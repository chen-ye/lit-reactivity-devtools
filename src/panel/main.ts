import type {
  ActionResult,
  BackgroundToPanelMessage,
  GraphSnapshot,
  NodeKind,
} from "../protocol/types.ts";
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
type ThemePreference = "auto" | "dark" | "light";
type DrawerTab = "inspector" | "waterfall";

type PendingRequest =
  | {
      readonly kind: "set-property";
      readonly nodeId: number;
      readonly propName: string;
    }
  | { readonly kind: "clear-memo"; readonly nodeId: number };

const THEME_STORAGE_KEY = "lit-flow-theme";
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

function readStoredTheme(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "dark" || raw === "light" || raw === "auto") {
      return raw;
    }
  } catch {
    // Storage may be unavailable in restricted contexts
  }
  return "auto";
}

function writeStoredTheme(pref: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Ignore storage write errors
  }
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
  const connectionStatusEl = mustEl("connection-status", HTMLSpanElement);
  const connectionStatusTextEl = mustEl(
    "connection-status-text",
    HTMLSpanElement,
  );
  const searchInput = mustEl("search-input", HTMLInputElement);
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
  let filter: PanelFilterState = { ...DEFAULT_FILTER_STATE };
  let selectedNodeId: number | null = null;
  let connectionState: ConnectionState = "connecting";
  let connectedUrl: string | null = null;
  let themePreference: ThemePreference = readStoredTheme();
  let activeTab: DrawerTab = "inspector";
  let requestCounter = 0;
  let lastHighlightedNodeId: number | null = null;
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

  const applyTheme = (): void => {
    if (themePreference === "auto") {
      const devtoolsTheme = transport.getDevToolsTheme();
      if (devtoolsTheme) {
        document.documentElement.dataset.theme = devtoolsTheme;
      } else {
        delete document.documentElement.dataset.theme;
      }
      themeBtn.textContent = "Theme: Auto";
    } else if (themePreference === "dark") {
      document.documentElement.dataset.theme = "dark";
      themeBtn.textContent = "Theme: Dark";
    } else {
      document.documentElement.dataset.theme = "light";
      themeBtn.textContent = "Theme: Light";
    }
  };

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
  });

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
  });

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
    updateConnectionStatus();
    updateToolbarControls(vm);
    updateEmptyState(vm);
    graphView.render(vm);
    inspectorView.render(vm);
    waterfallView.render(
      vm,
      filter.traceCategory,
      filter.followSelectionInTraces,
    );
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

  // Wire toolbar controls
  searchInput.addEventListener("input", () => {
    filter = { ...filter, query: searchInput.value };
    renderAll();
    graphView.fit();
  });

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
    filter = { ...DEFAULT_FILTER_STATE };
    searchInput.value = "";
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

  themeBtn.addEventListener("click", () => {
    themePreference =
      themePreference === "auto"
        ? "dark"
        : themePreference === "dark"
          ? "light"
          : "auto";
    writeStoredTheme(themePreference);
    applyTheme();
  });

  tabInspectorBtn.addEventListener("click", () => setActiveTab("inspector"));
  tabWaterfallBtn.addEventListener("click", () => setActiveTab("waterfall"));

  const onKeyDown = (evt: KeyboardEvent) => {
    if (evt.defaultPrevented) return;
    const active = document.activeElement;
    const isTyping =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement;

    if (
      evt.key === "/" &&
      !isTyping &&
      !evt.metaKey &&
      !evt.ctrlKey &&
      !evt.altKey
    ) {
      evt.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (
      evt.key === "Escape" &&
      !isTyping &&
      filter.focusSubgraphNodeId !== null
    ) {
      evt.preventDefault();
      filter = { ...filter, focusSubgraphNodeId: null };
      renderAll();
    }
  };
  window.addEventListener("keydown", onKeyDown);

  const colorSchemeMedia = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onColorSchemeChange = () => {
    if (themePreference === "auto") applyTheme();
  };
  colorSchemeMedia?.addEventListener("change", onColorSchemeChange);

  const cleanup = (): void => {
    stopHandshakeRetry();
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    window.removeEventListener("keydown", onKeyDown);
    colorSchemeMedia?.removeEventListener("change", onColorSchemeChange);
    sendHoverHighlight(null);
    unsubscribe();
    graphView.dispose();
    transport.dispose();
  };

  window.addEventListener("pagehide", cleanup);

  // Initial paint + resilient bootstrap handshake
  applyTheme();
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
