import { playKey } from '../capture/game-id';
import { checkPgnText, describeImportProblem, importProblemOf } from '../capture/pgn-games';
import type { BridgeGame, MyAccounts } from '../capture/protocol';
import type { UserAccount } from '../review/perspective';
import type { StoredGameRecord, WizardChessStorage } from '../storage/db';
import type { SaveOutcome } from './bridge-client';
import type { Color } from '../core/rules';
import { accountsFromSettings, buildGameRecord, myColor, type NewGameRecord } from './game-record';
import { PgnImportClient } from './pgn-import-client';
import type { SingleGameCheck } from './pgn-import-core';
import type { SavedReview } from './saved-review';

const ACCOUNTS_SETTING = 'library.myAccounts';
/** Accounts added after the first one per site (`myAccounts` keeps the first, the extension's message format). */
const MORE_ACCOUNTS_SETTING = 'library.moreAccounts';
const AUTO_ANALYZE_SETTING = 'library.autoAnalyze';

export interface ImportOutcome {
  saved: string[];
  duplicates: string[];
  errors: string[];
}

export interface ImportProgress {
  /** Games read so far. */
  done: number;
  total: number;
}

/** A game finished against the bot here, ready for the library. */
export interface PlayedGame {
  /** When the game started (ms since the epoch): its identity. */
  startedAt: number;
  pgn: string;
  /** My side. */
  playerColor: Color;
}

export interface LibraryChange {
  /** Games stored for the first time. */
  added: string[];
  /** How each added game was captured (the extension's method; null when pasted or dropped here). */
  methods: Record<string, string | null>;
  /** Games whose stored data changed (e.g. a review was saved). */
  updated: string[];
}

