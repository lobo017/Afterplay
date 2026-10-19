import { describe, expect, it } from 'vitest';
import {
  BOARD_FEEL_KEYS,
  BOARD_FEEL_RANGES,
  BOARD_FEEL_STORAGE_KEY,
  BoardFeelStore,
  DEFAULT_BOARD_FEEL,
  resolveDropSquare,
  sanitizeBoardFeel,
  squareAtBoardCell,
  type FeelStorage,
} from '../../src/render/board-feel';
import {
  BOARD_SIZE_RANGE,
  BOARD_SIZE_STORAGE_KEY,
  clampBoardSize,
  loadBoardSize,
  saveBoardSize,
} from '../../src/render/board-size';
import type { Square } from '../../src/core/rules';

class MemoryStorage implements FeelStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

class BlockedStorage implements FeelStorage {
  getItem(): string | null {
    throw new Error('blocked');
  }
  setItem(): void {
    throw new Error('blocked');
  }
  removeItem(): void {
    throw new Error('blocked');
  }
}

describe('Phase 6b — board feel', () => {
  it('has a default inside every range, on its step', () => {
    for (const key of BOARD_FEEL_KEYS) {
      const r = BOARD_FEEL_RANGES[key];
      const v = DEFAULT_BOARD_FEEL[key];
      expect(v).toBeGreaterThanOrEqual(r.min);
      expect(v).toBeLessThanOrEqual(r.max);
      expect(sanitizeBoardFeel({ [key]: v })[key]).toBe(v);
    }
  });

  it('clamps, snaps to the step, and ignores bad values', () => {
    const feel = sanitizeBoardFeel({
      dragThresholdPx: 99,
      liftScale: 0.5,
      snapMs: 113,
      dropTolerance: 'wide',
      touchOffset: Number.NaN,
      animationMs: -5,
      extra: 1,
    });
    expect(feel).toEqual({
      dragThresholdPx: 12,
      liftScale: 1,
      snapMs: 110,
      dropTolerance: DEFAULT_BOARD_FEEL.dropTolerance,
      touchOffset: DEFAULT_BOARD_FEEL.touchOffset,
      animationMs: 0,
    });
    expect(sanitizeBoardFeel(null)).toEqual(DEFAULT_BOARD_FEEL);
  });

  it('remembers changes, tells subscribers, and resets to the defaults', () => {
    const storage = new MemoryStorage();
    const store = new BoardFeelStore(storage);
    const seen: number[] = [];
    const unsubscribe = store.subscribe((f) => seen.push(f.liftScale));
    store.set({ liftScale: 1.2, snapMs: 80 });
    expect(store.get().liftScale).toBe(1.2);
    expect(JSON.parse(storage.getItem(BOARD_FEEL_STORAGE_KEY)!)).toMatchObject({ liftScale: 1.2, snapMs: 80 });

    // A new store (a reload) reads the saved values
    expect(new BoardFeelStore(storage).get()).toMatchObject({ liftScale: 1.2, snapMs: 80 });

    store.reset();
    expect(store.get()).toEqual(DEFAULT_BOARD_FEEL);
    expect(storage.getItem(BOARD_FEEL_STORAGE_KEY)).toBeNull();
    expect(seen).toEqual([1.2, DEFAULT_BOARD_FEEL.liftScale]);
    unsubscribe();
    store.set({ liftScale: 1.3 });
    expect(seen).toHaveLength(2);
  });

  it('falls back to the defaults on corrupt or blocked storage', () => {
    const storage = new MemoryStorage();
    storage.setItem(BOARD_FEEL_STORAGE_KEY, '{not json');
    expect(new BoardFeelStore(storage).get()).toEqual(DEFAULT_BOARD_FEEL);
    const blocked = new BoardFeelStore(new BlockedStorage());
    expect(blocked.get()).toEqual(DEFAULT_BOARD_FEEL);
    blocked.set({ snapMs: 50 });
    expect(blocked.get().snapMs).toBe(50);
    expect(() => blocked.reset()).not.toThrow();
  });
});

