import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeBook, type Book } from '../../src/engine/bot-profile';
import { PRESET_LIMITS, parsePreset } from '../../src/preset/preset';
import {
  PROFILE_STORAGE_KEY,
  ProfileStore,
  clearParsedBooks,
  customBotBooks,
  customBotFor,
  scheduleIdle,
  warmBotBooks,
} from '../../src/preset/profile';

// Invented data only: nothing here comes from a real player.

/**
 * A book that reads as valid, of at most `chars` characters, shaped like a real one (keys of about 60 characters, a
 * second move at one position in seven), so the JSON escaping inside a stored profile weighs about what it would.
 */
function syntheticBook(chars: number): string {
  const entries: Book['entries'] = {};
  let i = 0;
  let text = serializeBook({ v: 1, pliesCap: 36, entries });
  for (;;) {
    const key = `${i.toString(36)}/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR/${'1'.repeat(8)} ${i % 2 === 0 ? 'w' : 'b'} KQkq -`;
    entries[key] =
      i % 7 === 0
        ? [
            ['e2e4', 3 + (i % 5)],
            ['d2d4', 1 + (i % 3)],
          ]
        : [['g1f3', 1 + (i % 9)]];
    i++;
    if (i % 200 === 0) {
      text = serializeBook({ v: 1, pliesCap: 36, entries });
      if (text.length > chars - 4_000) break;
    }
  }
  return text;
}

function memoryStorage(limitChars = Infinity) {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (value.length > limitChars) throw new DOMException('quota', 'QuotaExceededError');
      data.set(key, value);
    },
    removeItem: (key: string) => void data.delete(key),
  };
}

afterEach(() => {
  clearParsedBooks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a gift-sized preset in the stored profile', () => {
  // Safari's localStorage holds about 5 MB; counted as UTF-16 code units (the strictest reading) that is 2.5 Mi characters
  const SAFARI_QUOTA_CHARS = 2_621_440;
  // The sizes of the gift's three books (docs/PROGRESS.md, personal bots step 4a) with invented content
  const ME = syntheticBook(462_000);
  const PEAK = syntheticBook(70_000);
  const STUDENT = syntheticBook(390_000);

  const preset = {
    version: 1,
    profile: { displayName: 'Ada' },
    bots: [
      { name: 'Rook', rating: 800, style: 'solid' },
      { name: 'Bishop', rating: 1200, style: 'solid' },
      { name: 'Knight', rating: 1800, style: 'aggressive' },
      { name: 'Pawn', rating: 1500, style: 'solid' },
      { name: 'Book one', rating: 1450, style: 'solid', books: [ME] },
      { name: 'Book two', rating: 1550, style: 'solid', books: [PEAK, ME] },
      { name: 'Book three', rating: 1250, style: 'solid', books: [STUDENT] },
    ],
  };

  it('is under the preset limits and survives the real parser whole', () => {
    const parsed = parsePreset(preset);
    expect(parsed.problems).toEqual([]);
    expect(parsed.preset!.bots).toHaveLength(7);
    const total = parsed.preset!.bots.flatMap((b) => b.books ?? []).reduce((n, b) => n + b.length, 0);
    expect(total).toBeLessThan(PRESET_LIMITS.booksTotalChars);
    expect(parsed.preset!.bots[5]!.books).toEqual([PEAK, ME]);
  });

  it('is written to localStorage whole, as app.ts applyPreset writes it, and fits with room to spare', () => {
    const parsed = parsePreset(preset).preset!;
    const storage = memoryStorage(SAFARI_QUOTA_CHARS);
    const store = new ProfileStore(storage);
    // The same call as applyPreset in src/app.ts
    store.set({ displayName: parsed.displayName, bots: parsed.bots });
    const stored = storage.data.get(PROFILE_STORAGE_KEY)!;
    expect(stored).toBeDefined();
    // The books are in what was stored (the quota fallback would have dropped them)
    expect(stored.length).toBeGreaterThan(ME.length + PEAK.length + STUDENT.length);
    // Under 60% of the strictest quota: the rest of the page's localStorage needs room too
    expect(stored.length).toBeLessThan(SAFARI_QUOTA_CHARS * 0.6);

    const reloaded = new ProfileStore(storage).get();
    expect(reloaded.bots).toHaveLength(7);
    expect(customBotFor(reloaded, 1450, 'solid')?.books).toEqual([ME]);
    expect(customBotFor(reloaded, 1550, 'solid')?.books).toEqual([PEAK, ME]);
    expect(customBotFor(reloaded, 1250, 'solid')?.books).toEqual([STUDENT]);
  });

  it('is the case the store fallback exists for: over the quota, the bots stay and the books go', () => {
    const parsed = parsePreset(preset).preset!;
    const storage = memoryStorage(1_000_000);
    new ProfileStore(storage).set({ bots: parsed.bots });
    const reloaded = new ProfileStore(storage).get();
    expect(reloaded.bots).toHaveLength(7);
    expect(reloaded.bots.every((b) => b.books === undefined)).toBe(true);
  });
});

