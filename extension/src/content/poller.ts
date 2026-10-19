import type { StreamTimers } from './lichess-stream';

export interface Poller {
  stop(): void;
  /** Runs a check now (if none is running) and restarts the wait. */
  poke(): void;
  /** Checks run so far. */
  runs(): number;
}

/**
 * Runs `check` repeatedly, `intervalMs()` apart (so the gap can depend on the tab being
 * visible), one at a time, until it answers 'stop' or the poller is stopped. A check that
 * throws counts as 'continue'.
 */
export function startPoller(options: {
  check: () => Promise<'stop' | 'continue'>;
  intervalMs: () => number;
  timers?: StreamTimers;
  /** Run the first check right away (default: after the first interval). */
  immediate?: boolean;
}): Poller {
  const timers: StreamTimers = options.timers ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let stopped = false;
  let running = false;
  let handle: unknown = null;
  let count = 0;

  const schedule = () => {
    if (stopped) return;
    if (handle !== null) timers.clear(handle);
    handle = timers.set(() => {
      handle = null;
      void run();
    }, options.intervalMs());
  };

  const run = async () => {
    if (stopped || running) return;
    running = true;
    count++;
    let next: 'stop' | 'continue' = 'continue';
    try {
      next = await options.check();
    } catch {
      next = 'continue';
    } finally {
      running = false;
    }
    if (next === 'stop') stopped = true;
    else schedule();
  };

  if (options.immediate) void run();
  else schedule();

  return {
    stop() {
      stopped = true;
      if (handle !== null) timers.clear(handle);
      handle = null;
    },
    poke() {
      if (stopped || running) return;
      if (handle !== null) timers.clear(handle);
      handle = null;
      void run();
    },
    runs: () => count,
  };
}
