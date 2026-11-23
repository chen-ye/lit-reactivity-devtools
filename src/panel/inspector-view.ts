import type {
  ActionResult,
  NodeKind,
  ReactivePropertySnapshot,
  ReactivityEdgeSnapshot,
  ReactivityNodeSnapshot,
  ValuePreview,
} from "../protocol/types.ts";
import type { PanelViewModel } from "./graph-state.ts";

export interface InspectorViewCallbacks {
  readonly transportMode: "devtools" | "bridge";
  readonly onSelectNode: (nodeId: number) => void;
  readonly onFocusSubgraph: (nodeId: number | null) => void;
  readonly onSetProperty: (
    nodeId: number,
    propName: string,
    jsonText: string,
  ) => void;
  readonly onClearMemoCache: (nodeId: number) => void;
  readonly onRevealInElements: (nodeId: number) => void;
  readonly onLogNode: (nodeId: number) => void;
}

interface PropRowRefs {
  readonly row: HTMLDivElement;
  readonly changesEl: HTMLSpanElement;
  readonly valuesEl: HTMLDivElement;
  readonly sourceEl: HTMLDivElement;
  readonly entriesHost: HTMLDivElement;
  readonly inputEl: HTMLInputElement;
  readonly feedbackEl: HTMLDivElement;
  entriesOpen: boolean;
}

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

const KIND_LABELS: Record<NodeKind, string> = {
  model: "Model",
  controller: "Controller",
  context: "Context",
  element: "Element",
  computed: "Computed",
  observer: "Observer",
};

function formatKindLabel(kind: NodeKind): string {
  return KIND_LABELS[kind];
}

function formatNodeTitle(node: ReactivityNodeSnapshot): string {
  if (node.kind === "element" && !node.label.startsWith("<")) {
    return `<${node.label}>`;
  }
  return node.label;
}

function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 0.01) return "<0.01 ms";
  if (ms < 10) return `${ms.toFixed(2)} ms`;
  return `${ms.toFixed(1)} ms`;
}

function defaultJsonInput(preview: ValuePreview): string {
  if (preview.truncated) return "";
  if (
    preview.kind === "string" ||
    preview.kind === "number" ||
    preview.kind === "boolean" ||
    preview.kind === "null"
  ) {
    return preview.text;
  }
  return "";
}

function createValueToken(preview: ValuePreview): HTMLSpanElement {
  return el("span", `val-token val-${preview.kind}`, preview.text);
}

function createEntriesDetails(
  entries: ReadonlyArray<readonly [string, string]>,
  truncated: boolean | undefined,
  open: boolean,
  onToggle?: (isOpen: boolean) => void,
): HTMLDetailsElement {
  const details = el("details", "entries-details");
  details.open = open;
  if (onToggle) {
    details.addEventListener("toggle", () => {
      onToggle(details.open);
    });
  }
  const suffix = truncated ? "+" : "";
  details.append(
    el("summary", undefined, `${entries.length}${suffix} entries`),
  );
  const table = el("table", "entries-table");
  const tbody = el("tbody");
  for (const [key, value] of entries) {
    const tr = el("tr");
    tr.append(el("td", undefined, key), el("td", undefined, value));
    tbody.append(tr);
  }
  table.append(tbody);
  details.append(table);
  return details;
}

export class InspectorView {
  readonly #container: HTMLElement;
  readonly #callbacks: InspectorViewCallbacks;

  #renderedNodeId: number | null = null;
  #headerHost: HTMLElement | null = null;
  #actionBannerHost: HTMLDivElement | null = null;
  #errorHost: HTMLDivElement | null = null;
  #metricsHost: HTMLDivElement | null = null;
  #propsSectionHost: HTMLElement | null = null;
  #propsListHost: HTMLDivElement | null = null;
  #valueHost: HTMLDivElement | null = null;
  #relationsHost: HTMLDivElement | null = null;

