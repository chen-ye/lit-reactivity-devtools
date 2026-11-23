export interface MemoizedFunctionLike {
  (...args: never[]): unknown;
  clear?: () => void;
}

export interface MemoCallEvent {
  readonly hit: boolean;
  readonly durationMs: number;
  readonly args: ReadonlyArray<unknown>;
  readonly result: unknown;
  readonly error?: unknown;
}

export function isMemoizeOneFunction(
  value: unknown,
  propKey = "",
): value is MemoizedFunctionLike {
  if (typeof value !== "function") return false;
  if (!Object.hasOwn(value, "clear")) return false;
  const clearFn: unknown = Reflect.get(value, "clear");
  if (typeof clearFn !== "function") return false;
  // Detect memoize-one in both unminified (name === "memoized", clear.name === "clear") and minified bundles
  return (
    value.name === "memoized" ||
    clearFn.name === "clear" ||
    /^(?:_)?(compute|observe|select|memo)/i.test(propKey)
  );
}

export function inferMemoRole(name: string): "computed" | "observer" {
  const lower = name.toLowerCase();
  if (lower.startsWith("_observe") || lower.startsWith("observe")) {
    return "observer";
  }
  return "computed";
}

function memoEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return (
    typeof a === "number" &&
    typeof b === "number" &&
    Number.isNaN(a) &&
    Number.isNaN(b)
  );
}

export function areMemoArgsEqual(
  prevArgs: ReadonlyArray<unknown>,
  nextArgs: ReadonlyArray<unknown>,
): boolean {
  if (prevArgs.length !== nextArgs.length) return false;
  for (let i = 0; i < prevArgs.length; i++) {
    if (!memoEqual(prevArgs[i], nextArgs[i])) {
      return false;
    }
  }
  return true;
}

export function wrapMemoizedFunction<T extends MemoizedFunctionLike>(
  fn: T,
  onCall: (event: MemoCallEvent) => void,
  onClear?: () => void,
): T {
  let hasLast = false;
  let lastThis: unknown = undefined;
  let lastArgs: unknown[] = [];

  const origClear = fn.clear;
  const wrappedClear = () => {
    hasLast = false;
    lastThis = undefined;
    lastArgs = [];
    origClear?.call(fn);
    onClear?.();
  };

  return new Proxy(fn, {
    apply(target, thisArg, argArray) {
      const startMs = performance.now();
      const predictedHit =
        hasLast &&
        memoEqual(lastThis, thisArg) &&
        areMemoArgsEqual(lastArgs, argArray);

      try {
        const result: unknown = Reflect.apply(target, thisArg, argArray);
        const durationMs = performance.now() - startMs;
        hasLast = true;
        lastThis = thisArg;
        lastArgs = [...argArray];
        onCall({
          hit: predictedHit,
          durationMs,
          args: argArray,
          result,
        });
        return result;
      } catch (err) {
        const durationMs = performance.now() - startMs;
        onCall({
          hit: false,
          durationMs,
          args: argArray,
          result: undefined,
          error: err,
        });
        throw err;
      }
    },
    get(target, prop, receiver) {
      if (prop === "clear") {
        return wrappedClear;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
