import { beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { GameTree } from '../../src/core/game-tree';
import { parsePgn, writePgn } from '../../src/core/pgn';
import { DEFAULT_POSITION } from '../../src/core/rules';
import { WizardChessStorage, deleteWizardChessDB } from '../../src/storage/db';
import { RELEARN_DELAY_MS } from '../../src/trainers/fsrs';
import {
  RepertoireDrill,
  addRepertoireMove,
  allMoveNodes,
  deleteRepertoireMove,
  describeDeparture,
  findDeparture,
  importRepertoirePgn,
  indexRepertoire,
  newRepertoireTree,
  positionKey,
  repertoireMovesAt,
  repertoireStats,
  seededRandom,
} from '../../src/trainers/repertoire';
import { RepertoireStore, repertoireCardTarget } from '../../src/trainers/repertoire-store';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 26, 12);

/** Plays SAN moves into a tree from the start, returning the last node. */
function play(tree: GameTree, ...sans: string[]) {
  let id = tree.root.id;
  for (const san of sans) id = addRepertoireMove(tree, id, san).node.id;
  return tree.getNode(id)!;
}

/** A White repertoire: the Ruy Lopez and the Italian, each with the replies it expects. */
function whiteTree(): GameTree {
  const tree = newRepertoireTree('w');
  play(tree, 'e4', 'e5', 'Nf3', 'Nc6', 'Bb5');
  play(tree, 'e4', 'e5', 'Nf3', 'Nc6', 'Bc4');
  play(tree, 'e4', 'c5', 'Nf3');
  return tree;
}

describe('Phase 7 — repertoire tree building', () => {
  it('starts empty, as a PGN file for its colour', () => {
    const tree = newRepertoireTree('b');
    expect(tree.root.fen).toBe(DEFAULT_POSITION);
    expect(tree.root.children).toHaveLength(0);
    expect(tree.getHeaders().Event).toBe('Black repertoire');
    expect(writePgn(tree)).toContain('[Event "Black repertoire"]');
  });

  it('adds moves and reuses a move that is already there, so a line played twice adds nothing', () => {
    const tree = newRepertoireTree('w');
    const first = addRepertoireMove(tree, tree.root.id, 'e4');
    expect(first.created).toBe(true);
    const again = addRepertoireMove(tree, tree.root.id, { from: 'e2', to: 'e4' });
    expect(again.created).toBe(false);
    expect(again.node.id).toBe(first.node.id);
    // UCI works too
    expect(addRepertoireMove(tree, first.node.id, 'e7e5').node.san).toBe('e5');
    expect(allMoveNodes(tree)).toHaveLength(2);
  });

  it('keeps alternatives as variations: the first move added is the main one', () => {
    const tree = newRepertoireTree('w');
    play(tree, 'e4', 'e5');
    play(tree, 'd4');
    expect(tree.root.children.map((c) => c.san)).toEqual(['e4', 'd4']);
    expect(() => addRepertoireMove(tree, tree.root.id, 'e5')).toThrow();
  });

  it('deletes a move with everything after it, and never the start position', () => {
    const tree = whiteTree();
    const c5 = tree.root.children[0]!.children[1]!;
    expect(c5.san).toBe('c5');
    expect(deleteRepertoireMove(tree, c5.id)).toBe(true);
    expect(tree.root.children[0]!.children.map((c) => c.san)).toEqual(['e5']);
    expect(tree.getNode(c5.id)).toBeUndefined();
    expect(deleteRepertoireMove(tree, tree.root.id)).toBe(false);
  });

  it('indexes the positions where I have a move: my turn, with a move prepared', () => {
    const white = indexRepertoire(whiteTree(), 'w');
    // Start, after 1.e4 e5, after 1.e4 e5 2.Nf3 Nc6, after 1.e4 c5: White to move in each
    expect(white.myKeys).toHaveLength(4);
    expect(white.myKeys[0]).toBe(positionKey(DEFAULT_POSITION));
    expect(repertoireStats(white)).toEqual({ moves: 8, lines: 3, myPositions: 4 });

    // The same tree read as a Black repertoire: Black's positions are the ones after White moved
    const black = indexRepertoire(whiteTree(), 'b');
    // after 1.e4 (…e5 or …c5) and after 1.e4 e5 2.Nf3 (…Nc6)
    expect(black.myKeys).toHaveLength(2);
  });

  it('shares a position between move orders (a transposition has one key)', () => {
    const tree = newRepertoireTree('w');
    play(tree, 'd4', 'Nf6', 'c4', 'e6', 'Nc3');
    play(tree, 'd4', 'e6', 'c4', 'Nf6');
    const index = indexRepertoire(tree, 'w');
    const after = positionKey(tree.getMainLine()[3]!.fen);
    expect(index.nodesByKey.get(after)).toHaveLength(2);
    // The second order inherits the first order's continuation
    const second = tree.root.children[0]!.children[1]!.children[0]!.children[0]!;
    expect(second.san).toBe('Nf6');
    expect(repertoireMovesAt(index, second.fen).map((n) => n.san)).toEqual(['Nc3']);
    // Still one card per position
    expect(new Set(index.myKeys).size).toBe(index.myKeys.length);
  });

  it('survives storage: a tree comes back from its serialized form with the same index', () => {
    const tree = whiteTree();
    const back = GameTree.fromJSON(JSON.parse(JSON.stringify(tree.toJSON())));
    expect(indexRepertoire(back, 'w').myKeys).toEqual(indexRepertoire(tree, 'w').myKeys);
    expect(writePgn(back)).toBe(writePgn(tree));
  });
});

