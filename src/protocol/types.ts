export type NodeKind =
  "model" | "controller" | "context" | "element" | "computed" | "observer";

export type EdgeKind =
  | "model-to-controller"
  | "controller-to-element"
  | "prop-flow"
  | "context-provide"
  | "context-consume"
  | "memo-compute"
  | "memo-observe"
  | "event-emit";

export type TraceKind =
  | "model-update"
  | "controller-transform"
  | "context-push"
  | "prop-change"
  | "render"
  | "veto"
  | "memo-miss"
  | "memo-hit"
  | "custom-event"
  | "connect"
  | "error";

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly fn: string | null;
}

export type PreviewKind =
  | "undefined"
  | "null"
  | "boolean"
  | "number"
  | "string"
  | "bigint"
  | "symbol"
  | "function"
  | "array"
  | "object"
  | "map"
  | "set"
  | "date"
  | "regexp"
  | "error"
  | "element"
  | "circular"
  | "unreadable";

export interface ValuePreview {
  readonly kind: PreviewKind;
  readonly text: string;
  readonly entries?: ReadonlyArray<readonly [string, string]>;
  readonly truncated?: boolean;
}

export interface ReactivePropertySnapshot {
  readonly name: string;
  readonly isState: boolean;
  readonly reflect: boolean;
  readonly attribute: string | null;
  readonly typeName: string | null;
  readonly value: ValuePreview;
  readonly prevValue: ValuePreview | null;
  readonly changes: number;
  readonly lastChangedSeq: number;
  readonly sourceLabel: string | null;
}

export interface ReactivityNodeSnapshot {
  readonly id: number;
  readonly kind: NodeKind;
  readonly label: string;
  readonly subtitle: string | null;
  readonly site: SourceLocation | null;
  readonly connected: boolean;
  readonly updates: number;
  readonly hits: number;
  readonly misses: number;
  readonly vetoes: number;
  readonly lastDurationMs: number | null;
  readonly lastChangedSeq: number;
  readonly lastCauseLabel: string | null;
  readonly lastCauseNodeId: number | null;
  readonly value: ValuePreview | null;
  readonly error: string | null;
  readonly rootType?: "shadow" | "light" | "closed-shadow";
  readonly properties?: ReadonlyArray<ReactivePropertySnapshot>;
  readonly lastArgs?: ReadonlyArray<ValuePreview>;
}

export interface ReactivityEdgeSnapshot {
  readonly id: string;
  readonly sourceId: number;
  readonly targetId: number;
  readonly kind: EdgeKind;
  readonly label: string | null;
  readonly count: number;
  readonly lastSeq: number;
  readonly lastDetail: string | null;
}

export interface TraceEvent {
  readonly seq: number;
  readonly cascadeId: number;
  readonly timestamp: number;
  readonly durationMs: number;
  readonly nodeId: number;
  readonly kind: TraceKind;
  readonly label: string;
  readonly causeNodeId: number | null;
  readonly detail: string | null;
}

export interface HookSettings {
  readonly paused: boolean;
  readonly captureMemoHits: boolean;
  readonly captureCustomEvents: boolean;
}

export interface GraphSnapshot {
  readonly version: 1;
  readonly seq: number;
  readonly baseSeq: number;
  readonly droppedEvents: number;
  readonly litVersions: ReadonlyArray<string>;
  readonly settings: HookSettings;
  readonly nodes: ReadonlyArray<ReactivityNodeSnapshot>;
  readonly edges: ReadonlyArray<ReactivityEdgeSnapshot>;
  readonly events: ReadonlyArray<TraceEvent>;
}

export type ActionResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface RegisterEntityOptions {
  readonly name?: string;
  readonly initialValue?: unknown;
}

export interface LitDevtoolsHook {
  readonly version: 1;
  registerModel<T extends object>(model: T, options?: RegisterEntityOptions): T;
  registerController<T extends object>(
    controller: T,
    options?: RegisterEntityOptions & {
      readonly host?: object;
      readonly model?: object;
    },
  ): T;
  label<T extends object>(target: T, name: string): T;
  traceMemoized<T extends (...args: never[]) => unknown>(
    fn: T,
    owner: object,
    name: string,
    role?: "computed" | "observer",
  ): T;
  scanDom(): void;
  snapshot(sinceSeq?: number): GraphSnapshot;
  setProperty(nodeId: number, propName: string, jsonText: string): ActionResult;
  clearMemoCache(nodeId: number): ActionResult;
  logToConsole(nodeId: number): ActionResult;
  highlightElement(nodeId: number | null): void;
  getElementById(nodeId: number): Element | null;
  selectElementFromElementsPanel(el: Element | null): number | null;
  configure(settings: Partial<HookSettings>): void;
  clearEvents(): void;
  subscribe(listener: () => void): () => void;
}

