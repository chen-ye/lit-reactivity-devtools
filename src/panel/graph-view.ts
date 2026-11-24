import type {
  EdgeKind,
  NodeKind,
  ReactivityNodeSnapshot,
} from "../protocol/types.ts";
import {
  GraphViewportController,
  findNearestDirectionalNode,
} from "../shared/graph-viewport.ts";
import {
  DEFAULT_LABEL_FONT,
  smartTruncateToPx,
} from "../shared/label-format.ts";
import {
  type BusTrunkSegment,
  type GraphLayout,
  type MemoClusterInfo,
  type PositionedNode,
  type RoutedEdge,
} from "./graph-layout.ts";
import type { PanelViewModel } from "./graph-state.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const AUTO_FIT_MIN_SCALE = 0.56;
const AUTO_FIT_MAX_SCALE = 1.08;
const LOD_HIDE_LABELS_SCALE = 0.45;

export interface GraphViewCallbacks {
  readonly onSelectNode: (nodeId: number | null) => void;
  readonly onFocusSubgraph: (nodeId: number) => void;
  readonly onHoverNode: (nodeId: number | null) => void;
  readonly onZoomChange?: ((scale: number) => void) | undefined;
  readonly onToggleMemoCluster?: ((ownerId: number) => void) | undefined;
}

interface NodeRenderFlags {
  readonly isSelected: boolean;
  readonly isRelated: boolean;
  readonly isSearchMatch: boolean;
  readonly isActiveMatch: boolean;
  readonly isDimmed: boolean;
  readonly isDirectCause: boolean;
  readonly isFocusedRoot: boolean;
  readonly showInPort: boolean;
  readonly showOutPort: boolean;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, String(value));
    }
  }
  return el;
}

function truncateText(text: string, maxChars: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  if (maxChars <= 1) return "…";
  return `${singleLine.slice(0, maxChars - 1)}…`;
}

function formatDurationMs(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 0.01) return "<0.01ms";
  if (ms < 10) return `${ms.toFixed(2)}ms`;
  return `${ms.toFixed(1)}ms`;
}

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

function defaultEdgeLabel(kind: EdgeKind): string {
  return DEFAULT_EDGE_LABELS[kind];
}

function formatNodeDisplayTitle(node: ReactivityNodeSnapshot): string {
  if (node.kind === "element" && !node.label.startsWith("<")) {
    return `<${node.label}>`;
  }
  return node.label;
}

function buildNodeTooltip(
  node: ReactivityNodeSnapshot,
  clusterInfo?: MemoClusterInfo,
): string {
  if (clusterInfo) {
    const kindCounts: string[] = [];
    if (clusterInfo.computedCount > 0) {
      kindCounts.push(`${clusterInfo.computedCount} computed`);
    }
    if (clusterInfo.observerCount > 0) {
      kindCounts.push(`${clusterInfo.observerCount} observer`);
    }
    const countSummary =
      kindCounts.length > 0
        ? kindCounts.join(", ")
        : `${clusterInfo.hiddenCount} memos`;
    const memberNames = clusterInfo.memberNodes
      .slice(0, 12)
      .map((member) => member.label)
      .join(", ");
    const remaining = clusterInfo.memberNodes.length - 12;
    const moreSuffix = remaining > 0 ? ` (+${remaining} more)` : "";
    return [
      `${clusterInfo.ownerLabel} · ${clusterInfo.hiddenCount} collapsed memos (${countSummary})`,
      `Click to expand: ${memberNames}${moreSuffix}`,
    ].join("\n");
  }

  const rootSuffix = node.rootType ? ` · ${node.rootType}` : "";
  const lines: string[] = [
    `${formatNodeDisplayTitle(node)} (#${node.id} · ${node.kind}${rootSuffix})`,
  ];
  if (node.subtitle) lines.push(node.subtitle);
  if (node.site) {
    const fnSuffix = node.site.fn ? ` (${node.site.fn})` : "";
    lines.push(
      `${node.site.file}:${node.site.line}:${node.site.column}${fnSuffix}`,
    );
  }
  if (node.value) lines.push(`Value: ${truncateText(node.value.text, 120)}`);
  if (node.lastCauseLabel) lines.push(`Last cause: ${node.lastCauseLabel}`);
  if (node.error) lines.push(`Error: ${node.error}`);
  return lines.join("\n");
}

function createArrowMarker(id: string, colorVar: string): SVGMarkerElement {
  const marker = svgEl("marker", {
    id,
    viewBox: "0 0 8 8",
    refX: 7,
    refY: 4,
    markerWidth: 6.5,
    markerHeight: 6.5,
    orient: "auto",
    markerUnits: "strokeWidth",
  });
  const path = svgEl("path", {
    d: "M 0.5 1 L 7.5 4 L 0.5 7 z",
    fill: colorVar,
  });
  marker.append(path);
  return marker;
}

function resolveVisibleSelectedId(vm: PanelViewModel): number | null {
  const candidateId = vm.selectedNode?.id ?? null;
  if (candidateId === null) return null;
  if (vm.layout.nodeById.has(candidateId)) return candidateId;
  for (const cluster of vm.layout.clusters ?? []) {
    if (!cluster.expanded && cluster.memberIds.includes(candidateId)) {
      return candidateId;
    }
  }
  return null;
}

export class GraphView {
  readonly #container: HTMLElement;
  readonly #callbacks: GraphViewCallbacks;
  readonly #svg: SVGSVGElement;
  readonly #viewportGroup: SVGGElement;
  readonly #edgesLayer: SVGGElement;
  readonly #busLayer: SVGGElement;
  readonly #nodesLayer: SVGGElement;
  readonly #viewport: GraphViewportController;
  readonly #resizeObserver: ResizeObserver;
  readonly #unbindPan: () => void;
  readonly #unbindWheel: () => void;

  readonly #edgeDomById = new Map<
    string,
    { readonly el: SVGGElement; renderKey: string }
  >();
  readonly #nodeDomById = new Map<
    number,
    { readonly el: SVGGElement; renderKey: string }
  >();

  #layout: GraphLayout | null = null;
  #lastVm: PanelViewModel | null = null;
  #busRenderKey = "";
  #hasFittedOnce = false;
  #lastFocusNodeId: number | null = null;
  #lastNodeCount = 0;
  #hoveredNodeId: number | null = null;

