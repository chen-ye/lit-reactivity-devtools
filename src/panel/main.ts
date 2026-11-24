import type {
  ActionResult,
  BackgroundToPanelMessage,
  GraphSnapshot,
  NodeKind,
  SourceLocation,
} from "../protocol/types.ts";
import {
  createPaneLayoutController,
  getDefaultBottomBounds,
  getDefaultRightBounds,
} from "../shared/pane-layout.ts";
import {
  clearTagTokens,
  listExcludedTags,
  listIncludedTags,
  matchGlob,
  parseQuery,
  rewriteFieldInclusionsToExclusions,
  setTagExcludedInQuery,
  setTagOnlyInQuery,
} from "../shared/query-parser.ts";
import { registerPanelShortcuts } from "../shared/shortcuts.ts";
import { createThemeController } from "../shared/theme.ts";
import {
  DEFAULT_FILTER_STATE,
  derivePanelViewModel,
  type KindFilter,
  type PanelFilterState,
  type PanelViewModel,
  type TraceCategoryFilter,
} from "./graph-state.ts";
import { GraphView } from "./graph-view.ts";
import { InspectorView } from "./inspector-view.ts";
import { createPanelTransport, type PanelTransport } from "./transport.ts";
import { WaterfallView } from "./waterfall-view.ts";

type ConnectionState =
  "connecting" | "connected" | "navigating" | "disconnected";
type DrawerTab = "inspector" | "waterfall";

type PendingRequest =
  | {
      readonly kind: "set-property";
      readonly nodeId: number;
      readonly propName: string;
    }
  | { readonly kind: "clear-memo"; readonly nodeId: number };

const THEME_STORAGE_KEY = "lit-flow-theme";
const PANE_LAYOUT_STORAGE_KEY = "lit-flow-pane-layout";
const VALID_KINDS = new Set<string>([
  "all",
  "model",
  "controller",
  "context",
  "element",
  "computed",
  "observer",
]);

function mustEl<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof ctor)) {
    throw new Error(`Expected #${id} to be ${ctor.name}`);
  }
  return found;
}

function isKindFilter(value: string): value is KindFilter {
  return VALID_KINDS.has(value);
}

function formatHostUrl(url: string | null): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.host || parsed.pathname;
  } catch {
    return url;
  }
}

function formatNodeLabel(kind: NodeKind, label: string): string {
  if (kind === "element" && !label.startsWith("<")) {
    return `<${label}>`;
  }
  return label;
}

