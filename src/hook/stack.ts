import type { SourceLocation } from "../protocol/types.ts";
import {
  captureCallsite as captureSharedCallsite,
  compileIgnoreMatchers,
  parseStackLocation as parseSharedStackLocation,
} from "../shared/stack.ts";

const DEFAULT_IGNORED_PATTERNS = compileIgnoreMatchers([
  /\/node_modules\//,
  /^chrome-extension:\/\//,
  /lit-reactivity-devtools\/src\/(hook|client|shared)\//,
]);

const TRACKER_PRIVATE_METHODS = new Set([
  "#ensureElementRecord",
  "#ensureHostOrElementRecord",
  "#ensureModelRecord",
  "#ensureControllerRecord",
  "#ensureContextRecord",
  "#instrumentLitClass",
  "#wrapReactiveElementBase",
  "#wrapSubclassHooks",
  "#wrapMemoField",
  "#wrapControllerTransform",
  "#wrapContextProviderController",
  "#scanMemoFields",
  "#scanControllerRefsOnObject",
  "#scanInternalControllers",
  "#onElementRequestUpdate",
  "#onContextRequestEvent",
  "#onContextProviderEvent",
  "#onModelUpdateEvent",
  "#onViewModelUpdateEvent",
  "#onCustomElementEvent",
  "#onControllerAdded",
]);

const isLitInternalFn = (fn: string): boolean =>
  fn.includes("__LIT_DEVTOOLS__") ||
  fn.includes("wrappedDefine") ||
  fn.includes("wrapMemoizedFunction") ||
  fn.includes("captureCallsite") ||
  fn.includes("LitReactivityTracker") ||
  fn.includes("createLitDevtoolsHook") ||
  TRACKER_PRIVATE_METHODS.has(fn);

export function parseStackLocation(
  stack: string | undefined,
  ignoredMatchers: ReadonlyArray<RegExp> = DEFAULT_IGNORED_PATTERNS,
  skipFrames = 0,
): SourceLocation | null {
  return parseSharedStackLocation(stack, {
    ignoredMatchers,
    internalFnTest: isLitInternalFn,
    skipFrames,
    normalizeInitializerFrames: true,
  });
}

export function captureCallsite(skipFrames = 0): SourceLocation | null {
  return captureSharedCallsite({
    ignoredMatchers: DEFAULT_IGNORED_PATTERNS,
    internalFnTest: isLitInternalFn,
    skipFrames,
    normalizeInitializerFrames: true,
  });
}