/** A stored list of added accounts, kept only where each entry is a site and a non-empty name; no repeats. */
function cleanMoreAccounts(value: unknown): UserAccount[] {
  if (!Array.isArray(value)) return [];
  const out: UserAccount[] = [];
  const seen = new Set<string>();
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { site, username } = item as Partial<UserAccount>;
    if ((site !== 'lichess' && site !== 'chesscom') || typeof username !== 'string') continue;
    const name = username.trim();
    const key = `${site}:${name.toLowerCase()}`;
    if (name === '' || seen.has(key)) continue;
    seen.add(key);
    out.push({ site, username: name });
  }
  return out;
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
  private moreAccounts: UserAccount[] = [];
  private readonly accountListeners = new Set<() => void>();

  constructor(
    private readonly storage: WizardChessStorage,
    private readonly importer: PgnImportClient = new PgnImportClient(),
  ) {}

  public async init(): Promise<void> {
    await this.loadAccounts();
  }

  private async loadAccounts(): Promise<void> {
    this.accounts = (await this.storage.getSetting<MyAccounts>(ACCOUNTS_SETTING)) ?? null;
    this.moreAccounts = cleanMoreAccounts(await this.storage.getSetting<unknown>(MORE_ACCOUNTS_SETTING));
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

  /** My accounts for "my color" and the review's default side (none until set or sent). */
  public getUserAccounts(): UserAccount[] {
    return accountsFromSettings(this.accounts, this.moreAccounts);
  }

  /** The accounts added after the first one per site. */
  public getMoreAccounts(): UserAccount[] {
    return this.moreAccounts.map((a) => ({ ...a }));
  }

  public async setMoreAccounts(accounts: readonly UserAccount[]): Promise<void> {
    const next = cleanMoreAccounts(accounts);
    if (JSON.stringify(next) === JSON.stringify(this.moreAccounts)) return;
    this.moreAccounts = next;
    await this.storage.setSetting(MORE_ACCOUNTS_SETTING, next);
    for (const l of this.accountListeners) l();
  }

  public async setMyAccounts(accounts: MyAccounts): Promise<void> {
    const same = this.accounts?.lichess === accounts.lichess && this.accounts?.chesscom === accounts.chesscom;
    this.accounts = { lichess: accounts.lichess, chesscom: accounts.chesscom };
    if (same) return;
    await this.storage.setSetting(ACCOUNTS_SETTING, this.accounts);
    for (const l of this.accountListeners) l();
  }

  /** Called when my usernames change (from Settings, the extension, or a restored backup). */
  public onAccountsChange(listener: () => void): () => void {
    this.accountListeners.add(listener);
    return () => this.accountListeners.delete(listener);
  }

  /** Reads my usernames again from storage (after a restore). */
  public async reloadAccounts(): Promise<void> {
    await this.loadAccounts();
    for (const l of this.accountListeners) l();
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

  /**
   * Stores the games of a pasted, dropped or opened PGN text; known games are skipped. The
   * reading (parsing, checking every move, the opening lookup) happens in a worker, a group of
   * games at a time, so any number of games can come in without freezing the page.
   */
  public async importPgnText(text: string, onProgress?: (progress: ImportProgress) => void): Promise<ImportOutcome> {
    const known = new Set(await this.storage.listGameIds());
    const outcome: ImportOutcome = { saved: [], duplicates: [], errors: [] };
    await this.importer.run(text, known, async (batch) => {
      const stored = await this.storage.saveNewGames(batch.records);
      outcome.saved.push(...stored);
      const storedSet = new Set(stored);
      // A game that turned up in the store meanwhile counts as a duplicate too
      outcome.duplicates.push(
        ...batch.duplicates,
        ...batch.records.filter((r) => !storedSet.has(r.id)).map((r) => r.id),
      );
      outcome.errors.push(...batch.errors);
      onProgress?.({ done: batch.gamesRead, total: batch.totalGames });
    });
    this.emit({
      added: outcome.saved,
      methods: Object.fromEntries(outcome.saved.map((id) => [id, null])),
      updated: [],
    });
    return outcome;
  }

  /** The ids of every stored game (no records read). */
  public listIds(): Promise<string[]> {
    return this.storage.listGameIds();
  }

  /** One game checked on its own, off the page's thread (the Chess.com sync's new games). */
  public checkSingleGame(pgn: string, method: string | null): Promise<SingleGameCheck> {
    return this.importer.checkSingle(pgn, method);
  }

  /**
   * Stores games a sync read. Only games not stored yet are written: a stored game is never changed or removed, so its
   * review and anything else kept with it stay. Returns the ids stored.
   */
  public async saveSyncedGames(records: readonly NewGameRecord[]): Promise<string[]> {
    if (records.length === 0) return [];
    const saved = await this.storage.saveNewGames(records);
    const savedSet = new Set(saved);
    this.emit({
      added: saved,
      methods: Object.fromEntries(
        records.filter((r) => savedSet.has(r.id)).map((r) => [r.id, r.captureMethod ?? null]),
      ),
      updated: [],
    });
    return saved;
  }

  /** A value the library's storage keeps under a settings key (the sync's own record of what it has read). */
  public readSetting<T>(key: string): Promise<T | undefined> {
    return this.storage.getSetting<T>(key);
  }

  public writeSetting<T>(key: string, value: T): Promise<void> {
    return this.storage.setSetting(key, value);
  }

  /**
   * Keeps a game played here. The same game saved again (it went on after a takeback) replaces
   * the entry and drops its review, which no longer matches the moves.
   */
  public async savePlayedGame(game: PlayedGame): Promise<string | null> {
    const { games } = checkPgnText(game.pgn);
    const checked = games[0];
    if (!checked) return null;
    const id = playKey(game.startedAt);
    const existing = await this.storage.getGame(id);
    const record = buildGameRecord({ ...checked, key: id, source: 'paste' });
    await this.storage.saveGame({
      ...record,
      source: 'play',
      playerColor: game.playerColor,
      ...(existing ? { createdAt: existing.createdAt } : {}),
    });
    if (existing) await this.storage.deleteReview(id);
    this.emit({ added: existing ? [] : [id], methods: existing ? {} : { [id]: null }, updated: existing ? [id] : [] });
    return id;
  }

  /** Removes games from the library, with their saved reviews. */
  public async deleteGames(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await this.storage.deleteGame(id);
      await this.storage.deleteReview(id);
    }
    this.emit({ added: [], methods: {}, updated: [...ids] });
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
        outcome.failed.push({
          key: g.key,
          kind: 'error',
          reason: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        });
      }
      await yieldToEventLoop();
    }
    const methods = Object.fromEntries(
      batch.filter((g) => outcome.saved.includes(g.key)).map((g) => [g.key, g.method]),
    );
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
