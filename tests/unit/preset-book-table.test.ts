import { afterEach, describe, expect, it, vi } from 'vitest';
import { RulesAdapter } from '../../src/core/rules';
import { buildBook, personalBookDecision, serializeBook, type Book } from '../../src/engine/bot-profile';
import {
  BOT_SETTING_KEYS,
  botBookKey,
  presetBookKey,
  readPresetBookText,
  resetBotData,
  savePresetBooks,
} from '../../src/engine/bot-profile-store';
import { PRESET_LIMITS, parsePreset } from '../../src/preset/preset';
import {
  BOOK_LOAD_TIMEOUT_MS,
  PROFILE_STORAGE_KEY,
  ProfileStore,
  awaitBotBooks,
  clearParsedBooks,
  namedBotForRating,
  sanitizeProfile,
  warmBotBooks,
} from '../../src/preset/profile';
import { record } from './helpers/book-games';
import { syntheticBook } from './helpers/synthetic-book';

// Invented games, books and names only: nothing here comes from a real player.

const bookOf = (games: string[][], side: 'own' | 'opponent' = 'own'): Book =>
  buildBook(
    games.map((g) => record(g)),
    { side },
  ).book;

/** Black's book: 1...h5 after 1. e4, then 2...a5 after 2. d4. */
const BLACK = serializeBook(bookOf([['e4', 'h5', 'd4', 'a5']], 'opponent'));
/** White's book: 1. e4, then 2. Nf3 after 1...e5. */
const WHITE = serializeBook(bookOf([['e4', 'e5', 'Nf3']]));

const fenAfter = (...sans: string[]): string => {
  const adapter = new RulesAdapter();
  for (const san of sans) adapter.move(san);
  return adapter.fen();
};

/** A settings store in memory (the three calls of `GameLibrary` the bots use). */
function memorySettings(options: { failWritesFor?: string[] } = {}) {
  const rows = new Map<string, unknown>();
  return {
    rows,
    readSetting: async <T>(key: string) => rows.get(key) as T | undefined,
    writeSetting: async <T>(key: string, value: T) => {
      if (options.failWritesFor?.some((name) => key.endsWith(name))) throw new Error('quota');
      rows.set(key, value);
    },
    deleteSetting: async (key: string) => void rows.delete(key),
  };
}

const bot = (bookRefs: string[], extra: Record<string, unknown> = {}) => ({
  name: 'Ref bot',
  rating: 1500,
  style: 'solid' as const,
  bookRefs,
  ...extra,
});

