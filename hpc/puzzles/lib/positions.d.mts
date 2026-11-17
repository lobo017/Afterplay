import type { GameTree } from '../../../src/core/game-tree';

export declare const PUZZLE_FORMAT: 'afterplay-mistake-puzzles';
export declare const PUZZLE_VERSION: 1;
export declare const PUZZLE_SHARDS: number;
export declare const MAX_PUZZLES_BYTES: number;
export declare const SETTINGS: Record<string, string | number | boolean>;
export declare const SELECTION_REASONS: string[];
export declare const DROP_REASONS: string[];

export interface Score {
  type: 'cp' | 'mate';
  value: number;
}
export interface Line {
  multipv: number;
  score: Score;
  pv: string[];
}

/** The app's own functions the script uses (hpc/puzzles/lib/app.mjs loads the real ones). */
export interface Deps {
  parsePgn: (pgn: string) => GameTree;
  isStandardGame: (headers: Readonly<Record<string, string>>) => boolean;
  applyUci: (fen: string, uci: string) => { move: { captured?: string; to: string } } | null;
  lineToSan: (fen: string, line: readonly string[], maxPlies?: number) => string[];
  winPercentFromScore: (score: Score) => number;
  CLASS_THRESHOLDS: { mistake: number; blunder: number };
  classFromWinDrop: (drop: number) => string;
}

export interface Plan {
  id: string;
  color: 'w' | 'b';
  ply: number;
  storedDrop: number;
  plies: number;
  rootFen: string;
  ucis: string[];
  fenSetup: string;
  fenBefore: string;
  setupUci: string;
  setupSan: string;
  setupTo: string | null;
  setupCaptured: boolean;
  playedUci: string;
  playedSan: string;
  playedColor: 'w' | 'b';
}
export interface Kept {
  bestUci: string;
  winBefore: number;
  mateIn: number | null;
  bestLineSan: string[];
}
export interface Entry {
  id: string;
  ply: number;
  fen: string;
  moves: [string, string];
  bestLineSan: string[];
  playedSan: string;
  class: string;
  loss: number;
  before: number;
  after: number;
  mateIn: number | null;
}
export interface Selection {
  games: number;
  candidates: Plan[];
  reasons: Record<string, number>;
}

export declare function replayToPly(
  tree: GameTree,
  ply: number,
): Omit<Plan, 'id' | 'color' | 'ply' | 'storedDrop'> | null;
export declare function selectGame(
  record: Record<string, unknown>,
  deps: Deps,
): { ok: true; plan: Plan } | { ok: false; reason: string };
export declare function selectGames(games: readonly Record<string, unknown>[], deps: Deps): Selection;
export declare function shardOf(candidates: readonly Plan[], shard: number, shards: number): Plan[];
export declare function isTrivialRecapture(plan: Plan, bestUci: string, deps: Deps): boolean;
export declare function judgeBefore(
  plan: Plan,
  before: { lines: readonly Line[] } | null,
  deps: Deps,
): { keep: false; reason: string } | { keep: true; kept: Kept };
export declare function finishPuzzle(
  plan: Plan,
  kept: Kept,
  afterScore: Score | null,
  deps: Deps,
): { keep: false; reason: string } | { keep: true; entry: Entry };

export declare function partFileName(shard: number, shards: number): string;
export interface HeaderMeta {
  input: string;
  engine: string;
  commit: string;
  shard: number;
  shards: number;
}
export declare function headerLine(meta: HeaderMeta): string;
export declare function puzzleLine(entry: Entry): string;
export declare function dropLine(id: string, reason: string): string;
export declare function parsePart(text: string): {
  header: Record<string, unknown> | null;
  entries: Entry[];
  drops: { id: string; reason: string }[];
  ids: Set<string>;
  rewrite: boolean;
  cleanText: string;
};
export declare function resumePlan(args: { text: string; expected: HeaderMeta; ids: readonly string[] }): {
  resumed: boolean;
  done: Set<string>;
  todo: string[];
  cleanText: string;
  rewrite: boolean;
};
export declare function mergeParts(args: {
  parts: readonly string[];
  candidates: readonly Pick<Plan, 'id'>[];
  selection: { games: number; reasons: Record<string, number> };
  input: string;
  shards: number;
  allowPartial?: boolean;
}): { text: string; countsText: string; counts: Record<string, unknown> & { kept: number; left: number } };
export declare function sha256Hex(data: string | Uint8Array): string;
