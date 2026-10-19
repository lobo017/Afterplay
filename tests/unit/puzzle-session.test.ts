import { describe, expect, it } from 'vitest';
import puzzlesJson from '../../data/puzzles.json';
import type { PuzzleEntry } from '../../src/core/datasets';
import { PuzzleDataset } from '../../src/trainers/puzzle-dataset';
import { preparePuzzle } from '../../src/trainers/puzzle-format';
import { PuzzleSession, gradeAttempt } from '../../src/trainers/puzzle-session';
import {
  DECISIVE_WIN_PERCENT,
  PERSONAL_MIN_GAP,
  isClearBest,
  judgeAlternative,
} from '../../src/trainers/puzzle-validation';

const puzzles = puzzlesJson as PuzzleEntry[];

// Black king h8 behind g7/h7; Black plays Kg8-h8 (the setup move), then both Ra8# and Rb8# mate.
const TWO_MATES = { id: 'two-mates', fen: '6k1/5ppp/8/8/8/8/5PPP/RR4K1 b - - 0 1', moves: ['g8h8', 'a1a8'] };

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('Phase 6 — solving a puzzle', () => {
  it('accepts another move that mates at once', () => {
    const s = new PuzzleSession(preparePuzzle(TWO_MATES));
    expect(s.play('b1b8')).toEqual({ kind: 'solved-alternative', uci: 'b1b8' });
    expect(s.status).toBe('solved');
    expect(s.outcome?.solved).toBe(true);
  });

  it('hands any other move to the engine check, and a rejected one fails the attempt (graded Again)', () => {
    const c = clock();
    const s = new PuzzleSession(preparePuzzle(TWO_MATES), c.now);
    const r = s.play('h2h3');
    expect(r).toMatchObject({ kind: 'check', uci: 'h2h3', expected: 'a1a8' });
    expect(s.status).toBe('checking');
    expect(s.play('a1a8').kind).toBe('not-playing');
    s.resolveAlternative(false);
    expect(s.status).toBe('playing');
    expect(s.outcome).toMatchObject({ solved: false, mistakes: 1, grade: 1 });
    // Still solvable afterwards, but the attempt stays a failure
    expect(s.play('a1a8')).toMatchObject({ kind: 'correct', solved: true });
    expect(s.outcome).toMatchObject({ solved: false, grade: 1 });
  });

  it('an alternative the engine accepts solves the puzzle', () => {
    const s = new PuzzleSession(preparePuzzle(TWO_MATES));
    s.play('h2h3');
    s.resolveAlternative(true);
    expect(s.status).toBe('solved');
    expect(s.outcome?.solved).toBe(true);
    expect(s.movesPlayed).toEqual(['h2h3']);
  });

  it('a hint names the piece to move and makes a solve Hard; showing the solution is a failure', () => {
    const s = new PuzzleSession(preparePuzzle(TWO_MATES));
    expect(s.hint()).toBe('a1');
    s.play('a1a8');
    expect(s.outcome).toMatchObject({ solved: true, hintUsed: true, grade: 2 });

    const t = new PuzzleSession(preparePuzzle(TWO_MATES));
    expect(t.showSolution()).toEqual(['a1a8']);
    expect(t.status).toBe('shown');
    expect(t.outcome).toMatchObject({ solved: false, grade: 1 });
  });

  it('grades a clean solve Easy when quick, Good otherwise', () => {
    expect(gradeAttempt({ solved: true, hintUsed: false, timeMs: 9_000, playerMoves: 1 })).toBe(4);
    expect(gradeAttempt({ solved: true, hintUsed: false, timeMs: 19_000, playerMoves: 2 })).toBe(4);
    expect(gradeAttempt({ solved: true, hintUsed: false, timeMs: 31_000, playerMoves: 2 })).toBe(3);
    expect(gradeAttempt({ solved: false, hintUsed: false, timeMs: 1_000, playerMoves: 1 })).toBe(1);
    const c = clock();
    const s = new PuzzleSession(preparePuzzle(TWO_MATES), c.now);
    c.advance(30_000);
    s.play('a1a8');
    expect(s.outcome).toMatchObject({ solved: true, timeMs: 30_000, grade: 3 });
  });

  it('matches a promotion by its piece', () => {
    // White pawn e7: the setup move is Black's king move, the solution e8=Q+
    const promo = { id: 'promo', fen: '8/4P3/8/8/8/8/k7/4K3 b - - 0 1', moves: ['a2b2', 'e7e8q'] };
    const s = new PuzzleSession(preparePuzzle(promo));
    expect(s.play('e7e8n').kind).toBe('check');
    s.resolveAlternative(false);
    expect(s.play('e7e8q')).toMatchObject({ kind: 'correct', solved: true });
  });
});

