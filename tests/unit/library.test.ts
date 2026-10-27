import { beforeEach, describe, expect, it } from 'vitest';
import { installIndexedDBPolyfill } from './helpers/indexeddb-polyfill';
installIndexedDBPolyfill();

import { parsePgn } from '../../src/core/pgn';
import { checkPgnText } from '../../src/capture/pgn-games';
import type { BridgeGame } from '../../src/capture/protocol';
import {
  accountsFromSettings,
  buildGameRecord,
  formatTimeControl,
  myColor,
  playedAtFromHeaders,
  resultFor,
} from '../../src/library/game-record';
import { GameLibrary, type LibraryChange } from '../../src/library/library';
import { restoreSavedReview, toSavedReview } from '../../src/library/saved-review';
import { buildGameReview, mainLinePlies } from '../../src/review/review-game';
import type { ReviewRunResult } from '../../src/review/review-runner';
import { WizardChessStorage, deleteWizardChessDB } from '../../src/storage/db';
import { lichessGame, lichessPositions } from '../helpers/lichess-fixture';
import { isBookFen } from '../helpers/review-fixtures';

const DB = 'wizards-chess-library-test';

const PLAIN =
  '[Event "Casual"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n[Date "2026.01.02"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0';

async function openLibrary() {
  const storage = await WizardChessStorage.create({ dbName: DB });
  const library = new GameLibrary(storage);
  await library.init();
  const changes: LibraryChange[] = [];
  library.onChange((c) => changes.push(c));
  return { storage, library, changes };
}

/** A complete review of the Lichess reference game from Lichess's own evaluations. */
function lichessRunResult(): ReviewRunResult {
  const tree = parsePgn(lichessGame.pgn);
  const positions = lichessPositions(tree);
  const plies = mainLinePlies(tree);
  const review = buildGameReview({
    preset: 'standard',
    budget: { movetimeMs: 600 },
    startFen: tree.root.fen,
    plies,
    positions,
    isBookPosition: isBookFen,
  });
  return {
    review,
    positions,
    plies,
    cancelled: false,
    stats: { timeMs: 1000, meanDepth: 20, minDepth: 20, searches: positions.length, verifiedPositions: 0 },
  };
}

describe('Phase 5b — game records', () => {
  it('builds the list fields from the PGN', () => {
    const [game] = checkPgnText(lichessGame.pgn).games;
    const record = buildGameRecord(game!, { capturedAt: 5, method: 'lichess-page-data' });
    expect(record).toMatchObject({
      id: 'lichess:Bjl39T9x',
      source: 'lichess',
      url: 'https://lichess.org/Bjl39T9x',
      white: 'GEU3',
      black: 'Lobo017',
      result: '0-1',
      whiteElo: 1374,
      blackElo: 1397,
      timeControl: '120+1',
      date: '2026.10.04',
      capturedAt: 5,
      captureMethod: 'lichess-page-data',
      analysis: null,
    });
    expect(record.openingName).not.toBe('');
    expect(record.playedAt).toBe(Date.UTC(2026, 9, 4, 5, 33, 38));
  });

  it("works out my color from my accounts on the game's site", () => {
    const accounts = accountsFromSettings({ lichess: 'lobo017', chesscom: 'LoboCC' });
    expect(myColor({ white: 'GEU3', black: 'Lobo017', source: 'lichess' }, accounts)).toBe('b');
    // A Lichess name doesn't make me a player on Chess.com
    expect(myColor({ white: 'GEU3', black: 'Lobo017', source: 'chesscom' }, accounts)).toBeNull();
    expect(myColor({ white: 'lobocc', black: 'X', source: 'chesscom' }, accounts)).toBe('w');
    expect(myColor({ white: 'lobocc', black: 'X', source: 'paste' }, accounts)).toBe('w');
    expect(myColor({ white: 'A', black: 'B', source: 'lichess' }, accounts)).toBeNull();
    // Until the extension sends usernames, the built-in default account applies
    expect(accountsFromSettings(null)).toEqual([{ site: 'lichess', username: 'Lobo017' }]);
    expect(accountsFromSettings({ lichess: '', chesscom: '' })).toEqual([{ site: 'lichess', username: 'Lobo017' }]);
  });

  it('formats results, time controls and dates for the list', () => {
    expect(resultFor('0-1', 'b')).toBe('win');
    expect(resultFor('0-1', 'w')).toBe('loss');
    expect(resultFor('1-0', null)).toBe('win');
    expect(resultFor('1/2-1/2', 'w')).toBe('draw');
    expect(resultFor('*', 'w')).toBe('unfinished');
    expect(formatTimeControl('120+1')).toBe('2+1');
    expect(formatTimeControl('180')).toBe('3+0');
    expect(formatTimeControl('90+0')).toBe('1.5+0');
    expect(formatTimeControl('30+0')).toBe('30s+0');
    expect(formatTimeControl('1/86400')).toBe('1 day');
    expect(formatTimeControl('1/259200')).toBe('3 days');
    expect(formatTimeControl('-')).toBe('–');
    expect(formatTimeControl(undefined)).toBe('–');
    expect(playedAtFromHeaders({ Date: '2026.??.??' })).toBeNull();
    expect(playedAtFromHeaders({ Date: '2026.10.18', StartTime: '09:28:20' })).toBe(Date.UTC(2026, 9, 18, 9, 28, 20));
  });
});

