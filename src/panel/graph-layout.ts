import type {
  EdgeKind,
  NodeKind,
  ReactivityEdgeSnapshot,
  ReactivityNodeSnapshot,
} from "../protocol/types.ts";

export const NODE_WIDTH = 238;
export const NODE_HEIGHT = 76;
export const LAYER_GAP = 148;
export const ROW_GAP = 24;
export const CANVAS_PADDING = 40;

export interface PositionedNode {
  readonly node: ReactivityNodeSnapshot;
  readonly layer: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RoutedEdge {
  readonly edge: ReactivityEdgeSnapshot;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly path: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly isFeedback: boolean;
}

export interface GraphLayout {
  readonly nodes: ReadonlyArray<PositionedNode>;
  readonly edges: ReadonlyArray<RoutedEdge>;
  readonly nodeById: ReadonlyMap<number, PositionedNode>;
  readonly width: number;
  readonly height: number;
  readonly layerCount: number;
}

const KIND_ORDER: Record<NodeKind, number> = {
  model: 0,
  controller: 1,
  context: 2,
  element: 3,
  computed: 4,
  observer: 5,
};

function coalesceParallelEdges(
  edges: ReadonlyArray<ReactivityEdgeSnapshot>,
): ReadonlyArray<ReactivityEdgeSnapshot> {
  interface EdgeGroup {
    readonly sourceId: number;
    readonly targetId: number;
    readonly kind: EdgeKind;
    readonly labels: string[];
    readonly details: string[];
    count: number;
    lastSeq: number;
  }

  const groups = new Map<string, EdgeGroup>();

  for (const edge of edges) {
    const key = `${edge.sourceId}->${edge.targetId}:${edge.kind}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        kind: edge.kind,
        labels: [],
        details: [],
        count: 0,
        lastSeq: 0,
      };
      groups.set(key, group);
    }
    group.count += edge.count;
    if (edge.lastSeq > group.lastSeq) group.lastSeq = edge.lastSeq;
    if (edge.label && !group.labels.includes(edge.label)) {
      group.labels.push(edge.label);
    }
    if (edge.lastDetail) {
      const prefix = edge.label ? `${edge.label}: ` : "";
      group.details.push(`${prefix}${edge.lastDetail}`);
    }
  }

  const merged: ReactivityEdgeSnapshot[] = [];
  for (const [key, g] of groups.entries()) {
    const label =
      g.labels.length === 0
        ? null
        : g.labels.length === 1
          ? g.labels[0]!
          : g.kind === "prop-flow"
            ? `props (${g.labels.length}): ${g.labels.join(", ")}`
            : g.labels.join(", ");
    merged.push({
      id: key,
      sourceId: g.sourceId,
      targetId: g.targetId,
      kind: g.kind,
      label,
      count: g.count,
      lastSeq: g.lastSeq,
      lastDetail: g.details.length > 0 ? g.details.join(" | ") : null,
    });
  }
  return merged;
}

export function computeGraphLayout(
  nodes: ReadonlyArray<ReactivityNodeSnapshot>,
  edges: ReadonlyArray<ReactivityEdgeSnapshot>,
): GraphLayout {
  if (nodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      nodeById: new Map(),
      width: CANVAS_PADDING * 2,
      height: CANVAS_PADDING * 2,
      layerCount: 0,
    };
  }

  const nodeMap = new Map<number, ReactivityNodeSnapshot>();
  const outgoing = new Map<number, number[]>();
  const incoming = new Map<number, number[]>();
  const inDegree = new Map<number, number>();

  for (const node of nodes) {
    nodeMap.set(node.id, node);
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  const filteredEdges: ReactivityEdgeSnapshot[] = [];
  for (const edge of edges) {
    if (edge.sourceId === edge.targetId) continue;
    if (!nodeMap.has(edge.sourceId) || !nodeMap.has(edge.targetId)) continue;
    filteredEdges.push(edge);
  }

  const coalescedEdges = coalesceParallelEdges(filteredEdges);

  for (const edge of coalescedEdges) {
    if (edge.kind !== "event-emit") {
      outgoing.get(edge.sourceId)?.push(edge.targetId);
      incoming.get(edge.targetId)?.push(edge.sourceId);
      inDegree.set(edge.targetId, (inDegree.get(edge.targetId) ?? 0) + 1);
    }
  }

  // Kahn's topological sort over forward dataflow edges (excludes event-emit feedback edges)
  const layerById = new Map<number, number>();
  const queue: number[] = [];

  for (const node of nodes) {
    if ((inDegree.get(node.id) ?? 0) === 0) {
      queue.push(node.id);
      layerById.set(node.id, 0);
    }
  }
  queue.sort((a, b) => compareNodes(nodeMap.get(a)!, nodeMap.get(b)!));

  const processed = new Set<number>();
  let cursor = 0;
  while (cursor < queue.length) {
    const id = queue[cursor++]!;
    processed.add(id);
    const currentLayer = layerById.get(id) ?? 0;

    for (const targetId of outgoing.get(id) ?? []) {
      const nextLayer = Math.max(
        layerById.get(targetId) ?? 0,
        currentLayer + 1,
      );
      layerById.set(targetId, nextLayer);
      const deg = (inDegree.get(targetId) ?? 0) - 1;
      inDegree.set(targetId, deg);
      if (deg === 0) {
        queue.push(targetId);
      }
    }
  }

  // Cycle-breaking fallback for unexpected forward cycles
  if (processed.size < nodes.length) {
    const remaining = nodes
      .filter((n) => !processed.has(n.id))
      .toSorted(compareNodes);
    for (const node of remaining) {
      let maxIn = -1;
      for (const srcId of incoming.get(node.id) ?? []) {
        const srcLayer = layerById.get(srcId);
        if (srcLayer !== undefined && srcLayer > maxIn) {
          maxIn = srcLayer;
        }
      }
      layerById.set(node.id, maxIn + 1);
    }
  }

  // Semantic column alignment for disconnected roots
  const hasModels = nodes.some((n) => n.kind === "model");
  const hasControllers = nodes.some((n) => n.kind === "controller");
  for (const node of nodes) {
    if ((incoming.get(node.id)?.length ?? 0) > 0) continue;
    const base = layerById.get(node.id) ?? 0;
    if ((node.kind === "controller" || node.kind === "context") && hasModels) {
      layerById.set(node.id, Math.max(base, 1));
    } else if (node.kind === "element" && (hasModels || hasControllers)) {
      layerById.set(node.id, Math.max(base, 1));
    } else if (
      (node.kind === "computed" || node.kind === "observer") &&
      nodes.some((n) => n.kind === "element")
    ) {
      layerById.set(node.id, Math.max(base, 2));
    }
  }

  let maxLayer = 0;
  for (const layer of layerById.values()) {
    if (layer > maxLayer) maxLayer = layer;
  }

  const layers: ReactivityNodeSnapshot[][] = Array.from(
    { length: maxLayer + 1 },
    () => [],
  );
  for (const node of nodes) {
    layers[layerById.get(node.id) ?? 0]?.push(node);
  }

  for (const layerNodes of layers) {
    layerNodes.sort(compareNodes);
  }

  // Two-pass Sugiyama barycenter crossing reduction
  for (let pass = 0; pass < 2; pass++) {
    for (let l = 1; l < layers.length; l++) {
      const prevRowById = indexLayer(layers[l - 1]!);
      sortLayerByBarycenter(layers[l]!, incoming, prevRowById);
    }
    for (let l = layers.length - 2; l >= 0; l--) {
      const nextRowById = indexLayer(layers[l + 1]!);
      sortLayerByBarycenter(layers[l]!, outgoing, nextRowById);
    }
  }

  let maxRows = 1;
  for (const layerNodes of layers) {
    if (layerNodes.length > maxRows) maxRows = layerNodes.length;
  }

  const maxColumnHeight =
    maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP;
  const positionedNodes: PositionedNode[] = [];
  const positionedById = new Map<number, PositionedNode>();
  let globalMaxNodeBottom = CANVAS_PADDING + maxColumnHeight;

  for (let l = 0; l < layers.length; l++) {
    const layerNodes = layers[l]!;
    const colHeight =
      layerNodes.length * NODE_HEIGHT +
      Math.max(0, layerNodes.length - 1) * ROW_GAP;
    const yOffset =
      CANVAS_PADDING + Math.round((maxColumnHeight - colHeight) / 2);
    const x = CANVAS_PADDING + l * (NODE_WIDTH + LAYER_GAP);

    for (let r = 0; r < layerNodes.length; r++) {
      const node = layerNodes[r]!;
      const y = yOffset + r * (NODE_HEIGHT + ROW_GAP);
      const bottom = y + NODE_HEIGHT;
      if (bottom > globalMaxNodeBottom) globalMaxNodeBottom = bottom;
      const positioned: PositionedNode = {
        node,
        layer: l,
        row: r,
        x,
        y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      };
      positionedNodes.push(positioned);
      positionedById.set(node.id, positioned);
    }
  }

  // Count outgoing forward edges per source so multi-fanout edge pills stagger cleanly
  const outCounts = new Map<number, number>();
  const outSeen = new Map<number, number>();
  for (const edge of coalescedEdges) {
    if (edge.kind !== "event-emit") {
      outCounts.set(edge.sourceId, (outCounts.get(edge.sourceId) ?? 0) + 1);
    }
  }

  let feedbackIdx = 0;
  let maxFeedbackY = globalMaxNodeBottom;

  const routedEdges: RoutedEdge[] = coalescedEdges.map((edge) => {
    const src = positionedById.get(edge.sourceId)!;
    const dst = positionedById.get(edge.targetId)!;
    const isFeedback = edge.kind === "event-emit" || dst.x <= src.x;

    if (!isFeedback) {
      const x1 = src.x + src.width;
      const y1 = src.y + src.height / 2;
      const x2 = dst.x;
      const y2 = dst.y + dst.height / 2;
      const dx = Math.max(48, (x2 - x1) * 0.5);
      const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

      // Stagger label position along cubic curve when source fans out to multiple targets
      const totalFan = outCounts.get(edge.sourceId) ?? 1;
      const fanIndex = outSeen.get(edge.sourceId) ?? 0;
      outSeen.set(edge.sourceId, fanIndex + 1);
      const t = totalFan <= 1 ? 0.5 : fanIndex % 2 === 0 ? 0.42 : 0.58;
      const omt = 1 - t;
      const c1x = x1 + dx;
      const c2x = x2 - dx;
      const lx =
        omt * omt * omt * x1 +
        3 * omt * omt * t * c1x +
        3 * omt * t * t * c2x +
        t * t * t * x2;
      const ly =
        omt * omt * omt * y1 +
        3 * omt * omt * t * y1 +
        3 * omt * t * t * y2 +
        t * t * t * y2;

      return {
        edge,
        x1,
        y1,
        x2,
        y2,
        path,
        labelX: Math.round(lx),
        labelY: Math.round(ly) - 8,
        isFeedback: false,
      };
    }

    // Route feedback / upward event arcs cleanly below ALL positioned nodes so they never cross cards
    const x1 = src.x + src.width * 0.5;
    const y1 = src.y + src.height;
    const x2 = dst.x + dst.width * 0.5;
    const y2 = dst.y + dst.height;
    const clearanceY = globalMaxNodeBottom + 32 + feedbackIdx * 26;
    feedbackIdx++;
    if (clearanceY > maxFeedbackY) maxFeedbackY = clearanceY;

    const path = `M ${x1} ${y1} C ${x1} ${clearanceY}, ${x2} ${clearanceY}, ${x2} ${y2}`;
    const midY = 0.125 * y1 + 0.75 * clearanceY + 0.125 * y2;
    return {
      edge,
      x1,
      y1,
      x2,
      y2,
      path,
      labelX: Math.round((x1 + x2) / 2),
      labelY: Math.round(midY) + 10,
      isFeedback: true,
    };
  });

  const width =
    CANVAS_PADDING * 2 +
    layers.length * NODE_WIDTH +
    Math.max(0, layers.length - 1) * LAYER_GAP;
  const height = Math.max(
    CANVAS_PADDING * 2 + maxColumnHeight,
    maxFeedbackY + 28,
  );

  return {
    nodes: positionedNodes,
    edges: routedEdges,
    nodeById: positionedById,
    width,
    height,
    layerCount: layers.length,
  };
}

function compareNodes(
  a: ReactivityNodeSnapshot,
  b: ReactivityNodeSnapshot,
): number {
  const kindDiff = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (kindDiff !== 0) return kindDiff;
  return a.id - b.id;
}

function indexLayer(
  layerNodes: ReadonlyArray<ReactivityNodeSnapshot>,
): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < layerNodes.length; i++) {
    map.set(layerNodes[i]!.id, i);
  }
  return map;
}

function sortLayerByBarycenter(
  layerNodes: ReactivityNodeSnapshot[],
  adjacency: ReadonlyMap<number, ReadonlyArray<number>>,
  neighborIndices: ReadonlyMap<number, number>,
): void {
  const originalOrder = indexLayer(layerNodes);
  layerNodes.sort((a, b) => {
    const scoreA = computeBarycenter(
      a.id,
      adjacency,
      neighborIndices,
      originalOrder.get(a.id) ?? 0,
    );
    const scoreB = computeBarycenter(
      b.id,
      adjacency,
      neighborIndices,
      originalOrder.get(b.id) ?? 0,
    );
    if (scoreA !== scoreB) return scoreA - scoreB;
    return compareNodes(a, b);
  });
}

function computeBarycenter(
  nodeId: number,
  adjacency: ReadonlyMap<number, ReadonlyArray<number>>,
  neighborIndices: ReadonlyMap<number, number>,
  fallbackIndex: number,
): number {
  const neighbors = adjacency.get(nodeId) ?? [];
  let sum = 0;
  let count = 0;
  for (const neighborId of neighbors) {
    const idx = neighborIndices.get(neighborId);
    if (idx !== undefined) {
      sum += idx;
      count += 1;
    }
  }
  return count > 0 ? sum / count : fallbackIndex;
}
