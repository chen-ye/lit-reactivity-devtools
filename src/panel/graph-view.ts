import type {
  EdgeKind,
  NodeKind,
  ReactivityNodeSnapshot,
} from "../protocol/types.ts";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  type GraphLayout,
  type PositionedNode,
  type RoutedEdge,
} from "./graph-layout.ts";
import type { PanelViewModel } from "./graph-state.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;
const AUTO_FIT_MIN_SCALE = 0.56;
const AUTO_FIT_MAX_SCALE = 1.08;

export interface GraphViewCallbacks {
  readonly onSelectNode: (nodeId: number | null) => void;
  readonly onFocusSubgraph: (nodeId: number) => void;
  readonly onHoverNode: (nodeId: number | null) => void;
  readonly onZoomChange?: (scale: number) => void;
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

function formatRootTypeBadge(
  rootType: ReactivityNodeSnapshot["rootType"],
): string | null {
  switch (rootType) {
    case "shadow":
      return "shadow";
    case "light":
      return "light";
    case "closed-shadow":
      return "closed";
    default:
      return null;
  }
}

function buildNodeTooltip(node: ReactivityNodeSnapshot): string {
  const lines: string[] = [
    `${formatNodeDisplayTitle(node)} (#${node.id} · ${node.kind})`,
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

export class GraphView {
  readonly #container: HTMLElement;
  readonly #callbacks: GraphViewCallbacks;
  readonly #svg: SVGSVGElement;
  readonly #viewport: SVGGElement;
  readonly #edgesLayer: SVGGElement;
  readonly #nodesLayer: SVGGElement;
  readonly #resizeObserver: ResizeObserver;

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
  #scale = 1;
  #tx = 0;
  #ty = 0;
  #hasFittedOnce = false;
  #userTransformed = false;
  #lastFocusNodeId: number | null = null;
  #lastNodeCount = 0;
  #hoveredNodeId: number | null = null;

  #panning = false;
  #panPointerId: number | null = null;
  #panStartX = 0;
  #panStartY = 0;
  #panOriginTx = 0;
  #panOriginTy = 0;
  #didPanMove = false;

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

    this.#viewport = svgEl("g", { class: "graph-viewport" });
    this.#edgesLayer = svgEl("g", { class: "graph-edges" });
    this.#nodesLayer = svgEl("g", { class: "graph-nodes" });

    this.#viewport.append(this.#edgesLayer, this.#nodesLayer);
    this.#svg.append(defs, this.#viewport);
    this.#container.replaceChildren(this.#svg);

    this.#svg.addEventListener("pointerdown", this.#onPointerDown);
    this.#svg.addEventListener("pointermove", this.#onPointerMove);
    this.#svg.addEventListener("pointerup", this.#onPointerUp);
    this.#svg.addEventListener("pointercancel", this.#onPointerUp);
    this.#svg.addEventListener("wheel", this.#onWheel, { passive: false });
    this.#svg.addEventListener("click", this.#onCanvasClick);
    this.#svg.addEventListener("keydown", this.#onKeyDown);

    this.#resizeObserver = new ResizeObserver(() => {
      if (
        !this.#userTransformed &&
        this.#layout &&
        this.#layout.nodes.length > 0
      ) {
        this.fit();
      }
    });
    this.#resizeObserver.observe(this.#container);
  }

  getScale(): number {
    return this.#scale;
  }

  render(vm: PanelViewModel): void {
    const prevFocus = this.#lastFocusNodeId;
    const prevNodeCount = this.#lastNodeCount;
    const activeElement = document.activeElement;
    const focusedNodeAttr =
      activeElement instanceof SVGElement
        ? activeElement.getAttribute("data-node-id")
        : null;
    const keyboardFocusNodeId =
      focusedNodeAttr !== null ? Number(focusedNodeAttr) : null;

    this.#lastVm = vm;
    this.#layout = vm.layout;
    this.#lastFocusNodeId = vm.focusedNode?.id ?? null;
    this.#lastNodeCount = vm.layout.nodes.length;

    this.#renderEdges(vm);
    this.#renderNodes(vm);

    if (keyboardFocusNodeId !== null && Number.isFinite(keyboardFocusNodeId)) {
      const target = this.#nodesLayer.querySelector<SVGGElement>(
        `g[data-node-id="${keyboardFocusNodeId}"]`,
      );
      if (target) {
        target.focus({ preventScroll: true });
      }
    }

