import { describe, expect, test } from "bun:test";
import { LitElement, type PropertyDeclarations } from "lit";
import memoizeOne from "memoize-one";
import { createLitDevtoolsHook } from "../../src/hook/hook.ts";
import {
  areMemoArgsEqual,
  wrapMemoizedFunction,
} from "../../src/hook/memo-tracker.ts";
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

      // Call #2 & #3 hit pre-warmed cache; Call #4 misses!
      expect(compNode?.misses).toBe(1);
      expect(compNode?.hits).toBe(2);
      expect(compNode?.value?.text).toBe("4267");
      expect(compNode?.computeSource).toContain("Math.round(ft * 0.3048)");
      expect(compNode?.computeSignature).toContain("Math.round(ft * 0.3048)");

      expect(obsNode?.misses).toBe(1);
      expect(obsNode?.hits).toBe(2);
      expect(obsNode?.computeSource).toContain("telemetry-synced");
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
      expect(afterClear?.misses).toBe(2);

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

class MockDomNode extends EventTarget {
  parentNode: MockDomNode | null = null;
  readonly childNodes: MockDomNode[] = [];
  textContent: string | null = "";

  appendChild<T extends MockDomNode>(child: T): T {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild<T extends MockDomNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) this.childNodes.splice(idx, 1);
    child.parentNode = null;
    return child;
  }

  get children(): MockDomElement[] {
    return this.childNodes.filter(
      (c): c is MockDomElement => c instanceof MockDomElement,
    );
  }

  get isConnected(): boolean {
    if (this instanceof MockDomElement && this.tagName === "HTML") {
      return this.parentNode === null;
    }
    let cur: MockDomNode | null =
      this instanceof MockDomShadowRoot ? this.host : this.parentNode;
    while (cur) {
      if (
        cur.parentNode === null &&
        cur instanceof MockDomElement &&
        cur.tagName === "HTML"
      ) {
        return true;
      }
      cur = cur instanceof MockDomShadowRoot ? cur.host : cur.parentNode;
    }
    return false;
  }
}

class MockDomShadowRoot extends MockDomNode {
  readonly host: MockDomElement;
  readonly mode: "open" | "closed";
  constructor(host: MockDomElement, mode: "open" | "closed") {
    super();
    this.host = host;
    this.mode = mode;
  }

  querySelector(selector: string): MockDomElement | null {
    const wantButton = selector.includes("button");
    const visit = (node: MockDomNode): MockDomElement | null => {
      for (const child of node.childNodes) {
        if (child instanceof MockDomElement) {
          if (
            wantButton &&
            (child.tagName.toLowerCase() === "button" ||
              child.getAttribute("role") === "button")
          ) {
            return child;
          }
          const nested = visit(child);
          if (nested) return nested;
        }
      }
      return null;
    };
    return visit(this);
  }
}

class MockDomElement extends MockDomNode {
  tagName = "DIV";
  id = "";
  shadowRoot: MockDomShadowRoot | null = null;
  renderRoot: MockDomShadowRoot | MockDomElement | null = null;
  readonly #attrs = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.#attrs.set(name, value);
    if (name === "id") this.id = value;
  }

  getAttribute(name: string): string | null {
    if (name === "id" && this.id) return this.id;
    return this.#attrs.get(name) ?? null;
  }

  attachShadow(init: { mode: "open" | "closed" }): MockDomShadowRoot {
    const root = new MockDomShadowRoot(this, init.mode);
    if (init.mode === "open") {
      this.shadowRoot = root;
    }
    this.renderRoot = root;
    return root;
  }
}

class MockDomHTMLElement extends MockDomElement {}

class MockDomReactiveElement extends MockDomHTMLElement {
  hasUpdated = false;

  requestUpdate(
    _name?: PropertyKey,
    _oldValue?: unknown,
    _options?: unknown,
  ): void {}
  performUpdate(): void {}
  shouldUpdate(_changed?: Map<PropertyKey, unknown>): boolean {
    return true;
  }
  willUpdate(_changed?: Map<PropertyKey, unknown>): void {}
  update(_changed?: Map<PropertyKey, unknown>): void {
    this.hasUpdated = true;
  }
  updated(_changed?: Map<PropertyKey, unknown>): void {}
  connectedCallback(): void {}
  disconnectedCallback(): void {}
}

class MockDomRegistry {
  readonly defs = new Map<string, new (...args: never[]) => MockDomElement>();
  define(name: string, ctor: new (...args: never[]) => MockDomElement): void {
    this.defs.set(name.toLowerCase(), ctor);
  }
}

