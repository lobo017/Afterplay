import type { PuzzleEntry } from '../core/datasets';

/** Themes offered as drills, in this order, when the dataset has enough puzzles for them. */
export const DRILL_THEMES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'mateIn1', label: 'Mate in 1' },
  { id: 'mateIn2', label: 'Mate in 2' },
  { id: 'mateIn3', label: 'Mate in 3' },
  { id: 'backRankMate', label: 'Back-rank mate' },
  { id: 'fork', label: 'Fork' },
  { id: 'pin', label: 'Pin' },
  { id: 'skewer', label: 'Skewer' },
  { id: 'discoveredAttack', label: 'Discovered attack' },
  { id: 'hangingPiece', label: 'Hanging piece' },
  { id: 'trappedPiece', label: 'Trapped piece' },
  { id: 'sacrifice', label: 'Sacrifice' },
  { id: 'deflection', label: 'Deflection' },
  { id: 'attraction', label: 'Attraction' },
  { id: 'intermezzo', label: 'Intermezzo' },
  { id: 'quietMove', label: 'Quiet move' },
  { id: 'defensiveMove', label: 'Defensive move' },
  { id: 'zugzwang', label: 'Zugzwang' },
  { id: 'promotion', label: 'Promotion' },
  { id: 'advancedPawn', label: 'Advanced pawn' },
  { id: 'kingsideAttack', label: 'Kingside attack' },
  { id: 'opening', label: 'Opening' },
  { id: 'middlegame', label: 'Middlegame' },
  { id: 'endgame', label: 'Endgame' },
  { id: 'rookEndgame', label: 'Rook endgame' },
  { id: 'pawnEndgame', label: 'Pawn endgame' },
];

/** A drill is offered when the dataset has at least this many puzzles of its theme. */
export const MIN_DRILL_SIZE = 100;
/** Puzzles are picked within this many points of the target rating first… */
export const RATING_WINDOW = 100;
/** …and the window widens by this much until something is found. */
export const RATING_WINDOW_STEP = 150;

export interface ThemeCount {
  id: string;
  label: string;
  count: number;
}

export interface PickRequest {
  /** A theme id, or null for a mix of every theme. */
  theme: string | null;
  targetRating: number;
  /** Puzzles already tried (never picked again). */
  exclude: ReadonlySet<string> | readonly string[];
  /** 0 ≤ random < 1 (Math.random by default; injected in tests). */
  random?: () => number;
}

/**
 * The bundled puzzles, indexed for picking: sorted by rating, with the positions of each
 * theme's puzzles. Built once in the dataset worker.
 */
export class PuzzleDataset {
  private readonly byRating: PuzzleEntry[];
  private readonly themeIndex = new Map<string, number[]>();
  private readonly ids = new Map<string, PuzzleEntry>();

  constructor(entries: readonly PuzzleEntry[]) {
    this.byRating = [...entries].sort((a, b) => a.rating - b.rating || (a.id < b.id ? -1 : 1));
    this.byRating.forEach((p, i) => {
      this.ids.set(p.id, p);
      for (const t of p.themes) {
        let list = this.themeIndex.get(t);
        if (!list) this.themeIndex.set(t, (list = []));
        list.push(i);
      }
    });
  }

  public get size(): number {
    return this.byRating.length;
  }

  public get(id: string): PuzzleEntry | undefined {
    return this.ids.get(id);
  }

  /** The drill themes with enough puzzles, with their counts. */
  public themes(): ThemeCount[] {
    return DRILL_THEMES.map((t) => ({ ...t, count: this.themeIndex.get(t.id)?.length ?? 0 })).filter(
      (t) => t.count >= MIN_DRILL_SIZE,
    );
  }

  /**
   * A puzzle near the target rating (closest window first, random inside it), of the theme
   * when one is given, never an excluded one. Null when every candidate is excluded.
   */
  public pick(request: PickRequest): PuzzleEntry | null {
    const random = request.random ?? Math.random;
    const exclude = request.exclude instanceof Set ? request.exclude : new Set(request.exclude as readonly string[]);
    const indexes = request.theme === null ? null : (this.themeIndex.get(request.theme) ?? []);
    const count = indexes ? indexes.length : this.byRating.length;
    if (count === 0) return null;
    const at = (k: number) => this.byRating[indexes ? indexes[k]! : k]!;

    // Indexes are in rating order (theme lists were filled in rating order too)
    const lowerBound = (rating: number) => {
      let lo = 0;
      let hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (at(mid).rating < rating) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };

    const maxSpan = 4000;
    for (let window = RATING_WINDOW; window <= maxSpan; window += RATING_WINDOW_STEP) {
      const from = lowerBound(request.targetRating - window);
      const to = lowerBound(request.targetRating + window + 1);
      const candidates: PuzzleEntry[] = [];
      for (let k = from; k < to; k++) {
        const p = at(k);
        if (!exclude.has(p.id)) candidates.push(p);
      }
      if (candidates.length > 0) return candidates[Math.floor(random() * candidates.length)] ?? candidates[0]!;
    }
    return null;
  }
}
