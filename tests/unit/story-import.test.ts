import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { GameLibrary } from '../../src/library/library';
import {
  addMoreAccount,
  chesscomAccountsOf,
  moreAccountsHtml,
  removeMoreAccount,
} from '../../src/library/more-accounts';
import { parsePreset, PRESET_LIMITS } from '../../src/preset/preset';
import { ProfileStore, sanitizeProfile } from '../../src/preset/profile';
import { WizardChessStorage, deleteWizardChessDB } from '../../src/storage/db';
import { computeStoryStats } from '../../src/story/stats';
import {
  STORY_SYNC_IMPORT_SETTING,
  importFailureOf,
  importProgressLine,
  parseSyncImportRecord,
} from '../../src/story/sync-import';
import { storyCards } from '../../src/story/text';
import { archiveMonthUrl, archivesListUrl } from '../../src/sync/chesscom-archive';
import {
  SYNC_STATE_SETTING,
  librarySyncStore,
  runChessComSync,
  syncStateKeyFor,
  type SyncFailure,
  type SyncFetch,
} from '../../src/sync/chesscom-sync';
import { FOES, ME, OTHER_ME, run, utc } from './helpers/story-games';

// Invented names only.
const DB = 'wizards-chess-story-import-test';
const NOW = utc(2026, 6, 20);

let storage: WizardChessStorage;
let library: GameLibrary;
beforeEach(async () => {
  await deleteWizardChessDB(DB);
  storage = await WizardChessStorage.create({ dbName: DB });
  library = new GameLibrary(storage);
  await library.init();
});
afterEach(async () => {
  storage.close();
  await deleteWizardChessDB(DB);
});

/** A fake archive: a list of months, each with no games (the order of the requests is what is looked at). */
function emptyArchive(player: string, months: string[]) {
  const urls: string[] = [];
  const answer = (body: unknown) => ({
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  });
  const fetchImpl: SyncFetch = async (url) => {
    urls.push(url);
    if (url === archivesListUrl(player)) return answer({ archives: months.map((m) => archiveMonthUrl(player, m)) });
    return answer({ games: [] });
  };
  return { urls, fetchImpl };
}

const syncDeps = (player: string, fetchImpl: SyncFetch, stateKey?: string) => ({
  username: player,
  fetchImpl,
  sleep: async () => undefined,
  now: () => NOW,
  store: librarySyncStore(library, stateKey),
  isAutoAnalyzeOn: () => false,
  queueReviews: () => undefined,
});

describe('sync: month order and the state key of each account', () => {
  const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04'];

  it('reads the oldest month first by default and the newest first when asked', async () => {
    const oldest = emptyArchive('order_tester', MONTHS);
    await runChessComSync(syncDeps('order_tester', oldest.fetchImpl));
    expect(oldest.urls.slice(1)).toEqual(MONTHS.map((m) => archiveMonthUrl('order_tester', m)));

    const newest = emptyArchive('order_tester', MONTHS);
    const result = await runChessComSync({
      ...syncDeps('order_tester', newest.fetchImpl, 'sync.chesscom.other-key'),
      monthOrder: 'newest',
    });
    expect(result.status).toBe('done');
    expect(newest.urls.slice(1)).toEqual([...MONTHS].reverse().map((m) => archiveMonthUrl('order_tester', m)));
  });

  it('reports progress in reading order, so a stopped newest-first run has the newest months', async () => {
    const api = emptyArchive('order_tester', MONTHS);
    const abort = new AbortController();
    const done: number[] = [];
    await runChessComSync({
      ...syncDeps('order_tester', api.fetchImpl, 'sync.chesscom.progress'),
      monthOrder: 'newest',
      signal: abort.signal,
      onProgress: (p) => {
        done.push(p.monthsDone);
        if (p.monthsDone === 2) abort.abort();
      },
    });
    const state = await storage.getSetting<{ months: Record<string, unknown> }>('sync.chesscom.progress');
    expect(Object.keys(state!.months).sort()).toEqual(['2026-03', '2026-04']);
    expect(done).toEqual([0, 1, 2]);
  });

  it('keeps a month record for each account under its own key', async () => {
    expect(syncStateKeyFor('First_One', true)).toBe(SYNC_STATE_SETTING);
    expect(syncStateKeyFor(' Second_One ', false)).toBe('sync.chesscom.second_one');

    const a = emptyArchive('first_one', ['2026-01']);
    const b = emptyArchive('second_one', ['2026-02', '2026-03']);
    await runChessComSync(syncDeps('first_one', a.fetchImpl, syncStateKeyFor('first_one', true)));
    await runChessComSync(syncDeps('second_one', b.fetchImpl, syncStateKeyFor('second_one', false)));
    const first = await storage.getSetting<{ player: string; months: object }>(SYNC_STATE_SETTING);
    const second = await storage.getSetting<{ player: string; months: object }>('sync.chesscom.second_one');
    expect(first?.player).toBe('first_one');
    expect(Object.keys(first!.months)).toEqual(['2026-01']);
    expect(second?.player).toBe('second_one');
    expect(Object.keys(second!.months).sort()).toEqual(['2026-02', '2026-03']);
  });
});

