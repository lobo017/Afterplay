import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBook, serializeBook, type Book } from '../../src/engine/bot-profile';
import { presetBookKey, readPresetBookText, savePresetBooks } from '../../src/engine/bot-profile-store';
import {
  checkBotsUpdate,
  loadFirstRunState,
  saveFirstRunState,
  type BotsUpdateOptions,
  type BotsUpdateResult,
  type FirstRunState,
} from '../../src/preset/first-run';
import { PRESET_LIMITS, parsePreset } from '../../src/preset/preset';
import { ProfileStore, awaitBotBooks } from '../../src/preset/profile';
import { AppSettingsStore } from '../../src/ui/app-settings';
import { record } from './helpers/book-games';

// The bots-only update reads a file of several megabytes. It checks the books table by name, text and size only (each
// book is parsed when a bot uses it), and no step shares a task with another. Invented names and books only.

const bookOf = (games: string[][]): Book =>
  buildBook(
    games.map((g) => record(g)),
    { side: 'own' },
  ).book;
const GOOD = serializeBook(bookOf([['e4', 'e5', 'Nf3']]));
const OTHER = serializeBook(bookOf([['d4', 'd5', 'c4']]));

const SLUG = 'sample';
const BUILD_OLD = 'index-OLD00001';
const BUILD_NEW = 'index-NEW00002';

const OLD_BOTS = [
  { name: 'Ada One', rating: 600, style: 'solid' },
  { name: 'Ada Two', rating: 800, style: 'solid' },
];

/** A new list of two bots that refer to table books by name (the names are the test's own: loaded books are cached by name). */
const presetWith = (books: Record<string, unknown>, refs: [string[], string[]]) => ({
  version: 1,
  botsRevision: 1,
  bots: [
    { name: 'Ada New', rating: 1489, style: 'solid', bookRefs: refs[0] },
    { name: 'Ada Newer', rating: 1700, style: 'solid', bookRefs: refs[1] },
  ],
  books,
});

