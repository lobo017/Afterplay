import type { StoredGameRecord, StoredPuzzleRecord } from '../storage/db';
import { personalPuzzleId } from './personal-puzzles';
import { preparePuzzle } from './puzzle-format';

/**
 * Puzzles made offline from a player's history (hpc/puzzles/, `gift.local/history/puzzles.json`), shipped beside a
 * first-run link and released a few at a time as ordinary personal puzzles. This file is the pure part: the strict
 * check of the file, the record a puzzle becomes and the release schedule. Nothing here reads a network or a database.
 */

export const HISTORY_PUZZLE_FORMAT = 'afterplay-mistake-puzzles';
export const HISTORY_PUZZLE_VERSION = 1;
/** The file is refused above this size (the real one is about 170 KB for 600 puzzles). */
export const MAX_PUZZLE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_PUZZLE_ENTRIES = 5000;
/** Released when the file is first loaded, and the most released on any later local day. */
export const FIRST_BATCH = 50;
export const DAILY_BATCH = 20;

/** What the app keeps of a file's entry: the position, the two moves and what the explanation needs. Nothing else. */
export interface HistoryPuzzleEntry {
  /** The id of the source game (`chesscom:…`). */
  id: string;
  /** The ply of the player's move in that game (1 is White's first move). */
  ply: number;
  /** The position before the opponent's last move. */
  fen: string;
  /** UCI: the opponent's move, then the best move. */
  moves: [string, string];
  bestLineSan: string[];
  playedSan: string;
  class: 'Mistake' | 'Blunder';
  /** Win% the played move gave up. */
  loss: number;
  /** A forced mate in this many moves (at most 5), or null. */
  mateIn: number | null;
}

export interface HistoryPuzzleFile {
  /** The marker of the history file the puzzles were made from (12 hex digits). */
  input: string;
  entries: HistoryPuzzleEntry[];
}

export type HistoryPuzzleParse = ({ ok: true } & HistoryPuzzleFile) | { ok: false; reason: string };

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const SAN = /^[A-Za-z0-9=+#-]{2,10}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function checkEntry(raw: unknown, index: number): { entry: HistoryPuzzleEntry } | { reason: string } {
  const bad = (what: string) => ({ reason: `entry ${index}: ${what}` });
  if (!isObject(raw)) return bad('not an object');
  const { id, ply, fen, moves, bestLineSan, playedSan, mateIn, loss } = raw;
  if (typeof id !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(id)) return bad('bad game id');
  if (!isCount(ply, 2, 2000)) return bad('bad ply');
  if (typeof fen !== 'string' || fen.length > 120) return bad('bad position');
  if (!Array.isArray(moves) || moves.length !== 2 || !moves.every((m) => typeof m === 'string' && UCI.test(m))) {
    return bad('bad moves');
  }
  if (
    !Array.isArray(bestLineSan) ||
    bestLineSan.length < 1 ||
    bestLineSan.length > 12 ||
    !bestLineSan.every((m) => typeof m === 'string' && SAN.test(m))
  ) {
    return bad('bad best line');
  }
  if (typeof playedSan !== 'string' || !SAN.test(playedSan)) return bad('bad played move');
  if (raw.class !== 'Mistake' && raw.class !== 'Blunder') return bad('bad class');
  if (typeof loss !== 'number' || !Number.isFinite(loss) || loss < 0 || loss > 100) return bad('bad loss');
  if (mateIn !== null && !isCount(mateIn, 1, 5)) return bad('bad mate length');
  // The app's own chess rules: a legal position, a legal setup move and a legal best move after it
  let prepared;
  try {
    prepared = preparePuzzle({ id: `${id}:${ply}`, fen, moves: [moves[0] as string, moves[1] as string] });
  } catch {
    return bad('illegal position or move');
  }
  if (prepared.playerColor !== (ply % 2 === 1 ? 'w' : 'b')) return bad('the side to move does not match the ply');
  if (prepared.solutionSan[0] !== bestLineSan[0]) return bad('the best line does not start with the best move');
  return {
    entry: {
      id,
      ply,
      fen,
      moves: [moves[0] as string, moves[1] as string],
      bestLineSan: [...(bestLineSan as string[])],
      playedSan,
      class: raw.class,
      loss,
      mateIn: mateIn as number | null,
    },
  };
}