afterEach(() => {
  clearParsedBooks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a preset books table and bookRefs', () => {
  const preset = (extra: Record<string, unknown>) => ({ version: 1, ...extra });

  it('reads the table and the references, in order, and keeps only the books some bot refers to', () => {
    const parsed = parsePreset(
      preset({
        books: { white: WHITE, black: BLACK, unused: WHITE },
        bots: [{ name: 'Ref bot', rating: 1500, style: 'solid', bookRefs: ['black', 'white'] }],
      }),
    );
    expect(parsed.preset!.bots).toEqual([bot(['black', 'white'])]);
    expect(parsed.preset!.books).toEqual({ white: WHITE, black: BLACK });
    expect(parsed.problems).toEqual(['books["unused"]: no bot refers to it (left out)']);
  });

  it('drops a reference to a book that is not in the table, a bad name, a repeat and the fourth; the bot stays', () => {
    const parsed = parsePreset(
      preset({
        books: { a: WHITE, b: BLACK, c: WHITE, d: BLACK },
        bots: [
          { name: 'Bot', rating: 1500, style: 'solid', bookRefs: ['a', 'missing', 'Bad Name', 'a', 'b', 'c', 'd', 7] },
          { name: 'Plain by refs', rating: 1600, style: 'solid', bookRefs: ['nope', '../x'] },
        ],
      }),
    );
    expect(parsed.preset!.bots[0]!.bookRefs).toEqual(['a', 'b', 'c']);
    expect(parsed.preset!.bots[1]).toEqual({ name: 'Plain by refs', rating: 1600, style: 'solid' });
    expect(parsed.problems.some((p) => p.includes('bookRefs[1]: no book of that name'))).toBe(true);
    expect(
      parsed.problems.some((p) => p.includes('bookRefs[4]: listed twice') || p.includes('bookRefs[3]: listed')),
    ).toBe(true);
    expect(parsed.problems.some((p) => p.includes('more than 3 book references'))).toBe(true);
    // The problems name places, never book text
    for (const p of parsed.problems) expect(p).not.toContain('pliesCap');
  });

  it('drops a table book that is not a book, is over the size, or would push the table over the total', () => {
    const big = (n: number) => `{"v":1,"pliesCap":36,"entries":{},"pad":"${'x'.repeat(n)}"}`;
    const huge = big(PRESET_LIMITS.bookTableChars);
    expect(huge.length).toBeGreaterThan(PRESET_LIMITS.bookTableChars);
    const parsed = parsePreset(
      preset({
        books: { fine: WHITE, broken: 'not a book', huge, 'Bad Name': WHITE, nottext: 5 },
        bots: [{ name: 'Bot', rating: 1500, style: 'solid', bookRefs: ['fine', 'broken', 'huge', 'nottext'] }],
      }),
    );
    expect(parsed.preset!.books).toEqual({ fine: WHITE });
    expect(parsed.preset!.bots[0]!.bookRefs).toEqual(['fine']);
    expect(parsed.problems.some((p) => p.includes('"broken"') && p.includes('not a valid opening book'))).toBe(true);
    expect(parsed.problems.some((p) => p.includes('"huge"') && p.includes('3000000'))).toBe(true);
    expect(parsed.problems.some((p) => p.includes('not a book name'))).toBe(true);
    expect(parsed.problems.some((p) => p.includes('must be text'))).toBe(true);
  });

  it('keeps the table within its total: books over what is left are dropped', () => {
    const a = syntheticBook(2_900_000, 'a');
    const b = syntheticBook(2_900_000, 'b');
    const c = syntheticBook(2_900_000, 'c');
    const parsed = parsePreset(
      preset({
        books: { a, b, c },
        bots: [{ name: 'Bot', rating: 1500, style: 'solid', bookRefs: ['a', 'b', 'c'] }],
      }),
    );
    expect(Object.keys(parsed.preset!.books ?? {})).toEqual(['a', 'b']);
    expect(parsed.preset!.bots[0]!.bookRefs).toEqual(['a', 'b']);
    expect(parsed.problems.some((p) => p.includes('over 6000000'))).toBe(true);
  });

  it('a books table that is not an object, or refs that are not a list, leave plain bots', () => {
    const a = parsePreset(
      preset({ books: [WHITE], bots: [{ name: 'Bot', rating: 1500, style: 'solid', bookRefs: ['x'] }] }),
    );
    expect(a.preset!.books).toBeUndefined();
    expect(a.preset!.bots).toEqual([{ name: 'Bot', rating: 1500, style: 'solid' }]);
    const b = parsePreset(
      preset({ books: { x: WHITE }, bots: [{ name: 'Bot', rating: 1500, style: 'solid', bookRefs: 'x' }] }),
    );
    expect(b.preset!.bots).toEqual([{ name: 'Bot', rating: 1500, style: 'solid' }]);
  });

  it('keeps the rating-and-style rule and the 8 bots with references', () => {
    const books = { x: WHITE };
    const dup = parsePreset(
      preset({
        books,
        bots: [
          { name: 'One', rating: 1500, style: 'solid', bookRefs: ['x'] },
          { name: 'Two', rating: 1500, style: 'solid', bookRefs: ['x'] },
        ],
      }),
    );
    expect(dup.preset!.bots.map((b) => b.name)).toEqual(['One']);
    const many = parsePreset(
      preset({
        books,
        bots: Array.from({ length: 9 }, (_, i) => ({
          name: `Bot ${i}`,
          rating: 800 + i * 100,
          style: 'solid',
          bookRefs: ['x'],
        })),
      }),
    );
    expect(many.preset!.bots).toHaveLength(8);
  });

  it('still reads a v1 preset with inline books exactly as before, and a bot may carry both kinds', () => {
    const v1 = parsePreset(preset({ bots: [{ name: 'Inline', rating: 1200, style: 'solid', books: [WHITE] }] }));
    expect(v1.problems).toEqual([]);
    expect(v1.preset!.bots).toEqual([{ name: 'Inline', rating: 1200, style: 'solid', books: [WHITE] }]);
    expect(v1.preset!.books).toBeUndefined();
    const both = parsePreset(
      preset({
        books: { b: BLACK },
        bots: [{ name: 'Both', rating: 1200, style: 'solid', books: [WHITE], bookRefs: ['b'] }],
      }),
    );
    expect(both.preset!.bots[0]).toEqual({
      name: 'Both',
      rating: 1200,
      style: 'solid',
      books: [WHITE],
      bookRefs: ['b'],
    });
  });

  it('keeps the references (and no table) in the stored profile, and checks only their form there', () => {
    const profile = sanitizeProfile({ bots: [bot(['me', 'Bad Name', 'peak'])] });
    expect(profile.bots[0]!.bookRefs).toEqual(['me', 'peak']);
    const storage = new Map<string, string>();
    const store = new ProfileStore({
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => void storage.set(k, v),
      removeItem: (k) => void storage.delete(k),
    });
    store.set({ bots: [bot(['me'])] });
    expect(JSON.parse(storage.get(PROFILE_STORAGE_KEY)!).bots[0].bookRefs).toEqual(['me']);
    expect(storage.get(PROFILE_STORAGE_KEY)!.length).toBeLessThan(500);
  });
});

