import {
  BRIDGE_CHANNEL,
  isValidActionResult,
  isValidGraphSnapshot,
  isValidPanelToPageMessage,
  type PageToPanelMessage,
} from "../protocol/types.ts";
import { startIsolatedBridge } from "../shared/isolated-bridge.ts";

function isValidPageToPanelMessage(
  value: unknown,
): value is PageToPanelMessage {
  if (value === null || typeof value !== "object") return false;
  const type = Reflect.get(value, "type");
  if (type === "SNAPSHOT") {
    return isValidGraphSnapshot(Reflect.get(value, "snapshot"));
  }
  if (type === "ACTION_RESULT") {
    return (
      typeof Reflect.get(value, "requestId") === "string" &&
      isValidActionResult(Reflect.get(value, "result"))
    );
  }
  if (type === "SYNC_SELECTED_ELEMENT") {
    return typeof Reflect.get(value, "nodeId") === "number";
  }
  return false;
}

startIsolatedBridge({
  channel: BRIDGE_CHANNEL,
  isValidPageToPanelMessage,
  isValidPanelToPageMessage,
  shouldForwardToBackground: (payload, inspectionActive) =>
    inspectionActive || payload.type === "SYNC_SELECTED_ELEMENT",
  wakeOnRuntimeMessage: true,
  handlePrerenderingChange: true,
});
