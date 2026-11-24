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
  readonly innerFn?: ((...args: never[]) => unknown) | undefined;
}

const innerApplyListeners = new WeakMap<
  (...args: never[]) => unknown,
  Set<() => void>
>();

function isCallableFn(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

function looksLikeMemoizeOneTarget(fn: (...args: never[]) => unknown): boolean {
  try {
    const src = Function.prototype.toString.call(fn);
    return (
      /\.lastThis\s*===\s*this\b/.test(src) ||
      (/\blastThis\b/.test(src) && /\.apply\s*\(/.test(src))
    );
  } catch {
    return false;
  }
}

function installOwnApplySpy(
  innerFn: (...args: never[]) => unknown,
  fallbackApply: (...args: never[]) => unknown,
): boolean {
  if (innerApplyListeners.has(innerFn)) {
    return true;
  }
  try {
    const existingDesc = Object.getOwnPropertyDescriptor(innerFn, "apply");
    let forwardApply: unknown = fallbackApply;
    if (existingDesc) {
      if (!existingDesc.configurable) {
        return false;
      }
      if (typeof existingDesc.value === "function") {
        forwardApply = existingDesc.value;
      }
    } else if (!Object.isExtensible(innerFn)) {
      return false;
    }

    const listeners = new Set<() => void>();
    innerApplyListeners.set(innerFn, listeners);

    const spyApply = function __LIT_DEVTOOLS__innerApply(
      this: unknown,
      thisArg: unknown,
      argsArray?: unknown,
    ): unknown {
      for (const markMiss of listeners) {
        markMiss();
      }
      const applyTarget = isCallableFn(forwardApply)
        ? forwardApply
        : fallbackApply;
      return argsArray === undefined
        ? Reflect.apply(applyTarget, this, [thisArg])
        : Reflect.apply(applyTarget, this, [thisArg, argsArray]);
    };

    Object.defineProperty(innerFn, "apply", {
      configurable: true,
      writable: true,
      value: spyApply,
    });
    return true;
  } catch {
    innerApplyListeners.delete(innerFn);
    return false;
  }
}

function sameArgs(
  innerArgs: unknown,
  outerArgs: ReadonlyArray<unknown>,
): boolean {
  if (innerArgs === undefined || innerArgs === null) {
    return outerArgs.length === 0;
  }
  if (Array.isArray(innerArgs)) {
    if (innerArgs.length !== outerArgs.length) return false;
    for (let i = 0; i < outerArgs.length; i++) {
      if (!Object.is(innerArgs[i], outerArgs[i])) {
        return false;
      }
    }
    return true;
  }
  if (typeof innerArgs !== "object") {
    return false;
  }
  const len: unknown = Reflect.get(innerArgs, "length");
  if (typeof len !== "number" || len !== outerArgs.length) {
    return false;
  }
  for (let i = 0; i < outerArgs.length; i++) {
    if (!Object.is(Reflect.get(innerArgs, i), outerArgs[i])) {
      return false;
    }
  }
  return true;
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
  let capturedInnerFn: ((...args: never[]) => unknown) | null = null;
  let ownSpyInstalled = false;
  let trapDisarmed = false;
  let wrappedRef: T | null = null;
  const isMemoOneTarget = looksLikeMemoizeOneTarget(fn);

  const origClear = fn.clear;
  const wrappedClear = () => {
    hasLast = false;
    lastThis = undefined;
    lastArgs = [];
    origClear?.call(fn);
    onClear?.();
  };

  const wrapped: T = new Proxy(fn, {
    apply: function __LIT_DEVTOOLS__memoApply(target, thisArg, argArray) {
      const startMs = performance.now();
      const origApply: unknown = Reflect.get(Function.prototype, "apply");
      const trapWasArmed =
        capturedInnerFn === null && !trapDisarmed && isCallableFn(origApply);
      let trapInstalled = false;
      let innerRan = false;
      const markInnerMiss = (): void => {
        innerRan = true;
      };

      const captureTarget = (fnRef: (...args: never[]) => unknown): void => {
        capturedInnerFn = fnRef;
        innerRan = true;
        if (isCallableFn(origApply)) {
          ownSpyInstalled = installOwnApplySpy(fnRef, origApply);
        }
      };

      const trappedApply = function (
        this: unknown,
        innerThis: unknown,
        innerArgs?: unknown,
      ): unknown {
        if (
          capturedInnerFn === null &&
          isCallableFn(this) &&
          this !== target &&
          this !== wrappedRef &&
          this !== origApply &&
          Object.is(innerThis, thisArg) &&
          sameArgs(innerArgs, argArray)
        ) {
          captureTarget(this);
          Reflect.set(Function.prototype, "apply", origApply);
        }
        if (!isCallableFn(origApply)) {
          return undefined;
        }
        return innerArgs === undefined
          ? Reflect.apply(origApply, this, [innerThis])
          : Reflect.apply(origApply, this, [innerThis, innerArgs]);
      };

      const activeListeners =
        capturedInnerFn && ownSpyInstalled
          ? innerApplyListeners.get(capturedInnerFn)
          : undefined;
      activeListeners?.add(markInnerMiss);

      if (trapWasArmed && isCallableFn(origApply)) {
        try {
          trapInstalled = Reflect.set(
            Function.prototype,
            "apply",
            trappedApply,
          );
          if (!trapInstalled) {
            trapDisarmed = true;
          }
        } catch {
          trapInstalled = false;
          trapDisarmed = true;
        }
      }

      try {
        const result: unknown = Reflect.apply(target, thisArg, argArray);
        const durationMs = performance.now() - startMs;

        if (capturedInnerFn === null && !isMemoOneTarget) {
          trapDisarmed = true;
        }

        let hit: boolean;
        if (innerRan) {
          hit = false;
        } else if (ownSpyInstalled) {
          hit = true;
        } else if (hasLast) {
          hit =
            memoEqual(lastThis, thisArg) &&
            areMemoArgsEqual(lastArgs, argArray);
          if (!hit && capturedInnerFn === null) {
            trapDisarmed = true;
          }
        } else {
          hit = isMemoOneTarget && trapInstalled && capturedInnerFn === null;
        }

        hasLast = true;
        lastThis = thisArg;
        lastArgs = [...argArray];
        onCall({
          hit,
          durationMs,
          args: argArray,
          result,
          ...(capturedInnerFn ? { innerFn: capturedInnerFn } : {}),
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
          ...(capturedInnerFn ? { innerFn: capturedInnerFn } : {}),
        });
        throw err;
      } finally {
        activeListeners?.delete(markInnerMiss);
        if (
          trapInstalled &&
          Reflect.get(Function.prototype, "apply") === trappedApply
        ) {
          Reflect.set(Function.prototype, "apply", origApply);
        }
      }
    },
    get(target, prop, receiver) {
      if (prop === "clear") {
        return wrappedClear;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  wrappedRef = wrapped;
  return wrapped;
}
