import type {
  GraphSnapshot,
  NodeKind,
  ReactivityEdgeSnapshot,
  ReactivityNodeSnapshot,
  TraceEvent,
  TraceKind,
} from "../protocol/types.ts";
import { computeGraphLayout, type GraphLayout } from "./graph-layout.ts";

export type KindFilter = "all" | NodeKind;
export type TraceCategoryFilter =
  | "all"
  | "render"
  | "prop"
  | "context"
  | "memo"
  | "model-ctrl"
  | "event"
  | "veto-err";

export interface PanelFilterState {
  readonly query: string;
  readonly kindFilter: KindFilter;
  readonly connectedOnly: boolean;
  readonly onlyErrors: boolean;
  readonly focusSubgraphNodeId: number | null;
  readonly traceCategory: TraceCategoryFilter;
  readonly followSelectionInTraces: boolean;
}

export interface WaterfallCascade {
  readonly cascadeId: number;
  readonly rootLabel: string;
  readonly startedAt: number;
  readonly totalDurationMs: number;
  readonly events: ReadonlyArray<TraceEvent>;
}

export interface PanelViewModel {
  readonly snapshot: GraphSnapshot | null;
  readonly layout: GraphLayout;
  readonly visibleNodes: ReadonlyArray<ReactivityNodeSnapshot>;
  readonly visibleEdges: ReadonlyArray<ReactivityEdgeSnapshot>;
  readonly focusedNode: ReactivityNodeSnapshot | null;
  readonly selectedNode: ReactivityNodeSnapshot | null;
  readonly upstreamIds: ReadonlySet<number>;
  readonly downstreamIds: ReadonlySet<number>;
  readonly directCauseNodeIds: ReadonlySet<number>;
  readonly filteredEvents: ReadonlyArray<TraceEvent>;
  readonly cascades: ReadonlyArray<WaterfallCascade>;
  readonly stats: {
    readonly totalNodes: number;
    readonly modelCount: number;
    readonly controllerCount: number;
    readonly contextCount: number;
    readonly elementCount: number;
    readonly computedCount: number;
    readonly observerCount: number;
    readonly edgeCount: number;
    readonly vetoCount: number;
    readonly errorCount: number;
  };
}

export const DEFAULT_FILTER_STATE: PanelFilterState = {
  query: "",
  kindFilter: "all",
  connectedOnly: false,
  onlyErrors: false,
  focusSubgraphNodeId: null,
  traceCategory: "all",
  followSelectionInTraces: false,
};

export function traceKindMatchesCategory(
  kind: TraceKind,
  category: TraceCategoryFilter,
): boolean {
  switch (category) {
    case "render":
      return kind === "render";
    case "prop":
      return kind === "prop-change";
    case "context":
      return kind === "context-push";
    case "memo":
      return kind === "memo-miss" || kind === "memo-hit";
    case "model-ctrl":
      return kind === "model-update" || kind === "controller-transform";
    case "event":
      return kind === "custom-event";
    case "veto-err":
      return kind === "veto" || kind === "error";
    case "all":
    default:
      return true;
  }
}

