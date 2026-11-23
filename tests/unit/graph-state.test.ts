import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FILTER_STATE,
  derivePanelViewModel,
} from "../../src/panel/graph-state.ts";
import type { GraphSnapshot } from "../../src/protocol/types.ts";

describe("derivePanelViewModel", () => {
  test("scopes Focused Subgraph to transitive upstream/downstream neighborhood and groups waterfall cascades", () => {
    const snapshot: GraphSnapshot = {
      version: 1,
      seq: 4,
      baseSeq: 0,
      droppedEvents: 0,
      litVersions: ["4.2.2"],
      settings: {
        paused: false,
        captureMemoHits: false,
        captureCustomEvents: true,
      },
      nodes: [
        {
          id: 1,
          kind: "model",
          label: "FlightModel",
          subtitle: "Model",
          site: null,
          connected: true,
          updates: 1,
          hits: 0,
          misses: 0,
          vetoes: 0,
          lastDurationMs: null,
          lastChangedSeq: 1,
          lastCauseLabel: null,
          lastCauseNodeId: null,
          value: null,
          error: null,
        },
        {
          id: 2,
          kind: "controller",
          label: "MapController",
          subtitle: "Controller",
          site: null,
          connected: true,
          updates: 1,
          hits: 0,
          misses: 0,
          vetoes: 0,
          lastDurationMs: null,
          lastChangedSeq: 2,
          lastCauseLabel: null,
          lastCauseNodeId: 1,
          value: null,
          error: null,
        },
        {
          id: 3,
          kind: "element",
          label: "x-moving-map",
          subtitle: "MovingMapElement",
          site: null,
          connected: true,
          updates: 1,
          hits: 0,
          misses: 0,
          vetoes: 0,
          lastDurationMs: 1.4,
          lastChangedSeq: 3,
          lastCauseLabel: "viewModel",
          lastCauseNodeId: 2,
          value: null,
          error: null,
        },
        {
          id: 4,
          kind: "element",
          label: "unrelated-clock",
          subtitle: "ClockElement",
          site: null,
          connected: true,
          updates: 1,
          hits: 0,
          misses: 0,
          vetoes: 0,
          lastDurationMs: 0.2,
          lastChangedSeq: 4,
          lastCauseLabel: null,
          lastCauseNodeId: null,
          value: null,
          error: null,
        },
      ],
      edges: [
        {
          id: "1->2:model-to-controller:model-update",
          sourceId: 1,
          targetId: 2,
          kind: "model-to-controller",
          label: "model-update",
          count: 1,
          lastSeq: 2,
          lastDetail: null,
        },
        {
          id: "2->3:controller-to-element:viewModel",
          sourceId: 2,
          targetId: 3,
          kind: "controller-to-element",
          label: "viewModel",
          count: 1,
          lastSeq: 3,
          lastDetail: null,
        },
      ],
      events: [
        {
          seq: 1,
          cascadeId: 10,
          timestamp: 1000,
          durationMs: 0,
          nodeId: 1,
          kind: "model-update",
          label: "FlightModel model-update",
          causeNodeId: null,
          detail: "{alt: 100}",
        },
        {
          seq: 2,
          cascadeId: 10,
          timestamp: 1001,
          durationMs: 0.5,
          nodeId: 2,
          kind: "controller-transform",
          label: "MapController view-model-update",
          causeNodeId: 1,
          detail: null,
        },
        {
          seq: 3,
          cascadeId: 10,
          timestamp: 1002,
          durationMs: 1.4,
          nodeId: 3,
          kind: "render",
          label: "x-moving-map render",
          causeNodeId: 2,
          detail: null,
        },
        {
          seq: 4,
          cascadeId: 11,
          timestamp: 1100,
          durationMs: 0.2,
          nodeId: 4,
          kind: "render",
          label: "unrelated-clock render",
          causeNodeId: null,
          detail: null,
        },
      ],
    };

    const focused = derivePanelViewModel(
      snapshot,
      { ...DEFAULT_FILTER_STATE, focusSubgraphNodeId: 2 },
      3,
    );

    expect(
      focused.visibleNodes.map((n) => n.id).toSorted((a, b) => a - b),
    ).toEqual([1, 2, 3]);
    expect(focused.upstreamIds).toEqual(new Set([1, 2]));
    expect(focused.downstreamIds).toEqual(new Set());
    expect(focused.cascades.length).toBe(2);
    expect(focused.cascades[0]?.cascadeId).toBe(11);
    expect(focused.cascades[1]?.cascadeId).toBe(10);
    expect(focused.cascades[1]?.totalDurationMs).toBeCloseTo(1.9);

    const selfCauseSnap: GraphSnapshot = {
      ...snapshot,
      nodes: snapshot.nodes.map((n) =>
        n.id === 3
          ? { ...n, lastCauseNodeId: 3, lastCauseLabel: "prop 'x'" }
          : n,
      ),
    };
    const selfChecked = derivePanelViewModel(
      selfCauseSnap,
      DEFAULT_FILTER_STATE,
      3,
    );
    expect(selfChecked.directCauseNodeIds.has(3)).toBe(false);
  });
});
