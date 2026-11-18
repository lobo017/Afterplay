import { describe, expect, it } from 'vitest';
import {
  DAILY_BATCH,
  FIRST_BATCH,
  gameTime,
  historyExplanation,
  historyGameLabel,
  historyPuzzleRecord,
  localDay,
  orderNewestFirst,
  parseHistoryPuzzleFile,
  parseHistoryPuzzleFileAsync,
  readHistoryPuzzlePending,
  readHistoryPuzzleState,
  releaseAllowance,
  type HistoryPuzzleEntry,
  type HistoryPuzzleState,
} from '../../src/trainers/history-puzzles';
import { preparePuzzle } from '../../src/trainers/puzzle-format';

// Every game id, name and position here is invented. Three small positions, each with a legal setup move and a legal best
// move: White mates with Qxf7# (ply must be odd), Black mates with Qh4# (even), Black answers 1.e4 with 1...e5 (even).
const MATE_WHITE = {
  fen: 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3',
  moves: ['g8f6', 'h5f7'],
  bestLineSan: ['Qxf7#'],
  playedSan: 'Nxe4',
  class: 'Blunder' as const,
  mateIn: 1,
  loss: 61.4,
  ply: 21,
};
const MATE_BLACK = {
  fen: 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2',
  moves: ['g2g4', 'd8h4'],
  bestLineSan: ['Qh4#'],
  playedSan: 'Nc6',
  class: 'Blunder' as const,
  mateIn: 1,
  loss: 55,
  ply: 22,
};
const PLAIN_BLACK = {
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  moves: ['e2e4', 'e7e5'],
  bestLineSan: ['e5'],
  playedSan: 'a6',
  class: 'Mistake' as const,
  mateIn: null,
  loss: 12.34,
  ply: 24,
};

const entry = (over: Record<string, unknown> = {}, base: Record<string, unknown> = MATE_WHITE) => ({
  id: 'chesscom:100',
  before: 70,
  after: 8.6,
  ...base,
  ...over,
});
const fileOf = (entries: unknown[], over: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: 'afterplay-mistake-puzzles',
    version: 1,
    input: '0123456789ab',
    count: entries.length,
    entries,
    ...over,
  });
const refused = (text: string) => {
  const r = parseHistoryPuzzleFile(text);
  if (r.ok) throw new Error('expected the file to be refused');
  return r.reason;
};