export type PanelToPageMessage =
  | { readonly type: "START_INSPECTION" }
  | { readonly type: "STOP_INSPECTION" }
  | { readonly type: "REQUEST_SNAPSHOT" }
  | { readonly type: "SCAN_DOM" }
  | {
      readonly type: "SET_PROPERTY";
      readonly nodeId: number;
      readonly propName: string;
      readonly jsonText: string;
      readonly requestId: string;
    }
  | {
      readonly type: "CLEAR_MEMO_CACHE";
      readonly nodeId: number;
      readonly requestId: string;
    }
  | { readonly type: "LOG_NODE"; readonly nodeId: number }
  | { readonly type: "HIGHLIGHT_ELEMENT"; readonly nodeId: number | null }
  | {
      readonly type: "CONFIGURE_HOOK";
      readonly settings: Partial<HookSettings>;
    }
  | { readonly type: "CLEAR_EVENTS" };

export type PageToPanelMessage =
  | { readonly type: "SNAPSHOT"; readonly snapshot: GraphSnapshot }
  | {
      readonly type: "ACTION_RESULT";
      readonly requestId: string;
      readonly result: ActionResult;
    }
  | { readonly type: "SYNC_SELECTED_ELEMENT"; readonly nodeId: number };

export type PanelToBackgroundMessage =
  PanelToPageMessage | { readonly type: "PING" };

export type BackgroundToPanelMessage =
  | PageToPanelMessage
  | { readonly type: "PAGE_CONNECTED"; readonly url: string | null }
  | { readonly type: "PAGE_NAVIGATING"; readonly url: string }
  | { readonly type: "PAGE_DISCONNECTED" }
  | { readonly type: "PONG" };

export type IsolatedToBackgroundMessage =
  PageToPanelMessage | { readonly type: "BRIDGE_READY"; readonly url: string };

export const BRIDGE_CHANNEL = "lit-reactivity-devtools" as const;

export interface WindowBridgeEnvelope<T> {
  readonly channel: typeof BRIDGE_CHANNEL;
  readonly direction: "main-to-isolated" | "isolated-to-main";
  readonly payload: T;
}

export function isValidSetPropertyName(propName: string): boolean {
  return (
    propName !== "__proto__" &&
    propName !== "constructor" &&
    propName !== "prototype"
  );
}

export function isValidPanelToPageMessage(
  value: unknown,
): value is PanelToPageMessage {
  if (value === null || typeof value !== "object") return false;
  const type = Reflect.get(value, "type");
  switch (type) {
    case "START_INSPECTION":
    case "STOP_INSPECTION":
    case "REQUEST_SNAPSHOT":
    case "SCAN_DOM":
    case "CLEAR_EVENTS":
      return true;
    case "SET_PROPERTY":
      return (
        typeof Reflect.get(value, "nodeId") === "number" &&
        typeof Reflect.get(value, "propName") === "string" &&
        isValidSetPropertyName(String(Reflect.get(value, "propName"))) &&
        typeof Reflect.get(value, "jsonText") === "string" &&
        typeof Reflect.get(value, "requestId") === "string"
      );
    case "CLEAR_MEMO_CACHE":
      return (
        typeof Reflect.get(value, "nodeId") === "number" &&
        typeof Reflect.get(value, "requestId") === "string"
      );
    case "LOG_NODE":
      return typeof Reflect.get(value, "nodeId") === "number";
    case "HIGHLIGHT_ELEMENT": {
      const nodeId: unknown = Reflect.get(value, "nodeId");
      return nodeId === null || typeof nodeId === "number";
    }
    case "CONFIGURE_HOOK": {
      const settings: unknown = Reflect.get(value, "settings");
      return settings !== null && typeof settings === "object";
    }
    default:
      return false;
  }
}

export function isValidGraphSnapshot(value: unknown): value is GraphSnapshot {
  if (value === null || typeof value !== "object") return false;
  if (Reflect.get(value, "version") !== 1) return false;
  if (typeof Reflect.get(value, "seq") !== "number") return false;
  const settings: unknown = Reflect.get(value, "settings");
  if (settings === null || typeof settings !== "object") return false;
  if (typeof Reflect.get(settings, "paused") !== "boolean") return false;
  if (typeof Reflect.get(settings, "captureMemoHits") !== "boolean")
    return false;
  if (typeof Reflect.get(settings, "captureCustomEvents") !== "boolean")
    return false;
  return (
    Array.isArray(Reflect.get(value, "litVersions")) &&
    Array.isArray(Reflect.get(value, "nodes")) &&
    Array.isArray(Reflect.get(value, "edges")) &&
    Array.isArray(Reflect.get(value, "events"))
  );
}

export function isValidActionResult(value: unknown): value is ActionResult {
  if (value === null || typeof value !== "object") return false;
  const ok = Reflect.get(value, "ok");
  if (ok === true) return true;
  return ok === false && typeof Reflect.get(value, "error") === "string";
}
