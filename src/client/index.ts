import type {
  LitDevtoolsHook,
  RegisterEntityOptions,
} from "../protocol/types.ts";

const GLOBAL_HOOK_KEY = "__LIT_DEVTOOLS_HOOK__";

function isLitHookV1(value: unknown): value is LitDevtoolsHook {
  return (
    value !== null &&
    typeof value === "object" &&
    Reflect.get(value, "version") === 1 &&
    typeof Reflect.get(value, "snapshot") === "function"
  );
}

function readHook(): LitDevtoolsHook | null {
  const candidate: unknown = Reflect.get(globalThis, GLOBAL_HOOK_KEY);
  return isLitHookV1(candidate) ? candidate : null;
}

export function registerModel<T extends object>(
  model: T,
  options?: RegisterEntityOptions,
): T {
  return readHook()?.registerModel(model, options) ?? model;
}

export function registerController<T extends object>(
  controller: T,
  options?: RegisterEntityOptions & {
    readonly host?: object;
    readonly model?: object;
  },
): T {
  return readHook()?.registerController(controller, options) ?? controller;
}

export function label<T extends object>(target: T, name: string): T {
  return readHook()?.label(target, name) ?? target;
}

export function traceMemoized<T extends (...args: never[]) => unknown>(
  fn: T,
  owner: object,
  name: string,
  role?: "computed" | "observer",
): T {
  return readHook()?.traceMemoized(fn, owner, name, role) ?? fn;
}
