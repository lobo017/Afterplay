import type { Color } from '../core/rules';

export type TimeControlPresetId =
  'unlimited' | '1+0' | '2+1' | '3+0' | '3+2' | '5+0' | '5+3' | '10+0' | '10+5' | '15+10';

export interface TimeControlConfig {
  id: TimeControlPresetId | 'custom';
  label: string;
  initialMs: number;
  incrementMs: number;
  unlimited: boolean;
}

export const TIME_CONTROL_PRESETS: Record<TimeControlPresetId, TimeControlConfig> = {
  unlimited: {
    id: 'unlimited',
    label: 'Unlimited (∞)',
    initialMs: 0,
    incrementMs: 0,
    unlimited: true,
  },
  '1+0': {
    id: '1+0',
    label: '1 + 0 · Bullet',
    initialMs: 60_000,
    incrementMs: 0,
    unlimited: false,
  },
  '2+1': {
    id: '2+1',
    label: '2 + 1 · Bullet',
    initialMs: 120_000,
    incrementMs: 1_000,
    unlimited: false,
  },
  '3+0': {
    id: '3+0',
    label: '3 + 0 · Blitz',
    initialMs: 180_000,
    incrementMs: 0,
    unlimited: false,
  },
  '3+2': {
    id: '3+2',
    label: '3 + 2 · Blitz',
    initialMs: 180_000,
    incrementMs: 2_000,
    unlimited: false,
  },
  '5+0': {
    id: '5+0',
    label: '5 + 0 · Blitz',
    initialMs: 300_000,
    incrementMs: 0,
    unlimited: false,
  },
  '5+3': {
    id: '5+3',
    label: '5 + 3 · Blitz',
    initialMs: 300_000,
    incrementMs: 3_000,
    unlimited: false,
  },
  '10+0': {
    id: '10+0',
    label: '10 + 0 · Rapid',
    initialMs: 600_000,
    incrementMs: 0,
    unlimited: false,
  },
  '10+5': {
    id: '10+5',
    label: '10 + 5 · Rapid',
    initialMs: 600_000,
    incrementMs: 5_000,
    unlimited: false,
  },
  '15+10': {
    id: '15+10',
    label: '15 + 10 · Rapid',
    initialMs: 900_000,
    incrementMs: 10_000,
    unlimited: false,
  },
};

export interface ClockSnapshot {
  whiteMs: number;
  blackMs: number;
  whiteFormatted: string;
  blackFormatted: string;
  activeColor: Color | null;
  running: boolean;
  unlimited: boolean;
  flaggedColor: Color | null;
}

