import type { GameTree } from '../core/game-tree';
import { parsePgnGames, writePgn } from '../core/pgn';
import { gameKey, pasteKey, refFromPgnHeaders, type GameSource, type SiteGameRef } from './game-id';

/** One game from a pasted or captured PGN text, checked move by move. */
export interface ValidGame {
  tree: GameTree;
  headers: Record<string, string>;
  sanMoves: string[];
  ref: SiteGameRef | null;
  key: string;
  source: GameSource;
  /** The game's PGN: the input itself for a one-game text, otherwise the game re-written. */
  pgn: string;
}

export interface PgnCheckResult {
  games: ValidGame[];
  /** One line per game that was rejected ("Game 2: no moves"). */
  errors: string[];
}

export const MAX_PGN_TEXT_LENGTH = 8 * 1024 * 1024;

const HEADER_LINE = /^\s*\[[A-Za-z0-9_]+\s+"/;

/**
 * Splits a PGN text into games: a header line after movetext starts the next game. Lines
 * inside a `{ }` comment never start a game, so a wrapped `[%clk …]` stays where it is.
 */
export function splitPgnGames(text: string): string[] {
  const games: string[] = [];
  let current: string[] = [];
  let sawMovetext = false;
  let braceDepth = 0;
  for (const line of text.split(/\r?\n/)) {
    if (braceDepth === 0 && HEADER_LINE.test(line) && sawMovetext) {
      games.push(current.join('\n'));
      current = [];
      sawMovetext = false;
    }
    current.push(line);
    if (braceDepth === 0 && !HEADER_LINE.test(line) && line.trim() !== '') sawMovetext = true;
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      else if (ch === '}' && braceDepth > 0) braceDepth--;
    }
  }
  if (current.some((l) => l.trim() !== '')) games.push(current.join('\n'));
  return games.map((g) => g.trim()).filter((g) => g !== '');
}

/**
 * Why a game can't be imported, whatever its moves: a variant the app doesn't play, or no
 * moves at all. (A game that doesn't parse is `invalid`, found by checkPgnText.)
 */
export type ImportProblem = { kind: 'variant'; variant: string } | { kind: 'no-moves' };

/** Variants the app plays (by `[Variant]`, lowercased without spaces); no tag is standard chess. */
const SUPPORTED_VARIANTS = new Set(['', 'standard', 'chess', 'chess960', 'fromposition']);

const TAG_LINE = /^\s*\[([A-Za-z][A-Za-z0-9_]*)\s*(.*?)\s*\]\s*$/;

/**
 * The variant / no-moves problem of one game's PGN, or null. Cheap (no move parsing): the
 * extension uses it on every game it queues, the site on every game it is sent.
 */
export function importProblemOf(pgn: string): ImportProblem | null {
  const variant = /^\s*\[Variant\s+"([^"]*)"\s*\]\s*$/m.exec(pgn)?.[1]?.trim() ?? '';
  if (!SUPPORTED_VARIANTS.has(variant.toLowerCase().replace(/[\s_-]/g, ''))) return { kind: 'variant', variant };
  const movetext = pgn
    .split(/\r?\n/)
    .filter((line) => !TAG_LINE.test(line) && !/^\s*%/.test(line))
    .join('\n')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/;[^\n]*/g, ' ')
    .replace(/\$\d+/g, ' ')
    .replace(/\b(1-0|0-1|1\/2-1\/2)\b|\*/g, ' ')
    .replace(/\d+\s*\.(\s*\.\.)?/g, ' ')
    .trim();
  return movetext === '' ? { kind: 'no-moves' } : null;
}

/** "variant: Antichess", "no moves". */
export function describeImportProblem(problem: ImportProblem): string {
  return problem.kind === 'variant' ? `variant: ${problem.variant}` : 'no moves';
}

/**
 * Tag lines the parser can't read, rewritten: a value with quotes inside (`[Event "The "big"
 * one"]`) or in single quotes (`[Event 'x']`). Other lines are kept as they are, including
 * several tags on one line.
 */
export function repairTagLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const m = TAG_LINE.exec(line);
      if (!m) return line;
      const value = m[2]!;
      if (/^"(?:[^"\\]|\\.)*"$/.test(value) || /"\s*\]\s*\[/.test(line)) return line;
      const inner = value.replace(/^["']/, '').replace(/["']$/, '');
      return `[${m[1]} "${inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
    })
    .join('\n');
}

/**
 * Parses a PGN text (one or more games) with the app's own parser. A game is accepted when
 * every move is legal and it has at least one move; a bad game doesn't stop the others. Its
 * key comes from the site it names (Lichess Site / GameId, Chess.com Link), otherwise from a
 * hash of players, date and moves. When some games fail, malformed tag lines are repaired
 * (repairTagLines) and the text is read again; the better reading wins.
 */
export function checkPgnText(text: string): PgnCheckResult {
  const first = checkPgnTextOnce(text);
  if (first.errors.length === 0) return first;
  const repaired = repairTagLines(text);
  if (repaired === text) return first;
  const second = checkPgnTextOnce(repaired);
  // A broken tag line can also split one game in two (half of it then fails): fewer errors wins
  const better =
    second.games.length > first.games.length ||
    (second.games.length === first.games.length && second.errors.length < first.errors.length);
  return better ? second : first;
}

function checkPgnTextOnce(text: string): PgnCheckResult {
  const trimmed = text.trim();
  if (trimmed === '') return { games: [], errors: ['The text is empty.'] };
  if (trimmed.length > MAX_PGN_TEXT_LENGTH) return { games: [], errors: ['The text is too large (over 8 MB).'] };

  const chunks = splitPgnGames(trimmed);
  const games: ValidGame[] = [];
  const errors: string[] = [];
  chunks.forEach((chunk, i) => {
    const label = chunks.length > 1 ? `Game ${i + 1}: ` : '';
    let trees: GameTree[];
    try {
      trees = parsePgnGames(chunk);
    } catch (err) {
      errors.push(`${label}not a valid PGN (${err instanceof Error ? err.message : String(err)}).`);
      return;
    }
    trees.forEach((tree, j) => {
      const mainLine = tree.getMainLine();
      if (mainLine.length === 0) {
        errors.push(`${label}no moves.`);
        return;
      }
      const headers = tree.getHeaders();
      const sanMoves = mainLine.map((n) => n.san ?? '');
      const ref = refFromPgnHeaders(headers);
      games.push({
        tree,
        headers,
        sanMoves,
        ref,
        key: ref ? gameKey(ref) : pasteKey(headers, sanMoves),
        source: ref ? ref.site : 'paste',
        pgn: trees.length === 1 && j === 0 ? chunk : writePgn(tree),
      });
    });
  });
  if (chunks.length === 0) errors.push('No game found in the text.');
  return { games, errors };
}
