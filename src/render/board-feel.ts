import type { Square } from '../core/rules';

/**
 * How piece handling feels. One shared set of values for every board, tuned live from the
 * dev overlay's "Board feel" panel and remembered on this device.
 */
export interface BoardFeel {
  /** Pointer travel (px) before a press becomes a drag; doubled for touch. */
  dragThresholdPx: number;
  /** Scale of a lifted piece. */
  liftScale: number;
  /** Glide of a dropped piece into its square, and of an illegal drop back home (ms). */
  snapMs: number;
  /** How far (in squares) past a legal square's edge a drop still lands on it. */
  dropTolerance: number;
  /** How far (in squares) above the finger a piece dragged by touch is drawn. */
  touchOffset: number;
  /** Duration of a played move's animation (ms). */
  animationMs: number;
}

export type BoardFeelKey = keyof BoardFeel;

export interface BoardFeelRange {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
}

export const BOARD_FEEL_RANGES: Record<BoardFeelKey, BoardFeelRange> = {
  dragThresholdPx: { label: 'Drag threshold', unit: 'px', min: 0, max: 12, step: 0.5 },
  liftScale: { label: 'Lift scale', unit: '×', min: 1, max: 1.35, step: 0.01 },
  snapMs: { label: 'Snap duration', unit: 'ms', min: 0, max: 300, step: 10 },
  dropTolerance: { label: 'Drop tolerance', unit: 'sq', min: 0, max: 0.5, step: 0.05 },
  touchOffset: { label: 'Touch offset', unit: 'sq', min: 0, max: 1.5, step: 0.05 },
  animationMs: { label: 'Animation speed', unit: 'ms', min: 0, max: 400, step: 10 },
};

export const BOARD_FEEL_KEYS = Object.keys(BOARD_FEEL_RANGES) as BoardFeelKey[];

export const DEFAULT_BOARD_FEEL: Readonly<BoardFeel> = Object.freeze({
  dragThresholdPx: 3,
  liftScale: 1.12,
  snapMs: 110,
  dropTolerance: 0.2,
  touchOffset: 0.8,
  animationMs: 170,
});

export const BOARD_FEEL_STORAGE_KEY = 'wc.boardFeel.v1';

/** Clamps every value to its range and snaps it to its step; unknown or bad values fall back to the default. */
export function sanitizeBoardFeel(input: unknown): BoardFeel {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_BOARD_FEEL };
  for (const key of BOARD_FEEL_KEYS) {
    const v = src[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const r = BOARD_FEEL_RANGES[key];
    const stepped = Math.round((v - r.min) / r.step) * r.step + r.min;
    out[key] = Number(Math.min(r.max, Math.max(r.min, stepped)).toFixed(4));
  }
  return out;
}

/** The parts of `localStorage` the store uses (injectable for tests). */
export interface FeelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): FeelStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class BoardFeelStore {
  private value: BoardFeel;
  private readonly listeners = new Set<(feel: BoardFeel) => void>();

  constructor(private readonly storage: FeelStorage | null = defaultStorage()) {
    this.value = this.load();
  }

  private load(): BoardFeel {
    try {
      const raw = this.storage?.getItem(BOARD_FEEL_STORAGE_KEY);
      return raw ? sanitizeBoardFeel(JSON.parse(raw)) : { ...DEFAULT_BOARD_FEEL };
    } catch {
      return { ...DEFAULT_BOARD_FEEL };
    }
  }

  public get(): Readonly<BoardFeel> {
    return this.value;
  }

  public set(partial: Partial<BoardFeel>): void {
    this.value = sanitizeBoardFeel({ ...this.value, ...partial });
    try {
      this.storage?.setItem(BOARD_FEEL_STORAGE_KEY, JSON.stringify(this.value));
    } catch {
      // Storage full or blocked: the values still apply for this session
    }
    this.emit();
  }

  /** Back to the defaults; the stored values are forgotten. */
  public reset(): void {
    this.value = { ...DEFAULT_BOARD_FEEL };
    try {
      this.storage?.removeItem(BOARD_FEEL_STORAGE_KEY);
    } catch {
      // Ignore blocked storage
    }
    this.emit();
  }

  public subscribe(listener: (feel: BoardFeel) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.value);
  }
}

/** The one store every board and the tuning panel share. */
export const boardFeel = new BoardFeelStore();

const FILES = 'abcdefgh';

/** The board square at screen column `col`, row `row` (0–7 from the top-left). */
export function squareAtBoardCell(col: number, row: number, flipped: boolean): Square {
  const fileIdx = flipped ? 7 - col : col;
  const rankIdx = flipped ? row : 7 - row;
  return `${FILES[fileIdx]}${rankIdx + 1}` as Square;
}

/**
 * Where a drop at board position (`x`, `y`), measured in squares from the board's top-left
 * corner, lands. The square under the point wins when it's a target; otherwise the nearest
 * target whose square lies within `tolerance` squares of the point (which may be just off
 * the board). Returns the square under the point (or null off the board) when no target is
 * close enough, so callers can treat it as an illegal drop.
 */
export function resolveDropSquare(
  x: number,
  y: number,
  targets: readonly Square[],
  tolerance: number,
  flipped: boolean,
): Square | null {
  const onBoard = x >= 0 && y >= 0 && x < 8 && y < 8;
  const under = onBoard ? squareAtBoardCell(Math.floor(x), Math.floor(y), flipped) : null;
  if (under && targets.includes(under)) return under;
  if (tolerance <= 0 || targets.length === 0) return under;

  let best: Square | null = null;
  let bestDist = Infinity;
  for (const sq of targets) {
    const fileIdx = FILES.indexOf(sq[0] ?? 'a');
    const rankIdx = Number(sq[1] ?? '1') - 1;
    const col = flipped ? 7 - fileIdx : fileIdx;
    const row = flipped ? rankIdx : 7 - rankIdx;
    // Distance from the point to the square's rectangle (0 inside it)
    const dx = Math.max(col - x, 0, x - (col + 1));
    const dy = Math.max(row - y, 0, y - (row + 1));
    const dist = Math.hypot(dx, dy);
    if (dist <= tolerance && dist < bestDist) {
      bestDist = dist;
      best = sq;
    }
  }
  return best ?? under;
}
