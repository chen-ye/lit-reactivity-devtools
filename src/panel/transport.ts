import {
  BRIDGE_CHANNEL,
  isValidActionResult,
  isValidGraphSnapshot,
  type ActionResult,
  type BackgroundToPanelMessage,
  type PanelToBackgroundMessage,
  type SourceLocation,
} from "../protocol/types.ts";
import {
  createBasePanelTransport,
  isChromeDevToolsContext,
  type BasePanelTransport,
  type PanelTransportMode,
} from "../shared/panel-transport.ts";
import { openSourceLocation } from "../shared/source-jump.ts";

export { isChromeDevToolsContext };

export interface PanelTransport extends BasePanelTransport<
  BackgroundToPanelMessage,
  PanelToBackgroundMessage
> {
  revealInElements(nodeId: number): void;
  syncFromElementsSelection(): Promise<number | null>;
  openSource(
    nodeId: number,
    site: SourceLocation | null,
    propName?: string | null,
  ): Promise<ActionResult>;
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

function createLitPanelTransport(mode?: PanelTransportMode): PanelTransport {
  const base = createBasePanelTransport<
    BackgroundToPanelMessage,
    PanelToBackgroundMessage
  >({
    channel: BRIDGE_CHANNEL,
    isIncomingMessage: isBackgroundMessage,
    mode,
    pingMessage: { type: "PING" },
    initialBridgeMessage: { type: "START_INSPECTION" },
    createNavigatedMessage: (url) => ({ type: "PAGE_NAVIGATING", url }),
  });

  if (base.mode === "devtools") {
    return {
      ...base,
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
      openSource(nodeId, site, propName) {
        const validNodeId = Number.isSafeInteger(nodeId) && nodeId >= 1;
        const propArg =
          typeof propName === "string" && propName.length > 0
            ? JSON.stringify(propName)
            : "null";
        const evalInspectTargetExpr = validNodeId
          ? `globalThis.__LIT_DEVTOOLS_HOOK__?.getDefinitionTarget?.(${nodeId}, ${propArg})`
          : undefined;
        return openSourceLocation({
          mode: "devtools",
          site,
          evalInspectTargetExpr,
        });
      },
    };
  }

  return {
    ...base,
    revealInElements() {},
    async syncFromElementsSelection() {
      return null;
    },
    openSource(_nodeId, site) {
      return openSourceLocation({
        mode: "bridge",
        site,
      });
    },
  };
}

export function createChromeDevtoolsTransport(): PanelTransport {
  return createLitPanelTransport("devtools");
}

export function createWindowBridgeTransport(): PanelTransport {
  return createLitPanelTransport("bridge");
}

export function createPanelTransport(): PanelTransport {
  return createLitPanelTransport();
}
