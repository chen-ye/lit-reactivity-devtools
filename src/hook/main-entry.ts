import {
  BRIDGE_CHANNEL,
  isValidPanelToPageMessage,
  type PageToPanelMessage,
  type PanelToPageMessage,
  type WindowBridgeEnvelope,
} from "../protocol/types.ts";
import { getOrInstallGlobalHook } from "./hook.ts";

const hook = getOrInstallGlobalHook({ traceInitially: false });

const STREAM_THROTTLE_MS = 160;

let inspectionActive = false;
let unsubscribeHook: (() => void) | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastStreamPushAt = 0;

function setTrackerRecording(active: boolean): void {
  const toggle: unknown = Reflect.get(hook, "__setTraceRecording");
  if (typeof toggle === "function") {
    Reflect.apply(toggle, hook, [active]);
  }
}

function postToIsolated(payload: PageToPanelMessage): void {
  const envelope: WindowBridgeEnvelope<PageToPanelMessage> = {
    channel: BRIDGE_CHANNEL,
    direction: "main-to-isolated",
    payload,
  };
  window.postMessage(envelope, "*");
}

function pushSnapshotNow(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  lastStreamPushAt = performance.now();
  postToIsolated({ type: "SNAPSHOT", snapshot: hook.snapshot() });
}

function scheduleSnapshotPush(): void {
  if (!inspectionActive || flushTimer !== null) return;
  const elapsed = performance.now() - lastStreamPushAt;
  const delay =
    elapsed >= STREAM_THROTTLE_MS ? 45 : STREAM_THROTTLE_MS - elapsed;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!inspectionActive) return;
    lastStreamPushAt = performance.now();
    postToIsolated({ type: "SNAPSHOT", snapshot: hook.snapshot() });
  }, delay);
}

function startInspection(): void {
  setTrackerRecording(true);
  hook.scanDom();
  if (!inspectionActive) {
    inspectionActive = true;
    unsubscribeHook = hook.subscribe(() => {
      scheduleSnapshotPush();
    });
  }
  pushSnapshotNow();
}

function stopInspection(): void {
  inspectionActive = false;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  unsubscribeHook?.();
  unsubscribeHook = null;
  hook.highlightElement(null);
}

function isIsolatedEnvelope(
  data: unknown,
): data is WindowBridgeEnvelope<PanelToPageMessage> {
  if (data === null || typeof data !== "object") return false;
  if (Reflect.get(data, "channel") !== BRIDGE_CHANNEL) return false;
  if (Reflect.get(data, "direction") !== "isolated-to-main") return false;
  return isValidPanelToPageMessage(Reflect.get(data, "payload"));
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  if (!isIsolatedEnvelope(event.data)) return;

  const msg = event.data.payload;
  switch (msg.type) {
    case "START_INSPECTION":
      startInspection();
      break;
    case "STOP_INSPECTION":
      stopInspection();
      break;
    case "REQUEST_SNAPSHOT":
      pushSnapshotNow();
      break;
    case "SCAN_DOM":
      hook.scanDom();
      pushSnapshotNow();
      break;
    case "SET_PROPERTY": {
      const result = hook.setProperty(msg.nodeId, msg.propName, msg.jsonText);
      postToIsolated({
        type: "ACTION_RESULT",
        requestId: msg.requestId,
        result,
      });
      pushSnapshotNow();
      break;
    }
    case "CLEAR_MEMO_CACHE": {
      const result = hook.clearMemoCache(msg.nodeId);
      postToIsolated({
        type: "ACTION_RESULT",
        requestId: msg.requestId,
        result,
      });
      pushSnapshotNow();
      break;
    }
    case "LOG_NODE":
      hook.logToConsole(msg.nodeId);
      break;
    case "HIGHLIGHT_ELEMENT":
      hook.highlightElement(msg.nodeId);
      break;
    case "CONFIGURE_HOOK":
      hook.configure(msg.settings);
      pushSnapshotNow();
      break;
    case "CLEAR_EVENTS":
      hook.clearEvents();
      pushSnapshotNow();
      break;
  }
});
