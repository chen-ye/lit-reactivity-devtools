import type {
  GraphSnapshot,
  NodeKind,
  ReactivityEdgeSnapshot,
  ReactivityNodeSnapshot,
  TraceEvent,
  TraceKind,
} from "../protocol/types.ts";
import {
  listExcludedTags,
  listIncludedTags,
  matchGlob,
  parseQuery,
  type ParsedQuery,
  type QueryToken,
} from "../shared/query-parser.ts";
import { computeGraphLayout, type GraphLayout } from "./graph-layout.ts";

export type KindFilter = "all" | NodeKind;
export type QueryMode = "highlight" | "filter";
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
  readonly queryMode: QueryMode;
  readonly kindFilter: KindFilter;
  readonly connectedOnly: boolean;
  readonly onlyErrors: boolean;
  readonly focusSubgraphNodeId: number | null;
  readonly expandedMemoOwnerIds: ReadonlySet<number>;
  readonly traceCategory: TraceCategoryFilter;
  readonly followSelectionInTraces: boolean;
}

export interface TagInventoryEntry {
  readonly tagName: string;
  readonly count: number;
  readonly excluded: boolean;
  readonly included: boolean;
}

export interface TagPrefixGroup {
  readonly prefix: string;
  readonly count: number;
  readonly excluded: boolean;
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
  readonly queryMode: QueryMode;
  readonly isHighlightQueryActive: boolean;
  readonly searchMatchIds: ReadonlySet<number>;
  readonly orderedMatchIds: ReadonlyArray<number>;
  readonly tagInventory: ReadonlyArray<TagInventoryEntry>;
  readonly prefixGroups: ReadonlyArray<TagPrefixGroup>;
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
  queryMode: "highlight",
  kindFilter: "all",
  connectedOnly: false,
  onlyErrors: false,
  focusSubgraphNodeId: null,
  expandedMemoOwnerIds: new Set(),
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

export function getNodeTagName(node: ReactivityNodeSnapshot): string | null {
  if (node.tagName && node.tagName.trim().length > 0) {
    return node.tagName.trim().toLowerCase();
  }
  if (node.kind === "element") {
    const firstWord = node.label.trim().split(/\s+/)[0] ?? "";
    const stripped = firstWord.replace(/^<|>$/g, "");
    if (stripped.length > 0) {
      return stripped.toLowerCase();
    }
  }
  return null;
}

export function nodeMatchesToken(
  node: ReactivityNodeSnapshot,
  token: QueryToken,
): boolean {
  if (token.value.length === 0) return true;

  switch (token.field) {
    case "tag": {
      const tag = getNodeTagName(node);
      return tag !== null && matchGlob(token.value, tag);
    }
    case "kind":
      return matchGlob(token.value, node.kind);
    case "prop":
      return (
        node.properties?.some(
          (p) =>
            matchGlob(token.value, p.name) ||
            (p.attribute !== null && matchGlob(token.value, p.attribute)),
        ) ?? false
      );
    case "file":
      return (
        node.site !== null &&
        node.site.file.toLowerCase().includes(token.value.toLowerCase())
      );
    case "is": {
      switch (token.value.toLowerCase()) {
        case "connected":
          return node.connected;
        case "disconnected":
          return !node.connected;
        case "error":
        case "errors":
          return node.error !== null;
        case "veto":
        case "vetoed":
        case "vetoes":
          return node.vetoes > 0;
        case "shadow":
          return node.rootType === "shadow";
        case "light":
          return node.rootType === "light";
        case "closed-shadow":
        case "closed":
          return node.rootType === "closed-shadow";
        case "memo":
          return node.kind === "computed" || node.kind === "observer";
        case "updated":
        case "dirty":
          return node.updates > 0;
        default:
          return false;
      }
    }
    case "id":
      return /^\d+$/.test(token.value) && node.id === Number(token.value);
    case "text": {
      const needle = token.value.toLowerCase();
      if (`#${node.id}`.includes(needle)) return true;
      if (node.label.toLowerCase().includes(needle)) return true;
      if (node.kind.toLowerCase().includes(needle)) return true;
      if (node.tagName?.toLowerCase().includes(needle)) return true;
      if (node.disambiguator?.toLowerCase().includes(needle)) return true;
      if (node.computeSource?.toLowerCase().includes(needle)) return true;
      if (node.computeSignature?.toLowerCase().includes(needle)) return true;
      if (node.subtitle?.toLowerCase().includes(needle)) return true;
      if (node.value?.text.toLowerCase().includes(needle)) return true;
      if (node.error?.toLowerCase().includes(needle)) return true;
      if (node.lastCauseLabel?.toLowerCase().includes(needle)) return true;
      if (node.site?.file.toLowerCase().includes(needle)) return true;
      if (
        node.properties?.some(
          (p) =>
            p.name.toLowerCase().includes(needle) ||
            p.value.text.toLowerCase().includes(needle) ||
            (p.attribute?.toLowerCase().includes(needle) ?? false),
        )
      ) {
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

function nodeMatchesBaseStructural(
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
  return true;
}

export function nodeMatchesFilter(
  node: ReactivityNodeSnapshot,
  filter: PanelFilterState,
  subgraphIds: ReadonlySet<number> | null,
  parsedQuery: ParsedQuery = parseQuery(filter.query),
): boolean {
  if (!nodeMatchesBaseStructural(node, filter, subgraphIds)) {
    return false;
  }
  if (parsedQuery.exclusions.some((token) => nodeMatchesToken(node, token))) {
    return false;
  }
  if (filter.queryMode === "filter" && parsedQuery.inclusions.length > 0) {
    return parsedQuery.inclusions.every((token) =>
      nodeMatchesToken(node, token),
    );
  }
  return true;
}

function buildTagInventoryAndPrefixes(
  nodes: ReadonlyArray<ReactivityNodeSnapshot>,
  filter: PanelFilterState,
  subgraphIds: ReadonlySet<number> | null,
  parsedQuery: ParsedQuery,
): {
  readonly tagInventory: ReadonlyArray<TagInventoryEntry>;
  readonly prefixGroups: ReadonlyArray<TagPrefixGroup>;
} {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (!nodeMatchesBaseStructural(node, filter, subgraphIds)) continue;
    if (
      parsedQuery.exclusions.some(
        (token) => token.field !== "tag" && nodeMatchesToken(node, token),
      )
    ) {
      continue;
    }
    const tag = getNodeTagName(node);
    if (tag === null) continue;
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }

  const excludedTags = listExcludedTags(filter.query);
  const includedTags = listIncludedTags(filter.query);

  const tagInventory: TagInventoryEntry[] = [];
  for (const [tagName, count] of counts.entries()) {
    tagInventory.push({
      tagName,
      count,
      excluded: excludedTags.some((pattern) => matchGlob(pattern, tagName)),
      included: includedTags.some((pattern) => matchGlob(pattern, tagName)),
    });
  }

  tagInventory.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.tagName < b.tagName ? -1 : a.tagName > b.tagName ? 1 : 0;
  });

  const byPrefix = new Map<string, TagInventoryEntry[]>();
  for (const entry of tagInventory) {
    const dashIdx = entry.tagName.indexOf("-");
    if (dashIdx <= 0) continue;
    const prefix = `${entry.tagName.slice(0, dashIdx)}-*`;
    const list = byPrefix.get(prefix);
    if (list) list.push(entry);
    else byPrefix.set(prefix, [entry]);
  }

  const prefixGroups: TagPrefixGroup[] = [];
  for (const [prefix, entries] of byPrefix.entries()) {
    if (entries.length < 2) continue;
    let count = 0;
    for (const entry of entries) count += entry.count;
    const excluded =
      excludedTags.some(
        (pattern) => pattern.toLowerCase() === prefix.toLowerCase(),
      ) || entries.every((entry) => entry.excluded);
    prefixGroups.push({
      prefix,
      count,
      excluded,
    });
  }

  prefixGroups.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0;
  });