describe('Phase 7 — importing a PGN into a repertoire', () => {
  const PGN = `[Event "Ruy Lopez"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 { The Ruy Lopez. } (3. Bc4 Bc5 4. c3) 3... a6 4. Ba4 *

[Event "Sicilian"]
[Result "*"]

1. e4 c5 2. Nf3 d6 *`;

  it('merges every game, main line and variations, with comments', () => {
    const tree = newRepertoireTree('w');
    const result = importRepertoirePgn(tree, PGN);
    expect(result).toMatchObject({ games: 2, imported: 2, skipped: [] });
    // e4 e5 Nf3 Nc6 Bb5 a6 Ba4 (7) + Bc4 Bc5 c3 (3) + c5 Nf3 d6 (3) = 13
    expect(result.added).toBe(13);
    expect(allMoveNodes(tree)).toHaveLength(13);
    const bb5 = tree.root.children[0]!.children[0]!.children[0]!.children[0]!.children[0]!;
    expect(bb5.san).toBe('Bb5');
    expect(bb5.comment).toContain('The Ruy Lopez.');
    expect(bb5.children.length).toBe(1);
    expect(bb5.parentId).not.toBeNull();
    // Variation: Bc4 beside Bb5
    const nc6 = tree.getNode(bb5.parentId!)!;
    expect(nc6.children.map((c) => c.san)).toEqual(['Bb5', 'Bc4']);
  });

  it('importing the same text again adds nothing', () => {
    const tree = newRepertoireTree('w');
    importRepertoirePgn(tree, PGN);
    const again = importRepertoirePgn(tree, PGN);
    expect(again).toMatchObject({ games: 2, imported: 2, added: 0 });
    expect(allMoveNodes(tree)).toHaveLength(13);
  });

  it('overlapping lines share their moves', () => {
    const tree = newRepertoireTree('b');
    importRepertoirePgn(tree, '1. e4 e5 2. Nf3 Nc6 *');
    const result = importRepertoirePgn(tree, '1. e4 e5 2. Nf3 Nf6 3. Nxe5 *');
    expect(result.added).toBe(2); // ...Nf6 and 3.Nxe5; the first moves were already there
  });

  it('leaves out games that cannot be a repertoire and still imports the others', () => {
    const tree = newRepertoireTree('w');
    const text = `[Event "Endgame"]
[SetUp "1"]
[FEN "4k3/8/4K3/4P3/8/8/8/8 w - - 0 1"]

1. Kd6 *

[Event "960"]
[Variant "Chess960"]
[SetUp "1"]
[FEN "bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1"]

1. g3 *

[Event "Good"]

1. d4 d5 *`;
    const result = importRepertoirePgn(tree, text);
    expect(result.games).toBe(3);
    expect(result.imported).toBe(1);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]).toContain('Game 1');
    expect(result.skipped[0]).toContain('custom position');
    expect(result.skipped[1]).toContain('Chess960');
    expect(tree.root.children.map((c) => c.san)).toEqual(['d4']);
  });

  it('reports an empty text and a game without moves', () => {
    const tree = newRepertoireTree('w');
    expect(importRepertoirePgn(tree, '   ').skipped).toEqual(['The text is empty.']);
    const none = importRepertoirePgn(tree, '[Event "x"]\n\n*');
    expect(none.imported).toBe(0);
    expect(none.skipped[0]).toContain('no moves');
  });

  it('a repertoire written out as PGN imports back to the same tree', () => {
    const tree = whiteTree();
    const copy = newRepertoireTree('w');
    importRepertoirePgn(copy, writePgn(tree));
    expect(indexRepertoire(copy, 'w').myKeys).toEqual(indexRepertoire(tree, 'w').myKeys);
    expect(allMoveNodes(copy)).toHaveLength(allMoveNodes(tree).length);
  });
});

