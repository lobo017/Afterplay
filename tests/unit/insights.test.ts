import { describe, expect, it } from 'vitest';
import { buildGameRecord } from '../../src/library/game-record';
import { toRow } from '../../src/library/game-rows';
import {
  OPENING_PLIES,
  accuracyByPhase,
  blundersOverTime,
  commonMotifs,
  minorAndMajorPieces,
  openingFamily,
  phaseOf,
  puzzleRatingSeries,
  resultsByOpening,
  type ReviewedGameInput,
} from '../../src/library/insights';
import { checkPgnText } from '../../src/capture/pgn-games';
import type { SavedReview } from '../../src/library/saved-review';
import type { ReviewedMove } from '../../src/review/types';
import type { StoredGameRecord } from '../../src/storage/db';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ENDING = '8/5pk1/8/3R4/8/8/5PK1/3r4 w - - 0 1';
const ACCOUNTS = [{ site: 'lichess' as const, username: 'Me' }];

function move(ply: number, color: 'w' | 'b', patch: Partial<ReviewedMove> = {}): ReviewedMove {
  return {
    ply,
    nodeId: `n${ply}`,
    color,
    moveNumber: Math.ceil(ply / 2),
    san: 'Nf3',
    uci: 'g1f3',
    fenBefore: START,
    fenAfter: START,
    winBefore: 50,
    winAfter: 50,
    whiteWinAfter: 50,
    winDrop: 0,
    accuracy: 100,
    cpLoss: 0,
    calibrationCpLoss: 0,
    classification: 'Best',
    bestMoveUci: null,
    bestMoveSan: null,
    bestLineSan: [],
    refutationSan: [],
    refutationUci: [],
    scoreBefore: null,
    scoreAfter: null,
    motifs: [],
    explanation: null,
    ...patch,
  };
}

function reviewed(white: string, black: string, result: string, moves: ReviewedMove[], at: number): ReviewedGameInput {
  const pgn = `[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n[Date "2026.01.0${at}"]\n\n1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 ${result}`;
  const valid = checkPgnText(pgn).games[0]!;
  const record: StoredGameRecord = { ...buildGameRecord(valid), id: `g${at}`, playedAt: at * 1000, schemaVersion: 4, createdAt: at, updatedAt: at, source: 'paste' };
  return { row: toRow(record, ACCOUNTS), review: { review: { moves } } as unknown as SavedReview };
}

describe('Phase 8 — insights: phases', () => {
  it('counts the pieces and names the phase', () => {
    expect(minorAndMajorPieces(START)).toBe(14);
    expect(minorAndMajorPieces(ENDING)).toBe(2);
    expect(phaseOf(START, 1)).toBe('opening');
    expect(phaseOf(START, OPENING_PLIES)).toBe('opening');
    expect(phaseOf(START, OPENING_PLIES + 1)).toBe('middlegame');
    // Few pieces left: an endgame whatever the move number
    expect(phaseOf(ENDING, 3)).toBe('endgame');
    expect(phaseOf('r4rk1/pp3ppp/8/8/8/8/PP3PPP/R4RK1 w - - 0 1', 30)).toBe('endgame');
  });

  it('accuracy by phase counts only my moves, worst first', () => {
    const g = reviewed('Me', 'Opp', '1-0', [
      move(1, 'w', { accuracy: 100 }),
      move(2, 'b', { accuracy: 10 }), // not mine
      move(3, 'w', { accuracy: 60, classification: 'Inaccuracy' }),
      move(41, 'w', { accuracy: 80, fenBefore: ENDING }),
      move(43, 'w', { accuracy: 40, fenBefore: START }),
    ], 1);
    const [opening, middlegame, endgame] = accuracyByPhase([g]);
    expect(opening).toMatchObject({ phase: 'opening', moves: 2, accuracy: 80 });
    expect(opening!.positions.map((p) => p.ply)).toEqual([3, 1]);
    expect(middlegame).toMatchObject({ phase: 'middlegame', moves: 1, accuracy: 40 });
    expect(endgame).toMatchObject({ phase: 'endgame', moves: 1, accuracy: 80 });
    expect(opening!.positions[0]).toMatchObject({ gameId: 'g1', moveLabel: '2. Nf3', classification: 'Inaccuracy' });
  });

  it('a game that is not mine counts for nothing', () => {
    const g = reviewed('A', 'B', '1-0', [move(1, 'w')], 1);
    expect(accuracyByPhase([g]).every((p) => p.moves === 0)).toBe(true);
    expect(blundersOverTime([g])).toEqual([]);
  });
});

describe('Phase 8 — insights: blunders, motifs, openings, rating', () => {
  it('blunders per 10 moves, game by game, oldest first', () => {
    const a = reviewed('Me', 'O', '1-0', [move(1, 'w'), move(3, 'w', { classification: 'Blunder' }), move(5, 'w'), move(7, 'w'), move(9, 'w')], 2);
    const b = reviewed('Me', 'O', '0-1', Array.from({ length: 20 }, (_, i) => move(i * 2 + 1, 'w', i < 2 ? { classification: 'Blunder' } : {})), 1);
    const points = blundersOverTime([a, b]);
    expect(points.map((p) => p.gameId)).toEqual(['g1', 'g2']);
    expect(points[0]).toMatchObject({ blunders: 2, moves: 20, per10: 1 });
    expect(points[1]).toMatchObject({ blunders: 1, moves: 5, per10: 2 });
    expect(points[1]!.positions).toHaveLength(1);
  });

  it('motifs: one count per move and motif, from my mistakes only', () => {
    const fork = { kind: 'fork' as const, square: 'e4' as const };
    const g = reviewed('Me', 'O', '0-1', [
      move(1, 'w', { classification: 'Blunder', motifs: [fork, fork, { kind: 'pin', square: 'c3' }] }),
      move(3, 'w', { classification: 'Mistake', motifs: [fork] }),
      move(5, 'w', { classification: 'Good', motifs: [fork] }), // not a mistake
      move(2, 'b', { classification: 'Blunder', motifs: [fork] }), // not mine
    ], 1);
    const m = commonMotifs([g]);
    expect(m.map((x) => [x.kind, x.count])).toEqual([['fork', 2], ['pin', 1]]);
    expect(m[0]!.positions.map((p) => p.ply)).toEqual([1, 3]);
  });

  it('results by opening family, my games only', () => {
    const win = reviewed('Me', 'O', '1-0', [], 1);
    const loss = reviewed('O', 'Me', '1-0', [], 2);
    const notMine = reviewed('A', 'B', '1-0', [], 3);
    const out = resultsByOpening([win, loss, notMine].map((g) => g.row));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ games: 2, wins: 1, losses: 1, draws: 0 });
    expect(out[0]!.name).toBe(openingFamily(out[0]!.name));
    expect(openingFamily('Sicilian Defense: Najdorf Variation')).toBe('Sicilian Defense');
  });

  it('the puzzle rating series is oldest first', () => {
    const s = puzzleRatingSeries([
      { at: 5, rating: 1520, puzzleId: 'b', solved: true },
      { at: 1, rating: 1500, puzzleId: 'a', solved: false },
    ]);
    expect(s.map((p) => p.puzzleId)).toEqual(['a', 'b']);
  });
});