interface MockGlobalsSnapshot {
  readonly Node: unknown;
  readonly Element: unknown;
  readonly HTMLElement: unknown;
  readonly ShadowRoot: unknown;
  readonly CustomElementRegistry: unknown;
  readonly customElements: unknown;
  readonly document: unknown;
}

function selectMockElementId(
  hook: ReturnType<typeof createLitDevtoolsHook>,
  el: MockDomElement,
): number | null {
  const fn: unknown = Reflect.get(hook, "selectElementFromElementsPanel");
  if (typeof fn !== "function") return null;
  const res: unknown = Reflect.apply(fn, hook, [el]);
  return typeof res === "number" ? res : null;
}

function withMockDom(
  run: (env: {
    readonly MockElement: typeof MockDomHTMLElement;
    readonly MockLitElement: typeof MockDomReactiveElement;
    readonly registry: MockDomRegistry;
    readonly documentRoot: MockDomHTMLElement;
  }) => void,
): void {
  const prev: MockGlobalsSnapshot = {
    Node: Reflect.get(globalThis, "Node"),
    Element: Reflect.get(globalThis, "Element"),
    HTMLElement: Reflect.get(globalThis, "HTMLElement"),
    ShadowRoot: Reflect.get(globalThis, "ShadowRoot"),
    CustomElementRegistry: Reflect.get(globalThis, "CustomElementRegistry"),
    customElements: Reflect.get(globalThis, "customElements"),
    document: Reflect.get(globalThis, "document"),
  };

  const registry = new MockDomRegistry();
  const docRoot = new MockDomHTMLElement();
  docRoot.tagName = "HTML";

  Reflect.set(globalThis, "Node", MockDomNode);
  Reflect.set(globalThis, "Element", MockDomElement);
  Reflect.set(globalThis, "HTMLElement", MockDomHTMLElement);
  Reflect.set(globalThis, "ShadowRoot", MockDomShadowRoot);
  Reflect.set(globalThis, "CustomElementRegistry", MockDomRegistry);
  Reflect.set(globalThis, "customElements", registry);
  Reflect.set(globalThis, "document", { documentElement: docRoot });

  try {
    run({
      MockElement: MockDomHTMLElement,
      MockLitElement: MockDomReactiveElement,
      registry,
      documentRoot: docRoot,
    });
  } finally {
    Reflect.set(globalThis, "Node", prev.Node);
    Reflect.set(globalThis, "Element", prev.Element);
    Reflect.set(globalThis, "HTMLElement", prev.HTMLElement);
    Reflect.set(globalThis, "ShadowRoot", prev.ShadowRoot);
    Reflect.set(
      globalThis,
      "CustomElementRegistry",
      prev.CustomElementRegistry,
    );
    Reflect.set(globalThis, "customElements", prev.customElements);
    Reflect.set(globalThis, "document", prev.document);
  }
}

function sampleMultiplyByTen(x: number): number {
  return x * 10;
}

function sampleRejectNegative(n: number): number {
  if (n < 0) throw new Error("negative");
  return n + 1;
}

function sampleDoubledSum(a: number, b: number): number {
  const doubled = (a + b) * 2;
  return doubled + a;
}

function sampleSumArray(arr: ReadonlyArray<number>): number {
  return arr.reduce((a, b) => a + b, 0);
}

function sampleIncrement(x: number): number {
  return x + 1;
}

