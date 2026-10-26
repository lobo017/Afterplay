import type { StoredSrsCardRecord, WizardChessStorage } from '../storage/db';
import { newCard, reviewCard, type Grade, type SrsCard } from './fsrs';

/** The decks of `srs_cards` the Phase 7 trainers use (puzzles keep their own ids in puzzle-store). */
export type DrillDeck = Exclude<StoredSrsCardRecord['deck'], 'puzzle'>;

/** `deck:target`, the same shape the puzzle deck uses (`puzzle:<id>`). */
export function drillCardId(deck: StoredSrsCardRecord['deck'], targetId: string): string {
  return `${deck}:${targetId}`;
}

export function toStoredCard(
  deck: StoredSrsCardRecord['deck'],
  targetId: string,
  card: SrsCard,
  now: number,
): StoredSrsCardRecord {
  return {
    id: drillCardId(deck, targetId),
    deck,
    targetId,
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

/** A card that exists but has never been graded (it waits to be learned). */
export function freshCardRecord(deck: StoredSrsCardRecord['deck'], targetId: string, now: number): StoredSrsCardRecord {
  return toStoredCard(deck, targetId, newCard(now), now);
}

/**
 * Grades a card (a new one is made when there is none) with FSRS and stores it. Returns the
 * stored card and whether it was the first grade.
 */
export async function gradeStoredCard(
  storage: WizardChessStorage,
  deck: StoredSrsCardRecord['deck'],
  targetId: string,
  grade: Grade,
  now: number,
): Promise<StoredSrsCardRecord> {
  const existing = await storage.getSrsCard(drillCardId(deck, targetId));
  const current: SrsCard = existing ?? newCard(now);
  const card = toStoredCard(deck, targetId, reviewCard(current, grade, now), now);
  await storage.saveSrsCard(card);
  return card;
}

/** A card is due for review when it has been graded before and its time has come. */
export function isDueReview(card: StoredSrsCardRecord, now: number): boolean {
  return card.state !== 'new' && card.dueDate <= now;
}
