import {
  deleteDB,
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
} from 'idb';
import type { Color } from '../core/rules';
import type { GameTermination, SerializedGameTree } from '../core/game-tree';
import type { GameSource } from '../capture/game-id';
import type { SavedReview } from '../library/saved-review';

export const DEFAULT_DB_NAME = 'wizards-chess-db';
export const LATEST_SCHEMA_VERSION = 4;

export interface StoredGameRecord {
  id: string;
  title?: string;
  white: string;
  black: string;
  playerColor: Color;
  result: GameTermination;
  date: string;
  openingEco: string;
  openingName: string;
  accuracy: number | null;
  pgn: string;
  tree?: SerializedGameTree;
  tags: string[];
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
  // Games list fields (Phase 5b). Optional, so records written before them stay valid;
  // the id (`lichess:<id>`, `chesscom:<id>`, `paste:<hash>`) keeps a site game unique.
  source?: GameSource;
  /** The game's page on its site. */
  url?: string | null;
  whiteElo?: number | null;
  blackElo?: number | null;
  /** PGN TimeControl, e.g. "120+1", "180", "1/86400". */
  timeControl?: string;
  /** When the game was played (ms since the epoch), when the PGN says. */
  playedAt?: number | null;
  /** When the extension captured it. */
  capturedAt?: number | null;
  captureMethod?: string | null;
  /** Summary of the saved review (the review itself is in the reviews store). */
  analysis?: GameAnalysisSummary | null;
}

export interface GameAnalysisSummary {
  preset: SavedReview['preset'];
  savedAt: number;
  whiteAccuracy: number | null;
  blackAccuracy: number | null;
}

/** A finished game review, keyed by its game's id (schema v4). */
export interface StoredReviewRecord {
  id: string;
  review: SavedReview;
  updatedAt: number;
}

export interface StoredSettingRecord<T = unknown> {
  key: string;
  value: T;
  updatedAt: number;
}

/**
 * A puzzle (Lichess layout: `fen` is the position before the opponent's move `moves[0]`; the
 * solution starts at `moves[1]`). Bundled puzzles are stored once tried; personal ones when
 * a review of my game yields them.
 */
export interface StoredPuzzleRecord {
  id: string;
  source: 'personal' | 'lichess';
  fen: string;
  moves: string[];
  /** The Lichess rating; 0 for personal puzzles (unrated). */
  rating: number;
  themes: string[];
  sourceGameId?: string;
  dueDate: number;
  attempts: number;
  solvedCount: number;
  updatedAt: number;
  // Phase 6 (optional, so v2 records stay valid)
  /** Personal: the ply of my move in the game, the move I played and how the review classed it. */
  ply?: number;
  playedSan?: string;
  classification?: 'Mistake' | 'Blunder' | 'Miss';
  explanation?: string | null;
  /** Personal: the engine's best line from the puzzle position (SAN), shown after solving. */
  bestLineSan?: string[];
  /** Personal: "Lobo017 vs hikaru · 2026-10-04", for the source line. */
  gameLabel?: string;
  /** When the review that produced it was saved (re-synced when the review changes). */
  reviewSavedAt?: number;
  lastAttemptAt?: number;
  lastSolved?: boolean;
}

export interface StoredSrsCardRecord {
  id: string;
  deck: 'puzzle' | 'repertoire' | 'endgame' | 'visualization';
  targetId: string;
  state: 'new' | 'learning' | 'review' | 'relearning';
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  dueDate: number;
  lastReviewDate?: number;
  updatedAt: number;
}

export interface StoredRepertoireRecord {
  id: string;
  name: string;
  color: Color;
  pgn: string;
  tree: SerializedGameTree;
  updatedAt: number;
}

export interface StoredEndgameProgressRecord {
  id: string;
  category: string;
  completed: number; // 0 or 1 for IndexedDB key indexing: ever reached the target result
  attempts: number;
  /** Fewest moves of a drill that reached the target without hints (null: none yet, or not tracked). */
  bestMoves: number | null;
  /** The engine's mate distance, null where the drill doesn't end in a forced mate. */
  optimalMoves: number | null;
  updatedAt: number;
  // Phase 7 (optional, so earlier records stay valid)
  /** Drills that reached the target result. */
  completions?: number;
  lastAttemptAt?: number;
  lastReached?: boolean;
  /** Moves the last drill took (the player's), when it reached the target. */
  lastMoves?: number | null;
}

export interface MigrationHistoryEntry {
  fromVersion: number;
  toVersion: number;
  appliedAt: number;
  description: string;
}

