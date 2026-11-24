import type {
  EdgeKind,
  NodeKind,
  ReactivityEdgeSnapshot,
  ReactivityNodeSnapshot,
} from "../protocol/types.ts";
import {
  computeHierarchicLayout,
  type LayoutEdgeInput,
  type LayoutNodeInput,
  type LayoutPoint,
} from "../shared/hierarchic-layout.ts";
import {
  formatSemanticTitle,
  smartTruncateToPx,
  splitTwoLineTitle,
  type TwoLineTitle,
} from "../shared/label-format.ts";
import { measureTextPx } from "../shared/text-measure.ts";

export const NODE_WIDTH = 238;
export const NODE_HEIGHT = 76;
export const LAYER_GAP = 148;
export const ROW_GAP = 24;
export const CANVAS_PADDING = 40;

const MIN_CARD_WIDTH = 224;
const MAX_CARD_WIDTH = 296;
const COMPACT_MEMO_HEIGHT = 52;
const TALL_CARD_HEIGHT = 90;
const DEFAULT_MEMO_COLLAPSE_THRESHOLD = 4;
const DEFAULT_BUS_THRESHOLD = 5;

const TITLE_FONT =
  '600 11.5px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
const SUB_FONT =
  '500 10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
const EDGE_FONT =
  '500 9.5px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export interface MemoClusterInfo {
  readonly clusterNodeId: number;
  readonly ownerId: number;
  readonly ownerLabel: string;
  readonly memberIds: ReadonlyArray<number>;
  readonly memberNodes: ReadonlyArray<ReactivityNodeSnapshot>;
  readonly computedCount: number;
  readonly observerCount: number;
  readonly hiddenCount: number;
  readonly expanded: boolean;
}

export interface BusTrunkSegment {
  readonly busGroupKey: string;
  readonly layerIndex: number;
  readonly sourceId: number;
  readonly kind: EdgeKind;
  readonly x: number;
  readonly yStart: number;
  readonly yEnd: number;
  readonly path: string;
  readonly memberEdgeIds: ReadonlyArray<string>;
}

export interface BusJunctionPoint {
  readonly x: number;
  readonly y: number;
  readonly kind: EdgeKind;
  readonly busGroupKey?: string;
}

export interface LitLayoutOptions {
  readonly expandedMemoOwnerIds?: ReadonlySet<number>;
  readonly memoCollapseThreshold?: number;
  readonly busThreshold?: number;
}

export interface PositionedNode {
  readonly node: ReactivityNodeSnapshot;
  readonly layer: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly isCompactMemo?: boolean;
  readonly isIsolated?: boolean;
  readonly clusterInfo?: MemoClusterInfo;
  readonly formattedTitle?: string;
  readonly formattedTitleLines?: TwoLineTitle;
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
  readonly points?: ReadonlyArray<LayoutPoint>;
  readonly reversed?: boolean;
  readonly busGroupKey?: string | null;
  readonly isBusMember?: boolean;
}

export interface GraphLayout {
  readonly nodes: ReadonlyArray<PositionedNode>;
  readonly edges: ReadonlyArray<RoutedEdge>;
  readonly nodeById: ReadonlyMap<number, PositionedNode>;
  readonly width: number;
  readonly height: number;
  readonly layerCount: number;
  readonly clusters?: ReadonlyArray<MemoClusterInfo>;
  readonly busTrunks?: ReadonlyArray<BusTrunkSegment>;
  readonly junctions?: ReadonlyArray<BusJunctionPoint>;
}

const KIND_ORDER: Record<NodeKind, number> = {
  model: 0,
  controller: 1,
  context: 2,
  element: 3,
  computed: 4,
  observer: 5,
};

const EDGE_PRIORITY: Record<EdgeKind, number> = {
  "model-to-controller": 10,
  "controller-to-element": 9,
  "context-provide": 8,
  "context-consume": 7,
  "prop-flow": 6,
  "memo-compute": 5,
  "memo-observe": 4,
  "event-emit": -10,
};

const DEFAULT_EDGE_LABELS: Record<EdgeKind, string> = {
  "model-to-controller": "model-update",
  "controller-to-element": "viewModel",
  "prop-flow": "prop-flow",
  "context-provide": "provide",
  "context-consume": "context",
  "memo-compute": "memo",
  "memo-observe": "memo",
  "event-emit": "event-emit",
};

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}

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