describe('Phase 7 — drilling a repertoire', () => {
  function drillOf(due: string[], seed = 1, target?: string) {
    const index = indexRepertoire(whiteTree(), 'w');
    return { index, drill: new RepertoireDrill(index, new Set(due), seededRandom(seed), target) };
  }

  it('asks at every due position, plays the opponent, and ends where the tree ends', () => {
    const index = indexRepertoire(whiteTree(), 'w');
    const all = new Set(index.myKeys);
    const drill = new RepertoireDrill(index, all, seededRandom(3));
    expect(drill.asking).toBe(true);
    expect(drill.expected().map((n) => n.san)).toEqual(['e4']);
    expect(drill.answer('e2e4').kind).toBe('correct');
    expect(drill.myTurn).toBe(false);
    const reply = drill.advance()!;
    expect(['e5', 'c5']).toContain(reply.san);
    const asked: string[] = [];
    while (!drill.done) {
      if (drill.asking) {
        asked.push(drill.expected()[0]!.san);
        drill.answer(drill.expected()[0]!.uci);
      } else drill.advance();
    }
    // Whichever branch the opponent chose, the walk ended at a leaf
    expect(drill.current.children).toHaveLength(0);
    expect(asked.length).toBeGreaterThan(0);
  });

  it('a wrong move is reported with the moves the repertoire has, and the position stays', () => {
    const { drill } = drillOf(indexRepertoire(whiteTree(), 'w').myKeys);
    const wrong = drill.answer('d2d4');
    expect(wrong.kind).toBe('wrong');
    if (wrong.kind === 'wrong') expect(wrong.expected.map((n) => n.san)).toEqual(['e4']);
    expect(drill.current.id).toBe(drill.path[0]!.id);
    expect(drill.asking).toBe(true);
  });

  it('plays my moves where nothing is due and heads for the due position', () => {
    const index = indexRepertoire(whiteTree(), 'w');
    // Only the position after 1.e4 e5 2.Nf3 Nc6 (White chooses Bb5 or Bc4) is due
    const deep = positionKey(
      index.tree.root.children[0]!.children[0]!.children[0]!.children[0]!.fen,
    );
    const drill = new RepertoireDrill(index, new Set([deep]), seededRandom(5));
    expect(drill.asking).toBe(false);
    const played: string[] = [];
    while (!drill.asking && !drill.done) played.push(drill.advance()!.san);
    expect(played).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(drill.asking).toBe(true);
    expect(drill.key).toBe(deep);
    // Either of my two prepared moves is right, and the drill follows the one I played
    expect(drill.expected().map((n) => n.san)).toEqual(['Bb5', 'Bc4']);
    const ans = drill.answer('f1c4');
    expect(ans.kind).toBe('correct');
    expect(drill.current.san).toBe('Bc4');
    expect(drill.done).toBe(true);
  });

  it('reveals the first prepared move when the player gives up on a position', () => {
    const { drill } = drillOf(indexRepertoire(whiteTree(), 'w').myKeys);
    expect(drill.reveal().san).toBe('e4');
  });

  it('knows when nothing is due', () => {
    const index = indexRepertoire(whiteTree(), 'w');
    expect(RepertoireDrill.hasWork(index, new Set())).toBe(false);
    expect(RepertoireDrill.hasWork(index, new Set(index.myKeys))).toBe(true);
    // A key that isn't one of my positions is not work
    expect(RepertoireDrill.hasWork(index, new Set(['8/8/8/8/8/8/8/8 w - -']))).toBe(false);
  });
});