describe('Phase 5b — game library', () => {
  beforeEach(async () => {
    await deleteWizardChessDB(DB);
  });

  it('imports pasted games once, reporting duplicates and bad games', async () => {
    const { library, storage, changes } = await openLibrary();
    const first = await library.importPgnText(`${PLAIN}\n\n${lichessGame.pgn}\n\n[Event "Bad"]\n\n1. e4 e5 2. Ke3 *`);
    expect(first.saved).toHaveLength(2);
    expect(first.saved).toContain('lichess:Bjl39T9x');
    expect(first.errors).toHaveLength(1);
    const again = await library.importPgnText(PLAIN);
    expect(again).toMatchObject({ saved: [], duplicates: [first.saved[0]] });
    expect(await library.list()).toHaveLength(2);
    expect(changes[0]).toMatchObject({ added: first.saved });
    expect(changes[0]!.methods['lichess:Bjl39T9x']).toBeNull();
    storage.close();
  });

  it('stores games from the extension, skipping known ones and reporting bad ones', async () => {
    const { library, storage, changes } = await openLibrary();
    await library.importPgnText(PLAIN);
    const [plain] = checkPgnText(PLAIN).games;
    const batch: BridgeGame[] = [
      { key: 'lichess:Bjl39T9x', source: 'lichess', pgn: lichessGame.pgn, capturedAt: 7, method: 'lichess-page-data' },
      { key: plain!.key, source: 'paste', pgn: PLAIN, capturedAt: 7, method: 'pasted-pgn' },
      {
        key: 'chesscom:live-1',
        source: 'chesscom',
        pgn: '[Event "x"]\n\n1. e4 e5 2. Ke3 *',
        capturedAt: 7,
        method: 'm',
      },
      { key: 'chesscom:live-2', source: 'chesscom', pgn: `${PLAIN}\n\n${PLAIN}`, capturedAt: 7, method: 'm' },
    ];
    const outcome = await library.saveBridgeGames(batch);
    expect(outcome.saved).toEqual(['lichess:Bjl39T9x']);
    expect(outcome.duplicates).toEqual([plain!.key]);
    expect(outcome.failed.map((f) => f.key)).toEqual(['chesscom:live-1', 'chesscom:live-2']);
    expect(outcome.failed[1]!.reason).toBe('Expected exactly one game.');
    const stored = await library.get('lichess:Bjl39T9x');
    expect(stored).toMatchObject({ source: 'lichess', capturedAt: 7, captureMethod: 'lichess-page-data' });
    expect(changes.at(-1)).toMatchObject({
      added: ['lichess:Bjl39T9x'],
      methods: { 'lichess:Bjl39T9x': 'lichess-page-data' },
    });
    // Saving the same batch again stores nothing new
    expect((await library.saveBridgeGames(batch.slice(0, 1))).duplicates).toEqual(['lichess:Bjl39T9x']);
    storage.close();
  });

  it('remembers my usernames from the extension', async () => {
    const { library, storage } = await openLibrary();
    expect(library.getMyAccounts()).toBeNull();
    await library.setMyAccounts({ lichess: 'Lobo017', chesscom: 'lobo_cc' });
    storage.close();
    const reopened = await openLibrary();
    expect(reopened.library.getMyAccounts()).toEqual({ lichess: 'Lobo017', chesscom: 'lobo_cc' });
    expect(reopened.library.getUserAccounts()).toEqual([
      { site: 'lichess', username: 'Lobo017' },
      { site: 'chesscom', username: 'lobo_cc' },
    ]);
    reopened.storage.close();
  });

  it('saves a finished review apart from the game and shows it again on a fresh parse of the game', async () => {
    const { library, storage } = await openLibrary();
    await library.importPgnText(lichessGame.pgn);
    const result = lichessRunResult();
    const saved = toSavedReview(result, 1234)!;
    expect(saved.ucis).toHaveLength(46);
    await library.saveReview('lichess:Bjl39T9x', saved);

    const record = await library.get('lichess:Bjl39T9x');
    expect(record?.analysis).toEqual({
      preset: 'standard',
      savedAt: 1234,
      whiteAccuracy: result.review.white.accuracy,
      blackAccuracy: result.review.black.accuracy,
    });
    // My side is Black (Lobo017, the default account): the record carries my accuracy
    expect(record?.accuracy).toBe(result.review.black.accuracy);
    expect(JSON.stringify(record)).not.toContain('whiteWinSeries');

    const fromDb = await library.getReview('lichess:Bjl39T9x');
    const tree = parsePgn(record!.pgn);
    const restored = restoreSavedReview(fromDb!, tree)!;
    const plies = mainLinePlies(tree);
    expect(restored.review.moves.map((m) => m.nodeId)).toEqual(plies.map((p) => p.nodeId));
    expect(restored.review.moves.map((m) => m.classification)).toEqual(
      result.review.moves.map((m) => m.classification),
    );
    expect(restored.review.keyMoments.every((k) => plies.some((p) => p.nodeId === k.nodeId))).toBe(true);
    expect(restored.positions).toHaveLength(47);
    storage.close();
  });

  it('refuses to restore a review onto a different game, and does not save partial reviews', () => {
    const result = lichessRunResult();
    const saved = toSavedReview(result)!;
    expect(restoreSavedReview(saved, parsePgn(PLAIN))).toBeNull();
    const shorter = parsePgn(lichessGame.pgn.replace(/23\.\.\. Qxc1#.*$/s, '0-1'));
    expect(restoreSavedReview(saved, shorter)).toBeNull();
    expect(toSavedReview({ ...result, cancelled: true })).toBeNull();
    expect(toSavedReview({ ...result, review: { ...result.review, complete: false } })).toBeNull();
  });
});