export function collectReachableIds(
  startId: number,
  adjacency: ReadonlyMap<number, ReadonlyArray<number>>,
): ReadonlySet<number> {
  const visited = new Set<number>();
  const stack = [...(adjacency.get(startId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === startId || visited.has(id)) continue;
    visited.add(id);
    for (const nextId of adjacency.get(id) ?? []) {
      if (!visited.has(nextId)) {
        stack.push(nextId);
      }
    }
  }
  return visited;
}

export function nodeMatchesFilter(
  node: ReactivityNodeSnapshot,
  filter: PanelFilterState,
  subgraphIds: ReadonlySet<number> | null,
): boolean {
  if (subgraphIds !== null && !subgraphIds.has(node.id)) {
    return false;
  }
  if (filter.kindFilter !== "all" && node.kind !== filter.kindFilter) {
    return false;
  }
  if (filter.connectedOnly && !node.connected) {
    return false;
  }
  if (filter.onlyErrors && node.error === null && node.vetoes === 0) {
    return false;
  }

  const q = filter.query.trim().toLowerCase();
  if (!q) return true;

  if (`#${node.id}`.includes(q)) return true;
  if (node.label.toLowerCase().includes(q)) return true;
  if (node.kind.includes(q)) return true;
  if (node.subtitle?.toLowerCase().includes(q)) return true;
  if (node.value?.text.toLowerCase().includes(q)) return true;
  if (node.error?.toLowerCase().includes(q)) return true;
  if (node.site?.file.toLowerCase().includes(q)) return true;
  if (
    node.properties?.some(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.value.text.toLowerCase().includes(q),
    )
  ) {
    return true;
  }
  return false;
}

function buildCascades(
  events: ReadonlyArray<TraceEvent>,
): ReadonlyArray<WaterfallCascade> {
  const byCascade = new Map<number, TraceEvent[]>();
  for (const evt of events) {
    const list = byCascade.get(evt.cascadeId);
    if (list) list.push(evt);
    else byCascade.set(evt.cascadeId, [evt]);
  }

  const cascades: WaterfallCascade[] = [];
  for (const [cascadeId, group] of byCascade.entries()) {
    const chronological = group.toSorted((a, b) => a.seq - b.seq);
    const first = chronological[0]!;
    let totalDurationMs = 0;
    for (const evt of chronological) {
      totalDurationMs += evt.durationMs;
    }
    cascades.push({
      cascadeId,
      rootLabel: first.label,
      startedAt: first.timestamp,
      totalDurationMs,
      events: chronological,
    });
  }

  cascades.sort((a, b) => b.cascadeId - a.cascadeId);
  return cascades;
}

export function derivePanelViewModel(
  snapshot: GraphSnapshot | null,
  filter: PanelFilterState,
  selectedNodeId: number | null,
): PanelViewModel {
  if (!snapshot) {
    return {
      snapshot: null,
      layout: computeGraphLayout([], []),
      visibleNodes: [],
      visibleEdges: [],
      focusedNode: null,
      selectedNode: null,
      upstreamIds: new Set(),
      downstreamIds: new Set(),
      directCauseNodeIds: new Set(),
      filteredEvents: [],
      cascades: [],
      stats: {
        totalNodes: 0,
        modelCount: 0,
        controllerCount: 0,
        contextCount: 0,
        elementCount: 0,
        computedCount: 0,
        observerCount: 0,
        edgeCount: 0,
        vetoCount: 0,
        errorCount: 0,
      },
    };
  }

  let modelCount = 0;
  let controllerCount = 0;
  let contextCount = 0;
  let elementCount = 0;
  let computedCount = 0;
  let observerCount = 0;
  let vetoCount = 0;
  let errorCount = 0;

  const nodeById = new Map<number, ReactivityNodeSnapshot>();
  for (const node of snapshot.nodes) {
    nodeById.set(node.id, node);
    switch (node.kind) {
      case "model":
        modelCount++;
        break;
      case "controller":
        controllerCount++;
        break;
      case "context":
        contextCount++;
        break;
      case "element":
        elementCount++;
        break;
      case "computed":
        computedCount++;
        break;
      case "observer":
        observerCount++;
        break;
    }
    vetoCount += node.vetoes;
    if (node.error !== null) errorCount++;
  }

  const outgoing = new Map<number, number[]>();
  const incoming = new Map<number, number[]>();
  for (const edge of snapshot.edges) {
    const outList = outgoing.get(edge.sourceId);
    if (outList) outList.push(edge.targetId);
    else outgoing.set(edge.sourceId, [edge.targetId]);

    const inList = incoming.get(edge.targetId);
    if (inList) inList.push(edge.sourceId);
    else incoming.set(edge.targetId, [edge.sourceId]);
  }

  const focusedNode =
    filter.focusSubgraphNodeId !== null
      ? (nodeById.get(filter.focusSubgraphNodeId) ?? null)
      : null;

  let subgraphIds: Set<number> | null = null;
  if (focusedNode) {
    const up = collectReachableIds(focusedNode.id, incoming);
    const down = collectReachableIds(focusedNode.id, outgoing);
    subgraphIds = new Set<number>([focusedNode.id, ...up, ...down]);
  }

  const visibleNodes = snapshot.nodes.filter((node) =>
    nodeMatchesFilter(node, filter, subgraphIds),
  );
  const visibleNodeIds = new Set(visibleNodes.map((n) => n.id));
  const visibleEdges = snapshot.edges.filter(
    (edge) =>
      visibleNodeIds.has(edge.sourceId) && visibleNodeIds.has(edge.targetId),
  );

  const layout = computeGraphLayout(visibleNodes, visibleEdges);
  const selectedNode =
    selectedNodeId !== null ? (nodeById.get(selectedNodeId) ?? null) : null;

  const upstreamIds = selectedNode
    ? collectReachableIds(selectedNode.id, incoming)
    : new Set<number>();
  const downstreamIds = selectedNode
    ? collectReachableIds(selectedNode.id, outgoing)
    : new Set<number>();
  const directCauseNodeIds = new Set<number>(
    selectedNode?.lastCauseNodeId &&
      selectedNode.lastCauseNodeId !== selectedNode.id
      ? [selectedNode.lastCauseNodeId]
      : [],
  );

  const filteredEvents = snapshot.events
    .filter((evt) => {
      if (!traceKindMatchesCategory(evt.kind, filter.traceCategory)) {
        return false;
      }
      if (filter.followSelectionInTraces && selectedNode) {
        return (
          evt.nodeId === selectedNode.id || evt.causeNodeId === selectedNode.id
        );
      }
      return true;
    })
    .toReversed();

  const cascades = buildCascades(filteredEvents);

  return {
    snapshot,
    layout,
    visibleNodes,
    visibleEdges,
    focusedNode,
    selectedNode,
    upstreamIds,
    downstreamIds,
    directCauseNodeIds,
    filteredEvents,
    cascades,
    stats: {
      totalNodes: snapshot.nodes.length,
      modelCount,
      controllerCount,
      contextCount,
      elementCount,
      computedCount,
      observerCount,
      edgeCount: snapshot.edges.length,
      vetoCount,
      errorCount,
    },
  };
}