describe('the Story import record and messages', () => {
  it('counts a "running" record found at start-up as partial, and cleans what it reads', () => {
    expect(parseSyncImportRecord(undefined)).toMatchObject({ status: 'never', monthsDone: 0, games: 0 });
    const running = parseSyncImportRecord({
      version: 1,
      status: 'running',
      monthsDone: 14,
      monthsTotal: 63,
      games: 1240,
    });
    expect(running).toMatchObject({
      status: 'partial',
      monthsDone: 14,
      monthsTotal: 63,
      games: 1240,
      interrupted: true,
    });
    const partial = parseSyncImportRecord({
      status: 'partial',
      monthsDone: -4,
      monthsTotal: 'x',
      games: 3.7,
      failure: 'f',
    });
    expect(partial).toEqual({ version: 1, status: 'partial', monthsDone: 0, monthsTotal: 0, games: 3, failure: 'f' });
    expect(parseSyncImportRecord({ status: 'done' }).status).toBe('done');
    expect(parseSyncImportRecord({ status: 'weird' }).status).toBe('never');
    expect(STORY_SYNC_IMPORT_SETTING).toBe('story.import.chesscom');
  });

  it('writes the progress line the way the spec words it', () => {
    expect(importProgressLine({ monthsDone: 14, monthsTotal: 63, games: 1240 })).toBe(
      'Chess.com: 14 of 63 months · 1,240 games',
    );
    expect(importProgressLine({ monthsDone: 0, monthsTotal: 1, games: 1 })).toBe('Chess.com: 0 of 1 month · 1 game');
    expect(importProgressLine({ monthsDone: 2, monthsTotal: 5, games: 9, accountIndex: 1, accountCount: 2 })).toBe(
      'Chess.com (account 2 of 2): 2 of 5 months · 9 games',
    );
  });

  it('puts a wrong username on the field, and pauses for the network, a timeout, being offline and the rate limit', () => {
    const kinds: Record<SyncFailure, 'field' | 'pause'> = {
      'no-username': 'field',
      'bad-username': 'field',
      'unknown-player': 'field',
      offline: 'pause',
      network: 'pause',
      timeout: 'pause',
      'rate-limited': 'pause',
      list: 'pause',
    };
    for (const [failure, kind] of Object.entries(kinds) as Array<[SyncFailure, 'field' | 'pause']>) {
      const mapped = importFailureOf(failure, 'HTTP 500');
      expect(mapped.kind).toBe(kind);
      expect(mapped.message.length).toBeGreaterThan(10);
      // Never an address or a name
      expect(mapped.message).not.toMatch(/https?:|api\.chess/i);
    }
    expect(importFailureOf('rate-limited').message).toContain('Wait a few minutes');
    expect(importFailureOf('unknown-player').message).toBe('Chess.com does not know a player with that username.');
    expect(importFailureOf('offline').message).toContain('press Continue');
  });
});

describe('added accounts', () => {
  it('lists the Chess.com accounts to sync: the saved one first, each name once', async () => {
    expect(chesscomAccountsOf(library)).toEqual([]);
    await library.setMyAccounts({ lichess: 'li_one', chesscom: 'cc_one' });
    await library.setMoreAccounts([
      { site: 'chesscom', username: 'cc_two' },
      { site: 'lichess', username: 'li_two' },
      { site: 'chesscom', username: 'CC_ONE' },
    ]);
    expect(chesscomAccountsOf(library)).toEqual(['cc_one', 'cc_two']);
  });

  it('adds an account, and refuses an empty, a malformed and a repeated name with a reason', async () => {
    await library.setMyAccounts({ lichess: '', chesscom: 'cc_one' });
    expect(await addMoreAccount(library, 'chesscom', ' cc_two ')).toEqual({ ok: true });
    expect(library.getMoreAccounts()).toEqual([{ site: 'chesscom', username: 'cc_two' }]);
    for (const [name, text] of [
      ['', 'Type the Chess.com username first.'],
      ['a b', 'does not look right'],
      ['CC_TWO', 'already in your list'],
      ['Cc_One', 'already in your list'],
    ] as const) {
      const result = await addMoreAccount(library, 'chesscom', name);
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.message).toContain(text);
    }
    expect(library.getMoreAccounts()).toHaveLength(1);
    // The same name on the other site is a different account
    expect(await addMoreAccount(library, 'lichess', 'cc_two')).toEqual({ ok: true });
  });

  it('counts an added account’s games, and after Remove keeps them stored but uncounted', async () => {
    await library.setMyAccounts({ lichess: '', chesscom: ME });
    await addMoreAccount(library, 'chesscom', OTHER_ME);
    const mine = run(25, 'a', (i) => ({ variantSalt: `a${i}`, foe: FOES[i % FOES.length]! }));
    const added = run(10, 'b', (i) => ({ variantSalt: `b${i}`, me: OTHER_ME, at: utc(2026, 2, 1 + i) }));
    await library.saveSyncedGames([...mine, ...added]);

    const count = async () => computeStoryStats(await library.list(), library.getUserAccounts()).all.games;
    expect(await count()).toBe(35);

    await removeMoreAccount(library, 'chesscom', OTHER_ME.toUpperCase());
    expect(library.getMoreAccounts()).toEqual([]);
    expect(await count()).toBe(25);
    // Still in the library, only no longer mine
    expect((await library.list()).length).toBe(35);
    expect(await library.get(added[0]!.id)).toBeTruthy();

    // Adding the name back counts them again
    await addMoreAccount(library, 'chesscom', OTHER_ME);
    expect(await count()).toBe(35);
  });

  it('draws the list with a Remove button for each account and the add input, and escapes names', () => {
    const html = moreAccountsHtml(
      'chesscom',
      [
        { site: 'chesscom', username: 'cc_two' },
        { site: 'lichess', username: 'li_two' },
        { site: 'chesscom', username: '<b>x</b>' },
      ],
      { idPrefix: 'test-more', draft: 'typed', error: 'Nope.' },
    );
    expect(html.match(/data-more-action="remove"/g)).toHaveLength(2);
    expect(html).toContain('data-testid="test-more-chesscom-add"');
    expect(html).toContain('value="typed"');
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('li_two');
    expect(html).toContain('Nope.');
  });
});