/**
 * Reads a puzzle file's text. Strict: the whole file is refused when anything is off (a page of HTML where the file
 * should be, another format or version, a wrong count, one illegal position or move). Never throws.
 */
function* parseSteps(text: string): Generator<void, HistoryPuzzleParse> {
  if (typeof text !== 'string' || text === '') return { ok: false, reason: 'empty' };
  if (text.length > MAX_PUZZLE_FILE_BYTES) return { ok: false, reason: 'too large' };
  if (/^\s*</.test(text)) return { ok: false, reason: 'a page, not a file' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  if (!isObject(json)) return { ok: false, reason: 'not an object' };
  if (json.format !== HISTORY_PUZZLE_FORMAT) return { ok: false, reason: 'another format' };
  if (json.version !== HISTORY_PUZZLE_VERSION) return { ok: false, reason: 'another version' };
  if (typeof json.input !== 'string' || !/^[0-9a-f]{12}$/.test(json.input))
    return { ok: false, reason: 'no input marker' };
  const list = json.entries;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_PUZZLE_ENTRIES) {
    return { ok: false, reason: 'no puzzles, or too many' };
  }
  if (json.count !== list.length) return { ok: false, reason: 'the count is wrong' };
  const entries: HistoryPuzzleEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const checked = checkEntry(list[i], i);
    if ('reason' in checked) return { ok: false, reason: checked.reason };
    const key = personalPuzzleId(checked.entry.id, checked.entry.ply);
    if (seen.has(key)) return { ok: false, reason: `entry ${i}: listed twice` };
    seen.add(key);
    entries.push(checked.entry);
    // A point where a caller that must not block the page can let it breathe (the position checks are the slow part)
    if (i % CHECKS_PER_STEP === CHECKS_PER_STEP - 1) yield;
  }
  return { ok: true, input: json.input, entries };
}

/** Entries checked between two yields of the async reader (about 10 ms of work). */
const CHECKS_PER_STEP = 20;

/** The check in one go (tests, small files). */
export function parseHistoryPuzzleFile(text: string): HistoryPuzzleParse {
  const steps = parseSteps(text);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** The same check, letting the page run between every few entries, so 600 puzzles never make one long task. */
export async function parseHistoryPuzzleFileAsync(
  text: string,
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<HistoryPuzzleParse> {
  const steps = parseSteps(text);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
    await pause();
  }
}

// ------------------------------------------------------------------------------------------------ the puzzle record

/** The part of a stored game a released puzzle needs. */
export type HistoryGameInfo = Pick<StoredGameRecord, 'id' | 'date'>;

/** "as White · 2026-10-04": the color and the date, never a name. */
export function historyGameLabel(ply: number, date: string | undefined): string {
  const color = ply % 2 === 1 ? 'White' : 'Black';
  const day = date ? date.replace(/\./g, '-') : '';
  return day === '' ? `as ${color}` : `as ${color} · ${day}`;
}

export function historyExplanation(entry: HistoryPuzzleEntry): string {
  if (entry.mateIn !== null) {
    return `Instead of ${entry.playedSan}, there was a forced mate in ${entry.mateIn}.`;
  }
  return `${entry.playedSan} gave up about ${Math.round(entry.loss)}% of your winning chances.`;
}

export type HistoryPuzzleRecord = Omit<StoredPuzzleRecord, 'dueDate' | 'attempts' | 'solvedCount' | 'updatedAt'>;

/** The personal puzzle an entry becomes (the store adds its card and counters). */
export function historyPuzzleRecord(entry: HistoryPuzzleEntry, game: HistoryGameInfo): HistoryPuzzleRecord {
  return {
    id: personalPuzzleId(entry.id, entry.ply),
    source: 'personal',
    fen: entry.fen,
    moves: [...entry.moves],
    rating: 0,
    themes: [entry.class.toLowerCase(), ...(entry.mateIn !== null ? ['mate'] : [])],
    sourceGameId: entry.id,
    ply: entry.ply,
    playedSan: entry.playedSan,
    classification: entry.class,
    explanation: historyExplanation(entry),
    bestLineSan: [...entry.bestLineSan],
    gameLabel: historyGameLabel(entry.ply, game.date),
    origin: 'history',
  };
}

// ----------------------------------------------------------------------------------------------- order and schedule

/** When a game was played (ms), or null when the record does not say. */
export function gameTime(game: Pick<StoredGameRecord, 'playedAt' | 'date'>): number | null {
  if (typeof game.playedAt === 'number' && Number.isFinite(game.playedAt)) return game.playedAt;
  const m = /^(\d{4})\.(\d{2}|\?\?)\.(\d{2}|\?\?)$/.exec(game.date ?? '');
  if (!m) return null;
  return Date.UTC(Number(m[1]), (m[2] === '??' ? 1 : Number(m[2])) - 1, m[3] === '??' ? 1 : Number(m[3]));
}

/** Newest source game first; games the library does not know come last; ties by game id, then ply. */
export function orderNewestFirst(
  entries: readonly HistoryPuzzleEntry[],
  timeOf: ReadonlyMap<string, number | null>,
): HistoryPuzzleEntry[] {
  const time = (e: HistoryPuzzleEntry): number => timeOf.get(e.id) ?? Number.NEGATIVE_INFINITY;
  return [...entries].sort((a, b) => {
    const d = time(b) - time(a);
    if (d !== 0 && !Number.isNaN(d)) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : a.ply - b.ply;
  });
}

/** What the device remembers about the file it loaded (settings key `puzzles.fromHistory.state`). */
export interface HistoryPuzzleState {
  version: 1;
  slug: string;
  input: string;
  /** The local day the file was loaded, `YYYY-MM-DD`. */
  loadedDay: string;
  total: number;
  /** Puzzles released so far, the first batch included. */
  released: number;
  /** The local day of the last release and how many that day held. */
  lastDay: string;
  lastDayCount: number;
}

/** The pending puzzles (settings key `puzzles.fromHistory.pending`): one blob, already in release order. */
export interface HistoryPuzzlePending {
  version: 1;
  input: string;
  entries: HistoryPuzzleEntry[];
}

/** Local calendar day of a time, `YYYY-MM-DD`. */
export function localDay(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d!) / 86_400_000);
}

