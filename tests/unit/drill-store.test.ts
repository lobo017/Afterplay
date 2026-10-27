import { beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { WizardChessStorage, deleteWizardChessDB } from '../../src/storage/db';
import { DrillStore, summarizeCards } from '../../src/trainers/drill-store';
import { ENDGAMES, getEndgame } from '../../src/trainers/endgames';
import { RELEARN_DELAY_MS } from '../../src/trainers/fsrs';
import { COORDINATE_HISTORY_LIMIT } from '../../src/trainers/visualization-store';
import { addRepertoireMove, newRepertoireTree } from '../../src/trainers/repertoire';
import { PuzzleStore } from '../../src/trainers/puzzle-store';

const DB = 'wizards-chess-drills-test';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 26, 12);

let storage: WizardChessStorage;
let drills: DrillStore;

beforeEach(async () => {
  await deleteWizardChessDB(DB);
  storage = await WizardChessStorage.create({ dbName: DB });
  drills = new DrillStore(storage);
});

describe('Phase 7 — endgame progress', () => {
  const kq = getEndgame('kq-vs-k')!;
  const lucena = getEndgame('lucena-position')!;

  it('nothing is stored until the first drill: no card, no progress', async () => {
    expect((await drills.endgames.progress()).size).toBe(0);
    expect(await drills.endgames.listCards()).toEqual([]);
    expect(await drills.summary(NOW)).toMatchObject({ endgame: { due: 0, fresh: 0, total: 0 } });
  });

  it('records a mate drill: attempts, completions, fewest moves and the card', async () => {
    const first = await drills.endgames.record(kq, { reached: true, moves: 12, hintsUsed: 0 }, NOW);
    expect(first.progress).toMatchObject({
      id: 'kq-vs-k',
      category: 'K+Q v K',
      completed: 1,
      attempts: 1,
      completions: 1,
      bestMoves: 12,
      optimalMoves: 7,
      lastReached: true,
      lastMoves: 12,
    });
    expect(first.newBest).toBe(true);
    expect(first.grade).toBe(2); // 5 over the best count of 7
    expect(first.card).toMatchObject({ id: 'endgame:kq-vs-k', deck: 'endgame', targetId: 'kq-vs-k', state: 'review' });

    // A better count is a new best; a worse one keeps it
    const better = await drills.endgames.record(kq, { reached: true, moves: 8, hintsUsed: 0 }, NOW + 1000);
    expect(better.newBest).toBe(true);
    expect(better.progress.bestMoves).toBe(8);
    expect(better.grade).toBe(3);
    const worse = await drills.endgames.record(kq, { reached: true, moves: 20, hintsUsed: 0 }, NOW + 2000);
    expect(worse.newBest).toBe(false);
    expect(worse.progress).toMatchObject({ bestMoves: 8, attempts: 3, completions: 3, lastMoves: 20 });
  });

  it('a drill with a hint completes but is not a best; a miss counts an attempt only', async () => {
    const hinted = await drills.endgames.record(kq, { reached: true, moves: 7, hintsUsed: 2 }, NOW);
    expect(hinted.progress).toMatchObject({ completed: 1, completions: 1, bestMoves: null });
    expect(hinted.newBest).toBe(false);
    expect(hinted.grade).toBe(2);
    const miss = await drills.endgames.record(kq, { reached: false, moves: 30, hintsUsed: 0 }, NOW + 1000);
    expect(miss.progress).toMatchObject({
      completed: 1,
      attempts: 2,
      completions: 1,
      lastReached: false,
      lastMoves: null,
    });
    expect(miss.grade).toBe(1);
    expect(miss.card.dueDate).toBe(NOW + 1000 + RELEARN_DELAY_MS);
  });

  it('tracks only the result for positions without a forced mate: no move counts', async () => {
    const r = await drills.endgames.record(lucena, { reached: true, moves: 22, hintsUsed: 0 }, NOW);
    expect(r.progress).toMatchObject({ completed: 1, bestMoves: null, optimalMoves: null, lastMoves: null });
    expect(r.newBest).toBe(false);
    expect(r.grade).toBe(3);
    const missed = await drills.endgames.record(lucena, { reached: false, moves: 9, hintsUsed: 0 }, NOW + 1);
    expect(missed.progress.completed).toBe(1); // ever completed
    expect(missed.progress.lastReached).toBe(false);
  });

  it('a first miss leaves the position uncompleted', async () => {
    const r = await drills.endgames.record(kq, { reached: false, moves: 3, hintsUsed: 0 }, NOW);
    expect(r.progress).toMatchObject({ completed: 0, completions: 0, attempts: 1 });
  });

  it('keeps the progress read from records written before completions were counted', async () => {
    await storage.saveEndgameProgress({
      id: 'kq-vs-k',
      category: 'K+Q v K',
      completed: 1,
      attempts: 2,
      bestMoves: 9,
      optimalMoves: 10,
      updatedAt: NOW - DAY,
    });
    const r = await drills.endgames.record(kq, { reached: true, moves: 9, hintsUsed: 0 }, NOW);
    expect(r.progress).toMatchObject({ attempts: 3, completions: 2, bestMoves: 9, optimalMoves: 7 });
    expect(r.newBest).toBe(false);
  });

  it('every position can be recorded', async () => {
    for (const e of ENDGAMES) await drills.endgames.record(e, { reached: true, moves: 30, hintsUsed: 0 }, NOW);
    expect((await drills.endgames.progress()).size).toBe(6);
    expect((await drills.endgames.listCards()).length).toBe(6);
  });
});

