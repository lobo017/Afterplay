import { describe, expect, it } from 'vitest';
import { parsePgn } from '../../src/core/pgn';
import { RulesAdapter } from '../../src/core/rules';
import { SAMPLE_GAME_PGN } from '../../src/review/sample-game';
import { seededRandom } from '../../src/trainers/repertoire';
import {
  ALL_SQUARES,
  BLINDFOLD_MAX_PLIES,
  BLINDFOLD_MIN_PLIES,
  CoordinateRound,
  GUESS_MAX_POSITIONS,
  buildBlindfoldDrill,
  gradeBlindfold,
  gradeCoordinates,
  gradeGuess,
  guessPositions,
  judgeGuess,
  nextBlindfoldLevel,
  pickBlindfoldSource,
  visualizationCardTarget,
} from '../../src/trainers/visualization';

describe('Phase 7 — coordinate rounds', () => {
  it('has the 64 squares, a1 first', () => {
    expect(ALL_SQUARES).toHaveLength(64);
    expect(ALL_SQUARES[0]).toBe('a1');
    expect(ALL_SQUARES[63]).toBe('h8');
    expect(new Set(ALL_SQUARES).size).toBe(64);
  });

  it('counts right and wrong clicks, and moves on to a new square after each', () => {
    const round = new CoordinateRound(seededRandom(7));
    const first = round.target;
    expect(round.answer(first)).toBe(true);
    expect(round.correct).toBe(1);
    expect(round.target).not.toBe(first);
    const second = round.target;
    const wrong = ALL_SQUARES.find((s) => s !== second)!;
    expect(round.answer(wrong)).toBe(false);
    expect(round.wrong).toBe(1);
    expect(round.target).not.toBe(second);
    expect(round.accuracy).toBe(0.5);
  });

  it('never asks for the same square twice in a row, and reaches the whole board', () => {
    const round = new CoordinateRound(seededRandom(11));
    const seen = new Set<string>();
    let prev = '';
    for (let i = 0; i < 2000; i++) {
      expect(round.target).not.toBe(prev);
      prev = round.target;
      seen.add(prev);
      round.answer(prev as (typeof ALL_SQUARES)[number]);
    }
    expect(seen.size).toBe(64);
  });

  it('grades a round by squares found and accuracy', () => {
    expect(gradeCoordinates({ correct: 0, wrong: 0 })).toBe(1);
    expect(gradeCoordinates({ correct: 9, wrong: 0 })).toBe(1);
    expect(gradeCoordinates({ correct: 10, wrong: 6 })).toBe(2);
    expect(gradeCoordinates({ correct: 10, wrong: 7 })).toBe(1); // 59%
    expect(gradeCoordinates({ correct: 20, wrong: 5 })).toBe(3);
    expect(gradeCoordinates({ correct: 20, wrong: 6 })).toBe(2); // 77%
    expect(gradeCoordinates({ correct: 35, wrong: 3 })).toBe(4);
    expect(gradeCoordinates({ correct: 35, wrong: 5 })).toBe(3); // 87%
  });
});

