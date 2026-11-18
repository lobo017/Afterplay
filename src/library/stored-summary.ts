/**
 * What the Review panel shows for a Games list game that has no review on this device: my side's numbers from a review
 * made in advance (a batch summary: accuracy, counts and accuracy by game phase, no per-move data), and the texts around
 * the "Review this game" button. Pure: no DOM, no storage.
 */
import type { Color } from '../core/rules';
import { storedKeyMoment, type UserAccount } from '../review/perspective';
import type { MoveClassification, ReviewPreset } from '../review/types';
import type { StoredGameRecord } from '../storage/db';
import { myColor } from './game-record';
import { PHASES, PHASE_LABEL, type GamePhase } from './insights';
import { readReviewNumbers, type ReviewNumbers } from './review-numbers';

/**
 * My side's numbers from a review made in advance, or null: the game has no such review (none at all, or one made on this
 * device, which opens as a full review instead), or its numbers are not usable. My side comes from my usernames; when they
 * do not name a side, from the one side the summary holds (a review made in advance stores only the player's side).
 */
export function storedNumbersFor(
  record: StoredRecordForSummary,
  accounts: readonly UserAccount[],
): ReviewNumbers | null {
  const color = storedColor(record, accounts);
  if (!color) return null;
  const numbers = readReviewNumbers(record, color);
  return numbers?.source === 'advance' ? numbers : null;
}

type StoredRecordForSummary = Pick<StoredGameRecord, 'analysis' | 'white' | 'black' | 'source' | 'playerColor'>;

/** The side a summary made in advance is about, or null (no such summary, or no way to tell the side). */
function storedColor(record: StoredRecordForSummary, accounts: readonly UserAccount[]): Color | null {
  const a = record.analysis;
  if (!a || a.summaryOnly !== true) return null;
  const stored = (['w', 'b'] as const).filter((c) => a.sides?.[c]);
  return myColor(record, accounts) ?? (stored.length === 1 ? stored[0]! : null);
}

export interface StoredMoment {
  color: Color;
  /** The ply of my move with the largest win% loss (1 = White's first move). */
  ply: number;
  /** The loss for me, in win% points (negative). */
  swing: number;
}

/**
 * The key moment a summary made in advance can name: my move with the largest win% loss (the summary stores its ply and
 * size, no classes per move). Null when the game has no usable summary, or no move lost enough to count.
 */
export function storedMomentFor(record: StoredRecordForSummary, accounts: readonly UserAccount[]): StoredMoment | null {
  const color = storedColor(record, accounts);
  if (!color || storedNumbersFor(record, accounts) === null) return null;
  const moment = storedKeyMoment(record.analysis?.sides?.[color], color);
  return moment ? { color, ...moment } : null;
}

export interface StoredTile {
  key: 'mistake' | 'blunder' | 'brilliant' | 'great';
  value: number;
  /** "mistakes", "1 blunder": the words under the number. */
  label: string;
}

export interface StoredPhaseRow {
  phase: GamePhase;
  label: string;
  /** "93.1%" */
  accuracy: string;
  /** 0–1, for the bar. */
  share: number;
}

/** One row of the stored "How you played" fold: only the classes a summary counts. */
export interface StoredClassRow {
  cls: MoveClassification;
  count: number;
}

/** The classes a summary made in advance counts, in the review's order (Miss before Blunder). */
export const STORED_CLASSES = ['Brilliant', 'Great', 'Inaccuracy', 'Mistake', 'Miss', 'Blunder'] as const;

export interface StoredSummaryView {
  /** "87.3%" */
  accuracy: string;
  tiles: StoredTile[];
  /** My count of each class the summary holds (Best, Excellent, Good and Book are not stored). */
  classes: StoredClassRow[];
  /** Phases with at least one of my moves, in game order; empty when the summary has no phase numbers. */
  phases: StoredPhaseRow[];
}

const LABELS: Record<StoredTile['key'], [one: string, many: string]> = {
  mistake: ['mistake', 'mistakes'],
  blunder: ['blunder', 'blunders'],
  brilliant: ['brilliant move', 'brilliant moves'],
  great: ['great move', 'great moves'],
};

const percent = (v: number): string => `${v.toFixed(1)}%`;

export function storedSummaryView(n: ReviewNumbers): StoredSummaryView {
  const tiles = (['mistake', 'blunder', 'brilliant', 'great'] as const).map((key) => ({
    key,
    value: n[key],
    label: LABELS[key][n[key] === 1 ? 0 : 1],
  }));
  const phases = n.phases
    ? PHASES.flatMap((phase, i) => {
        const t = n.phases![i]!;
        if (t[0] === 0) return [];
        return [
          { phase, label: PHASE_LABEL[phase], accuracy: percent(t[1]), share: Math.min(1, Math.max(0, t[1] / 100)) },
        ];
      })
    : [];
  const classes = STORED_CLASSES.map((cls) => ({
    cls,
    count: n[cls.toLowerCase() as 'brilliant' | 'great' | 'inaccuracy' | 'mistake' | 'miss' | 'blunder'],
  }));
  return { accuracy: percent(n.accuracy), tiles, classes, phases };
}

// ------------------------------------------------------------------------------------------------------------ texts

export const STORED_TITLE = 'Your numbers from this game';
export const STORED_ACCURACY_LABEL = 'accuracy';
export const STORED_PHASES_TITLE = 'Accuracy by game phase';
/** The button, before and after a run that did not finish. */
export const REVIEW_BUTTON_TEXT = 'Review this game';

const HELP_START = 'Checks every move and shows where the game turned.';

/**
 * The line under the button: what the review adds and how long it takes. Only Quick gives a time; the slower settings
 * say so without numbers.
 */
export const reviewHelpText = (preset: ReviewPreset): string =>
  preset === 'quick'
    ? `${HELP_START} Takes about 10 to 20 seconds on a phone (longer for very long games).`
    : `${HELP_START} Takes longer at this speed.`;

/** The button while the review runs. */
export const reviewRunningText = (done: number, total: number): string =>
  `Reviewing… move ${done} of ${total > 0 ? total : '…'}`;

/** The status line before a review: with stored numbers, and with none. */
export const storedIdleStatus = (hasNumbers: boolean, tap: string): string =>
  hasNumbers ? `${tap} Review this game to see every move.` : `Not reviewed yet. ${tap} Review this game.`;

export const CANCELED_STATUS = 'Review canceled. Nothing was changed.';
export const FAILED_STATUS = 'Review not finished';

/** The short message after a review that failed. */
export const reviewFailedText = (hasNumbers: boolean): string =>
  hasNumbers
    ? 'The review could not finish. Your numbers above are unchanged. You can try again.'
    : 'The review could not finish. You can try again.';
