import { describe, expect, test } from "bun:test";
import {
  computeGraphLayout,
  NODE_HEIGHT,
} from "../../src/panel/graph-layout.ts";
import type {
  ReactivityEdgeSnapshot,
  ReactivityNodeSnapshot,
} from "../../src/protocol/types.ts";
import {
  computeHierarchicLayout,
  type LayoutEdgeInput,
  type LayoutNodeInput,
  type LayoutPoint,
} from "../../src/shared/hierarchic-layout.ts";
import {
  formatSemanticTitle,
  smartTruncateToPx,
  splitTwoLineTitle,
  stripNamespaceKeepTail,
} from "../../src/shared/label-format.ts";
import {
  clearTextMeasureCache,
  measureTextPx,
} from "../../src/shared/text-measure.ts";

function makeNode(
  id: number,
  kind: ReactivityNodeSnapshot["kind"],
  label: string,
  extra?: Partial<ReactivityNodeSnapshot>,
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
    ...extra,
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

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

function segmentIntersectsCardInterior(
  p1: LayoutPoint,
  p2: LayoutPoint,
  card: { x: number; y: number; width: number; height: number },
): boolean {
  const minX = Math.min(p1.x, p2.x);
  const maxX = Math.max(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxY = Math.max(p1.y, p2.y);

  const left = card.x + 0.5;
  const right = card.x + card.width - 0.5;
  const top = card.y + 0.5;
  const bottom = card.y + card.height - 0.5;

  return maxX > left && minX < right && maxY > top && minY < bottom;
}

function assertAllSegmentsClearCards(
  edges: ReadonlyArray<{ readonly points?: ReadonlyArray<LayoutPoint> }>,
  cards: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
): void {
  for (const edge of edges) {
    const pts = edge.points ?? [];
    expect(pts.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      for (const card of cards) {
        expect(segmentIntersectsCardInterior(a, b, card)).toBe(false);
      }
    }
  }
}

describe("text-measure & label-format", () => {
  test("measureTextPx caches widths and distinguishes proportional vs monospace characters", () => {
    clearTextMeasureCache();
    const sans = "500 12px system-ui, sans-serif";
    const mono = "600 11.5px ui-monospace, monospace";
    expect(measureTextPx("", sans)).toBe(0);
    expect(measureTextPx("iiii", sans)).toBeLessThan(
      measureTextPx("mmmm", sans),
    );
    expect(measureTextPx("iiii", mono)).toBeCloseTo(
      measureTextPx("mmmm", mono),
      3,
    );
    const first = measureTextPx("FlightNavigationController", mono);
    const second = measureTextPx("FlightNavigationController", mono);
    expect(second).toBe(first);
  });

  test("stripNamespaceKeepTail preserves leading namespace and tail segments", () => {
    const font = "600 11.5px ui-monospace, monospace";
    const tag = "<ui-dashboard-route-canvas-map>";
    const fullW = measureTextPx(tag, font);
    const compact = stripNamespaceKeepTail(tag, fullW * 0.72, font);
    expect(compact.startsWith("<ui-…-")).toBe(true);
    expect(compact.endsWith("canvas-map>") || compact.endsWith("map>")).toBe(
      true,
    );
    expect(measureTextPx(compact, font)).toBeLessThanOrEqual(fullW * 0.72);
  });

  test("smartTruncateToPx and splitTwoLineTitle always preserve trailing disambiguator", () => {
    const font = "600 11.5px ui-monospace, monospace";
    const truncated = smartTruncateToPx(
      "veryLongComputedViewModelSelectorName",
      118,
      font,
      "#2",
    );
    expect(truncated.endsWith("#2")).toBe(true);
    expect(truncated.includes("…")).toBe(true);

    const twoLine = splitTwoLineTitle(
      "RouteModel.navigationWaypointList",
      130,
      font,
      "@map",
    );
    expect(twoLine.line2).not.toBeNull();
    expect(twoLine.line2!.endsWith("@map")).toBe(true);
    expect(twoLine.line1).toBe("RouteModel");
    expect(twoLine.line2!.startsWith(".navigation")).toBe(true);

    const kebabTwoLine = splitTwoLineTitle(
      "navigation-route-map-panel",
      125,
      font,
      "#3",
    );
    expect(kebabTwoLine.line2).not.toBeNull();
    expect(kebabTwoLine.line2!.endsWith("#3")).toBe(true);
  });

  test("formatSemanticTitle strips redundant prefixes and splits fieldAlias (ownerLabel)", () => {
    const a = formatSemanticTitle("_computeLayers (x-route-map)");
    expect(a.title).toBe("Layers");
    expect(a.ownerLabel).toBe("x-route-map");

    const b = formatSemanticTitle("computed · selectVisibleItems");
    expect(b.title).toBe("VisibleItems");
    expect(b.ownerLabel).toBeNull();

    const c = formatSemanticTitle("new MapController");
    expect(c.title).toBe("MapController");

    const d = formatSemanticTitle("observeScrollOffset", {
      disambiguator: "#2",
    });
    expect(d.title).toBe("ScrollOffset");
    expect(d.disambiguator).toBe("#2");

    const e = formatSemanticTitle("memoActiveRows (GridElement) #4", {
      disambiguator: "#4",
    });
    expect(e.title).toBe("ActiveRows");
    expect(e.ownerLabel).toBe("GridElement");
    expect(e.disambiguator).toBe("#4");
  });
});

describe("computeHierarchicLayout", () => {
  test("breaks cycles via priority-aware greedy FAS while preserving downstream topological order", () => {
    const nodes: LayoutNodeInput[] = [
      { id: 1, width: 220, height: 70 },
      { id: 2, width: 220, height: 70 },
      { id: 3, width: 220, height: 70 },
      { id: 4, width: 220, height: 70 },
      { id: 5, width: 220, height: 70 },
    ];
    const edges: LayoutEdgeInput[] = [
      { id: "1->2", sourceId: 1, targetId: 2, priority: 10 },
      { id: "2->3", sourceId: 2, targetId: 3, priority: 10 },
      { id: "3->1", sourceId: 3, targetId: 1, priority: -2 },
      { id: "3->4", sourceId: 3, targetId: 4, priority: 10 },
      { id: "4->5", sourceId: 4, targetId: 5, priority: 10 },
    ];

    const res = computeHierarchicLayout(nodes, edges);
    const l1 = res.nodeById.get(1)!.layer;
    const l2 = res.nodeById.get(2)!.layer;
    const l3 = res.nodeById.get(3)!.layer;
    const l4 = res.nodeById.get(4)!.layer;
    const l5 = res.nodeById.get(5)!.layer;

    expect(l1).toBeLessThan(l2);
    expect(l2).toBeLessThan(l3);
    expect(l3).toBeLessThan(l4);
    expect(l4).toBeLessThan(l5);

    const rev = res.edges.find((e) => e.id === "3->1")!;
    expect(rev.reversed).toBe(true);
    expect(rev.isFeedback).toBe(true);
    for (const fwd of res.edges.filter((e) => e.id !== "3->1")) {
      expect(fwd.reversed).toBe(false);
    }
    assertAllSegmentsClearCards(res.edges, res.nodes);
  });

  test("packs 0-degree isolated nodes in a 4-6 column grid below active components", () => {
    const nodes: LayoutNodeInput[] = [
      { id: 1, width: 224, height: 76 },
      { id: 2, width: 224, height: 76 },
      { id: 3, width: 224, height: 76 },
      ...Array.from({ length: 10 }, (_, idx) => ({
        id: 100 + idx,
        width: 224,
        height: 76,
      })),
    ];
    const edges: LayoutEdgeInput[] = [
      { id: "1->2", sourceId: 1, targetId: 2 },
      { id: "2->3", sourceId: 2, targetId: 3 },
    ];

    const res = computeHierarchicLayout(nodes, edges);
    expect(res.isolatedCount).toBe(10);
    expect(res.componentCount).toBe(1);

    const active = res.nodes.filter((n) => !n.isIsolated);
    const isolated = res.nodes.filter((n) => n.isIsolated);
    expect(active.length).toBe(3);
    expect(isolated.length).toBe(10);

    const maxActiveBottom = Math.max(...active.map((n) => n.y + n.height));
    const minIsolatedTop = Math.min(...isolated.map((n) => n.y));
    expect(minIsolatedTop).toBeGreaterThan(maxActiveBottom + 40);

    const distinctCols = new Set(isolated.map((n) => n.x));
    expect(distinctCols.size).toBeGreaterThanOrEqual(4);
    expect(distinctCols.size).toBeLessThanOrEqual(6);

    for (let i = 0; i < res.nodes.length; i++) {
      for (let j = i + 1; j < res.nodes.length; j++) {
        expect(boxesOverlap(res.nodes[i]!, res.nodes[j]!)).toBe(false);
      }
    }
  });

  test("aligns straight horizontal chains cleanly with Brandes-Kopf across variable card heights", () => {
    const nodes: LayoutNodeInput[] = [
      { id: 1, width: 230, height: 76 },
      { id: 2, width: 230, height: 90 },
      { id: 3, width: 230, height: 76 },
      { id: 4, width: 230, height: 52 },
    ];
    const edges: LayoutEdgeInput[] = [
      { id: "1->2", sourceId: 1, targetId: 2 },
      { id: "2->3", sourceId: 2, targetId: 3 },
      { id: "3->4", sourceId: 3, targetId: 4 },
    ];

    const res = computeHierarchicLayout(nodes, edges);
    const centers = [1, 2, 3, 4].map((id) => {
      const n = res.nodeById.get(id)!;
      return n.y + n.height / 2;
    });
    expect(centers[1]).toBeCloseTo(centers[0]!, 1);
    expect(centers[2]).toBeCloseTo(centers[0]!, 1);
    expect(centers[3]).toBeCloseTo(centers[0]!, 1);
  });

  test("resolves crossing segments in same gutter via HyperEdgeSegmentSplitter and emits rounded Q paths", () => {
    const nodes: LayoutNodeInput[] = [
      { id: 1, width: 224, height: 76 },
      { id: 2, width: 224, height: 76 },
      { id: 3, width: 224, height: 76 },
      { id: 4, width: 224, height: 76 },
    ];
    // Force opposite-order crossing in gutter 0 by anchoring 1->4 and 2->3 plus extra weight on 1->3, 2->4
    const edges: LayoutEdgeInput[] = [
      { id: "1->3", sourceId: 1, targetId: 3, weight: 2 },
      { id: "2->4", sourceId: 2, targetId: 4, weight: 2 },
      { id: "1->4", sourceId: 1, targetId: 4, weight: 1 },
      { id: "2->3", sourceId: 2, targetId: 3, weight: 1 },
    ];

    const res = computeHierarchicLayout(nodes, edges);
    assertAllSegmentsClearCards(res.edges, res.nodes);
    const curvedCorners = res.edges.filter((e) => e.path.includes(" Q "));
    expect(curvedCorners.length).toBeGreaterThan(0);
  });

  test("enforces transitive multi-class Brandes-Kopf constraints (2020 erratum) and top-corridor back-loops without card collisions", () => {
    // 3 parallel chains joined at bottom/middle creating >= 3 distinct sink classes
    // plus an upper-half reversed edge that routes cleanly along the top corridor
    const nodes: LayoutNodeInput[] = [
      { id: 1, width: 224, height: 76 },
      { id: 2, width: 224, height: 76 },
      { id: 3, width: 224, height: 76 },
      { id: 4, width: 224, height: 76 },
      { id: 5, width: 224, height: 90 },
      { id: 6, width: 224, height: 76 },
      { id: 7, width: 224, height: 76 },
      { id: 8, width: 224, height: 76 },
      { id: 9, width: 224, height: 52 },
      { id: 10, width: 224, height: 76 },
    ];
    const edges: LayoutEdgeInput[] = [
      // Upper branch with feedback loop
      { id: "1->2", sourceId: 1, targetId: 2, priority: 10 },
      { id: "2->3", sourceId: 2, targetId: 3, priority: 10 },
      { id: "3->1", sourceId: 3, targetId: 1, priority: -1 },
      // Middle diagonal cross-connections forcing multi-class shifts
      { id: "1->5", sourceId: 1, targetId: 5, priority: 8 },
      { id: "4->5", sourceId: 4, targetId: 5, priority: 8 },
      { id: "5->6", sourceId: 5, targetId: 6, priority: 8 },
      // Lower branch
      { id: "7->8", sourceId: 7, targetId: 8, priority: 8 },
      { id: "8->9", sourceId: 8, targetId: 9, priority: 8 },
      { id: "6->10", sourceId: 6, targetId: 10, priority: 8 },
      { id: "9->10", sourceId: 9, targetId: 10, priority: 8 },
    ];

    const res = computeHierarchicLayout(nodes, edges);
    for (let i = 0; i < res.nodes.length; i++) {
      for (let j = i + 1; j < res.nodes.length; j++) {
        expect(boxesOverlap(res.nodes[i]!, res.nodes[j]!)).toBe(false);
      }
    }
    assertAllSegmentsClearCards(res.edges, res.nodes);

    const revTop = res.edges.find((e) => e.id === "3->1")!;
    expect(revTop.isFeedback).toBe(true);
    expect(revTop.reversed).toBe(true);
    expect(revTop.path.includes(" Q ")).toBe(true);
  });
});

describe("computeGraphLayout", () => {
  test("lays out Model -> Controller -> Element -> Computed forward while routing event-emit as feedback arc", () => {
    const nodes: ReactivityNodeSnapshot[] = [
      makeNode(1, "model", "FlightModel"),
      makeNode(2, "controller", "MapController"),
      makeNode(3, "element", "x-route-map"),
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

    // Compact leaf memo height = 52, regular cards = 76
    expect(layout.nodeById.get(4)?.height).toBe(52);
    expect(layout.nodeById.get(1)?.height).toBe(NODE_HEIGHT);

    const feedback = layout.edges.find((e) => e.edge.kind === "event-emit");
    expect(feedback?.isFeedback).toBe(true);
    for (const fwd of layout.edges.filter(
      (e) => e.edge.kind !== "event-emit",
    )) {
      expect(fwd.isFeedback).toBe(false);
      expect(fwd.x1).toBeLessThan(fwd.x2);
    }
    assertAllSegmentsClearCards(layout.edges, layout.nodes);
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
    assertAllSegmentsClearCards(layout.edges, layout.nodes);
  });

  test("keeps owner-anchored leaf memos contiguous and auto-collapses > 4 leaf memos while preserving errors and supporting expansion", () => {
    const nodes: ReactivityNodeSnapshot[] = [
      makeNode(1, "model", "Store"),
      makeNode(2, "element", "owner-a"),
      makeNode(3, "element", "owner-b"),
      makeNode(4, "element", "downstream-leaf"),
      // 6 leaf memos on owner-a (one with an error!)
      makeNode(11, "computed", "_computeAlpha", { ownerNodeId: 2 }),
      makeNode(12, "computed", "_computeBeta", { ownerNodeId: 2 }),
      makeNode(13, "computed", "_computeGamma", { ownerNodeId: 2 }),
      makeNode(14, "observer", "observeDelta", { ownerNodeId: 2 }),
      makeNode(15, "computed", "_computeEpsilon", { ownerNodeId: 2 }),
      makeNode(16, "computed", "_computeFailing", {
        ownerNodeId: 2,
        error: "RangeError: invalid coordinate",
      }),
      // 3 leaf memos on owner-b (below collapse threshold)
      makeNode(21, "computed", "_computeB1", { ownerNodeId: 3 }),
      makeNode(22, "computed", "_computeB2", { ownerNodeId: 3 }),
      makeNode(23, "observer", "observeB3", { ownerNodeId: 3 }),
    ];

    const edges: ReactivityEdgeSnapshot[] = [
      makeEdge(1, 2, "prop-flow", "state"),
      makeEdge(1, 3, "prop-flow", "state"),
      makeEdge(2, 4, "prop-flow", "child"),
      makeEdge(2, 11, "memo-compute", "memo"),
      makeEdge(2, 12, "memo-compute", "memo"),
      makeEdge(2, 13, "memo-compute", "memo"),
      makeEdge(2, 14, "memo-observe", "memo"),
      makeEdge(2, 15, "memo-compute", "memo"),
      makeEdge(2, 16, "memo-compute", "memo"),
      makeEdge(3, 21, "memo-compute", "memo"),
      makeEdge(3, 22, "memo-compute", "memo"),
      makeEdge(3, 23, "memo-observe", "memo"),
    ];

    const collapsed = computeGraphLayout(nodes, edges);
    expect(collapsed.clusters?.length).toBe(1);
    const cluster = collapsed.clusters![0]!;
    expect(cluster.ownerId).toBe(2);
    expect(cluster.hiddenCount).toBe(5);
    expect(cluster.expanded).toBe(false);

    // Healthy memos 11..15 collapsed into "+5 memos", error memo 16 stays visible
    for (const id of [11, 12, 13, 14, 15]) {
      expect(collapsed.nodeById.has(id)).toBe(false);
    }
    expect(collapsed.nodeById.has(16)).toBe(true);
    const clusterCard = collapsed.nodeById.get(cluster.clusterNodeId)!;
    expect(clusterCard.node.label).toBe("+5 memos");
    expect(clusterCard.height).toBe(52);
    expect(clusterCard.layer).toBe(collapsed.nodeById.get(2)!.layer + 1);

    // Owner-b memos 21..23 stay visible and contiguous at owner-b.layer + 1
    const ownerBLayer = collapsed.nodeById.get(3)!.layer;
    const ownerBMemoRows = [21, 22, 23].map((id) => {
      const pn = collapsed.nodeById.get(id)!;
      expect(pn.layer).toBe(ownerBLayer + 1);
      expect(pn.height).toBe(52);
      return pn.row;
    });
    const sortedRows = ownerBMemoRows.toSorted((a, b) => a - b);
    expect(sortedRows[2]! - sortedRows[0]!).toBe(2);

    // Expanded view restores all 6 memos contiguously and emits bus trunk (>= 5 fan-out)
    const expanded = computeGraphLayout(nodes, edges, {
      expandedMemoOwnerIds: new Set([2]),
    });
    expect(expanded.clusters?.[0]?.expanded).toBe(true);
    expect(expanded.nodeById.has(cluster.clusterNodeId)).toBe(false);
    const ownerALayer = expanded.nodeById.get(2)!.layer;
    const ownerAMemoRows = [11, 12, 13, 14, 15, 16].map((id) => {
      const pn = expanded.nodeById.get(id)!;
      expect(pn.layer).toBe(ownerALayer + 1);
      return pn.row;
    });
    const sortedA = ownerAMemoRows.toSorted((a, b) => a - b);
    expect(sortedA[5]! - sortedA[0]!).toBe(5);
    expect(expanded.busTrunks?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(expanded.junctions?.length ?? 0).toBeGreaterThanOrEqual(6);
  });

  test("emits shared bus trunks and junction points when fanOut >= 5", () => {
    const nodes: ReactivityNodeSnapshot[] = [
      makeNode(1, "controller", "NavController"),
      makeNode(2, "element", "nav-header"),
      makeNode(3, "element", "nav-sidebar"),
      makeNode(4, "element", "nav-breadcrumb"),
      makeNode(5, "element", "nav-status"),
      makeNode(6, "element", "nav-actions"),
      makeNode(7, "element", "nav-footer"),
    ];
    const edges: ReactivityEdgeSnapshot[] = [2, 3, 4, 5, 6, 7].map((dst) =>
      makeEdge(1, dst, "controller-to-element", "viewModel"),
    );

    const layout = computeGraphLayout(nodes, edges);
    expect(layout.busTrunks?.length).toBe(1);
    const trunk = layout.busTrunks![0]!;
    expect(trunk.sourceId).toBe(1);
    expect(trunk.kind).toBe("controller-to-element");
    expect(trunk.memberEdgeIds.length).toBe(6);
    expect(trunk.x).toBeGreaterThan(
      layout.nodeById.get(1)!.x + layout.nodeById.get(1)!.width,
    );
    expect(trunk.x).toBeLessThan(layout.nodeById.get(2)!.x);

    expect(layout.junctions?.length).toBeGreaterThanOrEqual(6);
    for (const edge of layout.edges) {
      expect(edge.isBusMember).toBe(true);
    }
    assertAllSegmentsClearCards(layout.edges, layout.nodes);
  });

  test("adaptive column widths stay within 224..296px based on measured titles", () => {
    const nodes: ReactivityNodeSnapshot[] = [
      makeNode(1, "model", "App"),
      makeNode(
        2,
        "element",
        "super-long-adaptive-column-dashboard-inspector-panel",
      ),
    ];
    const edges: ReactivityEdgeSnapshot[] = [
      makeEdge(1, 2, "prop-flow", "state"),
    ];

    const layout = computeGraphLayout(nodes, edges);
    const n1 = layout.nodeById.get(1)!;
    const n2 = layout.nodeById.get(2)!;
    expect(n1.width).toBeGreaterThanOrEqual(224);
    expect(n1.width).toBeLessThanOrEqual(296);
    expect(n2.width).toBeGreaterThan(n1.width);
    expect(n2.width).toBeLessThanOrEqual(296);
  });

  test("owner-anchored leaf honors pred.minSpan > 1 even when predRank === ownerRank", () => {
    const nodes: LayoutNodeInput[] = [
      { id: 1, width: 220, height: 70 },
      {
        id: 2,
        width: 220,
        height: 52,
        ownerGroupId: 1,
        anchorToOwner: true,
      },
    ];
    const edges: LayoutEdgeInput[] = [
      { id: "1->2", sourceId: 1, targetId: 2, minSpan: 2 },
    ];
    const res = computeHierarchicLayout(nodes, edges);
    expect(res.nodeById.get(2)!.layer).toBeGreaterThanOrEqual(
      res.nodeById.get(1)!.layer + 2,
    );
  });

  test("420-node / 400-edge large-graph stress test has zero overlaps and runs < 150ms", () => {
    const nodes: ReactivityNodeSnapshot[] = [];
    const edges: ReactivityEdgeSnapshot[] = [];

    // 380 active nodes across 6 tiers + 40 isolated nodes = 420 nodes total
    // Tier 0: 20 models, Tier 1: 40 controllers, Tier 2: 20 contexts,
    // Tier 3: 140 elements, Tier 4: 120 computeds, Tier 5: 40 observers
    let nextId = 1;
    const models: number[] = [];
    for (let i = 0; i < 20; i++) {
      nodes.push(makeNode(nextId, "model", `Model${i}`));
      models.push(nextId++);
    }
    const ctrls: number[] = [];
    for (let i = 0; i < 40; i++) {
      nodes.push(makeNode(nextId, "controller", `Controller${i}`));
      ctrls.push(nextId++);
    }
    const ctxs: number[] = [];
    for (let i = 0; i < 20; i++) {
      nodes.push(makeNode(nextId, "context", `Context${i}`));
      ctxs.push(nextId++);
    }
    const elems: number[] = [];
    for (let i = 0; i < 140; i++) {
      nodes.push(makeNode(nextId, "element", `x-widget-${i}`));
      elems.push(nextId++);
    }
    const memos: number[] = [];
    for (let i = 0; i < 160; i++) {
      const ownerId = elems[i % elems.length]!;
      const kind = i < 120 ? "computed" : "observer";
      nodes.push(
        makeNode(nextId, kind, `_computeField${i}`, { ownerNodeId: ownerId }),
      );
      memos.push(nextId++);
    }
    for (let i = 0; i < 40; i++) {
      nodes.push(makeNode(nextId++, "element", `x-isolated-${i}`));
    }
    expect(nodes.length).toBe(420);

    for (let i = 0; i < ctrls.length; i++) {
      edges.push(
        makeEdge(
          models[i % models.length]!,
          ctrls[i]!,
          "model-to-controller",
          "state",
        ),
      );
    }
    for (let i = 0; i < elems.length; i++) {
      edges.push(
        makeEdge(
          ctrls[i % ctrls.length]!,
          elems[i]!,
          "controller-to-element",
          "vm",
        ),
      );
      if (i % 3 === 0) {
        edges.push(
          makeEdge(ctxs[i % ctxs.length]!, elems[i]!, "context-consume", "ctx"),
        );
      }
      if (i >= 20 && i < 60) {
        edges.push(makeEdge(elems[i - 20]!, elems[i]!, "prop-flow", "prop"));
      }
    }
    for (let i = 0; i < memos.length; i++) {
      const ownerId = elems[i % elems.length]!;
      edges.push(
        makeEdge(
          ownerId,
          memos[i]!,
          i < 120 ? "memo-compute" : "memo-observe",
          "memo",
        ),
      );
    }
    for (let i = 0; i < 20; i++) {
      edges.push(makeEdge(elems[i * 3]!, ctrls[i]!, "event-emit", "action"));
    }
    expect(edges.length).toBeGreaterThanOrEqual(400);

    // Warm JIT once then measure actual layout call
    computeGraphLayout(nodes, edges);
    const t0 = performance.now();
    const layout = computeGraphLayout(nodes, edges);
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(150);
    expect(layout.nodes.length).toBe(420);
    expect(layout.edges.length).toBeGreaterThanOrEqual(400);
    expect(Number.isFinite(layout.width)).toBe(true);
    expect(Number.isFinite(layout.height)).toBe(true);

    for (const edge of layout.edges) {
      expect(edge.path.length).toBeGreaterThan(4);
      expect(Number.isFinite(edge.labelX)).toBe(true);
      expect(Number.isFinite(edge.labelY)).toBe(true);
    }

    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        expect(boxesOverlap(layout.nodes[i]!, layout.nodes[j]!)).toBe(false);
      }
    }
    assertAllSegmentsClearCards(layout.edges, layout.nodes);
  });
});
