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
 * Parses a PGN text (one or more games) with the app's own parser. A game is accepted when
 * every move is legal and it has at least one move; a bad game doesn't stop the others. Its
 * key comes from the site it names (Lichess Site / GameId, Chess.com Link), otherwise from a
 * hash of players, date and moves.
 */
export function checkPgnText(text: string): PgnCheckResult {
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
