import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { CHESSCOM_HISTORY_METHOD } from '../../extension/src/backfill';
import { isGameKey } from '../../src/capture/game-id';
import { checkPgnText, importProblemOf } from '../../src/capture/pgn-games';
import { buildGameRecord, myColor } from '../../src/library/game-record';
import { LATEST_SCHEMA_VERSION, WizardChessStorage, deleteWizardChessDB } from '../../src/storage/db';
import type { BackupPayload } from '../../src/storage/db';
import { summarizeBackup } from '../../src/ui/settings-data-section';
import {
  API_ROOT,
  BACKUP_FORMAT,
  HISTORY_METHOD,
  USER_AGENT,
  archiveMonth,
  archiveUrl,
  buildRestorePayload,
  collectGames,
  computeStats,
  downloadArchives,
  formatDownloadSummary,
  formatReport,
  formatRestoreSummary,
  formatShortlist,
  formatSummary,
  isValidUsername,
  openingNameFromUrl,
  outcomeOf,
  shortlistOpponents,
  timeControlLabel,
  type ArchiveGame,
  type MonthArchive,
} from '../../hpc/history/lib/history.mjs';

// Invented players and games: nothing here is anyone's real history.
const PLAYER = 'TestPlayer';

const SCHOLARS_MATE =
  '1. e4 {[%clk 0:09:58.1]} 1... e5 {[%clk 0:09:57]} 2. Qh5 {[%clk 0:09:55]} 2... Nc6 {[%clk 0:09:50]} ' +
  '3. Bc4 {[%clk 0:09:50]} 3... Nf6 {[%clk 0:09:44]} 4. Qxf7# {[%clk 0:09:48]}';
const FOOLS_MATE = '1. f3 {[%clk 0:09:59]} 1... e5 {[%clk 0:09:58]} 2. g4 {[%clk 0:09:57]} 2... Qh4# {[%clk 0:09:55]}';

