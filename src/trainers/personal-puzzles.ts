import type { Color } from '../core/rules';
import { myColor } from '../library/game-record';
import type { SavedReview } from '../library/saved-review';
import type { UserAccount } from '../review/perspective';
import type { ReviewedMove } from '../review/types';
import type { StoredGameRecord, StoredPuzzleRecord } from '../storage/db';
import { preparePuzzle } from './puzzle-format';
import { isClearBest } from './puzzle-validation';

/** The review classes that become puzzles. */
export const PUZZLE_CLASSES: ReadonlySet<ReviewedMove['classification']> = new Set(['Mistake', 'Blunder', 'Miss']);

export type PersonalPuzzle = Omit<StoredPuzzleRecord, 'dueDate' | 'attempts' | 'solvedCount' | 'updatedAt'>;

export function personalPuzzleId(gameId: string, ply: number): string {
  return `personal:${gameId}:${ply}`;
}

/** Why a move of mine didn't become a puzzle (tests and diagnostics). */
export type SkipReason = 'not-mine' | 'class' | 'first-move' | 'no-best' | 'not-clear' | 'invalid';

export interface PersonalPuzzleScan {
  color: Color | null;
  puzzles: PersonalPuzzle[];
  skipped: Array<{ ply: number; reason: SkipReason }>;
}

/**
 * The puzzles my reviewed game yields: every Mistake, Blunder or Miss of mine (my side: a
 * player name equals one of my usernames for the game's site), set up from the position
 * before the opponent's last move, with the engine's best move as the solution. A position
 * is rejected when the second-best move is nearly as good as the best (isClearBest).
 */
export function scanPersonalPuzzles(
  record: Pick<StoredGameRecord, 'id' | 'white' | 'black' | 'source' | 'date'>,
  saved: SavedReview,
  accounts: readonly UserAccount[],
): PersonalPuzzleScan {
  const color = myColor(record, accounts);
  const out: PersonalPuzzleScan = { color, puzzles: [], skipped: [] };
  if (!color) return out;
  const moves = saved.review.moves;
  const opponent = color === 'w' ? record.black : record.white;
  const me = color === 'w' ? record.white : record.black;
  const label = [`${me} vs ${opponent}`, record.date ? record.date.replace(/\./g, '-') : null]
    .filter(Boolean)
    .join(' · ');

  for (const move of moves) {
    if (move.color !== color) continue;
    if (!PUZZLE_CLASSES.has(move.classification)) {
      continue;
    }
    const skip = (reason: SkipReason) => out.skipped.push({ ply: move.ply, reason });
    const previous = moves.find((m) => m.ply === move.ply - 1);
    if (!previous) {
      skip('first-move');
      continue;
    }
    const before = saved.positions[move.ply - 1];
    const best = move.bestMoveUci;
    if (!before || !best || best === move.uci) {
      skip('no-best');
      continue;
    }
    if (!isClearBest(before.lines)) {
      skip('not-clear');
      continue;
    }
    const lines = [...before.lines].sort((a, b) => a.multipv - b.multipv);
    if (lines[0]!.pv[0] !== best) {
      skip('no-best');
      continue;
    }
    const source = { id: personalPuzzleId(record.id, move.ply), fen: previous.fenBefore, moves: [previous.uci, best] };
    try {
      // The same loader as the bundled puzzles: checks the setup move and the solution
      preparePuzzle(source);
    } catch {
      skip('invalid');
      continue;
    }
    const motifs = [
      ...new Set(
        move.motifs
          .filter((m) => m.role === 'missed' || m.role === 'refutation' || m.role === undefined)
          .map((m) => m.kind),
      ),
    ];
    out.puzzles.push({
      ...source,
      source: 'personal',
      rating: 0,
      themes: [move.classification.toLowerCase(), ...motifs],
      sourceGameId: record.id,
      ply: move.ply,
      playedSan: move.san,
      classification: move.classification as 'Mistake' | 'Blunder' | 'Miss',
      explanation: move.explanation,
      bestLineSan: move.bestLineSan,
      gameLabel: label,
      reviewSavedAt: saved.savedAt,
    });
  }
  return out;
}