describe('Phase 7 — finding where a game leaves the repertoire', () => {
  const white = () => indexRepertoire(whiteTree(), 'w');
  const game = (moves: string) => parsePgn(`[White "Me"]\n[Black "Them"]\n\n${moves} *`);

  it('I left it: the move I played and the moves the repertoire has', () => {
    const d = findDeparture(white(), game('1. e4 e5 2. Nf3 Nc6 3. d4'))!;
    expect(d).toMatchObject({ kind: 'left', ply: 5, moveLabel: '3.d4', san: 'd4', mover: 'w', followed: 4 });
    expect(d.expected).toEqual(['Bb5', 'Bc4']);
    expect(describeDeparture(d, 'w')).toBe('You left your White repertoire at 3.d4. Your repertoire plays Bb5 or Bc4 there.');
  });

  it('left on my first move', () => {
    const d = findDeparture(white(), game('1. d4 d5'))!;
    expect(d).toMatchObject({ kind: 'left', ply: 1, followed: 0 });
    expect(d.expected).toEqual(['e4']);
  });

  it('the opponent left: a move the repertoire has no reply to', () => {
    const d = findDeparture(white(), game('1. e4 d5 2. exd5'))!;
    expect(d).toMatchObject({ kind: 'opponent-left', ply: 2, moveLabel: '1...d5', mover: 'b', followed: 1 });
    expect(d.expected).toEqual(['e5', 'c5']);
    expect(describeDeparture(d, 'w')).toContain('Your opponent left your White repertoire at 1...d5');
  });

  it('the line ended: the game followed the repertoire to its end and went on', () => {
    const d = findDeparture(white(), game('1. e4 c5 2. Nf3 d6 3. d4'))!;
    expect(d).toMatchObject({ kind: 'ended', followed: 3 });
    expect(describeDeparture(d, 'w')).toContain('followed your White repertoire to the end of the line (3 moves)');
  });

  it('the game ended inside the repertoire', () => {
    const d = findDeparture(white(), game('1. e4 e5 2. Nf3 Nc6'))!;
    expect(d).toMatchObject({ kind: 'followed', followed: 4 });
    expect(describeDeparture(d, 'w')).toBe('The whole game stayed inside your White repertoire.');
  });

  it('a transposition stays inside the repertoire', () => {
    const tree = newRepertoireTree('b');
    play(tree, 'd4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4');
    const index = indexRepertoire(tree, 'b');
    // 1.d4 e6 2.c4 Nf6 is another move order into the same position. ...e6 isn't prepared against 1.d4
    // yet, so the game leaves at move 1; once the repertoire holds both orders the whole game follows it
    // (the position after 2...Nf6 has 3.Nc3 whichever way it was reached) up to the end of the line
    expect(findDeparture(index, game('1. d4 e6 2. c4 Nf6 3. Nc3 Bb4'))).toMatchObject({ kind: 'left', moveLabel: '1...e6' });
    play(tree, 'd4', 'e6', 'c4', 'Nf6');
    const both = indexRepertoire(tree, 'b');
    expect(findDeparture(both, game('1. d4 e6 2. c4 Nf6 3. Nc3 Bb4'))).toMatchObject({ kind: 'ended', followed: 6 });
    expect(findDeparture(both, game('1. d4 e6 2. c4 Nf6 3. Nc3 Bb4 4. e3'))).toMatchObject({ kind: 'ended', followed: 6 });
    expect(findDeparture(both, game('1. d4 e6 2. c4 Nf6 3. Nf3'))).toMatchObject({ kind: 'opponent-left', moveLabel: '3.Nf3' });
  });

  it('has nothing to say for an empty repertoire or a game from another start position', () => {
    expect(findDeparture(indexRepertoire(newRepertoireTree('w'), 'w'), game('1. e4 e5'))).toBeNull();
    const custom = parsePgn('[SetUp "1"]\n[FEN "4k3/8/4K3/4P3/8/8/8/8 w - - 0 1"]\n\n1. Kd6 *');
    expect(findDeparture(white(), custom)).toBeNull();
    expect(findDeparture(white(), new GameTree())).toBeNull();
  });
});

