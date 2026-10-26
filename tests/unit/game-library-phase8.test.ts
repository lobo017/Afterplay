import { beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { buildGameRecord, myColor } from '../../src/library/game-record';
import { NO_FILTER, activeFilters, gameAccuracy, gameDay, matchesFilter, openingChoices, sortRows, toRow } from '../../src/library/game-rows';
import { GameLibrary } from '../../src/library/library';
import { readPgnBatches } from '../../src/library/pgn-import-core';
import { checkPgnText } from '../../src/capture/pgn-games';
import { WizardChessStorage, deleteWizardChessDB, type StoredGameRecord } from '../../src/storage/db';

const DB = 'wizards-chess-phase8-library-test';

const game = (white: string, black: string, result: string, date: string, moves: string) =>
  `[Event "T"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n[Date "${date}"]\n\n${moves} ${result}`;

const SICILIAN = '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6';
const SCHOLAR = '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#';
const ACCOUNTS = [{ site: 'lichess' as const, username: 'Me' }];

function record(pgn: string, patch: Partial<StoredGameRecord> = {}): StoredGameRecord {
  const valid = checkPgnText(pgn).games[0]!;
  return { ...buildGameRecord(valid), schemaVersion: 4, createdAt: 1, updatedAt: 1, ...patch };
}

beforeEach(async () => {
  await deleteWizardChessDB(DB);
});

describe('Phase 8 — library filters', () => {
  const rows = () => [
    toRow(record(game('Me', 'Bob', '1-0', '2026.01.02', SICILIAN), { source: 'paste', analysis: { preset: 'quick', savedAt: 1, whiteAccuracy: 90, blackAccuracy: 70 } }), ACCOUNTS),
    toRow(record(game('Al', 'Me', '1-0', '2026.02.10', SCHOLAR), { source: 'paste' }), ACCOUNTS),
    toRow(record(game('X', 'Y', '1/2-1/2', '2026.03.05', SICILIAN), { source: 'paste', analysis: { preset: 'quick', savedAt: 1, whiteAccuracy: 80, blackAccuracy: 60 } }), ACCOUNTS),
  ];

  it('filters by result, colour, opening, date and accuracy', () => {
    const r = rows();
    const count = (f: Partial<typeof NO_FILTER>) => r.filter((x) => matchesFilter(x, { ...NO_FILTER, ...f })).length;
    expect(count({})).toBe(3);
    expect(count({ result: 'win' })).toBe(1);
    expect(count({ result: 'loss' })).toBe(1);
    expect(count({ result: 'draw' })).toBe(1);
    expect(count({ color: 'w' })).toBe(1);
    expect(count({ color: 'b' })).toBe(1);
    expect(count({ opening: 'sicilian' })).toBe(2);
    expect(count({ from: '2026-02-01' })).toBe(2);
    expect(count({ from: '2026-02-01', to: '2026-02-28' })).toBe(1);
    expect(count({ minAccuracy: 85 })).toBe(1);
    expect(count({ minAccuracy: 65 })).toBe(2);
    expect(count({ minAccuracy: 0 })).toBe(2); // an unanalyzed game has no accuracy
    expect(count({ color: 'w', opening: 'sicilian' })).toBe(1);
  });

  it('counts the filters that are set and offers the openings that occur', () => {
    expect(activeFilters(NO_FILTER)).toBe(0);
    expect(activeFilters({ ...NO_FILTER, from: '2026-01-01', to: '2026-02-01', result: 'win', minAccuracy: 50 })).toBe(3);
    expect(openingChoices(rows().map((x) => x.record))[0]).toMatch(/Sicilian/);
  });

  it('knows the day and the accuracy of a game, and sorts by accuracy', () => {
    const r = rows();
    expect(gameDay(r[0]!.record)).toBe('2026-01-02');
    expect(gameAccuracy(r[0]!)).toBe(90); // mine (White)
    expect(gameAccuracy(r[2]!)).toBe(70); // not mine: both sides' mean
    expect(gameAccuracy(r[1]!)).toBeNull();
    expect(sortRows([...r], 'accuracy').map((x) => x.record.white)).toEqual(['Me', 'X', 'Al']);
  });

  it('a game played here is mine on the side I chose', () => {
    expect(myColor({ white: 'You', black: 'Stockfish Club', source: 'play', playerColor: 'b' }, ACCOUNTS)).toBe('b');
  });
});

describe('Phase 8 — bulk import and played games', () => {
  it('reads a big text in groups, with duplicates and numbered errors', () => {
    const games: string[] = [];
    for (let i = 0; i < 60; i++) games.push(game(`P${i}`, 'Q', '1-0', '2026.01.01', i % 2 ? SICILIAN : SCHOLAR));
    games.splice(10, 0, '[Event "Bad"]\n\n1. e4 e5 2. Ke4 *');
    const text = games.join('\n\n');
    const batches = [...readPgnBatches(text, new Set())];
    expect(batches.length).toBe(3); // 61 games, 25 a group
    expect(batches[batches.length - 1]!.gamesRead).toBe(61);
    const keys = batches.flatMap((b) => b.records.map((r) => r.id));
    const errors = batches.flatMap((b) => b.errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Game 11:/);
    // Keys depend on players, date and moves: the same game text twice is one record
    expect(new Set(keys).size).toBe(keys.length);
    const again = [...readPgnBatches(text, new Set(keys))];
    expect(again.flatMap((b) => b.duplicates).length).toBe(keys.length);
    expect(again.flatMap((b) => b.records)).toHaveLength(0);
  });

  it('imports through the library, skips known games and reports progress', async () => {
    const storage = await WizardChessStorage.create({ dbName: DB });
    const library = new GameLibrary(storage);
    const text = Array.from({ length: 30 }, (_, i) => game(`P${i}`, 'Q', '1-0', '2026.01.01', SCHOLAR)).join('\n\n');
    const progress: number[] = [];
    const first = await library.importPgnText(text, (p) => progress.push(p.done));
    expect(first.saved).toHaveLength(30);
    expect(progress.at(-1)).toBe(30);
    const second = await library.importPgnText(text);
    expect(second.saved).toHaveLength(0);
    expect(second.duplicates).toHaveLength(30);
    expect((await library.list()).length).toBe(30);
    storage.close();
  });

  it('keeps a game played here once; finishing it again replaces it and drops its review', async () => {
    const storage = await WizardChessStorage.create({ dbName: DB });
    const library = new GameLibrary(storage);
    const pgn = (moves: string, result: string) => `[White "You"]\n[Black "Stockfish Club"]\n[Result "${result}"]\n[Date "2026.10.20"]\n\n${moves} ${result}`;
    const id = await library.savePlayedGame({ startedAt: 1_000_000, pgn: pgn(SCHOLAR, '1-0'), playerColor: 'w' });
    expect(id).toBe('play:1000000');
    expect(await library.get(id!)).toMatchObject({ source: 'play', playerColor: 'w', white: 'You' });
    await storage.saveReview(id!, {} as never);
    await library.savePlayedGame({ startedAt: 1_000_000, pgn: pgn('1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#', '1-0'), playerColor: 'w' });
    expect((await library.list()).length).toBe(1);
    expect(await library.getReview(id!)).toBeUndefined();
    await library.deleteGames([id!]);
    expect(await library.get('play:1000000')).toBeUndefined();
    storage.close();
  });

  it('announces account changes once', async () => {
    const storage = await WizardChessStorage.create({ dbName: DB });
    const library = new GameLibrary(storage);
    let n = 0;
    library.onAccountsChange(() => n++);
    await library.setMyAccounts({ lichess: 'A', chesscom: '' });
    await library.setMyAccounts({ lichess: 'A', chesscom: '' });
    expect(n).toBe(1);
    storage.close();
  });
});