interface Spec {
  id: number;
  type?: 'live' | 'daily';
  white: string;
  black: string;
  result: '1-0' | '0-1' | '1/2-1/2';
  /** The two players' result codes, as the archive gives them. */
  codes: [string, string];
  date: [number, number, number];
  moves: string | null;
  ratings: [number, number];
  timeControl: string;
  timeClass: string;
  eco?: string;
  ecoUrl?: string;
  rules?: string;
  variant?: string;
  rated?: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');

function archiveGame(s: Spec): ArchiveGame {
  const [y, m, d] = s.date;
  const date = `${y}.${pad(m)}.${pad(d)}`;
  const link = `https://www.chess.com/game/${s.type ?? 'live'}/${s.id}`;
  const tags = [
    ['Event', 'Live Chess'],
    ['Site', 'Chess.com'],
    ['Date', date],
    ['Round', '-'],
    ['White', s.white],
    ['Black', s.black],
    ['Result', s.result],
    ...(s.variant ? [['Variant', s.variant]] : []),
    ...(s.eco ? [['ECO', s.eco]] : []),
    ...(s.ecoUrl ? [['ECOUrl', s.ecoUrl]] : []),
    ['UTCDate', date],
    ['UTCTime', '18:02:11'],
    ['WhiteElo', String(s.ratings[0])],
    ['BlackElo', String(s.ratings[1])],
    ['TimeControl', s.timeControl],
    ['StartTime', '18:02:11'],
    ['EndDate', date],
    ['EndTime', '18:05:40'],
    ['Link', link],
  ];
  const game: ArchiveGame = {
    url: link,
    uuid: `00000000-0000-0000-0000-${String(s.id).padStart(12, '0')}`,
    end_time: Date.UTC(y, m - 1, d, 18, 5, 40) / 1000,
    rated: s.rated ?? true,
    time_class: s.timeClass,
    time_control: s.timeControl,
    rules: s.rules ?? 'chess',
    white: { username: s.white, rating: s.ratings[0], result: s.codes[0] },
    black: { username: s.black, rating: s.ratings[1], result: s.codes[1] },
  };
  if (s.moves !== null) {
    game.pgn = `${tags.map(([k, v]) => `[${k} "${v}"]`).join('\n')}\n\n${s.moves} ${s.result}\n`;
  }
  return game;
}

const WAYWARD = 'https://www.chess.com/openings/Kings-Pawn-Opening-Wayward-Queen-Attack';
const rapid = { timeControl: '600', timeClass: 'rapid' };
const blitz = { timeControl: '180+2', timeClass: 'blitz' };

const G: ArchiveGame[] = [
  // 1: win as White
  archiveGame({
    id: 1001,
    white: PLAYER,
    black: 'alpha_one',
    result: '1-0',
    codes: ['win', 'checkmated'],
    date: [2023, 5, 2],
    moves: SCHOLARS_MATE,
    ratings: [812, 799],
    ...rapid,
    eco: 'C20',
    ecoUrl: WAYWARD,
  }),
  // 2: win as Black
  archiveGame({
    id: 1002,
    white: 'alpha_one',
    black: PLAYER,
    result: '0-1',
    codes: ['checkmated', 'win'],
    date: [2023, 5, 3],
    moves: FOOLS_MATE,
    ratings: [790, 820],
    ...rapid,
    eco: 'A00',
    ecoUrl: 'https://www.chess.com/openings/Barnes-Opening-1...e5-2.g4',
  }),
  // 3: draw as White
  archiveGame({
    id: 1003,
    white: PLAYER,
    black: 'BetaTwo',
    result: '1/2-1/2',
    codes: ['agreed', 'agreed'],
    date: [2023, 11, 20],
    moves: '1. e4 e5 2. Nf3 Nc6',
    ratings: [700, 705],
    ...blitz,
    eco: 'C44',
    ecoUrl: 'https://www.chess.com/openings/Kings-Knight-Opening',
  }),
  // 4: loss as Black
  archiveGame({
    id: 1004,
    white: 'BetaTwo',
    black: PLAYER,
    result: '1-0',
    codes: ['win', 'checkmated'],
    date: [2024, 1, 10],
    moves: SCHOLARS_MATE,
    ratings: [712, 690],
    ...blitz,
    eco: 'C20',
    ecoUrl: WAYWARD,
  }),
  // 5: loss as White (resigned)
  archiveGame({
    id: 1005,
    white: PLAYER,
    black: 'alpha_one',
    result: '0-1',
    codes: ['resigned', 'win'],
    date: [2024, 2, 1],
    moves: '1. e4 e5',
    ratings: [805, 801],
    ...rapid,
    eco: 'C20',
    ecoUrl: 'https://www.chess.com/openings/Kings-Pawn-Opening-1...e5',
  }),
  // 6: a variant the app does not play
  archiveGame({
    id: 1006,
    white: PLAYER,
    black: 'gamma-3',
    result: '1-0',
    codes: ['win', 'kingofthehill'],
    date: [2024, 2, 2],
    moves: '1. e4 e5 2. Ke2 Nc6',
    ratings: [900, 880],
    ...rapid,
    rules: 'kingofthehill',
    variant: 'King of the Hill',
  }),
  // 7: a daily game, won on time
  archiveGame({
    id: 555,
    type: 'daily',
    white: PLAYER,
    black: 'delta4',
    result: '1-0',
    codes: ['win', 'timeout'],
    date: [2024, 3, 1],
    moves: '1. d4 d5 2. c4',
    ratings: [1000, 950],
    timeControl: '1/86400',
    timeClass: 'daily',
    eco: 'D06',
    ecoUrl: 'https://www.chess.com/openings/Queens-Gambit',
  }),
  // 8: unrated, lost on time as Black
  archiveGame({
    id: 1008,
    white: 'alpha_one',
    black: PLAYER,
    result: '1-0',
    codes: ['win', 'timeout'],
    date: [2024, 3, 5],
    moves: '1. e4 e5 2. Nf3',
    ratings: [801, 805],
    ...rapid,
    rated: false,
  }),
  // 9: a game whose entry has no PGN
  archiveGame({
    id: 1009,
    white: PLAYER,
    black: 'Epsilon5',
    result: '1-0',
    codes: ['win', 'abandoned'],
    date: [2024, 4, 1],
    moves: null,
    ratings: [720, 600],
    ...blitz,
  }),
  // 10: a PGN with an illegal move
  archiveGame({
    id: 1010,
    white: 'zeta6',
    black: PLAYER,
    result: '1/2-1/2',
    codes: ['stalemate', 'stalemate'],
    date: [2024, 4, 10],
    moves: '1. e4 e5 2. Ke3',
    ratings: [730, 715],
    ...blitz,
  }),
];

const ARCHIVES: MonthArchive[] = [
  { month: '2024-03', games: [G[6], G[7], G[4], null] }, // G[4] again (a game listed in two months), and a stray entry
  { month: '2023-05', games: [G[0], G[1]] },
  { month: '2023-11', games: [G[2]] },
  { month: '2024-01', games: [G[3]] },
  { month: '2024-02', games: [G[4], G[5]] },
  { month: '2024-04', games: [G[8], G[9]] },
];

const OPPONENTS = ['alpha_one', 'BetaTwo', 'gamma-3', 'delta4', 'Epsilon5', 'zeta6'];
/** Text that would only be there if a game's moves had been copied into a report. */
const MOVE_TEXT = /Qxf7|Qh4#|%clk|\b1\. e4\b/;

describe('History import: archive addresses', () => {
  it('reads a month from this player’s archive address and nothing else', () => {
    expect(archiveMonth(`${API_ROOT}/testplayer/games/2024/03`, PLAYER)).toBe('2024-03');
    expect(archiveMonth(`${API_ROOT}/TestPlayer/games/2021/12`, 'testplayer')).toBe('2021-12');
    expect(archiveMonth(`${API_ROOT}/someoneelse/games/2024/03`, PLAYER)).toBeNull();
    expect(archiveMonth(`${API_ROOT}/testplayer/games/2024/13`, PLAYER)).toBeNull();
    expect(archiveMonth(`${API_ROOT}/testplayer/games/2024/03/extra`, PLAYER)).toBeNull();
    expect(archiveMonth('https://example.com/pub/player/testplayer/games/2024/03', PLAYER)).toBeNull();
    expect(archiveMonth(42, PLAYER)).toBeNull();
    expect(archiveUrl(PLAYER, '2024-03')).toBe('https://api.chess.com/pub/player/testplayer/games/2024/03');
  });

  it('accepts only names that can be a username', () => {
    expect(isValidUsername('Test_Player-1')).toBe(true);
    expect(isValidUsername('ab')).toBe(false);
    expect(isValidUsername('a/../b')).toBe(false);
    expect(isValidUsername('name with space')).toBe(false);
    expect(isValidUsername(undefined)).toBe(false);
  });
});

describe('History import: download', () => {
  const month = (m: string) => archiveUrl(PLAYER, m);
  const listUrl = `${API_ROOT}/testplayer/games/archives`;

  function harness(responses: Record<string, Array<{ status: number; body: string } | Error>>) {
    const calls: Array<{ url: string; agent: string | undefined; redirect: string }> = [];
    const sleeps: number[] = [];
    const saved = new Map<string, string>();
    const run = () =>
      downloadArchives({
        username: PLAYER,
        fetchImpl: async (url, init) => {
          calls.push({ url, agent: init.headers['User-Agent'], redirect: init.redirect });
          const next = responses[url]?.shift();
          if (!next) return { status: 404, text: async () => '' };
          if (next instanceof Error) throw next;
          return { status: next.status, text: async () => next.body };
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        save: (m, text) => {
          saved.set(m, text);
          return text.length;
        },
      });
    return { calls, sleeps, saved, run };
  }

  const body = (games: number) => JSON.stringify({ games: Array.from({ length: games }, () => ({})) });

  it('fetches each month once with a second in between, retries a failed month once, and lists what still fails', async () => {
    const timeout = new Error('The operation timed out: https://api.chess.com/pub/player/testplayer/…');
    timeout.name = 'TimeoutError';
    const h = harness({
      [listUrl]: [
        {
          status: 200,
          body: JSON.stringify({
            archives: [
              month('2024-02'),
              month('2024-01'),
              month('2024-03'),
              month('2024-04'),
              month('2024-01'),
              'https://example.com/elsewhere',
            ],
          }),
        },
      ],
      [month('2024-01')]: [{ status: 200, body: body(3) }],
      [month('2024-02')]: [
        { status: 500, body: 'oops' },
        { status: 200, body: body(2) },
      ],
      [month('2024-03')]: [
        { status: 404, body: '' },
        { status: 429, body: '' },
      ],
      [month('2024-04')]: [timeout, { status: 200, body: 'not json' }],
    });
    const result = await h.run();

    expect(result.ok).toBe(true);
    expect(result.months).toEqual(['2024-01', '2024-02', '2024-03', '2024-04']);
    expect(result.ignored).toBe(2);
    expect(result.saved).toEqual([
      { month: '2024-01', bytes: body(3).length, games: 3 },
      { month: '2024-02', bytes: body(2).length, games: 2 },
    ]);
    expect(result.retried).toEqual(['2024-02', '2024-03', '2024-04']);
    expect(result.failed).toEqual([
      { month: '2024-03', reason: 'HTTP 429' },
      { month: '2024-04', reason: 'not JSON' },
    ]);
    // The list, four months, then the three failed ones again: one request at a time, each month's after a second
    expect(h.calls.map((c) => c.url)).toEqual([
      listUrl,
      month('2024-01'),
      month('2024-02'),
      month('2024-03'),
      month('2024-04'),
      month('2024-02'),
      month('2024-03'),
      month('2024-04'),
    ]);
    expect(h.sleeps).toEqual(Array.from({ length: 7 }, () => 1000));
    expect(h.calls.every((c) => c.agent === USER_AGENT && c.redirect === 'manual')).toBe(true);
    expect(h.calls.every((c) => c.url.startsWith('https://api.chess.com/'))).toBe(true);
    expect([...h.saved.keys()].sort()).toEqual(['2024-01', '2024-02']);

    const summary = formatDownloadSummary(result);
    expect(summary).toContain('Monthly archives listed: 4, 2024-01 to 2024-04');
    expect(summary).toContain('Files saved: 2');
    expect(summary).toContain('Games in the files: 5');
    expect(summary).toContain('Failed months: 2024-03 (HTTP 429), 2024-04 (not JSON)');
    expect(summary.toLowerCase()).not.toContain('testplayer');
  });

  it('stops when the archive list is not served, without asking for anything else', async () => {
    const h = harness({ [listUrl]: [{ status: 403, body: 'Forbidden' }] });
    const result = await h.run();
    expect(result).toMatchObject({ ok: false, reason: 'HTTP 403', months: [], saved: [] });
    expect(h.calls).toHaveLength(1);
    expect(formatDownloadSummary(result)).toContain('could not be fetched: HTTP 403');
  });

  it('a failure never reports the address it asked for', async () => {
    const blocked = new Error(`getaddrinfo ENOTFOUND while fetching ${listUrl}`);
    Object.assign(blocked, { cause: { code: 'ENOTFOUND' } });
    const result = await harness({ [listUrl]: [blocked] }).run();
    expect(result).toMatchObject({ ok: false, reason: 'request failed (ENOTFOUND)' });
  });

  it('names this project to the API and nothing about a person', () => {
    expect(USER_AGENT).toMatch(/^Afterplay\//);
    expect(USER_AGENT).not.toMatch(/@|https?:/);
  });
});

describe('History import: report', () => {
  const { games, duplicates, malformed } = collectGames(ARCHIVES);
  const stats = computeStats(games, PLAYER);

  it('counts every game once', () => {
    expect(games).toHaveLength(10);
    expect(duplicates).toBe(1);
    expect(malformed).toBe(1);
    expect(stats.mine).toBe(10);
    expect(stats.notMine).toBe(0);
    expect(computeStats(games, 'nobody_here').mine).toBe(0);
  });

  it('gives results, colours and years from the player’s side', () => {
    expect(stats.results).toEqual({ games: 10, win: 5, loss: 3, draw: 2, other: 0 });
    expect(stats.colour.white).toEqual({ games: 6, win: 4, loss: 1, draw: 1, other: 0 });
    expect(stats.colour.black).toEqual({ games: 4, win: 1, loss: 2, draw: 1, other: 0 });
    expect(stats.years.map((y) => [y.name, y.games])).toEqual([
      ['2023', 3],
      ['2024', 7],
    ]);
    expect([stats.rated, stats.unrated]).toEqual([9, 1]);
    expect(new Date(stats.firstAt!).toISOString().slice(0, 10)).toBe('2023-05-02');
    expect(new Date(stats.lastAt!).toISOString().slice(0, 10)).toBe('2024-04-10');
  });

  it('maps the archive’s result codes', () => {
    for (const code of ['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'])
      expect(outcomeOf(code)).toBe('draw');
    for (const code of ['checkmated', 'timeout', 'resigned', 'lose', 'abandoned']) expect(outcomeOf(code)).toBe('loss');
    expect(outcomeOf('win')).toBe('win');
    expect(outcomeOf('something-new')).toBe('other');
    expect(outcomeOf(undefined)).toBe('other');
  });

  it('groups time controls and openings', () => {
    expect(stats.timeClasses.map((t) => [t.name, t.games])).toEqual([
      ['rapid', 5],
      ['blitz', 4],
      ['daily', 1],
    ]);
    expect(stats.timeControls.map((t) => [t.name, t.label, t.games])).toEqual([
      ['600', '10+0', 5],
      ['180+2', '3+2', 4],
      ['1/86400', '1 day per move', 1],
    ]);
    expect(timeControlLabel('30')).toBe('30s+0');
    expect(timeControlLabel('90+1')).toBe('1.5+1');
    expect(stats.rules.map((r) => [r.name, r.games])).toEqual([
      ['chess', 9],
      ['kingofthehill', 1],
    ]);

    const c20 = stats.openings.find((o) => o.name === 'C20')!;
    expect(c20).toMatchObject({
      games: 3,
      win: 1,
      loss: 2,
      draw: 0,
      opening: 'Kings Pawn Opening Wayward Queen Attack',
    });
    expect(stats.openings[0]).toMatchObject({ name: 'none', games: 4 });
    expect(openingNameFromUrl('https://www.chess.com/openings/Barnes-Opening-1...e5-2.g4')).toBe('Barnes Opening');
    expect(openingNameFromUrl('https://www.chess.com/openings/Sicilian-Defense-Open-2...d6-3.d4')).toBe(
      'Sicilian Defense Open',
    );
    expect(openingNameFromUrl('')).toBe('');
  });

  it('follows each rating pool over time, rated games only', () => {
    const pool = (name: string) => stats.ratings.find((p) => p.name === name)!;
    expect(pool('blitz')).toMatchObject({
      games: 4,
      first: { rating: 700 },
      last: { rating: 715 },
      peak: { rating: 720 },
      lowest: { rating: 690 },
      years: [
        { year: 2023, rating: 700 },
        { year: 2024, rating: 715 },
      ],
    });
    // The unrated rapid game (rating 805 shown, 2024-03-05) is not part of the pool
    expect(pool('rapid')).toMatchObject({
      games: 3,
      first: { rating: 812 },
      last: { rating: 805 },
      peak: { rating: 820 },
      lowest: { rating: 805 },
    });
    expect(new Date(pool('rapid').last.at!).toISOString().slice(0, 10)).toBe('2024-02-01');
    expect(pool('daily')).toMatchObject({ games: 1, peak: { rating: 1000 } });
    // A variant has its own rating
    expect(pool('kingofthehill rapid')).toMatchObject({ games: 1, peak: { rating: 900 } });
  });

  it('counts games and the record per opponent, and shortlists the most frequent', () => {
    expect(stats.opponents.map((o) => [o.name, o.games, o.win, o.loss, o.draw])).toEqual([
      ['alpha_one', 4, 2, 2, 0],
      ['BetaTwo', 2, 0, 1, 1],
      ['zeta6', 1, 0, 0, 1],
      ['Epsilon5', 1, 1, 0, 0],
      ['delta4', 1, 1, 0, 0],
      ['gamma-3', 1, 1, 0, 0],
    ]);
    // Fewer than five opponents were played twice, so the single games stay on the list
    expect(shortlistOpponents(stats.opponents).map((o) => o.name)).toEqual(stats.opponents.map((o) => o.name));
    expect([...OPPONENTS].sort()).toEqual(stats.opponents.map((o) => o.name).sort());
    expect(shortlistOpponents(stats.opponents, 3).map((o) => o.name)).toEqual(['alpha_one', 'BetaTwo', 'zeta6']);

    const many = Array.from({ length: 14 }, (_, i) => ({
      name: `opp${i}`,
      games: i < 6 ? 9 - i : 1,
      win: 0,
      loss: 0,
      draw: 0,
      other: 0,
      firstAt: null,
      lastAt: null,
    }));
    // Six were played more than once: only those are listed
    expect(shortlistOpponents(many).map((o) => o.name)).toEqual(['opp0', 'opp1', 'opp2', 'opp3', 'opp4', 'opp5']);
    expect(shortlistOpponents(many.map((o) => ({ ...o, games: 3 })))).toHaveLength(10);
  });

  it('writes a summary without names, a report with every opponent, and never a move', () => {
    const summary = formatSummary(stats);
    expect(summary).toContain('Games: 10');
    expect(summary).toContain('5 won, 3 lost, 2 drawn');
    expect(summary).toContain('Opponents: 6 different');
    for (const name of [...OPPONENTS, PLAYER]) expect(summary).not.toContain(name);

    const report = formatReport(stats);
    for (const name of OPPONENTS) expect(report).toContain(name);
    expect(report).toContain('alpha_one: 4 games, 2 won, 2 lost, 0 drawn (2023 to 2024)');
    expect(report).toContain('C20 Kings Pawn Opening Wayward Queen Attack');

    const shortlist = formatShortlist(shortlistOpponents(stats.opponents, 2));
    expect(shortlist).toContain('   1. alpha_one: 4 games, 2 won, 2 lost, 0 drawn (2023 to 2024)');
    expect(shortlist).toContain('   2. BetaTwo: 2 games, 0 won, 1 lost, 1 drawn (2023 to 2024)');

    for (const text of [summary, report, shortlist]) {
      expect(text).not.toMatch(MOVE_TEXT);
      // Plain ASCII, so it reads the same in any terminal
      expect(text).toMatch(/^[\x20-\x7e\n]*$/);
    }
  });
});

describe('History import: restore file', () => {
  const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
  const deps = { checkPgnText, importProblemOf, buildGameRecord, schemaVersion: LATEST_SCHEMA_VERSION };
  const built = buildRestorePayload(collectGames(ARCHIVES).games, PLAYER, deps, NOW);

  it('keeps the games the app’s own import would keep and counts the others by reason', () => {
    expect(built.read).toBe(10);
    expect(built.written).toBe(7);
    expect(built.skipped).toEqual({ noPgn: 1, variant: 1, noMoves: 0, invalid: 1, duplicate: 0 });
    expect(built.withoutSiteId).toBe(0);
    expect(built.notMine).toBe(0);
    expect(built.payload.games.map((g) => g.id)).toEqual([
      'chesscom:live-1001',
      'chesscom:live-1002',
      'chesscom:live-1003',
      'chesscom:live-1004',
      'chesscom:live-1005',
      'chesscom:daily-555',
      'chesscom:live-1008',
    ]);
    // The same game given twice is written once
    const twice = buildRestorePayload(
      [G[0]!, { ...G[0]!, url: 'https://www.chess.com/game/live/1001?copy' }],
      PLAYER,
      deps,
      NOW,
    );
    expect([twice.written, twice.skipped.duplicate]).toEqual([1, 1]);
  });

  it('writes the backup format with games only', () => {
    const { payload } = built;
    expect(BACKUP_FORMAT).toBe('wizards-chess-backup');
    expect(payload.format).toBe('wizards-chess-backup');
    expect(payload.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(payload.exportedAt).toBe(NOW);
    for (const key of ['settings', 'puzzles', 'srsCards', 'repertoires', 'endgameProgress', 'reviews'] as const)
      expect(payload[key]).toEqual([]);
    // The label the extension's own history import gives an archive game
    expect(HISTORY_METHOD).toBe(CHESSCOM_HISTORY_METHOD);

    const summary = formatRestoreSummary(built, 12_345);
    expect(summary).toContain('Games read from the raw files: 10');
    expect(summary).toContain('Games written: 7 (12.1 KB)');
    expect(summary).toContain('Games left out: 3');
    expect(summary).not.toMatch(MOVE_TEXT);
    for (const name of [...OPPONENTS, PLAYER]) expect(summary).not.toContain(name);
  });

  it('a record is what the app stores for the game, with the player’s colour', () => {
    const asBlack = built.payload.games.find((g) => g.id === 'chesscom:live-1002')!;
    expect(asBlack).toMatchObject({
      white: 'alpha_one',
      black: PLAYER,
      playerColor: 'b',
      result: '0-1',
      date: '2023.05.03',
      source: 'chesscom',
      url: 'https://www.chess.com/game/live/1002',
      whiteElo: 790,
      blackElo: 820,
      timeControl: '600',
      playedAt: Date.UTC(2023, 4, 3, 18, 2, 11),
      capturedAt: null,
      captureMethod: 'chesscom-archive-history',
      accuracy: null,
      analysis: null,
      tags: [],
      schemaVersion: LATEST_SCHEMA_VERSION,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(asBlack.pgn).toBe(G[1]!.pgn!.trim());
    expect(built.payload.games.find((g) => g.id === 'chesscom:live-1001')!.playerColor).toBe('w');
    const daily = built.payload.games.find((g) => g.id === 'chesscom:daily-555')!;
    expect(daily).toMatchObject({
      url: 'https://www.chess.com/game/daily/555',
      timeControl: '1/86400',
      openingEco: 'D06',
    });
  });

  it('the app’s backup import takes the file', async () => {
    const text = JSON.stringify(built.payload);
    expect(summarizeBackup(text)).toMatchObject({
      games: 7,
      reviews: 0,
      puzzles: 0,
      cards: 0,
      hasPreferences: false,
      exportedAt: NOW,
    });

    const dbName = 'wizards-chess-history-import-test';
    await deleteWizardChessDB(dbName);
    const storage = await WizardChessStorage.create({ dbName });
    try {
      expect(await storage.importBackupJson(text)).toEqual({
        gamesImported: 7,
        settingsImported: 0,
        puzzlesImported: 0,
        srsCardsImported: 0,
        repertoiresImported: 0,
        endgameProgressImported: 0,
        reviewsImported: 0,
      });
      const stored = await storage.listGames();
      expect(stored).toHaveLength(7);
      expect(stored.every((g) => isGameKey(g.id))).toBe(true);
      // With the username set (the preset does that), the app finds the player's side in every game
      const accounts = [{ site: 'chesscom' as const, username: 'testplayer' }];
      expect(stored.every((g) => myColor(g, accounts) === g.playerColor)).toBe(true);
      // Importing the same file again changes nothing (same ids)
      await storage.importBackupJson(text);
      expect(await storage.listGameIds()).toHaveLength(7);
    } finally {
      storage.close();
      await deleteWizardChessDB(dbName);
    }
  });
});

// The real file, on the machine that built it: WC_RESTORE_FILE=<path to restore.json> npm test -- tests/unit/history-import.test.ts
// (hpc/container/history.sh does this). Every check compares counts, so a failure prints numbers and never a game.
const RESTORE_FILE = process.env.WC_RESTORE_FILE ?? '';

describe('History import: a real restore file', () => {
  it.skipIf(RESTORE_FILE === '')(
    'is taken whole by the app’s backup import',
    async () => {
      const text = fs.readFileSync(RESTORE_FILE, 'utf8');
      const payload = JSON.parse(text) as BackupPayload;
      const total = payload.games.length;
      expect(payload.format).toBe('wizards-chess-backup');
      expect(payload.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      expect(total).toBeGreaterThan(0);
      expect(summarizeBackup(text).games).toBe(total);

      const dbName = 'wizards-chess-history-restore-file-test';
      await deleteWizardChessDB(dbName);
      const storage = await WizardChessStorage.create({ dbName });
      const lines: string[] = ["Restore file validation (the app's own import, in the unit test harness)", ''];
      try {
        const counts = await storage.importBackupJson(text);
        expect(counts.gamesImported).toBe(total);
        expect(counts.settingsImported + counts.puzzlesImported + counts.srsCardsImported).toBe(0);
        expect(counts.repertoiresImported + counts.endgameProgressImported + counts.reviewsImported).toBe(0);
        lines.push(`importBackupJson: ${counts.gamesImported} games imported`);

        const stored = await storage.listGames();
        expect(stored.length).toBe(total);
        lines.push(`games in the store afterwards: ${stored.length} (every id different)`);

        const badKeys = stored.filter((g) => !isGameKey(g.id)).length;
        const badColour = stored.filter((g) => g.playerColor !== 'w' && g.playerColor !== 'b').length;
        const noDate = stored.filter((g) => typeof g.playedAt !== 'number').length;
        expect(badKeys).toBe(0);
        expect(badColour).toBe(0);
        lines.push(`ids that are not a game key: ${badKeys}; games without a time played: ${noDate}`);

        // Each stored PGN read again by the app's parser: one legal game, the same id
        let reread = 0;
        for (const g of stored) {
          const checked = checkPgnText(g.pgn);
          if (checked.games.length === 1 && checked.games[0]!.key === g.id) reread++;
        }
        expect(reread).toBe(total);
        lines.push(`stored PGNs the app's parser reads again as one legal game with the same id: ${reread}`);

        const exported = JSON.parse(await storage.exportBackupJson()) as BackupPayload;
        expect(exported.games.length).toBe(total);
        expect(exported.format).toBe('wizards-chess-backup');
        lines.push(`a backup exported from that store holds ${exported.games.length} games`, '', 'Result: passed');
      } finally {
        storage.close();
        await deleteWizardChessDB(dbName);
      }
      fs.writeFileSync(path.join(path.dirname(RESTORE_FILE), 'restore-validation.txt'), lines.join('\n') + '\n');
    },
    12 * 60_000,
  );
});
