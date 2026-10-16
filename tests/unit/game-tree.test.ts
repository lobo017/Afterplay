import { describe, expect, it } from 'vitest';
import { GameTree, nagToGlyph, resolveNagCode } from '../../src/core/game-tree';

describe('Phase 1 — GameTree & Variation Management', () => {
  it('adds main-line moves, branches variations, and navigates across the tree', () => {
    const tree = new GameTree();
    const e4 = tree.addMove('e4');
    const e5 = tree.addMove('e5');
    const nf3 = tree.addMove('Nf3');

    expect(tree.getMainLine().map((n) => n.san)).toEqual(['e4', 'e5', 'Nf3']);
    expect(tree.currentNode.id).toBe(nf3.id);

    // Add variation 1... c5 and 1... e6 branching from 1. e4
    const c5 = tree.addVariation(e4.id, 'c5', {
      preComment: 'Sicilian Defense',
      comment: 'Fighting for d4',
      nags: ['!'],
    });
    tree.addMove('Nf3');
    tree.addMove('d6');

    const e6 = tree.addVariation(e4.id, 'e6', {
      comment: 'French Defense',
      nags: ['$5'],
    });

    expect(e4.children.map((c) => c.san)).toEqual(['e5', 'c5', 'e6']);
    expect(c5.preComment).toBe('Sicilian Defense');
    expect(c5.comment).toBe('Fighting for d4');
    expect(c5.nags).toEqual([1]);
    expect(e6.nags).toEqual([5]);

    // Test navigation
    tree.goToStart();
    expect(tree.currentNode.id).toBe(tree.root.id);
    tree.goForward(0);
    expect(tree.currentNode.id).toBe(e4.id);
    tree.goForward(1); // enter 1... c5 variation
    expect(tree.currentNode.id).toBe(c5.id);
    tree.goToEnd();
    expect(tree.getLineToNode(tree.currentNodeId).map((n) => n.san)).toEqual([
      'e4',
      'c5',
      'Nf3',
      'd6',
    ]);
    expect(tree.goBack()?.san).toBe('Nf3');
    void e5;
  });

  it('promotes, demotes, and deletes variations accurately', () => {
    const tree = new GameTree();
    const e4 = tree.addMove('e4');
    const e5 = tree.addMove('e5');
    tree.addMove('Nf3');

    const c5 = tree.addVariation(e4.id, 'c5');
    const c5Nf3 = tree.addMove('Nf3');
    const e6 = tree.addVariation(e4.id, 'e6');
    const c6 = tree.addVariation(e4.id, 'c6');

    expect(e4.children.map((c) => c.san)).toEqual(['e5', 'c5', 'e6', 'c6']);

    // Promote e6 one slot up (swaps with c5)
    expect(tree.promoteVariation(e6.id)).toBe(true);
    expect(e4.children.map((c) => c.san)).toEqual(['e5', 'e6', 'c5', 'c6']);

    // Promote c5 variation using a descendant node ID inside the c5 branch (c5Nf3)
    expect(tree.promoteVariation(c5Nf3.id)).toBe(true);
    expect(e4.children.map((c) => c.san)).toEqual(['e5', 'c5', 'e6', 'c6']);

    // Promote c5 again -> becomes main line (swaps with e5)
    expect(tree.promoteVariation(c5.id)).toBe(true);
    expect(e4.children.map((c) => c.san)).toEqual(['c5', 'e5', 'e6', 'c6']);
    expect(tree.getMainLine().map((n) => n.san)).toEqual(['e4', 'c5', 'Nf3']);

    // Demote c5 back down one slot (e5 becomes main line again)
    expect(tree.demoteVariation(c5.id)).toBe(true);
    expect(e4.children.map((c) => c.san)).toEqual(['e5', 'c5', 'e6', 'c6']);

    // Promote c6 all the way to the main line
    expect(tree.promoteToMainLine(c6.id)).toBe(true);
    expect(e4.children.map((c) => c.san)).toEqual(['c6', 'e5', 'c5', 'e6']);

    // Navigate into c5Nf3 and delete the c5 variation; active node should fall back to e4
    tree.goToNode(c5Nf3.id);
    expect(tree.deleteVariation(c5Nf3.id)).toBe(true);
    expect(e4.children.map((c) => c.san)).toEqual(['c6', 'e5', 'e6']);
    expect(tree.getNode(c5.id)).toBeUndefined();
    expect(tree.getNode(c5Nf3.id)).toBeUndefined();
    expect(tree.currentNodeId).toBe(e4.id);
    void e5;
  });

  it('manages comments, pre-comments, NAGs, eval, arrows, highlights, and JSON round-trip', () => {
    const tree = new GameTree();
    tree.setComment(tree.root.id, 'Game intro comment');
    const e4 = tree.addMove('e4');

    tree.setPreComment(e4.id, 'Best by test');
    tree.setComment(e4.id, 'Controls d5 and f5');
    tree.addNag(e4.id, '!');
    tree.addNag(e4.id, '±');
    tree.addNag(e4.id, '$146');
    tree.setEval(e4.id, { cp: 35, depth: 22 });
    tree.setArrows(e4.id, [
      { color: 'G', from: 'e2', to: 'e4' },
      { color: 'R', from: 'e4', to: 'd5' },
    ]);
    tree.setHighlights(e4.id, [{ color: 'Y', square: 'e4' }]);
    tree.setClassification(e4.id, 'Book');

    expect(e4.nags).toEqual([1, 16, 146]);
    expect(e4.nags.map(nagToGlyph)).toEqual(['!', '±', 'N']);
    expect(resolveNagCode('?!')).toBe(6);

    tree.removeNag(e4.id, 16);
    expect(e4.nags).toEqual([1, 146]);

    const serialized = tree.toJSON();
    const restored = GameTree.fromJSON(serialized);
    const restoredE4 = restored.getNode(e4.id)!;
    expect(restored.root.comment).toBe('Game intro comment');
    expect(restoredE4.preComment).toBe('Best by test');
    expect(restoredE4.comment).toBe('Controls d5 and f5');
    expect(restoredE4.nags).toEqual([1, 146]);
    expect(restoredE4.eval).toEqual({ cp: 35, depth: 22 });
    expect(restoredE4.arrows).toEqual([
      { color: 'G', from: 'e2', to: 'e4' },
      { color: 'R', from: 'e4', to: 'd5' },
    ]);
    expect(restoredE4.highlights).toEqual([{ color: 'Y', square: 'e4' }]);
    expect(restoredE4.classification).toBe('Book');
  });
});
