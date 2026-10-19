import type { PuzzleEntry } from '../core/datasets';
import type { UserAccount } from '../review/perspective';
import type { SavedReview } from '../library/saved-review';
import type { StoredGameRecord, StoredPuzzleRecord, StoredSrsCardRecord, WizardChessStorage } from '../storage/db';
import { newCard, reviewCard, type SrsCard } from './fsrs';
import { DEFAULT_PLAYER, ratePuzzleAttempt, type GlickoRating } from './glicko2';
import { scanPersonalPuzzles, type PersonalPuzzle } from './personal-puzzles';
import type { AttemptOutcome } from './puzzle-session';

const RATING_SETTING = 'puzzles.rating';
const SYNC_SETTING = 'puzzles.personalSync';
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
      const history = [...rating.history, { at: now, rating: next.rating, puzzleId: puzzle.id, solved: outcome.solved }];
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
    const existing =
      existingForGame ?? (await this.storage.listPuzzles('personal')).filter((p) => p.sourceGameId === record.id);
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
        await this.storage.savePuzzle({ ...prev, ...p, updatedAt: now });
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
      const savedAt = game.analysis?.savedAt;
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
    if (state.accountsKey === key && game.analysis?.savedAt !== undefined) {
      await this.storage.setSetting(SYNC_SETTING, { ...state, games: { ...state.games, [game.id]: game.analysis.savedAt } });
    }
    this.emit();
    return ids;
  }

  /** Puzzle ids due now: cards already seen (any source) first by due time; new personal puzzles after. */
  public async dueQueue(now: number = Date.now()): Promise<{ reviews: StoredSrsCardRecord[]; fresh: StoredSrsCardRecord[] }> {
    const cards = await this.listCards();
    const due = cards.filter((c) => c.dueDate <= now).sort((a, b) => a.dueDate - b.dueDate);
    return { reviews: due.filter((c) => c.state !== 'new'), fresh: due.filter((c) => c.state === 'new') };
  }

  public async todaySummary(now: number = Date.now()): Promise<TodaySummary> {
    const [cards, personal, rating] = await Promise.all([this.listCards(), this.storage.listPuzzles('personal'), this.getRating()]);
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
