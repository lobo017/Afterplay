import { checkPgnText, describeImportProblem, importProblemOf } from '../capture/pgn-games';
import type { BridgeGame, MyAccounts } from '../capture/protocol';
import type { UserAccount } from '../review/perspective';
import type { StoredGameRecord, WizardChessStorage } from '../storage/db';
import type { SaveOutcome } from './bridge-client';
import { accountsFromSettings, buildGameRecord, myColor } from './game-record';
import type { SavedReview } from './saved-review';

const ACCOUNTS_SETTING = 'library.myAccounts';
const AUTO_ANALYZE_SETTING = 'library.autoAnalyze';

export interface ImportOutcome {
  saved: string[];
  duplicates: string[];
  errors: string[];
}

export interface LibraryChange {
  /** Games stored for the first time. */
  added: string[];
  /** How each added game was captured (the extension's method; null when pasted or dropped here). */
  methods: Record<string, string | null>;
  /** Games whose stored data changed (e.g. a review was saved). */
  updated: string[];
}

/** Lets other work run between games, so a big import never becomes one long task. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The Games list's store: captured, pasted and dropped games in IndexedDB, keyed by
 * site + game ID so a game is kept once, plus my usernames and the auto-analyze setting.
 */
export class GameLibrary {
  private readonly listeners = new Set<(change: LibraryChange) => void>();
  private accounts: MyAccounts | null = null;

  constructor(private readonly storage: WizardChessStorage) {}

  public async init(): Promise<void> {
    this.accounts = (await this.storage.getSetting<MyAccounts>(ACCOUNTS_SETTING)) ?? null;
  }

  public onChange(listener: (change: LibraryChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: LibraryChange): void {
    if (change.added.length === 0 && change.updated.length === 0) return;
    for (const l of this.listeners) l(change);
  }

  /** My usernames as last sent by the extension (null: never sent). */
  public getMyAccounts(): MyAccounts | null {
    return this.accounts;
  }

  /** My accounts for "my color" and the review's default side (built-in default until sent). */
  public getUserAccounts(): UserAccount[] {
    return accountsFromSettings(this.accounts);
  }

  public async setMyAccounts(accounts: MyAccounts): Promise<void> {
    const same = this.accounts?.lichess === accounts.lichess && this.accounts?.chesscom === accounts.chesscom;
    this.accounts = { lichess: accounts.lichess, chesscom: accounts.chesscom };
    if (!same) await this.storage.setSetting(ACCOUNTS_SETTING, this.accounts);
  }

  public async getAutoAnalyze(): Promise<boolean> {
    return (await this.storage.getSetting<boolean>(AUTO_ANALYZE_SETTING)) ?? false;
  }

  public async setAutoAnalyze(on: boolean): Promise<void> {
    await this.storage.setSetting(AUTO_ANALYZE_SETTING, on);
  }

  public list(): Promise<StoredGameRecord[]> {
    return this.storage.listGames();
  }

  public get(id: string): Promise<StoredGameRecord | undefined> {
    return this.storage.getGame(id);
  }

  /** Stores the games of a pasted or dropped PGN text; known games are skipped. */
  public async importPgnText(text: string): Promise<ImportOutcome> {
    const { games, errors } = checkPgnText(text);
    const saved: string[] = [];
    const duplicates: string[] = [];
    for (const game of games) {
      if (saved.includes(game.key) || duplicates.includes(game.key) || (await this.storage.getGame(game.key))) {
        duplicates.push(game.key);
        continue;
      }
      await this.storage.saveGame(buildGameRecord(game));
      saved.push(game.key);
      await yieldToEventLoop();
    }
    this.emit({ added: saved, methods: Object.fromEntries(saved.map((id) => [id, null])), updated: [] });
    return { saved, duplicates, errors };
  }

  /** Stores games from the extension: each PGN is checked, known games are reported as duplicates. */
  public async saveBridgeGames(batch: readonly BridgeGame[]): Promise<SaveOutcome> {
    const outcome: SaveOutcome = { saved: [], duplicates: [], failed: [] };
    for (const g of batch) {
      try {
        if (await this.storage.getGame(g.key)) {
          outcome.duplicates.push(g.key);
          continue;
        }
        // Games the app doesn't play, or that have no moves: never stored, and said so
        const problem = importProblemOf(g.pgn);
        if (problem) {
          outcome.failed.push({ key: g.key, kind: problem.kind, reason: describeImportProblem(problem) });
          continue;
        }
        const { games, errors } = checkPgnText(g.pgn);
        if (games.length !== 1) {
          const reason = (errors[0] ?? 'Expected exactly one game.').slice(0, 200);
          outcome.failed.push({ key: g.key, kind: reason === 'no moves.' ? 'no-moves' : 'invalid', reason });
          continue;
        }
        // The extension's key names the game it captured, whatever the PGN headers say
        const game = { ...games[0]!, key: g.key, source: g.source };
        await this.storage.saveGame(buildGameRecord(game, { capturedAt: g.capturedAt, method: g.method }));
        outcome.saved.push(g.key);
      } catch (err) {
        // Storage trouble: worth another try on the next sync
        outcome.failed.push({ key: g.key, kind: 'error', reason: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
      }
      await yieldToEventLoop();
    }
    const methods = Object.fromEntries(batch.filter((g) => outcome.saved.includes(g.key)).map((g) => [g.key, g.method]));
    this.emit({ added: outcome.saved, methods, updated: [] });
    return outcome;
  }

  /**
   * Stores a finished review for a game: the review in its own store, a summary (and my
   * accuracy, when it's my game) on the game record the list reads.
   */
  public async saveReview(id: string, review: SavedReview): Promise<void> {
    const record = await this.storage.getGame(id);
    if (!record) return;
    const color = myColor(record, this.getUserAccounts());
    const side = color === 'b' ? review.review.black : color === 'w' ? review.review.white : null;
    await this.storage.saveReview(id, review);
    await this.storage.saveGame({
      ...record,
      analysis: {
        preset: review.preset,
        savedAt: review.savedAt,
        whiteAccuracy: review.review.white.accuracy,
        blackAccuracy: review.review.black.accuracy,
      },
      accuracy: side?.accuracy ?? null,
      playerColor: color ?? record.playerColor,
    });
    this.emit({ added: [], methods: {}, updated: [id] });
  }

  public getReview(id: string): Promise<SavedReview | undefined> {
    return this.storage.getReview(id);
  }
}
