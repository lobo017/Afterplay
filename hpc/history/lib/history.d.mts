export declare const USER_AGENT: string;
export declare const API_ROOT: string;
export declare const BACKUP_FORMAT: 'wizards-chess-backup';
export declare const HISTORY_METHOD: string;

export declare function isValidUsername(name: unknown): boolean;
export declare function archiveMonth(url: unknown, username: string): string | null;
export declare function archiveUrl(username: string, month: string): string;

export interface FetchedResponse {
  status: number;
  text(): Promise<string>;
}

export interface DownloadOptions {
  username: string;
  fetchImpl: (
    url: string,
    init: { headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal },
  ) => Promise<FetchedResponse>;
  sleep: (ms: number) => Promise<void>;
  /** Stores one month's text as it was served; returns its size in bytes. */
  save: (month: string, text: string) => number | Promise<number>;
  log?: (line: string) => void;
  delayMs?: number;
  timeoutMs?: number;
}

export interface DownloadResult {
  ok: boolean;
  /** Why the archive list could not be used (only when `ok` is false). */
  reason: string | null;
  months: string[];
  saved: Array<{ month: string; bytes: number; games: number }>;
  failed: Array<{ month: string; reason: string }>;
  retried: string[];
  ignored: number;
}

export declare function downloadArchives(options: DownloadOptions): Promise<DownloadResult>;
export declare function formatBytes(bytes: number): string;
export declare function formatDownloadSummary(result: DownloadResult): string;

/** One game of a monthly archive file, as far as these scripts read it. */
export interface ArchiveGame {
  url?: string;
  uuid?: string;
  pgn?: string;
  end_time?: number;
  rated?: boolean;
  time_class?: string;
  time_control?: string;
  rules?: string;
  eco?: string;
  white?: { username?: string; rating?: number; result?: string };
  black?: { username?: string; rating?: number; result?: string };
}

export interface MonthArchive {
  month: string;
  games: unknown;
}

export declare function collectGames(archives: readonly MonthArchive[]): {
  games: ArchiveGame[];
  duplicates: number;
  malformed: number;
};

export declare function readHeaders(pgn: unknown): Record<string, string>;
export type Outcome = 'win' | 'loss' | 'draw' | 'other';
export declare function outcomeOf(code: unknown): Outcome;
export declare function openingNameFromUrl(url: unknown): string;
export declare function timeControlLabel(tc: unknown): string;

export interface PlayerView {
  colour: 'white' | 'black';
  opponent: string;
  outcome: Outcome;
  at: number | null;
  year: number | null;
  rules: string;
  timeClass: string;
  timeControl: string;
  rated: boolean;
  pool: string;
  myRating: number | null;
  opponentRating: number | null;
  eco: string;
  opening: string;
}

export declare function playerView(game: ArchiveGame, player: string): PlayerView | null;

export interface Tally {
  games: number;
  win: number;
  loss: number;
  draw: number;
  other: number;
}

export interface NamedTally extends Tally {
  name: string;
}

export interface RatingPoint {
  rating: number;
  at: number | null;
}

export interface RatingPool {
  name: string;
  games: number;
  first: RatingPoint;
  last: RatingPoint;
  peak: RatingPoint;
  lowest: RatingPoint;
  years: Array<{ year: number; rating: number }>;
}

export interface OpponentRecord extends NamedTally {
  firstAt: number | null;
  lastAt: number | null;
}

export interface HistoryStats {
  total: number;
  mine: number;
  notMine: number;
  rated: number;
  unrated: number;
  firstAt: number | null;
  lastAt: number | null;
  results: Tally;
  colour: { white: Tally; black: Tally };
  years: NamedTally[];
  rules: NamedTally[];
  timeClasses: NamedTally[];
  timeControls: Array<NamedTally & { label: string }>;
  /** `name` is the ECO code ("none" when the game has none), `opening` its most frequent name. */
  openings: Array<NamedTally & { opening: string }>;
  ratings: RatingPool[];
  opponents: OpponentRecord[];
}

export declare function computeStats(games: readonly ArchiveGame[], player: string): HistoryStats;
export declare function shortlistOpponents(opponents: readonly OpponentRecord[], max?: number): OpponentRecord[];
export declare function formatSummary(stats: HistoryStats): string;
export declare function formatReport(stats: HistoryStats): string;
export declare function formatShortlist(list: readonly OpponentRecord[]): string;

/** The app's own functions the restore file is built with (loaded from src/ by the caller). */
export interface RestoreDeps<TGame, TRecord> {
  importProblemOf: (pgn: string) => { kind: string } | null;
  checkPgnText: (pgn: string) => { games: TGame[]; errors: string[] };
  buildGameRecord: (game: TGame, meta: { capturedAt: number | null; method: string }) => TRecord;
  schemaVersion: number;
}

export interface RestoreResult<TRecord> {
  payload: {
    format: 'wizards-chess-backup';
    schemaVersion: number;
    exportedAt: number;
    games: Array<TRecord & { playerColor: 'w' | 'b'; schemaVersion: number; createdAt: number; updatedAt: number }>;
    settings: never[];
    puzzles: never[];
    srsCards: never[];
    repertoires: never[];
    endgameProgress: never[];
    reviews: never[];
  };
  read: number;
  written: number;
  skipped: { noPgn: number; variant: number; noMoves: number; invalid: number; duplicate: number };
  withoutSiteId: number;
  notMine: number;
}

export declare function buildRestorePayload<
  TGame extends { source: string },
  TRecord extends { id: string; white: string; black: string; playedAt?: number | null },
>(
  games: readonly ArchiveGame[],
  player: string,
  deps: RestoreDeps<TGame, TRecord>,
  now: number,
): RestoreResult<TRecord>;

export declare function formatRestoreSummary(result: RestoreResult<unknown>, bytes: number): string;
