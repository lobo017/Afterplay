import type { PuzzleEntry } from '../core/datasets';
import type { UserAccount } from '../review/perspective';
import type { SavedReview } from '../library/saved-review';
import {
  hasSavedReview,
  type StoredGameRecord,
  type StoredPuzzleRecord,
  type StoredSrsCardRecord,
  type WizardChessStorage,
} from '../storage/db';
import { newCard, reviewCard, type SrsCard } from './fsrs';
import { DEFAULT_PLAYER, ratePuzzleAttempt, type GlickoRating } from './glicko2';
import {
  gameTime,
  historyPuzzleRecord,
  localDay,
  orderNewestFirst,
  readHistoryPuzzlePending,
  readHistoryPuzzleState,
  releaseAllowance,
  type HistoryGameInfo,
  type HistoryPuzzleEntry,
  type HistoryPuzzlePending,
  type HistoryPuzzleState,
} from './history-puzzles';
import { personalPuzzleId, scanPersonalPuzzles, type PersonalPuzzle } from './personal-puzzles';
import type { AttemptOutcome } from './puzzle-session';

const RATING_SETTING = 'puzzles.rating';
const SYNC_SETTING = 'puzzles.personalSync';
/** Puzzles from a link's puzzle file: what was loaded and released, the puzzles still pending, the last "not found". */
const HISTORY_STATE_SETTING = 'puzzles.fromHistory.state';
const HISTORY_PENDING_SETTING = 'puzzles.fromHistory.pending';
const HISTORY_MISS_SETTING = 'puzzles.fromHistory.miss';
/** Rating history entries kept (for the Phase 8 "puzzle rating over time" chart). */
export const RATING_HISTORY_LIMIT = 5000;

export interface RatingHistoryEntry {
  at: number;
  rating: number;
  puzzleId: string;
  solved: boolean;
}

export interface PuzzleRatingState extends GlickoRating {
  /** Rated puzzles played. */
  games: number;
  history: RatingHistoryEntry[];
}

export interface AttemptResult {
  rated: boolean;
  ratingBefore: number;
  ratingAfter: number;
  card: StoredSrsCardRecord | null;
  record: StoredPuzzleRecord;
}

export interface PersonalSyncState {
  /** My accounts when the games were last scanned; a change re-scans every reviewed game. */
  accountsKey: string;
  /** Game id → savedAt of the review last scanned. */
  games: Record<string, number>;
}

export interface TodaySummary {
  /** Cards already learned once that are due now, by puzzle source. */
  dueReviews: { personal: number; lichess: number };
  /** Personal puzzles never tried. */
  newPersonal: number;
  /** Personal puzzles in all. */
  totalPersonal: number;
  /** When the next card that isn't due yet comes due (null: none). */
  nextDueAt: number | null;
  /** Rated puzzles played today, and solved. */
  ratedToday: number;
  ratedSolvedToday: number;
  rating: PuzzleRatingState;
}

export function cardId(puzzleId: string): string {
  return `puzzle:${puzzleId}`;
}

export function accountsKey(accounts: readonly UserAccount[]): string {
  return accounts
    .map((a) => `${a.site}:${a.username.toLowerCase()}`)
    .sort()
    .join('|');
}

/** Local midnight before `now`. */
export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function toStoredCard(puzzleId: string, card: SrsCard, now: number): StoredSrsCardRecord {
  return {
    id: cardId(puzzleId),
    deck: 'puzzle',
    targetId: puzzleId,
    state: card.state,
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    dueDate: card.dueDate,
    ...(card.lastReviewDate !== undefined ? { lastReviewDate: card.lastReviewDate } : {}),
    updatedAt: now,
  };
}

/** Yields between games so a big sync never becomes one long task. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Puzzle progress in IndexedDB: puzzle records, their spaced-repetition cards (deck
 * `puzzle`), my Glicko-2 puzzle rating and its history, and the puzzles made from my
 * reviewed games.
 */
