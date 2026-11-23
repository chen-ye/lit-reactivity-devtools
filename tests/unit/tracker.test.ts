import { describe, expect, test } from "bun:test";
import memoizeOne from "memoize-one";
import { createLitDevtoolsHook } from "../../src/hook/hook.ts";
import { areMemoArgsEqual } from "../../src/hook/memo-tracker.ts";
import { serializePreview } from "../../src/hook/preview.ts";
import { parseStackLocation } from "../../src/hook/stack.ts";
import { isValidPanelToPageMessage } from "../../src/protocol/types.ts";

describe("LitReactivityTracker Model, Controller, and real memoize-one integration", () => {
  test("traces EventTarget model-update -> view-model-update -> memoizeOne _compute*/_observe* hits and misses", () => {
    const hook = createLitDevtoolsHook(false);
    let capturedEvents: Event[] = [];

    class FlightModel extends EventTarget {
      private data = { altitude: 12000, heading: 270 };
      setAltitude(next: number) {
        this.data = { ...this.data, altitude: next };
        this.dispatchEvent(
          new CustomEvent("model-update", { detail: { model: this.data } }),
        );
      }
      get snapshotData() {
        return this.data;
      }
    }

    class MovingMapController extends EventTarget {
      readonly modelManager: FlightModel;
      viewModel = { label: "", altMeters: 0 };

      _computeAltMeters = memoizeOne((ft: number) => Math.round(ft * 0.3048));
      _observeTelemetry = memoizeOne((altMeters: number) => {
        capturedEvents.push(
          new CustomEvent("telemetry-synced", { detail: altMeters }),
        );
      });

      constructor(model: FlightModel) {
        super();
        this.modelManager = model;
        this.modelManager.addEventListener("model-update", this.transform);
      }

      transform = () => {
        const ft = this.modelManager.snapshotData.altitude;
        const altMeters = this._computeAltMeters(ft);
        this._observeTelemetry(altMeters);
        this.viewModel = { label: `${ft}ft`, altMeters };
        this.dispatchEvent(
          new CustomEvent("view-model-update", {
            detail: {
              model: this.modelManager.snapshotData,
              viewModel: this.viewModel,
            },
          }),
        );
      };
    }

    const originalDispatch: unknown = Reflect.get(
      EventTarget.prototype,
      "dispatchEvent",
    );
    try {
      // Install EventTarget hook cleanly on this fresh test hook instance
      const testHook = createLitDevtoolsHook(true);
      const model = new FlightModel();
      const ctrl = new MovingMapController(model);

      // Call #1 discovers controller via view-model-update and wraps memoizeOne fields
      ctrl.transform();
      // Call #2 & #3 share identical altitude -> #2 initializes wrapper baseline, #3 hits cache!
      ctrl.transform();
      ctrl.transform();
      // Call #4 via model-update -> altitude changes -> cache MISS and model -> controller link!
      model.setAltitude(14000);

      const snap = testHook.snapshot();
      const modelNode = snap.nodes.find((n) => n.kind === "model");
      const ctrlNode = snap.nodes.find((n) => n.kind === "controller");
      const compNode = snap.nodes.find(
        (n) => n.kind === "computed" && n.label === "_computeAltMeters",
      );
      const obsNode = snap.nodes.find(
        (n) => n.kind === "observer" && n.label === "_observeTelemetry",
      );

      expect(modelNode?.label).toBe("FlightModel");
      expect(modelNode?.updates).toBe(1);
      expect(ctrlNode?.label).toBe("MovingMapController");
      expect(ctrlNode?.updates).toBe(4);

      expect(compNode?.misses).toBe(2);
      expect(compNode?.hits).toBe(1);
      expect(compNode?.value?.text).toBe("4267");

      expect(obsNode?.misses).toBe(2);
      expect(obsNode?.hits).toBe(1);
      expect(capturedEvents.length).toBe(2);

      // Verify edges: model -> controller, controller -> computed, controller -> observer
      expect(
        snap.edges.some(
          (e) =>
            e.sourceId === modelNode?.id &&
            e.targetId === ctrlNode?.id &&
            e.kind === "model-to-controller",
        ),
      ).toBe(true);
      expect(
        snap.edges.some(
          (e) =>
            e.sourceId === ctrlNode?.id &&
            e.targetId === compNode?.id &&
            e.kind === "memo-compute",
        ),
      ).toBe(true);
      expect(
        snap.edges.some(
          (e) =>
            e.sourceId === ctrlNode?.id &&
            e.targetId === obsNode?.id &&
            e.kind === "memo-observe",
        ),
      ).toBe(true);

      // Clearing memo cache forces next call to miss!
      expect(testHook.clearMemoCache(compNode!.id)).toEqual({ ok: true });
      ctrl.transform();
      const afterClear = testHook
        .snapshot()
        .nodes.find((n) => n.id === compNode!.id);
      expect(afterClear?.misses).toBe(3);

      // Clean unused helper reference
      expect(hook.version).toBe(1);
    } finally {
      Reflect.set(EventTarget.prototype, "dispatchEvent", originalDispatch);
    }
  });

  test("supports captureMemoHits, paused, and clearEvents settings", () => {
    const hook = createLitDevtoolsHook(false);
    const owner = { label: "store" };
    const fn = hook.traceMemoized(
      memoizeOne((x: number) => x + 1),
      owner,
      "_computePlusOne",
      "computed",
    );

    expect(fn(1)).toBe(2);
    expect(fn(1)).toBe(2);
    // By default captureMemoHits is false -> only 1 memo-miss trace recorded
    let snap = hook.snapshot();
    expect(snap.events.filter((e) => e.kind === "memo-hit").length).toBe(0);
    expect(snap.events.filter((e) => e.kind === "memo-miss").length).toBe(1);

    hook.configure({ captureMemoHits: true });
    expect(fn(1)).toBe(2);
    snap = hook.snapshot();
    expect(snap.events.filter((e) => e.kind === "memo-hit").length).toBe(1);

    hook.clearEvents();
    expect(hook.snapshot().events.length).toBe(0);
  });
});