    const focusChanged = prevFocus !== this.#lastFocusNodeId;
    const becamePopulated = prevNodeCount === 0 && vm.layout.nodes.length > 0;
    if (
      vm.layout.nodes.length > 0 &&
      (!this.#hasFittedOnce || becamePopulated || focusChanged)
    ) {
      if (!this.#userTransformed || focusChanged || becamePopulated) {
        this.fit();
      }
    } else {
      this.#applyTransform();
    }
  }

  fit(): void {
    if (!this.#layout || this.#layout.nodes.length === 0) {
      this.#scale = 1;
      this.#tx = 0;
      this.#ty = 0;
      this.#applyTransform();
      return;
    }

    const rect = this.#container.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return;

    const pad = 16;
    const availW = Math.max(1, rect.width - pad * 2);
    const availH = Math.max(1, rect.height - pad * 2);
    const rawScale = Math.min(
      availW / this.#layout.width,
      availH / this.#layout.height,
    );
    const minScaleFloor = this.#lastVm?.focusedNode
      ? Math.max(
          0.36,
          Math.min(AUTO_FIT_MIN_SCALE, availW / this.#layout.width),
        )
      : AUTO_FIT_MIN_SCALE;
    const scale = Math.max(
      minScaleFloor,
      Math.min(AUTO_FIT_MAX_SCALE, rawScale),
    );

    this.#scale = scale;
    const fitsW = this.#layout.width * scale <= rect.width;
    const fitsH = this.#layout.height * scale <= rect.height;

    if (fitsW && fitsH) {
      this.#tx = Math.round((rect.width - this.#layout.width * scale) / 2);
      this.#ty = Math.round((rect.height - this.#layout.height * scale) / 2);
    } else {
      // On large graphs (>40 nodes) where AUTO_FIT_MIN_SCALE overflows, frame the selected or most-active hub
      let anchor = this.#lastVm?.selectedNode
        ? this.#layout.nodeById.get(this.#lastVm.selectedNode.id)
        : undefined;
      if (!anchor) {
        for (const candidate of this.#layout.nodes) {
          if (!anchor || candidate.node.updates > anchor.node.updates) {
            anchor = candidate;
          }
        }
      }
      if (anchor) {
        const cx = anchor.x + anchor.width / 2;
        const cy = anchor.y + anchor.height / 2;
        this.#tx = fitsW
          ? Math.round((rect.width - this.#layout.width * scale) / 2)
          : Math.round(rect.width * 0.36 - cx * scale);
        this.#ty = fitsH
          ? Math.round((rect.height - this.#layout.height * scale) / 2)
          : Math.round(rect.height * 0.5 - cy * scale);
      } else {
        this.#tx = pad;
        this.#ty = pad;
      }
    }
    this.#hasFittedOnce = true;
    this.#userTransformed = false;
    this.#applyTransform();
  }

  zoomIn(): void {
    this.#zoomAtCenter(1.2);
  }

  zoomOut(): void {
    this.#zoomAtCenter(1 / 1.2);
  }

  centerOnNode(nodeId: number): void {
    const pos = this.#layout?.nodeById.get(nodeId);
    if (!pos) return;
    const rect = this.#container.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return;

    const cx = pos.x + pos.width / 2;
    const cy = pos.y + pos.height / 2;
    this.#tx = Math.round(rect.width / 2 - cx * this.#scale);
    this.#ty = Math.round(rect.height / 2 - cy * this.#scale);
    this.#userTransformed = true;
    this.#applyTransform();
  }

  dispose(): void {
    this.#resizeObserver.disconnect();
    this.#svg.removeEventListener("pointerdown", this.#onPointerDown);
    this.#svg.removeEventListener("pointermove", this.#onPointerMove);
    this.#svg.removeEventListener("pointerup", this.#onPointerUp);
    this.#svg.removeEventListener("pointercancel", this.#onPointerUp);
    this.#svg.removeEventListener("wheel", this.#onWheel);
    this.#svg.removeEventListener("click", this.#onCanvasClick);
    this.#svg.removeEventListener("keydown", this.#onKeyDown);
  }

  #zoomAtCenter(factor: number): void {
    const rect = this.#container.getBoundingClientRect();
    this.#zoomAtPoint(rect.width / 2, rect.height / 2, factor);
  }

  #zoomAtPoint(
    clientOffsetX: number,
    clientOffsetY: number,
    factor: number,
  ): void {
    const nextScale = Math.max(
      MIN_SCALE,
      Math.min(MAX_SCALE, this.#scale * factor),
    );
    if (nextScale === this.#scale) return;

    const worldX = (clientOffsetX - this.#tx) / this.#scale;
    const worldY = (clientOffsetY - this.#ty) / this.#scale;
    this.#scale = nextScale;
    this.#tx = clientOffsetX - worldX * nextScale;
    this.#ty = clientOffsetY - worldY * nextScale;
    this.#userTransformed = true;
    this.#applyTransform();
  }

  #applyTransform(): void {
    this.#viewport.setAttribute(
      "transform",
      `translate(${this.#tx.toFixed(1)}, ${this.#ty.toFixed(1)}) scale(${this.#scale.toFixed(4)})`,
    );
    this.#callbacks.onZoomChange?.(this.#scale);
  }

  #renderEdges(vm: PanelViewModel): void {
    const selectedId = vm.selectedNode?.id ?? null;
    const latestSeq = vm.snapshot?.seq ?? 0;

    const activeChainIds = new Set<number>();
    if (selectedId !== null) {
      activeChainIds.add(selectedId);
      for (const id of vm.upstreamIds) activeChainIds.add(id);
      for (const id of vm.downstreamIds) activeChainIds.add(id);
    }

    const nextIds = new Set<string>();
    for (const routed of vm.layout.edges) {
      nextIds.add(routed.edge.id);
    }
    for (const [edgeId, cached] of this.#edgeDomById.entries()) {
      if (!nextIds.has(edgeId)) {
        cached.el.remove();
        this.#edgeDomById.delete(edgeId);
      }
    }

    let domCursor: ChildNode | null = this.#edgesLayer.firstChild;
    for (const routed of vm.layout.edges) {
      const { edge } = routed;
      const isHighlighted =
        selectedId !== null &&
        activeChainIds.has(edge.sourceId) &&
        activeChainIds.has(edge.targetId);
      const isDimmed = selectedId !== null && !isHighlighted;
      const isRecent = latestSeq > 0 && edge.lastSeq >= latestSeq - 2;
      const renderKey = `${routed.path}\u0001${routed.labelX}\u0001${routed.labelY}\u0001${edge.kind}\u0001${edge.label ?? ""}\u0001${edge.count}\u0001${edge.lastDetail ?? ""}\u0001${routed.isFeedback ? 1 : 0}\u0001${isHighlighted ? 1 : 0}\u0001${isDimmed ? 1 : 0}\u0001${isRecent ? 1 : 0}`;

      let cached = this.#edgeDomById.get(edge.id);
      if (!cached) {
        const el = svgEl("g");
        this.#patchEdgeElement(el, routed, isHighlighted, isDimmed, isRecent);
        cached = { el, renderKey };
        this.#edgeDomById.set(edge.id, cached);
      } else if (cached.renderKey !== renderKey) {
        this.#patchEdgeElement(
          cached.el,
          routed,
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

  #patchEdgeElement(
    g: SVGGElement,
    routed: RoutedEdge,
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
      d: routed.path,
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

  #renderNodes(vm: PanelViewModel): void {
    const selectedId = vm.selectedNode?.id ?? null;
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
      const { node, x, y } = positioned;
      const id = node.id;
      const flags = {
        isSelected: selectedId === id,
        isRelated:
          selectedId !== null &&
          (vm.upstreamIds.has(id) || vm.downstreamIds.has(id)),
        isDimmed:
          selectedId !== null &&
          selectedId !== id &&
          !vm.upstreamIds.has(id) &&
          !vm.downstreamIds.has(id),
        isDirectCause: vm.directCauseNodeIds.has(id),
        isFocusedRoot: focusedId === id,
        showInPort: hasIncoming.has(id),
        showOutPort: hasOutgoing.has(id),
      };

      const renderKey = [
        x,
        y,
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
      this.#callbacks.onSelectNode(nodeId);
    });
    g.addEventListener("dblclick", (evt) => {
      evt.stopPropagation();
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
    flags: {
      readonly isSelected: boolean;
      readonly isRelated: boolean;
      readonly isDimmed: boolean;
      readonly isDirectCause: boolean;
      readonly isFocusedRoot: boolean;
      readonly showInPort: boolean;
      readonly showOutPort: boolean;
    },
  ): void {
    const { node, x, y } = positioned;
    const classes = ["graph-node", `kind-${node.kind}`];
    if (flags.isSelected) classes.push("is-selected");
    if (flags.isRelated) classes.push("is-related");
    if (flags.isDimmed) classes.push("is-dimmed");
    if (node.error !== null) classes.push("has-error");
    if (!node.connected) classes.push("is-disconnected");

    g.setAttribute("class", classes.join(" "));
    g.setAttribute("transform", `translate(${x}, ${y})`);
    g.setAttribute(
      "aria-label",
      `${node.kind} ${formatNodeDisplayTitle(node)}, ${node.updates} updates`,
    );
    g.setAttribute("aria-pressed", flags.isSelected ? "true" : "false");

    const children: SVGElement[] = [];
    const contentHost = svgEl("g");

    if (flags.isSelected) {
      children.push(this.#createCardShape(node.kind, "node-selection-ring"));
    }

    children.push(this.#createCardShape(node.kind, "node-card"));

    if (node.kind === "model") {
      children.push(
        svgEl("line", {
          class: "node-accent-stroke",
          x1: 5,
          y1: 9,
          x2: 5,
          y2: NODE_HEIGHT - 9,
        }),
        svgEl("line", {
          class: "node-accent-stroke",
          x1: 9,
          y1: 9,
          x2: 9,
          y2: NODE_HEIGHT - 9,
        }),
      );
    }

    const badgeRightX = this.#appendKindBadge(contentHost, node.kind);
    const rightReserved = this.#appendTopRightFlag(contentHost, node, flags);

    const titleStartX = badgeRightX + 6;
    const titleAvailPx =
      NODE_WIDTH -
      titleStartX -
      rightReserved -
      (node.kind === "observer" ? 16 : 10);
    const titleMaxChars = Math.max(8, Math.floor(titleAvailPx / 7.1));
    const titleEl = svgEl("text", {
      class: "node-title",
      x: titleStartX,
      y: 19,
    });
    titleEl.textContent = truncateText(
      formatNodeDisplayTitle(node),
      titleMaxChars,
    );
    contentHost.append(titleEl);

    const contentX = node.kind === "model" || node.kind === "context" ? 16 : 12;
    const subMaxChars = node.kind === "observer" ? 26 : 30;
    const subEl = svgEl("text", {
      class: "node-sub",
      x: contentX,
      y: 41,
    });
    subEl.textContent = truncateText(this.#formatMiddleLine(node), subMaxChars);
    contentHost.append(subEl);

    this.#appendBottomRow(contentHost, node, contentX);

    while (contentHost.firstChild) {
      const child = contentHost.firstChild;
      contentHost.removeChild(child);
      if (child instanceof SVGElement) {
        children.push(child);
      }
    }

    if (flags.showInPort) {
      children.push(
        svgEl("circle", {
          class: "node-port",
          cx: 0,
          cy: NODE_HEIGHT / 2,
          r: 3.5,
        }),
      );
    }
    if (flags.showOutPort) {
      const outX = node.kind === "observer" ? NODE_WIDTH - 11 : NODE_WIDTH;
      children.push(
        svgEl("circle", {
          class: "node-port",
          cx: outX,
          cy: NODE_HEIGHT / 2,
          r: 3.5,
        }),
      );
    }

    const tooltip = svgEl("title");
    tooltip.textContent = buildNodeTooltip(node);
    children.push(tooltip);

    g.replaceChildren(...children);
  }

  #createCardShape(kind: NodeKind, className: string): SVGElement {
    const w = NODE_WIDTH;
    const h = NODE_HEIGHT;
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
      case "context":
        return svgEl("rect", {
          class: className,
          x: 0,
          y: 0,
          width: w,
          height: h,
          rx: 22,
          ry: 22,
        });
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

  #appendKindBadge(parent: SVGGElement, kind: NodeKind): number {
    const badgeGroup = svgEl("g", { class: "node-badge-group" });
    switch (kind) {
      case "model": {
        badgeGroup.append(
          svgEl("rect", {
            class: "node-badge-bg",
            x: 15,
            y: 10,
            width: 32,
            height: 17,
            rx: 4,
          }),
          svgEl("ellipse", {
            cx: 23,
            cy: 15.2,
            rx: 4,
            ry: 1.7,
            fill: "none",
            stroke: "var(--kind-model)",
            "stroke-width": 1.15,
          }),
          svgEl("path", {
            d: "M 19 15.2 V 21.8 C 19 22.8 27 22.8 27 21.8 V 15.2",
            fill: "none",
            stroke: "var(--kind-model)",
            "stroke-width": 1.15,
          }),
        );
        const text = svgEl("text", {
          class: "node-badge-text",
          x: 37,
          y: 18.8,
        });
        text.textContent = "M";
        badgeGroup.append(text);
        parent.append(badgeGroup);
        return 47;
      }
      case "controller": {
        badgeGroup.append(
          svgEl("path", {
            class: "node-badge-bg",
            d: "M 13 10 H 41 L 46 18.5 L 41 27 H 13 L 10 18.5 Z",
          }),
        );
        const text = svgEl("text", {
          class: "node-badge-text",
          x: 27.5,
          y: 18.8,
        });
        text.textContent = "Ctrl";
        badgeGroup.append(text);
        parent.append(badgeGroup);
        return 46;
      }
      case "context": {
        badgeGroup.append(
          svgEl("rect", {
            class: "node-badge-bg",
            x: 15,
            y: 10,
            width: 30,
            height: 17,
            rx: 8.5,
          }),
        );
        const text = svgEl("text", {
          class: "node-badge-text",
          x: 30,
          y: 18.8,
        });
        text.textContent = "Ctx";
        badgeGroup.append(text);
        parent.append(badgeGroup);
        return 45;
      }
      case "computed": {
        badgeGroup.append(
          svgEl("rect", {
            class: "node-badge-bg",
            x: 12,
            y: 10,
            width: 30,
            height: 17,
            rx: 4,
          }),
        );
        const text = svgEl("text", {
          class: "node-badge-text",
          x: 27,
          y: 18.8,
        });
        text.textContent = "f(x)";
        badgeGroup.append(text);
        parent.append(badgeGroup);
        return 42;
      }
      case "observer": {
        badgeGroup.append(
          svgEl("rect", {
            class: "node-badge-bg",
            x: 10,
            y: 10,
            width: 30,
            height: 17,
            rx: 4,
          }),
        );
        const text = svgEl("text", {
          class: "node-badge-text",
          x: 25,
          y: 18.8,
        });
        text.textContent = "Obs";
        badgeGroup.append(text);
        parent.append(badgeGroup);
        return 40;
      }
      case "element":
      default: {
        badgeGroup.append(
          svgEl("rect", {
            class: "node-badge-bg",
            x: 10,
            y: 10,
            width: 34,
            height: 17,
            rx: 4,
          }),
        );
        const text = svgEl("text", {
          class: "node-badge-text",
          x: 27,
          y: 18.8,
        });
        text.textContent = "<…>";
        badgeGroup.append(text);
        parent.append(badgeGroup);
        return 44;
      }
    }
  }

  #appendTopRightFlag(
    parent: SVGGElement,
    node: ReactivityNodeSnapshot,
    flags: {
      readonly isDirectCause: boolean;
      readonly isFocusedRoot: boolean;
    },
  ): number {
    const rightEdge =
      node.kind === "observer"
        ? NODE_WIDTH - 14
        : node.kind === "context"
          ? NODE_WIDTH - 14
          : NODE_WIDTH - 10;

    if (node.error !== null) {
      return this.#drawSolidFlag(parent, rightEdge, 10, "ERR", "is-error");
    }
    if (flags.isDirectCause) {
      return this.#drawSolidFlag(parent, rightEdge, 10, "CAUSE", "is-cause");
    }
    if (flags.isFocusedRoot) {
      return this.#drawSolidFlag(parent, rightEdge, 10, "FOCUS", "is-focus");
    }
    if (node.kind === "element") {
      const rootLabel = formatRootTypeBadge(node.rootType);
      if (rootLabel) {
        return this.#drawMutedPill(parent, rightEdge, 11, rootLabel);
      }
    }
    return 0;
  }

  #drawSolidFlag(
    parent: SVGGElement,
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
    parent.append(g);
    return width + 6;
  }

  #drawMutedPill(
    parent: SVGGElement,
    rightEdge: number,
    y: number,
    label: string,
  ): number {
    const width = Math.max(32, Math.round(label.length * 5.6 + 10));
    const x = rightEdge - width;
    const g = svgEl("g", { class: "node-flag-group" });
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
    parent.append(g);
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
    parent: SVGGElement,
    node: ReactivityNodeSnapshot,
    leftX: number,
  ): void {
    const rightEdge =
      node.kind === "observer"
        ? NODE_WIDTH - 14
        : node.kind === "context"
          ? NODE_WIDTH - 16
          : NODE_WIDTH - 12;

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
        parent,
        cursorRight,
        53,
        `${node.vetoes} veto`,
        "is-veto",
      );
      cursorRight -= vetoWidth;
    }

    const durLabel = formatDurationMs(node.lastDurationMs);
    const rightMetric = durLabel || `#${node.id}`;
    const rightText = svgEl("text", {
      class: "node-meta",
      x: cursorRight,
      y: 61,
      "text-anchor": "end",
    });
    rightText.textContent = rightMetric;
    parent.append(rightText);

    const reservedRightPx = rightMetric.length * 6.1 + 12;
    const availLeftPx = Math.max(48, cursorRight - reservedRightPx - leftX);
    const maxLeftChars = Math.max(6, Math.floor(availLeftPx / 6.1));

    const leftText = svgEl("text", {
      class: "node-meta",
      x: leftX,
      y: 61,
    });
    leftText.textContent = truncateText(leftMetric, maxLeftChars);
    parent.append(leftText);
  }

  #onPointerDown = (evt: PointerEvent): void => {
    if (evt.button !== 0) return;
    const target = evt.target;
    if (target instanceof Element && target.closest(".graph-node") !== null) {
      return;
    }

    this.#panning = true;
    this.#didPanMove = false;
    this.#panPointerId = evt.pointerId;
    this.#panStartX = evt.clientX;
    this.#panStartY = evt.clientY;
    this.#panOriginTx = this.#tx;
    this.#panOriginTy = this.#ty;
    this.#svg.classList.add("is-panning");
    try {
      this.#svg.setPointerCapture(evt.pointerId);
    } catch {
      // Synthetic pointer events in tests may not support capture
    }
  };

  #onPointerMove = (evt: PointerEvent): void => {
    if (!this.#panning || evt.pointerId !== this.#panPointerId) return;
    const dx = evt.clientX - this.#panStartX;
    const dy = evt.clientY - this.#panStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      this.#didPanMove = true;
    }
    this.#tx = this.#panOriginTx + dx;
    this.#ty = this.#panOriginTy + dy;
    this.#userTransformed = true;
    this.#applyTransform();
  };

  #onPointerUp = (evt: PointerEvent): void => {
    if (!this.#panning || evt.pointerId !== this.#panPointerId) return;
    this.#panning = false;
    this.#panPointerId = null;
    this.#svg.classList.remove("is-panning");
    try {
      this.#svg.releasePointerCapture(evt.pointerId);
    } catch {
      // Ignore if not captured
    }
  };

  #onWheel = (evt: WheelEvent): void => {
    evt.preventDefault();
    const rect = this.#container.getBoundingClientRect();
    const offsetX = evt.clientX - rect.left;
    const offsetY = evt.clientY - rect.top;
    const factor = evt.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.#zoomAtPoint(offsetX, offsetY, factor);
  };

  #onCanvasClick = (evt: MouseEvent): void => {
    if (this.#didPanMove) {
      this.#didPanMove = false;
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

    const hasMod = evt.ctrlKey || evt.metaKey || evt.altKey;
    if (!hasMod && evt.key === "0") {
      evt.preventDefault();
      this.fit();
      return;
    }
    if (!hasMod && (evt.key === "+" || evt.key === "=")) {
      evt.preventDefault();
      this.zoomIn();
      return;
    }
    if (!hasMod && evt.key === "-") {
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

    if (!hasMod && (evt.key === "Enter" || evt.key === " ")) {
      evt.preventDefault();
      if (evt.shiftKey) {
        this.#callbacks.onFocusSubgraph(currentId);
      } else {
        this.#callbacks.onSelectNode(currentId);
      }
      return;
    }

    if (!hasMod && (evt.key === "f" || evt.key === "F")) {
      evt.preventDefault();
      this.#callbacks.onFocusSubgraph(currentId);
      return;
    }

    if (!hasMod && evt.key === "Escape") {
      if (this.#lastVm?.selectedNode) {
        evt.preventDefault();
        evt.stopPropagation();
        this.#callbacks.onSelectNode(null);
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
      const nextId = this.#findNeighborNode(layout, currentId, evt.key);
      if (nextId !== null) {
        this.#callbacks.onSelectNode(nextId);
        const nextEl = this.#nodesLayer.querySelector<SVGGElement>(
          `g[data-node-id="${nextId}"]`,
        );
        nextEl?.focus({ preventScroll: true });
      }
    }
  };

  #findNeighborNode(
    layout: GraphLayout,
    currentId: number,
    key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight",
  ): number | null {
    const current = layout.nodeById.get(currentId);
    if (!current) return layout.nodes[0]?.node.id ?? null;

    if (key === "ArrowUp" || key === "ArrowDown") {
      const sameLayer = layout.nodes
        .filter((n) => n.layer === current.layer)
        .toSorted((a, b) => a.row - b.row);
      const idx = sameLayer.findIndex((n) => n.node.id === currentId);
      if (idx === -1 || sameLayer.length <= 1) return null;
      const nextIdx =
        key === "ArrowDown"
          ? (idx + 1) % sameLayer.length
          : (idx - 1 + sameLayer.length) % sameLayer.length;
      return sameLayer[nextIdx]?.node.id ?? null;
    }

    // Prefer directly connected downstream/upstream neighbors when stepping left/right
    const directCandidates: PositionedNode[] = [];
    for (const routed of layout.edges) {
      if (key === "ArrowRight" && routed.edge.sourceId === currentId) {
        const dst = layout.nodeById.get(routed.edge.targetId);
        if (dst && dst.layer >= current.layer) directCandidates.push(dst);
      } else if (key === "ArrowLeft" && routed.edge.targetId === currentId) {
        const src = layout.nodeById.get(routed.edge.sourceId);
        if (src && src.layer <= current.layer) directCandidates.push(src);
      }
    }
    if (directCandidates.length > 0) {
      directCandidates.sort(
        (a, b) => Math.abs(a.y - current.y) - Math.abs(b.y - current.y),
      );
      return directCandidates[0]?.node.id ?? null;
    }

    const targetLayer =
      key === "ArrowRight" ? current.layer + 1 : current.layer - 1;
    const layerNodes = layout.nodes.filter((n) => n.layer === targetLayer);
    if (layerNodes.length === 0) return null;
    layerNodes.sort(
      (a, b) => Math.abs(a.y - current.y) - Math.abs(b.y - current.y),
    );
    return layerNodes[0]?.node.id ?? null;
  }
}