export interface SchemaMetaRecord {
  key: 'schema_version' | 'migration_history';
  value: number | MigrationHistoryEntry[];
  updatedAt: number;
}

export interface WizardChessDBSchema extends DBSchema {
  games: {
    key: string;
    value: StoredGameRecord;
    indexes: {
      'by-date': string;
      'by-result': string;
      'by-color': string;
      'by-opening': string;
      'by-accuracy': number;
      'by-updated': number;
    };
  };
  settings: {
    key: string;
    value: StoredSettingRecord;
  };
  schema_meta: {
    key: string;
    value: SchemaMetaRecord;
  };
  puzzles: {
    key: string;
    value: StoredPuzzleRecord;
    indexes: {
      'by-source': string;
      'by-rating': number;
      'by-due': number;
    };
  };
  srs_cards: {
    key: string;
    value: StoredSrsCardRecord;
    indexes: {
      'by-deck': string;
      'by-due': number;
      'by-state': string;
    };
  };
  repertoires: {
    key: string;
    value: StoredRepertoireRecord;
    indexes: {
      'by-color': string;
      'by-updated': number;
    };
  };
  endgame_progress: {
    key: string;
    value: StoredEndgameProgressRecord;
    indexes: {
      'by-category': string;
      'by-completed': number;
    };
  };
  reviews: {
    key: string;
    value: StoredReviewRecord;
  };
}

export interface GameFilterOptions {
  result?: GameTermination;
  playerColor?: Color;
  openingEco?: string;
  fromDate?: string;
  toDate?: string;
  minAccuracy?: number;
}

export interface BackupPayload {
  format: 'wizards-chess-backup';
  schemaVersion: number;
  exportedAt: number;
  games: StoredGameRecord[];
  settings: StoredSettingRecord[];
  puzzles: StoredPuzzleRecord[];
  srsCards: StoredSrsCardRecord[];
  repertoires: StoredRepertoireRecord[];
  endgameProgress: StoredEndgameProgressRecord[];
  /** Saved game reviews (schema v4; absent in older backups). */
  reviews?: StoredReviewRecord[];
}

export interface SchemaMigrationDefinition {
  version: number;
  description: string;
  migrate: (
    db: IDBPDatabase<WizardChessDBSchema>,
    tx: IDBPTransaction<
      WizardChessDBSchema,
      ArrayLike<StoreNames<WizardChessDBSchema>>,
      'versionchange'
    >,
    oldVersion: number,
  ) => Promise<void> | void;
}

