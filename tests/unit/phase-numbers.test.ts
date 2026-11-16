import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { GameLibrary } from '../../src/library/library';
import { readReviewNumbers } from '../../src/library/review-numbers';
import { loadHistoryFile, type HistoryGame } from '../../src/preset/first-run';
import { gameAccuracy, moveAccuracy } from '../../src/review/formulas';
import { phaseNumbers, totalPhases, type PhaseNumbers } from '../../src/review/phase-numbers';
import { buildGameReview, mainLinePlies } from '../../src/review/review-game';
import { storeHistory } from '../../src/story/history-loader';
import { WizardChessStorage, deleteWizardChessDB, type StoredGameRecord } from '../../src/storage/db';
import { phaseOf } from '../../src/library/insights';
import { lichessPositions, lichessTree } from '../helpers/lichess-fixture';
import { isBookFen } from '../helpers/review-fixtures';
import { game } from './helpers/story-games';
import { reviewed } from './helpers/story-reviews';

// Invented positions and games. Only the Lichess fixture game is real.
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** Six pieces besides kings and pawns: an endgame at once. */
const SIX = '4k3/8/8/8/8/8/8/RRBBNN1K w - - 0 1';
/** Seven: not yet. */
const SEVEN = 'r3k3/8/8/8/8/8/8/RRBBNN1K w - - 0 1';

const flat = (n: number, fen: string) => Array.from({ length: n }, () => fen);
const round2 = (n: number) => Math.round(n * 100) / 100;