describe('Phase 7 — blindfold drills', () => {
  const ITALIAN = {
    label: 'Italian Game',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4', 'exd4', 'cxd4', 'Bb4+'],
  };

  it('reads out the first plies of a line, as spoken moves', () => {
    const drill = buildBlindfoldDrill(ITALIAN, 6, seededRandom(1));
    expect(drill.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']);
    expect(drill.moves.map((m) => m.spoken)).toEqual([
      'Pawn to e4',
      'Pawn to e5',
      'Knight to f3',
      'Knight to c6',
      'Bishop to c4',
      'Bishop to c5',
    ]);
    expect(drill.moves.map((m) => m.color)).toEqual(['w', 'b', 'w', 'b', 'w', 'b']);
    expect(drill.label).toBe('Italian Game');
  });

  it('says captures, castling and promotion', () => {
    const drill = buildBlindfoldDrill(
      { label: 'x', moves: ['e4', 'd5', 'exd5', 'Nf6', 'Nf3', 'Nxd5', 'Be2', 'e6', 'O-O'] },
      9,
      seededRandom(1),
    );
    expect(drill.moves[2]!.spoken).toBe('Pawn takes on d5');
    expect(drill.moves[5]!.spoken).toBe('Knight takes on d5');
    expect(drill.moves[8]!.spoken).toBe('Castles kingside');
    const promo = buildBlindfoldDrill(
      { label: 'p', moves: ['h4', 'g5', 'hxg5', 'h5', 'g6', 'h4', 'g7', 'h3', 'gxh8=Q'] },
      9,
      seededRandom(1),
    );
    expect(promo.moves[8]!.spoken).toBe('Pawn takes on h8, promotes to queen');
  });

  it('asks where pieces are, about the right squares, with moved pieces first', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const drill = buildBlindfoldDrill(ITALIAN, 12, seededRandom(seed));
      expect(drill.questions).toHaveLength(5);
      const board = new RulesAdapter(drill.finalFen);
      const asked = new Set<string>();
      for (const q of drill.questions) {
        expect(q.squares.length).toBeGreaterThan(0);
        for (const s of q.squares)
          expect(board.get(s), `${q.text} ${s}`).toMatchObject({ color: q.color, type: q.piece });
        expect(q.piece).not.toBe('p');
        expect(q.text).toMatch(/^Where is the (white|black) (king|queen|rook|bishop|knight)\?$/);
        asked.add(`${q.color}${q.piece}`);
      }
      expect(asked.size).toBe(5); // no piece asked twice
      // The four piece kinds that moved (a knight and a bishop each) are always among the five questions
      for (const kind of ['wn', 'wb', 'bn', 'bb']) expect(asked.has(kind), `seed ${seed}: ${kind}`).toBe(true);
    }
  });

  it('a piece with two squares accepts either (two knights, two rooks)', () => {
    const drill = buildBlindfoldDrill({ label: 'x', moves: ['e4', 'e5'] }, 2, seededRandom(2), 10);
    const knights = drill.questions.find((q) => q.piece === 'n' && q.color === 'w')!;
    expect(knights.squares.sort()).toEqual(['b1', 'g1']);
    // Only non-pawn pieces: 2 sides × (K, Q, R, B, N) = 10 groups
    expect(drill.questions).toHaveLength(10);
  });

  it('is repeatable with a seed, and a plain line never throws on the first plies', () => {
    const a = buildBlindfoldDrill(ITALIAN, 8, seededRandom(42));
    const b = buildBlindfoldDrill(ITALIAN, 8, seededRandom(42));
    expect(a.questions.map((q) => q.text)).toEqual(b.questions.map((q) => q.text));
    expect(() => buildBlindfoldDrill({ label: 'x', moves: ['e4'] }, 8, seededRandom(1))).not.toThrow();
  });

  it('grades a drill: all right is Good, one miss Hard, more Again', () => {
    expect(gradeBlindfold({ correct: 5, total: 5 })).toBe(3);
    expect(gradeBlindfold({ correct: 4, total: 5 })).toBe(2);
    expect(gradeBlindfold({ correct: 3, total: 5 })).toBe(1);
    expect(gradeBlindfold({ correct: 0, total: 0 })).toBe(1);
  });

  it('moves the level: two plies up after a perfect drill, two down after two misses, within limits', () => {
    expect(nextBlindfoldLevel(8, { correct: 5, total: 5 })).toBe(10);
    expect(nextBlindfoldLevel(8, { correct: 4, total: 5 })).toBe(8);
    expect(nextBlindfoldLevel(8, { correct: 3, total: 5 })).toBe(6);
    expect(nextBlindfoldLevel(BLINDFOLD_MIN_PLIES, { correct: 0, total: 5 })).toBe(BLINDFOLD_MIN_PLIES);
    expect(nextBlindfoldLevel(BLINDFOLD_MAX_PLIES, { correct: 5, total: 5 })).toBe(BLINDFOLD_MAX_PLIES);
  });

  it('picks a line long enough, or none', () => {
    const lines = [
      { label: 'short', moves: ['e4', 'e5'] },
      { label: 'long', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'] },
    ];
    expect(pickBlindfoldSource(lines, 4, seededRandom(1))?.label).toBe('long');
    expect(pickBlindfoldSource(lines, 1, seededRandom(1))).not.toBeNull();
    expect(pickBlindfoldSource(lines, 6, seededRandom(1))).toBeNull();
  });

  it('the sample game is long enough for the top level', () => {
    const sample = parsePgn(SAMPLE_GAME_PGN)
      .getMainLine()
      .map((n) => n.san);
    expect(sample.length).toBeGreaterThanOrEqual(30);
    expect(() => buildBlindfoldDrill({ label: 'Opera', moves: sample }, sample.length, seededRandom(3))).not.toThrow();
  });
});