export const SCHEMA_MIGRATIONS: readonly SchemaMigrationDefinition[] = [
  {
    version: 1,
    description: 'Create core games, settings, and schema_meta object stores',
    migrate(db) {
      if (!db.objectStoreNames.contains('games')) {
        const gamesStore = db.createObjectStore('games', { keyPath: 'id' });
        gamesStore.createIndex('by-date', 'date');
        gamesStore.createIndex('by-result', 'result');
        gamesStore.createIndex('by-color', 'playerColor');
        gamesStore.createIndex('by-opening', 'openingEco');
        gamesStore.createIndex('by-updated', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('schema_meta')) {
        db.createObjectStore('schema_meta', { keyPath: 'key' });
      }
    },
  },
  {
    version: 2,
    description:
      'Add by-accuracy index to games; create puzzles and srs_cards object stores',
    migrate(db, tx) {
      if (db.objectStoreNames.contains('games')) {
        const gamesStore = tx.objectStore('games');
        if (!gamesStore.indexNames.contains('by-accuracy')) {
          gamesStore.createIndex('by-accuracy', 'accuracy');
        }
      }
      if (!db.objectStoreNames.contains('puzzles')) {
        const puzzlesStore = db.createObjectStore('puzzles', { keyPath: 'id' });
        puzzlesStore.createIndex('by-source', 'source');
        puzzlesStore.createIndex('by-rating', 'rating');
        puzzlesStore.createIndex('by-due', 'dueDate');
      }
      if (!db.objectStoreNames.contains('srs_cards')) {
        const srsStore = db.createObjectStore('srs_cards', { keyPath: 'id' });
        srsStore.createIndex('by-deck', 'deck');
        srsStore.createIndex('by-due', 'dueDate');
        srsStore.createIndex('by-state', 'state');
      }
    },
  },
  {
    version: 3,
    description:
      'Create repertoires and endgame_progress stores; backfill v3 fields on existing games',
    async migrate(db, tx) {
      if (!db.objectStoreNames.contains('repertoires')) {
        const repStore = db.createObjectStore('repertoires', { keyPath: 'id' });
        repStore.createIndex('by-color', 'color');
        repStore.createIndex('by-updated', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('endgame_progress')) {
        const egStore = db.createObjectStore('endgame_progress', {
          keyPath: 'id',
        });
        egStore.createIndex('by-category', 'category');
        egStore.createIndex('by-completed', 'completed');
      }

      // Backfill existing game records from v1/v2 to ensure schemaVersion=3 and normalized fields
      if (db.objectStoreNames.contains('games')) {
        const gamesStore = tx.objectStore('games');
        const allGames = await gamesStore.getAll();
        for (const raw of allGames) {
          const updated: StoredGameRecord = {
            ...raw,
            openingEco: raw.openingEco ?? '',
            openingName: raw.openingName ?? '',
            accuracy: raw.accuracy ?? null,
            tags: Array.isArray(raw.tags) ? raw.tags : [],
            schemaVersion: 3,
          };
          await gamesStore.put(updated);
        }
      }
    },
  },
  {
    version: 4,
    description:
      'Create the reviews store (saved game reviews, kept apart so listing games stays light)',
    migrate(db) {
      if (!db.objectStoreNames.contains('reviews')) {
        db.createObjectStore('reviews', { keyPath: 'id' });
      }
    },
  },
];

export interface OpenDatabaseOptions {
  dbName?: string;
  version?: number;
}

/**
 * Open the Wizard's Chess IndexedDB database and run all pending versioned migrations
 * up to `options.version` (defaults to `LATEST_SCHEMA_VERSION`).
 */
export async function openWizardChessDB(
  options?: OpenDatabaseOptions,
): Promise<IDBPDatabase<WizardChessDBSchema>> {
  const dbName = options?.dbName ?? DEFAULT_DB_NAME;
  const targetVersion = options?.version ?? LATEST_SCHEMA_VERSION;

  const appliedMigrations: MigrationHistoryEntry[] = [];

  const db = await openDB<WizardChessDBSchema>(dbName, targetVersion, {
    async upgrade(database, oldVersion, newVersion, transaction) {
      const effectiveNew = newVersion ?? targetVersion;
      for (const migration of SCHEMA_MIGRATIONS) {
        if (migration.version > oldVersion && migration.version <= effectiveNew) {
          await migration.migrate(database, transaction, oldVersion);
          appliedMigrations.push({
            fromVersion: oldVersion,
            toVersion: migration.version,
            appliedAt: Date.now(),
            description: migration.description,
          });
        }
      }
    },
  });

  // Persist migration metadata if an upgrade occurred and schema_meta store exists
  if (appliedMigrations.length > 0 && db.objectStoreNames.contains('schema_meta')) {
    const tx = db.transaction('schema_meta', 'readwrite');
    const store = tx.objectStore('schema_meta');
    const existingHistoryRec = await store.get('migration_history');
    const prevHistory = Array.isArray(existingHistoryRec?.value)
      ? existingHistoryRec.value
      : [];
    const mergedHistory = [...prevHistory, ...appliedMigrations];
    const now = Date.now();
    await store.put({
      key: 'migration_history',
      value: mergedHistory,
      updatedAt: now,
    });
    await store.put({
      key: 'schema_version',
      value: targetVersion,
      updatedAt: now,
    });
    await tx.done;
  }

  return db;
}

/**
 * Delete a Wizard's Chess IndexedDB database by name.
 */
export async function deleteWizardChessDB(
  dbName: string = DEFAULT_DB_NAME,
): Promise<void> {
  await deleteDB(dbName);
}

/**
 * High-level typed storage client wrapping the versioned IndexedDB database.
 */
export class WizardChessStorage {
  private db: IDBPDatabase<WizardChessDBSchema>;

  public constructor(db: IDBPDatabase<WizardChessDBSchema>) {
    this.db = db;
  }

  public static async create(
    options?: OpenDatabaseOptions,
  ): Promise<WizardChessStorage> {
    const db = await openWizardChessDB(options);
    return new WizardChessStorage(db);
  }

  public get version(): number {
    return this.db.version;
  }

  public get storeNames(): string[] {
    return Array.from(this.db.objectStoreNames);
  }

  public getIndexNames(storeName: StoreNames<WizardChessDBSchema>): string[] {
    const tx = this.db.transaction(storeName, 'readonly');
    return Array.from(tx.objectStore(storeName).indexNames);
  }

  public close(): void {
    this.db.close();
  }

  public async getSchemaVersion(): Promise<number> {
    const rec = await this.db.get('schema_meta', 'schema_version');
    return typeof rec?.value === 'number' ? rec.value : this.db.version;
  }

  public async getMigrationHistory(): Promise<MigrationHistoryEntry[]> {
    const rec = await this.db.get('schema_meta', 'migration_history');
    return Array.isArray(rec?.value) ? rec.value : [];
  }

  // --- Games Store ---

  public async saveGame(
    record: Omit<StoredGameRecord, 'schemaVersion' | 'createdAt' | 'updatedAt'> & {
      createdAt?: number;
      updatedAt?: number;
      schemaVersion?: number;
    },
  ): Promise<StoredGameRecord> {
    const now = Date.now();
    const existing = await this.db.get('games', record.id);
    const fullRecord: StoredGameRecord = {
      ...record,
      schemaVersion: record.schemaVersion ?? this.db.version,
      createdAt: record.createdAt ?? existing?.createdAt ?? now,
      updatedAt: record.updatedAt ?? now,
    };
    await this.db.put('games', fullRecord);
    return fullRecord;
  }

  public async getGame(id: string): Promise<StoredGameRecord | undefined> {
    return this.db.get('games', id);
  }

  public async deleteGame(id: string): Promise<void> {
    await this.db.delete('games', id);
  }

  public async listGames(filter?: GameFilterOptions): Promise<StoredGameRecord[]> {
    const all = await this.db.getAll('games');
    const filtered = all.filter((g) => {
      if (filter?.result && g.result !== filter.result) return false;
      if (filter?.playerColor && g.playerColor !== filter.playerColor) return false;
      if (filter?.openingEco && g.openingEco !== filter.openingEco) return false;
      if (filter?.fromDate && g.date < filter.fromDate) return false;
      if (filter?.toDate && g.date > filter.toDate) return false;
      if (
        filter?.minAccuracy !== undefined &&
        (g.accuracy === null || g.accuracy < filter.minAccuracy)
      ) {
        return false;
      }
      return true;
    });
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // --- Reviews Store ---

  public async saveReview(id: string, review: SavedReview): Promise<void> {
    await this.db.put('reviews', { id, review, updatedAt: Date.now() });
  }

  public async getReview(id: string): Promise<SavedReview | undefined> {
    return (await this.db.get('reviews', id))?.review;
  }

  public async deleteReview(id: string): Promise<void> {
    await this.db.delete('reviews', id);
  }

  // --- Settings Store ---

  public async setSetting<T>(key: string, value: T): Promise<void> {
    await this.db.put('settings', {
      key,
      value,
      updatedAt: Date.now(),
    });
  }

  public async getSetting<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    const rec = await this.db.get('settings', key);
    if (!rec) return defaultValue;
    return rec.value as T;
  }

  public async getAllSettings(): Promise<Record<string, unknown>> {
    const all = await this.db.getAll('settings');
    const out: Record<string, unknown> = {};
    for (const item of all) {
      out[item.key] = item.value;
    }
    return out;
  }

  // --- Puzzles & SRS Stores ---

  public async savePuzzle(puzzle: StoredPuzzleRecord): Promise<void> {
    await this.db.put('puzzles', puzzle);
  }

  public async getPuzzle(id: string): Promise<StoredPuzzleRecord | undefined> {
    return this.db.get('puzzles', id);
  }

  public async listPuzzles(source?: 'personal' | 'lichess'): Promise<StoredPuzzleRecord[]> {
    if (source) {
      return this.db.getAllFromIndex('puzzles', 'by-source', source);
    }
    return this.db.getAll('puzzles');
  }

  public async deletePuzzle(id: string): Promise<void> {
    await this.db.delete('puzzles', id);
  }

  public async saveSrsCard(card: StoredSrsCardRecord): Promise<void> {
    await this.db.put('srs_cards', card);
  }

  public async deleteSrsCard(id: string): Promise<void> {
    await this.db.delete('srs_cards', id);
  }

  public async listSrsCards(deck?: StoredSrsCardRecord['deck']): Promise<StoredSrsCardRecord[]> {
    return deck ? this.db.getAllFromIndex('srs_cards', 'by-deck', deck) : this.db.getAll('srs_cards');
  }

  public async getSrsCard(id: string): Promise<StoredSrsCardRecord | undefined> {
    return this.db.get('srs_cards', id);
  }

  public async listDueSrsCards(
    asOfTimestamp: number = Date.now(),
    deck?: StoredSrsCardRecord['deck'],
  ): Promise<StoredSrsCardRecord[]> {
    const cards = deck
      ? await this.db.getAllFromIndex('srs_cards', 'by-deck', deck)
      : await this.db.getAll('srs_cards');
    return cards
      .filter((c) => c.dueDate <= asOfTimestamp)
      .sort((a, b) => a.dueDate - b.dueDate);
  }

  // --- Repertoires & Endgame Progress Stores ---

  public async saveRepertoire(rep: StoredRepertoireRecord): Promise<void> {
    await this.db.put('repertoires', rep);
  }

  public async getRepertoire(id: string): Promise<StoredRepertoireRecord | undefined> {
    return this.db.get('repertoires', id);
  }

  public async listRepertoires(color?: Color): Promise<StoredRepertoireRecord[]> {
    if (color) {
      return this.db.getAllFromIndex('repertoires', 'by-color', color);
    }
    return this.db.getAll('repertoires');
  }

  public async saveEndgameProgress(
    progress: StoredEndgameProgressRecord,
  ): Promise<void> {
    await this.db.put('endgame_progress', progress);
  }

  public async getEndgameProgress(
    id: string,
  ): Promise<StoredEndgameProgressRecord | undefined> {
    return this.db.get('endgame_progress', id);
  }

  public async listEndgameProgress(): Promise<StoredEndgameProgressRecord[]> {
    return this.db.getAll('endgame_progress');
  }

  // --- JSON Backup & Restore ---

  public async exportBackupJson(): Promise<string> {
    const [games, settings, puzzles, srsCards, repertoires, endgameProgress, reviews] =
      await Promise.all([
        this.db.getAll('games'),
        this.db.getAll('settings'),
        this.db.objectStoreNames.contains('puzzles')
          ? this.db.getAll('puzzles')
          : Promise.resolve([]),
        this.db.objectStoreNames.contains('srs_cards')
          ? this.db.getAll('srs_cards')
          : Promise.resolve([]),
        this.db.objectStoreNames.contains('repertoires')
          ? this.db.getAll('repertoires')
          : Promise.resolve([]),
        this.db.objectStoreNames.contains('endgame_progress')
          ? this.db.getAll('endgame_progress')
          : Promise.resolve([]),
        this.db.objectStoreNames.contains('reviews')
          ? this.db.getAll('reviews')
          : Promise.resolve([]),
      ]);

    const payload: BackupPayload = {
      format: 'wizards-chess-backup',
      schemaVersion: this.db.version,
      exportedAt: Date.now(),
      games,
      settings,
      puzzles,
      srsCards,
      repertoires,
      endgameProgress,
      reviews,
    };
    return JSON.stringify(payload, null, 2);
  }

  public async importBackupJson(jsonString: string): Promise<{
    gamesImported: number;
    settingsImported: number;
    puzzlesImported: number;
    srsCardsImported: number;
    repertoiresImported: number;
    endgameProgressImported: number;
    reviewsImported: number;
  }> {
    const parsed = JSON.parse(jsonString) as Partial<BackupPayload>;
    if (parsed.format !== 'wizards-chess-backup') {
      throw new Error('Invalid backup format: expected wizards-chess-backup');
    }

    const games = Array.isArray(parsed.games) ? parsed.games : [];
    const settings = Array.isArray(parsed.settings) ? parsed.settings : [];
    const puzzles = Array.isArray(parsed.puzzles) ? parsed.puzzles : [];
    const srsCards = Array.isArray(parsed.srsCards) ? parsed.srsCards : [];
    const repertoires = Array.isArray(parsed.repertoires)
      ? parsed.repertoires
      : [];
    const endgameProgress = Array.isArray(parsed.endgameProgress)
      ? parsed.endgameProgress
      : [];

    for (const g of games) await this.db.put('games', g);
    for (const s of settings) await this.db.put('settings', s);
    if (this.db.objectStoreNames.contains('puzzles')) {
      for (const p of puzzles) await this.db.put('puzzles', p);
    }
    if (this.db.objectStoreNames.contains('srs_cards')) {
      for (const c of srsCards) await this.db.put('srs_cards', c);
    }
    if (this.db.objectStoreNames.contains('repertoires')) {
      for (const r of repertoires) await this.db.put('repertoires', r);
    }
    if (this.db.objectStoreNames.contains('endgame_progress')) {
      for (const e of endgameProgress) await this.db.put('endgame_progress', e);
    }
    const reviews = Array.isArray(parsed.reviews) ? parsed.reviews : [];
    if (this.db.objectStoreNames.contains('reviews')) {
      for (const r of reviews) await this.db.put('reviews', r);
    }

    return {
      gamesImported: games.length,
      settingsImported: settings.length,
      puzzlesImported: puzzles.length,
      srsCardsImported: srsCards.length,
      repertoiresImported: repertoires.length,
      endgameProgressImported: endgameProgress.length,
      reviewsImported: reviews.length,
    };
  }
}
