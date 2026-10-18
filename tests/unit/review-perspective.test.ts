import { describe, expect, it } from 'vitest';
import {
  defaultPerspective,
  movesOfClass,
  perspectiveErrors,
  perspectiveKeyMoments,
  perspectiveSeries,
  playerHeading,
  playerInfo,
  stepCycle,
} from '../../src/review/perspective';
import { findKeyMoments } from '../../src/review/review-game';
import type { GameReview, MoveClassification, ReviewedMove } from '../../src/review/types';

const move = (
  ply: number,
  winBefore: number,
  winAfter: number,
  classification: MoveClassification = 'Good',
): ReviewedMove => {
  const color = ply % 2 === 1 ? 'w' : 'b';
  return {
    ply,
    nodeId: `n${ply}`,
    color,
    moveNumber: Math.ceil(ply / 2),
    san: `m${ply}`,
    winBefore,
    winAfter,
    whiteWinAfter: color === 'w' ? winAfter : 100 - winAfter,
    classification,
  } as ReviewedMove;
};

// White's win% before each move follows from the previous move; the swings:
//  1 w  50→49  (−1)        2 b  51→30 Mistake (White +21)   3 w 70→40 Blunder (−30)
//  4 b  60→58  (+2)        5 w  42→35 Inaccuracy (−7)        6 b 65→60 Miss (White +5)
//  7 w  40→10 Miss (−30)   8 b  90→89 (+1)
const MOVES = [
  move(1, 50, 49),
  move(2, 51, 30, 'Mistake'),
  move(3, 70, 40, 'Blunder'),
  move(4, 60, 58),
  move(5, 42, 35, 'Inaccuracy'),
  move(6, 65, 60, 'Miss'),
  move(7, 40, 10, 'Miss'),
  move(8, 90, 89),
];

function reviewOf(moves: ReviewedMove[]): GameReview {
  return { moves, keyMoments: findKeyMoments(moves) } as GameReview;
}

describe('review perspective', () => {
  it('defaults to my side when one player is my Lichess account, otherwise Both', () => {
    const lichess = { Site: 'https://lichess.org/Bjl39T9x', White: 'GEU3', Black: 'Lobo017' };
    expect(defaultPerspective(lichess)).toBe('b');
    // Lichess usernames are case-insensitive
    expect(defaultPerspective({ ...lichess, White: 'lobo017', Black: 'GEU3' })).toBe('w');
    // No Site header: the name alone decides
    expect(defaultPerspective({ White: 'Lobo017', Black: 'Someone' })).toBe('w');
    // Same name on another site is somebody else
    expect(defaultPerspective({ Site: 'Chess.com', White: 'Lobo017', Black: 'x' })).toBe('both');
    // Neither player, or both players (a game against myself)
    expect(defaultPerspective({ White: 'Paul Morphy', Black: 'Duke Karl' })).toBe('both');
    expect(defaultPerspective({ White: 'Lobo017', Black: 'Lobo017' })).toBe('both');
    expect(defaultPerspective({})).toBe('both');
    // Other accounts can be passed in (Phase 5b settings)
    expect(
      defaultPerspective({ Site: 'https://www.chess.com/game/1', White: 'a', Black: 'Me' }, [
        { site: 'chesscom', username: 'me' },
      ]),
    ).toBe('b');
  });

  it('reads names and ratings from the headers', () => {
    const headers = { White: 'GEU3', Black: 'Lobo017', WhiteElo: '1374', BlackElo: '1397' };
    expect(playerHeading(playerInfo(headers, 'b'))).toBe('Lobo017 · 1397 · Black');
    expect(playerHeading(playerInfo(headers, 'w'))).toBe('GEU3 · 1374 · White');
    // Missing or placeholder values
    expect(playerInfo({ White: '?', WhiteElo: '?' }, 'w')).toEqual({ color: 'w', name: 'White', rating: null });
    expect(playerHeading(playerInfo({}, 'b'))).toBe('Black');
    expect(playerHeading(playerInfo({ White: 'Paul Morphy' }, 'w'))).toBe('Paul Morphy · White');
  });

  it("one side's errors include its Misses; Both covers every error", () => {
    expect(perspectiveErrors(MOVES, 'w').map((m) => m.ply)).toEqual([3, 5, 7]);
    expect(perspectiveErrors(MOVES, 'b').map((m) => m.ply)).toEqual([2, 6]);
    expect(perspectiveErrors(MOVES, 'both').map((m) => m.ply)).toEqual([2, 3, 5, 6, 7]);
    expect(movesOfClass(MOVES, 'w', 'Miss').map((m) => m.ply)).toEqual([7]);
  });

  it("key moments for one side are that side's biggest drops; Both keeps the game's", () => {
    const review = reviewOf(MOVES);
    expect(perspectiveKeyMoments(review, 'both')).toBe(review.keyMoments);
    expect(perspectiveKeyMoments(review, 'w').map((m) => m.ply)).toEqual([3, 5, 7]);
    // Black's drops: 2 (21), 6 (5), 4 (2); move 8 dropped 1 point for Black
    expect(perspectiveKeyMoments(review, 'b').map((m) => m.ply)).toEqual([2, 4, 6]);
    // A move that improved the mover's position is never one of its key moments
    const gain = [move(1, 50, 49), move(2, 51, 80), move(3, 20, 19)];
    expect(findKeyMoments(gain, 'b')).toEqual([]);
  });

  it("draws the chart from the side's point of view", () => {
    const series = [52, 40, null];
    expect(perspectiveSeries(series, 'w')).toEqual([52, 40, null]);
    expect(perspectiveSeries(series, 'both')).toEqual([52, 40, null]);
    expect(perspectiveSeries(series, 'b')).toEqual([48, 60, null]);
  });

  it('steps through a list in both directions, wrapping around', () => {
    const errors = perspectiveErrors(MOVES, 'w');
    expect(stepCycle(errors, 0, 1)?.ply).toBe(3);
    expect(stepCycle(errors, 3, 1)?.ply).toBe(5);
    expect(stepCycle(errors, 4, 1)?.ply).toBe(5);
    expect(stepCycle(errors, 7, 1)?.ply).toBe(3);
    expect(stepCycle(errors, 5, -1)?.ply).toBe(3);
    expect(stepCycle(errors, 3, -1)?.ply).toBe(7);
    expect(stepCycle(errors, 0, -1)?.ply).toBe(7);
    expect(stepCycle([], 3, 1)).toBeNull();
  });
});
