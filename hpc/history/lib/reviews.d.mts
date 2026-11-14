export declare const REVIEW_FORMAT: 'afterplay-engine-review';
export declare const REVIEW_VERSION: 1;
export declare const MAX_RESTORE_BYTES: number;
export declare const CLASS_LETTERS: Record<
  'Brilliant' | 'Great' | 'Best' | 'Excellent' | 'Good' | 'Book' | 'Inaccuracy' | 'Mistake' | 'Blunder' | 'Miss',
  string
>;

export declare function sha256Hex(data: string | Uint8Array): string;
export declare function moveHash(moves: readonly string[]): string;
export declare function canonicalJson(value: unknown): string;
export declare function makeDirGuard(dir: string): (...parts: string[]) => string;
export declare function partFileName(chunk: number, chunks: number): string;
export declare function chunkIds(ids: readonly string[], chunk: number, chunks: number): string[];

export interface HeaderMeta {
  input: string;
  settings: Record<string, unknown>;
  engine: string;
  commit: string;
  chunk: number;
  chunks: number;
}
export declare function headerLine(meta: HeaderMeta): string;
export declare function headerMismatches(found: unknown, expected: unknown): string[];

export interface ReviewSummaryLine {
  whiteAccuracy: number | null;
  blackAccuracy: number | null;
  depth?: number;
  plies: number;
  sides: { w?: Record<string, unknown>; b?: Record<string, unknown> };
}
export interface GameEntry {
  kind: 'game';
  id: string;
  hash: string;
  summary: ReviewSummaryLine;
  win: number[];
  classes: string;
}
export interface SkipEntry {
  kind: 'skip';
  id: string;
  reason: string;
}
export declare function entryProblem(e: unknown): string | null;
export declare function gameLine(e: Omit<GameEntry, 'kind'>): string;
export declare function skipLine(e: Omit<SkipEntry, 'kind'>): string;

export interface ParsedPart {
  header: (HeaderMeta & { kind: 'header'; format: string; version: number }) | null;
  entries: Array<GameEntry | SkipEntry>;
  ids: Set<string>;
  dropped: boolean;
  cleanText: string;
  rewrite: boolean;
}
export declare function parsePart(text: string): ParsedPart;
export declare function resumePlan(args: { text: string; expected: HeaderMeta; ids: readonly string[] }): {
  resumed: boolean;
  done: Set<string>;
  todo: string[];
  cleanText: string;
  rewrite: boolean;
};

export interface WritableFs {
  writeFileSync(file: string, text: string): void;
  renameSync(from: string, to: string): void;
}
export declare function writeThroughRename(
  fs: WritableFs,
  file: string,
  text: string,
  options?: { protect?: readonly string[] },
): number;

export declare function mergeReviews(args: {
  payload: { games: Array<{ id: string; playerColor?: string } & Record<string, unknown>> } & Record<string, unknown>;
  parts: ReadonlyArray<{ text: string }>;
  expected: { input: string; settings: Record<string, unknown>; engine: string };
  movesOf: (game: never) => string[];
  now: number;
  allowPartial?: boolean;
  maxBytes?: number;
}): { text: string; bytes: number; reviewed: number; skipped: Record<string, number>; missing: number; parts: number };