  constructor(container: HTMLElement, callbacks: GraphViewCallbacks) {
    this.#container = container;
    this.#callbacks = callbacks;

    this.#svg = svgEl("svg", {
      class: "graph-svg",
      "data-testid": "graph-svg",
      role: "application",
      "aria-label": "Causal reactivity dataflow graph",
      tabindex: "0",
    });

    const defs = svgEl("defs");
    defs.append(
      createArrowMarker("arrow-default", "var(--border-strong)"),
      createArrowMarker("arrow-model", "var(--kind-model)"),
      createArrowMarker("arrow-controller", "var(--kind-controller)"),
      createArrowMarker("arrow-context", "var(--kind-context)"),
      createArrowMarker("arrow-element", "var(--kind-element)"),
      createArrowMarker("arrow-computed", "var(--kind-computed)"),
      createArrowMarker("arrow-observer", "var(--kind-observer)"),
      createArrowMarker("arrow-feedback", "var(--color-event)"),
      createArrowMarker("arrow-active", "var(--accent)"),
    );

    this.#viewportGroup = svgEl("g", { class: "graph-viewport" });
    this.#edgesLayer = svgEl("g", { class: "graph-edges" });
    this.#busLayer = svgEl("g", { class: "graph-bus-layer" });
    this.#edgesLayer.append(this.#busLayer);
    this.#nodesLayer = svgEl("g", { class: "graph-nodes" });

    this.#viewportGroup.append(this.#edgesLayer, this.#nodesLayer);
    this.#svg.append(defs, this.#viewportGroup);
    this.#container.replaceChildren(this.#svg);

    this.#viewport = new GraphViewportController({
      onChange: () => {
        this.#applyTransform();
      },
    });

    this.#unbindPan = this.#viewport.bindPointerPan(this.#svg, {
      shouldIgnoreTarget: (target) =>
        target instanceof Element && target.closest(".graph-node") !== null,
    });
    this.#unbindWheel = this.#viewport.bindWheelZoom(this.#svg, {
      getViewportOrigin: () => this.#container.getBoundingClientRect(),
    });

    this.#svg.addEventListener("click", this.#onCanvasClick);
    this.#svg.addEventListener("keydown", this.#onKeyDown);

    this.#resizeObserver = new ResizeObserver(() => {
      if (
        !this.#viewport.userTransformed &&
        this.#layout &&
        this.#layout.nodes.length > 0
      ) {
        this.fit();
      }
    });
    this.#resizeObserver.observe(this.#container);
  }

  getScale(): number {
    return this.#viewport.scale;
  }

  render(vm: PanelViewModel, activeSearchMatchId: number | null = null): void {
    const prevFocus = this.#lastFocusNodeId;
    const prevNodeCount = this.#lastNodeCount;
    const activeElement = document.activeElement;
    const focusedNodeAttr =
      activeElement instanceof SVGElement
        ? activeElement.getAttribute("data-node-id")
        : null;
    const keyboardFocusNodeId =
      focusedNodeAttr !== null ? Number(focusedNodeAttr) : null;

    const prevLayout = this.#layout;
    const prevFocusNode =
      keyboardFocusNodeId !== null && prevLayout
        ? prevLayout.nodeById.get(keyboardFocusNodeId)
        : undefined;

    this.#lastVm = vm;
    this.#layout = vm.layout;
    this.#lastFocusNodeId = vm.focusedNode?.id ?? null;
    this.#lastNodeCount = vm.layout.nodes.length;

    this.#renderEdges(vm);
    this.#renderNodes(vm, activeSearchMatchId);

    if (keyboardFocusNodeId !== null && Number.isFinite(keyboardFocusNodeId)) {
      let target = this.#nodesLayer.querySelector<SVGGElement>(
        `g[data-node-id="${keyboardFocusNodeId}"]`,
      );
      if (!target && prevFocusNode?.clusterInfo) {
        for (const memberId of prevFocusNode.clusterInfo.memberIds) {
          target = this.#nodesLayer.querySelector<SVGGElement>(
            `g[data-node-id="${memberId}"]`,
          );
          if (target) break;
        }
        if (!target) {
          target = this.#nodesLayer.querySelector<SVGGElement>(
            `g[data-node-id="${prevFocusNode.clusterInfo.ownerId}"]`,
          );
        }
      }
      if (!target && vm.layout.clusters) {
        const enclosing = vm.layout.clusters.find((c) =>
          c.memberIds.includes(keyboardFocusNodeId),
        );
        if (enclosing) {
          target = this.#nodesLayer.querySelector<SVGGElement>(
            `g[data-node-id="${enclosing.clusterNodeId}"]`,
          );
        }
      }
      if (target) {
        target.focus({ preventScroll: true });
      } else {
        this.#svg.focus({ preventScroll: true });
      }
    }

    const focusChanged = prevFocus !== this.#lastFocusNodeId;
    const becamePopulated = prevNodeCount === 0 && vm.layout.nodes.length > 0;
    if (
      vm.layout.nodes.length > 0 &&
      (!this.#hasFittedOnce || becamePopulated || focusChanged)
    ) {
      if (!this.#viewport.userTransformed || focusChanged || becamePopulated) {
        this.fit();
      } else {
        this.#applyTransform();
      }
    } else {
      this.#applyTransform();
    }
  }

  fit(): void {
    if (!this.#layout || this.#layout.nodes.length === 0) {
      this.#viewport.resetZoom();
      return;
    }

    const rect = this.#container.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return;

    const pad = 16;
    const availW = Math.max(1, rect.width - pad * 2);
    const availH = Math.max(1, rect.height - pad * 2);
    const isCompactGraph =
      Boolean(this.#lastVm?.focusedNode) || this.#layout.nodes.length <= 40;
    const minScaleFloor = isCompactGraph
      ? Math.max(
          0.36,
          Math.min(
            AUTO_FIT_MIN_SCALE,
            availW / this.#layout.width,
            availH / this.#layout.height,
          ),
        )
      : AUTO_FIT_MIN_SCALE;

    // On large graphs (>40 nodes) where AUTO_FIT_MIN_SCALE overflows, frame the selected or most-active hub
    let anchor = this.#lastVm?.selectedNode
      ? (this.#layout.nodeById.get(this.#lastVm.selectedNode.id) ??
        this.#layout.nodes.find((n) =>
          n.clusterInfo?.memberIds.includes(this.#lastVm!.selectedNode!.id),
        ))
      : undefined;
    if (!anchor) {
      for (const candidate of this.#layout.nodes) {
        if (!anchor || candidate.node.updates > anchor.node.updates) {
          anchor = candidate;
        }
      }
    }

    const fitted = this.#viewport.fitToRect(
      { x: 0, y: 0, width: this.#layout.width, height: this.#layout.height },
      { width: rect.width, height: rect.height },
      {
        padding: pad,
        minScale: minScaleFloor,
        maxScale: AUTO_FIT_MAX_SCALE,
        ...(anchor
          ? {
              anchorRect: {
                x: anchor.x,
                y: anchor.y,
                width: anchor.width,
                height: anchor.height,
              },
              anchorBiasX: 0.36,
              anchorBiasY: 0.5,
            }
          : {}),
        markUserTransformed: false,
      },
    );
    if (fitted) {
      this.#hasFittedOnce = true;
    }
  }

  zoomIn(): void {
    const rect = this.#container.getBoundingClientRect();
    this.#viewport.zoomAtCenter(
      { width: rect.width, height: rect.height },
      1.2,
    );
  }

  zoomOut(): void {
    const rect = this.#container.getBoundingClientRect();
    this.#viewport.zoomAtCenter(
      { width: rect.width, height: rect.height },
      1 / 1.2,
    );
  }

  centerOnNode(nodeId: number): void {
    const pos =
      this.#layout?.nodeById.get(nodeId) ??
      this.#layout?.nodes.find((n) =>
        n.clusterInfo?.memberIds.includes(nodeId),
      );
    if (!pos) return;
    const rect = this.#container.getBoundingClientRect();
    this.#viewport.centerOnRect(
      { x: pos.x, y: pos.y, width: pos.width, height: pos.height },
      { width: rect.width, height: rect.height },
      { markUserTransformed: true },
    );
  }

  dispose(): void {
    this.#resizeObserver.disconnect();
    this.#unbindPan();
    this.#unbindWheel();
    this.#svg.removeEventListener("click", this.#onCanvasClick);
    this.#svg.removeEventListener("keydown", this.#onKeyDown);
  }

  #applyTransform(): void {
    const scale = this.#viewport.scale;
    this.#viewportGroup.setAttribute(
      "transform",
      this.#viewport.getSvgTransformAttribute(),
    );
    const denseGraph = (this.#layout?.edges.length ?? 0) > 40;
    const hideEdgeLabels = denseGraph
      ? scale < LOD_HIDE_LABELS_SCALE
      : scale < 0.34;
    this.#svg.classList.toggle("is-zoomed-out", hideEdgeLabels);
    this.#callbacks.onZoomChange?.(scale);
  }

  #renderEdges(vm: PanelViewModel): void {
    const selectedId = resolveVisibleSelectedId(vm);
    const latestSeq = vm.snapshot?.seq ?? 0;

    const activeChainIds = new Set<number>();
    if (selectedId !== null) {
      activeChainIds.add(selectedId);
      for (const id of vm.upstreamIds) activeChainIds.add(id);
      for (const id of vm.downstreamIds) activeChainIds.add(id);
      for (const cluster of vm.layout.clusters ?? []) {
        if (
          !cluster.expanded &&
          cluster.memberIds.some((mId) => activeChainIds.has(mId))
        ) {
          activeChainIds.add(cluster.clusterNodeId);
        }
      }
    }

    const effectiveMatchIds = new Set<number>(vm.searchMatchIds);
    if (vm.isHighlightQueryActive) {
      for (const cluster of vm.layout.clusters ?? []) {
        if (
          !cluster.expanded &&
          cluster.memberIds.some((mId) => vm.searchMatchIds.has(mId))
        ) {
          effectiveMatchIds.add(cluster.clusterNodeId);
        }
      }
    }

    const busTrunks = vm.layout.busTrunks ?? [];
    const junctions = vm.layout.junctions ?? [];
    const trunkByEdgeId = new Map<string, BusTrunkSegment>();
    for (const trunk of busTrunks) {
      for (const edgeId of trunk.memberEdgeIds) {
        trunkByEdgeId.set(edgeId, trunk);
      }
    }

    const highlightedEdgeIds = new Set<string>();
    const dimmedEdgeIds = new Set<string>();

    const nextIds = new Set<string>();
    for (const routed of vm.layout.edges) {
      nextIds.add(routed.edge.id);
      const isHighlighted =
        selectedId !== null &&
        activeChainIds.has(routed.edge.sourceId) &&
        activeChainIds.has(routed.edge.targetId);
      const isDimmed =
        selectedId !== null
          ? !isHighlighted
          : vm.isHighlightQueryActive &&
            !effectiveMatchIds.has(routed.edge.sourceId) &&
            !effectiveMatchIds.has(routed.edge.targetId);
      if (isHighlighted) highlightedEdgeIds.add(routed.edge.id);
      if (isDimmed) dimmedEdgeIds.add(routed.edge.id);
    }

    if (this.#edgesLayer.firstChild !== this.#busLayer) {
      this.#edgesLayer.prepend(this.#busLayer);
    }
    this.#renderBusLayer(
      busTrunks,
      junctions,
      highlightedEdgeIds,
      dimmedEdgeIds,
    );

    for (const [edgeId, cached] of this.#edgeDomById.entries()) {
      if (!nextIds.has(edgeId)) {
        cached.el.remove();
        this.#edgeDomById.delete(edgeId);
      }
    }

    let domCursor: ChildNode | null = this.#busLayer.nextSibling;
    for (const routed of vm.layout.edges) {
      const { edge } = routed;
      const isHighlighted = highlightedEdgeIds.has(edge.id);
      const isDimmed = dimmedEdgeIds.has(edge.id);
      const isRecent = latestSeq > 0 && edge.lastSeq >= latestSeq - 2;
      const effectivePath = this.#resolveEdgePath(
        vm.layout,
        routed,
        isHighlighted,
        trunkByEdgeId,
      );
      const renderKey = `${effectivePath}\u0001${routed.labelX}\u0001${routed.labelY}\u0001${edge.kind}\u0001${edge.label ?? ""}\u0001${edge.count}\u0001${edge.lastDetail ?? ""}\u0001${routed.isFeedback ? 1 : 0}\u0001${isHighlighted ? 1 : 0}\u0001${isDimmed ? 1 : 0}\u0001${isRecent ? 1 : 0}`;

      let cached = this.#edgeDomById.get(edge.id);
      if (!cached) {
        const el = svgEl("g");
        this.#patchEdgeElement(
          el,
          routed,
          effectivePath,
          isHighlighted,
          isDimmed,
          isRecent,
        );
        cached = { el, renderKey };
        this.#edgeDomById.set(edge.id, cached);
      } else if (cached.renderKey !== renderKey) {
        this.#patchEdgeElement(
          cached.el,
          routed,
          effectivePath,
          isHighlighted,
          isDimmed,
          isRecent,
        );
        cached.renderKey = renderKey;
      }

      if (cached.el !== domCursor) {
        this.#edgesLayer.insertBefore(cached.el, domCursor);
      } else {
        domCursor = domCursor.nextSibling;
      }
    }
  }

  #resolveEdgePath(
    layout: GraphLayout,
    routed: RoutedEdge,
    isHighlighted: boolean,
    trunkByEdgeId: ReadonlyMap<string, BusTrunkSegment>,
  ): string {
    if (!routed.isBusMember || isHighlighted || !routed.points) {
      return routed.path;
    }
    const trunk = trunkByEdgeId.get(routed.edge.id);
    if (!trunk) return routed.path;

    const srcPos = layout.nodeById.get(routed.edge.sourceId);
    const dstPos = layout.nodeById.get(routed.edge.targetId);
    if (
      !srcPos ||
      !dstPos ||
      srcPos.isIsolated ||
      dstPos.isIsolated ||
      srcPos.layer !== trunk.layerIndex ||
      dstPos.layer !== trunk.layerIndex + 1
    ) {
      return routed.path;
    }

    const pts = routed.points;
    const penultimate = pts.length >= 2 ? pts[pts.length - 2] : undefined;
    const yTap =
      penultimate && Math.abs(penultimate.x - trunk.x) < 1
        ? penultimate.y
        : routed.y2;
    return `M ${trunk.x} ${yTap} L ${routed.x2} ${routed.y2}`;
  }

  #renderBusLayer(
    busTrunks: ReadonlyArray<BusTrunkSegment>,
    junctions: NonNullable<GraphLayout["junctions"]>,
    highlightedEdgeIds: ReadonlySet<string>,
    dimmedEdgeIds: ReadonlySet<string>,
  ): void {
    const trunkStates = busTrunks.map((trunk) => {
      let anyHighlighted = false;
      let anyDimmed = false;
      let anyPlainVisible = false;
      for (const edgeId of trunk.memberEdgeIds) {
        const hl = highlightedEdgeIds.has(edgeId);
        const dm = dimmedEdgeIds.has(edgeId);
        if (hl) anyHighlighted = true;
        if (dm) anyDimmed = true;
        if (!hl && !dm) anyPlainVisible = true;
      }
      const isHighlighted = anyHighlighted && !anyDimmed;
      const isDimmed =
        trunk.memberEdgeIds.length > 0 &&
        !isHighlighted &&
        ((anyDimmed && !anyPlainVisible) ||
          trunk.memberEdgeIds.every((id) => dimmedEdgeIds.has(id)));
      return { trunk, isHighlighted, isDimmed };
    });

    const junctionStateByKey = new Map<
      string,
      { hasHighlighted: boolean; hasVisible: boolean }
    >();
    for (const st of trunkStates) {
      const existing = junctionStateByKey.get(st.trunk.busGroupKey) ?? {
        hasHighlighted: false,
        hasVisible: false,
      };
      if (st.isHighlighted) existing.hasHighlighted = true;
      if (!st.isDimmed) existing.hasVisible = true;
      junctionStateByKey.set(st.trunk.busGroupKey, existing);
    }

    const keyParts: string[] = [];
    for (const st of trunkStates) {
      keyParts.push(
        `T:${st.trunk.busGroupKey}:${st.trunk.kind}:${st.trunk.path}:${st.isHighlighted ? 1 : 0}:${st.isDimmed ? 1 : 0}`,
      );
    }
    for (const j of junctions) {
      const jState = j.busGroupKey
        ? junctionStateByKey.get(j.busGroupKey)
        : undefined;
      const isHl = jState?.hasHighlighted ?? false;
      const isDm = jState ? !jState.hasVisible : false;
      keyParts.push(
        `J:${j.x}:${j.y}:${j.kind}:${isHl ? 1 : 0}:${isDm ? 1 : 0}`,
      );
    }
    const nextKey = keyParts.join("\u0001");
    if (nextKey === this.#busRenderKey) return;
    this.#busRenderKey = nextKey;

    if (busTrunks.length === 0 && junctions.length === 0) {
      this.#busLayer.replaceChildren();
      return;
    }

    const children: SVGElement[] = [];
    for (const st of trunkStates) {
      const classes = ["graph-bus-trunk", `kind-${st.trunk.kind}`];
      if (st.isHighlighted) classes.push("is-highlighted");
      if (st.isDimmed) classes.push("is-dimmed");
      children.push(
        svgEl("path", {
          class: classes.join(" "),
          d: st.trunk.path,
        }),
      );
    }

    for (const j of junctions) {
      const jState = j.busGroupKey
        ? junctionStateByKey.get(j.busGroupKey)
        : undefined;
      const classes = ["graph-bus-junction", `kind-${j.kind}`];
      if (jState?.hasHighlighted) classes.push("is-highlighted");
      if (jState && !jState.hasVisible) classes.push("is-dimmed");
      children.push(
        svgEl("circle", {
          class: classes.join(" "),
          cx: j.x,
          cy: j.y,
          r: 2.8,
        }),
      );
    }

    this.#busLayer.replaceChildren(...children);
  }

  #patchEdgeElement(
    g: SVGGElement,
    routed: RoutedEdge,
    pathD: string,
    isHighlighted: boolean,
    isDimmed: boolean,
    isRecent: boolean,
  ): void {
    const { edge } = routed;
    const classes = ["graph-edge", `kind-${edge.kind}`];
    if (routed.isFeedback) classes.push("is-feedback");
    if (isHighlighted) classes.push("is-highlighted");
    if (isDimmed) classes.push("is-dimmed");
    if (isRecent) classes.push("is-recent");

    g.setAttribute("class", classes.join(" "));

    const markerId = this.#resolveEdgeMarker(
      edge.kind,
      routed.isFeedback,
      isHighlighted,
    );
    const path = svgEl("path", {
      class: "edge-path",
      d: pathD,
      "marker-end": `url(#${markerId})`,
    });

    const rawLabel = edge.label ?? defaultEdgeLabel(edge.kind);
    const labelWithCount =
      edge.count > 1 ? `${rawLabel} ×${edge.count}` : rawLabel;
    const displayLabel = truncateText(labelWithCount, 22);
    const pillWidth = Math.max(36, Math.round(displayLabel.length * 5.9 + 12));
    const pillHeight = 16;

    const labelBg = svgEl("rect", {
      class: "edge-label-bg",
      x: routed.labelX - pillWidth / 2,
      y: routed.labelY - pillHeight / 2,
      width: pillWidth,
      height: pillHeight,
      rx: 4,
    });
    const labelText = svgEl("text", {
      class: "edge-label-text",
      x: routed.labelX,
      y: routed.labelY,
    });
    labelText.textContent = displayLabel;

    const title = svgEl("title");
    const detailPart = edge.lastDetail ? ` (${edge.lastDetail})` : "";
    title.textContent = `${rawLabel} [${edge.kind}] ×${edge.count}${detailPart}`;

    g.replaceChildren(path, labelBg, labelText, title);
  }

  #resolveEdgeMarker(
    kind: EdgeKind,
    isFeedback: boolean,
    isHighlighted: boolean,
  ): string {
    if (isFeedback || kind === "event-emit") return "arrow-feedback";
    if (isHighlighted) return "arrow-active";
    switch (kind) {
      case "model-to-controller":
        return "arrow-model";
      case "controller-to-element":
        return "arrow-controller";
      case "context-provide":
      case "context-consume":
        return "arrow-context";
      case "prop-flow":
        return "arrow-element";
      case "memo-compute":
        return "arrow-computed";
      case "memo-observe":
        return "arrow-observer";
      default:
        return "arrow-default";
    }
  }

  #renderNodes(vm: PanelViewModel, activeSearchMatchId: number | null): void {
    const selectedId = resolveVisibleSelectedId(vm);
    const focusedId = vm.focusedNode?.id ?? null;

    const hasIncoming = new Set<number>();
    const hasOutgoing = new Set<number>();
    for (const routed of vm.layout.edges) {
      if (!routed.isFeedback) {
        hasOutgoing.add(routed.edge.sourceId);
        hasIncoming.add(routed.edge.targetId);
      }
    }

    const nextIds = new Set<number>();
    for (const positioned of vm.layout.nodes) {
      nextIds.add(positioned.node.id);
    }
    for (const [nodeId, cached] of this.#nodeDomById.entries()) {
      if (!nextIds.has(nodeId)) {
        cached.el.remove();
        this.#nodeDomById.delete(nodeId);
      }
    }

    let domCursor: ChildNode | null = this.#nodesLayer.firstChild;
    for (const positioned of vm.layout.nodes) {
      const { node, x, y, width, height, clusterInfo, isCompactMemo } =
        positioned;
      const id = node.id;
      const memberIds = clusterInfo?.memberIds;
      const clusterHasChainMember =
        selectedId !== null &&
        memberIds !== undefined &&
        memberIds.some(
          (mId) =>
            selectedId === mId ||
            vm.upstreamIds.has(mId) ||
            vm.downstreamIds.has(mId),
        );
      const isSelected = selectedId === id;
      const isRelated =
        (selectedId !== null &&
          (vm.upstreamIds.has(id) || vm.downstreamIds.has(id))) ||
        clusterHasChainMember;
      const inCausalChain = isSelected || isRelated;

      const clusterHasSearchMatch =
        memberIds !== undefined &&
        memberIds.some((mId) => vm.searchMatchIds.has(mId));
      const isSearchMatch =
        vm.isHighlightQueryActive &&
        (vm.searchMatchIds.has(id) || clusterHasSearchMatch);
      const isActiveMatch =
        activeSearchMatchId !== null &&
        ((activeSearchMatchId === id &&
          (vm.searchMatchIds.has(id) || clusterHasSearchMatch)) ||
          (memberIds !== undefined &&
            memberIds.includes(activeSearchMatchId) &&
            vm.searchMatchIds.has(activeSearchMatchId)));

      const isDimmed =
        selectedId !== null
          ? !inCausalChain && !isSearchMatch
          : vm.isHighlightQueryActive && !isSearchMatch;

      const flags: NodeRenderFlags = {
        isSelected,
        isRelated,
        isSearchMatch,
        isActiveMatch,
        isDimmed,
        isDirectCause: vm.directCauseNodeIds.has(id),
        isFocusedRoot: focusedId === id,
        showInPort: hasIncoming.has(id),
        showOutPort: hasOutgoing.has(id),
      };

      const renderKey = [
        x,
        y,
        width,
        height,
        isCompactMemo ? 1 : 0,
        positioned.formattedTitle ?? "",
        positioned.formattedTitleLines?.line1 ?? "",
        positioned.formattedTitleLines?.line2 ?? "",
        clusterInfo
          ? `${clusterInfo.hiddenCount}:${clusterInfo.computedCount}:${clusterInfo.observerCount}:${clusterInfo.ownerLabel}`
          : "",
        node.kind,
        node.label,
        node.subtitle ?? "",
        node.rootType ?? "",
        node.connected ? 1 : 0,
        node.updates,
        node.hits,
        node.misses,
        node.vetoes,
        node.lastDurationMs ?? "",
        node.lastCauseLabel ?? "",
        node.value?.text ?? "",
        node.error ?? "",
        node.properties?.length ?? 0,
        node.lastArgs?.map((a) => a.text).join("\u0002") ?? "",
        flags.isSelected ? 1 : 0,
        flags.isRelated ? 1 : 0,
        flags.isSearchMatch ? 1 : 0,
        flags.isActiveMatch ? 1 : 0,
        flags.isDimmed ? 1 : 0,
        flags.isDirectCause ? 1 : 0,
        flags.isFocusedRoot ? 1 : 0,
        flags.showInPort ? 1 : 0,
        flags.showOutPort ? 1 : 0,
      ].join("\u0001");

      let cached = this.#nodeDomById.get(id);
      if (!cached) {
        const g = this.#createNodeShell(id);
        this.#patchNodeElement(g, positioned, flags);
        cached = { el: g, renderKey };
        this.#nodeDomById.set(id, cached);
      } else if (cached.renderKey !== renderKey) {
        this.#patchNodeElement(cached.el, positioned, flags);
        cached.renderKey = renderKey;
      }

      if (cached.el !== domCursor) {
        this.#nodesLayer.insertBefore(cached.el, domCursor);
      } else {
        domCursor = domCursor.nextSibling;
      }
    }
  }

  #createNodeShell(nodeId: number): SVGGElement {
    const g = svgEl("g", {
      "data-node-id": nodeId,
      "data-testid": `graph-node-${nodeId}`,
      tabindex: "0",
      role: "button",
    });

    g.addEventListener("click", (evt) => {
      evt.stopPropagation();
      if (this.#viewport.consumeDidPanMove()) return;
      const positioned = this.#layout?.nodeById.get(nodeId);
      if (positioned?.clusterInfo) {
        this.#callbacks.onToggleMemoCluster?.(positioned.clusterInfo.ownerId);
        return;
      }
      this.#callbacks.onSelectNode(nodeId);
    });
    g.addEventListener("dblclick", (evt) => {
      evt.stopPropagation();
      const positioned = this.#layout?.nodeById.get(nodeId);
      if (positioned?.clusterInfo) return;
      this.#callbacks.onFocusSubgraph(nodeId);
    });
    g.addEventListener("pointerenter", () => {
      if (this.#hoveredNodeId !== nodeId) {
        this.#hoveredNodeId = nodeId;
        this.#callbacks.onHoverNode(nodeId);
      }
    });
    g.addEventListener("pointerleave", () => {
      if (this.#hoveredNodeId === nodeId) {
        this.#hoveredNodeId = null;
        this.#callbacks.onHoverNode(null);
      }
    });

    return g;
  }

  #patchNodeElement(
    g: SVGGElement,
    positioned: PositionedNode,
    flags: NodeRenderFlags,
  ): void {
    const { node, x, y, width, height, clusterInfo } = positioned;
    const isCompactMemo = positioned.isCompactMemo === true;

    const classes = ["graph-node", `kind-${node.kind}`];
    if (clusterInfo) classes.push("is-memo-cluster");
    if (isCompactMemo) classes.push("is-compact-memo");
    if (flags.isSelected) classes.push("is-selected");
    if (flags.isRelated) classes.push("is-related");
    if (flags.isSearchMatch) classes.push("is-search-match");
    if (flags.isActiveMatch) classes.push("is-active-match");
    if (flags.isDimmed) classes.push("is-dimmed");
    if (node.error !== null) classes.push("has-error");
    if (!node.connected) classes.push("is-disconnected");

    g.setAttribute("class", classes.join(" "));
    g.setAttribute("transform", `translate(${x}, ${y})`);
    g.setAttribute(
      "aria-label",
      clusterInfo
        ? `${node.kind} ${formatNodeDisplayTitle(node)}, ${node.updates} updates, click to expand`
        : `${node.kind} ${formatNodeDisplayTitle(node)}, ${node.updates} updates`,
    );
    g.setAttribute("aria-pressed", flags.isSelected ? "true" : "false");
    if (flags.isActiveMatch) {
      g.setAttribute("data-active-match", "true");
    } else {
      g.removeAttribute("data-active-match");
    }

    const children: SVGElement[] = [];

    if (flags.isActiveMatch) {
      children.push(
        this.#createCardShape(node.kind, "node-search-ring", width, height),
      );
    }
    if (flags.isSelected) {
      children.push(
        this.#createCardShape(node.kind, "node-selection-ring", width, height),
      );
    }

    children.push(this.#createCardShape(node.kind, "node-card", width, height));

    if (node.kind === "model") {
      children.push(
        svgEl("path", {
          class: "node-accent-stroke",
          d: `M 5 9 V ${height - 9} M 9 9 V ${height - 9}`,
        }),
      );
    }

    const badgeRightX = this.#appendKindBadge(children, node.kind);
    const rightReserved = this.#appendTopRightFlag(children, positioned, flags);

    const titleStartX = badgeRightX + 6;
    const titleAvailPx =
      width -
      titleStartX -
      rightReserved -
      (node.kind === "observer" ? 16 : 10);
    const titleMaxChars = Math.max(8, Math.floor(titleAvailPx / 7.1));

    const titleLines = positioned.formattedTitleLines ?? {
      line1:
        positioned.formattedTitle ??
        truncateText(formatNodeDisplayTitle(node), titleMaxChars),
      line2: null,
    };
    const hasTwoTitleLines = titleLines.line2 !== null;

    if (hasTwoTitleLines) {
      const line1Y = isCompactMemo ? 14 : 15;
      const line2Dy = isCompactMemo ? 12 : 13;
      const line1Text =
        flags.isDirectCause || flags.isFocusedRoot
          ? smartTruncateToPx(
              titleLines.line1,
              Math.max(40, titleAvailPx),
              DEFAULT_LABEL_FONT,
            )
          : titleLines.line1;
      const titleEl = svgEl("text", {
        class: "node-title",
        x: titleStartX,
        y: line1Y,
      });
      const tspan1 = svgEl("tspan", { x: titleStartX, y: line1Y });
      tspan1.textContent = line1Text;
      const tspan2 = svgEl("tspan", { x: titleStartX, dy: line2Dy });
      tspan2.textContent = titleLines.line2!;
      titleEl.append(tspan1, tspan2);
      children.push(titleEl);
    } else {
      const line1Text =
        flags.isDirectCause || flags.isFocusedRoot
          ? smartTruncateToPx(
              titleLines.line1,
              Math.max(40, titleAvailPx),
              DEFAULT_LABEL_FONT,
              node.disambiguator ?? null,
            )
          : titleLines.line1;
      const titleEl = svgEl("text", {
        class: "node-title",
        x: titleStartX,
        y: 19,
      });
      titleEl.textContent = line1Text;
      children.push(titleEl);
    }

    const contentX = node.kind === "model" || node.kind === "context" ? 16 : 12;

    if (!isCompactMemo) {
      const subAvailPx =
        width -
        contentX -
        (node.kind === "observer" || node.kind === "context" ? 16 : 12);
      const subMaxChars = Math.max(16, Math.floor(subAvailPx / 6.2));
      const subY = hasTwoTitleLines ? 44 : 41;
      const subEl = svgEl("text", {
        class: "node-sub",
        x: contentX,
        y: subY,
      });
      subEl.textContent = truncateText(
        this.#formatMiddleLine(node),
        subMaxChars,
      );
      children.push(subEl);
    }

    this.#appendBottomRow(
      children,
      positioned,
      contentX,
      isCompactMemo,
      hasTwoTitleLines,
    );

    if (flags.showInPort) {
      children.push(
        svgEl("circle", {
          class: "node-port",
          cx: 0,
          cy: height / 2,
          r: 3.5,
        }),
      );
    }
    if (flags.showOutPort) {
      const outX = node.kind === "observer" ? width - 11 : width;
      children.push(
        svgEl("circle", {
          class: "node-port",
          cx: outX,
          cy: height / 2,
          r: 3.5,
        }),
      );
    }

    const tooltip = svgEl("title");
    tooltip.textContent = buildNodeTooltip(node, clusterInfo);
    children.push(tooltip);

    g.replaceChildren(...children);
  }

  #createCardShape(
    kind: NodeKind,
    className: string,
    w: number,
    h: number,
  ): SVGElement {
    switch (kind) {
      case "model":
        return svgEl("rect", {
          class: className,
          x: 0,
          y: 0,
          width: w,
          height: h,
          rx: 6,
          ry: 6,
        });
      case "controller":
        return svgEl("path", {
          class: className,
          d: `M 6 0 H ${w - 11} L ${w} 11 V ${h - 11} L ${w - 11} ${h} H 6 Q 0 ${h} 0 ${h - 6} V 6 Q 0 0 6 0 Z`,
        });
      case "context": {
        const rx = Math.min(22, Math.floor(h / 2));
        return svgEl("rect", {
          class: className,
          x: 0,
          y: 0,
          width: w,
          height: h,
          rx,
          ry: rx,
        });
      }
      case "computed":
        return svgEl("path", {
          class: className,
          d: `M 10 0 H ${w - 10} L ${w} 10 V ${h - 10} L ${w - 10} ${h} H 10 L 0 ${h - 10} V 10 Z`,
        });
      case "observer":
        return svgEl("path", {
          class: className,
          d: `M 7 0 H ${w - 2} L ${w - 11} ${h / 2} L ${w - 2} ${h} H 7 Q 0 ${h} 0 ${h - 7} V 7 Q 0 0 7 0 Z`,
        });
      case "element":
      default:
        return svgEl("rect", {
          class: className,
          x: 0,
          y: 0,
          width: w,
          height: h,
          rx: 7,
          ry: 7,
        });
    }
  }

  #appendKindBadge(parentList: SVGElement[], kind: NodeKind): number {
    const badgeGroup = svgEl("g", { class: "node-badge-group" });
    switch (kind) {
      case "model": {
        badgeGroup.append(
          svgEl("rect", {
            class: "node-badge-bg",
            x: 14,
            y: 10,
            width: 22,
            height: 17,
            rx: 4,
          }),
        );
        const text = svgEl("text", {
          class: "node-badge-text",
          x: 25,
          y: 18.5,
        });
        text.textContent = "M";
        badgeGroup.append(text);
        parentList.push(badgeGroup);
        return 36;
      }
      case "controller": {
        badgeGroup.append(
          svgEl("path", {
            class: "node-badge-bg",
            d: "M 12 10 H 34 L 37 18.5 L 34 27 H 12 L 9 18.5 Z",
          }),
        );
        const text = svgEl("text", {
          class: "node-badge-text",
          x: 23,
          y: 18.5,
        });
        text.textContent = "Ctrl";
        badgeGroup.append(text);
        parentList.push(badgeGroup);
        return 37;
      }
      case "context": {
        badgeGroup.append(
          svgEl("rect", {
            class: "node-badge-bg",
            x: 13,
            y: 10,
            width: 25,
            height: 17,
            rx: 8.5,
          }),
        );
        const text = svgEl("text", {
          class: "node-badge-text",
          x: 25.5,
          y: 18.5,
        });
        text.textContent = "Ctx";
        badgeGroup.append(text);
        parentList.push(badgeGroup);
        return 38;
      }
      case "computed": {
        badgeGroup.append(
          svgEl("rect", {
            class: "node-badge-bg",
            x: 11,
            y: 10,
            width: 26,
            height: 17,
            rx: 4,
          }),
        );
        const text = svgEl("text", {
          class: "node-badge-text",
          x: 24,
          y: 18.5,
        });
        text.textContent = "f(x)";
        badgeGroup.append(text);
        parentList.push(badgeGroup);
        return 37;
      }
      case "observer": {
        badgeGroup.append(
          svgEl("rect", {
            class: "node-badge-bg",
            x: 10,
            y: 10,
            width: 26,
            height: 17,
            rx: 4,
          }),
        );
        const text = svgEl("text", {
          class: "node-badge-text",
          x: 23,
          y: 18.5,
        });
        text.textContent = "Obs";
        badgeGroup.append(text);
        parentList.push(badgeGroup);
        return 36;
      }
      case "element":
      default: {
        badgeGroup.append(
          svgEl("rect", {
            class: "node-badge-bg",
            x: 10,
            y: 10,
            width: 24,
            height: 17,
            rx: 4,
          }),
        );
        const text = svgEl("text", {
          class: "node-badge-text",
          x: 22,
          y: 18.5,
        });
        text.textContent = "<>";
        badgeGroup.append(text);
        parentList.push(badgeGroup);
        return 34;
      }
    }
  }

  #appendTopRightFlag(
    parentList: SVGElement[],
    positioned: PositionedNode,
    flags: NodeRenderFlags,
  ): number {
    const { node, width, clusterInfo } = positioned;
    const rightEdge =
      node.kind === "observer"
        ? width - 14
        : node.kind === "context"
          ? width - 14
          : width - 10;

    if (node.error !== null) {
      return this.#drawSolidFlag(parentList, rightEdge, 10, "ERR", "is-error");
    }
    if (clusterInfo) {
      return this.#drawMutedPill(
        parentList,
        rightEdge,
        11,
        "Expand ▸",
        "is-cluster-expand",
      );
    }
    if (flags.isDirectCause) {
      return this.#drawSolidFlag(
        parentList,
        rightEdge,
        10,
        "CAUSE",
        "is-cause",
      );
    }
    if (flags.isFocusedRoot) {
      return this.#drawSolidFlag(
        parentList,
        rightEdge,
        10,
        "FOCUS",
        "is-focus",
      );
    }
    if (node.kind === "element" && node.rootType === "closed-shadow") {
      return this.#drawMutedPill(parentList, rightEdge, 11, "closed");
    }
    return 0;
  }

  #drawSolidFlag(
    parentList: SVGElement[],
    rightEdge: number,
    y: number,
    label: string,
    variantClass: string,
  ): number {
    const width = Math.max(28, Math.round(label.length * 6.1 + 10));
    const x = rightEdge - width;
    const g = svgEl("g", { class: "node-flag-group" });
    g.append(
      svgEl("rect", {
        class: `node-flag-bg ${variantClass}`,
        x,
        y,
        width,
        height: 16,
        rx: 4,
      }),
    );
    const text = svgEl("text", {
      class: "node-flag-text",
      x: x + width / 2,
      y: y + 8.2,
    });
    text.textContent = label;
    g.append(text);
    parentList.push(g);
    return width + 6;
  }

  #drawMutedPill(
    parentList: SVGElement[],
    rightEdge: number,
    y: number,
    label: string,
    extraClass?: string,
  ): number {
    const width = Math.max(32, Math.round(label.length * 5.6 + 10));
    const x = rightEdge - width;
    const g = svgEl("g", {
      class: extraClass ? `node-flag-group ${extraClass}` : "node-flag-group",
    });
    g.append(
      svgEl("rect", {
        class: "node-pill-bg",
        x,
        y,
        width,
        height: 15,
        rx: 7.5,
      }),
    );
    const text = svgEl("text", {
      class: "node-pill-text",
      x: x + width / 2,
      y: y + 7.7,
    });
    text.textContent = label;
    g.append(text);
    parentList.push(g);
    return width + 6;
  }

  #formatMiddleLine(node: ReactivityNodeSnapshot): string {
    switch (node.kind) {
      case "model":
        return node.value?.text ?? node.subtitle ?? "Model store";
      case "controller":
        if (node.lastCauseLabel) return `← ${node.lastCauseLabel}`;
        return node.value?.text ?? node.subtitle ?? "Controller";
      case "context":
        return node.value?.text ?? "undefined";
      case "computed":
        return node.value?.text ?? "—";
      case "observer":
        if (node.lastArgs && node.lastArgs.length > 0) {
          return `(${node.lastArgs.map((arg) => arg.text).join(", ")})`;
        }
        return node.subtitle ?? "Memo observer";
      case "element":
      default: {
        if (node.lastCauseLabel) return `← ${node.lastCauseLabel}`;
        const propCount = node.properties?.length ?? 0;
        if (propCount > 0) {
          const base = node.subtitle ? `${node.subtitle} · ` : "";
          return `${base}${propCount} ${propCount === 1 ? "prop" : "props"}`;
        }
        return node.subtitle ?? "Custom element";
      }
    }
  }

  #appendBottomRow(
    parentList: SVGElement[],
    positioned: PositionedNode,
    leftX: number,
    isCompactMemo: boolean,
    hasTwoTitleLines: boolean,
  ): void {
    const { node, width, height, clusterInfo } = positioned;
    const rightEdge =
      node.kind === "observer"
        ? width - 14
        : node.kind === "context"
          ? width - 16
          : width - 12;

    const bottomY = isCompactMemo
      ? hasTwoTitleLines
        ? height - 10
        : height - 13
      : height - 15;

    let leftMetric = "";
    switch (node.kind) {
      case "model":
        leftMetric = `${node.updates} upd`;
        break;
      case "controller":
        leftMetric = `${node.updates} upd`;
        break;
      case "context":
        leftMetric = `${node.updates} ${node.updates === 1 ? "push" : "pushes"}`;
        break;
      case "element": {
        const detached = node.connected ? "" : " · detached";
        leftMetric = `${node.updates} ${node.updates === 1 ? "render" : "renders"}${detached}`;
        break;
      }
      case "computed": {
        const total = node.hits + node.misses;
        const pct =
          total > 0 ? ` (${Math.round((node.hits / total) * 100)}%)` : "";
        leftMetric = `${node.hits}H / ${node.misses}M${pct}`;
        break;
      }
      case "observer":
        leftMetric = `${node.misses} run · ${node.hits} skip`;
        break;
    }

    let cursorRight = rightEdge;
    if (node.kind === "element" && node.vetoes > 0) {
      const vetoWidth = this.#drawSolidFlag(
        parentList,
        cursorRight,
        bottomY - 8,
        `${node.vetoes} veto`,
        "is-veto",
      );
      cursorRight -= vetoWidth;
    }

    const durLabel = formatDurationMs(node.lastDurationMs);
    const rightMetric = clusterInfo
      ? durLabel || clusterInfo.ownerLabel
      : durLabel || `#${node.id}`;

    let reservedRightPx = 0;
    if (rightMetric.length > 0) {
      const displayRight = clusterInfo
        ? truncateText(rightMetric, 14)
        : rightMetric;
      const rightText = svgEl("text", {
        class: "node-meta",
        x: cursorRight,
        y: bottomY,
        "text-anchor": "end",
      });
      rightText.textContent = displayRight;
      parentList.push(rightText);
      reservedRightPx = displayRight.length * 6.1 + 12;
    }

    const availLeftPx = Math.max(48, cursorRight - reservedRightPx - leftX);
    const maxLeftChars = Math.max(6, Math.floor(availLeftPx / 6.1));

    const leftText = svgEl("text", {
      class: "node-meta",
      x: leftX,
      y: bottomY,
    });
    leftText.textContent = truncateText(leftMetric, maxLeftChars);
    parentList.push(leftText);
  }

  #onCanvasClick = (evt: MouseEvent): void => {
    if (this.#viewport.consumeDidPanMove()) {
      return;
    }
    const target = evt.target;
    if (target instanceof Element && target.closest(".graph-node") !== null) {
      return;
    }
    this.#callbacks.onSelectNode(null);
  };

  #onKeyDown = (evt: KeyboardEvent): void => {
    const layout = this.#layout;
    if (!layout || layout.nodes.length === 0) return;
    if (evt.ctrlKey || evt.metaKey || evt.altKey) return;

    if (evt.key === "0") {
      evt.preventDefault();
      this.fit();
      return;
    }
    if (evt.key === "+" || evt.key === "=") {
      evt.preventDefault();
      this.zoomIn();
      return;
    }
    if (evt.key === "-") {
      evt.preventDefault();
      this.zoomOut();
      return;
    }

    const activeEl = document.activeElement;
    const focusedAttr =
      activeEl instanceof SVGElement
        ? activeEl.getAttribute("data-node-id")
        : null;
    const currentId =
      focusedAttr !== null && Number.isFinite(Number(focusedAttr))
        ? Number(focusedAttr)
        : (this.#lastVm?.selectedNode?.id ?? layout.nodes[0]?.node.id ?? null);

    if (currentId === null) return;
    const currentPositioned = layout.nodeById.get(currentId);

    if (evt.key === "Enter" || evt.key === " ") {
      evt.preventDefault();
      if (currentPositioned?.clusterInfo) {
        if (!evt.shiftKey) {
          this.#callbacks.onToggleMemoCluster?.(
            currentPositioned.clusterInfo.ownerId,
          );
        }
        return;
      }
      if (evt.shiftKey) {
        this.#callbacks.onFocusSubgraph(currentId);
      } else {
        this.#callbacks.onSelectNode(currentId);
      }
      return;
    }

    if (evt.key === "f" || evt.key === "F") {
      evt.preventDefault();
      if (!currentPositioned?.clusterInfo) {
        this.#callbacks.onFocusSubgraph(currentId);
      }
      return;
    }

    if (
      evt.key === "ArrowUp" ||
      evt.key === "ArrowDown" ||
      evt.key === "ArrowLeft" ||
      evt.key === "ArrowRight"
    ) {
      evt.preventDefault();
      const directionalNodes = layout.nodes.map((n) => ({
        id: n.node.id,
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
      }));
      const nextId = findNearestDirectionalNode(
        directionalNodes,
        currentId,
        evt.key,
      );
      if (nextId !== null) {
        const nextPositioned = layout.nodeById.get(nextId);
        if (!nextPositioned?.clusterInfo) {
          this.#callbacks.onSelectNode(nextId);
        }
        const nextEl = this.#nodesLayer.querySelector<SVGGElement>(
          `g[data-node-id="${nextId}"]`,
        );
        nextEl?.focus({ preventScroll: true });
      }
    }
  };
}