function bootstrapPanel(): void {
  const panelShell = mustEl("panel-shell", HTMLDivElement);
  const workspaceEl = mustEl("workspace", HTMLElement);
  const rightSplitterEl = mustEl("splitter-right", HTMLDivElement);
  const bottomSplitterEl = mustEl("splitter-bottom", HTMLDivElement);
  const bottomCollapsedBar = mustEl("bottom-collapsed-bar", HTMLDivElement);
  const restoreBottomBtn = mustEl("restore-bottom-btn", HTMLButtonElement);
  const connectionStatusEl = mustEl("connection-status", HTMLSpanElement);
  const connectionStatusTextEl = mustEl(
    "connection-status-text",
    HTMLSpanElement,
  );
  const searchInput = mustEl("search-input", HTMLInputElement);
  const searchNavGroup = mustEl("search-nav-group", HTMLDivElement);
  const searchMatchCountEl = mustEl("search-match-count", HTMLSpanElement);
  const searchPrevBtn = mustEl("search-prev-btn", HTMLButtonElement);
  const searchNextBtn = mustEl("search-next-btn", HTMLButtonElement);
  const searchClearBtn = mustEl("search-clear-btn", HTMLButtonElement);
  const searchModeBtn = mustEl("search-mode-btn", HTMLButtonElement);
  const pauseBtn = mustEl("pause-btn", HTMLButtonElement);
  const memoHitsBtn = mustEl("memo-hits-btn", HTMLButtonElement);
  const eventsBtn = mustEl("events-btn", HTMLButtonElement);
  const scanDomBtn = mustEl("scan-dom-btn", HTMLButtonElement);
  const syncElementsBtn = mustEl("sync-elements-btn", HTMLButtonElement);
  const fitGraphBtn = mustEl("fit-graph", HTMLButtonElement);
  const themeBtn = mustEl("theme-btn", HTMLButtonElement);
  const kindFilterGroup = mustEl("kind-filter-group", HTMLDivElement);
  const connectedOnlyBtn = mustEl("connected-only-btn", HTMLButtonElement);
  const onlyErrorsBtn = mustEl("only-errors-btn", HTMLButtonElement);
  const tagsDropdownWrap = mustEl("tags-dropdown-wrap", HTMLDivElement);
  const tagsFilterBtn = mustEl("tags-filter-btn", HTMLButtonElement);
  const tagsPopover = mustEl("tags-popover", HTMLDivElement);
  const focusBreadcrumb = mustEl("focus-breadcrumb", HTMLDivElement);
  const focusBreadcrumbLabel = mustEl(
    "focus-breadcrumb-label",
    HTMLSpanElement,
  );
  const clearFocusBtn = mustEl("clear-focus-btn", HTMLButtonElement);
  const statsBar = mustEl("stats-bar", HTMLDivElement);
  const graphCanvas = mustEl("graph-canvas", HTMLDivElement);
  const emptyStateEl = mustEl("empty-state", HTMLDivElement);
  const emptyTitleEl = mustEl("empty-state-title", HTMLHeadingElement);
  const emptyDescEl = mustEl("empty-state-desc", HTMLParagraphElement);
  const emptyScanBtn = mustEl("empty-scan-btn", HTMLButtonElement);
  const emptyResetBtn = mustEl("empty-reset-btn", HTMLButtonElement);
  const zoomOutBtn = mustEl("zoom-out-btn", HTMLButtonElement);
  const zoomInBtn = mustEl("zoom-in-btn", HTMLButtonElement);
  const zoomReadout = mustEl("zoom-readout", HTMLSpanElement);
  const hudFitBtn = mustEl("hud-fit-btn", HTMLButtonElement);
  const toastBanner = mustEl("toast-banner", HTMLDivElement);
  const tabInspectorBtn = mustEl("tab-inspector", HTMLButtonElement);
  const tabWaterfallBtn = mustEl("tab-waterfall", HTMLButtonElement);
  const tabWaterfallCount = mustEl("tab-waterfall-count", HTMLSpanElement);
  const inspectorContainer = mustEl("inspector-view", HTMLElement);
  const waterfallContainer = mustEl("waterfall-view", HTMLElement);

  const transport: PanelTransport = createPanelTransport();

  if (transport.mode === "bridge") {
    syncElementsBtn.hidden = true;
  }

  let snapshot: GraphSnapshot | null = null;
  let filter: PanelFilterState = {
    ...DEFAULT_FILTER_STATE,
    expandedMemoOwnerIds: new Set(),
  };
  let selectedNodeId: number | null = null;
  let connectionState: ConnectionState = "connecting";
  let connectedUrl: string | null = null;
  let activeTab: DrawerTab = "inspector";
  let requestCounter = 0;
  let lastHighlightedNodeId: number | null = null;
  let activeMatchIndex = -1;
  let activeSearchMatchId: number | null = null;
  let lastVm: PanelViewModel | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let handshakeTimer: ReturnType<typeof setInterval> | null = null;
  let handshakeAttempts = 0;

  const pendingRequests = new Map<string, PendingRequest>();

  const showToast = (message: string): void => {
    toastBanner.textContent = message;
    toastBanner.hidden = false;
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => {
      toastBanner.hidden = true;
      toastTimer = null;
    }, 2400);
  };

  const themeController = createThemeController({
    storageKey: THEME_STORAGE_KEY,
    getDevToolsTheme: () => transport.getDevToolsTheme(),
    onChange: (preference) => {
      themeBtn.textContent =
        preference === "auto"
          ? "Theme: Auto"
          : preference === "dark"
            ? "Theme: Dark"
            : "Theme: Light";
    },
  });

  const setActiveTab = (tab: DrawerTab): void => {
    activeTab = tab;
    panelShell.dataset.activeTab = tab;
    tabInspectorBtn.setAttribute("aria-selected", String(tab === "inspector"));
    tabWaterfallBtn.setAttribute("aria-selected", String(tab === "waterfall"));
  };

  const sendHoverHighlight = (nodeId: number | null): void => {
    let targetId: number | null = null;
    if (nodeId !== null && snapshot) {
      const node = snapshot.nodes.find((n) => n.id === nodeId);
      if (node && node.kind === "element") {
        targetId = node.id;
      }
    }
    if (targetId === lastHighlightedNodeId) return;
    lastHighlightedNodeId = targetId;
    transport.send({ type: "HIGHLIGHT_ELEMENT", nodeId: targetId });
  };

  const nextRequestId = (): string => {
    requestCounter += 1;
    return `req-${requestCounter}`;
  };

  const toggleMemoCluster = (ownerId: number): void => {
    const nextExpanded = new Set(filter.expandedMemoOwnerIds);
    if (nextExpanded.has(ownerId)) {
      nextExpanded.delete(ownerId);
    } else {
      nextExpanded.add(ownerId);
    }
    filter = { ...filter, expandedMemoOwnerIds: nextExpanded };
    renderAll();
  };

  const setTagExcluded = (tagName: string, excluded: boolean): void => {
    const allTagNames = lastVm?.tagInventory.map((entry) => entry.tagName);
    const nextQuery = setTagExcludedInQuery(
      filter.query,
      tagName,
      excluded,
      allTagNames,
    );
    applyQueryUpdate(nextQuery, { resetMatch: false, fit: true });
    showToast(excluded ? `Hidden <${tagName}>` : `Shown <${tagName}>`);
  };

  const openSourceForNode = (
    nodeId: number,
    site: SourceLocation | null,
    propName?: string | null,
  ): void => {
    void transport.openSource(nodeId, site, propName).then((result) => {
      if (result.ok) {
        const msg =
          transport.mode === "bridge"
            ? "Copied source location to clipboard"
            : "Opened source in Sources";
        showToast(msg);
        inspectorView.showNodeActionMessage(nodeId, true, msg);
      } else {
        showToast(result.error);
        inspectorView.showNodeActionMessage(nodeId, false, result.error);
      }
    });
  };

  const graphView = new GraphView(graphCanvas, {
    onSelectNode(nodeId) {
      selectedNodeId = nodeId;
      if (nodeId !== null && activeTab !== "inspector") {
        setActiveTab("inspector");
      }
      renderAll();
    },
    onFocusSubgraph(nodeId) {
      selectedNodeId = nodeId;
      filter = { ...filter, focusSubgraphNodeId: nodeId };
      renderAll();
    },
    onHoverNode(nodeId) {
      sendHoverHighlight(nodeId);
    },
    onZoomChange(scale) {
      zoomReadout.textContent = `${Math.round(scale * 100)}%`;
    },
    onToggleMemoCluster(ownerId: number) {
      toggleMemoCluster(ownerId);
    },
  });

  const inspectorView = new InspectorView(inspectorContainer, {
    transportMode: transport.mode,
    onSelectNode(nodeId) {
      selectedNodeId = nodeId;
      renderAll();
      graphView.centerOnNode(nodeId);
    },
    onFocusSubgraph(nodeId) {
      filter = { ...filter, focusSubgraphNodeId: nodeId };
      if (nodeId !== null) {
        selectedNodeId = nodeId;
      }
      renderAll();
    },
    onSetProperty(nodeId, propName, jsonText) {
      const requestId = nextRequestId();
      pendingRequests.set(requestId, {
        kind: "set-property",
        nodeId,
        propName,
      });
      transport.send({
        type: "SET_PROPERTY",
        nodeId,
        propName,
        jsonText,
        requestId,
      });
    },
    onClearMemoCache(nodeId) {
      const requestId = nextRequestId();
      pendingRequests.set(requestId, { kind: "clear-memo", nodeId });
      transport.send({
        type: "CLEAR_MEMO_CACHE",
        nodeId,
        requestId,
      });
    },
    onRevealInElements(nodeId) {
      transport.revealInElements(nodeId);
    },
    onLogNode(nodeId) {
      transport.send({ type: "LOG_NODE", nodeId });
      showToast("Logged node to Console as $lit");
    },
    onOpenSource(
      nodeId: number,
      site: SourceLocation | null,
      propName?: string | null,
    ) {
      openSourceForNode(nodeId, site, propName);
    },
    onHideTag(tagName: string, nextExcluded = true) {
      setTagExcluded(tagName, nextExcluded);
    },
    onToggleMemoCluster(ownerId: number) {
      toggleMemoCluster(ownerId);
    },
  });

  let paneLayout: ReturnType<typeof createPaneLayoutController> | null = null;

  const waterfallView = new WaterfallView(waterfallContainer, {
    onSelectNode(nodeId) {
      selectedNodeId = nodeId;
      renderAll();
      graphView.centerOnNode(nodeId);
    },
    onHoverNode(nodeId) {
      sendHoverHighlight(nodeId);
    },
    onTraceCategoryChange(category: TraceCategoryFilter) {
      filter = { ...filter, traceCategory: category };
      renderAll();
    },
    onToggleFollowSelection() {
      filter = {
        ...filter,
        followSelectionInTraces: !filter.followSelectionInTraces,
      };
      renderAll();
    },
    onClearEvents() {
      transport.send({ type: "CLEAR_EVENTS" });
    },
    onToggleBottomCollapse() {
      paneLayout?.toggleBottomCollapsed();
    },
  });

  const syncBottomCollapsedUi = (collapsed: boolean): void => {
    bottomCollapsedBar.hidden = !collapsed;
    waterfallView.setBottomCollapsed(collapsed);
  };

  paneLayout = createPaneLayoutController({
    rootEl: panelShell,
    workspaceEl,
    rightSplitterEl,
    bottomSplitterEl,
    getRightBounds: (w) => getDefaultRightBounds(Math.max(0, w - 6)),
    getBottomBounds: (h) => getDefaultBottomBounds(Math.max(0, h - 6)),
    storageKey: PANE_LAYOUT_STORAGE_KEY,
    defaultState: {
      rightWidthPx: 340,
      bottomHeightPx: 220,
      bottomCollapsed: false,
    },
    onChange: (state) => {
      syncBottomCollapsedUi(state.bottomCollapsed);
    },
  });
  syncBottomCollapsedUi(paneLayout.getState().bottomCollapsed);

  const reconcileActiveMatch = (vm: PanelViewModel): number | null => {
    const matches = vm.orderedMatchIds;
    if (matches.length === 0) {
      activeMatchIndex = -1;
      activeSearchMatchId = null;
      return null;
    }
    if (activeSearchMatchId !== null) {
      const existingIdx = matches.indexOf(activeSearchMatchId);
      if (existingIdx !== -1) {
        activeMatchIndex = existingIdx;
        return activeSearchMatchId;
      }
    }
    const clampedIdx =
      activeMatchIndex >= 0 && activeMatchIndex < matches.length
        ? activeMatchIndex
        : 0;
    activeMatchIndex = clampedIdx;
    activeSearchMatchId = matches[clampedIdx] ?? null;
    return activeSearchMatchId;
  };

  const updateConnectionStatus = (): void => {
    const isPaused = snapshot?.settings.paused ?? false;
    const visualState =
      isPaused && connectionState === "connected" ? "paused" : connectionState;
    connectionStatusEl.dataset.state = visualState;

    const hostSuffix = connectedUrl ? ` · ${formatHostUrl(connectedUrl)}` : "";
    switch (visualState) {
      case "connecting":
        connectionStatusTextEl.textContent = "Connecting…";
        connectionStatusEl.title =
          "Waiting for Lit Reactivity hook on inspected page";
        break;
      case "connected":
        connectionStatusTextEl.textContent = "Connected";
        connectionStatusEl.title = `Connected${hostSuffix}`;
        break;
      case "paused":
        connectionStatusTextEl.textContent = "Paused";
        connectionStatusEl.title = `Capture paused${hostSuffix}`;
        break;
      case "navigating":
        connectionStatusTextEl.textContent = "Navigating…";
        connectionStatusEl.title = `Navigating${hostSuffix}`;
        break;
      case "disconnected":
        connectionStatusTextEl.textContent = "Disconnected";
        connectionStatusEl.title = "Inspected page disconnected";
        break;
    }
  };

  const updateSearchControls = (vm: PanelViewModel): void => {
    const isFilterMode = filter.queryMode === "filter";
    searchModeBtn.textContent = isFilterMode ? "Filter" : "Highlight";
    searchModeBtn.setAttribute("aria-pressed", String(isFilterMode));
    searchModeBtn.title = isFilterMode
      ? "Search mode: Filter graph to matches only (click to switch to Highlight)"
      : "Search mode: Highlight matches in graph (click to switch to Filter)";

    const parsed = parseQuery(filter.query);
    const hasPositiveInclusions = parsed.inclusions.length > 0;
    const totalMatches = vm.orderedMatchIds.length;

    if (!hasPositiveInclusions) {
      searchNavGroup.hidden = true;
      searchMatchCountEl.textContent = "0/0";
      searchMatchCountEl.classList.remove("is-no-match");
      return;
    }

    searchNavGroup.hidden = false;
    if (totalMatches > 0) {
      const displayIdx = activeMatchIndex >= 0 ? activeMatchIndex + 1 : 1;
      searchMatchCountEl.textContent = `${displayIdx}/${totalMatches}`;
      searchMatchCountEl.classList.remove("is-no-match");
      searchPrevBtn.disabled = false;
      searchNextBtn.disabled = false;
    } else {
      searchMatchCountEl.textContent = "0/0";
      searchMatchCountEl.classList.add("is-no-match");
      searchPrevBtn.disabled = true;
      searchNextBtn.disabled = true;
    }
  };

  const updateTagsButton = (vm: PanelViewModel): void => {
    const total = vm.tagInventory.length;
    const excludedCount = vm.tagInventory.filter((t) => t.excluded).length;
    const includedCount = vm.tagInventory.filter((t) => t.included).length;
    const hasTagQuery =
      listExcludedTags(filter.query).length > 0 ||
      listIncludedTags(filter.query).length > 0;

    if (hasTagQuery || excludedCount > 0 || includedCount > 0) {
      tagsFilterBtn.dataset.active = "true";
    } else {
      delete tagsFilterBtn.dataset.active;
    }

    if (excludedCount > 0 && total > 0) {
      tagsFilterBtn.textContent = `Tags (${total - excludedCount}/${total}) ▾`;
    } else if (includedCount > 0) {
      tagsFilterBtn.textContent = `Tags (${includedCount}) ▾`;
    } else if (total > 0) {
      tagsFilterBtn.textContent = `Tags (${total}) ▾`;
    } else {
      tagsFilterBtn.textContent = "Tags ▾";
    }
  };

  const renderTagsPopover = (vm: PanelViewModel): void => {
    const header = document.createElement("div");
    header.className = "tags-popover-header";

    const title = document.createElement("span");
    title.className = "tags-popover-title";
    title.textContent = "Web Component Tags";

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "tags-popover-reset";
    resetBtn.textContent = "Show all";
    const hasTagTokens =
      listExcludedTags(filter.query).length > 0 ||
      listIncludedTags(filter.query).length > 0;
    resetBtn.disabled = !hasTagTokens;
    resetBtn.addEventListener("click", () => {
      const nextQuery = clearTagTokens(filter.query);
      applyQueryUpdate(nextQuery, { resetMatch: false, fit: true });
    });

    header.append(title, resetBtn);

    const body = document.createElement("div");
    body.className = "tags-popover-body";

    if (vm.tagInventory.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tags-empty";
      empty.textContent = "No web component tags tracked yet.";
      body.append(empty);
      tagsPopover.replaceChildren(header, body);
      return;
    }

    const includedTags = listIncludedTags(filter.query);
    const allTagNames = vm.tagInventory.map((entry) => entry.tagName);
    const filterByInclusions =
      filter.queryMode === "filter" && includedTags.length > 0;
    const isTagChecked = (entry: (typeof vm.tagInventory)[number]): boolean =>
      !entry.excluded &&
      (!filterByInclusions ||
        includedTags.every((inc) => matchGlob(inc, entry.tagName)));

    if (vm.prefixGroups.length > 0) {
      const prefixHeading = document.createElement("div");
      prefixHeading.className = "tags-section-label";
      prefixHeading.textContent = "Prefixes";
      body.append(prefixHeading);

      for (const group of vm.prefixGroups) {
        const row = document.createElement("div");
        row.className = "tags-row";

        const label = document.createElement("label");
        label.className = "tags-toggle-label";

        const groupEntries = vm.tagInventory.filter((entry) =>
          matchGlob(group.prefix, entry.tagName),
        );
        const someHidden = groupEntries.some((entry) => !isTagChecked(entry));
        const allHidden =
          groupEntries.length > 0 &&
          groupEntries.every((entry) => !isTagChecked(entry));

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "tags-checkbox";
        checkbox.checked = !allHidden;
        checkbox.indeterminate = someHidden && !allHidden;
        checkbox.addEventListener("change", () => {
          if (filterByInclusions) {
            const nextIncluded = vm.tagInventory
              .filter((entry) =>
                matchGlob(group.prefix, entry.tagName)
                  ? checkbox.checked
                  : isTagChecked(entry),
              )
              .map((entry) => entry.tagName);
            const nextQuery = rewriteFieldInclusionsToExclusions(
              filter.query,
              "tag",
              nextIncluded,
              allTagNames,
            );
            applyQueryUpdate(nextQuery, { resetMatch: false, fit: true });
            return;
          }
          let nextQuery = setTagExcludedInQuery(
            filter.query,
            group.prefix,
            !checkbox.checked,
          );
          if (checkbox.checked) {
            for (const entry of groupEntries) {
              nextQuery = setTagExcludedInQuery(
                nextQuery,
                entry.tagName,
                false,
                allTagNames,
              );
            }
          }
          applyQueryUpdate(nextQuery, { resetMatch: false, fit: true });
        });

        const nameSpan = document.createElement("span");
        nameSpan.className = "tags-name";
        nameSpan.textContent = group.prefix;

        const countSpan = document.createElement("span");
        countSpan.className = "tags-count";
        countSpan.textContent = String(group.count);

        label.append(checkbox, nameSpan, countSpan);

        const onlyBtn = document.createElement("button");
        onlyBtn.type = "button";
        onlyBtn.className = "tags-only-btn";
        onlyBtn.textContent = "Only";
        const isOnly =
          includedTags.length === 1 &&
          includedTags[0]?.toLowerCase() === group.prefix.toLowerCase();
        onlyBtn.setAttribute("aria-pressed", String(isOnly));
        onlyBtn.addEventListener("click", () => {
          const nextQuery = isOnly
            ? clearTagTokens(filter.query)
            : setTagOnlyInQuery(filter.query, group.prefix);
          applyQueryUpdate(nextQuery, {
            resetMatch: true,
            fit: filter.queryMode === "filter",
          });
        });

        row.append(label, onlyBtn);
        body.append(row);
      }
    }

    const tagsHeading = document.createElement("div");
    tagsHeading.className = "tags-section-label";
    tagsHeading.textContent = "Tags";
    body.append(tagsHeading);

    for (const entry of vm.tagInventory) {
      const row = document.createElement("div");
      row.className = "tags-row";

      const label = document.createElement("label");
      label.className = "tags-toggle-label";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "tags-checkbox";
      checkbox.checked = isTagChecked(entry);
      checkbox.addEventListener("change", () => {
        if (filterByInclusions) {
          const nextIncluded = vm.tagInventory
            .filter((t) =>
              t.tagName.toLowerCase() === entry.tagName.toLowerCase()
                ? checkbox.checked
                : isTagChecked(t),
            )
            .map((t) => t.tagName);
          const nextQuery = rewriteFieldInclusionsToExclusions(
            filter.query,
            "tag",
            nextIncluded,
            allTagNames,
          );
          applyQueryUpdate(nextQuery, { resetMatch: false, fit: true });
          return;
        }
        const nextQuery = setTagExcludedInQuery(
          filter.query,
          entry.tagName,
          !checkbox.checked,
          allTagNames,
        );
        applyQueryUpdate(nextQuery, { resetMatch: false, fit: true });
      });

      const nameSpan = document.createElement("span");
      nameSpan.className = "tags-name";
      nameSpan.textContent = `<${entry.tagName}>`;

      const countSpan = document.createElement("span");
      countSpan.className = "tags-count";
      countSpan.textContent = String(entry.count);

      label.append(checkbox, nameSpan, countSpan);

      const onlyBtn = document.createElement("button");
      onlyBtn.type = "button";
      onlyBtn.className = "tags-only-btn";
      onlyBtn.textContent = "Only";
      const isOnly =
        includedTags.length === 1 &&
        includedTags[0]?.toLowerCase() === entry.tagName.toLowerCase();
      onlyBtn.setAttribute("aria-pressed", String(isOnly));
      onlyBtn.addEventListener("click", () => {
        const nextQuery = isOnly
          ? clearTagTokens(filter.query)
          : setTagOnlyInQuery(filter.query, entry.tagName);
        applyQueryUpdate(nextQuery, {
          resetMatch: true,
          fit: filter.queryMode === "filter",
        });
      });

      row.append(label, onlyBtn);
      body.append(row);
    }

    tagsPopover.replaceChildren(header, body);
  };

  const closeTagsPopover = (): void => {
    if (tagsPopover.hidden) return;
    tagsPopover.hidden = true;
    tagsFilterBtn.setAttribute("aria-expanded", "false");
  };

  const openTagsPopover = (): void => {
    const btnRect = tagsFilterBtn.getBoundingClientRect();
    tagsPopover.classList.toggle(
      "is-align-end",
      btnRect.left + 260 > window.innerWidth,
    );
    tagsPopover.hidden = false;
    tagsFilterBtn.setAttribute("aria-expanded", "true");
    if (lastVm) {
      renderTagsPopover(lastVm);
    }
  };

  const updateToolbarControls = (vm: PanelViewModel): void => {
    const paused = vm.snapshot?.settings.paused ?? false;
    const captureMemoHits = vm.snapshot?.settings.captureMemoHits ?? false;
    const captureCustomEvents =
      vm.snapshot?.settings.captureCustomEvents ?? true;

    pauseBtn.setAttribute("aria-pressed", String(paused));
    const pauseLabel = pauseBtn.querySelector("span");
    if (pauseLabel) {
      pauseLabel.textContent = paused ? "Resume" : "Pause";
    }
    memoHitsBtn.setAttribute("aria-pressed", String(captureMemoHits));
    eventsBtn.setAttribute("aria-pressed", String(captureCustomEvents));
    connectedOnlyBtn.setAttribute("aria-pressed", String(filter.connectedOnly));
    onlyErrorsBtn.setAttribute("aria-pressed", String(filter.onlyErrors));

    for (const btn of kindFilterGroup.querySelectorAll<HTMLButtonElement>(
      "button[data-kind]",
    )) {
      const kind = btn.dataset.kind;
      btn.setAttribute("aria-pressed", String(kind === filter.kindFilter));
    }

    updateTagsButton(vm);

    if (vm.focusedNode) {
      focusBreadcrumb.hidden = false;
      focusBreadcrumbLabel.textContent = `Focused: ${formatNodeLabel(vm.focusedNode.kind, vm.focusedNode.label)}`;
    } else {
      focusBreadcrumb.hidden = true;
      focusBreadcrumbLabel.textContent = "";
    }

    const { stats } = vm;
    const isFiltered = vm.visibleNodes.length !== stats.totalNodes;
    const nodeSummary = isFiltered
      ? `${vm.visibleNodes.length}/${stats.totalNodes} nodes`
      : `${stats.totalNodes} ${stats.totalNodes === 1 ? "node" : "nodes"}`;
    const edgeSummary = `${vm.visibleEdges.length} ${vm.visibleEdges.length === 1 ? "edge" : "edges"}`;
    const litVersions = vm.snapshot?.litVersions ?? [];
    const litSuffix =
      litVersions.length > 0 ? ` · lit-element ${litVersions.join(", ")}` : "";

    const statParts: Node[] = [
      document.createTextNode(`${nodeSummary} · ${edgeSummary}${litSuffix}`),
    ];
    if (stats.vetoCount > 0) {
      const chip = document.createElement("span");
      chip.className = "stat-chip veto";
      chip.textContent = `${stats.vetoCount} veto`;
      statParts.push(chip);
    }
    if (stats.errorCount > 0) {
      const chip = document.createElement("span");
      chip.className = "stat-chip error";
      chip.textContent = `${stats.errorCount} err`;
      statParts.push(chip);
    }
    statsBar.replaceChildren(...statParts);

    tabWaterfallCount.textContent = String(vm.filteredEvents.length);
  };

  const updateEmptyState = (vm: PanelViewModel): void => {
    const hasVisibleNodes = vm.visibleNodes.length > 0;
    panelShell.dataset.empty = String(vm.stats.totalNodes === 0);

    if (hasVisibleNodes) {
      emptyStateEl.hidden = true;
      return;
    }

    emptyStateEl.hidden = false;
    if (vm.stats.totalNodes === 0) {
      emptyTitleEl.textContent = "Waiting for Lit reactivity";
      emptyDescEl.textContent =
        "Interact with the inspected page or run Scan DOM to trace models, controllers, @lit/context channels, custom elements, and memoize-one computations.";
      emptyScanBtn.hidden = false;
      emptyResetBtn.hidden = true;
    } else {
      emptyTitleEl.textContent = "No nodes match current filters";
      emptyDescEl.textContent = `${vm.stats.totalNodes} nodes are tracked in the page, but the active search, kind filter, or subgraph focus hides them.`;
      emptyScanBtn.hidden = true;
      emptyResetBtn.hidden = false;
    }
  };

  const renderAll = (): void => {
    const vm = derivePanelViewModel(snapshot, filter, selectedNodeId);
    lastVm = vm;
    const matchId = reconcileActiveMatch(vm);
    updateConnectionStatus();
    updateToolbarControls(vm);
    updateSearchControls(vm);
    updateEmptyState(vm);
    if (!tagsPopover.hidden) {
      renderTagsPopover(vm);
    }
    graphView.render(vm, matchId);
    inspectorView.render(vm);
    waterfallView.render(
      vm,
      filter.traceCategory,
      filter.followSelectionInTraces,
    );
  };

  const applyQueryUpdate = (
    nextQuery: string,
    options: { readonly resetMatch: boolean; readonly fit: boolean },
  ): void => {
    if (searchInput.value !== nextQuery) {
      searchInput.value = nextQuery;
    }
    if (options.resetMatch) {
      activeMatchIndex = 0;
      activeSearchMatchId = null;
    }
    filter = { ...filter, query: nextQuery };
    renderAll();
    if (options.fit) {
      graphView.fit();
    }
  };

  const stepSearchMatch = (delta: 1 | -1): void => {
    const matches = lastVm?.orderedMatchIds ?? [];
    if (matches.length === 0) return;
    const baseIndex = activeMatchIndex < 0 ? 0 : activeMatchIndex;
    const nextIndex = (baseIndex + delta + matches.length) % matches.length;
    activeMatchIndex = nextIndex;
    activeSearchMatchId = matches[nextIndex] ?? null;
    renderAll();
    if (activeSearchMatchId !== null) {
      graphView.centerOnNode(activeSearchMatchId);
    }
  };

  const clearSearch = (): void => {
    applyQueryUpdate("", {
      resetMatch: true,
      fit: filter.queryMode === "filter",
    });
  };

  const stopHandshakeRetry = (): void => {
    if (handshakeTimer !== null) {
      clearInterval(handshakeTimer);
      handshakeTimer = null;
    }
  };

  const handleActionResult = (
    requestId: string,
    result: ActionResult,
  ): void => {
    const pending = pendingRequests.get(requestId);
    if (!pending) return;
    pendingRequests.delete(requestId);

    if (pending.kind === "set-property") {
      inspectorView.showPropertyResult(
        pending.nodeId,
        pending.propName,
        result,
      );
      if (result.ok) {
        showToast(`Updated ${pending.propName}`);
      }
    } else {
      inspectorView.showNodeActionMessage(
        pending.nodeId,
        result.ok,
        result.ok ? "Memo cache cleared" : result.error,
      );
      if (result.ok) {
        showToast("Memo cache cleared");
      }
    }
  };

  const onTransportMessage = (msg: BackgroundToPanelMessage): void => {
    switch (msg.type) {
      case "PAGE_CONNECTED":
        stopHandshakeRetry();
        connectionState = "connected";
        connectedUrl = msg.url;
        transport.send({ type: "REQUEST_SNAPSHOT" });
        renderAll();
        break;
      case "PAGE_NAVIGATING":
        connectionState = "navigating";
        connectedUrl = msg.url;
        snapshot = null;
        selectedNodeId = null;
        filter = { ...filter, focusSubgraphNodeId: null };
        transport.send({ type: "START_INSPECTION" });
        renderAll();
        break;
      case "PAGE_DISCONNECTED":
        connectionState = "disconnected";
        renderAll();
        break;
      case "SNAPSHOT":
        stopHandshakeRetry();
        connectionState = "connected";
        snapshot = msg.snapshot;
        if (
          selectedNodeId !== null &&
          !snapshot.nodes.some((n) => n.id === selectedNodeId)
        ) {
          selectedNodeId = null;
        }
        if (
          filter.focusSubgraphNodeId !== null &&
          !snapshot.nodes.some((n) => n.id === filter.focusSubgraphNodeId)
        ) {
          filter = { ...filter, focusSubgraphNodeId: null };
        }
        renderAll();
        break;
      case "ACTION_RESULT":
        handleActionResult(msg.requestId, msg.result);
        break;
      case "SYNC_SELECTED_ELEMENT":
        selectedNodeId = msg.nodeId;
        setActiveTab("inspector");
        renderAll();
        graphView.centerOnNode(msg.nodeId);
        break;
      case "PONG":
        break;
    }
  };

  const unsubscribe = transport.onMessage(onTransportMessage);

  // Wire search controls
  searchInput.addEventListener("input", () => {
    applyQueryUpdate(searchInput.value, {
      resetMatch: true,
      fit: filter.queryMode === "filter",
    });
  });

  searchInput.addEventListener("keydown", (evt) => {
    if (evt.ctrlKey || evt.metaKey || evt.altKey) return;
    if (evt.key === "Enter") {
      evt.preventDefault();
      stepSearchMatch(evt.shiftKey ? -1 : 1);
    } else if (evt.key === "Escape") {
      if (searchInput.value.length > 0) {
        evt.preventDefault();
        clearSearch();
      } else {
        searchInput.blur();
      }
    }
  });

  searchModeBtn.addEventListener("click", () => {
    filter = {
      ...filter,
      queryMode: filter.queryMode === "highlight" ? "filter" : "highlight",
    };
    renderAll();
    graphView.fit();
  });

  searchPrevBtn.addEventListener("click", () => stepSearchMatch(-1));
  searchNextBtn.addEventListener("click", () => stepSearchMatch(1));
  searchClearBtn.addEventListener("click", () => {
    clearSearch();
    searchInput.focus();
  });

  // Wire Tags popover
  tagsFilterBtn.addEventListener("click", () => {
    if (tagsPopover.hidden) {
      openTagsPopover();
    } else {
      closeTagsPopover();
    }
  });

  tagsPopover.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape") {
      evt.preventDefault();
      evt.stopPropagation();
      closeTagsPopover();
      tagsFilterBtn.focus();
    }
  });

  const onDocumentPointerDown = (evt: PointerEvent): void => {
    if (tagsPopover.hidden) return;
    const target = evt.target;
    if (target instanceof Node && !tagsDropdownWrap.contains(target)) {
      closeTagsPopover();
    }
  };
  document.addEventListener("pointerdown", onDocumentPointerDown);

  // Wire toolbar filter controls
  kindFilterGroup.addEventListener("click", (evt) => {
    const target = evt.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest<HTMLButtonElement>("button[data-kind]");
    const kind = btn?.dataset.kind;
    if (!kind || !isKindFilter(kind)) return;
    filter = { ...filter, kindFilter: kind };
    renderAll();
    graphView.fit();
  });

  connectedOnlyBtn.addEventListener("click", () => {
    filter = { ...filter, connectedOnly: !filter.connectedOnly };
    renderAll();
    graphView.fit();
  });

  onlyErrorsBtn.addEventListener("click", () => {
    filter = { ...filter, onlyErrors: !filter.onlyErrors };
    renderAll();
    graphView.fit();
  });

  clearFocusBtn.addEventListener("click", () => {
    filter = { ...filter, focusSubgraphNodeId: null };
    renderAll();
    graphView.fit();
  });

  pauseBtn.addEventListener("click", () => {
    const nextPaused = !(snapshot?.settings.paused ?? false);
    transport.send({
      type: "CONFIGURE_HOOK",
      settings: { paused: nextPaused },
    });
  });

  memoHitsBtn.addEventListener("click", () => {
    const nextHits = !(snapshot?.settings.captureMemoHits ?? false);
    transport.send({
      type: "CONFIGURE_HOOK",
      settings: { captureMemoHits: nextHits },
    });
  });

  eventsBtn.addEventListener("click", () => {
    const nextEvents = !(snapshot?.settings.captureCustomEvents ?? true);
    transport.send({
      type: "CONFIGURE_HOOK",
      settings: { captureCustomEvents: nextEvents },
    });
  });

  const triggerScanDom = (): void => {
    transport.send({ type: "SCAN_DOM" });
    showToast("Scanning DOM & shadow roots…");
  };
  scanDomBtn.addEventListener("click", triggerScanDom);
  emptyScanBtn.addEventListener("click", triggerScanDom);

  emptyResetBtn.addEventListener("click", () => {
    filter = {
      ...DEFAULT_FILTER_STATE,
      expandedMemoOwnerIds: new Set(),
    };
    searchInput.value = "";
    activeMatchIndex = -1;
    activeSearchMatchId = null;
    closeTagsPopover();
    renderAll();
    graphView.fit();
  });

  syncElementsBtn.addEventListener("click", () => {
    void transport.syncFromElementsSelection().then((nodeId) => {
      if (nodeId !== null) {
        selectedNodeId = nodeId;
        setActiveTab("inspector");
        renderAll();
        graphView.centerOnNode(nodeId);
        showToast("Synced selection from $0");
      } else {
        showToast("No Lit element selected as $0");
      }
    });
  });

  fitGraphBtn.addEventListener("click", () => graphView.fit());
  hudFitBtn.addEventListener("click", () => graphView.fit());
  zoomInBtn.addEventListener("click", () => graphView.zoomIn());
  zoomOutBtn.addEventListener("click", () => graphView.zoomOut());

  restoreBottomBtn.addEventListener("click", () => {
    paneLayout?.setBottomCollapsed(false);
  });

  themeBtn.addEventListener("click", () => {
    themeController.cycle();
  });

  tabInspectorBtn.addEventListener("click", () => setActiveTab("inspector"));
  tabWaterfallBtn.addEventListener("click", () => setActiveTab("waterfall"));

  const disposeShortcuts = registerPanelShortcuts(window, {
    onSearch: () => {
      searchInput.focus();
      searchInput.select();
    },
    onEscape: () => {
      if (!tagsPopover.hidden) {
        closeTagsPopover();
        return true;
      }
      if (filter.focusSubgraphNodeId !== null) {
        filter = { ...filter, focusSubgraphNodeId: null };
        renderAll();
        return true;
      }
      if (selectedNodeId !== null) {
        selectedNodeId = null;
        renderAll();
        return true;
      }
      return false;
    },
    onFit: () => graphView.fit(),
    onZoomIn: () => graphView.zoomIn(),
    onZoomOut: () => graphView.zoomOut(),
  });

  const handleDevtoolsSearch = (action: string, query?: string): void => {
    switch (action) {
      case "performSearch": {
        applyQueryUpdate(query ?? "", {
          resetMatch: true,
          fit: filter.queryMode === "filter",
        });
        if (filter.queryMode === "highlight" && activeSearchMatchId !== null) {
          graphView.centerOnNode(activeSearchMatchId);
        }
        break;
      }
      case "nextSearchResult":
        stepSearchMatch(1);
        break;
      case "previousSearchResult":
        stepSearchMatch(-1);
        break;
      case "cancelSearch":
        clearSearch();
        break;
    }
  };

  Reflect.set(window, "__LIT_FLOW_ON_SEARCH__", handleDevtoolsSearch);

  const pendingSearchRaw: unknown = Reflect.get(
    window,
    "__LIT_FLOW_PENDING_SEARCH__",
  );
  if (pendingSearchRaw !== null && typeof pendingSearchRaw === "object") {
    const action: unknown = Reflect.get(pendingSearchRaw, "action");
    const queryString: unknown = Reflect.get(pendingSearchRaw, "queryString");
    Reflect.deleteProperty(window, "__LIT_FLOW_PENDING_SEARCH__");
    if (typeof action === "string") {
      handleDevtoolsSearch(
        action,
        typeof queryString === "string" ? queryString : undefined,
      );
    }
  }

  const cleanup = (): void => {
    stopHandshakeRetry();
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    disposeShortcuts();
    document.removeEventListener("pointerdown", onDocumentPointerDown);
    Reflect.deleteProperty(window, "__LIT_FLOW_ON_SEARCH__");
    themeController.dispose();
    paneLayout?.dispose();
    sendHoverHighlight(null);
    unsubscribe();
    graphView.dispose();
    transport.dispose();
  };

  window.addEventListener("pagehide", cleanup);

  // Initial paint + resilient bootstrap handshake
  setActiveTab("inspector");
  renderAll();

  transport.send({ type: "START_INSPECTION" });
  handshakeTimer = setInterval(() => {
    handshakeAttempts += 1;
    if (snapshot !== null || handshakeAttempts >= 15) {
      stopHandshakeRetry();
      return;
    }
    transport.send({ type: "START_INSPECTION" });
  }, 200);
}

bootstrapPanel();