function estimateEdgeLabelWidth(edge: ReactivityEdgeSnapshot): number {
  const raw = edge.label ?? DEFAULT_EDGE_LABELS[edge.kind];
  const withCount = edge.count > 1 ? `${raw} ×${edge.count}` : raw;
  const singleLine = withCount.replace(/\s+/g, " ").trim();
  const display =
    singleLine.length <= 22 ? singleLine : `${singleLine.slice(0, 21)}…`;
  return Math.max(36, Math.round(measureTextPx(display, EDGE_FONT) + 14));
}

function buildDisplayTitle(node: ReactivityNodeSnapshot): {
  readonly displayText: string;
  readonly disambiguator: string | null;
} {
  if (node.kind === "element") {
    const baseTag = node.tagName || node.label;
    const bracketed = baseTag.startsWith("<") ? baseTag : `<${baseTag}>`;
    return {
      displayText: bracketed,
      disambiguator: node.disambiguator ?? null,
    };
  }
  const semantic = formatSemanticTitle(node.label, {
    disambiguator: node.disambiguator ?? null,
  });
  return {
    displayText: semantic.title,
    disambiguator: semantic.disambiguator,
  };
}

export function computeGraphLayout(
  nodes: ReadonlyArray<ReactivityNodeSnapshot>,
  edges: ReadonlyArray<ReactivityEdgeSnapshot>,
  options?: LitLayoutOptions,
): GraphLayout {
  if (nodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      nodeById: new Map(),
      width: CANVAS_PADDING * 2,
      height: CANVAS_PADDING * 2,
      layerCount: 0,
      clusters: [],
      busTrunks: [],
      junctions: [],
    };
  }

  const memoCollapseThreshold =
    options?.memoCollapseThreshold ?? DEFAULT_MEMO_COLLAPSE_THRESHOLD;
  const busThreshold = options?.busThreshold ?? DEFAULT_BUS_THRESHOLD;
  const expandedMemoOwnerIds = options?.expandedMemoOwnerIds;

  const nodeMap = new Map<number, ReactivityNodeSnapshot>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  const filteredEdges: ReactivityEdgeSnapshot[] = [];
  for (const edge of edges) {
    if (edge.sourceId === edge.targetId) continue;
    if (!nodeMap.has(edge.sourceId) || !nodeMap.has(edge.targetId)) continue;
    filteredEdges.push(edge);
  }
  const coalescedEdges = coalesceParallelEdges(filteredEdges);

  // Build forward adjacency to identify leaf memos and owners
  const forwardInByNode = new Map<number, ReactivityEdgeSnapshot[]>();
  const forwardOutByNode = new Map<number, ReactivityEdgeSnapshot[]>();
  const eventCountByNode = new Map<number, number>();
  for (const node of nodes) {
    forwardInByNode.set(node.id, []);
    forwardOutByNode.set(node.id, []);
    eventCountByNode.set(node.id, 0);
  }
  for (const edge of coalescedEdges) {
    if (edge.kind === "event-emit") {
      eventCountByNode.set(
        edge.sourceId,
        (eventCountByNode.get(edge.sourceId) ?? 0) + 1,
      );
      continue;
    }
    forwardOutByNode.get(edge.sourceId)?.push(edge);
    forwardInByNode.get(edge.targetId)?.push(edge);
  }

  const inferredOwnerByMemoId = new Map<number, number>();
  const leafMemosByOwner = new Map<number, ReactivityNodeSnapshot[]>();
  const leafMemoIds = new Set<number>();

  for (const node of nodes) {
    if (node.kind !== "computed" && node.kind !== "observer") continue;

    let ownerId: number | null = null;
    if (node.ownerNodeId !== undefined && nodeMap.has(node.ownerNodeId)) {
      ownerId = node.ownerNodeId;
    } else {
      const ins = forwardInByNode.get(node.id) ?? [];
      const memoInSources = new Set<number>();
      let hasNonMemoIncoming = false;
      for (const e of ins) {
        if (e.kind === "memo-compute" || e.kind === "memo-observe") {
          memoInSources.add(e.sourceId);
        } else {
          hasNonMemoIncoming = true;
        }
      }
      if (!hasNonMemoIncoming && memoInSources.size === 1) {
        ownerId = memoInSources.values().next().value ?? null;
      }
    }

    if (ownerId === null || ownerId === node.id || !nodeMap.has(ownerId)) {
      continue;
    }
    inferredOwnerByMemoId.set(node.id, ownerId);

    const outs = forwardOutByNode.get(node.id) ?? [];
    const ins = forwardInByNode.get(node.id) ?? [];
    const externalIn = ins.some((e) => e.sourceId !== ownerId);
    const emitsEvents = (eventCountByNode.get(node.id) ?? 0) > 0;
    if (outs.length === 0 && !externalIn && !emitsEvents) {
      leafMemoIds.add(node.id);
      const list = leafMemosByOwner.get(ownerId);
      if (list) list.push(node);
      else leafMemosByOwner.set(ownerId, [node]);
    }
  }

  // Build collapsible memo clusters (> threshold per owner, preserving erroring memos)
  const usedIds = new Set<number>(nodes.map((n) => n.id));
  const collapsedMemberIds = new Set<number>();
  const clusterInfoByClusterNodeId = new Map<number, MemoClusterInfo>();
  const clusters: MemoClusterInfo[] = [];
  const clusterNodes: ReactivityNodeSnapshot[] = [];
  const collapsedRedirectByMemberId = new Map<number, number>();

  for (const [ownerId, allLeafMemos] of leafMemosByOwner.entries()) {
    if (allLeafMemos.length <= memoCollapseThreshold) continue;
    const healthyMembers = allLeafMemos.filter((m) => m.error === null);
    if (healthyMembers.length < 2) continue;

    const ownerNode = nodeMap.get(ownerId)!;
    const expanded = expandedMemoOwnerIds?.has(ownerId) ?? false;

    let clusterNodeId = -Math.max(1, Math.abs(ownerId));
    while (usedIds.has(clusterNodeId)) {
      clusterNodeId--;
    }
    usedIds.add(clusterNodeId);

    let computedCount = 0;
    let observerCount = 0;
    let totalUpdates = 0;
    let totalHits = 0;
    let totalMisses = 0;
    let totalVetoes = 0;
    let maxLastSeq = 0;
    let maxDurationMs: number | null = null;

    for (const m of healthyMembers) {
      if (m.kind === "computed") computedCount++;
      else observerCount++;
      totalUpdates += m.updates;
      totalHits += m.hits;
      totalMisses += m.misses;
      totalVetoes += m.vetoes;
      if (m.lastChangedSeq > maxLastSeq) maxLastSeq = m.lastChangedSeq;
      if (
        m.lastDurationMs !== null &&
        (maxDurationMs === null || m.lastDurationMs > maxDurationMs)
      ) {
        maxDurationMs = m.lastDurationMs;
      }
    }

    const info: MemoClusterInfo = {
      clusterNodeId,
      ownerId,
      ownerLabel: ownerNode.label,
      memberIds: healthyMembers.map((m) => m.id),
      memberNodes: healthyMembers,
      computedCount,
      observerCount,
      hiddenCount: healthyMembers.length,
      expanded,
    };
    clusters.push(info);

    if (!expanded) {
      clusterInfoByClusterNodeId.set(clusterNodeId, info);
      for (const m of healthyMembers) {
        collapsedMemberIds.add(m.id);
        collapsedRedirectByMemberId.set(m.id, clusterNodeId);
      }
      const dominantKind: NodeKind =
        computedCount >= observerCount ? "computed" : "observer";
      const clusterSnapshot: ReactivityNodeSnapshot = {
        id: clusterNodeId,
        kind: dominantKind,
        label: `+${healthyMembers.length} memos`,
        subtitle: ownerNode.label,
        site: null,
        connected: ownerNode.connected,
        updates: totalUpdates,
        hits: totalHits,
        misses: totalMisses,
        vetoes: totalVetoes,
        lastDurationMs: maxDurationMs,
        lastChangedSeq: maxLastSeq,
        lastCauseLabel: null,
        lastCauseNodeId: ownerId,
        value: null,
        error: null,
        ownerNodeId: ownerId,
      };
      clusterNodes.push(clusterSnapshot);
      inferredOwnerByMemoId.set(clusterNodeId, ownerId);
    }
  }

  const activeNodes: ReactivityNodeSnapshot[] = [];
  for (const node of nodes) {
    if (!collapsedMemberIds.has(node.id)) {
      activeNodes.push(node);
    }
  }
  for (const cn of clusterNodes) {
    activeNodes.push(cn);
  }

  // Rewire edges targeting collapsed leaf memos into a single summary edge per cluster
  const activeEdges: ReactivityEdgeSnapshot[] = [];
  const clusterEdgeAgg = new Map<
    number,
    {
      readonly ownerId: number;
      readonly clusterNodeId: number;
      readonly kinds: Set<EdgeKind>;
      count: number;
      lastSeq: number;
      readonly labels: string[];
    }
  >();

  for (const edge of coalescedEdges) {
    const redirectedTarget = collapsedRedirectByMemberId.get(edge.targetId);
    if (redirectedTarget !== undefined) {
      let agg = clusterEdgeAgg.get(redirectedTarget);
      if (!agg) {
        agg = {
          ownerId: edge.sourceId,
          clusterNodeId: redirectedTarget,
          kinds: new Set(),
          count: 0,
          lastSeq: 0,
          labels: [],
        };
        clusterEdgeAgg.set(redirectedTarget, agg);
      }
      agg.kinds.add(edge.kind);
      agg.count += edge.count;
      if (edge.lastSeq > agg.lastSeq) agg.lastSeq = edge.lastSeq;
      if (edge.label) agg.labels.push(edge.label);
      continue;
    }
    if (collapsedMemberIds.has(edge.sourceId)) continue;
    activeEdges.push(edge);
  }

  for (const agg of clusterEdgeAgg.values()) {
    const info = clusterInfoByClusterNodeId.get(agg.clusterNodeId)!;
    const edgeKind: EdgeKind =
      info.computedCount >= info.observerCount
        ? "memo-compute"
        : "memo-observe";
    activeEdges.push({
      id: `${agg.ownerId}->${agg.clusterNodeId}:${edgeKind}:cluster`,
      sourceId: agg.ownerId,
      targetId: agg.clusterNodeId,
      kind: edgeKind,
      label: `${info.hiddenCount} memos`,
      count: agg.count,
      lastSeq: agg.lastSeq,
      lastDetail: agg.labels.length > 0 ? agg.labels.join(", ") : null,
    });
  }

  // Semantic column hints for disconnected roots
  const hasModels = activeNodes.some((n) => n.kind === "model");
  const hasControllers = activeNodes.some((n) => n.kind === "controller");
  const hasElements = activeNodes.some((n) => n.kind === "element");

  const activeSnapshotById = new Map<number, ReactivityNodeSnapshot>();
  const formattedTitleById = new Map<number, string>();
  const formattedTitleLinesById = new Map<number, TwoLineTitle>();
  const isCompactById = new Map<number, boolean>();

  const layoutNodes: LayoutNodeInput[] = [];
  for (const node of activeNodes) {
    activeSnapshotById.set(node.id, node);
    const { displayText, disambiguator } = buildDisplayTitle(node);
    const badgeAndLeftPad =
      node.kind === "model" || node.kind === "context" ? 76 : 68;
    const rightFlagReserve =
      node.error !== null
        ? 44
        : node.kind === "element" && node.rootType
          ? 52
          : 18;

    const fullTitleForWidth = disambiguator
      ? `${displayText} ${disambiguator}`
      : displayText;
    const titleNeed =
      measureTextPx(fullTitleForWidth, TITLE_FONT) +
      badgeAndLeftPad +
      rightFlagReserve;
    const subSample = node.value?.text ?? node.subtitle ?? "";
    const subNeed = subSample
      ? Math.min(276, measureTextPx(subSample, SUB_FONT) + 32)
      : 0;
    const cardWidth = clamp(
      MIN_CARD_WIDTH,
      MAX_CARD_WIDTH,
      Math.ceil(Math.max(MIN_CARD_WIDTH, titleNeed, subNeed)),
    );

    const availTitlePx = cardWidth - badgeAndLeftPad - rightFlagReserve;
    const formattedTitle = smartTruncateToPx(
      displayText,
      availTitlePx,
      TITLE_FONT,
      disambiguator,
    );
    const formattedLines = splitTwoLineTitle(
      displayText,
      availTitlePx,
      TITLE_FONT,
      disambiguator,
    );
    formattedTitleById.set(node.id, formattedTitle);
    formattedTitleLinesById.set(node.id, formattedLines);

    const isClusterCard = clusterInfoByClusterNodeId.has(node.id);
    const isLeafMemo = leafMemoIds.has(node.id) || isClusterCard;
    const isCompactMemo = isLeafMemo && node.error === null;
    isCompactById.set(node.id, isCompactMemo);

    const needsTall =
      !isCompactMemo &&
      (formattedLines.line2 !== null ||
        node.error !== null ||
        node.vetoes > 0 ||
        (node.properties?.length ?? 0) >= 5);
    const cardHeight = isCompactMemo
      ? COMPACT_MEMO_HEIGHT
      : needsTall
        ? TALL_CARD_HEIGHT
        : NODE_HEIGHT;

    let minLayerHint = 0;
    if ((node.kind === "controller" || node.kind === "context") && hasModels) {
      minLayerHint = 1;
    } else if (node.kind === "element" && (hasModels || hasControllers)) {
      minLayerHint = 1;
    } else if (
      (node.kind === "computed" || node.kind === "observer") &&
      hasElements
    ) {
      minLayerHint = 2;
    }

    const ownerGroupId = inferredOwnerByMemoId.get(node.id) ?? null;

    layoutNodes.push({
      id: node.id,
      width: cardWidth,
      height: cardHeight,
      sortGroup: KIND_ORDER[node.kind],
      minLayerHint,
      ownerGroupId,
      anchorToOwner: isLeafMemo,
      ownerOrder: node.error !== null ? -1 : node.id,
    });
  }

  const edgeById = new Map<string, ReactivityEdgeSnapshot>();
  const layoutEdges: LayoutEdgeInput[] = [];
  for (const edge of activeEdges) {
    edgeById.set(edge.id, edge);
    const busGroupKey =
      edge.kind === "event-emit"
        ? null
        : edge.kind === "memo-compute" || edge.kind === "memo-observe"
          ? `${edge.sourceId}:memo`
          : `${edge.sourceId}:${edge.kind}`;

    layoutEdges.push({
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      priority: EDGE_PRIORITY[edge.kind],
      isFeedbackHint: edge.kind === "event-emit",
      busGroupKey,
      labelWidth: estimateEdgeLabelWidth(edge),
      labelHeight: 18,
      weight:
        edge.kind === "model-to-controller"
          ? 3
          : edge.kind === "controller-to-element"
            ? 2
            : 1,
      minSpan: 1,
    });
  }

  const rawLayout = computeHierarchicLayout(layoutNodes, layoutEdges, {
    padding: CANVAS_PADDING,
    minLayerGap: 112,
    nodeSpacingY: ROW_GAP,
    componentGap: 56,
    busThreshold,
    cornerRadius: 8,
    uniformColumnWidth: true,
  });

  const positionedNodes: PositionedNode[] = [];
  const nodeById = new Map<number, PositionedNode>();

  for (const pn of rawLayout.nodes) {
    const snapshot = activeSnapshotById.get(pn.id)!;
    const clusterInfo = clusterInfoByClusterNodeId.get(pn.id);
    const formattedTitle = formattedTitleById.get(pn.id);
    const formattedTitleLines = formattedTitleLinesById.get(pn.id);
    const isCompactMemo = isCompactById.get(pn.id);

    const nodeOut: PositionedNode = {
      node: snapshot,
      layer: pn.layer,
      row: pn.row,
      x: pn.x,
      y: pn.y,
      width: pn.width,
      height: pn.height,
      ...(isCompactMemo !== undefined ? { isCompactMemo } : {}),
      isIsolated: pn.isIsolated,
      ...(clusterInfo !== undefined ? { clusterInfo } : {}),
      ...(formattedTitle !== undefined ? { formattedTitle } : {}),
      ...(formattedTitleLines !== undefined ? { formattedTitleLines } : {}),
    };
    positionedNodes.push(nodeOut);
    nodeById.set(pn.id, nodeOut);
  }

  const routedEdges: RoutedEdge[] = rawLayout.edges.map((re) => ({
    edge: edgeById.get(re.id)!,
    x1: re.x1,
    y1: re.y1,
    x2: re.x2,
    y2: re.y2,
    path: re.path,
    labelX: re.labelX,
    labelY: re.labelY,
    isFeedback: re.isFeedback,
    points: re.points,
    reversed: re.reversed,
    busGroupKey: re.busGroupKey,
    isBusMember: re.isBusMember,
  }));

  const trunkKindByKey = new Map<string, EdgeKind>();
  const busTrunks: BusTrunkSegment[] = rawLayout.busTrunks.map((bt) => {
    const firstMemberId = bt.memberEdgeIds[0];
    const kind: EdgeKind =
      (firstMemberId ? edgeById.get(firstMemberId)?.kind : undefined) ??
      "prop-flow";
    trunkKindByKey.set(bt.busGroupKey, kind);
    return {
      busGroupKey: bt.busGroupKey,
      layerIndex: bt.layerIndex,
      sourceId: bt.sourceId,
      kind,
      x: bt.x,
      yStart: bt.yStart,
      yEnd: bt.yEnd,
      path: bt.path,
      memberEdgeIds: bt.memberEdgeIds,
    };
  });

  const junctions: BusJunctionPoint[] = rawLayout.junctions.map((j) => ({
    x: j.x,
    y: j.y,
    kind: trunkKindByKey.get(j.busGroupKey) ?? "prop-flow",
    busGroupKey: j.busGroupKey,
  }));

  return {
    nodes: positionedNodes,
    edges: routedEdges,
    nodeById,
    width: rawLayout.width,
    height: rawLayout.height,
    layerCount: rawLayout.layerCount,
    clusters,
    busTrunks,
    junctions,
  };
}
