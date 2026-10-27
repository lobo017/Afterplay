import { describe, expect, it } from 'vitest';
import { GameTree } from '../../src/core/game-tree';
import { parsePgn } from '../../src/core/pgn';
import { writePgn } from '../../src/core/pgn';
import { stripEngineComment } from '../../src/review/annotations';
import { describeHintedMoves, HINT_COMMENT_PREFIX, hintComment, hintedMoves } from '../../src/review/hints';

describe('hints kept with the game', () => {
  it('words the comment for one hint and for several asked before the same move', () => {
    expect(hintComment(['Nf3'])).toBe('Hint used: Nf3');
    expect(hintComment(['Nf3', 'e4'])).toBe('Hint used (2×): Nf3');
    expect(hintComment(['Nf3']).startsWith(HINT_COMMENT_PREFIX)).toBe(true);
  });

  it('finds the hinted moves of the main line, with the side that played them', () => {
    const tree = new GameTree();
    tree.addMove('e2e4');
    tree.addMove('e7e5', { comment: hintComment(['e5']) });
    tree.addMove('g1f3');
    tree.addMove('b8c6', { comment: 'a human note' });
    tree.addMove('f1b5', { comment: hintComment(['Bb5']) });
    const hinted = hintedMoves(tree);
    expect(hinted.map((h) => [h.ply, h.color, h.san])).toEqual([
      [2, 'b', 'e5'],
      [5, 'w', 'Bb5'],
    ]);
    expect(describeHintedMoves(hinted)).toBe('1... e5, 3. Bb5');
  });

  it('survives the PGN of a saved game and a review (a plain comment is never taken for engine text)', () => {
    const tree = new GameTree();
    tree.addMove('e2e4');
    tree.addMove('e7e5', { comment: hintComment(['e5']) });
    const pgn = writePgn(tree);
    expect(pgn).toContain('Hint used: e5');
    const back = parsePgn(pgn);
    expect(hintedMoves(back).map((h) => h.san)).toEqual(['e5']);
    // what a review does to a comment: engine/Lichess text goes, human text stays
    expect(stripEngineComment('Hint used: e5').human).toBe('Hint used: e5');
  });
});