describe('loading the books a bot refers to', () => {
  it('a book that is missing, unreadable, not a book, or has no loader: the bot plays without books', async () => {
    const refs = bot(['gone', 'broken', 'bad', 'text']);
    const load = async (name: string): Promise<string | null> => {
      if (name === 'broken') throw new Error('database closed');
      if (name === 'bad') return 'not a book';
      if (name === 'text') return null;
      return null;
    };
    expect(await awaitBotBooks(refs, load)).toEqual([]);
    expect(await awaitBotBooks(refs)).toEqual([]);
    expect(await awaitBotBooks(null, load)).toEqual([]);
  });

  it('a bot with no books moves straight on, and a bot with the books of both kinds gets the inline ones first', async () => {
    expect(await awaitBotBooks({ name: 'Plain', rating: 1200, style: 'solid' }, async () => WHITE)).toEqual([]);
    const both = bot(['b'], { books: [WHITE] });
    const books = await awaitBotBooks(both, async () => BLACK);
    expect(books).toHaveLength(2);
    expect(Object.keys(books[0]!.entries).length).toBeGreaterThan(0);
  });

  it('a bot with a missing book then asks the engine: no book move for the position its book would have known', async () => {
    const books = await awaitBotBooks(bot(['black']), async () => null);
    expect(personalBookDecision(fenAfter('e4'), { books }, () => 0.5, {} as never)).toBeNull();
    const loaded = await awaitBotBooks(bot(['black']), async () => BLACK);
    expect(personalBookDecision(fenAfter('e4'), { books: loaded }, () => 0.5, {} as never)?.san).toBe('h5');
  });

  it('waits for a slow book for at most 1.5 s, then goes on without it; the load finishes in the background', async () => {
    vi.useFakeTimers();
    let release: (text: string) => void = () => undefined;
    const load = vi.fn(() => new Promise<string | null>((resolve) => (release = resolve)));
    const pending = awaitBotBooks(bot(['black']), load);
    let done = false;
    void pending.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(BOOK_LOAD_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual([]);
    // The book arrives later: the next move has it at once, and the loader was asked once
    release(BLACK);
    await vi.advanceTimersByTimeAsync(0);
    expect(await awaitBotBooks(bot(['black']), load)).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a book that arrives before the limit is used, and the timer is cleared', async () => {
    vi.useFakeTimers();
    const load = () => new Promise<string | null>((resolve) => setTimeout(() => resolve(BLACK), 400));
    const pending = awaitBotBooks(bot(['black']), load);
    await vi.advanceTimersByTimeAsync(400);
    expect(await pending).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a loaded book for the session, and does not keep a miss (the first run writes the books a moment late)', async () => {
    const load = vi.fn<(name: string) => Promise<string | null>>().mockResolvedValueOnce(null).mockResolvedValue(BLACK);
    expect(await awaitBotBooks(bot(['black']), load)).toEqual([]);
    expect(await awaitBotBooks(bot(['black']), load)).toHaveLength(1);
    expect(await awaitBotBooks(bot(['black']), load)).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('warms referenced books in idle moments: nothing is read until the task runs, and a loaded book is not read again', async () => {
    const load = vi.fn(async () => BLACK);
    const tasks: (() => void)[] = [];
    warmBotBooks(bot(['black', 'white']), (task) => tasks.push(task), load);
    expect(tasks).toHaveLength(2);
    expect(load).not.toHaveBeenCalled();
    tasks.forEach((task) => task());
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    await awaitBotBooks(bot(['black', 'white']), load);
    expect(load).toHaveBeenCalledTimes(2);
    const more: (() => void)[] = [];
    warmBotBooks(bot(['black', 'white']), (task) => more.push(task), load);
    expect(more).toHaveLength(0);
    warmBotBooks(bot(['black']), (task) => more.push(task));
    expect(more).toHaveLength(0);
  });
});

describe('the preset books in the settings store', () => {
  it('"reset bot data" leaves the books a preset brought alone, and deletes the books built on the device', async () => {
    const store = memorySettings();
    await store.writeSetting(botBookKey('me'), 'built here');
    await store.writeSetting(presetBookKey('me'), WHITE);
    expect(BOT_SETTING_KEYS).not.toContain(presetBookKey('me'));
    expect(presetBookKey('me').startsWith('bots.preset.')).toBe(true);
    await resetBotData(store);
    expect(store.rows.has(botBookKey('me'))).toBe(false);
    expect(store.rows.get(presetBookKey('me'))).toBe(WHITE);
  });

  it('a write that fails leaves that book out and the others are written; nothing throws', async () => {
    const store = memorySettings({ failWritesFor: ['two'] });
    const written = await savePresetBooks(store, { one: WHITE, two: BLACK, three: WHITE });
    expect(written).toEqual(['one', 'three']);
    expect(await readPresetBookText(store, 'two')).toBeNull();
    expect(await readPresetBookText(store, 'one')).toBe(WHITE);
    const broken = { readSetting: async () => Promise.reject(new Error('closed')) };
    expect(await readPresetBookText(broken as never, 'one')).toBeNull();
  });
});

describe('a gift-sized preset by reference, from the file to the first book move', () => {
  it('parses whole, is stored once per book, keeps a tiny profile, and the loader gives the bots their books in order', async () => {
    const me = syntheticBook(1_614_000, 'm');
    const peak = syntheticBook(70_000, 'p');
    const student = syntheticBook(2_450_000, 's');
    const file = {
      version: 1,
      profile: { displayName: 'Ada' },
      settings: { newGame: { botRating: 1450, botStyle: 'solid' } },
      books: { me, peak, student },
      bots: [
        { name: 'Rook', rating: 800, style: 'solid' },
        { name: 'Your level', rating: 1450, style: 'solid', bookRefs: ['me'] },
        { name: 'Peak you', rating: 1550, style: 'solid', bookRefs: ['peak', 'me'] },
        { name: 'Your Student', rating: 1250, style: 'solid', bookRefs: ['student'] },
      ],
    };
    // As the first run reads it: text, JSON, the real parser
    const parsed = parsePreset(JSON.parse(JSON.stringify(file)));
    expect(parsed.problems).toEqual([]);
    expect(parsed.preset!.settings.newGame).toMatchObject({ botRating: 1450, botStyle: 'solid' });
    expect(parsed.preset!.books).toEqual({ me, peak, student });
    expect(parsed.preset!.bots.map((b) => b.bookRefs ?? [])).toEqual([[], ['me'], ['peak', 'me'], ['student']]);

    // As applyPreset does: the profile (names only) to localStorage, the books to the database
    const storage = new Map<string, string>();
    const store = new ProfileStore({
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => void storage.set(k, v),
      removeItem: (k) => void storage.delete(k),
    });
    store.set({ displayName: 'Ada', bots: parsed.preset!.bots });
    expect(storage.get(PROFILE_STORAGE_KEY)!.length).toBeLessThan(2_000);
    const db = memorySettings();
    expect(await savePresetBooks(db, parsed.preset!.books!)).toEqual(['me', 'peak', 'student']);
    expect([...db.rows.keys()].sort()).toEqual(['bots.preset.me', 'bots.preset.peak', 'bots.preset.student']);

    // After a reload: the profile from localStorage, the books through the loader
    const reloaded = new ProfileStore({
      getItem: (k) => storage.get(k) ?? null,
      setItem: () => undefined,
      removeItem: () => undefined,
    }).get();
    const load = (name: string) => readPresetBookText(db, name);
    // The Play screen finds a named bot by rating (a style change keeps the bot), so the books are asked the same way
    const peakYou = await awaitBotBooks(namedBotForRating(reloaded, 1550, 'solid'), load);
    expect(peakYou).toHaveLength(2);
    expect(Object.keys(peakYou[0]!.entries).length).toBeLessThan(Object.keys(peakYou[1]!.entries).length);
    expect(await awaitBotBooks(namedBotForRating(reloaded, 1550, 'aggressive'), load)).toEqual(peakYou);
    expect(await awaitBotBooks(namedBotForRating(reloaded, 1250, 'solid'), load)).toHaveLength(1);
    expect(await awaitBotBooks(namedBotForRating(reloaded, 1250, 'gambiteer'), load)).toHaveLength(1);
    expect(await awaitBotBooks(namedBotForRating(reloaded, 800, 'solid'), load)).toEqual([]);
    expect(await awaitBotBooks(namedBotForRating(reloaded, 1000, 'solid'), load)).toEqual([]);

    // And a backup carries the rows: every book row is a plain string
    expect([...db.rows.values()].every((v) => typeof v === 'string')).toBe(true);
    expect(PRESET_LIMITS.bookTableTotalChars).toBeGreaterThan(me.length + peak.length + student.length);
  }, 60_000);
});