describe('Phase 6b — drop square with tolerance', () => {
  // Board positions are in squares from the top-left corner (White at the bottom)
  it('maps screen cells to squares in both orientations', () => {
    expect(squareAtBoardCell(0, 0, false)).toBe('a8');
    expect(squareAtBoardCell(7, 7, false)).toBe('h1');
    expect(squareAtBoardCell(0, 0, true)).toBe('h1');
    expect(squareAtBoardCell(4, 6, true)).toBe('d7');
  });

  it('takes the square under the point when it is a target', () => {
    expect(resolveDropSquare(4.5, 4.5, ['e4', 'e3'], 0.2, false)).toBe('e4');
  });

  it('lands on a target just past its edge, within the tolerance', () => {
    // e4 spans x 4–5, y 4–5. The point is 0.15 squares into e5 (above e4).
    expect(resolveDropSquare(4.5, 3.85, ['e4'], 0.2, false)).toBe('e4');
    // Beyond the tolerance: the square under the point (e5), not a target
    expect(resolveDropSquare(4.5, 3.7, ['e4'], 0.2, false)).toBe('e5');
    // Tolerance 0: exact squares only
    expect(resolveDropSquare(4.5, 3.85, ['e4'], 0, false)).toBe('e5');
  });

  it('measures to the corner diagonally', () => {
    // 0.1 right and 0.1 below e4's bottom-right corner: 0.141 squares away
    expect(resolveDropSquare(5.1, 5.1, ['e4'], 0.15, false)).toBe('e4');
    expect(resolveDropSquare(5.1, 5.1, ['e4'], 0.13, false)).toBe('f3');
  });

  it('accepts a drop just off the board next to an edge target', () => {
    // a8 is the top-left square; the point is 0.1 squares above the board
    expect(resolveDropSquare(0.5, -0.1, ['a8'], 0.2, false)).toBe('a8');
    expect(resolveDropSquare(0.5, -0.3, ['a8'], 0.2, false)).toBeNull();
  });

  it('picks the nearest of two targets', () => {
    // Between e4 (x 4–5) and g4 (x 6–7) on f4, closer to g4
    const targets: Square[] = ['e4', 'g4'];
    expect(resolveDropSquare(5.9, 4.5, targets, 0.2, false)).toBe('g4');
    expect(resolveDropSquare(5.1, 4.5, targets, 0.2, false)).toBe('e4');
  });

  it('works on a flipped board', () => {
    // Flipped: e4 is at column 3, row 3
    expect(resolveDropSquare(3.5, 3.5, ['e4'], 0, true)).toBe('e4');
    expect(resolveDropSquare(3.5, 2.9, ['e4'], 0.2, true)).toBe('e4');
  });
});

describe('Phase 6b — board size', () => {
  it('clamps to the allowed range', () => {
    expect(clampBoardSize(10)).toBe(BOARD_SIZE_RANGE.min);
    expect(clampBoardSize(5000)).toBe(BOARD_SIZE_RANGE.max);
    expect(clampBoardSize(640.4)).toBe(640);
  });

  it('remembers a size and forgets it', () => {
    const storage = new MemoryStorage();
    expect(loadBoardSize(storage)).toBeNull();
    saveBoardSize(720, storage);
    expect(storage.getItem(BOARD_SIZE_STORAGE_KEY)).toBe('720');
    expect(loadBoardSize(storage)).toBe(720);
    saveBoardSize(null, storage);
    expect(loadBoardSize(storage)).toBeNull();
    storage.setItem(BOARD_SIZE_STORAGE_KEY, 'huge');
    expect(loadBoardSize(storage)).toBeNull();
    storage.setItem(BOARD_SIZE_STORAGE_KEY, '99999');
    expect(loadBoardSize(storage)).toBe(BOARD_SIZE_RANGE.max);
    expect(loadBoardSize(new BlockedStorage())).toBeNull();
    expect(() => saveBoardSize(500, new BlockedStorage())).not.toThrow();
  });
});
