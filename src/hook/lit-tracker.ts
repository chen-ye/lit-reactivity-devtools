import type {
  ActionResult,
  EdgeKind,
  GraphSnapshot,
  HookSettings,
  NodeKind,
  ReactivePropertySnapshot,
  ReactivityEdgeSnapshot,
  ReactivityNodeSnapshot,
  RegisterEntityOptions,
  SourceLocation,
  TraceEvent,
  ValuePreview,
} from "../protocol/types.ts";
import { isValidSetPropertyName } from "../protocol/types.ts";
import {
  inferMemoRole,
  isMemoizeOneFunction,
  wrapMemoizedFunction,
  type MemoizedFunctionLike,
} from "./memo-tracker.ts";
import { formatErrorMessage, serializePreview } from "./preview.ts";
import { captureCallsite } from "./stack.ts";

const MAX_EVENTS = 400;
const MAX_CTOR_SOURCE_CHARS = 120_000;
const MAX_COMPUTE_SOURCE_CHARS = 1200;
const MAX_COMPUTE_SIGNATURE_CHARS = 120;
const MAX_DISAMBIGUATOR_TEXT_CHARS = 24;

const DISAMBIGUATOR_PROP_PRIORITY = [
  "key",
  "id",
  "ident",
  "code",
  "label",
  "title",
  "name",
  "text",
  "heading",
  "icon",
  "mode",
  "panel",
  "tab",
  "action",
  "command",
  "channel",
  "range",
  "rangeNm",
  "distance",
  "radius",
  "unit",
  "variant",
  "kind",
  "type",
  "index",
] as const;

const JS_NON_CALL_KEYWORDS = new Set([
  "new",
  "function",
  "async",
  "typeof",
  "return",
  "if",
  "while",
  "for",
  "switch",
  "catch",
  "await",
  "void",
  "delete",
  "throw",
]);

interface PropertyRecord {
  readonly name: string;
  readonly isState: boolean;
  readonly reflect: boolean;
  readonly attribute: string | null;
  readonly typeName: string | null;
  value: ValuePreview;
  prevValue: ValuePreview | null;
  changes: number;
  lastChangedSeq: number;
  sourceLabel: string | null;
}

interface NodeRecord {
  readonly id: number;
  readonly kind: NodeKind;
  readonly ref: WeakRef<object>;
  label: string;
  subtitle: string | null;
  site: SourceLocation | null;
  connected: boolean;
  ownerNodeId?: number;
  domParentNodeId?: number | undefined;
  tagName?: string;
  explicitLabel?: string;
  disambiguator?: string | null;
  lockedDisambiguator?: string | null;
  lockedDisambiguatorRank?: number | undefined;
  updates: number;
  hits: number;
  misses: number;
  vetoes: number;
  lastDurationMs: number | null;
  lastChangedSeq: number;
  lastCauseLabel: string | null;
  lastCauseNodeId: number | null;
  valuePreview: ValuePreview | null;
  error: string | null;
  rootType?: "shadow" | "light" | "closed-shadow";
  properties?: Map<string, PropertyRecord>;
  lastArgs?: ReadonlyArray<ValuePreview>;
  clearMemoFn?: () => void;
  computeSource?: string | null;
  computeSignature?: string | null;
  innerMemoFnRef?: WeakRef<(...args: never[]) => unknown>;
  providerHostRef?: WeakRef<object>;
}

interface EdgeRecord {
  readonly id: string;
  readonly sourceId: number;
  readonly targetId: number;
  readonly kind: EdgeKind;
  readonly label: string | null;
  count: number;
  lastSeq: number;
  lastDetail: string | null;
}

interface CausalFrame {
  readonly nodeId: number;
  readonly kind: NodeKind | "context-push";
  readonly label: string;
  readonly cascadeId: number;
  readonly phase?: string;
  readonly eventType?: string;
}

interface PendingCause {
  readonly causeNodeId: number | null;
  readonly cascadeId: number;
  readonly label: string;
}

interface ContextControllerMeta {
  readonly contextKey: unknown;
  readonly isProvider: boolean;
}

function highResTimestamp(): number {
  return performance.timeOrigin + performance.now();
}

function findControllerFieldName(
  host: object,
  controller: object,
): string | null {
  try {
    for (const key of Object.getOwnPropertyNames(host)) {
      if (key === "renderRoot" || key === "shadowRoot") continue;
      if (Reflect.get(host, key) === controller) {
        return key;
      }
    }
  } catch {
    // Ignore unreadable host properties
  }
  return null;
}

function getCtorName(obj: object): string {
  try {
    const proto: unknown = Object.getPrototypeOf(obj);
    if (proto !== null && typeof proto === "object") {
      const ctor: unknown = Reflect.get(proto, "constructor");
      if (typeof ctor === "function") {
        const name: unknown = Reflect.get(ctor, "name");
        if (typeof name === "string" && name.length > 0) return name;
      }
    }
  } catch {
    // Ignore prototype lookup errors
  }
  return "Object";
}

function formatContextKeyLabel(contextKey: unknown): string {
  if (typeof contextKey === "string") return contextKey;
  if (typeof contextKey === "symbol")
    return contextKey.description ?? contextKey.toString();
  if (typeof contextKey === "object" && contextKey !== null) {
    const name: unknown = Reflect.get(contextKey, "name");
    if (typeof name === "string" && name.length > 0) return name;
    return getCtorName(contextKey);
  }
  return String(contextKey);
}

function formatTypeName(declType: unknown): string | null {
  if (typeof declType === "function") {
    const name: unknown = Reflect.get(declType, "name");
    return typeof name === "string" && name.length > 0 ? name : null;
  }
  return null;
}

function safeReadProp(
  target: object,
  key: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: Reflect.get(target, key) };
  } catch {
    return { ok: false };
  }
}

function isCallableFn(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

function isNativeCodeFn(fn: unknown): boolean {
  if (!isCallableFn(fn)) return true;
  try {
    return Function.prototype.toString.call(fn).includes("[native code]");
  } catch {
    return true;
  }
}

function isUserConstructor(
  value: unknown,
): value is (...args: never[]) => unknown {
  if (typeof value !== "function") return false;
  const obj: object = value;
  if (obj === Object || obj === Function) return false;
  if (typeof HTMLElement !== "undefined" && obj === HTMLElement) return false;
  if (typeof EventTarget !== "undefined" && obj === EventTarget) return false;
  return true;
}

function isMemoizeOneWrapperSource(src: string): boolean {
  return (
    /\bcache\.lastThis\b/.test(src) || /\.lastThis\s*===\s*this\b/.test(src)
  );
}

function normalizeMemoSource(
  raw: string,
): { readonly source: string; readonly signature: string } | null {
  if (!raw || raw.includes("[native code]") || isMemoizeOneWrapperSource(raw)) {
    return null;
  }
  const normalized = raw.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return null;

  const lines = normalized.split("\n");
  let minIndent = Number.POSITIVE_INFINITY;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) continue;
    const match = /^[ \t]*/.exec(line);
    const indentLen = match ? match[0].length : 0;
    if (indentLen < minIndent) {
      minIndent = indentLen;
    }
  }

  const dedented =
    Number.isFinite(minIndent) && minIndent > 0
      ? [
          lines[0] ?? "",
          ...lines
            .slice(1)
            .map((line) =>
              line.trim().length === 0 ? "" : line.slice(minIndent),
            ),
        ].join("\n")
      : normalized;

  const source =
    dedented.length > MAX_COMPUTE_SOURCE_CHARS
      ? `${dedented.slice(0, MAX_COMPUTE_SOURCE_CHARS - 1)}…`
      : dedented;
  const collapsed = dedented.replace(/\s+/g, " ").trim();
  const signature =
    collapsed.length > MAX_COMPUTE_SIGNATURE_CHARS
      ? `${collapsed.slice(0, MAX_COMPUTE_SIGNATURE_CHARS - 1)}…`
      : collapsed;

  return { source, signature };
}

function skipQuotedString(
  src: string,
  startIdx: number,
  quote: string,
): number {
  let i = startIdx + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    i++;
  }
  return src.length;
}

function skipRegexLiteral(src: string, startIdx: number): number {
  let i = startIdx + 1;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      inClass = true;
    } else if (ch === "]" && inClass) {
      inClass = false;
    } else if (ch === "/" && !inClass) {
      return i + 1;
    } else if (ch === "\n") {
      return i + 1;
    }
    i++;
  }
  return src.length;
}

function skipComment(src: string, startIdx: number): number {
  if (src[startIdx] !== "/") return startIdx;
  if (src[startIdx + 1] === "/") {
    const nl = src.indexOf("\n", startIdx + 2);
    return nl === -1 ? src.length : nl + 1;
  }
  if (src[startIdx + 1] === "*") {
    const end = src.indexOf("*/", startIdx + 2);
    return end === -1 ? src.length : end + 2;
  }
  return startIdx;
}

function skipWsAndComments(src: string, startIdx: number): number {
  let i = startIdx;
  while (i < src.length) {
    const ch = src[i] ?? "";
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      i = skipComment(src, i);
      continue;
    }
    break;
  }
  return i;
}

function skipBraceBlock(src: string, startAfterOpenBrace: number): number {
  let i = startAfterOpenBrace;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const ch = src[i] ?? "";
    if (ch === "'" || ch === '"') {
      i = skipQuotedString(src, i, ch);
      continue;
    }
    if (ch === "`") {
      i = skipTemplateLiteral(src, i);
      continue;
    }
    if (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      i = skipComment(src, i);
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
    }
    i++;
  }
  return i;
}

function skipTemplateLiteral(src: string, tickIdx: number): number {
  let i = tickIdx + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      return i + 1;
    }
    if (ch === "$" && src[i + 1] === "{") {
      i = skipBraceBlock(src, i + 2);
      continue;
    }
    i++;
  }
  return src.length;
}

function scanFirstCallArg(src: string, openParenIdx: number): string | null {
  let i = skipWsAndComments(src, openParenIdx + 1);
  const argStart = i;
  let parenDepth = 1;
  let bracketDepth = 0;
  let braceDepth = 0;
  let prevNonWs = "(";

  while (i < src.length) {
    const ch = src[i] ?? "";
    if (ch === "'" || ch === '"') {
      i = skipQuotedString(src, i, ch);
      prevNonWs = ch;
      continue;
    }
    if (ch === "`") {
      i = skipTemplateLiteral(src, i);
      prevNonWs = "`";
      continue;
    }
    if (ch === "/") {
      if (src[i + 1] === "/" || src[i + 1] === "*") {
        i = skipComment(src, i);
        continue;
      }
      if ("(=,[!&|?:{};\n".includes(prevNonWs)) {
        i = skipRegexLiteral(src, i);
        prevNonWs = "/";
        continue;
      }
    }

    if (ch === "(") {
      parenDepth++;
    } else if (ch === ")") {
      parenDepth--;
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return src.slice(argStart, i).trim();
      }
    } else if (ch === "[") {
      bracketDepth++;
    } else if (ch === "]") {
      if (bracketDepth > 0) bracketDepth--;
    } else if (ch === "{") {
      braceDepth++;
    } else if (ch === "}") {
      if (braceDepth > 0) braceDepth--;
    } else if (
      ch === "," &&
      parenDepth === 1 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      return src.slice(argStart, i).trim();
    }

    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
      prevNonWs = ch;
    }
    i++;
  }
  return null;
}