describe("Wave 2A stack parsing, memoize-one expression capture, getDefinitionTarget, and sibling disambiguation", () => {
  test("stack.ts counts skipFrames after filtering ignored/internal frames and peeks at frame 2 for V8 initializer fn", () => {
    const stackWithIgnored = [
      "Error",
      "    at captureCallsite (file:///app/node_modules/lit/index.js:10:2)",
      "    at Object.__LIT_DEVTOOLS__wrappedDefine [as apply] (http://127.0.0.1:4173/main.js:50:12)",
      "    at wrapMemoizedFunction (http://127.0.0.1:4173/main.js:90:8)",
      "    at LitReactivityTracker.registerModel (http://127.0.0.1:4173/main.js:120:4)",
      "    at createLitDevtoolsHook (http://127.0.0.1:4173/main.js:140:6)",
      "    at firstUserFrame (http://127.0.0.1:4173/app.js:21:5)",
      "    at secondUserFrame (http://127.0.0.1:4173/app.js:44:9)",
    ].join("\n");

    expect(parseStackLocation(stackWithIgnored, undefined, 0)).toEqual({
      file: "http://127.0.0.1:4173/app.js",
      line: 21,
      column: 5,
      fn: "firstUserFrame",
    });

    // skipFrames=1 must skip firstUserFrame (the 1st surviving frame), not ignored/internal frames
    expect(parseStackLocation(stackWithIgnored, undefined, 1)).toEqual({
      file: "http://127.0.0.1:4173/app.js",
      line: 44,
      column: 9,
      fn: "secondUserFrame",
    });

    const initStack = [
      "Error",
      "    at captureCallsite (http://127.0.0.1:4173/main.js:10:1)",
      "    at <instance_members_initializer> (http://127.0.0.1:4173/card.ts:18:22)",
      "    at new TelemetryCard (http://127.0.0.1:4173/card.ts:12:1)",
    ].join("\n");

    expect(parseStackLocation(initStack)).toEqual({
      file: "http://127.0.0.1:4173/card.ts",
      line: 18,
      column: 22,
      fn: "new TelemetryCard",
    });

    const staticInitStack = [
      "Error",
      "    at <static_initializer> (http://127.0.0.1:4173/store.ts:7:19)",
      "    at StoreModule (http://127.0.0.1:4173/store.ts:1:1)",
    ].join("\n");

    expect(parseStackLocation(staticInitStack)).toEqual({
      file: "http://127.0.0.1:4173/store.ts",
      line: 7,
      column: 19,
      fn: "StoreModule",
    });
  });

  test("memo-tracker 1-shot apply trap captures innerFn safely across nested calls, throws, and pre-warmed hits", () => {
    const origApply = Reflect.get(Function.prototype, "apply");
    const calls: Array<{
      hit: boolean;
      innerFn?: ((...args: never[]) => unknown) | undefined;
      error?: unknown;
    }> = [];

    const rawInner = sampleMultiplyByTen;
    const preWarmed = memoizeOne(rawInner);
    expect(preWarmed(3)).toBe(30); // Warm cache BEFORE wrapping!

    const wrappedPreWarmed = wrapMemoizedFunction(preWarmed, (evt) => {
      calls.push({ hit: evt.hit, innerFn: evt.innerFn, error: evt.error });
    });

    // Call #1 hits pre-warmed cache -> hit: true, innerFn not triggered yet!
    expect(wrappedPreWarmed(3)).toBe(30);
    expect(calls[0]?.hit).toBe(true);
    expect(calls[0]?.innerFn).toBeUndefined();
    expect(Reflect.get(Function.prototype, "apply")).toBe(origApply);

    // Call #2 misses -> 1-shot apply trap captures rawInner and restores Function.prototype.apply!
    expect(wrappedPreWarmed(4)).toBe(40);
    expect(calls[1]?.hit).toBe(false);
    expect(calls[1]?.innerFn).toBe(rawInner);
    expect(Reflect.get(Function.prototype, "apply")).toBe(origApply);

    // Re-entrant nested memoizeOne + inner throwing restores Function.prototype.apply cleanly
    const innerCalls: Array<{
      hit: boolean;
      innerFn?: ((...args: never[]) => unknown) | undefined;
    }> = [];
    const outerCalls: Array<{
      hit: boolean;
      innerFn?: ((...args: never[]) => unknown) | undefined;
    }> = [];

    const innerFn = sampleRejectNegative;
    const wrappedInner = wrapMemoizedFunction(memoizeOne(innerFn), (evt) => {
      innerCalls.push({ hit: evt.hit, innerFn: evt.innerFn });
    });

    const outerFn = (n: number): number => wrappedInner(n) * 2;
    const wrappedOuter = wrapMemoizedFunction(memoizeOne(outerFn), (evt) => {
      outerCalls.push({ hit: evt.hit, innerFn: evt.innerFn });
    });

    expect(wrappedOuter(5)).toBe(12);
    expect(outerCalls[0]?.innerFn).toBe(outerFn);
    expect(innerCalls[0]?.innerFn).toBe(innerFn);
    expect(Reflect.get(Function.prototype, "apply")).toBe(origApply);

    expect(() => wrappedOuter(-1)).toThrow("negative");
    expect(Reflect.get(Function.prototype, "apply")).toBe(origApply);

    // Custom memoizeOne(fn, isEqual) comparator: two distinct array instances with equal items must be a HIT!
    const customCalls: boolean[] = [];
    const wrappedCustom = wrapMemoizedFunction(
      memoizeOne(
        sampleSumArray,
        (
          nextArgs: readonly [ReadonlyArray<number>],
          prevArgs: readonly [ReadonlyArray<number>],
        ) => {
          const a = nextArgs[0];
          const b = prevArgs[0];
          return a.length === b.length && a.every((v, idx) => v === b[idx]);
        },
      ),
      (evt) => customCalls.push(evt.hit),
    );
    expect(wrappedCustom([1, 2])).toBe(3);
    expect(wrappedCustom([1, 2])).toBe(3);
    expect(wrappedCustom([1, 3])).toBe(4);
    expect(customCalls).toEqual([false, true, false]);

    // Custom non-.apply memoizer via traceMemoized: Call #1 must be miss (hit: false), Call #2 hit
    let cachedNonApplyArg: number | undefined;
    let cachedNonApplyRes = 0;
    const customMemo = Object.assign(
      (n: number): number => {
        if (cachedNonApplyArg === n) return cachedNonApplyRes;
        cachedNonApplyArg = n;
        cachedNonApplyRes = n * 5;
        return cachedNonApplyRes;
      },
      {
        clear() {
          cachedNonApplyArg = undefined;
        },
      },
    );
    const nonApplyHits: boolean[] = [];
    const wrappedNonApply = wrapMemoizedFunction(customMemo, (evt) =>
      nonApplyHits.push(evt.hit),
    );
    expect(wrappedNonApply(4)).toBe(20);
    expect(wrappedNonApply(4)).toBe(20);
    expect(wrappedNonApply(5)).toBe(25);
    expect(nonApplyHits).toEqual([false, true, false]);
  });

  test("Layer A (t=0) and Layer B (miss) memo expression capture handle multi-line dedent, 1200-char cap, and native/wrapper rejection", () => {
    const hook = createLitDevtoolsHook(false);

    class FormulaStore extends EventTarget {
      _computeFormatted = memoizeOne(
        (label: string, val: number): string => {
          const rounded = Math.round(val);
          return `${label}: ${rounded}`;
        },
        (a, b) => a[0] === b[0] && a[1] === b[1],
      );
      _computeLong = memoizeOne((n: number): string => {
        const s =
          "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789" +
          "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789" +
          "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789" +
          "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789" +
          "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789" +
          "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789" +
          "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789" +
          "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789" +
          "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789" +
          "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789" +
          "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789" +
          "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789" +
          "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789";
        return s.slice(n);
      });
    }

    const store = new FormulaStore();
    hook.registerController(store);

    // Layer A populated computeSource & computeSignature immediately at t=0 before any call!
    const snapT0 = hook.snapshot();
    const formattedT0 = snapT0.nodes.find(
      (n) => n.label === "_computeFormatted",
    );
    const longT0 = snapT0.nodes.find((n) => n.label === "_computeLong");
    expect(formattedT0?.computeSource).toContain(
      "const rounded = Math.round(val);",
    );
    expect(formattedT0?.computeSource).not.toContain("a[0] === b[0]");
    expect(formattedT0?.computeSignature).not.toContain("\n");
    expect(longT0?.computeSource?.length).toBe(1200);
    expect(longT0?.computeSource?.endsWith("…")).toBe(true);
    expect(longT0?.computeSignature?.length).toBeLessThanOrEqual(120);
    expect(longT0?.computeSignature?.endsWith("…")).toBe(true);

    // Layer B works even on plain object owner (Object.toString() is [native code])
    const plainOwner = { name: "plain" };
    const traced = hook.traceMemoized(
      memoizeOne(sampleDoubledSum),
      plainOwner,
      "_computeSum",
      "computed",
    );
    expect(
      hook.snapshot().nodes.find((n) => n.label === "_computeSum")
        ?.computeSource,
    ).toBeNull();
    expect(traced(2, 3)).toBe(12);
    const afterMiss = hook
      .snapshot()
      .nodes.find((n) => n.label === "_computeSum");
    expect(afterMiss?.computeSource).toContain("return");
    expect(afterMiss?.computeSource).not.toContain("cache.lastThis");
    expect(afterMiss?.computeSignature).toContain("sampleDoubledSum(a, b)");
  });

  test("getDefinitionTarget resolves element/prop/Lit synthetic accessor, controller/model, memo innerFn, and context provider host", () => {
    const originalDispatch = Reflect.get(
      EventTarget.prototype,
      "dispatchEvent",
    );
    try {
      withMockDom(({ MockLitElement, registry, documentRoot }) => {
        const hook = createLitDevtoolsHook(true);

        class BaseCard extends MockLitElement {
          static properties: PropertyDeclarations = {
            baseProp: { type: String },
          };
          static elementProperties = new Map<string, Record<string, unknown>>([
            ["baseProp", { type: String }],
          ]);
          declare baseProp: string;
          constructor() {
            super();
            this.tagName = "X-BASE-CARD";
            this.baseProp = "base";
          }
        }

        class SubCard extends BaseCard {
          static override properties: PropertyDeclarations = {
            childProp: { type: Number },
            customProp: { type: String },
            setterOnly: { type: String },
          };
          static override elementProperties = new Map<
            string,
            Record<string, unknown>
          >([
            ["baseProp", { type: String }],
            ["childProp", { type: Number }],
            ["customProp", { type: String, wrapped: true }],
            ["setterOnly", { type: String, wrapped: true }],
          ]);
          #custom = "init";
          _computeDouble = memoizeOne((v: number) => v * 2);

          get customProp(): string {
            return this.#custom;
          }
          set customProp(v: string) {
            this.#custom = v;
          }

          constructor() {
            super();
            this.tagName = "X-SUB-CARD";
          }
        }

        // Emulate ReactiveElement installing a synthetic getter on SubCard.prototype for childProp
        // and a synthetic setter wrapper for setterOnly
        const symKey = Symbol("childProp");
        Object.defineProperty(SubCard.prototype, "childProp", {
          get(this: Record<symbol, unknown>) {
            return this[symKey];
          },
          configurable: true,
        });
        Object.defineProperty(SubCard.prototype, "setterOnly", {
          set(
            this: { requestUpdate: (k: string, old: unknown) => void },
            v: unknown,
          ) {
            this.requestUpdate("setterOnly", v);
          },
          configurable: true,
        });

        registry.define("x-sub-card", SubCard);
        const card = new SubCard();
        documentRoot.appendChild(card);
        card.connectedCallback();

        // Plain object model & controller with _transform/update fallbacks + class model
        class ClassModel extends EventTarget {}
        hook.registerModel(new ClassModel());
        const plainCtrl = hook.registerController(
          {
            _transform: sampleIncrement,
          },
          { name: "PlainCtrl", host: card },
        );
        const updateOnlyModel = hook.registerModel(
          {
            update() {
              return 42;
            },
          },
          { name: "UpdateModel" },
        );

        // Bound inner memo function ([native code]) must fall back to owner constructor
        const boundInner = function (
          this: { readonly tagName: string },
          n: number,
        ) {
          return n + this.tagName.length;
        }.bind(card);
        const boundMemo = hook.traceMemoized(
          memoizeOne(boundInner),
          card,
          "_computeBound",
          "computed",
        );
        boundMemo(1);

        // Context provider event
        const ctxKey = { name: "theme-ctx" };
        card.dispatchEvent(
          Object.assign(new Event("context-provider", { bubbles: true }), {
            context: ctxKey,
            contextTarget: card,
          }),
        );

        const snap = hook.snapshot();
        const cardNode = snap.nodes.find((n) => n.tagName === "x-sub-card")!;
        const memoNode = snap.nodes.find((n) => n.label === "_computeDouble")!;
        const boundMemoNode = snap.nodes.find(
          (n) => n.label === "_computeBound",
        )!;
        const classModelNode = snap.nodes.find(
          (n) => n.label === "ClassModel",
        )!;
        const plainCtrlNode = snap.nodes.find((n) => n.label === "PlainCtrl")!;
        const updateModelNode = snap.nodes.find(
          (n) => n.label === "UpdateModel",
        )!;
        const ctxNode = snap.nodes.find((n) => n.kind === "context")!;

        const defTarget = (nodeId: number, propName?: string | null): unknown =>
          hook.getDefinitionTarget?.(nodeId, propName);

        expect(defTarget(cardNode.id)).toBe(SubCard);
        expect(defTarget(cardNode.id, "childProp")).toBe(SubCard);
        expect(defTarget(cardNode.id, "setterOnly")).toBe(SubCard);
        expect(defTarget(cardNode.id, "baseProp")).toBe(BaseCard);
        const customDesc = Object.getOwnPropertyDescriptor(
          SubCard.prototype,
          "customProp",
        );
        const customGetter: unknown = customDesc
          ? Reflect.get(customDesc, "get")
          : undefined;
        expect(defTarget(cardNode.id, "customProp")).toBe(customGetter);

        expect(defTarget(classModelNode.id)).toBe(ClassModel);
        expect(defTarget(plainCtrlNode.id)).toBe(sampleIncrement);
        expect(defTarget(plainCtrlNode.id)).not.toBe(
          Reflect.get(plainCtrl, "_transform"),
        );
        expect(defTarget(updateModelNode.id)).toBe(
          Reflect.get(updateOnlyModel, "update"),
        );
        expect(defTarget(ctxNode.id)).toBe(SubCard);
        expect(defTarget(boundMemoNode.id)).toBe(SubCard);

        // Computed before first miss falls back to owner constructor (never memoize-one wrapper)
        expect(defTarget(memoNode.id)).toBe(SubCard);
        // After first miss, returns exact inner function (not card._computeDouble wrapper!)
        expect(card._computeDouble(7)).toBe(14);
        const targetAfterMiss = defTarget(memoNode.id);
        expect(targetAfterMiss).not.toBe(card._computeDouble);
        expect(String(targetAfterMiss)).toContain("v * 2");
      });
    } finally {
      Reflect.set(EventTarget.prototype, "dispatchEvent", originalDispatch);
    }

    // Verify LitElement (ReactiveElement) synthetic accessor detection directly
    class RealLitCard extends LitElement {
      static override properties: PropertyDeclarations = {
        heading: { type: Number },
        customTitle: { type: String },
      };
      #title = "A";
      get customTitle(): string {
        return this.#title;
      }
      set customTitle(v: string) {
        this.#title = v;
      }
    }
    void RealLitCard.observedAttributes;
    expect(
      Reflect.get(
        RealLitCard.elementProperties.get("customTitle") ?? {},
        "wrapped",
      ),
    ).toBe(true);
    expect(
      Reflect.get(
        RealLitCard.elementProperties.get("heading") ?? {},
        "wrapped",
      ),
    ).toBeUndefined();
  });

  test("exports ownerNodeId, domParentNodeId across ShadowRoot, bare tagName, and completes lazy site on runtime events", () => {
    const originalDispatch = Reflect.get(
      EventTarget.prototype,
      "dispatchEvent",
    );
    try {
      withMockDom(({ MockElement, MockLitElement, registry, documentRoot }) => {
        // Pre-existing element + controller BEFORE hook install -> scanDom() leaves site === null
        class PreExistingCtrl extends EventTarget {
          view: MockDomReactiveElement | null = null;
          _computeScaled = memoizeOne((n: number) => n * 3);
          _transform(n: number): number {
            return this._computeScaled(n);
          }
          emitViewModel(n: number): void {
            const vm = this._transform(n);
            this.dispatchEvent(
              new CustomEvent("view-model-update", {
                detail: { viewModel: vm },
              }),
            );
          }
        }

        class ParentShell extends MockLitElement {
          constructor() {
            super();
            this.tagName = "X-PARENT-SHELL";
          }
        }

        class ChildCard extends MockLitElement {
          controller: PreExistingCtrl;
          constructor(ctrl: PreExistingCtrl) {
            super();
            this.tagName = "X-CHILD-CARD";
            this.controller = ctrl;
          }
        }

        registry.define("x-parent-shell", ParentShell);
        registry.define("x-child-card", ChildCard);

        const parent = new ParentShell();
        const shadow = parent.attachShadow({ mode: "open" });
        const wrapperDiv = new MockElement();
        wrapperDiv.tagName = "DIV";
        const ctrl = new PreExistingCtrl();
        const child = new ChildCard(ctrl);
        ctrl.view = child;

        documentRoot.appendChild(parent);
        shadow.appendChild(wrapperDiv);
        wrapperDiv.appendChild(child);

        // Install hook AFTER DOM construction -> install() runs scanDom()
        const hook = createLitDevtoolsHook(true);
        const initialSnap = hook.snapshot();

        const parentNode = initialSnap.nodes.find(
          (n) => n.tagName === "x-parent-shell",
        )!;
        const childNode = initialSnap.nodes.find(
          (n) => n.tagName === "x-child-card",
        )!;
        const ctrlNodeInit = initialSnap.nodes.find(
          (n) => n.kind === "controller",
        )!;
        const memoNodeInit = initialSnap.nodes.find(
          (n) => n.kind === "computed",
        )!;

        // domParentNodeId crosses div -> ShadowRoot.host -> X-PARENT-SHELL!
        expect(parentNode.domParentNodeId).toBeUndefined();
        expect(childNode.domParentNodeId).toBe(parentNode.id);
        expect(ctrlNodeInit.ownerNodeId).toBe(childNode.id);
        expect(memoNodeInit.ownerNodeId).toBe(ctrlNodeInit.id);
        // scanDom() did NOT poison site with scanDom() itself
        expect(ctrlNodeInit.site).toBeNull();
        expect(childNode.site).toBeNull();

        // Runtime event lazily completes site for controller and memo
        ctrl.emitViewModel(10);
        const afterRuntime = hook.snapshot();
        const ctrlAfter = afterRuntime.nodes.find(
          (n) => n.id === ctrlNodeInit.id,
        )!;
        const memoAfter = afterRuntime.nodes.find(
          (n) => n.id === memoNodeInit.id,
        )!;
        expect(ctrlAfter.site).not.toBeNull();
        expect(ctrlAfter.site?.file).toContain("tracker.test.ts");
        expect(memoAfter.site).not.toBeNull();

        // Lazy site on context + model
        const model = new (class LazyModel extends EventTarget {})();
        // Discover model during scanDom-style controller ref or register? Simulate pre-existing via dispatch:
        model.dispatchEvent(
          new CustomEvent("model-update", { detail: { model: { ok: true } } }),
        );
        const modelNode = hook
          .snapshot()
          .nodes.find((n) => n.label === "LazyModel");
        expect(modelNode?.site?.file).toContain("tracker.test.ts");
      });
    } finally {
      Reflect.set(EventTarget.prototype, "dispatchEvent", originalDispatch);
    }
  });

  test("6-tier latched sibling disambiguation resolves all 6 tiers, gives 0 suffix on singletons, and prevents 60Hz churn flicker", () => {
    const originalDispatch = Reflect.get(
      EventTarget.prototype,
      "dispatchEvent",
    );
    try {
      withMockDom(({ MockElement, MockLitElement, registry, documentRoot }) => {
        const hook = createLitDevtoolsHook(true);

        // 1. Singleton without id -> 0 suffix; Singleton with id -> #id
        class SingletonEl extends MockLitElement {
          constructor() {
            super();
            this.tagName = "X-SINGLETON";
          }
        }
        class SingletonWithIdEl extends MockLitElement {
          constructor() {
            super();
            this.tagName = "X-HERO";
            this.id = "main";
          }
        }

        // 2. Cohort testing Tiers 0..6
        class TelemetryTile extends MockLitElement {
          static elementProperties = new Map<string, Record<string, unknown>>([
            ["label", { type: String }],
            ["mode", { type: String }],
            ["distance", { type: Number }],
            ["value", { type: Number }],
          ]);
          label = "";
          mode = "live";
          distance = 0;
          value = 100;
          constructor() {
            super();
            this.tagName = "X-TILE";
          }
        }

        class HostBox extends MockLitElement {
          constructor(tag: string) {
            super();
            this.tagName = tag.toUpperCase();
          }
        }

        registry.define("x-singleton", SingletonEl);
        registry.define("x-hero", SingletonWithIdEl);
        registry.define("x-tile", TelemetryTile);
        registry.define("x-header-box", HostBox);
        registry.define("x-footer-box", HostBox);

        const singleton = new SingletonEl();
        const hero = new SingletonWithIdEl();
        documentRoot.appendChild(singleton);
        documentRoot.appendChild(hero);

        // Tier 0: explicit hook.label()
        const t0 = new TelemetryTile();
        hook.label(t0, "Explicit Master Tile");
        documentRoot.appendChild(t0);

        // Tier 1: #id
        const t1 = new TelemetryTile();
        t1.id = "alt-tile";
        documentRoot.appendChild(t1);

        // Tier 2: data-testid -> distinct slot -> aria-label
        const t2a = new TelemetryTile();
        t2a.setAttribute("data-testid", "spd-widget");
        documentRoot.appendChild(t2a);

        const t2b = new TelemetryTile();
        t2b.setAttribute("slot", "header-slot");
        documentRoot.appendChild(t2b);

        const t2cSharedSlot = new TelemetryTile();
        t2cSharedSlot.setAttribute("slot", "dup");
        t2cSharedSlot.setAttribute("aria-label", "Nav Card");
        documentRoot.appendChild(t2cSharedSlot);

        const t2dDupSlot = new TelemetryTile();
        t2dDupSlot.setAttribute("slot", "dup");
        t2dDupSlot.label = "Heading";
        documentRoot.appendChild(t2dDupSlot);

        // Tier 3: entropy-ranked low-churn reactive prop (`label` has higher entropy than `mode`!)
        const t3a = new TelemetryTile();
        t3a.label = "Altitude";
        t3a.mode = "shared";
        documentRoot.appendChild(t3a);

        const t3b = new TelemetryTile();
        t3b.label = "Vertical";
        t3b.mode = "shared";
        documentRoot.appendChild(t3b);

        // Tier 4: Shadow DOM button label (skipping <style>)
        const t4 = new TelemetryTile();
        const t4Shadow = t4.attachShadow({ mode: "open" });
        const styleEl = new MockElement();
        styleEl.tagName = "STYLE";
        styleEl.textContent = ".btn { color: red; }";
        const btnEl = new MockElement();
        btnEl.tagName = "BUTTON";
        btnEl.textContent = "Arm Gear";
        t4Shadow.appendChild(styleEl);
        t4Shadow.appendChild(btnEl);
        documentRoot.appendChild(t4);

        // Tier 5: distinct domParentNodeId tag (`in <parent>`)
        const headerHost = new HostBox("x-header-box");
        const footerHost = new HostBox("x-footer-box");
        documentRoot.appendChild(headerHost);
        documentRoot.appendChild(footerHost);

        const t5Header = new TelemetryTile();
        headerHost.appendChild(t5Header);

        const t5Footer = new TelemetryTile();
        footerHost.appendChild(t5Footer);

        // Tier 6: identical siblings -> DOM sibling ordinal [1], [2]
        const t6a = new TelemetryTile();
        const t6b = new TelemetryTile();
        documentRoot.appendChild(t6a);
        documentRoot.appendChild(t6b);

        // Shadow DOM duplicate #id must NOT resolve both to #dup-btn at Tier 1
        const dupHostA = new HostBox("x-dup-host-a");
        const dupHostB = new HostBox("x-dup-host-b");
        documentRoot.appendChild(dupHostA);
        documentRoot.appendChild(dupHostB);
        const dupShadowA = new TelemetryTile();
        dupShadowA.id = "dup-id";
        dupHostA.appendChild(dupShadowA);
        const dupShadowB = new TelemetryTile();
        dupShadowB.id = "dup-id";
        dupHostB.appendChild(dupShadowB);

        hook.scanDom();

        // Trigger updates on t3a & t3b & t6a so Ranks 1-5 latch (while Rank 6 does NOT latch!)
        for (const el of [
          t0,
          t1,
          t2a,
          t2b,
          t2cSharedSlot,
          t2dDupSlot,
          t3a,
          t3b,
          t4,
          t5Header,
          t5Footer,
          t6a,
          t6b,
          dupShadowA,
          dupShadowB,
        ]) {
          el.update();
        }

        const snap1 = hook.snapshot();
        const byEl = (target: MockDomElement) => {
          const id = selectMockElementId(hook, target);
          return snap1.nodes.find((n) => n.id === id)!;
        };

        // Singletons
        expect(byEl(singleton).label).toBe("x-singleton");
        expect(byEl(singleton).disambiguator).toBeNull();
        expect(byEl(singleton).tagName).toBe("x-singleton");

        expect(byEl(hero).label).toBe("x-hero#main");
        expect(byEl(hero).disambiguator).toBe("#main");
        expect(byEl(hero).tagName).toBe("x-hero");

        // Tier 0..6 checks + clean tagName
        expect(byEl(t0).label).toBe("Explicit Master Tile");
        expect(byEl(t0).tagName).toBe("x-tile");

        expect(byEl(t1).disambiguator).toBe("#alt-tile");
        expect(byEl(t1).label).toBe("x-tile#alt-tile");
        expect(byEl(t1).tagName).toBe("x-tile");

        expect(byEl(t2a).disambiguator).toBe('[data-testid="spd-widget"]');
        expect(byEl(t2b).disambiguator).toBe('[slot="header-slot"]');
        expect(byEl(t2cSharedSlot).disambiguator).toBe(
          '[aria-label="Nav Card"]',
        );
        expect(byEl(t2dDupSlot).disambiguator).toBe('label="Heading"');

        expect(byEl(t3a).disambiguator).toBe('label="Altitude"');
        expect(byEl(t3b).disambiguator).toBe('label="Vertical"');

        expect(byEl(t4).disambiguator).toBe('"Arm Gear"');
        expect(byEl(t5Header).disambiguator).toBe("in x-header-box");
        expect(byEl(t5Footer).disambiguator).toBe("in x-footer-box");

        expect(byEl(t6a).disambiguator).toBe("[1]");
        expect(byEl(t6b).disambiguator).toBe("[2]");
        // Duplicate #id fell through Tier 1 cleanly and disambiguated by parent (Tier 5) or ordinal!
        expect(byEl(dupShadowA).disambiguator).not.toBe(
          byEl(dupShadowB).disambiguator,
        );
        expect(byEl(dupShadowA).disambiguator).not.toBe("#dup-id");

        // Simulate 60Hz telemetry numeric churn AND label mutation after latching on t3a:
        // Rank 3 is latched -> label MUST NOT flicker!
        for (let i = 1; i <= 10; i++) {
          const prevVal = t3a.value;
          t3a.value = 100 + i;
          t3a.requestUpdate("value", prevVal);
        }
        t3a.label = "Mutated Churn";
        t3a.requestUpdate("label", "Altitude");
        t3a.update();

        // Meanwhile Rank 6 does NOT latch: swapping t6a & t6b order in DOM updates ordinals!
        documentRoot.removeChild(t6a);
        documentRoot.appendChild(t6a);

        const snap2 = hook.snapshot();
        const find2 = (target: MockDomElement) => {
          const id = selectMockElementId(hook, target);
          return snap2.nodes.find((n) => n.id === id)!;
        };

        expect(find2(t3a).disambiguator).toBe('label="Altitude"');
        expect(find2(t3a).label).toBe('x-tile label="Altitude"');
        expect(find2(t6b).disambiguator).toBe("[1]");
        expect(find2(t6a).disambiguator).toBe("[2]");
      });
    } finally {
      Reflect.set(EventTarget.prototype, "dispatchEvent", originalDispatch);
    }
  });
});