describe('the puzzle file check', () => {
  it('accepts a good file and keeps only the fields the app uses (no names, no extras)', () => {
    const text = fileOf([
      { ...entry(), white: 'Ann', black: 'Ben', pgn: '1. e4', opponent: 'Ben' },
      entry({ id: 'chesscom:101' }, MATE_BLACK),
      entry({ id: 'chesscom:102' }, PLAIN_BLACK),
    ]);
    const r = parseHistoryPuzzleFile(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toBe('0123456789ab');
    expect(r.entries).toHaveLength(3);
    expect(Object.keys(r.entries[0]!).sort()).toEqual(
      ['bestLineSan', 'class', 'fen', 'id', 'loss', 'mateIn', 'moves', 'ply', 'playedSan'].sort(),
    );
    expect(JSON.stringify(r.entries)).not.toMatch(/Ann|Ben|pgn/);
  });

  it('refuses a page of HTML where the file should be, and anything that is not JSON', () => {
    expect(refused('<!doctype html><html><body>Afterplay</body></html>')).toBe('a page, not a file');
    expect(refused('  \n<html>')).toBe('a page, not a file');
    expect(refused('{"format":')).toBe('not JSON');
    expect(refused('')).toBe('empty');
    expect(refused('[]')).toBe('not an object');
    expect(refused('null')).toBe('not an object');
  });

  it('refuses another format, another version, a missing or malformed marker and a wrong count', () => {
    const good = [entry()];
    expect(refused(fileOf(good, { format: 'wizards-chess-backup' }))).toBe('another format');
    expect(refused(fileOf(good, { version: 2 }))).toBe('another version');
    expect(refused(fileOf(good, { input: undefined }))).toBe('no input marker');
    expect(refused(fileOf(good, { input: '30FA19BC757F' }))).toBe('no input marker');
    expect(refused(fileOf(good, { input: '30fa19bc' }))).toBe('no input marker');
    expect(refused(fileOf(good, { count: 2 }))).toBe('the count is wrong');
    expect(refused(fileOf(good, { count: undefined }))).toBe('the count is wrong');
    expect(refused(fileOf([]))).toBe('no puzzles, or too many');
    expect(refused(fileOf(good, { entries: 'x' }))).toBe('no puzzles, or too many');
  });

  it('refuses the whole file when one entry has an illegal setup move, an illegal best move or an illegal position', () => {
    // Black has no knight on a8, so the setup move is illegal
    expect(refused(fileOf([entry(), entry({ id: 'chesscom:2', moves: ['a8a6', 'h5f7'] })]))).toBe(
      'entry 1: illegal position or move',
    );
    // The best move is illegal after the setup move (the queen cannot reach h8)
    expect(refused(fileOf([entry({ moves: ['g8f6', 'h5h8'] })]))).toBe('entry 0: illegal position or move');
    // Not a position at all, and a position with two white kings
    expect(refused(fileOf([entry({ fen: 'not a fen' })]))).toBe('entry 0: illegal position or move');
    expect(refused(fileOf([entry({ fen: 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNBKK1NR b KQkq - 3 3' })]))).toBe(
      'entry 0: illegal position or move',
    );
  });

  it('refuses entries whose fields are malformed or do not agree with each other', () => {
    expect(refused(fileOf([entry({ moves: ['g8f6'] })]))).toBe('entry 0: bad moves');
    expect(refused(fileOf([entry({ moves: ['g8f6', 'Qxf7'] })]))).toBe('entry 0: bad moves');
    expect(refused(fileOf([entry({ id: '' })]))).toBe('entry 0: bad game id');
    expect(refused(fileOf([entry({ ply: 1 })]))).toBe('entry 0: bad ply');
    expect(refused(fileOf([entry({ ply: 3.5 })]))).toBe('entry 0: bad ply');
    expect(refused(fileOf([entry({ class: 'Miss' })]))).toBe('entry 0: bad class');
    expect(refused(fileOf([entry({ loss: -1 })]))).toBe('entry 0: bad loss');
    expect(refused(fileOf([entry({ loss: 101 })]))).toBe('entry 0: bad loss');
    expect(refused(fileOf([entry({ mateIn: 6 })]))).toBe('entry 0: bad mate length');
    expect(refused(fileOf([entry({ mateIn: 0 })]))).toBe('entry 0: bad mate length');
    expect(refused(fileOf([entry({ bestLineSan: [] })]))).toBe('entry 0: bad best line');
    expect(refused(fileOf([entry({ bestLineSan: ['Qxf7# and then some'] })]))).toBe('entry 0: bad best line');
    expect(refused(fileOf([entry({ playedSan: '' })]))).toBe('entry 0: bad played move');
    // The ply says Black moves, the position says White does
    expect(refused(fileOf([entry({ ply: 22 })]))).toBe('entry 0: the side to move does not match the ply');
    // The best line starts with another move than the best move
    expect(refused(fileOf([entry({ bestLineSan: ['Qh7'] })]))).toBe(
      'entry 0: the best line does not start with the best move',
    );
    expect(refused(fileOf([entry(), entry()]))).toBe('entry 1: listed twice');
    expect(refused(fileOf([42]))).toBe('entry 0: not an object');
  });

  it('allows a game to appear twice at different plies, and refuses a file that is too large', () => {
    expect(parseHistoryPuzzleFile(fileOf([entry(), entry({ ply: 23 })])).ok).toBe(true);
    expect(refused(' '.repeat(9 * 1024 * 1024))).toBe('too large');
  });
});

describe('the check that lets the page breathe', () => {
  it('gives the same answer as the one-go check, and pauses every 20 entries', async () => {
    const many = Array.from({ length: 90 }, (_, i) => entry({ id: `chesscom:${i}` }));
    let pauses = 0;
    const pause = async () => {
      pauses++;
    };
    expect(await parseHistoryPuzzleFileAsync(fileOf(many), pause)).toEqual(parseHistoryPuzzleFile(fileOf(many)));
    expect(pauses).toBe(4);
    const broken = fileOf([...many.slice(0, 45), entry({ id: 'chesscom:x', moves: ['a8a6', 'h5f7'] })]);
    pauses = 0;
    const r = await parseHistoryPuzzleFileAsync(broken, pause);
    expect(r).toEqual({ ok: false, reason: 'entry 45: illegal position or move' });
    expect(pauses).toBe(2);
    expect(await parseHistoryPuzzleFileAsync('<html>')).toEqual({ ok: false, reason: 'a page, not a file' });
  });
});

describe('a released puzzle', () => {
  const parsed = (e: unknown) => {
    const r = parseHistoryPuzzleFile(fileOf([e]));
    if (!r.ok) throw new Error(r.reason);
    return r.entries[0]!;
  };

  it('is a normal personal puzzle: id, themes, rating, moves, explanation, game link and a label without a name', () => {
    const mate = parsed(entry());
    const r = historyPuzzleRecord(mate, { id: 'chesscom:100', date: '2026.10.04' });
    expect(r).toEqual({
      id: 'personal:chesscom:100:21',
      source: 'personal',
      fen: MATE_WHITE.fen,
      moves: ['g8f6', 'h5f7'],
      rating: 0,
      themes: ['blunder', 'mate'],
      sourceGameId: 'chesscom:100',
      ply: 21,
      playedSan: 'Nxe4',
      classification: 'Blunder',
      explanation: 'Instead of Nxe4, there was a forced mate in 1.',
      bestLineSan: ['Qxf7#'],
      gameLabel: 'as White · 2026-10-04',
      origin: 'history',
    });
    // The bundled puzzles' loader accepts it, and the player is the color the label names
    expect(preparePuzzle(r).playerColor).toBe('w');

    const plain = historyPuzzleRecord(parsed(entry({}, PLAIN_BLACK)), { id: 'chesscom:100', date: '2026.01.31' });
    expect(plain.themes).toEqual(['mistake']);
    expect(plain.classification).toBe('Mistake');
    expect(plain.explanation).toBe('a6 gave up about 12% of your winning chances.');
    expect(plain.gameLabel).toBe('as Black · 2026-01-31');
    expect(preparePuzzle(plain).playerColor).toBe('b');
  });

  it('names the color and the date only, and copes with a missing date', () => {
    expect(historyGameLabel(21, '2026.10.04')).toBe('as White · 2026-10-04');
    expect(historyGameLabel(22, '2026.10.04')).toBe('as Black · 2026-10-04');
    expect(historyGameLabel(22, '')).toBe('as Black');
    expect(historyGameLabel(21, undefined)).toBe('as White');
    expect(historyExplanation(parsed(entry({ mateIn: 3 })))).toBe('Instead of Nxe4, there was a forced mate in 3.');
  });
});

describe('the order of release', () => {
  const e = (id: string, ply = 21): HistoryPuzzleEntry => ({ ...(parsedBase as HistoryPuzzleEntry), id, ply });
  const parsedBase = (() => {
    const r = parseHistoryPuzzleFile(fileOf([entry()]));
    if (!r.ok) throw new Error('fixture');
    return r.entries[0]!;
  })();

  it('reads when a game was played from its time, else from its date, else not at all', () => {
    expect(gameTime({ playedAt: 1_700_000_000_000, date: '2020.01.01' })).toBe(1_700_000_000_000);
    expect(gameTime({ playedAt: null, date: '2026.10.04' })).toBe(Date.UTC(2026, 9, 4));
    expect(gameTime({ date: '2026.10.??' })).toBe(Date.UTC(2026, 9, 1));
    expect(gameTime({ date: '????.??.??' })).toBeNull();
    expect(gameTime({ date: '' })).toBeNull();
  });

  it('puts the newest source game first, games the library does not know last, and ties by id then ply', () => {
    const times = new Map<string, number | null>([
      ['a', 100],
      ['b', 300],
      ['c', 200],
      ['d', 300],
      ['e', null],
    ]);
    const out = orderNewestFirst([e('a'), e('e'), e('c'), e('d', 23), e('d', 21), e('b'), e('zz')], times);
    expect(out.map((x) => `${x.id}${x.ply}`)).toEqual(['b21', 'd21', 'd23', 'c21', 'a21', 'e21', 'zz21']);
  });
});

describe('the release schedule', () => {
  const state = (over: Partial<HistoryPuzzleState> = {}): HistoryPuzzleState => ({
    version: 1,
    slug: 'ada-sample',
    input: '0123456789ab',
    loadedDay: '2026-11-17',
    total: 600,
    released: 0,
    lastDay: '2026-11-17',
    lastDayCount: 0,
    ...over,
  });

  it('releases 50 on the day the file was loaded and no more that day, however often the app opens', () => {
    expect(FIRST_BATCH).toBe(50);
    expect(DAILY_BATCH).toBe(20);
    expect(releaseAllowance(state(), '2026-11-17', 600)).toBe(50);
    expect(releaseAllowance(state({ released: 50, lastDayCount: 50 }), '2026-11-17', 550)).toBe(0);
    expect(releaseAllowance(state({ released: 30, lastDayCount: 30 }), '2026-11-17', 570)).toBe(20);
  });

  it('adds 20 on each later day', () => {
    const after = state({ released: 50, lastDayCount: 50 });
    expect(releaseAllowance(after, '2026-11-18', 550)).toBe(20);
    expect(
      releaseAllowance({ ...after, released: 70, lastDay: '2026-11-18', lastDayCount: 20 }, '2026-11-18', 530),
    ).toBe(0);
    expect(
      releaseAllowance({ ...after, released: 70, lastDay: '2026-11-18', lastDayCount: 20 }, '2026-11-19', 530),
    ).toBe(20);
  });

  it('catches up after days away, but never more than 20 on one day', () => {
    let s = state({ released: 50, lastDayCount: 50 });
    // Five days later 100 are owed; today holds 20
    expect(releaseAllowance(s, '2026-11-22', 550)).toBe(20);
    s = { ...s, released: 70, lastDay: '2026-11-22', lastDayCount: 20 };
    expect(releaseAllowance(s, '2026-11-22', 530)).toBe(0);
    // The next day the rest of what is owed follows, 20 at a time
    expect(releaseAllowance(s, '2026-11-23', 530)).toBe(20);
    // A month later everything owed is 50 + 20 * 30, still 20 a day
    expect(releaseAllowance(s, '2026-12-17', 530)).toBe(20);
  });

  it('never releases more than is pending or more than is owed, and a clock set back releases nothing extra', () => {
    expect(releaseAllowance(state(), '2026-11-17', 7)).toBe(7);
    expect(releaseAllowance(state(), '2026-11-17', 0)).toBe(0);
    expect(releaseAllowance(state({ released: 50, lastDayCount: 50 }), '2026-11-16', 500)).toBe(0);
    expect(releaseAllowance(state({ released: 70, lastDay: '2026-11-18', lastDayCount: 20 }), '2026-11-18', 500)).toBe(
      0,
    );
  });

  it('counts local calendar days across a month and a year, whatever the time of day', () => {
    const s = state({ loadedDay: '2026-12-31', released: 50, lastDay: '2026-12-31', lastDayCount: 50 });
    expect(releaseAllowance(s, '2027-01-01', 100)).toBe(20);
    expect(localDay(new Date(2026, 10, 17, 0, 0, 1).getTime())).toBe('2026-11-17');
    expect(localDay(new Date(2026, 10, 17, 23, 59, 59).getTime())).toBe('2026-11-17');
    expect(localDay(new Date(2026, 0, 5, 12).getTime())).toBe('2026-01-05');
  });
});

describe('stored values', () => {
  it('reads back only a state and a pending blob of this version', () => {
    const state = {
      version: 1,
      slug: 'ada-sample',
      input: '0123456789ab',
      loadedDay: '2026-11-17',
      total: 3,
      released: 1,
      lastDay: '2026-11-17',
      lastDayCount: 1,
    };
    expect(readHistoryPuzzleState(state)).toEqual(state);
    expect(readHistoryPuzzleState({ ...state, version: 2 })).toBeUndefined();
    expect(readHistoryPuzzleState({ ...state, loadedDay: 'yesterday' })).toBeUndefined();
    expect(readHistoryPuzzleState({ ...state, released: -1 })).toBeUndefined();
    expect(readHistoryPuzzleState(null)).toBeUndefined();
    expect(readHistoryPuzzlePending({ version: 1, input: 'x', entries: [] })).toEqual({
      version: 1,
      input: 'x',
      entries: [],
    });
    expect(readHistoryPuzzlePending({ version: 1, input: 'x', entries: [{ id: 1 }] })).toBeUndefined();
    expect(readHistoryPuzzlePending({ version: 2, input: 'x', entries: [] })).toBeUndefined();
    expect(readHistoryPuzzlePending('x')).toBeUndefined();
  });
});