describe('Phase 7 — the repertoire store', () => {
  const DB = 'wizards-chess-repertoire-test';
  let storage: WizardChessStorage;

  beforeEach(async () => {
    await deleteWizardChessDB(DB);
    storage = await WizardChessStorage.create({ dbName: DB });
  });

  it('stores a repertoire with a new card for each of my positions, and brings them back', async () => {
    const store = new RepertoireStore(storage);
    let changes = 0;
    store.onChange(() => changes++);
    const empty = await store.load('w');
    expect(empty.tree.root.children).toHaveLength(0);
    expect((await store.due('w', NOW)).total).toBe(0);

    const index = await store.save('w', whiteTree(), NOW);
    expect(index.myKeys).toHaveLength(4);
    expect(changes).toBe(1);
    const due = await store.due('w', NOW);
    expect(due).toMatchObject({ reviews: 0, fresh: 4, total: 4 });
    expect(due.ordered).toEqual(index.myKeys);
    // The Black repertoire is separate
    expect((await store.due('b', NOW)).total).toBe(0);

    const record = await store.getRecord('w');
    expect(record).toMatchObject({ id: 'repertoire-w', name: 'White repertoire', color: 'w' });
    expect(record!.pgn).toContain('[Event "White repertoire"]');
    expect(record!.pgn).toContain('Bb5');

    // A fresh store (a new page load) reads the same tree
    const again = new RepertoireStore(storage);
    expect((await again.load('w')).myKeys).toEqual(index.myKeys);
  });

  it('cards follow the tree: new positions get cards, deleted ones lose them, graded ones keep theirs', async () => {
    const store = new RepertoireStore(storage);
    const tree = whiteTree();
    const index = await store.save('w', tree, NOW);
    const graded = index.myKeys[0]!;
    await store.grade('w', graded, 3, NOW);

    // Add a line (a new position of mine), delete another
    play(tree, 'e4', 'e6', 'd4');
    const c5 = tree.root.children[0]!.children.find((c) => c.san === 'c5')!;
    deleteRepertoireMove(tree, c5.id);
    const next = await store.save('w', tree, NOW + 1000);
    const cards = await store.cards('w');
    expect(cards.map((c) => c.targetId).sort()).toEqual(next.myKeys.map((k) => repertoireCardTarget('w', k)).sort());
    expect(cards.some((c) => c.targetId === repertoireCardTarget('w', graded) && c.state === 'review')).toBe(true);
  });

  it('grades with the same FSRS schedule as puzzles: Again comes back in ten minutes, Good in days', async () => {
    const store = new RepertoireStore(storage);
    const index = await store.save('w', whiteTree(), NOW);
    const [a, b] = index.myKeys;
    const again = await store.grade('w', a!, 1, NOW);
    expect(again.dueDate).toBe(NOW + RELEARN_DELAY_MS);
    const good = await store.grade('w', b!, 3, NOW);
    expect(good.state).toBe('review');
    expect(good.dueDate).toBeGreaterThanOrEqual(NOW + DAY);

    const due = await store.due('w', NOW + 11 * 60 * 1000);
    // The failed one is due again; the Good one isn't; two are still new
    expect(due.reviews).toBe(1);
    expect(due.fresh).toBe(2);
    expect(due.ordered[0]).toBe(a);
    expect(due.nextDueAt).toBe(good.dueDate);
  });

  it('reload() drops what was read, for after a restore from a backup', async () => {
    const store = new RepertoireStore(storage);
    await store.save('w', whiteTree(), NOW);
    const other = new RepertoireStore(storage);
    const tree = whiteTree();
    play(tree, 'e4', 'e6', 'd4');
    await other.save('w', tree, NOW);
    expect((await store.load('w')).myKeys).toHaveLength(4);
    store.reload();
    expect((await store.load('w')).myKeys).toHaveLength(5);
  });
});