export class PuzzleStore {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: WizardChessStorage) {}

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  public async getRating(): Promise<PuzzleRatingState> {
    const stored = await this.storage.getSetting<PuzzleRatingState>(RATING_SETTING);
    return stored ?? { ...DEFAULT_PLAYER, games: 0, history: [] };
  }

  public getPuzzle(id: string): Promise<StoredPuzzleRecord | undefined> {
    return this.storage.getPuzzle(id);
  }

  public listPuzzles(source?: StoredPuzzleRecord['source']): Promise<StoredPuzzleRecord[]> {
    return this.storage.listPuzzles(source);
  }

  public getCard(puzzleId: string): Promise<StoredSrsCardRecord | undefined> {
    return this.storage.getSrsCard(cardId(puzzleId));
  }

  public listCards(): Promise<StoredSrsCardRecord[]> {
    return this.storage.listSrsCards('puzzle');
  }

  /** Ids of the bundled puzzles already tried (never picked again for rated play). */
  public async triedBundledIds(): Promise<string[]> {
    return (await this.storage.listPuzzles('lichess')).map((p) => p.id);
  }

  /**
   * Records how an attempt went: the puzzle's counters, my rating (a bundled puzzle's first
   * attempt, unless a hint was used), and its card (personal puzzles always have one; a
   * bundled puzzle gets one when failed or hinted, so it comes back).
   */
  public async recordAttempt(
    puzzle: PuzzleEntry | StoredPuzzleRecord,
    source: StoredPuzzleRecord['source'],
    outcome: AttemptOutcome,
    now: number = Date.now(),
  ): Promise<AttemptResult> {
    const existing = await this.storage.getPuzzle(puzzle.id);
    const firstAttempt = !existing || existing.attempts === 0;
    const base: StoredPuzzleRecord = existing ?? {
      id: puzzle.id,
      source,
      fen: puzzle.fen,
      moves: [...puzzle.moves],
      rating: puzzle.rating,
      themes: [...puzzle.themes],
      dueDate: now,
      attempts: 0,
      solvedCount: 0,
      updatedAt: now,
    };

    const rating = await this.getRating();
    const rated = source === 'lichess' && firstAttempt && !outcome.hintUsed;
    let ratingAfter = rating.rating;
    if (rated) {
      const next = ratePuzzleAttempt(rating, base.rating, outcome.solved);
      ratingAfter = next.rating;
      const history = [
        ...rating.history,
        { at: now, rating: next.rating, puzzleId: puzzle.id, solved: outcome.solved },
      ];
      await this.storage.setSetting<PuzzleRatingState>(RATING_SETTING, {
        ...next,
        games: rating.games + 1,
        history: history.slice(-RATING_HISTORY_LIMIT),
      });
    }

    const storedCard = await this.storage.getSrsCard(cardId(puzzle.id));
    let card: StoredSrsCardRecord | null = null;
    if (storedCard || source === 'personal' || outcome.grade <= 2) {
      const current: SrsCard = storedCard ?? newCard(now);
      card = toStoredCard(puzzle.id, reviewCard(current, outcome.grade, now), now);
      await this.storage.saveSrsCard(card);
    }

    const record: StoredPuzzleRecord = {
      ...base,
      attempts: base.attempts + 1,
      solvedCount: base.solvedCount + (outcome.solved ? 1 : 0),
      dueDate: card?.dueDate ?? base.dueDate,
      lastAttemptAt: now,
      lastSolved: outcome.solved,
      updatedAt: now,
    };
    await this.storage.savePuzzle(record);
    this.emit();
    return { rated, ratingBefore: rating.rating, ratingAfter, card, record };
  }

  /**
   * Brings one game's personal puzzles in line with its review: new ones are added with a
   * new card, changed ones updated (progress kept), ones it no longer yields removed.
   * Returns the ids the game now has.
   */
  public async syncGame(
    record: Pick<StoredGameRecord, 'id' | 'white' | 'black' | 'source' | 'date'>,
    saved: SavedReview | undefined,
    accounts: readonly UserAccount[],
    now: number = Date.now(),
    existingForGame?: StoredPuzzleRecord[],
  ): Promise<string[]> {
    const wanted: PersonalPuzzle[] = saved ? scanPersonalPuzzles(record, saved, accounts).puzzles : [];
    // Puzzles released from a link's puzzle file stay while the game has no review on this device; a device review
    // takes the game over, as for any other game
    const existing = (
      existingForGame ?? (await this.storage.listPuzzles('personal')).filter((p) => p.sourceGameId === record.id)
    ).filter((p) => saved !== undefined || p.origin !== 'history');
    const wantedIds = new Set(wanted.map((p) => p.id));
    for (const old of existing) {
      if (!wantedIds.has(old.id)) {
        await this.storage.deletePuzzle(old.id);
        await this.storage.deleteSrsCard(cardId(old.id));
      }
    }
    for (const p of wanted) {
      const prev = existing.find((e) => e.id === p.id);
      const samePosition = prev && prev.fen === p.fen && prev.moves.join(' ') === p.moves.join(' ');
      if (prev && samePosition) {
        const kept: StoredPuzzleRecord = { ...prev, ...p, updatedAt: now };
        // The device review made this puzzle its own (progress is kept)
        delete kept.origin;
        await this.storage.savePuzzle(kept);
        continue;
      }
      // New, or the review now gives another solution: start over
      const card = newCard(now);
      await this.storage.savePuzzle({ ...p, dueDate: card.dueDate, attempts: 0, solvedCount: 0, updatedAt: now });
      await this.storage.saveSrsCard(toStoredCard(p.id, card, now));
    }
    return [...wantedIds];
  }

  /**
   * Scans every reviewed game whose review (or my accounts) changed since the last scan.
   * Returns how many games were scanned.
   */
  public async syncAll(
    games: readonly StoredGameRecord[],
    getReview: (id: string) => Promise<SavedReview | undefined>,
    accounts: readonly UserAccount[],
    now: number = Date.now(),
  ): Promise<number> {
    const key = accountsKey(accounts);
    const state = (await this.storage.getSetting<PersonalSyncState>(SYNC_SETTING)) ?? { accountsKey: key, games: {} };
    const rescanAll = state.accountsKey !== key;
    const next: PersonalSyncState = { accountsKey: key, games: rescanAll ? {} : { ...state.games } };
    const personal = await this.storage.listPuzzles('personal');
    let scanned = 0;
    for (const game of games) {
      const savedAt = hasSavedReview(game) ? game.analysis?.savedAt : undefined;
      const has = personal.filter((p) => p.sourceGameId === game.id);
      if (savedAt === undefined) {
        if (has.length > 0) await this.syncGame(game, undefined, accounts, now, has);
        delete next.games[game.id];
        continue;
      }
      if (!rescanAll && state.games[game.id] === savedAt) continue;
      await this.syncGame(game, await getReview(game.id), accounts, now, has);
      next.games[game.id] = savedAt;
      scanned++;
      await yieldToEventLoop();
    }
    await this.storage.setSetting(SYNC_SETTING, next);
    if (scanned > 0) this.emit();
    return scanned;
  }

  /** Scans one game right after its review was saved. */
  public async syncReviewedGame(
    game: StoredGameRecord,
    saved: SavedReview | undefined,
    accounts: readonly UserAccount[],
    now: number = Date.now(),
  ): Promise<string[]> {
    const ids = await this.syncGame(game, saved, accounts, now);
    const key = accountsKey(accounts);
    const state = (await this.storage.getSetting<PersonalSyncState>(SYNC_SETTING)) ?? { accountsKey: key, games: {} };
    // Only mark it scanned when the accounts are the ones the other games were scanned with
    if (state.accountsKey === key && hasSavedReview(game) && game.analysis?.savedAt !== undefined) {
      await this.storage.setSetting(SYNC_SETTING, {
        ...state,
        games: { ...state.games, [game.id]: game.analysis.savedAt },
      });
    }
    this.emit();
    return ids;
  }

  // ------------------------------------------------------------------------- puzzles from a link's puzzle file

  /** What the device remembers of the puzzle file it loaded; undefined before the first load. */
  public async historyPuzzleState(): Promise<HistoryPuzzleState | undefined> {
    return readHistoryPuzzleState(await this.storage.getSetting<unknown>(HISTORY_STATE_SETTING));
  }

  /** The local day on which the link's puzzle file was last found missing or unusable (a retry waits for the next day). */
  public async historyPuzzleMissDay(slug: string): Promise<string | undefined> {
    const miss = await this.storage.getSetting<{ slug?: unknown; day?: unknown }>(HISTORY_MISS_SETTING);
    return miss && miss.slug === slug && typeof miss.day === 'string' ? miss.day : undefined;
  }

  public markHistoryPuzzleMiss(slug: string, now: number): Promise<void> {
    return this.storage.setSetting(HISTORY_MISS_SETTING, { slug, day: localDay(now) });
  }

  /**
   * Keeps a checked puzzle file: the puzzles, newest source game first, as one pending blob, and the state that
   * schedules their release, written together in one transaction that first looks again for a state (another page may
   * have loaded the file meanwhile). Does nothing when a file was loaded before: a second load never starts over or
   * duplicates. Returns true when it stored the file. `games` are the library's games, for their dates.
   */
  public async loadHistoryPuzzles(
    file: { input: string; entries: readonly HistoryPuzzleEntry[] },
    slug: string,
    games: readonly Pick<StoredGameRecord, 'id' | 'date' | 'playedAt'>[],
    now: number = Date.now(),
  ): Promise<boolean> {
    const times = new Map(games.map((g) => [g.id, gameTime(g)] as const));
    const pending: HistoryPuzzlePending = {
      version: 1,
      input: file.input,
      entries: orderNewestFirst(file.entries, times),
    };
    const day = localDay(now);
    return this.storage.atomically(async (tx) => {
      if (readHistoryPuzzleState(await tx.getSetting<unknown>(HISTORY_STATE_SETTING))) return false;
      await tx.setSetting(HISTORY_PENDING_SETTING, pending);
      await tx.setSetting<HistoryPuzzleState>(HISTORY_STATE_SETTING, {
        version: 1,
        slug,
        input: file.input,
        loadedDay: day,
        total: file.entries.length,
        released: 0,
        lastDay: day,
        lastDayCount: 0,
      });
      return true;
    });
  }

  /**
   * Turns the next pending puzzles into personal puzzles with new cards: the first 50 on the day the file was loaded,
   * then at most 20 a local day (see `releaseAllowance`). A puzzle whose game is not in the library yet stays pending.
   * One that already exists (the same id) is never added twice.
   *
   * The games are looked up first; then ONE transaction reads the saved state and pending list again, decides how
   * many may still be released today, writes the puzzles, their cards, the shorter pending list and the state (the
   * released counts are added to what is saved, never replaced). A run that is cut off, or that overlaps another page's,
   * therefore leaves nothing half done and cannot release more than the day allows. Returns how many were released.
   */
  public async releaseHistoryPuzzles(
    getGame: (id: string) => Promise<HistoryGameInfo | undefined>,
    now: number = Date.now(),
  ): Promise<number> {
    const state = await this.historyPuzzleState();
    if (!state) return 0;
    const pending = readHistoryPuzzlePending(await this.storage.getSetting<unknown>(HISTORY_PENDING_SETTING));
    if (!pending) return 0;
    const today = localDay(now);
    const allowed = releaseAllowance(state, today, pending.entries.length);
    if (allowed === 0) return 0;

    // The puzzles that could be released now, found outside the transaction (a lookup of the library may not be waited
    // for inside it): the ones that already exist, and the ones whose game is stored
    const candidates: Array<{ entry: HistoryPuzzleEntry; game: HistoryGameInfo | undefined }> = [];
    let room = 0;
    for (const entry of pending.entries) {
      if (room >= allowed) break;
      const existing = await this.storage.getPuzzle(personalPuzzleId(entry.id, entry.ply));
      if (existing) {
        candidates.push({ entry, game: undefined });
        if (existing.origin === 'history') room++;
        continue;
      }
      const game = await getGame(entry.id);
      if (!game) continue;
      candidates.push({ entry, game });
      room++;
    }
    if (candidates.length === 0) return 0;

    const released = await this.storage.atomically(async (tx) => {
      const saved = readHistoryPuzzleState(await tx.getSetting<unknown>(HISTORY_STATE_SETTING));
      const list = readHistoryPuzzlePending(await tx.getSetting<unknown>(HISTORY_PENDING_SETTING));
      if (!saved || !list) return 0;
      const left = releaseAllowance(saved, today, list.entries.length);
      const listed = new Set(list.entries.map((e) => personalPuzzleId(e.id, e.ply)));
      const done = new Set<string>();
      let count = 0;
      for (const { entry, game } of candidates) {
        const id = personalPuzzleId(entry.id, entry.ply);
        // Another page released it already
        if (!listed.has(id)) continue;
        if (count >= left) break;
        const existing = await tx.getPuzzle(id);
        if (existing) {
          // One of ours that a stop left in the list counts as released; any other (a device review made it) is just dropped
          done.add(id);
          if (existing.origin === 'history') count++;
          continue;
        }
        if (!game) continue;
        const card = newCard(now);
        await tx.savePuzzle({
          ...historyPuzzleRecord(entry, game),
          dueDate: card.dueDate,
          attempts: 0,
          solvedCount: 0,
          updatedAt: now,
        });
        await tx.saveSrsCard(toStoredCard(id, card, now));
        done.add(id);
        count++;
      }
      if (done.size === 0) return 0;
      await tx.setSetting<HistoryPuzzlePending>(HISTORY_PENDING_SETTING, {
        ...list,
        entries: list.entries.filter((e) => !done.has(personalPuzzleId(e.id, e.ply))),
      });
      await tx.setSetting<HistoryPuzzleState>(HISTORY_STATE_SETTING, {
        ...saved,
        released: saved.released + count,
        lastDay: today,
        lastDayCount: (saved.lastDay === today ? saved.lastDayCount : 0) + count,
      });
      return count;
    });
    if (released > 0) this.emit();
    return released;
  }

  /** Puzzle ids due now: cards already seen (any source) first by due time; new personal puzzles after. */
  public async dueQueue(
    now: number = Date.now(),
  ): Promise<{ reviews: StoredSrsCardRecord[]; fresh: StoredSrsCardRecord[] }> {
    const cards = await this.listCards();
    const due = cards.filter((c) => c.dueDate <= now).sort((a, b) => a.dueDate - b.dueDate);
    return { reviews: due.filter((c) => c.state !== 'new'), fresh: due.filter((c) => c.state === 'new') };
  }

  public async todaySummary(now: number = Date.now()): Promise<TodaySummary> {
    const [cards, personal, rating] = await Promise.all([
      this.listCards(),
      this.storage.listPuzzles('personal'),
      this.getRating(),
    ]);
    const personalIds = new Set(personal.map((p) => p.id));
    const dueReviews = { personal: 0, lichess: 0 };
    let newPersonal = 0;
    let nextDueAt: number | null = null;
    for (const c of cards) {
      if (c.state === 'new') {
        if (personalIds.has(c.targetId)) newPersonal++;
        continue;
      }
      if (c.dueDate <= now) {
        if (personalIds.has(c.targetId)) dueReviews.personal++;
        else dueReviews.lichess++;
      } else if (nextDueAt === null || c.dueDate < nextDueAt) {
        nextDueAt = c.dueDate;
      }
    }
    const midnight = startOfLocalDay(now);
    const today = rating.history.filter((h) => h.at >= midnight);
    return {
      dueReviews,
      newPersonal,
      totalPersonal: personal.length,
      nextDueAt,
      ratedToday: today.length,
      ratedSolvedToday: today.filter((h) => h.solved).length,
      rating,
    };
  }
}
