import type { Color } from '../core/rules';
import type { MotifKind, ReviewedMove } from '../review/types';
import type { GameRow } from './game-rows';
import type { SavedReview } from './saved-review';

/**
 * What the Insights charts are made of. Every number comes with the positions it was counted
 * from, so clicking a data point can show them. Pure: the view only draws what is here.
 */

/** One position behind a data point: a move of mine in one of my reviewed games. */
export interface InsightPosition {
  gameId: string;
  ply: number;
  /** The position before the move. */
  fen: string;
  /** "12. Nf3", "12... Qxd4". */
  moveLabel: string;
  san: string;
  classification: string;
  /** "Lobo017 vs Opponent · 2026-10-04". */
  gameLabel: string;
  /** One line about what happened, when there is one. */
  note: string | null;
  /** My side (the board is shown from it). */
  color: Color;
}

/** A reviewed game of mine, ready to be counted. */
export interface ReviewedGameInput {
  row: GameRow;
  review: SavedReview;
}

export type GamePhase = 'opening' | 'middlegame' | 'endgame';

export const PHASE_LABEL: Record<GamePhase, string> = { opening: 'Opening', middlegame: 'Middlegame', endgame: 'Endgame' };
export const PHASES: readonly GamePhase[] = ['opening', 'middlegame', 'endgame'];

/** Plies (half-moves) the opening lasts, unless the pieces have come off sooner. */
export const OPENING_PLIES = 20;
/** The endgame starts when this many pieces (queens, rooks, bishops, knights of both sides) are left. */
export const ENDGAME_PIECES = 6;

/** Pieces other than kings and pawns on the board of a FEN. */
export function minorAndMajorPieces(fen: string): number {
  let n = 0;
  for (const ch of fen.split(' ')[0] ?? '') if ('qrbnQRBN'.includes(ch)) n++;
  return n;
}

/** The phase of the position before the move at `ply` (1 = the first move). */
export function phaseOf(fen: string, ply: number): GamePhase {
  if (minorAndMajorPieces(fen) <= ENDGAME_PIECES) return 'endgame';
  return ply <= OPENING_PLIES ? 'opening' : 'middlegame';
}

function label(row: GameRow): string {
  const r = row.record;
  const day = r.date ? r.date.replace(/\./g, '-') : '';
  return `${r.white} vs ${r.black}${day ? ` · ${day}` : ''}`;
}

function moveLabel(m: ReviewedMove): string {
  const n = m.moveNumber;
  return m.color === 'w' ? `${n}. ${m.san}` : `${n}... ${m.san}`;
}

function position(row: GameRow, m: ReviewedMove, note: string | null = m.explanation): InsightPosition {
  return {
    gameId: row.record.id,
    ply: m.ply,
    fen: m.fenBefore,
    moveLabel: moveLabel(m),
    san: m.san,
    classification: m.classification,
    gameLabel: label(row),
    note,
    color: m.color,
  };
}

/** My moves in a reviewed game of mine. */
function myMoves(input: ReviewedGameInput): ReviewedMove[] {
  const color = input.row.color;
  return color ? input.review.review.moves.filter((m) => m.color === color) : [];
}

// ---------------------------------------------------------------------------- accuracy by phase

export interface PhaseAccuracy {
  phase: GamePhase;
  /** Mean accuracy of my moves in the phase (0–100), null with no moves. */
  accuracy: number | null;
  moves: number;
  /** The moves, worst first. */
  positions: InsightPosition[];
}

export function accuracyByPhase(games: readonly ReviewedGameInput[]): PhaseAccuracy[] {
  const out = new Map<GamePhase, { total: number; items: Array<{ accuracy: number; pos: InsightPosition }> }>();
  for (const p of PHASES) out.set(p, { total: 0, items: [] });
  for (const g of games) {
    for (const m of myMoves(g)) {
      const bucket = out.get(phaseOf(m.fenBefore, m.ply))!;
      bucket.total += m.accuracy;
      bucket.items.push({ accuracy: m.accuracy, pos: position(g.row, m) });
    }
  }
  return PHASES.map((phase) => {
    const b = out.get(phase)!;
    return {
      phase,
      accuracy: b.items.length === 0 ? null : b.total / b.items.length,
      moves: b.items.length,
      positions: b.items.sort((x, y) => x.accuracy - y.accuracy).map((i) => i.pos),
    };
  });
}

