/**
 * Build-on-first-use helpers, so start-up does not carry work the first screen doesn't need (the
 * spec allows no main-thread task over 50 ms).
 */

export interface Lazy<T> {
  /** The value; created on the first call. */
  get(): T;
  /** Whether it has been created yet (asking never creates it). */
  created(): boolean;
}

export function lazy<T>(create: () => T): Lazy<T> {
  let value: T | undefined;
  let made = false;
  return {
    get: () => {
      if (!made) {
        value = create();
        made = true;
      }
      return value as T;
    },
    created: () => made,
  };
}

/**
 * An object that stands in for the one `source` returns: nothing is built until a property is read or
 * written, then every access goes to the real object (methods keep it as `this`). Code that was written
 * against the real object (and the tests' window hooks) keeps working unchanged.
 */
export function lazyProxy<T extends object>(source: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const real = source();
      const value = Reflect.get(real, prop, real) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(real) : value;
    },
    set(_target, prop, value) {
      const real = source();
      return Reflect.set(real, prop, value, real);
    },
    has(_target, prop) {
      return prop in source();
    },
  });
}

/** Runs `task` in a browser idle moment (or after `timeoutMs` at the latest); a plain timer where idle callbacks don't exist. */
export function whenIdle(task: () => void, timeoutMs: number): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === 'function') ric(task, { timeout: timeoutMs });
  else setTimeout(task, Math.min(timeoutMs, 50));
}
