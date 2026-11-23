import type { LitDevtoolsHook } from "../protocol/types.ts";
import { LitReactivityTracker } from "./lit-tracker.ts";

export const GLOBAL_HOOK_KEY = "__LIT_DEVTOOLS_HOOK__" as const;

export function createLitDevtoolsHook(
  autoInstall = true,
  hookOpts?: { readonly traceInitially?: boolean },
): LitDevtoolsHook {
  const tracker = new LitReactivityTracker();
  if (hookOpts?.traceInitially === false) {
    tracker.setTraceRecording(false);
  }
  if (autoInstall) {
    tracker.install();
  }

  return {
    version: 1,
    ...(hookOpts?.traceInitially === false
      ? {
          __setTraceRecording(active: boolean) {
            tracker.setTraceRecording(active);
          },
        }
      : {}),
    registerModel(model, options) {
      return tracker.registerModel(model, options);
    },
    registerController(controller, options) {
      return tracker.registerController(controller, options);
    },
    label(target, name) {
      return tracker.label(target, name);
    },
    traceMemoized(fn, owner, name, role) {
      return tracker.traceMemoized(fn, owner, name, role);
    },
    scanDom() {
      tracker.scanDom();
    },
    snapshot(sinceSeq) {
      return tracker.snapshot(sinceSeq);
    },
    setProperty(nodeId, propName, jsonText) {
      return tracker.setProperty(nodeId, propName, jsonText);
    },
    clearMemoCache(nodeId) {
      return tracker.clearMemoCache(nodeId);
    },
    logToConsole(nodeId) {
      return tracker.logToConsole(nodeId);
    },
    highlightElement(nodeId) {
      tracker.highlightElement(nodeId);
    },
    getElementById(nodeId) {
      return tracker.getElementById(nodeId);
    },
    selectElementFromElementsPanel(el) {
      return tracker.selectElementFromElementsPanel(el);
    },
    configure(settings) {
      tracker.configure(settings);
    },
    clearEvents() {
      tracker.clearEvents();
    },
    subscribe(listener) {
      return tracker.subscribe(listener);
    },
  };
}

function isLitHookV1(value: unknown): value is LitDevtoolsHook {
  return (
    value !== null &&
    typeof value === "object" &&
    Reflect.get(value, "version") === 1 &&
    typeof Reflect.get(value, "snapshot") === "function"
  );
}

export function getOrInstallGlobalHook(options?: {
  readonly traceInitially?: boolean;
}): LitDevtoolsHook {
  const host = globalThis as Record<string, unknown>;
  const existing = host[GLOBAL_HOOK_KEY];
  if (isLitHookV1(existing)) {
    return existing;
  }
  const hook = createLitDevtoolsHook(true, options);
  host[GLOBAL_HOOK_KEY] = hook;
  return hook;
}