export function formatClockMs(ms: number, unlimited = false): string {
  if (unlimited) return '∞';
  const clamped = Math.max(0, ms);
  if (clamped < 10_000) {
    const wholeSeconds = Math.floor(clamped / 1000);
    const tenths = Math.floor((clamped % 1000) / 100);
    return `0:0${wholeSeconds}.${tenths}`;
  }
  const totalSeconds = Math.ceil(clamped / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

/**
 * High-precision chess clock based on `performance.now()`.
 * Supports time controls with increment, pause/resume, takeback state restoration, and flag detection.
 * Runs zero timers when unlimited or paused.
 */
export class ChessClock {
  private config: TimeControlConfig;
  private whiteMs: number;
  private blackMs: number;
  private activeColor: Color | null = null;
  private running = false;
  private flaggedColor: Color | null = null;
  private lastStamp = 0;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private lastEmittedKey = '';

  private readonly nowFn: () => number;
  private readonly onTickCallback: ((snapshot: ClockSnapshot) => void) | undefined;
  private readonly onFlagCallback: ((flaggedColor: Color, snapshot: ClockSnapshot) => void) | undefined;

  constructor(options?: {
    config?: TimeControlConfig;
    nowFn?: () => number;
    onTick?: (snapshot: ClockSnapshot) => void;
    onFlag?: (flaggedColor: Color, snapshot: ClockSnapshot) => void;
  }) {
    this.config = options?.config ?? TIME_CONTROL_PRESETS['5+3'];
    this.whiteMs = this.config.initialMs;
    this.blackMs = this.config.initialMs;
    this.nowFn = options?.nowFn ?? (() => performance.now());
    this.onTickCallback = options?.onTick;
    this.onFlagCallback = options?.onFlag;
  }

  public getConfig(): TimeControlConfig {
    return this.config;
  }

  public reset(config?: TimeControlConfig): ClockSnapshot {
    this.stopTimer();
    if (config) {
      this.config = config;
    }
    this.whiteMs = this.config.initialMs;
    this.blackMs = this.config.initialMs;
    this.activeColor = null;
    this.running = false;
    this.flaggedColor = null;
    this.lastEmittedKey = '';
    const snap = this.getSnapshot();
    this.emitTickIfNeeded(snap, true);
    return snap;
  }

  public start(activeColor: Color, now = this.nowFn()): ClockSnapshot {
    if (this.flaggedColor) return this.getSnapshot();
    this.activeColor = activeColor;
    if (this.config.unlimited) {
      this.running = false;
      const snap = this.getSnapshot();
      this.emitTickIfNeeded(snap, true);
      return snap;
    }

    this.running = true;
    this.lastStamp = now;
    this.ensureTimer();
    const snap = this.getSnapshot();
    this.emitTickIfNeeded(snap, true);
    return snap;
  }

  /**
   * Called when `completedByColor` completes a move at timestamp `now`.
   * Deducts elapsed time since `lastStamp`, applies increment if remaining > 0,
   * and starts the opponent's clock.
   */
  public switchTurn(completedByColor: Color, now = this.nowFn()): ClockSnapshot {
    if (this.flaggedColor) return this.getSnapshot();

    if (this.config.unlimited) {
      this.activeColor = completedByColor === 'w' ? 'b' : 'w';
      const snap = this.getSnapshot();
      this.emitTickIfNeeded(snap, true);
      return snap;
    }

    if (this.running && this.activeColor === completedByColor) {
      this.advanceElapsed(now);
      if (this.flaggedColor) {
        return this.getSnapshot();
      }
    }

    // Add Fischer increment to the side that just completed its move
    if (completedByColor === 'w') {
      this.whiteMs += this.config.incrementMs;
    } else {
      this.blackMs += this.config.incrementMs;
    }

    this.activeColor = completedByColor === 'w' ? 'b' : 'w';
    this.running = true;
    this.lastStamp = now;
    this.ensureTimer();

    const snap = this.getSnapshot();
    this.emitTickIfNeeded(snap, true);
    return snap;
  }

  public pause(now = this.nowFn()): ClockSnapshot {
    if (this.running && !this.config.unlimited) {
      this.advanceElapsed(now);
    }
    this.running = false;
    this.stopTimer();
    const snap = this.getSnapshot();
    this.emitTickIfNeeded(snap, true);
    return snap;
  }

  public setTimes(
    whiteMs: number,
    blackMs: number,
    activeColor: Color | null = this.activeColor,
    now = this.nowFn(),
  ): ClockSnapshot {
    this.whiteMs = Math.max(0, whiteMs);
    this.blackMs = Math.max(0, blackMs);
    this.activeColor = activeColor;
    this.lastStamp = now;
    if (this.whiteMs > 0 && this.blackMs > 0) {
      this.flaggedColor = null;
    }
    const snap = this.getSnapshot();
    this.emitTickIfNeeded(snap, true);
    return snap;
  }

  public tick(now = this.nowFn()): ClockSnapshot {
    if (!this.running || this.config.unlimited || !this.activeColor) {
      return this.getSnapshot();
    }
    this.advanceElapsed(now);
    const snap = this.getSnapshot();
    this.emitTickIfNeeded(snap, false);
    return snap;
  }

  private advanceElapsed(now: number): void {
    const dt = Math.max(0, now - this.lastStamp);
    this.lastStamp = now;

    if (this.activeColor === 'w') {
      this.whiteMs = Math.max(0, this.whiteMs - dt);
      if (this.whiteMs <= 0) {
        this.handleFlag('w');
      }
    } else if (this.activeColor === 'b') {
      this.blackMs = Math.max(0, this.blackMs - dt);
      if (this.blackMs <= 0) {
        this.handleFlag('b');
      }
    }
  }

  private handleFlag(color: Color): void {
    this.flaggedColor = color;
    this.running = false;
    this.stopTimer();
    const snap = this.getSnapshot();
    this.emitTickIfNeeded(snap, true);
    this.onFlagCallback?.(color, snap);
  }

  public getSnapshot(): ClockSnapshot {
    return {
      whiteMs: Math.round(this.whiteMs),
      blackMs: Math.round(this.blackMs),
      whiteFormatted: formatClockMs(this.whiteMs, this.config.unlimited),
      blackFormatted: formatClockMs(this.blackMs, this.config.unlimited),
      activeColor: this.activeColor,
      running: this.running,
      unlimited: this.config.unlimited,
      flaggedColor: this.flaggedColor,
    };
  }

  private emitTickIfNeeded(snap: ClockSnapshot, force: boolean): void {
    const key = `${snap.whiteFormatted}|${snap.blackFormatted}|${snap.activeColor ?? ''}|${snap.running ? 1 : 0}|${snap.flaggedColor ?? ''}`;
    if (!force && key === this.lastEmittedKey) {
      return;
    }
    this.lastEmittedKey = key;
    this.onTickCallback?.(snap);
  }

  private ensureTimer(): void {
    if (this.timerId !== null || this.config.unlimited) return;
    this.timerId = setInterval(() => {
      this.tick();
    }, 100);
  }

  private stopTimer(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  public isRunning(): boolean {
    return this.running;
  }

  public destroy(): void {
    this.stopTimer();
  }
}