  readonly #propRows = new Map<string, PropRowRefs>();
  readonly #drafts = new Map<string, string>();
  readonly #propFeedback = new Map<string, ActionResult>();
  readonly #emptyButtons = new Map<
    number,
    {
      readonly btn: HTMLButtonElement;
      readonly dot: HTMLSpanElement;
      readonly labelEl: HTMLSpanElement;
      readonly metricEl: HTMLSpanElement;
    }
  >();
  #emptyWrap: HTMLDivElement | null = null;
  #emptyHeading: HTMLHeadingElement | null = null;
  #emptyList: HTMLDivElement | null = null;
  #lastHeaderKey = "";
  #lastActionKey = "";
  #lastErrorKey = "";
  #lastMetricsKey = "";
  #lastValueKey = "";
  #lastRelationsKey = "";
  #nodeFeedback: {
    readonly nodeId: number;
    readonly ok: boolean;
    readonly text: string;
  } | null = null;

  constructor(container: HTMLElement, callbacks: InspectorViewCallbacks) {
    this.#container = container;
    this.#callbacks = callbacks;
  }

  render(vm: PanelViewModel): void {
    const node = vm.selectedNode;
    if (!node) {
      this.#renderedNodeId = null;
      this.#clearStructuralRefs();
      this.#renderEmpty(vm);
      return;
    }

    if (this.#renderedNodeId !== node.id) {
      this.#renderedNodeId = node.id;
      if (this.#nodeFeedback && this.#nodeFeedback.nodeId !== node.id) {
        this.#nodeFeedback = null;
      }
      this.#mountNodeScaffold();
    }

    this.#patchHeader(node, vm.focusedNode?.id === node.id);
    this.#patchActionBanner(node.id);
    this.#patchError(node);
    this.#patchMetrics(node, vm);
    this.#patchProperties(node);
    this.#patchValueAndArgs(node);
    this.#patchRelations(node, vm);
  }

  showPropertyResult(
    nodeId: number,
    propName: string,
    result: ActionResult,
  ): void {
    const key = `${nodeId}:${propName}`;
    this.#propFeedback.set(key, result);
    if (result.ok) {
      this.#drafts.delete(key);
    }
    if (this.#renderedNodeId === nodeId) {
      const refs = this.#propRows.get(propName);
      if (refs) {
        this.#applyPropFeedback(refs.feedbackEl, result);
      }
    }
  }

  showNodeActionMessage(nodeId: number, ok: boolean, text: string): void {
    this.#nodeFeedback = { nodeId, ok, text };
    if (this.#renderedNodeId === nodeId) {
      this.#patchActionBanner(nodeId);
    }
  }

  #clearStructuralRefs(): void {
    this.#headerHost = null;
    this.#actionBannerHost = null;
    this.#errorHost = null;
    this.#metricsHost = null;
    this.#propsSectionHost = null;
    this.#propsListHost = null;
    this.#valueHost = null;
    this.#relationsHost = null;
    this.#propRows.clear();
    this.#lastHeaderKey = "";
    this.#lastActionKey = "";
    this.#lastErrorKey = "";
    this.#lastMetricsKey = "";
    this.#lastValueKey = "";
    this.#lastRelationsKey = "";
  }

  #mountNodeScaffold(): void {
    this.#clearStructuralRefs();
    this.#emptyWrap = null;
    this.#emptyHeading = null;
    this.#emptyList = null;
    this.#emptyButtons.clear();

    const header = el("div", "inspector-header");
    const body = el("div", "inspector-body");

    const actionBanner = el("div");
    const errorHost = el("div");
    const metricsHost = el("div");
    const propsSection = el("section", "inspector-section");
    const propsList = el("div", "prop-list");
    const valueHost = el("div");
    const relationsHost = el("div");

    propsSection.append(
      el("h3", "section-heading", "Reactive Properties"),
      propsList,
    );
    body.append(
      actionBanner,
      errorHost,
      metricsHost,
      propsSection,
      valueHost,
      relationsHost,
    );

    this.#headerHost = header;
    this.#actionBannerHost = actionBanner;
    this.#errorHost = errorHost;
    this.#metricsHost = metricsHost;
    this.#propsSectionHost = propsSection;
    this.#propsListHost = propsList;
    this.#valueHost = valueHost;
    this.#relationsHost = relationsHost;

    this.#container.replaceChildren(header, body);
  }

  #renderEmpty(vm: PanelViewModel): void {
    if (!this.#emptyWrap || !this.#emptyHeading || !this.#emptyList) {
      const wrap = el("div", "inspector-empty");
      wrap.append(
        el("h2", undefined, "Inspector"),
        el(
          "p",
          undefined,
          "Select any node in the graph or click a waterfall row to inspect reactive properties, edit JSON values live, clear memo caches, or trace causal neighbors.",
        ),
      );
      const heading = el("h3", "section-heading", "");
      const list = el("div", "relation-list");
      wrap.append(heading, list);
      this.#emptyWrap = wrap;
      this.#emptyHeading = heading;
      this.#emptyList = list;
      this.#emptyButtons.clear();
      this.#container.replaceChildren(wrap);
    }

    const notable = vm.visibleNodes
      .filter((n) => n.error !== null || n.vetoes > 0)
      .slice(0, 6);
    const activeSorted = vm.visibleNodes
      .toSorted((a, b) => b.updates - a.updates || a.id - b.id)
      .slice(0, 14);
    const listNodes = notable.length > 0 ? notable : activeSorted;

    if (listNodes.length === 0) {
      this.#emptyHeading.hidden = true;
      this.#emptyList.hidden = true;
      return;
    }

    this.#emptyHeading.hidden = false;
    this.#emptyList.hidden = false;
    this.#emptyHeading.textContent =
      notable.length > 0 ? "Errors & Vetoes" : "Most Active Nodes";

    const nextIds = new Set(listNodes.map((n) => n.id));
    for (const [id, refs] of this.#emptyButtons.entries()) {
      if (!nextIds.has(id)) {
        refs.btn.remove();
        this.#emptyButtons.delete(id);
      }
    }

    let cursor: ChildNode | null = this.#emptyList.firstChild;
    for (const n of listNodes) {
      let refs = this.#emptyButtons.get(n.id);
      if (!refs) {
        const btn = el("button", "relation-btn");
        btn.type = "button";
        const dot = el("span", `kind-dot kind-${n.kind}`);
        const labelEl = el("span", "relation-node-label");
        const metricEl = el("span", "relation-edge-label");
        btn.append(dot, labelEl, metricEl);
        btn.addEventListener("click", () => {
          this.#callbacks.onSelectNode(n.id);
        });
        refs = { btn, dot, labelEl, metricEl };
        this.#emptyButtons.set(n.id, refs);
      }

      const titleText = formatNodeTitle(n);
      const metricText =
        n.error !== null
          ? "error"
          : n.vetoes > 0
            ? `${n.vetoes} veto`
            : `${n.updates} upd`;

      if (refs.labelEl.textContent !== titleText) {
        refs.labelEl.textContent = titleText;
      }
      if (refs.metricEl.textContent !== metricText) {
        refs.metricEl.textContent = metricText;
      }

      if (refs.btn !== cursor) {
        this.#emptyList.insertBefore(refs.btn, cursor);
      } else {
        cursor = cursor.nextSibling;
      }
    }
  }

  #patchHeader(node: ReactivityNodeSnapshot, isFocusedRoot: boolean): void {
    if (!this.#headerHost) return;
    const headerKey = `${node.id}|${node.kind}|${node.label}|${node.subtitle ?? ""}|${node.connected}|${node.rootType ?? ""}|${node.vetoes}|${node.error ?? ""}|${isFocusedRoot}|${node.site?.file ?? ""}:${node.site?.line ?? 0}|${this.#callbacks.transportMode}`;
    if (headerKey === this.#lastHeaderKey) return;
    this.#lastHeaderKey = headerKey;

    const titleRow = el("div", "inspector-title-row");
    titleRow.append(
      el("span", `kind-badge kind-${node.kind}`, formatKindLabel(node.kind)),
      el("h2", "inspector-title", formatNodeTitle(node)),
      el("span", "inspector-id", `#${node.id}`),
    );

    const metaRow = el("div", "inspector-meta-row");
    if (node.subtitle) {
      metaRow.append(el("span", undefined, node.subtitle));
    }
    if (node.kind === "element" || node.kind === "controller") {
      metaRow.append(
        el(
          "span",
          node.connected ? "meta-tag" : "meta-tag is-disconnected",
          node.connected ? "connected" : "detached",
        ),
      );
    }
    if (node.rootType) {
      metaRow.append(el("span", "meta-tag", node.rootType));
    }
    if (node.vetoes > 0) {
      metaRow.append(
        el(
          "span",
          "meta-tag is-veto",
          `${node.vetoes} ${node.vetoes === 1 ? "veto" : "vetoes"}`,
        ),
      );
    }
    if (node.error !== null) {
      metaRow.append(el("span", "meta-tag is-error", "ERROR"));
    }

    const actions = el("div", "inspector-actions");

    const focusBtn = el(
      "button",
      "tool-btn",
      isFocusedRoot ? "Show full graph" : "Focus subgraph",
    );
    focusBtn.type = "button";
    focusBtn.dataset.testid = "focus-subgraph-btn";
    focusBtn.setAttribute("aria-pressed", String(isFocusedRoot));
    focusBtn.addEventListener("click", () => {
      this.#callbacks.onFocusSubgraph(isFocusedRoot ? null : node.id);
    });
    actions.append(focusBtn);

    if (node.kind === "element") {
      const revealBtn = el("button", "tool-btn", "Reveal in Elements");
      revealBtn.type = "button";
      revealBtn.dataset.testid = "reveal-elements-btn";
      if (this.#callbacks.transportMode === "bridge") {
        revealBtn.disabled = true;
        revealBtn.title = "Available inside Chrome DevTools";
      } else {
        revealBtn.title = "Inspect this DOM element in the Elements panel";
      }
      revealBtn.addEventListener("click", () => {
        this.#callbacks.onRevealInElements(node.id);
      });
      actions.append(revealBtn);
    }

    if (node.kind === "computed" || node.kind === "observer") {
      const clearBtn = el("button", "tool-btn", "Clear memo cache");
      clearBtn.type = "button";
      clearBtn.dataset.testid = "clear-memo-btn";
      clearBtn.addEventListener("click", () => {
        this.#callbacks.onClearMemoCache(node.id);
      });
      actions.append(clearBtn);
    }

    const logBtn = el("button", "tool-btn", "Log as $lit");
    logBtn.type = "button";
    logBtn.dataset.testid = "log-node-btn";
    logBtn.title = "Bind live instance to globalThis.$lit and print to Console";
    logBtn.addEventListener("click", () => {
      this.#callbacks.onLogNode(node.id);
      this.showNodeActionMessage(
        node.id,
        true,
        "Logged live reference to Console as $lit",
      );
    });
    actions.append(logBtn);

    const children: HTMLElement[] = [titleRow];
    if (metaRow.childElementCount > 0) children.push(metaRow);
    if (node.site) {
      const fnSuffix = node.site.fn ? ` · ${node.site.fn}` : "";
      const siteEl = el(
        "div",
        "inspector-site",
        `${node.site.file}:${node.site.line}:${node.site.column}${fnSuffix}`,
      );
      siteEl.title = siteEl.textContent;
      children.push(siteEl);
    }
    children.push(actions);
    this.#headerHost.replaceChildren(...children);
  }

  #patchActionBanner(nodeId: number): void {
    if (!this.#actionBannerHost) return;
    const actionKey =
      this.#nodeFeedback && this.#nodeFeedback.nodeId === nodeId
        ? `${nodeId}|${this.#nodeFeedback.ok}|${this.#nodeFeedback.text}`
        : `none:${nodeId}`;
    if (actionKey === this.#lastActionKey) return;
    this.#lastActionKey = actionKey;

    if (!this.#nodeFeedback || this.#nodeFeedback.nodeId !== nodeId) {
      this.#actionBannerHost.hidden = true;
      this.#actionBannerHost.replaceChildren();
      return;
    }
    this.#actionBannerHost.hidden = false;
    const banner = el(
      "div",
      `action-feedback-banner ${this.#nodeFeedback.ok ? "is-ok" : "is-error"}`,
      this.#nodeFeedback.text,
    );
    this.#actionBannerHost.replaceChildren(banner);
  }

  #patchError(node: ReactivityNodeSnapshot): void {
    if (!this.#errorHost) return;
    const errKey = node.error ?? "";
    if (
      errKey === this.#lastErrorKey &&
      this.#errorHost.hidden === (node.error === null)
    ) {
      return;
    }
    this.#lastErrorKey = errKey;

    if (node.error === null) {
      this.#errorHost.hidden = true;
      this.#errorHost.replaceChildren();
      return;
    }
    this.#errorHost.hidden = false;
    this.#errorHost.replaceChildren(el("div", "error-banner", node.error));
  }

  #patchMetrics(node: ReactivityNodeSnapshot, vm: PanelViewModel): void {
    if (!this.#metricsHost) return;
    const causeNode =
      node.lastCauseNodeId !== null && node.lastCauseNodeId !== node.id
        ? (vm.snapshot?.nodes.find((n) => n.id === node.lastCauseNodeId) ??
          null)
        : null;
    const metricsKey = `${node.updates}|${node.lastDurationMs ?? ""}|${node.hits}|${node.misses}|${node.vetoes}|${node.lastChangedSeq}|${node.lastCauseNodeId ?? ""}|${node.lastCauseLabel ?? ""}|${causeNode?.label ?? ""}`;
    if (metricsKey === this.#lastMetricsKey) return;
    this.#lastMetricsKey = metricsKey;
    const section = el("section", "inspector-section");
    section.append(el("h3", "section-heading", "Execution"));

    const grid = el("div", "metrics-grid");
    const primaryLabel =
      node.kind === "element"
        ? "Renders"
        : node.kind === "context"
          ? "Pushes"
          : node.kind === "computed" || node.kind === "observer"
            ? "Invocations"
            : "Updates";

    grid.append(
      this.#metricCell(primaryLabel, String(node.updates)),
      this.#metricCell("Last duration", formatMs(node.lastDurationMs)),
    );

    if (node.kind === "computed" || node.kind === "observer") {
      const total = node.hits + node.misses;
      const ratio =
        total > 0 ? `${Math.round((node.hits / total) * 100)}%` : "—";
      grid.append(
        this.#metricCell("Hits / Misses", `${node.hits} / ${node.misses}`),
        this.#metricCell("Hit rate", ratio),
      );
    } else if (node.kind === "element") {
      grid.append(
        this.#metricCell("Vetoes", String(node.vetoes)),
        this.#metricCell(
          "Last seq",
          node.lastChangedSeq > 0 ? `#${node.lastChangedSeq}` : "—",
        ),
      );
    } else {
      grid.append(
        this.#metricCell(
          "Last seq",
          node.lastChangedSeq > 0 ? `#${node.lastChangedSeq}` : "—",
        ),
      );
    }

    section.append(grid);

    if (node.lastCauseLabel || node.lastCauseNodeId !== null) {
      const causeRow = el("div", "inspector-meta-row");
      causeRow.append(el("span", "metric-label", "Last cause:"));
      if (causeNode) {
        const causeTitle = formatNodeTitle(causeNode);
        const labelSuffix =
          node.lastCauseLabel &&
          node.lastCauseLabel !== causeNode.label &&
          node.lastCauseLabel !== causeTitle
            ? ` · ${node.lastCauseLabel}`
            : "";
        const btn = el("button", "cause-link", `${causeTitle}${labelSuffix}`);
        btn.type = "button";
        btn.addEventListener("click", () => {
          this.#callbacks.onSelectNode(causeNode.id);
        });
        causeRow.append(btn);
      } else if (node.lastCauseLabel) {
        causeRow.append(el("span", "meta-tag", node.lastCauseLabel));
      }
      section.append(causeRow);
    }

    this.#metricsHost.replaceChildren(section);
  }

  #metricCell(label: string, value: string): HTMLDivElement {
    const cell = el("div", "metric-cell");
    cell.append(
      el("span", "metric-label", label),
      el("span", "metric-val", value),
    );
    return cell;
  }

  #patchProperties(node: ReactivityNodeSnapshot): void {
    if (!this.#propsSectionHost || !this.#propsListHost) return;
    const props = node.properties;
    if (!props || props.length === 0) {
      this.#propsSectionHost.hidden = true;
      this.#propRows.clear();
      this.#propsListHost.replaceChildren();
      return;
    }

    this.#propsSectionHost.hidden = false;
    const seenNames = new Set<string>();

    for (const prop of props) {
      seenNames.add(prop.name);
      let refs = this.#propRows.get(prop.name);
      if (!refs) {
        refs = this.#createPropRow(node.id, prop);
        this.#propRows.set(prop.name, refs);
        this.#propsListHost.append(refs.row);
      }
      this.#updatePropRow(node.id, prop, refs);
    }

    for (const [name, refs] of this.#propRows.entries()) {
      if (!seenNames.has(name)) {
        refs.row.remove();
        this.#propRows.delete(name);
      }
    }
  }

  #createPropRow(nodeId: number, prop: ReactivePropertySnapshot): PropRowRefs {
    const row = el("div", "prop-row");
    const head = el("div", "prop-head");
    head.append(el("span", "prop-name", prop.name));

    if (prop.isState) {
      head.append(el("span", "meta-tag", "@state"));
    }
    if (prop.attribute !== null) {
      const attrLabel =
        prop.attribute === prop.name ? "attr" : `attr="${prop.attribute}"`;
      head.append(el("span", "meta-tag", attrLabel));
    }
    if (prop.reflect) {
      head.append(el("span", "meta-tag", "reflect"));
    }
    if (prop.typeName) {
      head.append(el("span", "meta-tag", prop.typeName));
    }

    const changesEl = el("span", "prop-changes");
    head.append(changesEl);

    const valuesEl = el("div", "prop-values");
    const entriesHost = el("div");
    const sourceEl = el("div", "prop-source");

    const editor = el("div", "prop-editor");
    const inputEl = el("input", "prop-input");
    inputEl.type = "text";
    inputEl.dataset.testid = `prop-input-${prop.name}`;
    inputEl.placeholder = "JSON value…";
    inputEl.autocomplete = "off";
    inputEl.spellcheck = false;
    inputEl.setAttribute(
      "aria-label",
      `Set JSON value for property ${prop.name}`,
    );

    const draftKey = `${nodeId}:${prop.name}`;
    inputEl.value = this.#drafts.get(draftKey) ?? defaultJsonInput(prop.value);

    inputEl.addEventListener("input", () => {
      this.#drafts.set(draftKey, inputEl.value);
    });

    const submitEdit = () => {
      this.#drafts.set(draftKey, inputEl.value);
      this.#callbacks.onSetProperty(nodeId, prop.name, inputEl.value);
    };

    inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        submitEdit();
      }
    });

    const setBtn = el("button", "prop-set-btn", "Set");
    setBtn.type = "button";
    setBtn.dataset.testid = `prop-set-${prop.name}`;
    setBtn.addEventListener("click", submitEdit);

    editor.append(inputEl, setBtn);

    const feedbackEl = el("div", "prop-feedback");
    feedbackEl.hidden = true;

    row.append(head, valuesEl, entriesHost, sourceEl, editor, feedbackEl);

    return {
      row,
      changesEl,
      valuesEl,
      sourceEl,
      entriesHost,
      inputEl,
      feedbackEl,
      entriesOpen: false,
    };
  }

  #updatePropRow(
    nodeId: number,
    prop: ReactivePropertySnapshot,
    refs: PropRowRefs,
  ): void {
    refs.changesEl.textContent = `${prop.changes}×`;

    const valueNodes: Node[] = [];
    if (prop.prevValue !== null) {
      valueNodes.push(
        el("span", "prop-prev", prop.prevValue.text),
        el("span", "prop-arrow", "→"),
      );
    }
    valueNodes.push(createValueToken(prop.value));
    refs.valuesEl.replaceChildren(...valueNodes);

    if (prop.value.entries && prop.value.entries.length > 0) {
      refs.entriesHost.hidden = false;
      refs.entriesHost.replaceChildren(
        createEntriesDetails(
          prop.value.entries,
          prop.value.truncated,
          refs.entriesOpen,
          (open) => {
            refs.entriesOpen = open;
          },
        ),
      );
    } else {
      refs.entriesHost.hidden = true;
      refs.entriesHost.replaceChildren();
    }

    if (prop.sourceLabel) {
      refs.sourceEl.hidden = false;
      refs.sourceEl.textContent = `← ${prop.sourceLabel}`;
    } else {
      refs.sourceEl.hidden = true;
      refs.sourceEl.textContent = "";
    }

    const draftKey = `${nodeId}:${prop.name}`;
    if (
      document.activeElement !== refs.inputEl &&
      !this.#drafts.has(draftKey)
    ) {
      refs.inputEl.value = defaultJsonInput(prop.value);
    }

    const existingFeedback = this.#propFeedback.get(draftKey);
    if (existingFeedback) {
      this.#applyPropFeedback(refs.feedbackEl, existingFeedback);
    }
  }

  #applyPropFeedback(elTarget: HTMLDivElement, result: ActionResult): void {
    elTarget.hidden = false;
    elTarget.className = `prop-feedback ${result.ok ? "is-ok" : "is-error"}`;
    elTarget.textContent = result.ok ? "Updated" : result.error;
  }

  #patchValueAndArgs(node: ReactivityNodeSnapshot): void {
    if (!this.#valueHost) return;
    const valueKey = `${node.value?.kind ?? ""}|${node.value?.text ?? ""}|${node.value?.entries?.length ?? 0}|${node.lastArgs?.map((a) => a.text).join("\u0001") ?? ""}`;
    if (valueKey === this.#lastValueKey) return;
    this.#lastValueKey = valueKey;
    const sections: HTMLElement[] = [];

    if (node.value !== null) {
      const section = el("section", "inspector-section");
      const title =
        node.kind === "computed"
          ? "Last Return Value"
          : node.kind === "context"
            ? "Current Context Value"
            : "Current Value";
      const heading = el("h3", "section-heading", title);
      heading.append(el("span", "meta-tag", node.value.kind));
      section.append(heading);

      const box = el("div", "value-box");
      box.append(createValueToken(node.value));
      if (node.value.entries && node.value.entries.length > 0) {
        box.append(
          createEntriesDetails(node.value.entries, node.value.truncated, true),
        );
      }
      section.append(box);
      sections.push(section);
    }

    if (node.lastArgs && node.lastArgs.length > 0) {
      const section = el("section", "inspector-section");
      section.append(
        el("h3", "section-heading", `Last Arguments (${node.lastArgs.length})`),
      );
      const box = el("div", "value-box");
      for (let i = 0; i < node.lastArgs.length; i++) {
        const arg = node.lastArgs[i]!;
        const line = el("div", "prop-values");
        line.append(
          el("span", "metric-label", `arg[${i}]`),
          createValueToken(arg),
        );
        box.append(line);
      }
      section.append(box);
      sections.push(section);
    }

    this.#valueHost.hidden = sections.length === 0;
    this.#valueHost.replaceChildren(...sections);
  }

  #patchRelations(node: ReactivityNodeSnapshot, vm: PanelViewModel): void {
    if (!this.#relationsHost || !vm.snapshot) return;

    const nodeById = new Map<number, ReactivityNodeSnapshot>();
    for (const candidate of vm.snapshot.nodes) {
      nodeById.set(candidate.id, candidate);
    }

    const incoming: ReactivityEdgeSnapshot[] = [];
    const outgoing: ReactivityEdgeSnapshot[] = [];
    for (const edge of vm.snapshot.edges) {
      if (edge.targetId === node.id) incoming.push(edge);
      if (edge.sourceId === node.id) outgoing.push(edge);
    }

    const relationsKey = [
      ...incoming.map(
        (e) => `in:${e.id}:${e.count}:${nodeById.get(e.sourceId)?.label ?? ""}`,
      ),
      ...outgoing.map(
        (e) =>
          `out:${e.id}:${e.count}:${nodeById.get(e.targetId)?.label ?? ""}`,
      ),
    ].join("\u0001");
    if (relationsKey === this.#lastRelationsKey) return;
    this.#lastRelationsKey = relationsKey;

    const sections: HTMLElement[] = [];

    if (incoming.length > 0) {
      sections.push(
        this.#buildRelationSection("Driven By", incoming, nodeById, "source"),
      );
    }
    if (outgoing.length > 0) {
      sections.push(
        this.#buildRelationSection("Drives", outgoing, nodeById, "target"),
      );
    }

    this.#relationsHost.hidden = sections.length === 0;
    this.#relationsHost.replaceChildren(...sections);
  }

  #buildRelationSection(
    title: string,
    edges: ReadonlyArray<ReactivityEdgeSnapshot>,
    nodeById: ReadonlyMap<number, ReactivityNodeSnapshot>,
    direction: "source" | "target",
  ): HTMLElement {
    const section = el("section", "inspector-section");
    section.append(el("h3", "section-heading", `${title} (${edges.length})`));
    const list = el("div", "relation-list");

    for (const edge of edges) {
      const peerId = direction === "source" ? edge.sourceId : edge.targetId;
      const peer = nodeById.get(peerId);
      if (!peer) continue;

      const btn = el("button", "relation-btn");
      btn.type = "button";
      const edgeText = `${edge.label ?? edge.kind}${edge.count > 1 ? ` ×${edge.count}` : ""}`;
      btn.append(
        el("span", `kind-dot kind-${peer.kind}`),
        el("span", "relation-node-label", formatNodeTitle(peer)),
        el("span", "relation-edge-label", edgeText),
      );
      btn.addEventListener("click", () => {
        this.#callbacks.onSelectNode(peer.id);
      });
      list.append(btn);
    }

    section.append(list);
    return section;
  }
}
