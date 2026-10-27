import { icon, type IconName } from '../ui/components/icons';
import type { DrillStore } from './drill-store';
import type { PuzzleStore } from './puzzle-store';
import { repertoireStats } from './repertoire';
import { ENDGAMES } from './endgames';

/** The four trainers of the Train hub. */
export type TrainerKind = 'puzzles' | 'repertoire' | 'endgames' | 'visualization';

export const TRAINERS: ReadonlyArray<{ kind: TrainerKind; title: string; icon: IconName; idle: string }> = [
  { kind: 'puzzles', title: 'Puzzles', icon: 'hint', idle: 'Rated puzzles, and puzzles from your own mistakes.' },
  {
    kind: 'repertoire',
    title: 'Repertoire',
    icon: 'book',
    idle: 'Build your White and Black openings and drill them.',
  },
  { kind: 'endgames', title: 'Endgames', icon: 'flag', idle: 'Mate, Lucena, Philidor and more, against the engine.' },
  {
    kind: 'visualization',
    title: 'Visualization',
    icon: 'eye',
    idle: 'Coordinates, blindfold, and guess the move in your games.',
  },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface TrainerTilesOptions {
  container: HTMLElement;
  puzzles: PuzzleStore;
  drills: DrillStore;
  onOpen: (kind: TrainerKind) => void;
}

/** The Train hub's way into each trainer: a tile with what you have done in it. */
export class TrainerTiles {
  private readonly root: HTMLElement;
  private readonly details = new Map<TrainerKind, HTMLElement>();
  private refreshing: Promise<void> | null = null;

  constructor(private readonly options: TrainerTilesOptions) {
    this.root = document.createElement('section');
    this.root.className = 'wc-trainer-tiles';
    this.root.setAttribute('data-testid', 'train-trainers');
    this.root.setAttribute('aria-label', 'Trainers');
    this.root.innerHTML = `
      <h3 class="wc-trainer-tiles-title">Trainers</h3>
      <div class="wc-trainer-tiles-grid">${TRAINERS.map(
        (t) => `
        <article class="wc-trainer-tile" data-testid="trainer-tile-${t.kind}">
          <span class="wc-trainer-tile-icon" aria-hidden="true">${icon(t.icon)}</span>
          <div class="wc-trainer-tile-main">
            <h4 class="wc-trainer-tile-title">${t.title}</h4>
            <p class="wc-trainer-tile-detail" data-testid="trainer-tile-${t.kind}-detail">${t.idle}</p>
          </div>
          <button type="button" class="wc-btn wc-btn-secondary" data-testid="btn-trainer-${t.kind}" aria-label="Open ${t.title}">Open</button>
        </article>`,
      ).join('')}</div>`;
    options.container.appendChild(this.root);
    for (const t of TRAINERS) {
      this.details.set(t.kind, this.root.querySelector(`[data-testid="trainer-tile-${t.kind}-detail"]`) as HTMLElement);
      this.root
        .querySelector(`[data-testid="btn-trainer-${t.kind}"]`)
        ?.addEventListener('click', () => options.onOpen(t.kind));
    }
  }

  /** Re-reads what each trainer has to say. */
  public refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private set(kind: TrainerKind, text: string): void {
    const el = this.details.get(kind);
    if (el && el.textContent !== text) el.textContent = text;
  }

  private async doRefresh(): Promise<void> {
    try {
      const [rating, today, drills, progress, coords, blind, white, black] = await Promise.all([
        this.options.puzzles.getRating(),
        this.options.puzzles.todaySummary(),
        this.options.drills.summary(),
        this.options.drills.endgames.progress(),
        this.options.drills.visualization.coordinateStats(),
        this.options.drills.visualization.blindfoldStats(),
        this.options.drills.repertoire.load('w'),
        this.options.drills.repertoire.load('b'),
      ]);
      const dueReviews = today.dueReviews.personal + today.dueReviews.lichess;
      this.set('puzzles', `Rating ${Math.round(rating.rating)} · ${plural(dueReviews, 'review')} due`);
      const moves = repertoireStats(white).moves + repertoireStats(black).moves;
      const waiting = drills.repertoire.due + drills.repertoire.fresh;
      this.set(
        'repertoire',
        moves === 0
          ? TRAINERS[1]!.idle
          : `${plural(moves, 'move')} in your repertoires · ${waiting} ${waiting === 1 ? 'position' : 'positions'} to answer`,
      );
      const completed = ENDGAMES.filter((e) => progress.get(e.id)?.completed === 1).length;
      this.set(
        'endgames',
        `${completed} of ${ENDGAMES.length} completed${drills.endgame.due > 0 ? ` · ${drills.endgame.due} due` : ''}`,
      );
      this.set(
        'visualization',
        coords.rounds === 0 && blind.drills === 0
          ? TRAINERS[3]!.idle
          : `Best round ${coords.best} right · blindfold level ${blind.level}${drills.visualization.due > 0 ? ` · ${drills.visualization.due} due` : ''}`,
      );
    } catch {
      // The tiles keep their descriptions when progress can't be read
    }
  }
}
