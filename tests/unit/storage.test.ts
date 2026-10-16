import { beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import {
  LATEST_SCHEMA_VERSION,
  WizardChessStorage,
  deleteWizardChessDB,
} from '../../src/storage/db';
import { parsePgn, writePgn } from '../../src/core/pgn';

describe('Phase 1 — IndexedDB Storage & Versioned Schema Migrations', () => {
  const testDbName = 'wizards-chess-unit-test-db';

  beforeEach(async () => {
    await deleteWizardChessDB(testDbName);
  });

  it('upgrades step-by-step from v1 -> v2 -> v3 while preserving data and backfilling v3 fields', async () => {
    // 1. Open at Schema v1
    const v1Storage = await WizardChessStorage.create({
      dbName: testDbName,
      version: 1,
    });
    expect(v1Storage.version).toBe(1);
    expect(v1Storage.storeNames.sort()).toEqual([
      'games',
      'schema_meta',
      'settings',
    ]);
    expect(v1Storage.getIndexNames('games')).not.toContain('by-accuracy');

    // Insert a v1 game record and a setting
    await v1Storage.saveGame({
      id: 'game-v1-1',
      white: 'Morphy',
      black: 'Duke of Brunswick',
      playerColor: 'w',
      result: '1-0',
      date: '1858.11.02',
      openingEco: 'C41',
      openingName: 'Philidor Defense',
      accuracy: null,
      pgn: '1. e4 e5 2. Nf3 d6 1-0',
      tags: ['opera'],
    });
    await v1Storage.setSetting('boardTheme', 'cathedral-marble');
    v1Storage.close();

    // 2. Upgrade from v1 -> v2
    const v2Storage = await WizardChessStorage.create({
      dbName: testDbName,
      version: 2,
    });
    expect(v2Storage.version).toBe(2);
    expect(v2Storage.storeNames.sort()).toEqual([
      'games',
      'puzzles',
      'schema_meta',
      'settings',
      'srs_cards',
    ]);
    expect(v2Storage.getIndexNames('games')).toContain('by-accuracy');

    // Verify v1 game and setting survived v1 -> v2 migration
    const gameAtV2 = await v2Storage.getGame('game-v1-1');
    expect(gameAtV2?.white).toBe('Morphy');
    expect(await v2Storage.getSetting('boardTheme')).toBe('cathedral-marble');

    // Insert a puzzle and SRS card in v2
    await v2Storage.savePuzzle({
      id: 'puz-1',
      source: 'personal',
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
      moves: ['f1b5', 'a7a6'],
      rating: 1450,
      themes: ['pin'],
      dueDate: 1000,
      attempts: 1,
      solvedCount: 1,
      updatedAt: 1000,
    });
    v2Storage.close();

    // 3. Upgrade from v2 -> v3 (LATEST_SCHEMA_VERSION)
    const v3Storage = await WizardChessStorage.create({
      dbName: testDbName,
      version: LATEST_SCHEMA_VERSION,
    });
    expect(v3Storage.version).toBe(3);
    expect(await v3Storage.getSchemaVersion()).toBe(3);
    expect(v3Storage.storeNames.sort()).toEqual([
      'endgame_progress',
      'games',
      'puzzles',
      'repertoires',
      'schema_meta',
      'settings',
      'srs_cards',
    ]);

    // Verify migration history recorded all 3 steps (0->1, 1->2, 2->3)
    const history = await v3Storage.getMigrationHistory();
    expect(history.map((h) => h.toVersion)).toEqual([1, 2, 3]);

    // Verify v1 game record was backfilled to schemaVersion: 3
    const gameAtV3 = await v3Storage.getGame('game-v1-1');
    expect(gameAtV3?.schemaVersion).toBe(3);
    expect(gameAtV3?.openingEco).toBe('C41');

    // Verify v2 puzzle survived v2 -> v3
    const puzAtV3 = await v3Storage.getPuzzle('puz-1');
    expect(puzAtV3?.rating).toBe(1450);
    v3Storage.close();
  });

  it('supports CRUD, game filtering, due SRS card queries, and full JSON backup/restore', async () => {
    const storage = await WizardChessStorage.create({ dbName: testDbName });
    const tree = parsePgn('1. e4 c5 2. Nf3 d6 1-0');

    await storage.saveGame({
      id: 'g-sicilian',
      white: 'Hero',
      black: 'Bot',
      playerColor: 'w',
      result: '1-0',
      date: '2026.10.15',
      openingEco: 'B50',
      openingName: 'Sicilian Defense',
      accuracy: 92.4,
      pgn: writePgn(tree),
      tree: tree.toJSON(),
      tags: ['blitz'],
      updatedAt: 2000,
    });

    await storage.saveGame({
      id: 'g-french',
      white: 'Bot',
      black: 'Hero',
      playerColor: 'b',
      result: '0-1',
      date: '2026.10.16',
      openingEco: 'C00',
      openingName: 'French Defense',
      accuracy: 78.1,
      pgn: '1. e4 e6 0-1',
      tags: ['rapid'],
      updatedAt: 3000,
    });

    expect((await storage.listGames()).map((g) => g.id)).toEqual([
      'g-french',
      'g-sicilian',
    ]);
    expect(
      (await storage.listGames({ playerColor: 'w', minAccuracy: 90 })).map(
        (g) => g.id,
      ),
    ).toEqual(['g-sicilian']);

    await storage.saveSrsCard({
      id: 'card-due',
      deck: 'puzzle',
      targetId: 'puz-1',
      state: 'review',
      stability: 4.5,
      difficulty: 5.2,
      reps: 3,
      lapses: 0,
      dueDate: 5000,
      updatedAt: 4000,
    });
    await storage.saveSrsCard({
      id: 'card-future',
      deck: 'puzzle',
      targetId: 'puz-2',
      state: 'review',
      stability: 9.0,
      difficulty: 4.0,
      reps: 5,
      lapses: 0,
      dueDate: 99999,
      updatedAt: 4000,
    });

    const dueAt6000 = await storage.listDueSrsCards(6000, 'puzzle');
    expect(dueAt6000.map((c) => c.id)).toEqual(['card-due']);

    // Export JSON backup, wipe DB, and restore into a fresh DB
    const backupJson = await storage.exportBackupJson();
    storage.close();

    const restoredDbName = `${testDbName}-restored`;
    await deleteWizardChessDB(restoredDbName);
    const restoredStorage = await WizardChessStorage.create({
      dbName: restoredDbName,
    });
    const counts = await restoredStorage.importBackupJson(backupJson);
    expect(counts.gamesImported).toBe(2);
    expect(counts.srsCardsImported).toBe(2);

    const restoredGame = await restoredStorage.getGame('g-sicilian');
    expect(restoredGame?.accuracy).toBe(92.4);
    expect(restoredGame?.tree?.result).toBe('1-0');
    restoredStorage.close();
    await deleteWizardChessDB(restoredDbName);
  });
});
