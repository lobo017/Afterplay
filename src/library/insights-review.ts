/**
 * The Insights items that read the engine-review numbers (a batch summary or a review made on this device): accuracy,
 * and blunders and mistakes per 10 moves, by calendar quarter. Pure: no DOM, no storage. Quarters follow the same local
 * calendar days the Games list filters by, so a click on a quarter lists the games the point counted.
 */
import { localDateTime } from '../capture/pgn-time';
import { MIN_REVIEWED_GAMES, type StoryGame } from '../story/stats';
import type { GameFilter } from './game-rows';

/** A quarter becomes a point from this many reviewed games. */
export const MIN_QUARTER_GAMES = 10;

export interface QuarterPoint {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  /** "2023 Q2" */
  label: string;
  /** The quarter's first and last day, "2023-04-01" and "2023-06-30" (the Games list's date filter). */
  from: string;
  to: string;
  games: number;
  /** Mean of the game accuracies, 0–100. */
  accuracy: number;
  /** Blunders and mistakes per 10 of my reviewed moves, over the quarter's games together. */
  blundersPer10: number;
  mistakesPer10: number;
}

export interface ReviewQuarters {
  /** Reviewed games the Story counts (the "so far" of the empty text). */
  reviewed: number;
  /** MIN_REVIEWED_GAMES reviewed games: the charts are drawn. */
  enough: boolean;
  /** Quarters with at least MIN_QUARTER_GAMES reviewed games, oldest first. */
  points: QuarterPoint[];
}

type Quarter = 1 | 2 | 3 | 4;

const n = (v: number): string => v.toLocaleString('en-US');
const FIRST_DAY = ['01-01', '04-01', '07-01', '10-01'] as const;
const LAST_DAY = ['03-31', '06-30', '09-30', '12-31'] as const;

/** The quarter of a day "2023-05-17", or null for text that is not a day. */
export function quarterOfDay(day: string): { year: number; quarter: Quarter } | null {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(day);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(m[1]), quarter: (Math.floor((month - 1) / 3) + 1) as Quarter };
}

export const quarterKey = (p: Pick<QuarterPoint, 'year' | 'quarter'>): string => `${p.year}-Q${p.quarter}`;
/** A position on a time axis that keeps empty quarters as gaps. */
export const quarterX = (p: Pick<QuarterPoint, 'year' | 'quarter'>): number => p.year * 4 + (p.quarter - 1);

interface Sums {
  year: number;
  quarter: Quarter;
  games: number;
  accuracy: number;
  blunders: number;
  mistakes: number;
  moves: number;
}

export function reviewQuarters(games: readonly StoryGame[]): ReviewQuarters {
  const byQuarter = new Map<string, Sums>();
  let reviewed = 0;
  for (const g of games) {
    if (!g.review) continue;
    reviewed++;
    if (g.playedAt === null) continue; // counted as reviewed, but in no quarter
    const q = quarterOfDay(localDateTime(g.playedAt).date);
    if (!q) continue;
    const key = quarterKey(q);
    const e = byQuarter.get(key) ?? { ...q, games: 0, accuracy: 0, blunders: 0, mistakes: 0, moves: 0 };
    e.games++;
    e.accuracy += g.review.accuracy;
    e.blunders += g.review.blunder;
    e.mistakes += g.review.mistake;
    e.moves += g.review.moves;
    byQuarter.set(key, e);
  }
  const points: QuarterPoint[] = [...byQuarter.values()]
    .filter((e) => e.games >= MIN_QUARTER_GAMES)
    .sort((a, b) => a.year - b.year || a.quarter - b.quarter)
    .map((e) => ({
      year: e.year,
      quarter: e.quarter,
      label: `${e.year} Q${e.quarter}`,
      from: `${e.year}-${FIRST_DAY[e.quarter - 1]}`,
      to: `${e.year}-${LAST_DAY[e.quarter - 1]}`,
      games: e.games,
      accuracy: e.accuracy / e.games,
      blundersPer10: (e.blunders / e.moves) * 10,
      mistakesPer10: (e.mistakes / e.moves) * 10,
    }));
  return { reviewed, enough: reviewed >= MIN_REVIEWED_GAMES, points };
}

/** What a click on a quarter's point asks the Games list for: that quarter's days, reviewed games only. */
export function quarterFilter(p: Pick<QuarterPoint, 'from' | 'to'>): Partial<GameFilter> {
  return { from: p.from, to: p.to, minAccuracy: 0 };
}

// ------------------------------------------------------------------------------------------------------------ texts

const one = (v: number): string => v.toFixed(1);

/** "Needs 20 reviewed games (4 so far)." */
export const needsReviewedText = (reviewed: number): string =>
  `Needs ${MIN_REVIEWED_GAMES} reviewed games (${n(reviewed)} so far).`;
export const NO_QUARTER_TEXT = `No quarter has ${MIN_QUARTER_GAMES} reviewed games yet.`;

/** "2023 Q2: 79.4% over 212 games" */
export const accuracyPointLabel = (p: QuarterPoint): string =>
  `${p.label}: ${one(p.accuracy)}% over ${n(p.games)} games`;
/** "2023 Q2: 0.8 blunders and 1.7 mistakes per 10 moves over 212 games" */
export const errorsPointLabel = (p: QuarterPoint): string =>
  `${p.label}: ${one(p.blundersPer10)} blunders and ${one(p.mistakesPer10)} mistakes per 10 moves over ${n(p.games)} games`;

/** The first and last quarter in words, for a reader who cannot hover a point; null with fewer than two points. */
export function accuracyEnds(points: readonly QuarterPoint[]): string | null {
  if (points.length < 2) return null;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  return `From ${a.label} (${one(a.accuracy)}%) to ${b.label} (${one(b.accuracy)}%).`;
}

export function errorsEnds(points: readonly QuarterPoint[]): string | null {
  if (points.length < 2) return null;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  return `From ${a.label} (${one(a.blundersPer10)} blunders, ${one(a.mistakesPer10)} mistakes) to ${b.label} (${one(b.blundersPer10)} blunders, ${one(b.mistakesPer10)} mistakes), per 10 moves.`;
}

/** The header line: full reviews, then (only when there are some) games reviewed in advance, then all of mine. */
export function insightsSummary(c: { reviewed: number; inAdvance: number; mine: number }): string {
  return `${n(c.reviewed)} reviewed game${c.reviewed === 1 ? '' : 's'} of yours${
    c.inAdvance > 0 ? ` · ${n(c.inAdvance)} reviewed in advance` : ''
  } · ${n(c.mine)} of yours in all`;
}

/** The empty text of the old cards (they need a full review made here). */
export function needReviewsText(c: { inAdvance: number; noneMarked: boolean }): string {
  if (c.inAdvance > 0) {
    const advance =
      c.inAdvance === 1
        ? '1 game was reviewed in advance; its numbers are below.'
        : `${n(c.inAdvance)} games were reviewed in advance; their numbers are below.`;
    return `These need a game reviewed on this device (Games › Analyze). ${advance}`;
  }
  return `Review some of your games (Games › Analyze) to see this.${
    c.noneMarked ? ' None of your games are marked yours yet: set your usernames in Settings › Your games.' : ''
  }`;
}