describe('Phase 7 — visualization progress', () => {
  it('coordinates: rounds, the best score, a short history, and the card', async () => {
    const empty = await drills.visualization.coordinateStats();
    expect(empty).toEqual({ rounds: 0, best: 0, history: [] });
    const a = await drills.visualization.recordCoordinates({ correct: 22, wrong: 3 }, NOW);
    expect(a.newBest).toBe(true);
    expect(a.grade).toBe(3);
    expect(a.stats).toMatchObject({ rounds: 1, best: 22 });
    expect(a.card).toMatchObject({ id: 'visualization:coordinates', deck: 'visualization', targetId: 'coordinates' });
    const b = await drills.visualization.recordCoordinates({ correct: 15, wrong: 9 }, NOW + 1);
    expect(b.newBest).toBe(false);
    expect(b.stats).toMatchObject({ rounds: 2, best: 22 });
    expect(b.stats.history.map((h) => h.correct)).toEqual([22, 15]);
    for (let i = 0; i < COORDINATE_HISTORY_LIMIT + 5; i++)
      await drills.visualization.recordCoordinates({ correct: i, wrong: 0 }, NOW + 2 + i);
    expect((await drills.visualization.coordinateStats()).history).toHaveLength(COORDINATE_HISTORY_LIMIT);
  });

  it('blindfold: the level follows the results', async () => {
    expect(await drills.visualization.blindfoldStats()).toEqual({ level: 8, drills: 0, bestLevel: 0 });
    const perfect = await drills.visualization.recordBlindfold({ plies: 8, correct: 5, total: 5 }, NOW);
    expect(perfect.stats).toEqual({ level: 10, drills: 1, bestLevel: 8 });
    expect(perfect.grade).toBe(3);
    const bad = await drills.visualization.recordBlindfold({ plies: 10, correct: 2, total: 5 }, NOW + 1);
    expect(bad.stats).toEqual({ level: 8, drills: 2, bestLevel: 8 });
    expect(bad.grade).toBe(1);
    expect(bad.card.id).toBe('visualization:blindfold');
  });

  it('guess the move: a score and a card for each game', async () => {
    const a = await drills.visualization.recordGuess('lichess:abc', { hits: 8, total: 10 }, NOW);
    expect(a.grade).toBe(3);
    expect(a.card).toMatchObject({ id: 'visualization:guess:lichess:abc', targetId: 'guess:lichess:abc' });
    await drills.visualization.recordGuess('paste:def', { hits: 1, total: 10 }, NOW + 1);
    const stats = await drills.visualization.guessStats();
    expect(stats['lichess:abc']).toEqual({ hits: 8, total: 10, at: NOW });
    expect(stats['paste:def']).toMatchObject({ hits: 1 });
    expect((await drills.visualization.listCards()).map((c) => c.id).sort()).toEqual([
      'visualization:guess:lichess:abc',
      'visualization:guess:paste:def',
    ]);
  });
});