describe('Phase 7 — guess the move', () => {
  const sample = () => parsePgn(SAMPLE_GAME_PGN);

  it('asks my moves: not the first few, not forced ones, spread over the game, at most ten', () => {
    const tree = sample();
    const white = guessPositions(tree, 'w');
    // White made 17 moves; the first 3 are left out and 14 are spread over 10 questions
    expect(white).toHaveLength(GUESS_MAX_POSITIONS);
    expect(white[0]!.label).toBe('4.dxe5');
    expect(white[white.length - 1]!.label).toBe('17.Rd8#');
    expect(white.every((p) => p.ply % 2 === 1)).toBe(true);
    expect(white.map((p) => p.ply)).toEqual([...white.map((p) => p.ply)].sort((a, b) => a - b));
    // Each position is the one before the move, and the move is legal there
    for (const p of white) expect(new RulesAdapter(p.fen).move(p.uci).san).toBe(p.san);

    const black = guessPositions(tree, 'b');
    expect(black.every((p) => p.ply % 2 === 0)).toBe(true);
    // 16...Nxb8 is forced (Qb8+ attacks the king: only Nxb8 answers... the knight on d7) and left out
    expect(black.map((p) => p.label)).not.toContain('16...Nxb8');
  });

  it('a short game is asked from its first moves', () => {
    const short = parsePgn('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *');
    expect(guessPositions(short, 'w').map((p) => p.label)).toEqual(['1.e4', '2.Nf3', '3.Bb5']);
    expect(guessPositions(short, 'b').map((p) => p.label)).toEqual(['1...e5', '2...Nc6', '3...a6']);
    // Four moves of mine: the first is left out
    expect(guessPositions(parsePgn('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 *'), 'w').map((p) => p.label)).toEqual([
      '2.Nf3',
      '3.Bb5',
      '4.Ba4',
    ]);
    expect(guessPositions(parsePgn('1. e4 *'), 'w').map((p) => p.label)).toEqual(['1.e4']);
    expect(guessPositions(parsePgn('1. e4 *'), 'b')).toEqual([]);
  });

  it('carries the review’s best move for the position', () => {
    const tree = parsePgn('1. e4 e5 2. Nf3 Nc6 *');
    const best = new Map([[3, 'g1f3']]);
    const positions = guessPositions(tree, 'w', best);
    expect(positions.find((p) => p.ply === 3)?.bestUci).toBe('g1f3');
    expect(positions.find((p) => p.ply === 1)?.bestUci).toBeNull();
  });

  it('judges a guess: the move played, the review’s best, or something else', () => {
    const tree = parsePgn('1. e4 e5 2. Nf3 Nc6 *');
    const pos = guessPositions(tree, 'w', new Map([[3, 'b1c3']]))[1]!;
    expect(pos.san).toBe('Nf3');
    expect(judgeGuess(pos, 'g1f3')).toBe('played');
    expect(judgeGuess(pos, 'b1c3')).toBe('best');
    expect(judgeGuess(pos, 'd2d4')).toBe('other');
    // Castling is a king move of two squares, and the played move matches it
    const castle = guessPositions(parsePgn('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 *'), 'w').find(
      (p) => p.san === 'O-O',
    )!;
    expect(judgeGuess(castle, 'e1g1')).toBe('played');
  });

  it('grades a game by the share of guesses that match', () => {
    expect(gradeGuess({ hits: 7, total: 10 })).toBe(3);
    expect(gradeGuess({ hits: 6, total: 10 })).toBe(2);
    expect(gradeGuess({ hits: 4, total: 10 })).toBe(2);
    expect(gradeGuess({ hits: 3, total: 10 })).toBe(1);
    expect(gradeGuess({ hits: 0, total: 0 })).toBe(1);
  });

  it('names the card of each drill', () => {
    expect(visualizationCardTarget('coordinates')).toBe('coordinates');
    expect(visualizationCardTarget('blindfold')).toBe('blindfold');
    expect(visualizationCardTarget('guess', 'lichess:abc')).toBe('guess:lichess:abc');
  });
});
