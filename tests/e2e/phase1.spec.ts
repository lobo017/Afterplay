import path from 'node:path';
import { expect, test } from '@playwright/test';

test.describe('Phase 1 — Core Rules, GameTree, PGN Round-Trip & Browser IndexedDB Migrations', () => {
  test('verifies adversarial PGN round-trip, Chess960 rules, GameTree operations, and native Chromium IndexedDB v1->v2->v3->v4 migrations with zero network requests', async ({
    page,
  }) => {
    const externalRequests: string[] = [];
    const consoleErrors: string[] = [];

    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
        externalRequests.push(request.url());
      }
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    page.on('pageerror', (err) => {
      consoleErrors.push(err.message);
    });

    const response = await page.goto('/');
    expect(response?.status()).toBe(200);

    await expect(page.getByTestId('core-badge')).toContainText('Core Rules · PGN · IDB v4');
    await expect(page.getByTestId('stat-rules')).toContainText('Standard + Chess960');
    await expect(page.getByTestId('stat-pgn')).toContainText('RAVs · NAGs · [%eval/%cal/%csl]');
    await expect(page.getByTestId('stat-storage')).toContainText('IndexedDB Schema v4');

    if (process.env.SCREENSHOT_DIR) {
      await page.screenshot({
        path: path.join(process.env.SCREENSHOT_DIR, 'phase1-core.png'),
        fullPage: true,
      });
    }

    // Run end-to-end verification of RulesAdapter, GameTree, PGN round-trips, and real browser IndexedDB migrations
    const e2eResults = await page.evaluate(async () => {
      const core = window.__wizardChessCore;
      if (!core) {
        throw new Error('window.__wizardChessCore not initialized');
      }

      // 1. RulesAdapter & Chess960 FEN round-trip in browser
      const startRules = new core.RulesAdapter();
      const perft2 = startRules.perft(2);

      const c960Fen = '1r3kr1/pppppppp/8/8/8/8/PPPPPPPP/1R3KR1 w GBgb - 0 1';
      const c960Rules = new core.RulesAdapter(c960Fen);
      const c960RoundTripBefore = c960Rules.fen();
      const castleMove = c960Rules.move('O-O');
      c960Rules.undo();
      const c960RoundTripAfterUndo = c960Rules.fen();

      // 2. Adversarial PGN round-trip in browser
      const adversarialPgn = `
[Event "E2E Adversarial Round-Trip"]
[Site "Browser"]
[Date "2026.10.16"]
[Round "1"]
[White "WhitePlayer"]
[Black "BlackPlayer"]
[Result "1-0"]

{ Opening study }
1. { King's pawn } e4 $1 { [%eval +0.35,22] [%cal Ge2e4,Gd2d4] [%csl Ge4] Center control }
( { Queen's pawn } 1. d4 d5 ( 1... Nf6 2. c4 e6 ) 2. c4 )
1... e6 2. Ng1f3!! Nc6 3. Bb5 d5 4. e5 Nge7?! 5. 0-0 Bd7 1-0
`;
      const tree1 = core.parsePgn(adversarialPgn);
      const written1 = core.writePgn(tree1);
      const tree2 = core.parsePgn(written1);
      const written2 = core.writePgn(tree2);

      // 3. Real browser IndexedDB step-by-step migration (v1 -> v2 -> v3 -> v4)
      const dbName = 'wizards-chess-e2e-migration-test';
      await core.deleteWizardChessDB(dbName);

      const s1 = await core.WizardChessStorage.create({ dbName, version: 1 });
      const v1Stores = s1.storeNames.sort();
      await s1.saveGame({
        id: 'e2e-game-1',
        white: 'WhitePlayer',
        black: 'BlackPlayer',
        playerColor: 'w',
        result: '1-0',
        date: '2026.10.16',
        openingEco: 'C00',
        openingName: 'French Defense',
        accuracy: null,
        pgn: written1,
        tree: tree1.toJSON(),
        tags: ['e2e'],
      });
      s1.close();

      const s2 = await core.WizardChessStorage.create({ dbName, version: 2 });
      const v2Stores = s2.storeNames.sort();
      const v2HasAccuracyIdx = s2.getIndexNames('games').includes('by-accuracy');
      s2.close();

      const s3 = await core.WizardChessStorage.create({ dbName, version: 3 });
      const v3Stores = s3.storeNames.sort();
      const migratedGame = await s3.getGame('e2e-game-1');
      s3.close();

      const s4 = await core.WizardChessStorage.create({
        dbName,
        version: core.LATEST_SCHEMA_VERSION,
      });
      const v4Stores = s4.storeNames.sort();
      const gameAtV4 = await s4.getGame('e2e-game-1');
      const migrationHistory = await s4.getMigrationHistory();
      s4.close();
      await core.deleteWizardChessDB(dbName);

      return {
        perft2,
        c960RoundTripBefore,
        castleSan: castleMove.san,
        c960RoundTripAfterUndo,
        pgnIdempotent: written1 === written2,
        treeIdempotent:
          JSON.stringify(tree1.toJSON()) === JSON.stringify(tree2.toJSON()),
        mainLineSan: tree1.getMainLine().map((n) => n.san),
        v1Stores,
        v2Stores,
        v2HasAccuracyIdx,
        v3Stores,
        v4Stores,
        latestVersion: core.LATEST_SCHEMA_VERSION,
        gameAtV4White: gameAtV4?.white,
        migratedGameSchemaVersion: migratedGame?.schemaVersion,
        migrationVersions: migrationHistory.map((m) => m.toVersion),
      };
    });

    expect(e2eResults.perft2).toBe(400);
    expect(e2eResults.c960RoundTripBefore).toBe(
      '1r3kr1/pppppppp/8/8/8/8/PPPPPPPP/1R3KR1 w GBgb - 0 1',
    );
    expect(e2eResults.castleSan).toBe('O-O');
    expect(e2eResults.c960RoundTripAfterUndo).toBe(
      '1r3kr1/pppppppp/8/8/8/8/PPPPPPPP/1R3KR1 w GBgb - 0 1',
    );
    expect(e2eResults.pgnIdempotent).toBe(true);
    expect(e2eResults.treeIdempotent).toBe(true);
    expect(e2eResults.mainLineSan).toEqual([
      'e4',
      'e6',
      'Nf3',
      'Nc6',
      'Bb5',
      'd5',
      'e5',
      'Ne7',
      'O-O',
      'Bd7',
    ]);
    expect(e2eResults.v1Stores).toEqual(['games', 'schema_meta', 'settings']);
    expect(e2eResults.v2Stores).toEqual([
      'games',
      'puzzles',
      'schema_meta',
      'settings',
      'srs_cards',
    ]);
    expect(e2eResults.v2HasAccuracyIdx).toBe(true);
    expect(e2eResults.v3Stores).toEqual([
      'endgame_progress',
      'games',
      'puzzles',
      'repertoires',
      'schema_meta',
      'settings',
      'srs_cards',
    ]);
    expect(e2eResults.migratedGameSchemaVersion).toBe(3);
    expect(e2eResults.latestVersion).toBe(4);
    expect(e2eResults.v4Stores).toEqual([
      'endgame_progress',
      'games',
      'puzzles',
      'repertoires',
      'reviews',
      'schema_meta',
      'settings',
      'srs_cards',
    ]);
    expect(e2eResults.gameAtV4White).toBe('WhitePlayer');
    expect(e2eResults.migrationVersions).toEqual([1, 2, 3, 4]);

    expect(externalRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