describe('parsing a bot books in an idle moment', () => {
  const bookText = (n: number): string =>
    serializeBook({ v: 1, pliesCap: 36, entries: { [`${n}/8/8/8/8/8/8/8 w - -`]: [['e2e4', 1]] } });
  const bot = { name: 'Book bot', rating: 1500, style: 'solid' as const, books: [bookText(1), bookText(2)] };

  it('schedules one task per book that is not parsed yet, and parses nothing until they run', () => {
    const parse = vi.spyOn(JSON, 'parse');
    const tasks: (() => void)[] = [];
    warmBotBooks(bot, (task) => tasks.push(task));
    expect(tasks).toHaveLength(2);
    expect(parse).not.toHaveBeenCalled();
    tasks.forEach((task) => task());
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('leaves the first book move nothing to parse', () => {
    const tasks: (() => void)[] = [];
    warmBotBooks(bot, (task) => tasks.push(task));
    tasks.forEach((task) => task());
    const parse = vi.spyOn(JSON, 'parse');
    expect(customBotBooks(bot)).toHaveLength(2);
    expect(parse).not.toHaveBeenCalled();
  });

  it('schedules nothing for a book already parsed, a bot without books, or no bot, and one task for a repeated text', () => {
    customBotBooks(bot);
    const tasks: (() => void)[] = [];
    const schedule = (task: () => void): void => void tasks.push(task);
    warmBotBooks(bot, schedule);
    warmBotBooks({ name: 'Plain', rating: 1200, style: 'solid' }, schedule);
    warmBotBooks(null, schedule);
    expect(tasks).toHaveLength(0);
    clearParsedBooks();
    warmBotBooks({ ...bot, books: [bookText(1), bookText(1)] }, schedule);
    expect(tasks).toHaveLength(1);
  });

  it('a text that is not a book is skipped without a word, and the bot still plays from the others', () => {
    const tasks: (() => void)[] = [];
    const odd = { ...bot, books: ['not a book', bookText(3)] };
    warmBotBooks(odd, (task) => tasks.push(task));
    expect(() => tasks.forEach((task) => task())).not.toThrow();
    expect(customBotBooks(odd)).toHaveLength(1);
  });

  it('uses requestIdleCallback when there is one (within two seconds), else a zero-delay timer', () => {
    const idle = vi.fn((task: () => void) => {
      task();
      return 1;
    });
    vi.stubGlobal('requestIdleCallback', idle);
    const ran = vi.fn();
    scheduleIdle(ran);
    expect(idle).toHaveBeenCalledWith(ran, { timeout: 2000 });
    expect(ran).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.useFakeTimers();
    const later = vi.fn();
    scheduleIdle(later);
    expect(later).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(later).toHaveBeenCalledTimes(1);
  });
});
