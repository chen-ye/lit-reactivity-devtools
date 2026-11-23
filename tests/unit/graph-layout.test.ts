import { describe, expect, test } from "bun:test";
import { computeGraphLayout } from "../../src/panel/graph-layout.ts";
import type {
  ReactivityEdgeSnapshot,
  ReactivityNodeSnapshot,
} from "../../src/protocol/types.ts";

function makeNode(
  id: number,
  kind: ReactivityNodeSnapshot["kind"],
  label: string,
): ReactivityNodeSnapshot {
  return {
    id,
    kind,
    label,
    subtitle: null,
    site: null,
    connected: true,
    updates: 1,
    hits: 0,
    misses: 0,
    vetoes: 0,
    lastDurationMs: null,
    lastChangedSeq: 0,
    lastCauseLabel: null,
    lastCauseNodeId: null,
    value: null,
    error: null,
  };
}

function makeEdge(
  sourceId: number,
  targetId: number,
  kind: ReactivityEdgeSnapshot["kind"],
  label: string | null = null,
): ReactivityEdgeSnapshot {
  return {
    id: `${sourceId}->${targetId}:${kind}:${label ?? ""}`,
    sourceId,
    targetId,
    kind,
    label,
    count: 1,
    lastSeq: 1,
    lastDetail: null,
  };
}

describe("computeGraphLayout", () => {
  test("lays out Model -> Controller -> Element -> Computed forward while routing event-emit as feedback arc", () => {
    const nodes: ReactivityNodeSnapshot[] = [
      makeNode(1, "model", "FlightModel"),
      makeNode(2, "controller", "MapController"),
      makeNode(3, "element", "x-moving-map"),
      makeNode(4, "computed", "_computeLayers"),
    ];
    const edges: ReactivityEdgeSnapshot[] = [
      makeEdge(1, 2, "model-to-controller", "model-update"),
      makeEdge(2, 3, "controller-to-element", "viewModel"),
      makeEdge(3, 4, "memo-compute", "computes"),
      makeEdge(3, 2, "event-emit", "zoom-change"),
    ];

    const layout = computeGraphLayout(nodes, edges);
    expect(layout.layerCount).toBe(4);
    expect(layout.nodeById.get(1)?.layer).toBe(0);
    expect(layout.nodeById.get(2)?.layer).toBe(1);
    expect(layout.nodeById.get(3)?.layer).toBe(2);
    expect(layout.nodeById.get(4)?.layer).toBe(3);

    const feedback = layout.edges.find((e) => e.edge.kind === "event-emit");
    expect(feedback?.isFeedback).toBe(true);
    for (const fwd of layout.edges.filter(
      (e) => e.edge.kind !== "event-emit",
    )) {
      expect(fwd.isFeedback).toBe(false);
      expect(fwd.x1).toBeLessThan(fwd.x2);
    }
  });

  test("coalesces parallel prop-flow edges and routes feedback arcs below all intermediate columns", () => {
    const nodes: ReactivityNodeSnapshot[] = [
      makeNode(1, "element", "parent-el"),
      makeNode(2, "element", "mid-a"),
      makeNode(3, "element", "mid-b"),
      makeNode(4, "element", "child-el"),
    ];
    const edges: ReactivityEdgeSnapshot[] = [
      makeEdge(1, 2, "prop-flow", "a"),
      makeEdge(1, 3, "prop-flow", "b"),
      makeEdge(2, 4, "prop-flow", "valueText"),
      makeEdge(2, 4, "prop-flow", "label"),
      makeEdge(2, 4, "prop-flow", "muted"),
      makeEdge(4, 1, "event-emit", "action"),
    ];

    const layout = computeGraphLayout(nodes, edges);
    const propEdges24 = layout.edges.filter(
      (e) =>
        e.edge.sourceId === 2 &&
        e.edge.targetId === 4 &&
        e.edge.kind === "prop-flow",
    );
    expect(propEdges24.length).toBe(1);
    expect(propEdges24[0]?.edge.label).toContain("props (3):");
    expect(propEdges24[0]?.edge.count).toBe(3);

    const feedback = layout.edges.find((e) => e.edge.kind === "event-emit")!;
    const maxNodeBottom = Math.max(...layout.nodes.map((n) => n.y + n.height));
    expect(feedback.labelY).toBeGreaterThan(maxNodeBottom);
    expect(layout.height).toBeGreaterThan(feedback.labelY);
  });
});
