import { describe, expect, it } from 'vitest';
import { parsePgn } from '../../src/core/pgn';
import { restoreSavedReview, toSavedReview } from '../../src/library/saved-review';
import {
  DEFAULT_USER_ACCOUNTS,
  KEY_MOMENTS_SHOWN_MAX,
  defaultPerspective,
  movesOfClass,
  perspectiveErrors,
  perspectiveKeyMoments,
  perspectiveSeries,
  playerHeading,
  playerInfo,
  stepCycle,
  type UserAccount,
} from '../../src/review/perspective';
import { findKeyMoments, mainLinePlies } from '../../src/review/review-game';
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
    // The app has no built-in account: mine is given, as the library gives the saved ones
    const me: UserAccount[] = [{ site: 'lichess', username: 'Lobo017' }];
    const lichess = { Site: 'https://lichess.org/Bjl39T9x', White: 'GEU3', Black: 'Lobo017' };
    expect(defaultPerspective(lichess, me)).toBe('b');
    // Lichess usernames are case-insensitive
    expect(defaultPerspective({ ...lichess, White: 'lobo017', Black: 'GEU3' }, me)).toBe('w');
    // No Site header: the name alone decides
    expect(defaultPerspective({ White: 'Lobo017', Black: 'Someone' }, me)).toBe('w');
    // Same name on another site is somebody else
    expect(defaultPerspective({ Site: 'Chess.com', White: 'Lobo017', Black: 'x' }, me)).toBe('both');
    // Neither player, or both players (a game against myself)
    expect(defaultPerspective({ White: 'Paul Morphy', Black: 'Duke Karl' }, me)).toBe('both');
    expect(defaultPerspective({ White: 'Lobo017', Black: 'Lobo017' }, me)).toBe('both');
    expect(defaultPerspective({}, me)).toBe('both');
    // Other accounts can be passed in (Phase 5b settings)
    expect(
      defaultPerspective({ Site: 'https://www.chess.com/game/1', White: 'a', Black: 'Me' }, [
        { site: 'chesscom', username: 'me' },
      ]),
    ).toBe('b');
  });

  it('with no account saved, no name is mine: every game opens on Both', () => {
    expect(DEFAULT_USER_ACCOUNTS).toEqual([]);
    const lichess = { Site: 'https://lichess.org/Bjl39T9x', White: 'GEU3', Black: 'Lobo017' };
    expect(defaultPerspective(lichess)).toBe('both');
    expect(defaultPerspective({ ...lichess, White: 'Lobo017', Black: 'GEU3' })).toBe('both');
    expect(defaultPerspective({ White: 'Lobo017', Black: 'Someone' })).toBe('both');
    expect(defaultPerspective(lichess, [])).toBe('both');
    // An empty name in the headers is nobody's, with or without accounts
    expect(defaultPerspective({ White: '', Black: 'x' }, [{ site: 'lichess', username: '' }])).toBe('both');
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

  describe('key moments shown: the swings plus Brilliant and Great moves', () => {
    // Four quiet moves after MOVES (swings 0, −0.4, 0, 0): too small to be a swing of the game
    const GREAT_W = move(9, 11, 11, 'Great');
    const BRILLIANT_B = move(10, 89, 89.4, 'Brilliant');
    const BRILLIANT_W = move(11, 10.6, 10.6, 'Brilliant');
    const GREAT_B = move(12, 89.4, 89.4, 'Great');
    const plies = (list: Array<{ ply: number }>) => list.map((m) => m.ply);

    it('the game alone gives its five swings; the three largest are 3, 7 and 2', () => {
      const review = reviewOf(MOVES);
      expect(plies(review.keyMoments)).toEqual([2, 3, 5, 6, 7]);
      expect(KEY_MOMENTS_SHOWN_MAX).toBe(5);
    });

    it('adds a Brilliant and a Great move, by either side in the Both view, in game order', () => {
      const review = reviewOf([...MOVES, GREAT_W, BRILLIANT_B]);
      // Neither is a swing of the game
      expect(plies(review.keyMoments)).toEqual([2, 3, 5, 6, 7]);
      const shown = perspectiveKeyMoments(review, 'both');
      // The three largest swings stay; the two smaller ones (5 and 6) make room
      expect(plies(shown)).toEqual([2, 3, 7, 9, 10]);
      expect(shown.map((m) => m.highlight)).toEqual([undefined, undefined, undefined, 'Great', 'Brilliant']);
      expect(shown[3]).toEqual({ ply: 9, nodeId: 'n9', swing: 0, label: '5. m9 — Great', highlight: 'Great' });
      expect(shown[4]!.label).toBe('5... m10 — Brilliant');
      expect(shown[4]!.swing).toBeCloseTo(-0.4, 6);
      // The swings are the review's own entries, untouched
      for (const k of shown.slice(0, 3)) expect(review.keyMoments).toContain(k);
      // The review itself is not changed
      expect(plies(review.keyMoments)).toEqual([2, 3, 5, 6, 7]);
    });

    it('shows five at most and two highlights at most: Brilliant before Great, then the larger swing, then the earlier move', () => {
      const review = reviewOf([...MOVES, GREAT_W, BRILLIANT_B, BRILLIANT_W, GREAT_B]);
      const shown = perspectiveKeyMoments(review, 'both');
      expect(shown).toHaveLength(5);
      // Both Brilliant moves (10 moved the chances more than 11) come before either Great move
      expect(plies(shown)).toEqual([2, 3, 7, 10, 11]);
      // Two Great moves with the same swing: the earlier one
      const greats = perspectiveKeyMoments(
        reviewOf([...MOVES, GREAT_W, GREAT_B, move(13, 10.6, 10.6, 'Great')]),
        'both',
      );
      expect(plies(greats)).toEqual([2, 3, 7, 9, 12]);
      // A Great move that moved the chances more (13) goes before the earlier ones
      const three = perspectiveKeyMoments(
        reviewOf([...MOVES, GREAT_W, GREAT_B, move(13, 10.6, 10.9, 'Great')]),
        'both',
      );
      expect(plies(three)).toEqual([2, 3, 7, 9, 13]);
    });

    it('the three largest swings are never pushed out; the room left goes to the next largest swings', () => {
      const one = perspectiveKeyMoments(reviewOf([...MOVES, BRILLIANT_W]), 'both');
      // 3, 7, 2 kept, the Brilliant move, then 5 (7 points) before 6 (5 points)
      expect(plies(one)).toEqual([2, 3, 5, 7, 11]);
      expect(one.map((m) => m.highlight)).toEqual([undefined, undefined, undefined, undefined, 'Brilliant']);
      for (const game of [
        [...MOVES, GREAT_W, BRILLIANT_B, BRILLIANT_W, GREAT_B],
        [...MOVES, BRILLIANT_W],
        [...MOVES, GREAT_B, GREAT_W],
      ]) {
        const shown = plies(perspectiveKeyMoments(reviewOf(game), 'both'));
        expect(shown).toEqual(expect.arrayContaining([2, 3, 7]));
        expect(shown.length).toBeLessThanOrEqual(5);
      }
    });

    it("one side's view adds only that side's Brilliant and Great moves", () => {
      const review = reviewOf([...MOVES, GREAT_W, BRILLIANT_B, BRILLIANT_W, GREAT_B]);
      const white = perspectiveKeyMoments(review, 'w');
      expect(plies(white)).toEqual([3, 5, 7, 9, 11]);
      expect(white.map((m) => m.highlight)).toEqual([undefined, undefined, undefined, 'Great', 'Brilliant']);
      expect(white.every((m) => m.ply % 2 === 1)).toBe(true);
      const black = perspectiveKeyMoments(review, 'b');
      expect(plies(black)).toEqual([2, 4, 6, 10, 12]);
      expect(black.map((m) => m.highlight)).toEqual([undefined, undefined, undefined, 'Brilliant', 'Great']);
      expect(black.every((m) => m.ply % 2 === 0)).toBe(true);
      // Only Black has one: White's view is White's drops, as before
      const blackOnly = reviewOf([...MOVES, BRILLIANT_B]);
      expect(perspectiveKeyMoments(blackOnly, 'w')).toEqual(findKeyMoments(blackOnly.moves, 'w'));
      expect(plies(perspectiveKeyMoments(blackOnly, 'b'))).toEqual([2, 4, 6, 10]);
    });

    it('never shows a move twice: a Great move that is already a swing stays one entry, with its swing', () => {
      // A quiet game: its three swings are moves 1, 2 and 3, and move 2 is Great
      const quiet = reviewOf([
        move(1, 50, 49),
        move(2, 51, 49, 'Great'),
        move(3, 51, 48),
        move(4, 52, 52, 'Brilliant'),
      ]);
      expect(plies(quiet.keyMoments)).toEqual([1, 2, 3]);
      const shown = perspectiveKeyMoments(quiet, 'both');
      expect(plies(shown)).toEqual([1, 2, 3, 4]);
      expect(new Set(shown.map((m) => m.nodeId)).size).toBe(shown.length);
      expect(shown[1]).toBe(quiet.keyMoments[1]);
      expect(shown[1]!.highlight).toBeUndefined();
      expect(shown[3]!.highlight).toBe('Brilliant');

      // A Great move among the smaller swings (move 6) takes a highlight place as the swing it already is
      const moves = MOVES.map((m) => (m.ply === 6 ? { ...m, classification: 'Great' as const } : m));
      const review = reviewOf([...moves, BRILLIANT_B]);
      const both = perspectiveKeyMoments(review, 'both');
      expect(plies(both)).toEqual([2, 3, 6, 7, 10]);
      expect(new Set(both.map((m) => m.nodeId)).size).toBe(5);
      expect(both[2]).toBe(review.keyMoments.find((k) => k.ply === 6));
      expect(both[2]!.highlight).toBeUndefined();
    });

    it('a game with no Brilliant or Great move returns the review’s own list, the same array', () => {
      const review = reviewOf(MOVES);
      expect(perspectiveKeyMoments(review, 'both')).toBe(review.keyMoments);
      expect(perspectiveKeyMoments(review, 'w')).toEqual(findKeyMoments(MOVES, 'w'));
      expect(perspectiveKeyMoments(review, 'b')).toEqual(findKeyMoments(MOVES, 'b'));
      expect(perspectiveKeyMoments(review, 'both').some((m) => m.highlight)).toBe(false);
    });

    it('a saved review shown again on a fresh parse of the game gets the same highlights', () => {
      const pgn = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 *';
      const tree = parsePgn(pgn);
      const treePlies = mainLinePlies(tree);
      const moves = [...MOVES, GREAT_W, BRILLIANT_B, BRILLIANT_W, GREAT_B].map((m, i) => ({
        ...m,
        nodeId: treePlies[i]!.nodeId,
        uci: treePlies[i]!.uci,
      }));
      const review = { ...reviewOf(moves), preset: 'quick', complete: true } as GameReview;
      const saved = toSavedReview(
        {
          review,
          positions: [],
          plies: treePlies,
          cancelled: false,
          stats: { timeMs: 1, meanDepth: 1, minDepth: 1, searches: 13, verifiedPositions: 0 },
        },
        1,
      )!;
      // As it comes back from storage, on a tree parsed again
      const fresh = parsePgn(pgn);
      const freshPlies = mainLinePlies(fresh);
      const restored = restoreSavedReview(JSON.parse(JSON.stringify(saved)) as typeof saved, fresh)!;
      for (const p of ['both', 'w', 'b'] as const) {
        const before = perspectiveKeyMoments(review, p);
        const after = perspectiveKeyMoments(restored.review, p);
        expect(after.map((m) => [m.ply, m.highlight, m.label, m.swing])).toEqual(
          before.map((m) => [m.ply, m.highlight, m.label, m.swing]),
        );
        expect(after.map((m) => m.nodeId)).toEqual(after.map((m) => freshPlies[m.ply - 1]!.nodeId));
      }
      expect(plies(perspectiveKeyMoments(restored.review, 'both'))).toEqual([2, 3, 7, 10, 11]);
    });
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
