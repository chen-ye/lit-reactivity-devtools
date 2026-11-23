import {
  BRIDGE_CHANNEL,
  isValidActionResult,
  isValidGraphSnapshot,
  type BackgroundToPanelMessage,
  type PanelToBackgroundMessage,
} from "../protocol/types.ts";

export interface PanelTransport {
  readonly mode: "devtools" | "bridge";
  send(message: PanelToBackgroundMessage): void;
  onMessage(listener: (message: BackgroundToPanelMessage) => void): () => void;
  revealInElements(nodeId: number): void;
  syncFromElementsSelection(): Promise<number | null>;
  getDevToolsTheme(): "light" | "dark" | null;
  dispose(): void;
}

function isBackgroundMessage(
  value: unknown,
): value is BackgroundToPanelMessage {
  if (value === null || typeof value !== "object") return false;
  const type = Reflect.get(value, "type");
  switch (type) {
    case "SNAPSHOT":
      return isValidGraphSnapshot(Reflect.get(value, "snapshot"));
    case "ACTION_RESULT":
      return (
        typeof Reflect.get(value, "requestId") === "string" &&
        isValidActionResult(Reflect.get(value, "result"))
      );
    case "SYNC_SELECTED_ELEMENT":
      return typeof Reflect.get(value, "nodeId") === "number";
    case "PAGE_CONNECTED":
      return (
        Reflect.get(value, "url") === null ||
        typeof Reflect.get(value, "url") === "string"
      );
    case "PAGE_NAVIGATING":
      return typeof Reflect.get(value, "url") === "string";
    case "PAGE_DISCONNECTED":
    case "PONG":
      return true;
    default:
      return false;
  }
}

export function isChromeDevToolsContext(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.devtools !== "undefined" &&
    typeof chrome.devtools.inspectedWindow?.tabId === "number"
  );
}

export function createChromeDevtoolsTransport(): PanelTransport {
  const tabId = chrome.devtools.inspectedWindow.tabId;
  const listeners = new Set<(message: BackgroundToPanelMessage) => void>();
  let port: chrome.runtime.Port | null = null;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const emit = (msg: BackgroundToPanelMessage) => {
    for (const listener of listeners) {
      listener(msg);
    }
  };

  const connect = () => {
    if (disposed) return;
    const nextPort = chrome.runtime.connect({ name: `devtools:${tabId}` });
    port = nextPort;

    nextPort.onMessage.addListener((raw: unknown) => {
      if (isBackgroundMessage(raw)) {
        emit(raw);
      }
    });

    nextPort.onDisconnect.addListener(() => {
      if (port === nextPort) {
        port = null;
      }
      if (!disposed && reconnectTimer === null) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 250);
      }
    });
  };

  queueMicrotask(connect);

  heartbeatTimer = setInterval(() => {
    if (port && !disposed) {
      try {
        port.postMessage({ type: "PING" } satisfies PanelToBackgroundMessage);
      } catch {
        // Ignore transient disconnect
      }
    }
  }, 18_000);

  const onNavigated = (url: string) => {
    emit({ type: "PAGE_NAVIGATING", url });
  };
  chrome.devtools.network?.onNavigated?.addListener(onNavigated);

  return {
    mode: "devtools",
    send(message) {
      if (disposed) return;
      if (!port) connect();
      try {
        port?.postMessage(message);
      } catch {
        port = null;
        connect();
      }
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    revealInElements(nodeId) {
      if (!Number.isSafeInteger(nodeId) || nodeId < 1) return;
      chrome.devtools.inspectedWindow.eval(
        `(() => { const el = globalThis.__LIT_DEVTOOLS_HOOK__?.getElementById(${nodeId}); if (el) inspect(el); })()`,
      );
    },
    syncFromElementsSelection() {
      return new Promise<number | null>((resolve) => {
        chrome.devtools.inspectedWindow.eval(
          "globalThis.__LIT_DEVTOOLS_HOOK__?.selectElementFromElementsPanel($0) ?? null",
          (result, exceptionInfo) => {
            if (exceptionInfo?.isException || typeof result !== "number") {
              resolve(null);
            } else {
              resolve(result);
            }
          },
        );
      });
    },
    getDevToolsTheme() {
      const theme = chrome.devtools.panels.themeName;
      return theme === "dark" ? "dark" : "light";
    },
    dispose() {
      disposed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      chrome.devtools.network?.onNavigated?.removeListener(onNavigated);
      port?.disconnect();
      port = null;
      listeners.clear();
    },
  };
}

export function createWindowBridgeTransport(): PanelTransport {
  const listeners = new Set<(message: BackgroundToPanelMessage) => void>();
  const target: Window | null =
    window.opener ?? (window.parent !== window ? window.parent : null);

  const onWindowMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    if (target && event.source !== target) return;
    if (!target && event.source !== window) return;
    const data: unknown = event.data;
    if (data === null || typeof data !== "object") return;
    if (Reflect.get(data, "channel") !== BRIDGE_CHANNEL) return;
    if (Reflect.get(data, "direction") !== "host-to-panel") return;
    const payload: unknown = Reflect.get(data, "payload");
    if (isBackgroundMessage(payload)) {
      for (const listener of listeners) {
        listener(payload);
      }
    }
  };

  window.addEventListener("message", onWindowMessage);

  const postToHost = (message: PanelToBackgroundMessage) => {
    target?.postMessage(
      {
        channel: BRIDGE_CHANNEL,
        direction: "panel-to-host",
        payload: message,
      },
      window.location.origin,
    );
  };

  postToHost({ type: "START_INSPECTION" });

  return {
    mode: "bridge",
    send(message) {
      postToHost(message);
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    revealInElements() {},
    async syncFromElementsSelection() {
      return null;
    },
    getDevToolsTheme() {
      return null;
    },
    dispose() {
      window.removeEventListener("message", onWindowMessage);
      listeners.clear();
    },
  };
}

export function createPanelTransport(): PanelTransport {
  return isChromeDevToolsContext()
    ? createChromeDevtoolsTransport()
    : createWindowBridgeTransport();
}
