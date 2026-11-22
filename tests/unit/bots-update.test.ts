import { describe, expect, it } from 'vitest';
import { buildBook, serializeBook, type Book } from '../../src/engine/bot-profile';
import { presetBookKey, savePresetBooks } from '../../src/engine/bot-profile-store';
import { buildIdFromScriptUrl } from '../../src/preset/build-id';
import {
  FIRST_RUN_STORAGE_KEY,
  checkBotsUpdate,
  loadFirstRunState,
  remapSavedRating,
  saveFirstRunState,
  type BotsUpdateOptions,
  type BotsUpdateResult,
  type FirstRunState,
} from '../../src/preset/first-run';
import { ProfileStore } from '../../src/preset/profile';
import { AppSettingsStore } from '../../src/ui/app-settings';
import { record } from './helpers/book-games';

// Invented names, ratings, books and games only: nothing here comes from a real player.

const bookOf = (games: string[][]): Book =>
  buildBook(
    games.map((g) => record(g)),
    { side: 'own' },
  ).book;
const BOOKS = {
  student: serializeBook(bookOf([['e4', 'e5', 'Nf3']])),
  'student-bullet': serializeBook(bookOf([['d4', 'd5', 'c4']])),
  'student-blitz': serializeBook(bookOf([['c4', 'e5', 'Nc3']])),
  'student-rapid': serializeBook(bookOf([['Nf3', 'd5', 'g3']])),
};

const SLUG = 'sample';
const PATH = `/start/${SLUG}/`;
const BUILD_OLD = 'index-OLD00001';
const BUILD_NEW = 'index-NEW00002';

/** The old list: six bots, the Student one bot at 1345. The new list: one Student with classes, revision 1. */
const OLD_BOTS = [
  { name: 'Ada One', rating: 600, style: 'solid' },
  { name: 'Ada Two', rating: 800, style: 'solid' },
  { name: 'Ada Three', rating: 1000, style: 'solid' },
  { name: 'Ada Four', rating: 1200, style: 'solid' },
  { name: 'Ada Five', rating: 1600, style: 'solid' },
  { name: 'Your Student', rating: 1345, style: 'solid' },
];
const NEW_PRESET = {
  version: 1,
  botsRevision: 1,
  bots: [
    {
      name: 'Your Student',
      rating: 1489,
      style: 'solid',
      bookRefs: ['student-rapid', 'student'],
      classes: {
        bullet: { rating: 1300, bookRefs: ['student-bullet', 'student'] },
        blitz: { rating: 1425, bookRefs: ['student-blitz', 'student'] },
        rapid: { rating: 1489, bookRefs: ['student-rapid', 'student'] },
      },
    },
  ],
  books: BOOKS,
};

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