describe('phase boundaries', () => {
  // 24 plies; every move is perfect except the ones named. White moves on odd plies, Black on even ones.
  const winWith = (drops: Record<number, number>): number[] => {
    const win = [50];
    for (let ply = 1; ply <= 24; ply++) {
      const drop = drops[ply] ?? 0;
      win.push(win[ply - 1]! + (ply % 2 === 1 ? -drop : drop));
    }
    return win;
  };
  const classesWith = (letters: Record<number, string>): string =>
    Array.from({ length: 24 }, (_, i) => letters[i + 1] ?? 'B').join('');

  it('the opening is the first 20 plies: ply 19 (White) and ply 20 (Black) are in it, 21 and 22 are not', () => {
    const win = winWith({ 19: 20, 21: 10, 20: 30, 22: 5 });
    const classes = classesWith({ 19: 'X', 21: 'M', 20: 'S', 22: 'M' });
    const fens = flat(24, START);

    const white = phaseNumbers({ win, classes, fensBefore: fens, color: 'w' })!;
    expect(white[0]).toEqual([10, round2((9 * 100 + moveAccuracy(20)) / 10), 1, 0, 0]); // plies 1, 3 … 19
    expect(white[1]).toEqual([2, round2((moveAccuracy(10) + 100) / 2), 0, 1, 0]); // plies 21, 23
    expect(white[2]).toEqual([0, 0, 0, 0, 0]);

    const black = phaseNumbers({ win, classes, fensBefore: fens, color: 'b' })!;
    expect(black[0]).toEqual([10, round2((9 * 100 + moveAccuracy(30)) / 10), 0, 0, 1]); // plies 2, 4 … 20
    expect(black[1]).toEqual([2, round2((moveAccuracy(5) + 100) / 2), 0, 1, 0]); // plies 22, 24
    expect(black[2]).toEqual([0, 0, 0, 0, 0]);
  });

  it('six pieces is an endgame at any ply, seven is not', () => {
    const classes = classesWith({ 5: 'X', 7: 'X' });
    const win = winWith({ 5: 40, 7: 40 });
    const fens = flat(24, START);
    fens[4] = SIX; // before ply 5
    fens[6] = SEVEN; // before ply 7
    expect(phaseOf(SIX, 5)).toBe('endgame');
    expect(phaseOf(SEVEN, 7)).toBe('opening');
    const w = phaseNumbers({ win, classes, fensBefore: fens, color: 'w' })!;
    expect(w[2]).toEqual([1, round2(moveAccuracy(40)), 1, 0, 0]); // ply 5
    expect(w[0][0]).toBe(9); // the other nine opening moves, ply 7 included
    expect(w[0][2]).toBe(1); // ply 7's blunder
  });

  it('a game that never reaches an endgame has an empty endgame tuple and counts every move once', () => {
    const w = phaseNumbers({ win: winWith({}), classes: classesWith({}), fensBefore: flat(24, START), color: 'w' })!;
    expect(w[2]).toEqual([0, 0, 0, 0, 0]);
    expect(w.reduce((n, t) => n + t[0], 0)).toBe(12);
    expect(w[0][1]).toBe(100);
  });

  it('counts only Blunder, Mistake and Miss, and refuses lists that do not fit', () => {
    const w = phaseNumbers({
      win: winWith({}),
      classes: classesWith({ 1: 'I', 3: '!', 5: 'G', 7: 'K', 9: 'E', 11: 'O', 13: 'X', 15: 'M', 17: 'S' }),
      fensBefore: flat(24, START),
      color: 'w',
    })!;
    expect([w[0][2], w[0][3], w[0][4]]).toEqual([1, 1, 1]);
    const ok = { win: winWith({}), classes: classesWith({}), fensBefore: flat(24, START), color: 'w' as const };
    expect(phaseNumbers({ ...ok, win: ok.win.slice(1) })).toBeNull();
    expect(phaseNumbers({ ...ok, fensBefore: flat(23, START) })).toBeNull();
    expect(phaseNumbers({ ...ok, classes: '' })).toBeNull();
  });

  it('adds up games weighted by their moves, skipping games without numbers', () => {
    const a: PhaseNumbers = [
      [10, 90, 1, 0, 0],
      [20, 80, 0, 2, 1],
      [0, 0, 0, 0, 0],
    ];
    const b: PhaseNumbers = [
      [30, 100, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [10, 70, 1, 1, 1],
    ];
    const [opening, middle, end] = totalPhases([a, null, b, undefined]);
    expect(opening).toMatchObject({ moves: 40, accuracy: 97.5, blunders: 1, games: 2 });
    expect(middle).toMatchObject({ moves: 20, accuracy: 80, mistakes: 2, misses: 1, games: 1 });
    expect(end).toMatchObject({ moves: 10, accuracy: 70, games: 1 });
    expect(totalPhases([])[0]!.accuracy).toBeNull();
  });
});

describe('a game that ends in mate (the 105 games whose stored accuracy differed)', () => {
  // The batch stores the mating move's win% as 100 / 0 (the position is checkmate), but the review's own game accuracy
  // counted a forced mate as ±1000 cp: 97.5 / 2.5. Through the weight of the last moves that moves the game accuracy of
  // the mating side (all 105 games are ones the player ended with mate), never the accuracy of a move: the mating move is
  // 100% on either value.
  const CASES = [
    // White mates on ply 13; the positions before the mating move
    {
      name: 'White mates',
      before: [50, 52, 40, 45, 38, 44, 33, 41, 50, 40, 80, 70, 97.5],
      stored: 100,
      counted: 97.5,
      who: 'w',
    },
    // Black mates on ply 12
    {
      name: 'Black mates',
      before: [50, 48, 56, 52, 62, 55, 66, 58, 70, 44, 55, 3.2],
      stored: 0,
      counted: 2.5,
      who: 'b',
    },
  ] as const;

  it.each(CASES)('$name: the game accuracy differs by the end value, the phase numbers do not', (c) => {
    const winStored = [...c.before, c.stored];
    const winCounted = [...c.before, c.counted];
    const plies = winStored.length - 1;
    const mating = c.who === 'w' ? 'white' : 'black';
    const other = c.who === 'w' ? 'black' : 'white';
    const diff = Math.abs(gameAccuracy(winStored)[mating]! - gameAccuracy(winCounted)[mating]!);
    expect(diff).toBeGreaterThan(0.2);
    expect(gameAccuracy(winStored)[other]).toBe(gameAccuracy(winCounted)[other]);

    const classes = 'B'.repeat(plies);
    const fens = flat(plies, START);
    for (const color of ['w', 'b'] as const) {
      const x = phaseNumbers({ win: winStored, classes, fensBefore: fens, color })!;
      const y = phaseNumbers({ win: winCounted, classes, fensBefore: fens, color })!;
      expect(x).toEqual(y);
    }
    const last = c.before[plies - 1]!;
    for (const end of [c.stored, c.counted]) {
      expect(moveAccuracy(c.who === 'w' ? last - end : end - last)).toBe(100);
    }
  });
});

describe('the Lichess reference game: win% and class letters give what a full review gives', () => {
  const LETTER: Record<string, string> = {
    Brilliant: '!',
    Great: 'G',
    Best: 'B',
    Excellent: 'E',
    Good: 'O',
    Book: 'K',
    Inaccuracy: 'I',
    Mistake: 'M',
    Blunder: 'X',
    Miss: 'S',
  };

  it.each(['w', 'b'] as const)('for the %s side', (color) => {
    const tree = lichessTree();
    const review = buildGameReview({
      preset: null,
      budget: { depth: 20 },
      startFen: tree.root.fen,
      plies: mainLinePlies(tree),
      positions: lichessPositions(tree),
      isBookPosition: isBookFen,
    });
    expect(review.complete).toBe(true);

    // What the batch stores (hpc/history/review-games.mjs), rounded to 2 decimals
    const win = [review.whiteWinSeries[0]!, ...review.moves.map((m) => m.whiteWinAfter)].map(round2);
    const classes = review.moves.map((m) => LETTER[m.classification]).join('');
    const fensBefore = review.moves.map((m) => m.fenBefore);
    const got = phaseNumbers({ win, classes, fensBefore, color })!;

    // What the review itself holds, move by move
    const phases = ['opening', 'middlegame', 'endgame'] as const;
    let seen = 0;
    phases.forEach((phase, p) => {
      const mine = review.moves.filter((m) => m.color === color && phaseOf(m.fenBefore, m.ply) === phase);
      const mean = mine.length === 0 ? 0 : mine.reduce((s, m) => s + m.accuracy, 0) / mine.length;
      const count = (c: string) => mine.filter((m) => m.classification === c).length;
      seen += mine.length;
      expect(got[p]![0], phase).toBe(mine.length);
      expect(Math.abs(got[p]![1] - mean), phase).toBeLessThanOrEqual(0.011);
      expect([got[p]![2], got[p]![3], got[p]![4]], phase).toEqual([count('Blunder'), count('Mistake'), count('Miss')]);
    });
    expect(seen).toBe(23);
    expect(got[0][0]).toBeGreaterThan(0);
    expect(got[0][0] + got[1][0]).toBeGreaterThan(0);
  });
});

describe('a history file with phases', () => {
  const DB = 'wizards-chess-phase-numbers-test';
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

  const PHASES: PhaseNumbers = [
    [10, 93.31, 0, 1, 0],
    [14, 85.5, 1, 0, 1],
    [3, 100, 0, 0, 0],
  ];

  /** Two invented reviewed games, one with phases (as the script writes them) and one without (an excluded game). */
  function twoGames(): StoredGameRecord[] {
    const a = reviewed(game({ id: 'phased-a', color: 'w', plies: 30 }), { moves: 27 });
    const b = reviewed(game({ id: 'plain-b', color: 'w', plies: 30, variantSalt: 'x' }), { moves: 27 });
    const sides = a.analysis!.sides!;
    sides.w = { ...sides.w!, phases: PHASES };
    return [a, b];
  }
  const fileOf = (games: StoredGameRecord[]) =>
    JSON.stringify({ format: 'wizards-chess-backup', schemaVersion: 4, exportedAt: 0, games, settings: [] });

  const okResponse = (body: string): Response =>
    ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: async () => body,
    }) as unknown as Response;

  it('loads with the history loader, stores through the Story import and keeps the numbers', async () => {
    const text = fileOf(twoGames());
    const loaded = await loadHistoryFile({ slug: 'sample', fetchFile: async () => okResponse(text) });
    expect(loaded.kind).toBe('loaded');
    if (loaded.kind !== 'loaded') return;
    expect(loaded.games).toHaveLength(2);
    expect(loaded.ignored).toBe(0);

    const result = await storeHistory({
      slug: 'sample',
      games: loaded.games as HistoryGame[],
      monthRecord: null,
      store: library,
    });
    expect(result.added).toBe(2);
    const a = await storage.getGame('chesscom:phased-a');
    const b = await storage.getGame('chesscom:plain-b');
    expect(a?.analysis?.sides?.w?.phases).toEqual(PHASES);
    expect(b?.analysis?.sides?.w?.phases).toBeUndefined();
    // The reader the Story and Insights use: the same numbers as before, now with the phases (the old assertion was
    // "equal to the same record without phases"; the new one says what is added)
    const without = readReviewNumbers(
      { analysis: { ...a!.analysis!, sides: { w: { ...a!.analysis!.sides!.w!, phases: undefined } } } },
      'w',
    );
    expect(without?.phases).toBeUndefined();
    expect(readReviewNumbers(a!, 'w')).toEqual({ ...without, phases: PHASES });
    expect(readReviewNumbers(a!, 'w')?.source).toBe('advance');
  });

  it('is accepted by the backup import', async () => {
    const counts = await storage.importBackupJson(fileOf(twoGames()));
    expect(counts.gamesImported).toBe(2);
    expect((await storage.getGame('chesscom:phased-a'))?.analysis?.sides?.w?.phases).toEqual(PHASES);
    expect((await storage.getGame('chesscom:plain-b'))?.analysis?.sides?.w?.phases).toBeUndefined();
  });
});
