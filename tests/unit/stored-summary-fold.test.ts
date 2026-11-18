import { describe, expect, it } from 'vitest';
import { readReviewNumbers } from '../../src/library/review-numbers';
import { STORED_CLASSES, storedMomentFor, storedNumbersFor, storedSummaryView } from '../../src/library/stored-summary';
import { storedKeyMoment } from '../../src/review/perspective';
import type { StoredGameRecord } from '../../src/storage/db';
import { ME } from './helpers/story-games';
import { batch } from './helpers/story-reviews';

// A game opened from the Games list with a summary made in advance: the "How you played" fold and the one key moment the
// summary can name. Invented games and numbers.
const accounts = [{ site: 'chesscom' as const, username: ME }];

/** A game of mine with a summary made in advance. `dropPly` and `drop` are the stored worst move. */
function game(color: 'w' | 'b', side: { dropPly: number | null; drop: number }): StoredGameRecord {
  const r = batch(1, 'fold', () => ({
    game: { color },
    review: { accuracy: 80, inaccuracy: 3, mistake: 2, blunder: 1, brilliant: 1, great: 4 },
  }))[0]!;
  const sides = r.analysis!.sides!;
  const mine = sides[color]!;
  return { ...r, analysis: { ...r.analysis!, sides: { [color]: { ...mine, miss: 5, ...side } } } };
}

describe('the "How you played" rows of a stored game', () => {
  it('lists the six classes a summary counts, in the review order, with my counts', () => {
    const view = storedSummaryView(storedNumbersFor(game('w', { dropPly: 11, drop: 20 }), accounts)!);
    expect(view.classes.map((c) => c.cls)).toEqual([...STORED_CLASSES]);
    expect(view.classes.map((c) => c.cls)).toEqual(['Brilliant', 'Great', 'Inaccuracy', 'Mistake', 'Miss', 'Blunder']);
    expect(view.classes.map((c) => c.count)).toEqual([1, 4, 3, 2, 5, 1]);
  });

  it('never lists a class the summary does not store (Best, Excellent, Good, Book)', () => {
    const view = storedSummaryView(storedNumbersFor(game('b', { dropPly: 12, drop: 20 }), accounts)!);
    const names = view.classes.map((c) => c.cls as string);
    for (const missing of ['Best', 'Excellent', 'Good', 'Book']) expect(names).not.toContain(missing);
  });

  it('keeps the tiles and the accuracy as they were', () => {
    const view = storedSummaryView(storedNumbersFor(game('w', { dropPly: 11, drop: 20 }), accounts)!);
    expect(view.accuracy).toBe('80.0%');
    expect(view.tiles.map((t) => t.key)).toEqual(['mistake', 'blunder', 'brilliant', 'great']);
  });
});

describe('the key moment a summary can name', () => {
  it('is my move with the largest loss: its ply, and the loss as a negative swing for me', () => {
    expect(storedMomentFor(game('w', { dropPly: 11, drop: 23.4 }), accounts)).toEqual({
      color: 'w',
      ply: 11,
      swing: -23.4,
    });
    expect(storedMomentFor(game('b', { dropPly: 12, drop: 31 }), accounts)).toEqual({
      color: 'b',
      ply: 12,
      swing: -31,
    });
  });

  it('is none when no move lost at least the review’s own key-moment minimum (5 points)', () => {
    expect(storedMomentFor(game('w', { dropPly: 11, drop: 4.9 }), accounts)).toBeNull();
    expect(storedMomentFor(game('w', { dropPly: 11, drop: 5 }), accounts)).not.toBeNull();
    expect(storedMomentFor(game('w', { dropPly: 11, drop: 0 }), accounts)).toBeNull();
  });

  it('is none when the summary names no move, or a move that is not mine', () => {
    expect(storedMomentFor(game('w', { dropPly: null, drop: 30 }), accounts)).toBeNull();
    // ply 12 is Black's move; I am White
    expect(storedMomentFor(game('w', { dropPly: 12, drop: 30 }), accounts)).toBeNull();
    expect(storedMomentFor(game('b', { dropPly: 11, drop: 30 }), accounts)).toBeNull();
    expect(storedMomentFor(game('w', { dropPly: 0, drop: 30 }), accounts)).toBeNull();
    expect(storedMomentFor(game('w', { dropPly: 11.5, drop: 30 }), accounts)).toBeNull();
  });

  it('is none for a game with no summary made in advance', () => {
    const r = game('w', { dropPly: 11, drop: 30 });
    expect(storedMomentFor({ ...r, analysis: null }, accounts)).toBeNull();
    // a review made on this device opens as a full review, not as numbers
    const device = { ...r, analysis: { ...r.analysis!, summaryOnly: undefined } };
    expect(storedMomentFor(device, accounts)).toBeNull();
  });

  it('does not change the numbers the reader gives (the stored move is read beside them)', () => {
    const r = game('w', { dropPly: 11, drop: 20 });
    expect(Object.keys(readReviewNumbers(r, 'w')!)).not.toContain('dropPly');
  });
});

describe('storedKeyMoment', () => {
  it('reads only the stored worst move of the side asked about', () => {
    expect(storedKeyMoment(undefined, 'w')).toBeNull();
    expect(storedKeyMoment({ drop: 12, dropPly: 3 }, 'w')).toEqual({ ply: 3, swing: -12 });
    expect(storedKeyMoment({ drop: 12, dropPly: 4 }, 'b')).toEqual({ ply: 4, swing: -12 });
    expect(storedKeyMoment({ drop: Number.NaN, dropPly: 4 }, 'b')).toBeNull();
  });
});