/** The database's settings rows (books, the sync's month record, the books learned from my games), in memory. */
function memoryRows(options: { failFor?: string[] } = {}) {
  const rows = new Map<string, unknown>();
  const log: string[] = [];
  return {
    rows,
    log,
    store: {
      writeSetting: async <T>(key: string, value: T) => {
        if (options.failFor?.some((name) => key.endsWith(name))) throw new Error('quota');
        log.push(`book:${key}`);
        rows.set(key, value);
      },
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A device that applied the link with the old list, under an older build, with everything a user collects. */
function device(
  extra: { rowsFailFor?: string[]; theme?: string; botRating?: number; timeControlId?: '5+0' | '10+0' } = {},
) {
  const profileStorage = new MemoryStorage();
  const profile = new ProfileStore(profileStorage);
  profile.replace({
    displayName: 'Tester',
    title: 'FM',
    appName: 'Afterplay',
    welcome: { title: 'Hello', message: 'A welcome.', from: 'Ada' },
    story: { intro: 'An intro.', closing: 'A closing.' },
    bots: OLD_BOTS,
  });
  const settings = new AppSettingsStore({
    boardTheme: extra.theme ?? 'green',
    newGame: { botRating: extra.botRating ?? 1345, timeControlId: extra.timeControlId ?? '10+0' },
  });
  const db = memoryRows(extra.rowsFailFor ? { failFor: extra.rowsFailFor } : {});
  db.rows.set('sync.chesscom', { month: '2026-10' });
  db.rows.set('bots.me', 'learned from my games');
  db.rows.set(presetBookKey('old-book'), 'an old preset book');
  const games = Object.freeze([Object.freeze({ id: 'g1', pgn: '1. e4 *' })]);
  const puzzles = Object.freeze([Object.freeze({ id: 'p1' })]);
  const history = Object.freeze({ games: 1 });
  const stateStorage = new MemoryStorage();
  let state: FirstRunState = { slug: SLUG, welcomeSeen: true, botsBuild: BUILD_OLD };
  saveFirstRunState(state, stateStorage);
  const fetched: string[] = [];
  return {
    profile,
    settings,
    db,
    games,
    puzzles,
    history,
    stateStorage,
    fetched,
    get state() {
      return state;
    },
    /** Everything that is not a bot: what an update must leave exactly as it is. */
    snapshot() {
      const { bots: _bots, botsRevision: _revision, ...profileRest } = this.profile.get();
      const { newGame, ...settingsRest } = this.settings.get();
      const { botRating: _rating, ...newGameRest } = newGame;
      const rows = new Map(this.db.rows);
      return JSON.parse(
        JSON.stringify({
          profileRest,
          settingsRest,
          newGameRest,
          welcomeSeen: this.state.welcomeSeen,
          slug: this.state.slug,
          rows: [...rows].filter(([key]) => !key.startsWith('bots.preset.student')),
          games,
          puzzles,
          history,
        }),
      ) as unknown;
    },
    run(overrides: Partial<BotsUpdateOptions> & { answer?: () => Promise<Response>; busy?: () => boolean } = {}) {
      const { answer, busy, ...rest } = overrides;
      return checkBotsUpdate({
        pathname: PATH,
        state,
        build: BUILD_NEW,
        profile: this.profile,
        newGame: {
          get: () => this.settings.get().newGame,
          setBotRating: (botRating) => this.settings.set({ newGame: { botRating } }),
        },
        writeBooks: (books) => savePresetBooks(this.db.store, books),
        isBusy: busy ?? (() => false),
        recordBuild: (botsBuild) => {
          state = { ...state, botsBuild };
          saveFirstRunState(state, this.stateStorage);
        },
        fetchPreset: (url) => {
          fetched.push(url);
          return (answer ?? (() => Promise.resolve(json(NEW_PRESET))))();
        },
        ...rest,
      });
    },
  };
}

const kind = (r: BotsUpdateResult) => r.kind;

describe('the bots-only update: when it asks and when it does not', () => {
  it('is skipped without a build id (the dev server, an unknown page): no request, nothing recorded', async () => {
    const d = device();
    expect(await d.run({ build: null })).toEqual({ kind: 'skipped', reason: 'no-build' });
    expect(d.fetched).toEqual([]);
    expect(d.state.botsBuild).toBe(BUILD_OLD);
  });

  it('is skipped when this build already looked, with no request', async () => {
    const d = device();
    expect(await d.run({ build: BUILD_OLD })).toEqual({ kind: 'skipped', reason: 'same-build' });
    expect(d.fetched).toEqual([]);
  });

  it('is skipped on an address that is not the link this device applied', async () => {
    const d = device();
    expect(await d.run({ pathname: '/' })).toEqual({ kind: 'skipped', reason: 'not-this-link' });
    expect(await d.run({ pathname: '/start/another-link/' })).toEqual({ kind: 'skipped', reason: 'not-this-link' });
    expect(d.fetched).toEqual([]);
  });

  it('is skipped while a game is in progress, with no request, and the build stays unrecorded', async () => {
    const d = device();
    const before = JSON.stringify(d.profile.get());
    expect(await d.run({ busy: () => true })).toEqual({ kind: 'skipped', reason: 'busy' });
    expect(d.fetched).toEqual([]);
    expect(d.state.botsBuild).toBe(BUILD_OLD);
    expect(JSON.stringify(d.profile.get())).toBe(before);
  });

  it('changes nothing when a game starts while the file is loading', async () => {
    const d = device();
    let busy = false;
    const before = JSON.stringify(d.profile.get());
    const result = await d.run({
      busy: () => busy,
      answer: () => {
        busy = true;
        return Promise.resolve(json(NEW_PRESET));
      },
    });
    expect(result).toEqual({ kind: 'skipped', reason: 'busy' });
    expect(JSON.stringify(d.profile.get())).toBe(before);
    expect(d.state.botsBuild).toBe(BUILD_OLD);
    expect([...d.db.rows.keys()].some((k) => k.startsWith('bots.preset.student'))).toBe(false);
  });

  it("asks for the link's own preset file and nothing else", async () => {
    const d = device();
    await d.run();
    expect(d.fetched).toEqual([`/start/${SLUG}/preset.json`]);
  });
});

describe('the bots-only update: the revision', () => {
  it('records the build and changes nothing when the revision is the same', async () => {
    const d = device();
    d.profile.set({ botsRevision: 1 });
    const before = JSON.stringify(d.profile.get());
    expect(await d.run()).toEqual({ kind: 'unchanged' });
    expect(JSON.stringify(d.profile.get())).toBe(before);
    expect(d.state.botsBuild).toBe(BUILD_NEW);
    expect(loadFirstRunState(d.stateStorage).botsBuild).toBe(BUILD_NEW);
    expect([...d.db.rows.keys()].some((k) => k.startsWith('bots.preset.student'))).toBe(false);
  });

  it('records the build and changes nothing when the revision is lower (or the file has none)', async () => {
    const d = device();
    d.profile.set({ botsRevision: 5 });
    const before = JSON.stringify(d.profile.get());
    expect(await d.run()).toEqual({ kind: 'unchanged' });
    expect(JSON.stringify(d.profile.get())).toBe(before);
    const d2 = device();
    const { botsRevision: _gone, ...withoutRevision } = NEW_PRESET;
    expect(await d2.run({ answer: () => Promise.resolve(json(withoutRevision)) })).toEqual({ kind: 'unchanged' });
    expect(d2.profile.get().bots).toHaveLength(6);
  });

  it('tells a list that is not newer by its number alone, without checking its books (a task of 100 ms and more on a real file)', async () => {
    const d = device();
    d.profile.set({ botsRevision: 1 });
    // The books table is garbage: reading the whole preset would report it, the number check never looks
    const garbage = { ...NEW_PRESET, books: { student: 'not a book', 'student-blitz': 5 } };
    expect(await d.run({ answer: () => Promise.resolve(json(garbage)) })).toEqual({ kind: 'unchanged' });
    expect(d.state.botsBuild).toBe(BUILD_NEW);
    // A newer list is checked before it is taken: bad names, types and sizes in the books table are left out, but the
    // text of a table book is not parsed (a text that is not a book gives a bot without books when the bot is used)
    const d2 = device();
    expect(await d2.run({ answer: () => Promise.resolve(json(garbage)) })).toEqual({ kind: 'updated', revision: 1 });
  });

  it('replaces the bots when the revision is higher, and keeps the new revision', async () => {
    const d = device();
    expect(await d.run()).toEqual({ kind: 'updated', revision: 1 });
    const bots = d.profile.get().bots;
    expect(bots).toHaveLength(1);
    expect(bots[0]).toMatchObject({ name: 'Your Student', rating: 1489 });
    expect(Object.keys(bots[0]?.classes ?? {})).toEqual(['bullet', 'blitz', 'rapid']);
    expect(d.profile.get().botsRevision).toBe(1);
    expect(d.state.botsBuild).toBe(BUILD_NEW);
    // The books of the new list are in the database, one row each
    for (const name of Object.keys(BOOKS))
      expect(d.db.rows.get(presetBookKey(name))).toBe(BOOKS[name as keyof typeof BOOKS]);
  });
});

describe('the bots-only update: books first, the profile last', () => {
  it('writes every book before it writes the profile', async () => {
    const d = device();
    const order: string[] = [];
    const real = d.profile.set.bind(d.profile);
    d.profile.set = (patch) => {
      order.push('profile');
      real(patch);
    };
    await d.run({
      writeBooks: async (books) => {
        const written = await savePresetBooks(d.db.store, books);
        order.push(...written.map((name) => `book:${name}`));
        return written;
      },
    });
    expect(order.at(-1)).toBe('profile');
    expect(order.filter((x) => x === 'profile')).toHaveLength(1);
    expect(order.slice(0, -1).sort()).toEqual(
      Object.keys(BOOKS)
        .map((n) => `book:${n}`)
        .sort(),
    );
  });

  it('changes nothing and leaves the build unrecorded when a book cannot be written', async () => {
    const d = device({ rowsFailFor: ['student-blitz'] });
    const before = JSON.stringify(d.profile.get());
    const settingsBefore = JSON.stringify(d.settings.get());
    expect(await d.run()).toEqual({ kind: 'failed' });
    expect(JSON.stringify(d.profile.get())).toBe(before);
    expect(JSON.stringify(d.settings.get())).toBe(settingsBefore);
    expect(d.state.botsBuild).toBe(BUILD_OLD);
  });

  it('changes nothing when the books store throws', async () => {
    const d = device();
    const before = JSON.stringify(d.profile.get());
    const result = await d.run({ writeBooks: () => Promise.reject(new Error('database closed')) });
    expect(result).toEqual({ kind: 'failed' });
    expect(JSON.stringify(d.profile.get())).toBe(before);
    expect(d.state.botsBuild).toBe(BUILD_OLD);
  });
});

describe('the bots-only update: answers that are not a usable preset', () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ['not JSON', () => Promise.resolve(new Response('this is not json', { status: 200 }))],
    [
      'an HTML page (a host that answers every path)',
      () =>
        Promise.resolve(
          new Response('<!doctype html><title>x</title>', { status: 200, headers: { 'content-type': 'text/html' } }),
        ),
    ],
    ['a 404', () => Promise.resolve(new Response('none', { status: 404 }))],
    ['a 500', () => Promise.resolve(new Response('error', { status: 500 }))],
    ['offline', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a preset with no bot', () => Promise.resolve(json({ ...NEW_PRESET, bots: [] }))],
    [
      'a preset whose bots are all invalid',
      () => Promise.resolve(json({ ...NEW_PRESET, bots: [{ name: '', rating: 5 }] })),
    ],
    ['a version this app cannot read', () => Promise.resolve(json({ ...NEW_PRESET, version: 2 }))],
    ['a JSON value that is not an object', () => Promise.resolve(json([1, 2, 3]))],
  ];
  for (const [name, answer] of cases) {
    it(`changes nothing and records nothing for ${name}`, async () => {
      const d = device();
      const before = JSON.stringify(d.profile.get());
      const rows = [...d.db.rows.keys()];
      expect(kind(await d.run({ answer }))).toBe('failed');
      expect(JSON.stringify(d.profile.get())).toBe(before);
      expect([...d.db.rows.keys()]).toEqual(rows);
      expect(d.state.botsBuild).toBe(BUILD_OLD);
      expect(loadFirstRunState(d.stateStorage).botsBuild).toBe(BUILD_OLD);
    });
  }

  it('gives up on a file that never arrives', async () => {
    const d = device();
    const result = await d.run({
      timeoutMs: 20,
      fetchPreset: (_url, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });
    expect(result).toEqual({ kind: 'failed' });
    expect(d.state.botsBuild).toBe(BUILD_OLD);
  });

  it('never throws, whatever the hooks do', async () => {
    const d = device();
    await expect(
      d.run({
        isBusy: () => {
          throw new Error('boom');
        },
      }),
    ).resolves.toEqual({ kind: 'failed' });
  });
});

describe('the bots-only update: everything that is not a bot stays as it was', () => {
  it('leaves settings, theme, names, welcome, story, games, puzzles, history and every other row exactly as they were', async () => {
    const d = device({ theme: 'imperial-walnut', botRating: 1000 });
    const before = d.snapshot();
    expect(await d.run()).toEqual({ kind: 'updated', revision: 1 });
    expect(d.snapshot()).toEqual(before);
    // Named, not just compared: the fields the update must never touch
    expect(d.profile.get()).toMatchObject({
      displayName: 'Tester',
      title: 'FM',
      appName: 'Afterplay',
      welcome: { title: 'Hello', message: 'A welcome.', from: 'Ada' },
      story: { intro: 'An intro.', closing: 'A closing.' },
    });
    expect(d.settings.get().boardTheme).toBe('imperial-walnut');
    expect(d.state).toMatchObject({ slug: SLUG, welcomeSeen: true });
    // The saved rating belonged to no replaced bot, and stays
    expect(d.settings.get().newGame.botRating).toBe(1000);
  });

  it('never deletes a book row: the old preset book and the books learned from my games stay', async () => {
    const d = device();
    await d.run();
    expect(d.db.rows.get(presetBookKey('old-book'))).toBe('an old preset book');
    expect(d.db.rows.get('bots.me')).toBe('learned from my games');
    expect(d.db.rows.get('sync.chesscom')).toEqual({ month: '2026-10' });
  });

  it("does not touch the preset's other fields (settings, names, welcome in the file are ignored)", async () => {
    const d = device({ theme: 'green' });
    const before = d.snapshot();
    const loud = {
      ...NEW_PRESET,
      appName: 'Other name',
      profile: { displayName: 'Someone else', title: 'GM' },
      welcome: { title: 'New', message: 'A new welcome.', from: 'Nobody' },
      story: { intro: 'new', closing: 'new' },
      settings: { boardTheme: 'high-contrast', newGame: { botRating: 400, timeControlId: '1+0' } },
      usernames: { lichess: 'someone', chesscom: 'someone' },
    };
    expect(await d.run({ answer: () => Promise.resolve(json(loud)) })).toEqual({ kind: 'updated', revision: 1 });
    expect(d.snapshot()).toEqual(before);
    expect(d.settings.get().boardTheme).toBe('green');
    expect(d.settings.get().newGame.botRating).toBe(1489);
    expect(d.settings.get().newGame.timeControlId).toBe('10+0');
  });
});

describe('the bots-only update: two tabs, a restored backup', () => {
  it('is idempotent: two updates at once give the one result', async () => {
    const d = device();
    const [a, b] = await Promise.all([d.run(), d.run()]);
    expect([a.kind, b.kind].every((k) => k === 'updated' || k === 'unchanged')).toBe(true);
    const bots = d.profile.get().bots;
    expect(bots).toHaveLength(1);
    expect(d.profile.get().botsRevision).toBe(1);
    expect(d.state.botsBuild).toBe(BUILD_NEW);
    // A third, later run is a plain no-op
    const after = JSON.stringify(d.profile.get());
    expect(kind(await d.run({ build: 'index-NEW00003' }))).toBe('unchanged');
    expect(JSON.stringify(d.profile.get())).toBe(after);
  });

  it('merges again at the next new build when a restored backup brought the old profile back', async () => {
    const d = device();
    const oldProfile = JSON.parse(JSON.stringify(d.profile.get())) as unknown;
    expect(await d.run()).toEqual({ kind: 'updated', revision: 1 });
    // A restore puts the old profile (revision 0) back; the build that looked stays recorded
    d.profile.replace(oldProfile);
    expect(d.profile.get().bots).toHaveLength(6);
    expect(await d.run({ build: BUILD_NEW })).toEqual({ kind: 'skipped', reason: 'same-build' });
    // The next build asks again and takes the list again
    expect(await d.run({ build: 'index-NEW00003' })).toEqual({ kind: 'updated', revision: 1 });
    expect(d.profile.get().bots).toHaveLength(1);
  });
});

describe('the bots-only update: the saved New game rating', () => {
  it('remaps a saved 1345 (the old Student, one bot) to the class rating of the chip, by name', async () => {
    const rapid = device({ botRating: 1345, timeControlId: '10+0' });
    await rapid.run();
    expect(rapid.settings.get().newGame.botRating).toBe(1489);
    const blitz = device({ botRating: 1345, timeControlId: '5+0' });
    await blitz.run();
    expect(blitz.settings.get().newGame.botRating).toBe(1425);
    expect(blitz.settings.get().newGame.timeControlId).toBe('5+0');
  });

  it('leaves a saved rating that is not one of a replaced bot', async () => {
    const d = device({ botRating: 1000 });
    await d.run();
    expect(d.settings.get().newGame.botRating).toBe(1000);
  });

  it('leaves a saved rating of a replaced bot that the new list does not have by name', async () => {
    const d = device({ botRating: 600 });
    await d.run();
    expect(d.settings.get().newGame.botRating).toBe(600);
  });

  it('the pure rule', () => {
    const old = [{ name: 'Your Student', rating: 1345, style: 'solid' as const }];
    const next = [
      {
        name: 'Your Student',
        rating: 1489,
        style: 'solid' as const,
        classes: { bullet: { rating: 1300 }, blitz: { rating: 1425 } },
      },
    ];
    expect(remapSavedRating(old, next, 1345, '1+0')).toBe(1300);
    expect(remapSavedRating(old, next, 1345, '3+2')).toBe(1425);
    expect(remapSavedRating(old, next, 1345, 'unlimited')).toBe(1489);
    expect(remapSavedRating(old, next, 1345, '15+10')).toBe(1489);
    expect(remapSavedRating(old, next, 999, '1+0')).toBeNull();
    expect(remapSavedRating(old, [{ name: 'Else', rating: 1489, style: 'solid' as const }], 1345, '1+0')).toBeNull();
    // Already the right rating: nothing to set
    expect(remapSavedRating(next, next, 1425, '3+0')).toBeNull();
  });
});

describe('the first-run state and the build id', () => {
  it('remembers the build that looked, and reads a device without one exactly as before', () => {
    const storage = new MemoryStorage();
    saveFirstRunState({ slug: SLUG, welcomeSeen: true }, storage);
    expect(loadFirstRunState(storage)).toEqual({ slug: SLUG, welcomeSeen: true });
    saveFirstRunState({ slug: SLUG, welcomeSeen: true, botsBuild: BUILD_NEW }, storage);
    expect(loadFirstRunState(storage)).toEqual({ slug: SLUG, welcomeSeen: true, botsBuild: BUILD_NEW });
    storage.setItem(FIRST_RUN_STORAGE_KEY, '{"slug":"a-b","welcomeSeen":false,"botsBuild":5}');
    expect(loadFirstRunState(storage)).toEqual({ slug: 'a-b', welcomeSeen: false });
  });

  it('takes the build id from the built entry script only, and from nothing else', () => {
    expect(buildIdFromScriptUrl('/assets/index-Dd9e-I7O.js')).toBe('index-Dd9e-I7O');
    expect(buildIdFromScriptUrl('https://example.test/assets/index-Dd9e-I7O.js', 'https://example.test/start/x/')).toBe(
      'index-Dd9e-I7O',
    );
    // The dev server, another chunk, an unhashed name, a path outside assets, nonsense
    expect(buildIdFromScriptUrl('/src/main.ts')).toBeNull();
    expect(buildIdFromScriptUrl('/assets/puzzle-trainer-p5827WOM.js')).toBeNull();
    expect(buildIdFromScriptUrl('/assets/index.js')).toBeNull();
    expect(buildIdFromScriptUrl('/other/index-Dd9e-I7O.js')).toBeNull();
    expect(buildIdFromScriptUrl('')).toBeNull();
    expect(buildIdFromScriptUrl('http://[bad', 'also bad')).toBeNull();
  });
});