class MemoryStorage {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** A device that applied the link with the old list under an older build. */
function device(options: { failFor?: string[] } = {}) {
  const profile = new ProfileStore(new MemoryStorage());
  profile.replace({ displayName: 'Tester', bots: OLD_BOTS });
  const settings = new AppSettingsStore({ newGame: { botRating: 800, timeControlId: '10+0' } });
  const rows = new Map<string, unknown>();
  rows.set(presetBookKey('upd-old'), 'an old preset book');
  const writes: string[][] = [];
  const stateStorage = new MemoryStorage();
  let state: FirstRunState = { slug: SLUG, welcomeSeen: true, botsBuild: BUILD_OLD };
  saveFirstRunState(state, stateStorage);
  const store = {
    writeSetting: async <T>(key: string, value: T) => {
      if (options.failFor?.some((name) => key.endsWith(name))) throw new Error('quota');
      rows.set(key, value);
    },
  };
  return {
    profile,
    rows,
    writes,
    stored: () => loadFirstRunState(stateStorage),
    run(body: unknown, overrides: Partial<BotsUpdateOptions> = {}): Promise<BotsUpdateResult> {
      return checkBotsUpdate({
        pathname: `/start/${SLUG}/`,
        state,
        build: BUILD_NEW,
        profile,
        newGame: {
          get: () => settings.get().newGame,
          setBotRating: (botRating) => settings.set({ newGame: { botRating } }),
        },
        writeBooks: (books) => {
          writes.push(Object.keys(books));
          return savePresetBooks(store, books);
        },
        isBusy: () => false,
        recordBuild: (botsBuild) => {
          state = { ...state, botsBuild };
          saveFirstRunState(state, stateStorage);
        },
        fetchPreset: () => Promise.resolve(json(body)),
        ...overrides,
      });
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the bots-only update: the books table is checked by name and size, not parsed', () => {
  it('takes a valid table: one row per book, each written on its own, then the profile', async () => {
    const d = device();
    const body = presetWith({ 'upd-a': GOOD, 'upd-b': OTHER, 'upd-c': GOOD }, [['upd-a', 'upd-b'], ['upd-c']]);
    expect(await d.run(body)).toEqual({ kind: 'updated', revision: 1 });
    expect(d.writes).toEqual([['upd-a'], ['upd-b'], ['upd-c']]);
    expect(d.rows.get(presetBookKey('upd-a'))).toBe(GOOD);
    expect(d.rows.get(presetBookKey('upd-b'))).toBe(OTHER);
    expect(d.profile.get().bots.map((bot) => bot.name)).toEqual(['Ada New', 'Ada Newer']);
    expect(d.profile.get().botsRevision).toBe(1);
    expect(d.stored().botsBuild).toBe(BUILD_NEW);
    // Never deleted: the old preset book stays
    expect(d.rows.get(presetBookKey('upd-old'))).toBe('an old preset book');
  });

  it('leaves out a book with a name the bots cannot reference, a book that is not text and one over the size limit', async () => {
    const d = device();
    const body = presetWith(
      {
        'upd-fine': GOOD,
        'Bad Name': GOOD,
        'upd-number': 5,
        'upd-huge': 'x'.repeat(PRESET_LIMITS.bookTableChars + 1),
      },
      [['upd-fine', 'Bad Name', 'upd-number'], ['upd-huge']],
    );
    expect(await d.run(body)).toEqual({ kind: 'updated', revision: 1 });
    expect([...d.rows.keys()].filter((key) => key !== presetBookKey('upd-old'))).toEqual([presetBookKey('upd-fine')]);
    // The bots keep only the references that exist
    expect(d.profile.get().bots[0]?.bookRefs).toEqual(['upd-fine']);
    expect(d.profile.get().bots[1]?.bookRefs ?? []).toEqual([]);
  });

  it('keeps the table within its total, as before: the book that would push it over is left out', async () => {
    const d = device();
    const big = 'x'.repeat(2_500_000);
    const body = presetWith({ 'upd-one': big, 'upd-two': big, 'upd-three': big }, [
      ['upd-one', 'upd-two', 'upd-three'],
      [],
    ]);
    expect(await d.run(body)).toEqual({ kind: 'updated', revision: 1 });
    expect(d.writes).toEqual([['upd-one'], ['upd-two']]);
  });

  it('parsePreset checks every table book by default (the first run), and only names and sizes with checkTableBooks: false', () => {
    const body = presetWith({ 'upd-good': GOOD, 'upd-broken': 'not a book', 'Bad Name': GOOD }, [
      ['upd-good', 'upd-broken'],
      [],
    ]);
    const whole = parsePreset(body);
    expect(Object.keys(whole.preset?.books ?? {})).toEqual(['upd-good']);
    expect(whole.problems.some((p) => p.includes('"upd-broken"') && p.includes('not a valid opening book'))).toBe(true);
    const light = parsePreset(body, { checkTableBooks: false });
    expect(Object.keys(light.preset?.books ?? {})).toEqual(['upd-good', 'upd-broken']);
    expect(light.problems.some((p) => p.includes('not a valid opening book'))).toBe(false);
    // The name check is the same in both
    expect(light.problems.some((p) => p.includes('not a book name'))).toBe(true);
    expect(whole.problems.some((p) => p.includes('not a book name'))).toBe(true);
    expect(light.preset?.bots[0]?.bookRefs).toEqual(['upd-good', 'upd-broken']);
    expect(whole.preset?.bots[0]?.bookRefs).toEqual(['upd-good']);
  });
});

describe('a stored book that is not a book: the bot plays without it, no crash', () => {
  it('an update stores the text as it is, and the loader gives the bot only the books that read', async () => {
    const d = device();
    const body = presetWith(
      {
        'upd-ok': GOOD,
        'upd-corrupt': 'not a book',
        'upd-shape': '{"v":1,"pliesCap":10}',
        'upd-cut': GOOD.slice(0, 40),
      },
      [['upd-ok', 'upd-corrupt', 'upd-shape'], ['upd-cut']],
    );
    expect(await d.run(body)).toEqual({ kind: 'updated', revision: 1 });
    expect(d.rows.get(presetBookKey('upd-corrupt'))).toBe('not a book');
    const load = (name: string) =>
      readPresetBookText({ readSetting: async <T>(key: string) => d.rows.get(key) as T }, name);
    const [first, second] = d.profile.get().bots;
    const books = await awaitBotBooks(first!, load);
    expect(books).toHaveLength(1);
    expect(Object.keys(books[0]!.entries).length).toBeGreaterThan(0);
    // A bot whose only book is cut off plays as the usual bot: no book, no throw
    await expect(awaitBotBooks(second!, load)).resolves.toEqual([]);
    // A row that is not text at all, and a loader that throws, give the same
    d.rows.set(presetBookKey('upd-cut'), 12345);
    await expect(awaitBotBooks(second!, load)).resolves.toEqual([]);
    await expect(
      awaitBotBooks(second!, async () => {
        throw new Error('database closed');
      }),
    ).resolves.toEqual([]);
  });
});

describe('the bots-only update: a task for each step, the game check after each', () => {
  /** Runs the update with only `setTimeout` faked, counting how many times it waited for the event loop. */
  async function yieldsOf(d: ReturnType<typeof device>, body: unknown) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The update's own waits are the zero-delay timers (its only other timer is the 30 s limit on the request)
    const timers = vi.spyOn(globalThis, 'setTimeout');
    let result: BotsUpdateResult | undefined;
    void d.run(body).then((r) => (result = r));
    for (let i = 0; i < 200 && result === undefined; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      // 1 ms, not 0: the fake clock gives a zero-delay timer made inside a tick a delay of 1 ms
      if (result === undefined && vi.getTimerCount() > 0) await vi.advanceTimersByTimeAsync(1);
    }
    const yields = timers.mock.calls.filter(([, delay]) => delay === 0).length;
    timers.mockRestore();
    vi.useRealTimers();
    return { result, yields };
  }

  const BODY = presetWith({ 'upd-a': GOOD, 'upd-b': OTHER, 'upd-c': GOOD }, [['upd-a', 'upd-b'], ['upd-c']]);

  it('yields to the event loop after the body, after the JSON, after the check, and after each of the books', async () => {
    const { result, yields } = await yieldsOf(device(), BODY);
    expect(result).toEqual({ kind: 'updated', revision: 1 });
    // body, JSON, the check of the list, then three books
    expect(yields).toBe(3 + 3);
  });

  it('a list that is not newer needs the first two yields only', async () => {
    const d = device();
    d.profile.set({ botsRevision: 1 });
    const { result, yields } = await yieldsOf(d, BODY);
    expect(result).toEqual({ kind: 'unchanged' });
    expect(yields).toBe(2);
  });

  it('asks whether a game is in progress at the start and after every yield; a game that begins at any of them stops the update', async () => {
    let calls = 0;
    const probe = device();
    expect(
      await probe.run(BODY, {
        isBusy: () => {
          calls++;
          return false;
        },
      }),
    ).toEqual({ kind: 'updated', revision: 1 });
    // the start, the body, the JSON, the check, then one for each of the three books (the last is the one before the profile)
    expect(calls).toBe(1 + 3 + 3);
    for (let stopAt = 1; stopAt <= calls; stopAt++) {
      const d = device();
      const before = JSON.stringify(d.profile.get());
      let n = 0;
      const result = await d.run(BODY, { isBusy: () => ++n >= stopAt });
      expect(result).toEqual({ kind: 'skipped', reason: 'busy' });
      // The profile and the build are as they were; whatever books were written stay (books are only added)
      expect(JSON.stringify(d.profile.get())).toBe(before);
      expect(d.stored().botsBuild).toBe(BUILD_OLD);
      expect(d.rows.get(presetBookKey('upd-old'))).toBe('an old preset book');
    }
  });

  it('stops at the first book that cannot be written: nothing after it is written, the profile and the build are as they were', async () => {
    const d = device({ failFor: ['upd-b'] });
    const before = JSON.stringify(d.profile.get());
    expect(await d.run(BODY)).toEqual({ kind: 'failed' });
    expect(d.writes).toEqual([['upd-a'], ['upd-b']]);
    expect(JSON.stringify(d.profile.get())).toBe(before);
    expect(d.stored().botsBuild).toBe(BUILD_OLD);
  });
});