describe('Phase 7 — what is due, across the trainers', () => {
  it('counts due, new and waiting cards of each deck', async () => {
    // Repertoire: two positions of mine, never answered
    const tree = newRepertoireTree('w');
    const e4 = addRepertoireMove(tree, tree.root.id, 'e4').node;
    const e5 = addRepertoireMove(tree, e4.id, 'e5').node;
    addRepertoireMove(tree, e5.id, 'Nf3');
    await drills.repertoire.save('w', tree, NOW);
    // Endgames: one failed (back in ten minutes), one passed (days away)
    await drills.endgames.record(getEndgame('kq-vs-k')!, { reached: false, moves: 5, hintsUsed: 0 }, NOW);
    await drills.endgames.record(getEndgame('kr-vs-k')!, { reached: true, moves: 14, hintsUsed: 0 }, NOW);
    // Visualization: a coordinate round
    await drills.visualization.recordCoordinates({ correct: 12, wrong: 3 }, NOW);

    let s = await drills.summary(NOW);
    expect(s.repertoire).toEqual({ due: 0, fresh: 2, total: 2 });
    expect(s.endgame).toEqual({ due: 0, fresh: 0, total: 2 });
    expect(s.visualization).toEqual({ due: 0, fresh: 0, total: 1 });
    expect(s.nextDueAt).toBe(NOW + RELEARN_DELAY_MS);

    s = await drills.summary(NOW + 11 * 60 * 1000);
    expect(s.endgame).toEqual({ due: 1, fresh: 0, total: 2 });
    expect(s.nextDueAt).not.toBeNull();

    s = await drills.summary(NOW + 400 * DAY);
    expect(s).toMatchObject({
      endgame: { due: 2 },
      visualization: { due: 1 },
      repertoire: { due: 0, fresh: 2 },
      nextDueAt: null,
    });
  });

  it('summarizeCards on its own', () => {
    const card = (state: 'new' | 'review', due: number) => ({
      id: `x${due}${state}`,
      deck: 'endgame' as const,
      targetId: 'x',
      state,
      stability: 1,
      difficulty: 1,
      reps: 1,
      lapses: 0,
      dueDate: due,
      updatedAt: 0,
    });
    expect(summarizeCards([card('new', 0), card('review', 5), card('review', 50)], 10)).toEqual({
      deck: { due: 1, fresh: 1, total: 3 },
      nextDueAt: 50,
    });
    expect(summarizeCards([], 0)).toEqual({ deck: { due: 0, fresh: 0, total: 0 }, nextDueAt: null });
  });

  it('tells its listeners when a trainer records or a repertoire changes', async () => {
    let n = 0;
    drills.onChange(() => n++);
    await drills.endgames.record(getEndgame('kq-vs-k')!, { reached: true, moves: 7, hintsUsed: 0 }, NOW);
    await drills.visualization.recordCoordinates({ correct: 1, wrong: 0 }, NOW);
    await drills.repertoire.save('b', newRepertoireTree('b'), NOW);
    expect(n).toBe(3);
  });

  it('does not touch the puzzle deck: puzzle counts ignore the new decks', async () => {
    await drills.endgames.record(getEndgame('kq-vs-k')!, { reached: false, moves: 1, hintsUsed: 0 }, NOW);
    await drills.visualization.recordCoordinates({ correct: 1, wrong: 0 }, NOW);
    const puzzles = new PuzzleStore(storage);
    const today = await puzzles.todaySummary(NOW + DAY);
    expect(today.dueReviews).toEqual({ personal: 0, lichess: 0 });
    expect(today.newPersonal).toBe(0);
    expect(await puzzles.dueQueue(NOW + DAY)).toEqual({ reviews: [], fresh: [] });
  });
});

describe('Phase 7 — backup and restore carry the new data', () => {
  it('a JSON backup includes repertoires, endgame progress, drill cards and visualization stats', async () => {
    const tree = newRepertoireTree('w');
    addRepertoireMove(tree, tree.root.id, 'e4');
    await drills.repertoire.save('w', tree, NOW);
    await drills.endgames.record(getEndgame('kq-vs-k')!, { reached: true, moves: 9, hintsUsed: 0 }, NOW);
    await drills.visualization.recordCoordinates({ correct: 30, wrong: 2 }, NOW);
    const json = await storage.exportBackupJson();

    await deleteWizardChessDB(`${DB}-restored`);
    const other = await WizardChessStorage.create({ dbName: `${DB}-restored` });
    const result = await other.importBackupJson(json);
    expect(result).toMatchObject({ repertoiresImported: 1, endgameProgressImported: 1 });
    expect(result.srsCardsImported).toBe(3); // the repertoire position, the endgame, the coordinates
    const restored = new DrillStore(other);
    expect((await restored.repertoire.load('w')).myKeys).toHaveLength(1);
    expect((await restored.endgames.progress()).get('kq-vs-k')).toMatchObject({ bestMoves: 9, optimalMoves: 7 });
    expect((await restored.visualization.coordinateStats()).best).toBe(30);
    expect(await restored.summary(NOW + 100 * DAY)).toMatchObject({
      repertoire: { fresh: 1 },
      endgame: { due: 1 },
      visualization: { due: 1 },
    });
    other.close();
    await deleteWizardChessDB(`${DB}-restored`);
  });
});
