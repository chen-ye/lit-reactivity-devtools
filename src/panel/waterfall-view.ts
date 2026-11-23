import type { TraceEvent, TraceKind } from "../protocol/types.ts";
import type {
  PanelViewModel,
  TraceCategoryFilter,
  WaterfallCascade,
} from "./graph-state.ts";

export type WaterfallMode = "cascades" | "flat";

export interface WaterfallViewCallbacks {
  readonly onSelectNode: (nodeId: number) => void;
  readonly onHoverNode: (nodeId: number | null) => void;
  readonly onTraceCategoryChange: (category: TraceCategoryFilter) => void;
  readonly onToggleFollowSelection: () => void;
  readonly onClearEvents: () => void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

const CATEGORY_OPTIONS: ReadonlyArray<{
  readonly id: TraceCategoryFilter;
  readonly label: string;
}> = [
  { id: "all", label: "All" },
  { id: "render", label: "render" },
  { id: "prop", label: "prop" },
  { id: "context", label: "context" },
  { id: "memo", label: "memo" },
  { id: "model-ctrl", label: "model/ctrl" },
  { id: "event", label: "event" },
  { id: "veto-err", label: "veto/err" },
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createChevronSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "cascade-chevron");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M4 2.5 L8 6 L4 9.5");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

function createTreeBranchSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "10");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 10 12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M2 1 V7 H9");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

const TRACE_BADGE_LABELS: Record<TraceKind, string> = {
  "model-update": "model",
  "controller-transform": "ctrl",
  "context-push": "ctx",
  "prop-change": "prop",
  render: "render",
  veto: "veto",
  "memo-miss": "miss",
  "memo-hit": "hit",
  "custom-event": "event",
  connect: "conn",
  error: "error",
};

function shortTraceBadge(kind: TraceKind): string {
  return TRACE_BADGE_LABELS[kind];
}

function formatDurationMs(ms: number): string {
  if (ms === 0) return "0.00ms";
  if (ms < 0.01) return "<0.01ms";
  if (ms < 10) return `${ms.toFixed(2)}ms`;
  return `${ms.toFixed(1)}ms`;
}

export class WaterfallView {
  readonly #container: HTMLElement;
  readonly #callbacks: WaterfallViewCallbacks;

  readonly #bodyEl: HTMLDivElement;
  readonly #modeCascadesBtn: HTMLButtonElement;
  readonly #modeFlatBtn: HTMLButtonElement;
  readonly #selectedOnlyBtn: HTMLButtonElement;
  readonly #metaEl: HTMLDivElement;
  readonly #categoryButtons = new Map<TraceCategoryFilter, HTMLButtonElement>();
  readonly #collapsedCascades = new Set<number>();
  readonly #expandedCascades = new Set<number>();
  readonly #cascadeDomById = new Map<
    number,
    { readonly card: HTMLDetailsElement; key: string }
  >();

  #mode: WaterfallMode = "cascades";
  #lastVm: PanelViewModel | null = null;
  #lastCategory: TraceCategoryFilter = "all";
  #lastFollowSelection = false;
  #lastMetaKey = "";
  #lastEmptyMsg = "";
  #lastFlatKey = "";

  constructor(container: HTMLElement, callbacks: WaterfallViewCallbacks) {
    this.#container = container;
    this.#callbacks = callbacks;

    const header = el("div", "waterfall-header");

    const modeGroup = el("div", "segmented");
    modeGroup.setAttribute("role", "group");
    modeGroup.setAttribute("aria-label", "Waterfall view mode");

    this.#modeCascadesBtn = el("button", "segmented-btn", "Cascades");
    this.#modeCascadesBtn.type = "button";
    this.#modeCascadesBtn.dataset.testid = "waterfall-mode-cascades";
    this.#modeCascadesBtn.setAttribute("aria-pressed", "true");
    this.#modeCascadesBtn.addEventListener("click", () =>
      this.#setMode("cascades"),
    );

    this.#modeFlatBtn = el("button", "segmented-btn", "Flat Stream");
    this.#modeFlatBtn.type = "button";
    this.#modeFlatBtn.dataset.testid = "waterfall-mode-flat";
    this.#modeFlatBtn.setAttribute("aria-pressed", "false");
    this.#modeFlatBtn.addEventListener("click", () => this.#setMode("flat"));