  return { tagInventory, prefixGroups };
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
      queryMode: filter.queryMode,
      isHighlightQueryActive: false,
      searchMatchIds: new Set(),
      orderedMatchIds: [],
      tagInventory: [],
      prefixGroups: [],
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

  const parsedQuery = parseQuery(filter.query);
  const { tagInventory, prefixGroups } = buildTagInventoryAndPrefixes(
    snapshot.nodes,
    filter,
    subgraphIds,
    parsedQuery,
  );

  const structurallyVisibleNodes = snapshot.nodes.filter(
    (node) =>
      nodeMatchesBaseStructural(node, filter, subgraphIds) &&
      !parsedQuery.exclusions.some((token) => nodeMatchesToken(node, token)),
  );

  const hasPositiveInclusions = parsedQuery.inclusions.length > 0;
  const isHighlightQueryActive =
    filter.queryMode === "highlight" && hasPositiveInclusions;

  const matchingNodes = hasPositiveInclusions
    ? structurallyVisibleNodes.filter((node) =>
        parsedQuery.inclusions.every((token) => nodeMatchesToken(node, token)),
      )
    : [];
  const searchMatchIds = new Set(matchingNodes.map((n) => n.id));

  const visibleNodes =
    filter.queryMode === "filter" && hasPositiveInclusions
      ? matchingNodes
      : structurallyVisibleNodes;

  const visibleNodeIds = new Set(visibleNodes.map((n) => n.id));
  const visibleEdges = snapshot.edges.filter(
    (edge) =>
      visibleNodeIds.has(edge.sourceId) && visibleNodeIds.has(edge.targetId),
  );

  const layout = computeGraphLayout(visibleNodes, visibleEdges, {
    expandedMemoOwnerIds: filter.expandedMemoOwnerIds,
  });

  const clusterIdByMemberId = new Map<number, number>();
  for (const cluster of layout.clusters ?? []) {
    if (!cluster.expanded) {
      for (const memberId of cluster.memberIds) {
        clusterIdByMemberId.set(memberId, cluster.clusterNodeId);
      }
    }
  }

  const orderedMatchTargetIds = new Set<number>();
  for (const matchId of searchMatchIds) {
    orderedMatchTargetIds.add(clusterIdByMemberId.get(matchId) ?? matchId);
  }

  const orderedMatchIds = Array.from(orderedMatchTargetIds).toSorted((a, b) => {
    const posA = layout.nodeById.get(a);
    const posB = layout.nodeById.get(b);
    if (!posA && !posB) return a - b;
    if (!posA) return 1;
    if (!posB) return -1;
    if (posA.layer !== posB.layer) return posA.layer - posB.layer;
    if (posA.row !== posB.row) return posA.row - posB.row;
    return posA.node.id - posB.node.id;
  });

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
    queryMode: filter.queryMode,
    isHighlightQueryActive,
    searchMatchIds,
    orderedMatchIds,
    tagInventory,
    prefixGroups,
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