/**
 * How many puzzles may be released now. The first day holds up to 50; every later day adds 20 to what is owed, and a
 * day with more owed (the app was not opened) still releases at most 20, so the rest follows on the next days.
 */
export function releaseAllowance(state: HistoryPuzzleState, today: string, pending: number): number {
  const sinceLoad = Math.max(0, dayNumber(today) - dayNumber(state.loadedDay));
  const owed = Math.max(0, FIRST_BATCH + DAILY_BATCH * sinceLoad - state.released);
  const cap = today === state.loadedDay ? FIRST_BATCH : DAILY_BATCH;
  const usedToday = state.lastDay === today ? state.lastDayCount : 0;
  return Math.max(0, Math.min(cap - usedToday, owed, pending));
}

/** A stored state, or undefined when it is not one of ours. */
export function readHistoryPuzzleState(value: unknown): HistoryPuzzleState | undefined {
  if (!isObject(value) || value.version !== 1) return undefined;
  const day = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  const { slug, input, loadedDay, total, released, lastDay, lastDayCount } = value;
  if (typeof slug !== 'string' || typeof input !== 'string' || !day(loadedDay) || !day(lastDay)) return undefined;
  if (!num(total) || !num(released) || !num(lastDayCount)) return undefined;
  return { version: 1, slug, input, loadedDay, total, released, lastDay, lastDayCount };
}

/** A stored pending blob, or undefined when it is not one of ours (the entries were checked before they were stored). */
export function readHistoryPuzzlePending(value: unknown): HistoryPuzzlePending | undefined {
  if (!isObject(value) || value.version !== 1 || typeof value.input !== 'string' || !Array.isArray(value.entries)) {
    return undefined;
  }
  const entries: HistoryPuzzleEntry[] = [];
  for (const raw of value.entries) {
    const e = raw as Partial<HistoryPuzzleEntry> | null;
    if (
      !e ||
      typeof e.id !== 'string' ||
      typeof e.ply !== 'number' ||
      !Array.isArray(e.moves) ||
      e.moves.length !== 2
    ) {
      return undefined;
    }
    entries.push(e as HistoryPuzzleEntry);
  }
  return { version: 1, input: value.input, entries };
}