describe("serializePreview & parseStackLocation", () => {
  test("marks truncated 45-72 char strings as truncated and protects circular objects", () => {
    const longStr = serializePreview("x".repeat(55));
    expect(longStr.kind).toBe("string");
    expect(longStr.truncated).toBe(true);

    const cyclic: Record<string, unknown> = { ok: true };
    cyclic.self = cyclic;
    expect(serializePreview(cyclic).text).toContain("[Circular]");

    const loc = parseStackLocation(
      "Error\n    at updateView (http://127.0.0.1:4173/src/app.ts:19:7)",
    );
    expect(loc).toEqual({
      file: "http://127.0.0.1:4173/src/app.ts",
      line: 19,
      column: 7,
      fn: "updateView",
    });
  });

  test("enforces memoize-one +0/-0 parity and rejects unsafe SET_PROPERTY prototype keys", () => {
    expect(areMemoArgsEqual([0], [-0])).toBe(true);
    expect(areMemoArgsEqual([Number.NaN], [Number.NaN])).toBe(true);

    expect(
      isValidPanelToPageMessage({
        type: "SET_PROPERTY",
        nodeId: 1,
        propName: "__proto__",
        jsonText: "{}",
        requestId: "r1",
      }),
    ).toBe(false);

    expect(
      isValidPanelToPageMessage({
        type: "SET_PROPERTY",
        nodeId: 1,
        propName: "label",
        jsonText: '"ok"',
        requestId: "r2",
      }),
    ).toBe(true);

    const hook = createLitDevtoolsHook(false);
    expect(hook.setProperty(1, "__proto__", "{}").ok).toBe(false);
    expect(hook.setProperty(1, "constructor", "{}").ok).toBe(false);
  });

  test("formats Lit TemplateResult values concisely without raw internal boilerplate", () => {
    const htmlTpl = {
      _$litType$: 1,
      strings: ["\n  <x-hsi-marker .heading=", ">\n"],
      values: [90],
    };
    const svgTpl = {
      _$litType$: 2,
      strings: ['<circle cx="0" cy="0" r="', '"/>'],
      values: [5],
    };
    expect(serializePreview(htmlTpl).text).toBe(
      "html`<x-hsi-marker .heading=`",
    );
    expect(serializePreview(svgTpl).text).toBe(
      'svg`<circle cx="0" cy="0" r="`',
    );
  });
});