    modeGroup.append(this.#modeCascadesBtn, this.#modeFlatBtn);

    const filterGroup = el("div", "pill-group");
    filterGroup.setAttribute("role", "group");
    filterGroup.setAttribute("aria-label", "Filter trace kinds");

    for (const opt of CATEGORY_OPTIONS) {
      const btn = el("button", "filter-pill", opt.label);
      btn.type = "button";
      btn.dataset.testid = `waterfall-filter-${opt.id}`;
      btn.setAttribute("aria-pressed", opt.id === "all" ? "true" : "false");
      btn.addEventListener("click", () => {
        this.#callbacks.onTraceCategoryChange(opt.id);
      });
      this.#categoryButtons.set(opt.id, btn);
      filterGroup.append(btn);
    }

    this.#selectedOnlyBtn = el("button", "filter-pill", "Selected only");
    this.#selectedOnlyBtn.type = "button";
    this.#selectedOnlyBtn.dataset.testid = "waterfall-selected-only";
    this.#selectedOnlyBtn.setAttribute("aria-pressed", "false");
    this.#selectedOnlyBtn.addEventListener("click", () => {
      this.#callbacks.onToggleFollowSelection();
    });

    const clearBtn = el("button", "tool-btn", "Clear");
    clearBtn.type = "button";
    clearBtn.dataset.testid = "waterfall-clear-btn";
    clearBtn.addEventListener("click", () => {
      this.#callbacks.onClearEvents();
    });

    this.#metaEl = el("div", "waterfall-meta");

    const sep1 = el("span", "toolbar-sep");
    sep1.setAttribute("aria-hidden", "true");
    const sep2 = el("span", "toolbar-sep");
    sep2.setAttribute("aria-hidden", "true");

    header.append(
      modeGroup,
      sep1,
      filterGroup,
      sep2,
      this.#selectedOnlyBtn,
      this.#metaEl,
      clearBtn,
    );

    this.#bodyEl = el("div", "waterfall-body");
    this.#container.replaceChildren(header, this.#bodyEl);
  }

  render(
    vm: PanelViewModel,
    traceCategory: TraceCategoryFilter,
    followSelectionInTraces: boolean,
  ): void {
    this.#lastVm = vm;
    this.#lastCategory = traceCategory;
    this.#lastFollowSelection = followSelectionInTraces;
    this.#selectedOnlyBtn.setAttribute(
      "aria-pressed",
      String(followSelectionInTraces),
    );

    for (const [id, btn] of this.#categoryButtons.entries()) {
      btn.setAttribute("aria-pressed", String(id === traceCategory));
    }

    const events = vm.filteredEvents;
    const cascades = vm.cascades;

    const dropped = vm.snapshot?.droppedEvents ?? 0;
    const summaryText =
      this.#mode === "cascades"
        ? `${cascades.length} ${cascades.length === 1 ? "cascade" : "cascades"} · ${events.length} events`
        : `${events.length} events`;
    const metaKey = `${summaryText}|${dropped}`;
    if (metaKey !== this.#lastMetaKey) {
      this.#lastMetaKey = metaKey;
      const metaNodes: Node[] = [document.createTextNode(summaryText)];
      if (dropped > 0) {
        metaNodes.push(el("span", "stat-chip veto", `${dropped} dropped`));
      }
      this.#metaEl.replaceChildren(...metaNodes);
    }

    if (events.length === 0) {
      this.#cascadeDomById.clear();
      this.#lastFlatKey = "";
      const msg =
        (vm.snapshot?.events.length ?? 0) === 0
          ? "No trace events captured yet. Interact with the page or click Scan DOM."
          : "No trace events match the active filter.";
      if (
        this.#lastEmptyMsg !== msg ||
        this.#bodyEl.firstElementChild?.className !== "waterfall-empty"
      ) {
        this.#lastEmptyMsg = msg;
        this.#bodyEl.replaceChildren(el("div", "waterfall-empty", msg));
      }
      return;
    }
    this.#lastEmptyMsg = "";

    const selectedNodeId = vm.selectedNode?.id ?? null;

    if (this.#mode === "cascades") {
      this.#lastFlatKey = "";
      this.#renderCascades(cascades, selectedNodeId);
    } else {
      this.#cascadeDomById.clear();
      this.#renderFlatStream(events, selectedNodeId);
    }
  }

  #setMode(mode: WaterfallMode): void {
    if (this.#mode === mode) return;
    this.#mode = mode;
    this.#cascadeDomById.clear();
    this.#lastFlatKey = "";
    this.#lastEmptyMsg = "";
    this.#bodyEl.replaceChildren();
    this.#modeCascadesBtn.setAttribute(
      "aria-pressed",
      String(mode === "cascades"),
    );
    this.#modeFlatBtn.setAttribute("aria-pressed", String(mode === "flat"));
    if (this.#lastVm) {
      this.render(this.#lastVm, this.#lastCategory, this.#lastFollowSelection);
    }
  }

  #renderCascades(
    cascades: ReadonlyArray<WaterfallCascade>,
    selectedNodeId: number | null,
  ): void {
    const limit = Math.min(cascades.length, 40);
    const visibleCascades = cascades.slice(0, limit);
    const nextIds = new Set(visibleCascades.map((c) => c.cascadeId));

    for (const [cid, cached] of this.#cascadeDomById.entries()) {
      if (!nextIds.has(cid)) {
        cached.card.remove();
        this.#cascadeDomById.delete(cid);
      }
    }
    if (this.#bodyEl.firstElementChild?.classList.contains("waterfall-empty")) {
      this.#bodyEl.replaceChildren();
    }

    let domCursor: ChildNode | null = this.#bodyEl.firstChild;
    for (let i = 0; i < visibleCascades.length; i++) {
      const cascade = visibleCascades[i];
      if (!cascade) continue;

      const defaultOpen = i < 2;
      const isOpen = this.#expandedCascades.has(cascade.cascadeId)
        ? true
        : this.#collapsedCascades.has(cascade.cascadeId)
          ? false
          : defaultOpen;

      const lastEvt = cascade.events.at(-1);
      const hasSelected =
        selectedNodeId !== null &&
        cascade.events.some((e) => e.nodeId === selectedNodeId);
      const selectedMask = hasSelected
        ? cascade.events
            .map((e) => (e.nodeId === selectedNodeId ? "1" : "0"))
            .join("")
        : "";
      const cardKey = `${cascade.events.length}:${cascade.totalDurationMs.toFixed(3)}:${lastEvt?.seq ?? 0}:${lastEvt?.durationMs.toFixed(3) ?? "0"}:${isOpen ? 1 : 0}:${selectedMask}`;

      let cached = this.#cascadeDomById.get(cascade.cascadeId);
      if (!cached) {
        const card = el("details", "cascade-card");
        card.dataset.testid = `waterfall-cascade-${cascade.cascadeId}`;
        card.open = isOpen;
        card.addEventListener("toggle", () => {
          if (card.open) {
            this.#collapsedCascades.delete(cascade.cascadeId);
            this.#expandedCascades.add(cascade.cascadeId);
          } else {
            this.#expandedCascades.delete(cascade.cascadeId);
            this.#collapsedCascades.add(cascade.cascadeId);
          }
        });
        this.#populateCascadeCard(card, cascade, selectedNodeId);
        cached = { card, key: cardKey };
        this.#cascadeDomById.set(cascade.cascadeId, cached);
      } else if (cached.key !== cardKey) {
        cached.card.open = isOpen;
        this.#populateCascadeCard(cached.card, cascade, selectedNodeId);
        cached.key = cardKey;
      }

      if (cached.card !== domCursor) {
        this.#bodyEl.insertBefore(cached.card, domCursor);
      } else {
        domCursor = domCursor.nextSibling;
      }
    }
  }

  #populateCascadeCard(
    card: HTMLDetailsElement,
    cascade: WaterfallCascade,
    selectedNodeId: number | null,
  ): void {
    const summary = el("summary", "cascade-summary");
    const stats = el("span", "cascade-stats");
    stats.append(
      el(
        "span",
        undefined,
        `${cascade.events.length} ${cascade.events.length === 1 ? "step" : "steps"}`,
      ),
      el("span", undefined, formatDurationMs(cascade.totalDurationMs)),
    );
    summary.append(
      createChevronSvg(),
      el("span", "cascade-id", `#${cascade.cascadeId}`),
      el("span", "cascade-root", cascade.rootLabel),
      stats,
    );

    const stepsHost = el("div", "cascade-steps");

    let maxEndOffset = 0;
    for (const evt of cascade.events) {
      const end =
        Math.max(0, evt.timestamp - cascade.startedAt) + evt.durationMs;
      if (end > maxEndOffset) maxEndOffset = end;
    }
    const scaleMax = Math.max(maxEndOffset, cascade.totalDurationMs, 0.25);

    const depthByNodeId = new Map<number, number>();

    for (let idx = 0; idx < cascade.events.length; idx++) {
      const evt = cascade.events[idx];
      if (!evt) continue;

      let depth = 0;
      if (idx > 0 && evt.causeNodeId !== null) {
        const parentDepth = depthByNodeId.get(evt.causeNodeId);
        depth = parentDepth !== undefined ? Math.min(5, parentDepth + 1) : 1;
      }
      if (!depthByNodeId.has(evt.nodeId)) {
        depthByNodeId.set(evt.nodeId, depth);
      }

      const startOffsetMs = Math.max(0, evt.timestamp - cascade.startedAt);
      const leftPct = Math.min(96, (startOffsetMs / scaleMax) * 100);
      // Point events (0ms) render as a crisp 3px vertical marker (width 0% + CSS min-inline-size: 3px)
      const widthPct =
        evt.durationMs <= 0
          ? 0
          : Math.min(100 - leftPct, (evt.durationMs / scaleMax) * 100);

      stepsHost.append(
        this.#createCascadeRow(
          evt,
          depth,
          leftPct,
          widthPct,
          selectedNodeId === evt.nodeId,
        ),
      );
    }

    card.replaceChildren(summary, stepsHost);
  }

  #createCascadeRow(
    evt: TraceEvent,
    depth: number,
    leftPct: number,
    widthPct: number,
    isSelected: boolean,
  ): HTMLButtonElement {
    const row = el(
      "button",
      isSelected ? "trace-row is-selected" : "trace-row",
    );
    row.type = "button";
    row.dataset.testid = `trace-row-${evt.seq}`;

    const main = el("div", "trace-main");
    if (depth > 0) {
      const indent = el("span", "trace-indent");
      indent.style.paddingInlineStart = `${(depth - 1) * 12}px`;
      indent.append(createTreeBranchSvg());
      main.append(indent);
    }

    main.append(
      el("span", `trace-badge t-${evt.kind}`, shortTraceBadge(evt.kind)),
    );

    const textWrap = el("div", "trace-text");
    textWrap.append(el("span", "trace-label", evt.label));
    if (evt.detail) {
      textWrap.append(el("span", "trace-detail", evt.detail));
    }
    main.append(textWrap);

    const barTrack = el("div", "bar-track");
    const barFill = el("div", `bar-fill t-${evt.kind}`);
    barFill.style.insetInlineStart = `${leftPct.toFixed(1)}%`;
    barFill.style.inlineSize = `${widthPct.toFixed(1)}%`;
    barTrack.append(barFill);

    const durEl = el(
      "span",
      evt.durationMs >= 4 ? "trace-dur is-slow" : "trace-dur",
      formatDurationMs(evt.durationMs),
    );

    row.append(main, barTrack, durEl);
    this.#bindRowInteraction(row, evt);
    return row;
  }

  #renderFlatStream(
    events: ReadonlyArray<TraceEvent>,
    selectedNodeId: number | null,
  ): void {
    const limit = Math.min(events.length, 150);
    const headSignature = events
      .slice(0, 5)
      .map((e) => `${e.seq}:${e.durationMs.toFixed(3)}`)
      .join(",");
    const flatKey = `${limit}:${events[0]?.seq ?? 0}:${events[limit - 1]?.seq ?? 0}:${selectedNodeId ?? ""}:${headSignature}`;
    if (flatKey === this.#lastFlatKey) return;
    this.#lastFlatKey = flatKey;

    const fragment = document.createDocumentFragment();

    let maxDur = 0.25;
    for (let i = 0; i < limit; i++) {
      const dur = events[i]?.durationMs ?? 0;
      if (dur > maxDur) maxDur = dur;
    }

    for (let i = 0; i < limit; i++) {
      const evt = events[i];
      if (!evt) continue;

      const isSelected = selectedNodeId === evt.nodeId;
      const row = el(
        "button",
        isSelected
          ? "trace-row trace-row-flat is-selected"
          : "trace-row trace-row-flat",
      );
      row.type = "button";
      row.dataset.testid = `trace-row-${evt.seq}`;

      const textWrap = el("div", "trace-text");
      textWrap.append(el("span", "trace-label", evt.label));
      if (evt.detail) {
        textWrap.append(el("span", "trace-detail", evt.detail));
      }

      const barTrack = el("div", "bar-track");
      const barFill = el("div", `bar-fill t-${evt.kind}`);
      const widthPct =
        evt.durationMs <= 0
          ? 0
          : Math.min(100, (evt.durationMs / maxDur) * 100);
      barFill.style.insetInlineStart = "0%";
      barFill.style.inlineSize = `${widthPct.toFixed(1)}%`;
      barTrack.append(barFill);

      const durEl = el(
        "span",
        evt.durationMs >= 4 ? "trace-dur is-slow" : "trace-dur",
        formatDurationMs(evt.durationMs),
      );

      row.append(
        el("span", "trace-seq", `#${evt.seq}`),
        el("span", "cascade-id", `c${evt.cascadeId}`),
        el("span", `trace-badge t-${evt.kind}`, shortTraceBadge(evt.kind)),
        textWrap,
        barTrack,
        durEl,
      );

      this.#bindRowInteraction(row, evt);
      fragment.append(row);
    }

    this.#bodyEl.replaceChildren(fragment);
  }

  #bindRowInteraction(row: HTMLButtonElement, evt: TraceEvent): void {
    row.title = evt.detail
      ? `#${evt.seq} · cascade #${evt.cascadeId} · ${evt.label} — ${evt.detail}`
      : `#${evt.seq} · cascade #${evt.cascadeId} · ${evt.label}`;
    row.addEventListener("click", () => {
      this.#callbacks.onSelectNode(evt.nodeId);
    });
    row.addEventListener("pointerenter", () => {
      this.#callbacks.onHoverNode(evt.nodeId);
    });
    row.addEventListener("pointerleave", () => {
      this.#callbacks.onHoverNode(null);
    });
  }
}