describe('Phase 6 — alternative moves', () => {
  const cp = (value: number) => ({ type: 'cp' as const, value });
  const mate = (value: number) => ({ type: 'mate' as const, value });

  it('accepts a mate, a forced mate, a decisive advantage, or a move as good as the solution', () => {
    expect(judgeAlternative({ givesMate: true, altScore: null, solutionScore: null, matePuzzle: true })).toEqual({
      accepted: true,
      reason: 'mate',
    });
    expect(judgeAlternative({ givesMate: false, altScore: mate(3), solutionScore: mate(2), matePuzzle: true })).toMatchObject({
      reason: 'forced-mate',
    });
    expect(judgeAlternative({ givesMate: false, altScore: cp(700), solutionScore: cp(900), matePuzzle: false })).toMatchObject({
      reason: 'decisive',
    });
    expect(judgeAlternative({ givesMate: false, altScore: cp(240), solutionScore: cp(250), matePuzzle: false })).toMatchObject({
      reason: 'as-good',
    });
  });

  it('rejects a move that gives the advantage away, and non-mates in a mate puzzle', () => {
    expect(judgeAlternative({ givesMate: false, altScore: cp(100), solutionScore: cp(400), matePuzzle: false })).toEqual({
      accepted: false,
    });
    expect(judgeAlternative({ givesMate: false, altScore: cp(2000), solutionScore: mate(2), matePuzzle: true })).toEqual({
      accepted: false,
    });
    expect(judgeAlternative({ givesMate: false, altScore: mate(-2), solutionScore: cp(300), matePuzzle: false })).toEqual({
      accepted: false,
    });
    expect(judgeAlternative({ givesMate: false, altScore: null, solutionScore: cp(300), matePuzzle: false })).toEqual({
      accepted: false,
    });
    expect(DECISIVE_WIN_PERCENT).toBe(90);
  });

  it('a personal puzzle needs a best move clearly ahead of the second-best', () => {
    const line = (multipv: number, score: { type: 'cp' | 'mate'; value: number }) => ({ multipv, score, pv: ['e2e4'] });
    expect(PERSONAL_MIN_GAP).toBe(10);
    expect(isClearBest([line(1, cp(300)), line(2, cp(-100))])).toBe(true);
    // Nearly as good: rejected
    expect(isClearBest([line(1, cp(300)), line(2, cp(250))])).toBe(false);
    expect(isClearBest([line(1, mate(2)), line(2, mate(4))])).toBe(false);
    // One line only (no second-best to compare): rejected
    expect(isClearBest([line(1, cp(300))])).toBe(false);
    // Order by multipv, not by array position
    expect(isClearBest([line(2, cp(-100)), line(1, cp(300))])).toBe(true);
  });
});

describe('Phase 6 — the bundled puzzle index', () => {
  const dataset = new PuzzleDataset(puzzles);

  it('offers themed drills with enough puzzles', () => {
    const themes = dataset.themes();
    expect(themes.map((t) => t.id)).toEqual(expect.arrayContaining(['mateIn1', 'mateIn2', 'fork', 'pin', 'endgame']));
    for (const t of themes) expect(t.count).toBeGreaterThanOrEqual(100);
  });

  it('picks near the target rating, of the theme, never an excluded one', () => {
    const exclude = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const p = dataset.pick({ theme: 'fork', targetRating: 1500, exclude, random: () => 0.5 })!;
      expect(p.themes).toContain('fork');
      expect(Math.abs(p.rating - 1500)).toBeLessThanOrEqual(100);
      expect(exclude.has(p.id)).toBe(false);
      exclude.add(p.id);
    }
    const mix = dataset.pick({ theme: null, targetRating: 900, exclude: [], random: () => 0 })!;
    expect(Math.abs(mix.rating - 900)).toBeLessThanOrEqual(100);
  });

  it('widens the window when nothing is close, and runs out only when everything is excluded', () => {
    const far = dataset.pick({ theme: 'mateIn1', targetRating: 3500, exclude: [], random: () => 0 })!;
    expect(far.themes).toContain('mateIn1');
    const all = puzzles.filter((p) => p.themes.includes('underPromotion')).map((p) => p.id);
    expect(dataset.pick({ theme: 'underPromotion', targetRating: 1500, exclude: all })).toBeNull();
    expect(dataset.pick({ theme: 'no-such-theme', targetRating: 1500, exclude: [] })).toBeNull();
  });
});