// ---------------------------------------------------------------------------- blunders over time

export interface BlunderPoint {
  gameId: string;
  /** When the game was played (ms). */
  at: number;
  /** Blunders per 10 of my moves in the game. */
  per10: number;
  blunders: number;
  moves: number;
  gameLabel: string;
  positions: InsightPosition[];
}

export function blundersOverTime(games: readonly ReviewedGameInput[]): BlunderPoint[] {
  const points: BlunderPoint[] = [];
  for (const g of games) {
    const mine = myMoves(g);
    if (mine.length === 0) continue;
    const blunders = mine.filter((m) => m.classification === 'Blunder');
    const r = g.row.record;
    points.push({
      gameId: r.id,
      at: r.playedAt ?? r.capturedAt ?? r.createdAt,
      per10: (blunders.length / mine.length) * 10,
      blunders: blunders.length,
      moves: mine.length,
      gameLabel: label(g.row),
      positions: blunders.map((m) => position(g.row, m)),
    });
  }
  return points.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------- motifs

export const MOTIF_LABEL: Record<MotifKind, string> = {
  'hanging-piece': 'Hanging piece',
  fork: 'Fork',
  pin: 'Pin',
  skewer: 'Skewer',
  'discovered-attack': 'Discovered attack',
  'back-rank': 'Back rank',
  'missed-mate': 'Missed mate',
  'trapped-piece': 'Trapped piece',
  'promotion-threat': 'Promotion threat',
};

export interface MotifCount {
  kind: MotifKind;
  count: number;
  positions: InsightPosition[];
}

/** The motifs behind my mistakes, blunders and misses, most common first (a move counts once per motif). */
export function commonMotifs(games: readonly ReviewedGameInput[]): MotifCount[] {
  const byKind = new Map<MotifKind, InsightPosition[]>();
  for (const g of games) {
    for (const m of myMoves(g)) {
      if (m.classification !== 'Mistake' && m.classification !== 'Blunder' && m.classification !== 'Miss') continue;
      for (const kind of new Set(m.motifs.map((x) => x.kind))) {
        const list = byKind.get(kind) ?? [];
        list.push(position(g.row, m));
        byKind.set(kind, list);
      }
    }
  }
  return [...byKind.entries()]
    .map(([kind, positions]) => ({ kind, count: positions.length, positions }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

// ---------------------------------------------------------------------------- results by opening

export interface OpeningResults {
  /** The opening family ("Sicilian Defense"). */
  name: string;
  eco: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  gameIds: string[];
}

/** "Sicilian Defense: Najdorf Variation" → "Sicilian Defense". */
export function openingFamily(name: string): string {
  return name.split(':')[0]!.trim();
}

/** My finished games by opening family (all my games, reviewed or not), most played first. */
export function resultsByOpening(rows: readonly GameRow[]): OpeningResults[] {
  const map = new Map<string, OpeningResults>();
  for (const row of rows) {
    if (row.color === null || row.result === 'unfinished' || !row.record.openingName) continue;
    const name = openingFamily(row.record.openingName);
    const entry = map.get(name) ?? { name, eco: row.record.openingEco, games: 0, wins: 0, draws: 0, losses: 0, gameIds: [] };
    entry.games++;
    if (row.result === 'win') entry.wins++;
    else if (row.result === 'draw') entry.draws++;
    else entry.losses++;
    entry.gameIds.push(row.record.id);
    map.set(name, entry);
  }
  return [...map.values()].sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------- puzzle rating

export interface RatingPoint {
  at: number;
  rating: number;
  puzzleId: string;
  solved: boolean;
}

/** The puzzle rating history, oldest first. */
export function puzzleRatingSeries(history: ReadonlyArray<{ at: number; rating: number; puzzleId: string; solved: boolean }>): RatingPoint[] {
  return history.map((h) => ({ ...h })).sort((a, b) => a.at - b.at);
}