function extractMemoFromCtorSource(
  ctorSrc: string,
  fieldName: string,
): { readonly source: string; readonly signature: string } | null {
  const escapedField = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assignRe = new RegExp(
    `(?:this\\s*\\.\\s*|(?<![.$\\w]))${escapedField}\\s*=\\s*`,
    "g",
  );
  let match: RegExpExecArray | null;
  while ((match = assignRe.exec(ctorSrc)) !== null) {
    let pos = skipWsAndComments(ctorSrc, match.index + match[0].length);
    const tail = ctorSrc.slice(pos);
    const tracePrefix = /^(?:[A-Za-z_$][\w$]*\s*\.\s*)*traceMemoized\s*\(/.exec(
      tail,
    );
    if (tracePrefix) {
      pos = skipWsAndComments(ctorSrc, pos + tracePrefix[0].length);
    }

    const afterTrace = ctorSrc.slice(pos);
    const callMatch =
      /^(?:\(\s*0\s*,\s*[A-Za-z_$][\w$.]*\s*\)|([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*))\s*\(/.exec(
        afterTrace,
      );
    if (!callMatch) continue;
    const calleeName = callMatch[1];
    if (calleeName && JS_NON_CALL_KEYWORDS.has(calleeName)) continue;

    const openParenIdx = pos + callMatch[0].length - 1;
    const extracted = scanFirstCallArg(ctorSrc, openParenIdx);
    if (!extracted) continue;
    const normalized = normalizeMemoSource(extracted);
    if (normalized) return normalized;
  }
  return null;
}

function isLitSyntheticGetter(fn: unknown): boolean {
  if (!isCallableFn(fn)) return false;
  try {
    const src = Function.prototype.toString.call(fn).trim();
    return (
      /^(?:function\s*)?get\s*\(\s*\)\s*\{\s*return\s+this\[[^\]]+\];?\s*\}$/.test(
        src,
      ) || /^\(\s*\)\s*=>\s*this\[[^\]]+\]$/.test(src)
    );
  } catch {
    return false;
  }
}

function isLitSyntheticSetter(fn: unknown): boolean {
  if (!isCallableFn(fn)) return false;
  try {
    const src = Function.prototype.toString.call(fn).trim();
    return /^(?:function\s*)?set\s*\([^)]*\)\s*\{[\s\S]*this\.requestUpdate\s*\(/.test(
      src,
    );
  } catch {
    return false;
  }
}

function truncateLabelText(
  text: string,
  maxLen = MAX_DISAMBIGUATOR_TEXT_CHARS,
): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1)}…`;
}

function collectReadableText(root: Node, maxChars = 48): string {
  const parts: string[] = [];
  let len = 0;
  const walk = (node: Node): void => {
    if (len >= maxChars) return;
    if (isElement(node)) {
      const tag = node.tagName.toUpperCase();
      if (tag === "STYLE" || tag === "SCRIPT" || tag === "TEMPLATE") return;
    }
    const childNodes = node.childNodes;
    if (!childNodes || childNodes.length === 0) {
      const text = node.textContent?.trim();
      if (text) {
        parts.push(text);
        len += text.length + 1;
      }
      return;
    }
    for (let i = 0; i < childNodes.length; i++) {
      const child = childNodes[i];
      if (child) walk(child);
      if (len >= maxChars) break;
    }
  };
  walk(root);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function extractElementShortText(
  el: Element,
  closedShadow?: ShadowRoot,
): string | null {
  if (el.children.length === 0) {
    const lightLeaf = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (lightLeaf.length >= 1 && lightLeaf.length <= 28) {
      return truncateLabelText(lightLeaf);
    }
  }

  const renderRoot: unknown = Reflect.get(el, "renderRoot");
  const root = isShadowRoot(renderRoot)
    ? renderRoot
    : isShadowRoot(el.shadowRoot)
      ? el.shadowRoot
      : closedShadow;

  if (root) {
    if (typeof root.querySelector === "function") {
      const btn = root.querySelector("button, [role='button']");
      if (btn) {
        const btnText = collectReadableText(btn);
        if (btnText.length >= 1 && btnText.length <= 28) {
          return truncateLabelText(btnText);
        }
      }
    }
    const shadowText = collectReadableText(root);
    if (shadowText.length >= 1 && shadowText.length <= 28) {
      return truncateLabelText(shadowText);
    }
  }

  if (el.children.length > 0) {
    const lightText = collectReadableText(el);
    if (lightText.length >= 1 && lightText.length <= 28) {
      return truncateLabelText(lightText);
    }
  }

  return null;
}

function getDomAncestryPath(el: Element): Node[] {
  const path: Node[] = [];
  let cursor: Node | null = el;
  let depth = 0;
  while (cursor && depth < 512) {
    depth++;
    path.push(cursor);
    cursor = isShadowRoot(cursor) ? cursor.host : cursor.parentNode;
  }
  path.reverse();
  return path;
}

function compareDomOrder(
  a: Element,
  b: Element,
  idA: number,
  idB: number,
): number {
  if (a === b) return 0;
  const pathA = getDomAncestryPath(a);
  const pathB = getDomAncestryPath(b);
  if (pathA[0] === pathB[0]) {
    const limit = Math.min(pathA.length, pathB.length);
    let diffIdx = 0;
    while (diffIdx < limit && pathA[diffIdx] === pathB[diffIdx]) {
      diffIdx++;
    }
    if (diffIdx > 0 && diffIdx < limit) {
      const parent = pathA[diffIdx - 1];
      const branchA = pathA[diffIdx];
      const branchB = pathB[diffIdx];
      if (parent && branchA && branchB) {
        const children = parent.childNodes;
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (child === branchA) return -1;
          if (child === branchB) return 1;
        }
        if (isShadowRoot(branchA) && !isShadowRoot(branchB)) return -1;
        if (isShadowRoot(branchB) && !isShadowRoot(branchA)) return 1;
        if (typeof branchA.compareDocumentPosition === "function") {
          const pos = branchA.compareDocumentPosition(branchB);
          if ((pos & 4) !== 0) return -1;
          if ((pos & 2) !== 0) return 1;
        }
      }
    }
  }
  return idA - idB;
}

function findBaseOwnerProto(
  startProto: object,
  methodName: string,
): object | null {
  let cursor: object | null = startProto;
  let baseOwner: object | null = null;
  const stopProto =
    typeof HTMLElement !== "undefined" ? HTMLElement.prototype : null;
  while (cursor && cursor !== stopProto && cursor !== Object.prototype) {
    if (Object.hasOwn(cursor, methodName)) {
      baseOwner = cursor;
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  return baseOwner;
}

function isReactiveElementProto(proto: unknown): proto is object {
  if (proto === null || typeof proto !== "object") return false;
  return (
    typeof Reflect.get(proto, "requestUpdate") === "function" &&
    typeof Reflect.get(proto, "performUpdate") === "function"
  );
}

function isElement(value: unknown): value is Element {
  return typeof Element !== "undefined" && value instanceof Element;
}

function isNode(value: unknown): value is Node {
  return typeof Node !== "undefined" && value instanceof Node;
}

function isShadowRoot(value: unknown): value is ShadowRoot {
  return typeof ShadowRoot !== "undefined" && value instanceof ShadowRoot;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof Reflect.get(value, "then") === "function"
  );
}

function isContextProviderLike(
  controller: object,
): ContextControllerMeta | null {
  const ctx: unknown = Reflect.get(controller, "context");
  if (ctx === undefined) return null;
  if (
    typeof Reflect.get(controller, "setValue") === "function" &&
    Reflect.get(controller, "subscriptions") instanceof Map
  ) {
    return { contextKey: ctx, isProvider: true };
  }
  if (typeof Reflect.get(controller, "dispatchRequest") === "function") {
    return { contextKey: ctx, isProvider: false };
  }
  return null;
}

export class LitReactivityTracker {
  #nextNodeId = 1;
  #seq = 0;
  #baseSeq = 0;
  #droppedEvents = 0;
  #nextCascadeId = 1;
  #installed = false;
  #recordingTraces = true;

  #settings: HookSettings = {
    paused: false,
    captureMemoHits: false,
    captureCustomEvents: true,
  };

  readonly #nodesById = new Map<number, NodeRecord>();
  readonly #idByObject = new WeakMap<object, number>();
  readonly #objectContextIds = new WeakMap<object, number>();
  readonly #primitiveContextIds = new Map<string | symbol, number>();
  readonly #contextAnchors = new Map<number, object>();
  readonly #edges = new Map<string, EdgeRecord>();
  readonly #events: TraceEvent[] = [];
  readonly #listeners = new Set<() => void>();

  readonly #wrappedRegistries = new WeakSet<object>();
  readonly #wrappedReactiveProtos = new WeakSet<object>();
  readonly #wrappedSubclassProtos = new WeakSet<object>();
  readonly #wrappedMethods = new WeakSet<Function>();
  readonly #origFnByWrapped = new WeakMap<
    Function,
    (...args: never[]) => unknown
  >();
  readonly #wrappedMemoTargets = new WeakSet<object>();
  readonly #wrappedProviders = new WeakSet<object>();
  readonly #wrappedCallbacks = new WeakMap<Function, Function>();
  readonly #wrappedEventTargets = new WeakSet<object>();
  readonly #wrappedAttachShadow = new WeakSet<object>();
  readonly #closedShadowRoots = new WeakMap<Element, ShadowRoot>();
  readonly #defineSites = new WeakMap<object, SourceLocation>();
  readonly #controllersByHost = new WeakMap<object, Set<object>>();
  readonly #pendingCauses = new WeakMap<object, PendingCause>();
  readonly #activeLifecyclePhase = new WeakMap<object, string>();
  readonly #activeLifecycleDepth = new WeakMap<object, Map<string, number>>();
  readonly #deferredLabels = new WeakMap<object, string>();
  readonly #ctorSourceCache = new WeakMap<object, string | null>();
  readonly #causalStack: CausalFrame[] = [];

  #scanningDom = false;
  #notifyScheduled = false;
  #highlightEl: HTMLDivElement | null = null;
  #lastModelDispatch: { nodeId: number; cascadeId: number; at: number } | null =
    null;

  readonly #finalizer = new FinalizationRegistry<number>((nodeId) => {
    const existing = this.#nodesById.get(nodeId);
    if (existing && existing.ref.deref() === undefined) {
      this.#removeNode(nodeId);
      this.#scheduleNotify();
    }
  });

  setTraceRecording(active: boolean): void {
    this.#recordingTraces = active;
  }

  install(): void {
    if (this.#installed) return;
    this.#installed = true;

    this.#hookAttachShadow();
    this.#hookCustomElementDefine();
    this.#hookEventTargetDispatch();
    this.scanDom();
  }

  registerModel<T extends object>(
    model: T,
    options?: RegisterEntityOptions,
  ): T {
    const record = this.#ensureModelRecord(model, options?.name);
    if (options && "initialValue" in options) {
      record.valuePreview = serializePreview(options.initialValue);
    }
    this.#scheduleNotify();
    return model;
  }

  registerController<T extends object>(
    controller: T,
    options?: RegisterEntityOptions & {
      readonly host?: object;
      readonly model?: object;
    },
  ): T {
    const record = this.#ensureControllerRecord(controller, options?.name);
    if (options?.host) {
      const hostNode = this.#ensureHostOrElementRecord(options.host);
      if (hostNode) {
        record.ownerNodeId = hostNode.id;
        this.#recordEdge(
          record.id,
          hostNode.id,
          "controller-to-element",
          "host",
          null,
        );
      }
    }
    if (options?.model) {
      const modelNode = this.#ensureModelRecord(options.model);
      this.#recordEdge(
        modelNode.id,
        record.id,
        "model-to-controller",
        "model",
        null,
      );
    }
    this.#scanMemoFields(controller, record);
    this.#scheduleNotify();
    return controller;
  }

  label<T extends object>(target: T, name: string): T {
    const clean = name.trim();
    const id = this.#idByObject.get(target);
    if (id !== undefined) {
      const record = this.#nodesById.get(id);
      if (record && clean) {
        record.label = clean;
        record.explicitLabel = clean;
        record.disambiguator = null;
        record.lockedDisambiguator = null;
        record.lockedDisambiguatorRank = undefined;
        this.#scheduleNotify();
      }
    } else if (clean) {
      this.#deferredLabels.set(target, clean);
    }
    return target;
  }

  traceMemoized<T extends (...args: never[]) => unknown>(
    fn: T,
    owner: object,
    name: string,
    role?: "computed" | "observer",
  ): T {
    const ownerNode = this.#ensureHostOrElementRecord(owner);
    if (!ownerNode) return fn;
    const memoKind: "computed" | "observer" = role ?? inferMemoRole(name);
    return this.#wrapMemoField(fn, ownerNode, name, memoKind);
  }

  #unwrapTargetFn(fn: unknown): ((...args: never[]) => unknown) | null {
    if (!isCallableFn(fn)) return null;
    let current: (...args: never[]) => unknown = fn;
    const seen = new Set<Function>();
    while (!seen.has(current)) {
      seen.add(current);
      const orig = this.#origFnByWrapped.get(current);
      if (!orig) break;
      current = orig;
    }
    return isNativeCodeFn(current) ? null : current;
  }

  getDefinitionTarget(
    nodeId: number,
    propName?: string | null,
  ): ((...args: never[]) => unknown) | null {
    const record = this.#nodesById.get(nodeId);
    if (!record) return null;
    const inst = record.ref.deref();

    if (record.kind === "element") {
      if (!inst || !isElement(inst)) return null;
      const stopProto =
        typeof HTMLElement !== "undefined" ? HTMLElement.prototype : null;

      if (typeof propName === "string" && propName.length > 0) {
        let cursor: object | null = Object.getPrototypeOf(inst);
        while (cursor && cursor !== stopProto && cursor !== Object.prototype) {
          const desc = Object.getOwnPropertyDescriptor(cursor, propName);
          if (desc) {
            const getter = this.#unwrapTargetFn(Reflect.get(desc, "get"));
            const setter = this.#unwrapTargetFn(Reflect.get(desc, "set"));
            if (getter && !isLitSyntheticGetter(getter)) {
              return getter;
            }
            if (setter && !isLitSyntheticSetter(setter)) {
              return setter;
            }
          }
          cursor = Object.getPrototypeOf(cursor);
        }

        let basePropCtor: ((...args: never[]) => unknown) | null = null;
        cursor = Object.getPrototypeOf(inst);
        while (cursor && cursor !== stopProto && cursor !== Object.prototype) {
          const cursorCtor: unknown = Reflect.get(cursor, "constructor");
          if (isUserConstructor(cursorCtor) && !isNativeCodeFn(cursorCtor)) {
            if (Object.hasOwn(cursorCtor, "properties")) {
              const ownProps: unknown = Reflect.get(cursorCtor, "properties");
              if (
                ownProps !== null &&
                typeof ownProps === "object" &&
                Object.hasOwn(ownProps, propName)
              ) {
                return cursorCtor;
              }
            }
            if (Object.hasOwn(cursorCtor, "elementProperties")) {
              const elProps: unknown = Reflect.get(
                cursorCtor,
                "elementProperties",
              );
              if (elProps instanceof Map && elProps.has(propName)) {
                basePropCtor = cursorCtor;
              }
            }
          }
          cursor = Object.getPrototypeOf(cursor);
        }
        if (basePropCtor) return basePropCtor;
      }

      const elCtor: unknown = Reflect.get(inst, "constructor");
      return isUserConstructor(elCtor) && !isNativeCodeFn(elCtor)
        ? elCtor
        : null;
    }

    if (record.kind === "controller" || record.kind === "model") {
      if (!inst) return null;
      const ctor: unknown = Reflect.get(inst, "constructor");
      if (isUserConstructor(ctor) && !isNativeCodeFn(ctor)) {
        return ctor;
      }
      const transformFn = this.#unwrapTargetFn(Reflect.get(inst, "_transform"));
      if (transformFn) return transformFn;
      const updateFn = this.#unwrapTargetFn(Reflect.get(inst, "update"));
      if (updateFn) return updateFn;
      return null;
    }

    if (record.kind === "computed" || record.kind === "observer") {
      const innerFn = record.innerMemoFnRef?.deref();
      if (innerFn && isCallableFn(innerFn) && !isNativeCodeFn(innerFn)) {
        try {
          const src = Function.prototype.toString.call(innerFn);
          if (!isMemoizeOneWrapperSource(src)) {
            return innerFn;
          }
        } catch {
          return innerFn;
        }
      }
      if (record.ownerNodeId !== undefined) {
        const ownerInst = this.#nodesById.get(record.ownerNodeId)?.ref.deref();
        if (ownerInst) {
          const ownerCtor: unknown = Reflect.get(ownerInst, "constructor");
          if (isUserConstructor(ownerCtor) && !isNativeCodeFn(ownerCtor)) {
            return ownerCtor;
          }
        }
      }
      return null;
    }

    if (record.kind === "context") {
      let providerHost: object | undefined = record.providerHostRef?.deref();
      if (!providerHost) {
        for (const edge of this.#edges.values()) {
          if (edge.targetId === nodeId && edge.kind === "context-provide") {
            providerHost = this.#nodesById.get(edge.sourceId)?.ref.deref();
            if (providerHost) break;
          }
        }
      }
      if (providerHost) {
        const ctor: unknown = Reflect.get(providerHost, "constructor");
        if (isUserConstructor(ctor) && !isNativeCodeFn(ctor)) {
          return ctor;
        }
      }
      return null;
    }

    return null;
  }

  scanDom(): void {
    if (typeof document === "undefined" || !document.documentElement) return;
    const prevScanning = this.#scanningDom;
    this.#scanningDom = true;
    try {
      const visited = new Set<Node>();
      const walk = (root: Node) => {
        if (visited.has(root)) return;
        visited.add(root);

        if (isElement(root)) {
          if (typeof Reflect.get(root, "requestUpdate") === "function") {
            const ctor: unknown = root.constructor;
            if (typeof ctor === "function" && ctor.prototype) {
              this.#instrumentLitClass(ctor, ctor.prototype);
            }
            const record = this.#ensureElementRecord(root);
            record.rootType = this.#resolveRootType(root);
            this.#scanMemoFields(root, record);
            this.#scanControllerRefsOnObject(root, record);
            this.#scanInternalControllers(root);
          }

          const renderRoot: unknown = Reflect.get(root, "renderRoot");
          const closedShadow = this.#closedShadowRoots.get(root);
          if (isShadowRoot(renderRoot)) {
            walk(renderRoot);
          } else if (root.shadowRoot) {
            walk(root.shadowRoot);
          } else if (closedShadow) {
            walk(closedShadow);
          }
        }

        const children = root.childNodes;
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (child) walk(child);
        }
      };
      walk(document.documentElement);
    } finally {
      this.#scanningDom = prevScanning;
    }
  }

  configure(settings: Partial<HookSettings>): void {
    this.#settings = {
      paused: settings.paused ?? this.#settings.paused,
      captureMemoHits:
        settings.captureMemoHits ?? this.#settings.captureMemoHits,
      captureCustomEvents:
        settings.captureCustomEvents ?? this.#settings.captureCustomEvents,
    };
    this.#scheduleNotify();
  }

  clearEvents(): void {
    this.#events.length = 0;
    this.#baseSeq = this.#seq;
    this.#droppedEvents = 0;
    this.#scheduleNotify();
  }

  setProperty(
    nodeId: number,
    propName: string,
    jsonText: string,
  ): ActionResult {
    if (!isValidSetPropertyName(propName)) {
      return {
        ok: false,
        error: `Refusing to mutate unsafe property "${propName}"`,
      };
    }
    const record = this.#nodesById.get(nodeId);
    if (!record || record.kind !== "element") {
      return { ok: false, error: `Element #${nodeId} is not available` };
    }
    const instance = record.ref.deref();
    if (!instance) {
      this.#removeNode(nodeId);
      return { ok: false, error: `Element #${nodeId} was garbage collected` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      return { ok: false, error: `Invalid JSON: ${formatErrorMessage(err)}` };
    }

    try {
      Reflect.set(instance, propName, parsed);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatErrorMessage(err) };
    }
  }

  clearMemoCache(nodeId: number): ActionResult {
    const record = this.#nodesById.get(nodeId);
    if (!record || (record.kind !== "computed" && record.kind !== "observer")) {
      return {
        ok: false,
        error: `Node #${nodeId} is not a memoized compute/observe function`,
      };
    }
    if (!record.clearMemoFn) {
      return { ok: false, error: `Memo node #${nodeId} has no clear() handle` };
    }
    record.clearMemoFn();
    this.#scheduleNotify();
    return { ok: true };
  }

  logToConsole(nodeId: number): ActionResult {
    const record = this.#nodesById.get(nodeId);
    const instance = record?.ref.deref();
    if (!record || !instance) {
      return { ok: false, error: `Node #${nodeId} is no longer live` };
    }
    (globalThis as Record<string, unknown>).$lit = instance;
    console.info(
      `[lit-reactivity-devtools] #${record.id} (${record.kind}) ${record.label}`,
      instance,
    );
    return { ok: true };
  }

  highlightElement(nodeId: number | null): void {
    if (typeof document === "undefined") return;
    if (nodeId === null) {
      if (this.#highlightEl) {
        this.#highlightEl.remove();
        this.#highlightEl = null;
      }
      return;
    }

    const record = this.#nodesById.get(nodeId);
    const instance = record?.ref.deref();
    if (!isElement(instance) || !instance.isConnected) {
      this.highlightElement(null);
      return;
    }

    const rect = this.#measureElementRect(instance);
    if (!rect) {
      this.highlightElement(null);
      return;
    }

    if (!this.#highlightEl) {
      const overlay = document.createElement("div");
      overlay.setAttribute("data-lit-devtools-highlight", "true");
      overlay.style.cssText = [
        "position: fixed",
        "pointer-events: none",
        "z-index: 2147483647",
        "border: 2px solid #388bfd",
        "background: rgba(56, 139, 253, 0.14)",
        "border-radius: 4px",
        "box-sizing: border-box",
      ].join(";");
      document.documentElement.appendChild(overlay);
      this.#highlightEl = overlay;
    }

    this.#highlightEl.style.left = `${Math.round(rect.left)}px`;
    this.#highlightEl.style.top = `${Math.round(rect.top)}px`;
    this.#highlightEl.style.width = `${Math.round(rect.width)}px`;
    this.#highlightEl.style.height = `${Math.round(rect.height)}px`;
  }

  getElementById(nodeId: number): Element | null {
    const record = this.#nodesById.get(nodeId);
    const inst = record?.ref.deref();
    return isElement(inst) ? inst : null;
  }

  selectElementFromElementsPanel(el: Element | null): number | null {
    let cursor: Node | null = el;
    while (cursor) {
      if (isElement(cursor)) {
        const id = this.#idByObject.get(cursor);
        if (id !== undefined) return id;
        if (typeof Reflect.get(cursor, "requestUpdate") === "function") {
          return this.#ensureElementRecord(cursor).id;
        }
      }
      if (isShadowRoot(cursor)) {
        cursor = cursor.host;
      } else {
        cursor = cursor.parentNode;
      }
    }
    return null;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  snapshot(sinceSeq?: number): GraphSnapshot {
    const liveRecords: NodeRecord[] = [];
    const liveIds = new Set<number>();

    for (const [id, record] of this.#nodesById.entries()) {
      const inst = record.ref.deref();
      if (!inst) {
        this.#removeNode(id);
        continue;
      }

      if (record.kind === "element" && isElement(inst)) {
        record.connected = inst.isConnected;
        record.rootType = this.#resolveRootType(inst);
        record.tagName = inst.tagName.toLowerCase();
        record.domParentNodeId = this.#resolveDomParentNodeId(inst);
        this.#refreshElementPropertyValues(record, inst);
      } else if (
        (record.kind === "computed" ||
          record.kind === "observer" ||
          record.kind === "controller") &&
        record.ownerNodeId !== undefined
      ) {
        const owner = this.#nodesById.get(record.ownerNodeId);
        if (owner) {
          record.connected = owner.connected;
          if (
            record.kind === "controller" &&
            (record.label.length <= 2 ||
              record.label.startsWith("Controller ("))
          ) {
            const ownerInst = owner.ref.deref();
            if (ownerInst) {
              const fieldAlias = findControllerFieldName(ownerInst, inst);
              if (fieldAlias) {
                record.label = `${fieldAlias} (${owner.label})`;
              }
            }
          }
        }
      }

      liveIds.add(id);
      liveRecords.push(record);
    }

    this.#resolveCohortDisambiguators(liveRecords);

    // Keep memo subtitles synced with disambiguated owner labels
    for (const record of liveRecords) {
      if (
        (record.kind === "computed" || record.kind === "observer") &&
        record.ownerNodeId !== undefined
      ) {
        const owner = this.#nodesById.get(record.ownerNodeId);
        if (owner) {
          record.subtitle = owner.label;
        }
      }
    }

    const nodes: ReactivityNodeSnapshot[] = liveRecords.map((record) => {
      const propList: ReactivePropertySnapshot[] | undefined = record.properties
        ? Array.from(record.properties.values()).map((p) => ({
            name: p.name,
            isState: p.isState,
            reflect: p.reflect,
            attribute: p.attribute,
            typeName: p.typeName,
            value: p.value,
            prevValue: p.prevValue,
            changes: p.changes,
            lastChangedSeq: p.lastChangedSeq,
            sourceLabel: p.sourceLabel,
          }))
        : undefined;

      return {
        id: record.id,
        kind: record.kind,
        label: record.label,
        subtitle: record.subtitle,
        site: record.site,
        connected: record.connected,
        updates: record.updates,
        hits: record.hits,
        misses: record.misses,
        vetoes: record.vetoes,
        lastDurationMs: record.lastDurationMs,
        lastChangedSeq: record.lastChangedSeq,
        lastCauseLabel: record.lastCauseLabel,
        lastCauseNodeId: record.lastCauseNodeId,
        value: record.valuePreview,
        error: record.error,
        ...(record.rootType ? { rootType: record.rootType } : {}),
        ...(propList ? { properties: propList } : {}),
        ...(record.lastArgs ? { lastArgs: record.lastArgs } : {}),
        ...(record.ownerNodeId !== undefined
          ? { ownerNodeId: record.ownerNodeId }
          : {}),
        ...(record.domParentNodeId !== undefined
          ? { domParentNodeId: record.domParentNodeId }
          : {}),
        ...(record.tagName !== undefined ? { tagName: record.tagName } : {}),
        ...(record.disambiguator !== undefined
          ? { disambiguator: record.disambiguator }
          : {}),
        ...(record.computeSource !== undefined
          ? { computeSource: record.computeSource }
          : {}),
        ...(record.computeSignature !== undefined
          ? { computeSignature: record.computeSignature }
          : {}),
      };
    });

    const edges: ReactivityEdgeSnapshot[] = [];
    for (const [edgeId, edge] of this.#edges.entries()) {
      if (!liveIds.has(edge.sourceId) || !liveIds.has(edge.targetId)) {
        this.#edges.delete(edgeId);
        continue;
      }
      edges.push({
        id: edge.id,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        kind: edge.kind,
        label: edge.label,
        count: edge.count,
        lastSeq: edge.lastSeq,
        lastDetail: edge.lastDetail,
      });
    }

    const events =
      sinceSeq !== undefined
        ? this.#events.filter((e) => e.seq > sinceSeq)
        : [...this.#events];

    const rawVersions: unknown = Reflect.get(globalThis, "litElementVersions");
    const litVersions = Array.isArray(rawVersions)
      ? rawVersions.filter((v): v is string => typeof v === "string")
      : [];

    return {
      version: 1,
      seq: this.#seq,
      baseSeq: this.#baseSeq,
      droppedEvents: this.#droppedEvents,
      litVersions,
      settings: { ...this.#settings },
      nodes,
      edges,
      events,
    };
  }

  #resolveDomParentNodeId(element: Element): number | undefined {
    let cursor: Node | null = element.parentNode;
    let depth = 0;
    while (cursor && depth < 512) {
      depth++;
      if (isElement(cursor)) {
        const existingId = this.#idByObject.get(cursor);
        if (existingId !== undefined) {
          return existingId;
        }
        if (typeof Reflect.get(cursor, "requestUpdate") === "function") {
          return this.#ensureElementRecord(cursor).id;
        }
      }
      cursor = isShadowRoot(cursor) ? cursor.host : cursor.parentNode;
    }
    return undefined;
  }

  #resolveCohortDisambiguators(liveRecords: ReadonlyArray<NodeRecord>): void {
    interface CohortMember {
      readonly record: NodeRecord;
      readonly el: Element;
      readonly tagName: string;
      resolved: boolean;
      disambiguator: string | null;
      rank: number;
    }

    const cohorts = new Map<string, CohortMember[]>();
    for (const record of liveRecords) {
      if (record.kind !== "element") continue;
      const inst = record.ref.deref();
      if (!inst || !isElement(inst)) continue;
      const tagName = record.tagName ?? inst.tagName.toLowerCase();
      record.tagName = tagName;
      const list = cohorts.get(tagName);
      const member: CohortMember = {
        record,
        el: inst,
        tagName,
        resolved: false,
        disambiguator: null,
        rank: 6,
      };
      if (list) {
        list.push(member);
      } else {
        cohorts.set(tagName, [member]);
      }
    }

    const applyMemberLabel = (member: CohortMember): void => {
      const { record, tagName, disambiguator, rank, el } = member;
      if (record.explicitLabel) {
        record.disambiguator = null;
        record.label = record.explicitLabel;
        return;
      }
      if (!disambiguator) {
        record.disambiguator = null;
        record.label = tagName;
        return;
      }
      const hasUpdated =
        record.updates >= 1 || Boolean(Reflect.get(el, "hasUpdated"));
      if (rank >= 1 && rank <= 5 && hasUpdated && !record.lockedDisambiguator) {
        record.lockedDisambiguator = disambiguator;
        record.lockedDisambiguatorRank = rank;
      }
      record.disambiguator = disambiguator;
      record.label = disambiguator.startsWith("#")
        ? `${tagName}${disambiguator}`
        : `${tagName} ${disambiguator}`;
    };

    for (const [tagName, members] of cohorts.entries()) {
      if (members.length === 1) {
        const only = members[0]!;
        if (only.record.explicitLabel) {
          only.rank = 0;
          applyMemberLabel(only);
          continue;
        }
        const domId = (only.el.id ?? "").trim();
        if (domId.length > 0) {
          only.disambiguator = `#${domId}`;
          only.rank = 1;
          only.resolved = true;
        } else {
          only.disambiguator = null;
          only.rank = 0;
        }
        applyMemberLabel(only);
        continue;
      }

      const usedDisambiguators = new Set<string>();

      // Tier 0 (explicit hook.label) and latched Ranks 1-5
      for (const m of members) {
        if (m.record.explicitLabel) {
          m.resolved = true;
          m.rank = 0;
          continue;
        }
        if (m.record.lockedDisambiguator) {
          m.resolved = true;
          m.disambiguator = m.record.lockedDisambiguator;
          m.rank = m.record.lockedDisambiguatorRank ?? 1;
          usedDisambiguators.add(m.record.lockedDisambiguator);
        }
      }

      // Tier 1: #id (unique within cohort, since Shadow DOM roots can reuse ids)
      const idCandidates = new Map<CohortMember, string>();
      const idCounts = new Map<string, number>();
      for (const m of members) {
        const domId = (m.el.id ?? "").trim();
        if (domId.length > 0) {
          const d = `#${domId}`;
          idCandidates.set(m, d);
          idCounts.set(d, (idCounts.get(d) ?? 0) + 1);
        }
      }
      for (const m of members) {
        if (m.resolved) continue;
        const cand = idCandidates.get(m);
        if (!cand) continue;
        if (idCounts.get(cand) === 1 && !usedDisambiguators.has(cand)) {
          m.resolved = true;
          m.disambiguator = cand;
          m.rank = 1;
          usedDisambiguators.add(cand);
        }
      }

      // Tier 2: data-testid/data-test-id/data-id -> slot/name (if distinct) -> aria-label/title
      const resolveDistinctAttr = (attrs: ReadonlyArray<string>): void => {
        for (const attr of attrs) {
          const candidates = new Map<CohortMember, string>();
          const counts = new Map<string, number>();
          for (const m of members) {
            const raw =
              typeof m.el.getAttribute === "function"
                ? m.el.getAttribute(attr)?.trim()
                : undefined;
            if (!raw) continue;
            const formatted = `[${attr}="${truncateLabelText(raw)}"]`;
            candidates.set(m, formatted);
            counts.set(formatted, (counts.get(formatted) ?? 0) + 1);
          }
          for (const m of members) {
            if (m.resolved) continue;
            const cand = candidates.get(m);
            if (!cand) continue;
            if (counts.get(cand) === 1 && !usedDisambiguators.has(cand)) {
              m.resolved = true;
              m.disambiguator = cand;
              m.rank = 2;
              usedDisambiguators.add(cand);
            }
          }
        }
      };

      resolveDistinctAttr(["data-testid", "data-test-id", "data-id"]);
      resolveDistinctAttr(["slot", "name"]);
      resolveDistinctAttr(["aria-label", "title"]);

      // Tier 3: entropy-ranked low-churn primitive reactive prop
      while (members.some((m) => !m.resolved)) {
        let bestProp: {
          readonly uniqueCount: number;
          readonly entropy: number;
          readonly maxChanges: number;
          readonly prioIdx: number;
          readonly winners: ReadonlyArray<readonly [CohortMember, string]>;
        } | null = null;

        for (
          let prioIdx = 0;
          prioIdx < DISAMBIGUATOR_PROP_PRIORITY.length;
          prioIdx++
        ) {
          const propName = DISAMBIGUATOR_PROP_PRIORITY[prioIdx]!;
          const allValues = new Map<CohortMember, string>();
          const allCounts = new Map<string, number>();
          const unresolvedCounts = new Map<string, number>();
          const memberChanges = new Map<CohortMember, number>();
          let unresolvedWithProp = 0;

          for (const m of members) {
            const propRec = m.record.properties?.get(propName);
            const hasDeclaredProp = propRec !== undefined;
            if (!hasDeclaredProp) continue;
            const read = safeReadProp(m.el, propName);
            if (!read.ok) continue;
            const val = read.value;
            let formatted: string | null = null;
            if (typeof val === "string") {
              const trimmed = val.trim();
              if (trimmed.length > 0) {
                formatted = `${propName}="${truncateLabelText(trimmed)}"`;
              }
            } else if (typeof val === "number" && Number.isFinite(val)) {
              formatted = `${propName}=${String(val)}`;
            } else if (typeof val === "boolean") {
              formatted = `${propName}=${String(val)}`;
            }
            if (!formatted) continue;
            allValues.set(m, formatted);
            allCounts.set(formatted, (allCounts.get(formatted) ?? 0) + 1);
            memberChanges.set(m, propRec.changes);
            if (!m.resolved) {
              unresolvedWithProp++;
              unresolvedCounts.set(
                formatted,
                (unresolvedCounts.get(formatted) ?? 0) + 1,
              );
            }
          }

          if (unresolvedWithProp === 0) continue;

          const winners: Array<readonly [CohortMember, string]> = [];
          let maxChanges = 0;
          for (const m of members) {
            if (m.resolved) continue;
            const cand = allValues.get(m);
            if (!cand) continue;
            const changes = memberChanges.get(m) ?? 0;
            if (changes > 3) continue;
            if (allCounts.get(cand) === 1 && !usedDisambiguators.has(cand)) {
              winners.push([m, cand]);
              if (changes > maxChanges) maxChanges = changes;
            }
          }

          if (winners.length === 0) continue;

          let entropy = 0;
          for (const count of unresolvedCounts.values()) {
            const p = count / unresolvedWithProp;
            if (p > 0) entropy -= p * Math.log2(p);
          }

          const isBetter =
            !bestProp ||
            winners.length > bestProp.uniqueCount ||
            (winners.length === bestProp.uniqueCount &&
              (entropy > bestProp.entropy + 1e-6 ||
                (Math.abs(entropy - bestProp.entropy) <= 1e-6 &&
                  (maxChanges < bestProp.maxChanges ||
                    (maxChanges === bestProp.maxChanges &&
                      prioIdx < bestProp.prioIdx)))));

          if (isBetter) {
            bestProp = {
              uniqueCount: winners.length,
              entropy,
              maxChanges,
              prioIdx,
              winners,
            };
          }
        }

        if (!bestProp) break;
        for (const [m, cand] of bestProp.winners) {
          m.resolved = true;
          m.disambiguator = cand;
          m.rank = 3;
          usedDisambiguators.add(cand);
        }
      }

      // Tier 4: short leaf textContent / shadow button label
      if (members.some((m) => !m.resolved)) {
        const textCands = new Map<CohortMember, string>();
        const textCounts = new Map<string, number>();
        for (const m of members) {
          const shortText = extractElementShortText(
            m.el,
            this.#closedShadowRoots.get(m.el),
          );
          if (!shortText) continue;
          const formatted = `"${shortText}"`;
          textCands.set(m, formatted);
          textCounts.set(formatted, (textCounts.get(formatted) ?? 0) + 1);
        }
        for (const m of members) {
          if (m.resolved) continue;
          const cand = textCands.get(m);
          if (!cand) continue;
          if (textCounts.get(cand) === 1 && !usedDisambiguators.has(cand)) {
            m.resolved = true;
            m.disambiguator = cand;
            m.rank = 4;
            usedDisambiguators.add(cand);
          }
        }
      }

      // Tier 5: distinct domParentNodeId tag (in <parent>)
      if (members.some((m) => !m.resolved)) {
        const parentCands = new Map<CohortMember, string>();
        const parentCounts = new Map<string, number>();
        for (const m of members) {
          const parentId = m.record.domParentNodeId;
          if (parentId === undefined) continue;
          const parentRecord = this.#nodesById.get(parentId);
          const parentTag =
            parentRecord?.tagName ?? parentRecord?.label ?? null;
          if (!parentTag) continue;
          const formatted = `in ${parentTag}`;
          parentCands.set(m, formatted);
          parentCounts.set(formatted, (parentCounts.get(formatted) ?? 0) + 1);
        }
        for (const m of members) {
          if (m.resolved) continue;
          const cand = parentCands.get(m);
          if (!cand) continue;
          if (parentCounts.get(cand) === 1 && !usedDisambiguators.has(cand)) {
            m.resolved = true;
            m.disambiguator = cand;
            m.rank = 5;
            usedDisambiguators.add(cand);
          }
        }
      }

      // Tier 6: DOM sibling ordinal [1]..[n] (never latched)
      const remaining = members.filter((m) => !m.resolved);
      if (remaining.length > 0) {
        remaining.sort((a, b) =>
          compareDomOrder(a.el, b.el, a.record.id, b.record.id),
        );
        let ordinal = 1;
        for (const m of remaining) {
          while (usedDisambiguators.has(`[${ordinal}]`)) {
            ordinal++;
          }
          const cand = `[${ordinal}]`;
          m.resolved = true;
          m.disambiguator = cand;
          m.rank = 6;
          usedDisambiguators.add(cand);
          ordinal++;
        }
      }

      for (const m of members) {
        applyMemberLabel(m);
        // Ensure record.tagName remains bare lowercase tag
        m.record.tagName = tagName;
      }
    }
  }

  #measureElementRect(
    element: Element,
  ): { left: number; top: number; width: number; height: number } | null {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      return rect;
    }

    // Fallback for display: contents hosts: union child client rects
    const roots: Array<Element | ShadowRoot> = [element];
    const renderRoot: unknown = Reflect.get(element, "renderRoot");
    if (isShadowRoot(renderRoot)) {
      roots.push(renderRoot);
    } else if (element.shadowRoot) {
      roots.push(element.shadowRoot);
    }

    let minLeft = Number.POSITIVE_INFINITY;
    let minTop = Number.POSITIVE_INFINITY;
    let maxRight = Number.NEGATIVE_INFINITY;
    let maxBottom = Number.NEGATIVE_INFINITY;

    for (const root of roots) {
      for (let i = 0; i < root.children.length; i++) {
        const child = root.children[i];
        if (!child) continue;
        const cRect = child.getBoundingClientRect();
        if (cRect.width === 0 && cRect.height === 0) continue;
        minLeft = Math.min(minLeft, cRect.left);
        minTop = Math.min(minTop, cRect.top);
        maxRight = Math.max(maxRight, cRect.right);
        maxBottom = Math.max(maxBottom, cRect.bottom);
      }
    }

    if (!Number.isFinite(minLeft)) return null;
    return {
      left: minLeft,
      top: minTop,
      width: Math.max(1, maxRight - minLeft),
      height: Math.max(1, maxBottom - minTop),
    };
  }

  #resolveRootType(element: Element): "shadow" | "light" | "closed-shadow" {
    const renderRoot: unknown = Reflect.get(element, "renderRoot");
    if (isShadowRoot(renderRoot)) {
      return element.shadowRoot === renderRoot ? "shadow" : "closed-shadow";
    }
    if (element.shadowRoot) {
      return "shadow";
    }
    if (this.#closedShadowRoots.has(element)) {
      return "closed-shadow";
    }
    return "light";
  }

  #hookAttachShadow(): void {
    if (typeof Element === "undefined") return;
    const proto = Element.prototype;
    if (this.#wrappedAttachShadow.has(proto)) return;
    this.#wrappedAttachShadow.add(proto);

    const origAttach: unknown = Reflect.get(proto, "attachShadow");
    if (typeof origAttach !== "function") return;

    const __LIT_DEVTOOLS__attachShadow = (
      target: Function,
      thisArg: unknown,
      argArray: unknown[],
    ): unknown => {
      const root: unknown = Reflect.apply(target, thisArg, argArray);
      if (isElement(thisArg) && isShadowRoot(root)) {
        const init: unknown = argArray[0];
        if (
          init !== null &&
          typeof init === "object" &&
          Reflect.get(init, "mode") === "closed"
        ) {
          this.#closedShadowRoots.set(thisArg, root);
        }
      }
      return root;
    };

    const wrappedAttach = new Proxy(origAttach, {
      apply: __LIT_DEVTOOLS__attachShadow,
    });
    Reflect.set(proto, "attachShadow", wrappedAttach);
  }

  #hookCustomElementDefine(): void {
    if (typeof CustomElementRegistry === "undefined") return;
    const regProto = CustomElementRegistry.prototype;
    if (this.#wrappedRegistries.has(regProto)) return;
    this.#wrappedRegistries.add(regProto);

    const origDefine: unknown = Reflect.get(regProto, "define");
    if (typeof origDefine !== "function") return;

    const __LIT_DEVTOOLS__wrappedDefine = (
      target: Function,
      thisArg: unknown,
      argArray: unknown[],
    ): unknown => {
      const constructor: unknown = argArray[1];
      try {
        if (typeof constructor === "function" && constructor.prototype) {
          const site = captureCallsite(0);
          if (site) {
            this.#defineSites.set(constructor, site);
          }
          if (isReactiveElementProto(constructor.prototype)) {
            this.#instrumentLitClass(constructor, constructor.prototype);
          }
        }
      } catch {
        // Never interfere with customElements.define registration
      }
      return Reflect.apply(target, thisArg, argArray);
    };

    const wrappedDefine = new Proxy(origDefine, {
      apply: __LIT_DEVTOOLS__wrappedDefine,
    });
    Reflect.set(regProto, "define", wrappedDefine);
  }

  #instrumentLitClass(ctor: Function, subProto: object): void {
    const baseReactiveProto = findBaseOwnerProto(subProto, "performUpdate");
    if (
      baseReactiveProto &&
      !this.#wrappedReactiveProtos.has(baseReactiveProto)
    ) {
      this.#wrappedReactiveProtos.add(baseReactiveProto);
      this.#wrapReactiveElementBase(baseReactiveProto);
    }

    // Wrap every prototype from subProto up to HTMLElement.prototype (including SignalWatcher/LitElement/ReactiveElement)
    const stopProto =
      typeof HTMLElement !== "undefined" ? HTMLElement.prototype : null;
    let cursor: object | null = subProto;
    while (cursor && cursor !== stopProto && cursor !== Object.prototype) {
      if (!this.#wrappedSubclassProtos.has(cursor)) {
        this.#wrappedSubclassProtos.add(cursor);
        this.#wrapSubclassHooks(cursor);
      }
      cursor = Object.getPrototypeOf(cursor);
    }

    if (!this.#scanningDom && !this.#defineSites.has(ctor)) {
      const fallbackSite = captureCallsite(0);
      if (fallbackSite) this.#defineSites.set(ctor, fallbackSite);
    }
  }

  #wrapReactiveElementBase(reactiveProto: object): void {
    const origAddController: unknown = Reflect.get(
      reactiveProto,
      "addController",
    );
    if (
      typeof origAddController === "function" &&
      !this.#wrappedMethods.has(origAddController)
    ) {
      const __LIT_DEVTOOLS__addController = (
        target: Function,
        thisArg: unknown,
        argArray: unknown[],
      ): unknown => {
        const controller: unknown = argArray[0];
        if (
          thisArg !== null &&
          typeof thisArg === "object" &&
          controller !== null &&
          typeof controller === "object"
        ) {
          this.#onControllerAdded(thisArg, controller);
        }
        return Reflect.apply(target, thisArg, argArray);
      };
      const wrappedAdd = new Proxy(origAddController, {
        apply: __LIT_DEVTOOLS__addController,
      });
      this.#wrappedMethods.add(wrappedAdd);
      Reflect.set(reactiveProto, "addController", wrappedAdd);
    }

    const origRemoveController: unknown = Reflect.get(
      reactiveProto,
      "removeController",
    );
    if (
      typeof origRemoveController === "function" &&
      !this.#wrappedMethods.has(origRemoveController)
    ) {
      const __LIT_DEVTOOLS__removeController = (
        target: Function,
        thisArg: unknown,
        argArray: unknown[],
      ): unknown => {
        const controller: unknown = argArray[0];
        if (
          thisArg !== null &&
          typeof thisArg === "object" &&
          controller !== null &&
          typeof controller === "object"
        ) {
          this.#controllersByHost.get(thisArg)?.delete(controller);
          const ctrlId = this.#idByObject.get(controller);
          const hostId = this.#idByObject.get(thisArg);
          if (ctrlId !== undefined) {
            const ctrlNode = this.#nodesById.get(ctrlId);
            if (ctrlNode) ctrlNode.connected = false;
            if (hostId !== undefined) {
              for (const [edgeId, edge] of this.#edges.entries()) {
                if (
                  edge.sourceId === ctrlId &&
                  edge.targetId === hostId &&
                  edge.kind === "controller-to-element"
                ) {
                  this.#edges.delete(edgeId);
                }
              }
            }
          }
        }
        return Reflect.apply(target, thisArg, argArray);
      };
      const wrappedRemove = new Proxy(origRemoveController, {
        apply: __LIT_DEVTOOLS__removeController,
      });
      this.#wrappedMethods.add(wrappedRemove);
      Reflect.set(reactiveProto, "removeController", wrappedRemove);
    }

    const origRequestUpdate: unknown = Reflect.get(
      reactiveProto,
      "requestUpdate",
    );
    if (
      typeof origRequestUpdate === "function" &&
      !this.#wrappedMethods.has(origRequestUpdate)
    ) {
      const __LIT_DEVTOOLS__requestUpdate = (
        target: Function,
        thisArg: unknown,
        argArray: unknown[],
      ): unknown => {
        if (isElement(thisArg)) {
          const rawName: unknown = argArray[0];
          const name: PropertyKey | undefined =
            typeof rawName === "string" ||
            typeof rawName === "number" ||
            typeof rawName === "symbol"
              ? rawName
              : undefined;
          const oldValue: unknown = argArray[1];
          const options: unknown = argArray[2];
          const useNewValue = Boolean(argArray[3]);
          const newValue: unknown = argArray[4];
          this.#onElementRequestUpdate(
            thisArg,
            name,
            oldValue,
            options,
            useNewValue,
            newValue,
          );
        }
        return Reflect.apply(target, thisArg, argArray);
      };
      const wrappedRequestUpdate = new Proxy(origRequestUpdate, {
        apply: __LIT_DEVTOOLS__requestUpdate,
      });
      this.#wrappedMethods.add(wrappedRequestUpdate);
      Reflect.set(reactiveProto, "requestUpdate", wrappedRequestUpdate);
    }

    const origPerformUpdate: unknown = Reflect.get(
      reactiveProto,
      "performUpdate",
    );
    if (
      typeof origPerformUpdate === "function" &&
      !this.#wrappedMethods.has(origPerformUpdate)
    ) {
      const __LIT_DEVTOOLS__performUpdate = (
        target: Function,
        thisArg: unknown,
        argArray: unknown[],
      ): unknown => {
        if (!isElement(thisArg)) {
          return Reflect.apply(target, thisArg, argArray);
        }
        const record = this.#ensureElementRecord(thisArg);
        record.rootType = this.#resolveRootType(thisArg);
        this.#scanMemoFields(thisArg, record);
        this.#scanControllerRefsOnObject(thisArg, record);
        this.#scanInternalControllers(thisArg);

        const pending = this.#pendingCauses.get(thisArg);
        if (pending) {
          this.#pendingCauses.delete(thisArg);
          record.lastCauseNodeId = pending.causeNodeId;
          record.lastCauseLabel = pending.label;
        } else {
          record.lastCauseNodeId = null;
          record.lastCauseLabel = null;
        }
        const cascadeId = pending?.cascadeId ?? this.#nextCascadeId++;

        this.#causalStack.push({
          nodeId: record.id,
          kind: "element",
          label: record.label,
          cascadeId,
          phase: "performUpdate",
        });

        const onPerformError = (err: unknown) => {
          record.error = formatErrorMessage(err);
          this.#pushTrace({
            cascadeId,
            durationMs: 0,
            nodeId: record.id,
            kind: "error",
            label: `${record.label} performUpdate error`,
            causeNodeId: record.lastCauseNodeId,
            detail: record.error,
          });
          this.#scheduleNotify();
        };

        try {
          const ret: unknown = Reflect.apply(target, thisArg, argArray);
          if (isPromiseLike(ret)) {
            return ret.then(
              (val) => val,
              (err: unknown) => {
                onPerformError(err);
                throw err;
              },
            );
          }
          return ret;
        } catch (err) {
          onPerformError(err);
          throw err;
        } finally {
          this.#causalStack.pop();
        }
      };
      const wrappedPerformUpdate = new Proxy(origPerformUpdate, {
        apply: __LIT_DEVTOOLS__performUpdate,
      });
      this.#wrappedMethods.add(wrappedPerformUpdate);
      Reflect.set(reactiveProto, "performUpdate", wrappedPerformUpdate);
    }
  }

  #wrapSubclassHooks(proto: object): void {
    const wrapLifecycle = (
      methodName:
        | "connectedCallback"
        | "disconnectedCallback"
        | "shouldUpdate"
        | "willUpdate"
        | "update"
        | "updated",
    ) => {
      if (!Object.hasOwn(proto, methodName)) return;
      const desc = Object.getOwnPropertyDescriptor(proto, methodName);
      if (
        !desc ||
        typeof desc.value !== "function" ||
        this.#wrappedMethods.has(desc.value)
      )
        return;
      if (!desc.writable && !desc.configurable) return;

      const origFn: Function = desc.value;
      const __LIT_DEVTOOLS__lifecycle = (
        target: Function,
        thisArg: unknown,
        argArray: unknown[],
      ): unknown => {
        if (!isElement(thisArg)) {
          return Reflect.apply(target, thisArg, argArray);
        }

        let depthMap = this.#activeLifecycleDepth.get(thisArg);
        if (!depthMap) {
          depthMap = new Map<string, number>();
          this.#activeLifecycleDepth.set(thisArg, depthMap);
        }
        const depth = depthMap.get(methodName) ?? 0;
        depthMap.set(methodName, depth + 1);
        const isOutermost = depth === 0;

        const record = this.#ensureElementRecord(thisArg);
        const prevPhase = this.#activeLifecyclePhase.get(thisArg);
        if (isOutermost) {
          this.#activeLifecyclePhase.set(thisArg, methodName);
        }

        const startMs = performance.now();
        let reservedRenderEvent: TraceEvent | null = null;
        let pushedUpdateFrame = false;

        try {
          if (isOutermost && methodName === "connectedCallback") {
            record.connected = true;
            record.rootType = this.#resolveRootType(thisArg);
            this.#scanMemoFields(thisArg, record);
            this.#scanControllerRefsOnObject(thisArg, record);
            this.#scanInternalControllers(thisArg);
            this.#pushTrace({
              cascadeId: this.#currentCascadeId(),
              durationMs: 0,
              nodeId: record.id,
              kind: "connect",
              label: `${record.label} connected`,
              causeNodeId: null,
              detail: null,
            });
            this.#scheduleNotify();
          } else if (isOutermost && methodName === "disconnectedCallback") {
            record.connected = false;
            this.#scheduleNotify();
          } else if (
            isOutermost &&
            (methodName === "willUpdate" || methodName === "update")
          ) {
            const changed = argArray[0];
            if (changed instanceof Map) {
              this.#syncChangedPropertiesMap(record, thisArg, changed);
            }
          }

          if (isOutermost && methodName === "update") {
            const cascadeId = this.#currentCascadeId();
            reservedRenderEvent = this.#pushTraceMutable({
              cascadeId,
              durationMs: 0,
              nodeId: record.id,
              kind: "render",
              label: `${record.label} render`,
              causeNodeId: record.lastCauseNodeId,
              detail: record.lastCauseLabel,
            });
            // Push update phase onto causalStack in case a subclass calls update() directly outside performUpdate
            this.#causalStack.push({
              nodeId: record.id,
              kind: "element",
              label: record.label,
              cascadeId,
              phase: "update",
            });
            pushedUpdateFrame = true;
          }

          const result: unknown = Reflect.apply(target, thisArg, argArray);

          if (
            isOutermost &&
            methodName === "shouldUpdate" &&
            result === false
          ) {
            record.vetoes += 1;
            this.#pushTrace({
              cascadeId: this.#currentCascadeId(),
              durationMs: performance.now() - startMs,
              nodeId: record.id,
              kind: "veto",
              label: `${record.label} shouldUpdate → false`,
              causeNodeId: record.lastCauseNodeId,
              detail: "Render skipped by shouldUpdate",
            });
            this.#scheduleNotify();
          } else if (isOutermost && methodName === "update") {
            const durationMs = performance.now() - startMs;
            record.updates += 1;
            record.lastDurationMs = durationMs;
            record.error = null;
            record.rootType = this.#resolveRootType(thisArg);
            if (reservedRenderEvent) {
              record.lastChangedSeq = reservedRenderEvent.seq;
              this.#patchTraceDuration(reservedRenderEvent.seq, durationMs);
            }
            this.#scheduleNotify();
          }

          return result;
        } finally {
          if (pushedUpdateFrame) {
            this.#causalStack.pop();
          }
          depthMap.set(methodName, depth);
          if (isOutermost) {
            if (prevPhase !== undefined) {
              this.#activeLifecyclePhase.set(thisArg, prevPhase);
            } else {
              this.#activeLifecyclePhase.delete(thisArg);
            }
          }
        }
      };

      const wrapped = new Proxy(origFn, {
        apply: __LIT_DEVTOOLS__lifecycle,
      });

      this.#wrappedMethods.add(wrapped);
      if (isCallableFn(origFn)) {
        this.#origFnByWrapped.set(wrapped, origFn);
      }
      Reflect.set(proto, methodName, wrapped);
    };

    wrapLifecycle("connectedCallback");
    wrapLifecycle("disconnectedCallback");
    wrapLifecycle("shouldUpdate");
    wrapLifecycle("willUpdate");
    wrapLifecycle("update");
    wrapLifecycle("updated");
  }

  #hookEventTargetDispatch(): void {
    if (typeof EventTarget === "undefined") return;
    const proto = EventTarget.prototype;
    if (this.#wrappedEventTargets.has(proto)) return;
    this.#wrappedEventTargets.add(proto);

    const origDispatch: unknown = Reflect.get(proto, "dispatchEvent");
    if (typeof origDispatch !== "function") return;

    const callOrigDispatch = (target: EventTarget, evt: Event): boolean =>
      Boolean(Reflect.apply(origDispatch, target, [evt]));

    const __LIT_DEVTOOLS__dispatchEvent = (
      target: Function,
      thisArg: unknown,
      argArray: unknown[],
    ): unknown => {
      const event: unknown = argArray[0];
      if (!(thisArg instanceof EventTarget) || !(event instanceof Event)) {
        return Reflect.apply(target, thisArg, argArray);
      }

      const type = event.type;
      if (type === "context-request") {
        this.#onContextRequestEvent(thisArg, event);
        return Reflect.apply(target, thisArg, argArray);
      }

      if (type === "context-provider") {
        this.#onContextProviderEvent(thisArg, event);
        return Reflect.apply(target, thisArg, argArray);
      }

      if (type === "model-update") {
        return this.#onModelUpdateEvent(thisArg, event, (evt) =>
          callOrigDispatch(thisArg, evt),
        );
      }

      if (type === "view-model-update") {
        return this.#onViewModelUpdateEvent(thisArg, event, (evt) =>
          callOrigDispatch(thisArg, evt),
        );
      }

      if (
        this.#settings.captureCustomEvents &&
        type !== "lit-debug" &&
        isElement(thisArg) &&
        thisArg.tagName.includes("-") &&
        typeof CustomEvent !== "undefined" &&
        event instanceof CustomEvent &&
        event.bubbles &&
        event.composed
      ) {
        return this.#onCustomElementEvent(thisArg, event, (evt) =>
          callOrigDispatch(thisArg, evt),
        );
      }

      return Reflect.apply(target, thisArg, argArray);
    };

    const wrappedDispatch = new Proxy(origDispatch, {
      apply: __LIT_DEVTOOLS__dispatchEvent,
    });

    Reflect.set(proto, "dispatchEvent", wrappedDispatch);
  }

  #onContextRequestEvent(target: EventTarget, event: Event): void {
    const contextKey: unknown = Reflect.get(event, "context");
    if (contextKey === undefined) return;
    const consumerHost: unknown = Reflect.get(event, "contextTarget") ?? target;
    const subscribe = Boolean(Reflect.get(event, "subscribe"));
    const origCallback: unknown = Reflect.get(event, "callback");

    const contextNode = this.#ensureContextRecord(contextKey);
    const consumerNode =
      consumerHost !== null && typeof consumerHost === "object"
        ? this.#ensureHostOrElementRecord(consumerHost)
        : null;

    if (consumerNode) {
      this.#recordEdge(
        contextNode.id,
        consumerNode.id,
        "context-consume",
        subscribe ? "subscribe" : "once",
        null,
      );
    }

    if (typeof origCallback === "function") {
      let wrappedCb = this.#wrappedCallbacks.get(origCallback);
      if (!wrappedCb) {
        const __LIT_DEVTOOLS__contextCallback = (
          cbTarget: Function,
          thisArg: unknown,
          argArray: unknown[],
        ): unknown => {
          const value: unknown = argArray[0];
          const preview = serializePreview(value);
          contextNode.valuePreview = preview;

          const top = this.#causalStack.at(-1);
          const cascadeId = top?.cascadeId ?? this.#nextCascadeId++;
          const causeId = top?.nodeId ?? contextNode.lastCauseNodeId;

          if (top?.kind !== "context-push") {
            contextNode.updates += 1;
          }

          const pushSeq = this.#pushTrace({
            cascadeId,
            durationMs: 0,
            nodeId: contextNode.id,
            kind: "context-push",
            label: `${contextNode.label} → ${consumerNode?.label ?? "consumer"}`,
            causeNodeId: causeId,
            detail: preview.text,
          });
          contextNode.lastChangedSeq = pushSeq;

          if (consumerNode) {
            const edge = this.#recordEdge(
              contextNode.id,
              consumerNode.id,
              "context-consume",
              subscribe ? "subscribe" : "once",
              preview.text,
            );
            edge.count += 1;
            edge.lastSeq = pushSeq;
          }

          this.#causalStack.push({
            nodeId: contextNode.id,
            kind: "context-push",
            label: `context '${contextNode.label}'`,
            cascadeId,
          });
          this.#scheduleNotify();

          try {
            return Reflect.apply(cbTarget, thisArg, argArray);
          } finally {
            this.#causalStack.pop();
          }
        };
        wrappedCb = new Proxy(origCallback, {
          apply: __LIT_DEVTOOLS__contextCallback,
        });
        this.#wrappedCallbacks.set(origCallback, wrappedCb);
        this.#wrappedCallbacks.set(wrappedCb, wrappedCb);
      }
      try {
        Reflect.set(event, "callback", wrappedCb);
      } catch {
        // Ignore if caller froze event object
      }
    }
  }

  #onContextProviderEvent(target: EventTarget, event: Event): void {
    const contextKey: unknown = Reflect.get(event, "context");
    if (contextKey === undefined) return;
    const providerHost: unknown = Reflect.get(event, "contextTarget") ?? target;
    const contextNode = this.#ensureContextRecord(contextKey);
    if (!this.#scanningDom && contextNode.site === null) {
      contextNode.site = captureCallsite(0);
    }

    if (providerHost !== null && typeof providerHost === "object") {
      contextNode.providerHostRef = new WeakRef(providerHost);
      const hostNode = this.#ensureHostOrElementRecord(providerHost);
      if (hostNode) {
        this.#recordEdge(
          hostNode.id,
          contextNode.id,
          "context-provide",
          "provides",
          null,
        );
        contextNode.lastCauseNodeId = hostNode.id;
        contextNode.lastCauseLabel = `provided by ${hostNode.label}`;
      }
      const controllers = this.#controllersByHost.get(providerHost);
      if (controllers) {
        for (const ctrl of controllers) {
          const meta = isContextProviderLike(ctrl);
          if (meta?.isProvider && meta.contextKey === contextKey) {
            this.#wrapContextProviderController(
              ctrl,
              providerHost,
              contextNode,
            );
          }
        }
      }
    }
    this.#scheduleNotify();
  }

  #onModelUpdateEvent(
    target: EventTarget,
    event: Event,
    origDispatch: (event: Event) => boolean,
  ): boolean {
    const modelNode = this.#ensureModelRecord(target);
    if (!this.#scanningDom && modelNode.site === null) {
      modelNode.site = captureCallsite(0);
    }
    const detail: unknown = Reflect.get(event, "detail");
    const rawModel: unknown =
      detail !== null && typeof detail === "object" && "model" in detail
        ? Reflect.get(detail, "model")
        : target;

    const preview = serializePreview(rawModel);
    const prevTop = this.#causalStack.at(-1);
    const cascadeId = prevTop?.cascadeId ?? this.#nextCascadeId++;

    modelNode.updates += 1;
    modelNode.valuePreview = preview;
    const seq = this.#pushTrace({
      cascadeId,
      durationMs: 0,
      nodeId: modelNode.id,
      kind: "model-update",
      label: `${modelNode.label} model-update`,
      causeNodeId: prevTop ? prevTop.nodeId : null,
      detail: preview.text,
    });
    if (prevTop?.eventType && prevTop.nodeId !== modelNode.id) {
      this.#recordEdge(
        prevTop.nodeId,
        modelNode.id,
        "event-emit",
        prevTop.eventType,
        preview.text,
      );
    }
    modelNode.lastChangedSeq = seq;
    this.#lastModelDispatch = {
      nodeId: modelNode.id,
      cascadeId,
      at: performance.now(),
    };

    this.#causalStack.push({
      nodeId: modelNode.id,
      kind: "model",
      label: modelNode.label,
      cascadeId,
    });
    this.#scheduleNotify();

    try {
      return origDispatch(event);
    } finally {
      this.#causalStack.pop();
    }
  }

  #onViewModelUpdateEvent(
    target: EventTarget,
    event: Event,
    origDispatch: (event: Event) => boolean,
  ): boolean {
    const ctrlNode = this.#ensureControllerRecord(target);
    if (!this.#scanningDom && ctrlNode.site === null) {
      ctrlNode.site = captureCallsite(0);
    }
    this.#scanMemoFields(target, ctrlNode);

    const detail: unknown = Reflect.get(event, "detail");
    const viewModel: unknown =
      detail !== null && typeof detail === "object"
        ? Reflect.get(detail, "viewModel")
        : undefined;
    const preview =
      viewModel !== undefined ? serializePreview(viewModel) : null;

    const modelRef: unknown = Reflect.get(target, "modelManager");
    const prevTop = this.#causalStack.at(-1);
    let causeNodeId: number | null = prevTop?.nodeId ?? null;
    let cascadeId = prevTop?.cascadeId ?? null;

    if (prevTop?.eventType && prevTop.nodeId !== ctrlNode.id) {
      this.#recordEdge(
        prevTop.nodeId,
        ctrlNode.id,
        "event-emit",
        prevTop.eventType,
        null,
      );
    }

    if (modelRef !== null && typeof modelRef === "object") {
      const modelNode = this.#ensureModelRecord(modelRef);
      const edge = this.#recordEdge(
        modelNode.id,
        ctrlNode.id,
        "model-to-controller",
        "model-update",
        null,
      );
      edge.count += 1;
      causeNodeId ??= modelNode.id;
      if (
        cascadeId === null &&
        this.#lastModelDispatch &&
        this.#lastModelDispatch.nodeId === modelNode.id &&
        performance.now() - this.#lastModelDispatch.at < 250
      ) {
        cascadeId = this.#lastModelDispatch.cascadeId;
      }
    }

    const parentCtrl: unknown = Reflect.get(target, "parentController");
    if (parentCtrl !== null && typeof parentCtrl === "object") {
      const parentNode = this.#ensureControllerRecord(parentCtrl);
      this.#recordEdge(
        parentNode.id,
        ctrlNode.id,
        "model-to-controller",
        "view-model",
        null,
      );
    }

    const viewEl: unknown = Reflect.get(target, "view");
    if (viewEl !== null && typeof viewEl === "object") {
      const viewNode = this.#ensureHostOrElementRecord(viewEl);
      if (viewNode) {
        ctrlNode.ownerNodeId = viewNode.id;
        const edge = this.#recordEdge(
          ctrlNode.id,
          viewNode.id,
          "controller-to-element",
          "viewModel",
          preview?.text ?? null,
        );
        edge.count += 1;
      }
    }

    const activeCascadeId = cascadeId ?? this.#nextCascadeId++;
    ctrlNode.updates += 1;
    if (preview) ctrlNode.valuePreview = preview;
    ctrlNode.lastCauseNodeId = causeNodeId;
    ctrlNode.lastCauseLabel = causeNodeId ? `from #${causeNodeId}` : null;

    const seq = this.#pushTrace({
      cascadeId: activeCascadeId,
      durationMs: 0,
      nodeId: ctrlNode.id,
      kind: "controller-transform",
      label: `${ctrlNode.label} view-model-update`,
      causeNodeId,
      detail: preview?.text ?? null,
    });
    ctrlNode.lastChangedSeq = seq;

    this.#causalStack.push({
      nodeId: ctrlNode.id,
      kind: "controller",
      label: ctrlNode.label,
      cascadeId: activeCascadeId,
    });
    this.#scheduleNotify();

    try {
      return origDispatch(event);
    } finally {
      this.#causalStack.pop();
    }
  }

  #onCustomElementEvent(
    target: Element,
    event: CustomEvent<unknown>,
    origDispatch: (event: Event) => boolean,
  ): boolean {
    const elNode = this.#ensureElementRecord(target);
    const cascadeId =
      this.#causalStack.at(-1)?.cascadeId ?? this.#nextCascadeId++;
    const detailPreview = serializePreview(event.detail);

    this.#pushTrace({
      cascadeId,
      durationMs: 0,
      nodeId: elNode.id,
      kind: "custom-event",
      label: `${elNode.label} → ${event.type}`,
      causeNodeId: elNode.id,
      detail: detailPreview.text,
    });

    this.#causalStack.push({
      nodeId: elNode.id,
      kind: "element",
      label: `event '${event.type}'`,
      cascadeId,
      eventType: event.type,
    });
    this.#scheduleNotify();

    try {
      return origDispatch(event);
    } finally {
      this.#causalStack.pop();
    }
  }

  #onControllerAdded(host: object, controller: object): void {
    let set = this.#controllersByHost.get(host);
    if (!set) {
      set = new Set<object>();
      this.#controllersByHost.set(host, set);
    }
    set.add(controller);

    const ctxMeta = isContextProviderLike(controller);
    if (ctxMeta) {
      const contextNode = this.#ensureContextRecord(ctxMeta.contextKey);
      const hostNode = this.#ensureHostOrElementRecord(host);
      if (ctxMeta.isProvider) {
        contextNode.providerHostRef = new WeakRef(host);
        if (!this.#scanningDom && contextNode.site === null) {
          contextNode.site = captureCallsite(0);
        }
        if (hostNode) {
          this.#recordEdge(
            hostNode.id,
            contextNode.id,
            "context-provide",
            "provides",
            null,
          );
          contextNode.lastCauseNodeId = hostNode.id;
          contextNode.lastCauseLabel = `provided by ${hostNode.label}`;
        }
        this.#wrapContextProviderController(controller, host, contextNode);
      } else if (hostNode) {
        this.#recordEdge(
          contextNode.id,
          hostNode.id,
          "context-consume",
          "consume",
          null,
        );
      }
      this.#scheduleNotify();
      return;
    }

    const ctrlNode = this.#ensureControllerRecord(controller);
    ctrlNode.connected = true;
    const hostNode = this.#ensureHostOrElementRecord(host);
    if (hostNode) {
      ctrlNode.ownerNodeId = hostNode.id;
      this.#recordEdge(
        ctrlNode.id,
        hostNode.id,
        "controller-to-element",
        "controller",
        null,
      );
      if (ctrlNode.label.length <= 2) {
        const fieldAlias = findControllerFieldName(host, controller);
        ctrlNode.label = fieldAlias
          ? `${fieldAlias} (${hostNode.label})`
          : `Controller (${hostNode.label})`;
      }
    }
    this.#scanMemoFields(controller, ctrlNode);
    this.#scheduleNotify();
  }

  #scanInternalControllers(host: Element): void {
    // Support late discovery (scanDom) across Lit 2 (__controllers Array) and Lit 3 (_$EO Set)
    for (const key of Object.getOwnPropertyNames(host)) {
      if (key !== "__controllers" && key !== "_$EO") continue;
      const val: unknown = Reflect.get(host, key);
      if (val instanceof Set || Array.isArray(val)) {
        for (const ctrl of val) {
          if (ctrl !== null && typeof ctrl === "object") {
            const set = this.#controllersByHost.get(host);
            if (!set || !set.has(ctrl)) {
              this.#onControllerAdded(host, ctrl);
            }
          }
        }
      }
    }
  }

  #wrapContextProviderController(
    provider: object,
    host: object,
    contextNode: NodeRecord,
  ): void {
    if (this.#wrappedProviders.has(provider)) return;
    this.#wrappedProviders.add(provider);

    contextNode.providerHostRef = new WeakRef(host);
    const hostNode = this.#ensureHostOrElementRecord(host);
    const initialVal: unknown = Reflect.get(provider, "value");
    if (initialVal !== undefined) {
      contextNode.valuePreview = serializePreview(initialVal);
    }

    const origSetValue: unknown = Reflect.get(provider, "setValue");
    if (typeof origSetValue === "function") {
      const __LIT_DEVTOOLS__contextSetValue = (
        target: Function,
        thisArg: unknown,
        argArray: unknown[],
      ): unknown => {
        if (contextNode.site === null) {
          contextNode.site = captureCallsite(0);
        }
        const value: unknown = argArray[0];
        const force = Boolean(argArray[1]);
        const prevValue: unknown =
          thisArg !== null && typeof thisArg === "object"
            ? Reflect.get(thisArg, "value")
            : undefined;
        const changed = force || !Object.is(value, prevValue);

        const preview = serializePreview(value);
        contextNode.valuePreview = preview;
        if (changed) {
          contextNode.updates += 1;
        }

        const top = this.#causalStack.at(-1);
        const cascadeId = top?.cascadeId ?? this.#nextCascadeId++;
        const causeNodeId = top?.nodeId ?? hostNode?.id ?? null;

        contextNode.lastCauseNodeId = causeNodeId;
        contextNode.lastCauseLabel = top
          ? top.label
          : hostNode
            ? `setValue on ${hostNode.label}`
            : null;

        this.#causalStack.push({
          nodeId: causeNodeId ?? contextNode.id,
          kind: "context-push",
          label: `context '${contextNode.label}'`,
          cascadeId,
        });
        this.#scheduleNotify();

        try {
          return Reflect.apply(target, thisArg, argArray);
        } finally {
          this.#causalStack.pop();
        }
      };
      const wrappedSetValue = new Proxy(origSetValue, {
        apply: __LIT_DEVTOOLS__contextSetValue,
      });
      Reflect.set(provider, "setValue", wrappedSetValue);
    }
  }

  #onElementRequestUpdate(
    element: Element,
    name: PropertyKey | undefined,
    oldValue: unknown,
    options: unknown,
    useNewValue?: boolean,
    explicitNewValue?: unknown,
  ): void {
    const record = this.#ensureElementRecord(element);
    if (!this.#scanningDom && record.site === null) {
      record.site = captureCallsite(0);
    }
    const top = this.#causalStack.at(-1);
    const propName = name !== undefined ? String(name) : null;

    const decl = propName
      ? this.#readPropertyDeclaration(element, propName, options)
      : {
          isState: false,
          reflect: false,
          attribute: null,
          typeName: null,
          hasChanged: null,
        };

    const nextRead =
      propName === null
        ? { ok: false as const }
        : useNewValue
          ? { ok: true as const, value: explicitNewValue }
          : safeReadProp(element, propName);

    // Check Lit hasChanged predicate before attributing changes, edges, or traces!
    if (propName !== null && nextRead.ok) {
      const changed = decl.hasChanged
        ? decl.hasChanged(nextRead.value, oldValue)
        : !Object.is(nextRead.value, oldValue);
      if (!changed) {
        return;
      }
    }

    const isPreInitSelfState =
      !Reflect.get(element, "hasUpdated") &&
      decl.isState &&
      top?.kind === "element" &&
      !top.eventType;

    if (top && top.nodeId !== record.id && !isPreInitSelfState) {
      const causeLabel =
        top.kind === "element" && propName && !top.eventType
          ? `prop '${propName}' from ${top.label}`
          : top.label;
      this.#pendingCauses.set(element, {
        causeNodeId: top.nodeId,
        cascadeId: top.cascadeId,
        label: causeLabel,
      });

      if (top.kind === "element" && top.eventType) {
        const edge = this.#recordEdge(
          top.nodeId,
          record.id,
          "event-emit",
          top.eventType,
          null,
        );
        edge.count += 1;
        edge.lastSeq = this.#seq + 1;
      } else if (top.kind === "element" && propName) {
        const nextVal = nextRead.ok ? nextRead.value : undefined;
        const edgeDetail = `${serializePreview(oldValue).text} → ${serializePreview(nextVal).text}`;
        const edge = this.#recordEdge(
          top.nodeId,
          record.id,
          "prop-flow",
          propName,
          edgeDetail,
        );
        edge.count += 1;
        edge.lastSeq = this.#seq + 1;
      }
    } else if (!top) {
      const existingPending = this.#pendingCauses.get(element);
      if (!existingPending || existingPending.causeNodeId === null) {
        const selfCascadeId = this.#nextCascadeId++;
        this.#pendingCauses.set(element, {
          causeNodeId: null,
          cascadeId: selfCascadeId,
          label: propName ? `prop '${propName}'` : "requestUpdate",
        });
      }
    }

    if (!propName) return;

    const propsMap = record.properties ?? new Map<string, PropertyRecord>();
    record.properties = propsMap;

    const nextPreview = nextRead.ok
      ? serializePreview(nextRead.value)
      : serializePreview(undefined);
    const prevPreview = serializePreview(oldValue);

    const pendingOrTopCascade =
      top?.cascadeId ??
      this.#pendingCauses.get(element)?.cascadeId ??
      this.#nextCascadeId++;

    const existing = propsMap.get(propName);
    const seq = this.#pushTrace({
      cascadeId: pendingOrTopCascade,
      durationMs: 0,
      nodeId: record.id,
      kind: "prop-change",
      label: `${record.label}.${propName}`,
      causeNodeId:
        top && top.nodeId !== record.id && !isPreInitSelfState
          ? top.nodeId
          : null,
      detail: `${prevPreview.text} → ${nextPreview.text}`,
    });

    const sourceLabel =
      top && top.nodeId !== record.id && !isPreInitSelfState
        ? top.kind === "element" && !top.eventType
          ? `prop from ${top.label}`
          : top.label
        : (existing?.sourceLabel ?? null);

    propsMap.set(propName, {
      name: propName,
      isState: decl.isState,
      reflect: decl.reflect,
      attribute: decl.attribute,
      typeName: decl.typeName,
      value: nextPreview,
      prevValue: prevPreview,
      changes: (existing?.changes ?? 0) + 1,
      lastChangedSeq: seq,
      sourceLabel,
    });
    record.lastChangedSeq = seq;
    this.#scheduleNotify();
  }

  #syncChangedPropertiesMap(
    record: NodeRecord,
    element: Element,
    changed: Map<PropertyKey, unknown>,
  ): void {
    const propsMap = record.properties ?? new Map<string, PropertyRecord>();
    record.properties = propsMap;

    for (const [key, prevVal] of changed.entries()) {
      const propName = String(key);
      const existing = propsMap.get(propName);
      const read = safeReadProp(element, propName);
      const nextPreview = read.ok
        ? serializePreview(read.value)
        : serializePreview(undefined);
      const decl = this.#readPropertyDeclaration(element, propName, undefined);
      propsMap.set(propName, {
        name: propName,
        isState: existing?.isState ?? decl.isState,
        reflect: existing?.reflect ?? decl.reflect,
        attribute: existing?.attribute ?? decl.attribute,
        typeName: existing?.typeName ?? decl.typeName,
        value: nextPreview,
        prevValue: serializePreview(prevVal),
        changes: existing?.changes ?? 1,
        lastChangedSeq: existing?.lastChangedSeq ?? this.#seq,
        sourceLabel: existing?.sourceLabel ?? null,
      });
    }
  }

  #readPropertyDeclaration(
    element: Element,
    propName: string,
    inlineOptions: unknown,
  ): {
    isState: boolean;
    reflect: boolean;
    attribute: string | null;
    typeName: string | null;
    hasChanged: ((next: unknown, prev: unknown) => boolean) | null;
  } {
    const ctor: unknown = element.constructor;
    let decl: unknown = inlineOptions;
    if (!decl && typeof ctor === "function") {
      const elProps: unknown = Reflect.get(ctor, "elementProperties");
      if (elProps instanceof Map) {
        decl = elProps.get(propName);
      }
    }
    if (decl === null || typeof decl !== "object") {
      return {
        isState: false,
        reflect: false,
        attribute: propName,
        typeName: null,
        hasChanged: null,
      };
    }
    const isState = Boolean(Reflect.get(decl, "state"));
    const reflect = Boolean(Reflect.get(decl, "reflect"));
    const rawAttr: unknown = Reflect.get(decl, "attribute");
    const attribute =
      rawAttr === false
        ? null
        : typeof rawAttr === "string"
          ? rawAttr
          : isState
            ? null
            : propName.toLowerCase();
    const typeName = formatTypeName(Reflect.get(decl, "type"));
    const rawHasChanged: unknown = Reflect.get(decl, "hasChanged");
    const hasChanged =
      typeof rawHasChanged === "function"
        ? (next: unknown, prev: unknown) =>
            Boolean(Reflect.apply(rawHasChanged, decl, [next, prev]))
        : null;
    return { isState, reflect, attribute, typeName, hasChanged };
  }

  #refreshElementPropertyValues(record: NodeRecord, element: Element): void {
    const ctor: unknown = element.constructor;
    if (typeof ctor !== "function") return;
    const elProps: unknown = Reflect.get(ctor, "elementProperties");
    if (!(elProps instanceof Map)) return;

    const propsMap = record.properties ?? new Map<string, PropertyRecord>();
    record.properties = propsMap;

    for (const [key, decl] of elProps.entries()) {
      const propName = String(key);
      const read = safeReadProp(element, propName);
      const preview = read.ok
        ? serializePreview(read.value)
        : serializePreview("[Unreadable]");
      const existing = propsMap.get(propName);
      const meta = this.#readPropertyDeclaration(element, propName, decl);
      propsMap.set(propName, {
        name: propName,
        isState: meta.isState,
        reflect: meta.reflect,
        attribute: meta.attribute,
        typeName: meta.typeName,
        value: preview,
        prevValue: existing?.prevValue ?? null,
        changes: existing?.changes ?? 0,
        lastChangedSeq: existing?.lastChangedSeq ?? 0,
        sourceLabel: existing?.sourceLabel ?? null,
      });
    }
  }

  #scanMemoFields(owner: object, ownerRecord: NodeRecord): void {
    if (this.#wrappedMemoTargets.has(owner)) return;
    this.#wrappedMemoTargets.add(owner);

    for (const key of Object.keys(owner)) {
      const desc = Object.getOwnPropertyDescriptor(owner, key);
      if (!desc || !desc.writable || !("value" in desc)) continue;
      const val: unknown = desc.value;
      if (!isMemoizeOneFunction(val, key)) continue;

      const role = inferMemoRole(key);
      const wrapped = this.#wrapMemoField(val, ownerRecord, key, role);
      Reflect.set(owner, key, wrapped);
    }
  }

  #scanControllerRefsOnObject(owner: object, ownerRecord: NodeRecord): void {
    for (const key of Object.keys(owner)) {
      if (
        key === "renderRoot" ||
        key === "shadowRoot" ||
        key === "parentElement"
      )
        continue;
      const read = safeReadProp(owner, key);
      if (!read.ok) continue;
      const val = read.value;
      if (
        val === null ||
        typeof val !== "object" ||
        isElement(val) ||
        isNode(val)
      )
        continue;
      if (val instanceof Map || val instanceof Set || Array.isArray(val))
        continue;

      const isCtrlLike =
        key.toLowerCase().includes("controller") ||
        typeof Reflect.get(val, "_transform") === "function" ||
        Reflect.get(val, "view") === owner;

      if (isCtrlLike) {
        const ctrlNode = this.#ensureControllerRecord(val);
        ctrlNode.ownerNodeId = ownerRecord.id;
        if (
          ctrlNode.label.length <= 2 ||
          ctrlNode.label.startsWith("Controller (")
        ) {
          ctrlNode.label = `${key} (${ownerRecord.label})`;
        }
        this.#recordEdge(
          ctrlNode.id,
          ownerRecord.id,
          "controller-to-element",
          key,
          null,
        );
        this.#scanMemoFields(val, ctrlNode);
        const modelRef: unknown = Reflect.get(val, "modelManager");
        if (modelRef !== null && typeof modelRef === "object") {
          const modelNode = this.#ensureModelRecord(modelRef);
          this.#recordEdge(
            modelNode.id,
            ctrlNode.id,
            "model-to-controller",
            "modelManager",
            null,
          );
        }
      }
    }
  }

  #extractMemoFromOwner(
    owner: object | undefined,
    fieldName: string,
  ): { readonly source: string; readonly signature: string } | null {
    if (!owner) return null;
    let ctor: unknown = Reflect.get(owner, "constructor");

    while (isUserConstructor(ctor)) {
      let cached = this.#ctorSourceCache.get(ctor);
      if (cached === undefined) {
        cached = null;
        try {
          const raw = Function.prototype.toString.call(ctor);
          if (
            raw.length <= MAX_CTOR_SOURCE_CHARS &&
            !raw.includes("[native code]")
          ) {
            cached = raw;
          }
        } catch {
          cached = null;
        }
        this.#ctorSourceCache.set(ctor, cached);
      }

      if (cached !== null) {
        const extracted = extractMemoFromCtorSource(cached, fieldName);
        if (extracted) return extracted;
      }

      const nextCtor: unknown = Object.getPrototypeOf(ctor);
      if (!isCallableFn(nextCtor)) break;
      ctor = nextCtor;
    }
    return null;
  }

  #wrapControllerTransform(controller: object): void {
    let holder: object | null = null;
    if (Object.hasOwn(controller, "_transform")) {
      holder = controller;
    } else {
      let cursor: object | null = Object.getPrototypeOf(controller);
      const stopEvt =
        typeof EventTarget !== "undefined" ? EventTarget.prototype : null;
      while (cursor && cursor !== Object.prototype && cursor !== stopEvt) {
        if (Object.hasOwn(cursor, "_transform")) {
          holder = cursor;
          break;
        }
        cursor = Object.getPrototypeOf(cursor);
      }
    }
    if (!holder) return;

    const desc = Object.getOwnPropertyDescriptor(holder, "_transform");
    if (
      !desc ||
      typeof desc.value !== "function" ||
      this.#wrappedMethods.has(desc.value)
    ) {
      return;
    }
    if (!desc.writable && !desc.configurable) return;

    const origTransform: Function = desc.value;
    const __LIT_DEVTOOLS__controllerTransform = (
      target: Function,
      thisArg: unknown,
      argArray: unknown[],
    ): unknown => {
      if (thisArg === null || typeof thisArg !== "object") {
        return Reflect.apply(target, thisArg, argArray);
      }
      const ctrlNode = this.#ensureControllerRecord(thisArg);
      if (ctrlNode.site === null) {
        ctrlNode.site = captureCallsite(0);
      }
      this.#scanMemoFields(thisArg, ctrlNode);
      const cascadeId = this.#currentCascadeId();
      this.#causalStack.push({
        nodeId: ctrlNode.id,
        kind: "controller",
        label: ctrlNode.label,
        cascadeId,
        phase: "_transform",
      });
      try {
        return Reflect.apply(target, thisArg, argArray);
      } finally {
        this.#causalStack.pop();
      }
    };
    const wrapped = new Proxy(origTransform, {
      apply: __LIT_DEVTOOLS__controllerTransform,
    });
    this.#wrappedMethods.add(wrapped);
    if (isCallableFn(origTransform)) {
      this.#origFnByWrapped.set(wrapped, origTransform);
    }
    Reflect.set(holder, "_transform", wrapped);
  }

  #wrapMemoField<T extends MemoizedFunctionLike>(
    fn: T,
    ownerRecord: NodeRecord,
    fieldName: string,
    role: "computed" | "observer",
  ): T {
    const existingId = this.#idByObject.get(fn);
    if (existingId !== undefined) return fn;

    const ownerInst = ownerRecord.ref.deref();
    const layerA = this.#extractMemoFromOwner(ownerInst, fieldName);

    const memoId = this.#nextNodeId++;
    const record: NodeRecord = {
      id: memoId,
      kind: role,
      ref: new WeakRef(fn),
      label: fieldName,
      subtitle: ownerRecord.label,
      site: ownerRecord.site,
      connected: ownerRecord.connected,
      ownerNodeId: ownerRecord.id,
      updates: 0,
      hits: 0,
      misses: 0,
      vetoes: 0,
      lastDurationMs: null,
      lastChangedSeq: 0,
      lastCauseLabel: null,
      lastCauseNodeId: ownerRecord.id,
      valuePreview: null,
      error: null,
      computeSource: layerA?.source ?? null,
      computeSignature: layerA?.signature ?? null,
    };

    const edgeKind: EdgeKind =
      role === "computed" ? "memo-compute" : "memo-observe";
    const edge = this.#recordEdge(
      ownerRecord.id,
      memoId,
      edgeKind,
      role === "computed" ? "computes" : "observes",
      null,
    );

    const wrapped = wrapMemoizedFunction(
      fn,
      (call) => {
        if (record.site === null) {
          record.site = captureCallsite(0);
        }
        if (ownerRecord.site === null && record.site) {
          ownerRecord.site = record.site;
        }
        if (call.innerFn && !record.innerMemoFnRef?.deref()) {
          record.innerMemoFnRef = new WeakRef(call.innerFn);
          try {
            const rawInner = Function.prototype.toString.call(call.innerFn);
            const layerB = normalizeMemoSource(rawInner);
            if (layerB) {
              record.computeSource = layerB.source;
              record.computeSignature = layerB.signature;
            }
          } catch {
            // Ignore unreadable innerFn.toString()
          }
        }

        const top = this.#causalStack.at(-1);
        const phase =
          top?.nodeId === ownerRecord.id
            ? top.phase
            : this.#activeLifecyclePhase.get(ownerRecord.ref.deref() ?? {});
        const cascadeId = top?.cascadeId ?? this.#nextCascadeId++;

        record.updates += 1;
        record.lastDurationMs = call.durationMs;
        record.lastArgs = call.args.map((arg) => serializePreview(arg));

        if (call.error !== undefined) {
          record.misses += 1;
          record.error = formatErrorMessage(call.error);
          const seq = this.#pushTrace({
            cascadeId,
            durationMs: call.durationMs,
            nodeId: memoId,
            kind: "error",
            label: `${ownerRecord.label}.${fieldName}`,
            causeNodeId: ownerRecord.id,
            detail: record.error,
          });
          record.lastChangedSeq = seq;
          edge.count += 1;
          edge.lastSeq = seq;
          edge.lastDetail = record.error;
          this.#scheduleNotify();
          return;
        }

        record.error = null;
        if (call.hit) {
          record.hits += 1;
          if (this.#settings.captureMemoHits) {
            this.#pushTrace({
              cascadeId,
              durationMs: call.durationMs,
              nodeId: memoId,
              kind: "memo-hit",
              label: `${fieldName} (HIT)`,
              causeNodeId: ownerRecord.id,
              detail: phase ? `in ${phase}` : null,
            });
          }
        } else {
          record.misses += 1;
          const preview = serializePreview(call.result);
          record.valuePreview = role === "computed" ? preview : null;
          const seq = this.#pushTrace({
            cascadeId,
            durationMs: call.durationMs,
            nodeId: memoId,
            kind: "memo-miss",
            label: `${fieldName} (MISS)`,
            causeNodeId: ownerRecord.id,
            detail:
              role === "computed"
                ? preview.text
                : phase
                  ? `side-effect in ${phase}`
                  : "side-effect",
          });
          record.lastChangedSeq = seq;
          edge.count += 1;
          edge.lastSeq = seq;
          edge.lastDetail = `misses: ${record.misses} · hits: ${record.hits}`;
        }
        this.#scheduleNotify();
      },
      () => {
        record.valuePreview = null;
        this.#scheduleNotify();
      },
    );

    record.clearMemoFn = () => wrapped.clear?.();
    this.#nodesById.set(memoId, record);
    this.#idByObject.set(fn, memoId);
    this.#idByObject.set(wrapped, memoId);
    this.#finalizer.register(wrapped, memoId);
    return wrapped;
  }

  #ensureElementRecord(element: Element): NodeRecord {
    const existingId = this.#idByObject.get(element);
    if (existingId !== undefined) {
      const existing = this.#nodesById.get(existingId);
      if (existing) {
        if (!this.#scanningDom && existing.site === null) {
          const ctor: unknown = element.constructor;
          existing.site =
            typeof ctor === "function"
              ? (this.#defineSites.get(ctor) ?? null)
              : null;
        }
        return existing;
      }
    }

    const id = this.#nextNodeId++;
    const tag = (element.tagName ?? "element").toLowerCase();
    const explicitLabel = this.#deferredLabels.get(element);
    const trimmedId = (element.id ?? "").trim();
    const idAttr = trimmedId ? `#${trimmedId}` : null;
    const label = explicitLabel ?? (idAttr ? `${tag}${idAttr}` : tag);
    const ctor: unknown = element.constructor;
    const site =
      typeof ctor === "function" ? (this.#defineSites.get(ctor) ?? null) : null;
    const rootType = this.#resolveRootType(element);

    const record: NodeRecord = {
      id,
      kind: "element",
      ref: new WeakRef(element),
      label,
      subtitle: getCtorName(element),
      site,
      connected: element.isConnected,
      tagName: tag,
      ...(explicitLabel ? { explicitLabel } : {}),
      disambiguator: explicitLabel ? null : idAttr,
      updates: 0,
      hits: 0,
      misses: 0,
      vetoes: 0,
      lastDurationMs: null,
      lastChangedSeq: 0,
      lastCauseLabel: null,
      lastCauseNodeId: null,
      valuePreview: null,
      error: null,
      rootType,
      properties: new Map(),
    };

    this.#refreshElementPropertyValues(record, element);
    this.#nodesById.set(id, record);
    this.#idByObject.set(element, id);
    this.#finalizer.register(element, id);
    record.domParentNodeId = this.#resolveDomParentNodeId(element);
    return record;
  }

  #ensureHostOrElementRecord(host: object): NodeRecord | null {
    if (isElement(host)) {
      return this.#ensureElementRecord(host);
    }
    const existingId = this.#idByObject.get(host);
    if (existingId !== undefined) {
      return this.#nodesById.get(existingId) ?? null;
    }
    return this.#ensureControllerRecord(host);
  }

  #ensureModelRecord(model: object, explicitName?: string): NodeRecord {
    const existingId = this.#idByObject.get(model);
    if (existingId !== undefined) {
      const existing = this.#nodesById.get(existingId);
      if (existing) {
        if (!this.#scanningDom && existing.site === null) {
          existing.site = captureCallsite(0);
        }
        return existing;
      }
    }

    const id = this.#nextNodeId++;
    const label =
      explicitName ?? this.#deferredLabels.get(model) ?? getCtorName(model);
    const record: NodeRecord = {
      id,
      kind: "model",
      ref: new WeakRef(model),
      label,
      subtitle: "Model",
      site: this.#scanningDom ? null : captureCallsite(0),
      connected: true,
      updates: 0,
      hits: 0,
      misses: 0,
      vetoes: 0,
      lastDurationMs: null,
      lastChangedSeq: 0,
      lastCauseLabel: null,
      lastCauseNodeId: null,
      valuePreview: null,
      error: null,
    };
    this.#nodesById.set(id, record);
    this.#idByObject.set(model, id);
    this.#finalizer.register(model, id);
    return record;
  }

  #ensureControllerRecord(
    controller: object,
    explicitName?: string,
  ): NodeRecord {
    const existingId = this.#idByObject.get(controller);
    if (existingId !== undefined) {
      const existing = this.#nodesById.get(existingId);
      if (existing) {
        if (!this.#scanningDom && existing.site === null) {
          existing.site = captureCallsite(0);
        }
        this.#wrapControllerTransform(controller);
        return existing;
      }
    }

    const id = this.#nextNodeId++;
    const label =
      explicitName ??
      this.#deferredLabels.get(controller) ??
      getCtorName(controller);
    const record: NodeRecord = {
      id,
      kind: "controller",
      ref: new WeakRef(controller),
      label,
      subtitle: "Controller",
      site: this.#scanningDom ? null : captureCallsite(0),
      connected: true,
      updates: 0,
      hits: 0,
      misses: 0,
      vetoes: 0,
      lastDurationMs: null,
      lastChangedSeq: 0,
      lastCauseLabel: null,
      lastCauseNodeId: null,
      valuePreview: null,
      error: null,
    };
    this.#nodesById.set(id, record);
    this.#idByObject.set(controller, id);
    this.#finalizer.register(controller, id);
    this.#wrapControllerTransform(controller);
    return record;
  }

  #ensureContextRecord(contextKey: unknown): NodeRecord {
    if (typeof contextKey === "object" && contextKey !== null) {
      const existingObjId = this.#objectContextIds.get(contextKey);
      if (existingObjId !== undefined) {
        const existing = this.#nodesById.get(existingObjId);
        if (existing) return existing;
      }
      const id = this.#nextNodeId++;
      const record: NodeRecord = {
        id,
        kind: "context",
        ref: new WeakRef(contextKey),
        label: formatContextKeyLabel(contextKey),
        subtitle: "Context",
        site: null,
        connected: true,
        updates: 0,
        hits: 0,
        misses: 0,
        vetoes: 0,
        lastDurationMs: null,
        lastChangedSeq: 0,
        lastCauseLabel: null,
        lastCauseNodeId: null,
        valuePreview: null,
        error: null,
      };
      this.#nodesById.set(id, record);
      this.#objectContextIds.set(contextKey, id);
      this.#finalizer.register(contextKey, id);
      return record;
    }

    const primKey: string | symbol =
      typeof contextKey === "symbol" ? contextKey : String(contextKey);
    const existingId = this.#primitiveContextIds.get(primKey);
    if (existingId !== undefined) {
      const existing = this.#nodesById.get(existingId);
      if (existing) return existing;
    }

    const id = this.#nextNodeId++;
    const anchor = { contextKey: primKey };
    this.#contextAnchors.set(id, anchor);
    const record: NodeRecord = {
      id,
      kind: "context",
      ref: new WeakRef(anchor),
      label: formatContextKeyLabel(primKey),
      subtitle: typeof primKey === "symbol" ? "Symbol context" : "Context",
      site: null,
      connected: true,
      updates: 0,
      hits: 0,
      misses: 0,
      vetoes: 0,
      lastDurationMs: null,
      lastChangedSeq: 0,
      lastCauseLabel: null,
      lastCauseNodeId: null,
      valuePreview: null,
      error: null,
    };
    this.#nodesById.set(id, record);
    this.#primitiveContextIds.set(primKey, id);
    return record;
  }

  #recordEdge(
    sourceId: number,
    targetId: number,
    kind: EdgeKind,
    label: string | null,
    detail: string | null,
  ): EdgeRecord {
    const edgeId = `${sourceId}->${targetId}:${kind}:${label ?? ""}`;
    const existing = this.#edges.get(edgeId);
    if (existing) {
      if (detail !== null) existing.lastDetail = detail;
      return existing;
    }
    const edge: EdgeRecord = {
      id: edgeId,
      sourceId,
      targetId,
      kind,
      label,
      count: 1,
      lastSeq: this.#seq,
      lastDetail: detail,
    };
    this.#edges.set(edgeId, edge);
    return edge;
  }

  #pushTrace(entry: Omit<TraceEvent, "seq" | "timestamp">): number {
    const seq = ++this.#seq;
    if (this.#recordingTraces && !this.#settings.paused) {
      this.#events.push({
        seq,
        timestamp: highResTimestamp(),
        ...entry,
      });
      this.#trimEventHistory();
    }
    return seq;
  }

  #pushTraceMutable(
    entry: Omit<TraceEvent, "seq" | "timestamp">,
  ): TraceEvent | null {
    const seq = ++this.#seq;
    if (!this.#recordingTraces || this.#settings.paused) {
      return null;
    }
    const evt: TraceEvent = {
      seq,
      timestamp: highResTimestamp(),
      ...entry,
    };
    this.#events.push(evt);
    this.#trimEventHistory();
    return evt;
  }

  #patchTraceDuration(seq: number, durationMs: number): void {
    for (let i = this.#events.length - 1; i >= 0; i--) {
      const evt = this.#events[i];
      if (!evt) continue;
      if (evt.seq === seq) {
        this.#events[i] = { ...evt, durationMs };
        return;
      }
      if (evt.seq < seq) return;
    }
  }

  #trimEventHistory(): void {
    if (this.#events.length > MAX_EVENTS) {
      const overflow = this.#events.length - MAX_EVENTS;
      this.#events.splice(0, overflow);
      this.#droppedEvents += overflow;
      this.#baseSeq = this.#events[0]?.seq
        ? this.#events[0].seq - 1
        : this.#seq;
    }
  }

  #currentCascadeId(): number {
    return this.#causalStack.at(-1)?.cascadeId ?? this.#nextCascadeId++;
  }

  #removeNode(nodeId: number): void {
    this.#nodesById.delete(nodeId);
    this.#contextAnchors.delete(nodeId);
    for (const [edgeId, edge] of this.#edges.entries()) {
      if (edge.sourceId === nodeId || edge.targetId === nodeId) {
        this.#edges.delete(edgeId);
      }
    }
  }

  #scheduleNotify(): void {
    if (this.#listeners.size === 0 || this.#notifyScheduled) return;
    this.#notifyScheduled = true;
    queueMicrotask(() => {
      this.#notifyScheduled = false;
      for (const listener of this.#listeners) {
        try {
          listener();
        } catch {
          // Listener failure must never disrupt user app rendering
        }
      }
    });
  }
}