describe('the preset’s story text', () => {
  const stats = (records: Parameters<typeof computeStoryStats>[0]) =>
    computeStoryStats(records, [{ site: 'chesscom', username: ME }]);
  const many = run(30, 'p', (i) => ({
    variantSalt: `p${i}`,
    foe: FOES[i % FOES.length]!,
    outcome: i % 4 === 0 ? 'loss' : 'win',
    foeElo: 1400 + i * 7,
    opening: i % 2 ? 'Ruy Lopez: Berlin Defense' : 'Sicilian Defense',
  }));

  it('is optional, cleaned and cut like the welcome, and one paragraph', () => {
    expect(parsePreset({ version: 1 }).preset!.story).toBeUndefined();
    expect(parsePreset({ version: 1, story: {} }).preset!.story).toBeUndefined();
    const { preset, problems } = parsePreset({
      version: 1,
      story: { intro: '  Hello\u0007  there\n\nfriend  ', closing: 'x'.repeat(PRESET_LIMITS.storyText + 50), extra: 1 },
    });
    expect(preset!.story).toEqual({ intro: 'Hello there friend', closing: 'x'.repeat(PRESET_LIMITS.storyText) });
    expect(problems).toContain(`story.closing: longer than ${PRESET_LIMITS.storyText} characters (cut)`);
    expect(problems).toContain('story.extra: not a known field (ignored)');
    expect(parsePreset({ version: 1, story: 'text' }).problems).toContain('story: must be an object');
    expect(parsePreset({ version: 1, story: { intro: 4 } }).problems).toContain('story.intro: must be text');
  });

  it('is kept in the profile, and only when there is some', () => {
    expect('story' in sanitizeProfile({})).toBe(false);
    const store = new ProfileStore(null);
    store.set({ story: { intro: 'Hi', closing: '' } });
    expect(store.get().story).toEqual({ intro: 'Hi', closing: '' });
    expect(sanitizeProfile({ story: { intro: '', closing: '' } }).story).toBeUndefined();
  });

  it('changes no number: two profiles give identical stats and number sentences', () => {
    const profileA = sanitizeProfile({
      story: { intro: 'You won 9,999 games and had a 3000 rating!', closing: '12 months' },
    });
    const profileB = sanitizeProfile({ story: { intro: 'Welcome.', closing: '' } });
    const none = sanitizeProfile({});
    const s = stats(many);
    // The stats are computed from games and accounts alone: the text has no way in
    expect(stats(many)).toEqual(s);
    const cardsA = storyCards(s, { intro: profileA.story?.intro, closing: profileA.story?.closing });
    const cardsB = storyCards(s, { intro: profileB.story?.intro, closing: profileB.story?.closing });
    const cardsNone = storyCards(s, { intro: none.story?.intro, closing: none.story?.closing });
    const withoutPersonal = (cards: ReturnType<typeof storyCards>) => cards.map(({ personal: _p, ...rest }) => rest);
    expect(withoutPersonal(cardsA)).toEqual(withoutPersonal(cardsB));
    expect(withoutPersonal(cardsA)).toEqual(withoutPersonal(cardsNone));
    // The text shows only as the paragraph, on the first and last cards
    expect(cardsA.map((c) => c.personal !== null)).toEqual(cardsA.map((c) => c.id === 'intro' || c.id === 'closing'));
    expect(cardsA.find((c) => c.id === 'intro')!.personal).toContain('9,999');
    expect(JSON.stringify(withoutPersonal(cardsA))).not.toContain('9,999');
    expect(cardsNone.every((c) => c.personal === null)).toBe(true);
    // The totals card's number is the games' count
    expect(cardsA.find((c) => c.id === 'totals')!.value).toBe(String(s.all.games));
  });
});
