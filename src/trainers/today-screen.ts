import type { PuzzleStore, TodaySummary } from './puzzle-store';

/** Which puzzle session a Today button opens. */
export type PuzzleMode = 'review' | 'mistakes' | 'rated';

export interface TodayScreenOptions {
  container: HTMLElement;
  store: PuzzleStore;
  /** Brings personal puzzles up to date with the reviewed games before counting. */
  syncPersonal: () => Promise<void>;
  /** Games in the list without a review. */
  countUnanalyzed: () => Promise<number>;
  onStartPuzzles: (mode: PuzzleMode) => void;
  onOpenGames: () => void;
}

/** "in 3 h", "in 2 days", "tomorrow" — when the next review comes due. */
export function formatDueIn(dueAt: number, now: number): string {
  const minutes = Math.max(1, Math.round((dueAt - now) / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The Today screen: what's due across the trainers now (puzzle reviews, new puzzles from my
 * mistakes, rated puzzles played today) and games still waiting for a review, each with the
 * button that starts it.
 */
export class TodayScreen {
  private readonly root: HTMLElement;
  private els!: {
    reviews: HTMLElement;
    reviewsDetail: HTMLElement;
    startReviews: HTMLButtonElement;
    mistakes: HTMLElement;
    mistakesDetail: HTMLElement;
    startMistakes: HTMLButtonElement;
    rated: HTMLElement;
    ratedDetail: HTMLElement;
    games: HTMLElement;
    gamesDetail: HTMLElement;
    openGames: HTMLButtonElement;
    status: HTMLElement;
  };
  private refreshing: Promise<void> | null = null;
  private last: TodaySummary | null = null;

  constructor(private readonly options: TodayScreenOptions) {
    this.root = document.createElement('section');
    this.root.className = 'wc-today';
    this.root.setAttribute('data-testid', 'today-screen');
    this.root.setAttribute('aria-label', 'Today');
    options.container.appendChild(this.root);
    this.mount();
  }

  public getSummary(): TodaySummary | null {
    return this.last;
  }

  private mount(): void {
    this.root.innerHTML = `
      <div class="wc-today-head">
        <h2 class="wc-today-title">Today</h2>
        <span class="wc-today-status" data-testid="today-status" role="status"></span>
      </div>
      <div class="wc-today-grid">
        <article class="wc-today-card" data-testid="today-reviews">
          <div class="wc-today-card-label">Puzzle reviews due</div>
          <div class="wc-today-count" data-testid="today-reviews-count">–</div>
          <p class="wc-today-detail" data-testid="today-reviews-detail"></p>
          <button type="button" class="wc-btn wc-btn-primary" data-testid="btn-today-reviews">Start reviews</button>
        </article>
        <article class="wc-today-card" data-testid="today-mistakes">
          <div class="wc-today-card-label">New puzzles from my mistakes</div>
          <div class="wc-today-count" data-testid="today-mistakes-count">–</div>
          <p class="wc-today-detail" data-testid="today-mistakes-detail"></p>
          <button type="button" class="wc-btn wc-btn-primary" data-testid="btn-today-mistakes">Solve them</button>
        </article>
        <article class="wc-today-card" data-testid="today-rated">
          <div class="wc-today-card-label">Rated puzzles today</div>
          <div class="wc-today-count" data-testid="today-rated-count">–</div>
          <p class="wc-today-detail" data-testid="today-rated-detail"></p>
          <button type="button" class="wc-btn wc-btn-secondary" data-testid="btn-today-rated">Play rated puzzles</button>
        </article>
        <article class="wc-today-card" data-testid="today-games">
          <div class="wc-today-card-label">Games not analyzed yet</div>
          <div class="wc-today-count" data-testid="today-games-count">–</div>
          <p class="wc-today-detail" data-testid="today-games-detail">Analyzed games turn your mistakes into puzzles.</p>
          <button type="button" class="wc-btn wc-btn-secondary" data-testid="btn-today-games">Open the Games list</button>
        </article>
      </div>
    `;
    const q = <T extends HTMLElement>(id: string) => this.root.querySelector(`[data-testid="${id}"]`) as T;
    this.els = {
      reviews: q('today-reviews-count'),
      reviewsDetail: q('today-reviews-detail'),
      startReviews: q('btn-today-reviews'),
      mistakes: q('today-mistakes-count'),
      mistakesDetail: q('today-mistakes-detail'),
      startMistakes: q('btn-today-mistakes'),
      rated: q('today-rated-count'),
      ratedDetail: q('today-rated-detail'),
      games: q('today-games-count'),
      gamesDetail: q('today-games-detail'),
      openGames: q('btn-today-games'),
      status: q('today-status'),
    };
    this.els.startReviews.addEventListener('click', () => this.options.onStartPuzzles('review'));
    this.els.startMistakes.addEventListener('click', () => this.options.onStartPuzzles('mistakes'));
    q<HTMLButtonElement>('btn-today-rated').addEventListener('click', () => this.options.onStartPuzzles('rated'));
    this.els.openGames.addEventListener('click', () => this.options.onOpenGames());
  }

  /** Re-counts everything (personal puzzles are synced with the reviewed games first). */
  public refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    this.els.status.textContent = 'Updating…';
    this.root.setAttribute('data-state', 'loading');
    try {
      await this.options.syncPersonal();
      const now = Date.now();
      const [summary, unanalyzed] = await Promise.all([this.options.store.todaySummary(now), this.options.countUnanalyzed()]);
      this.last = summary;
      this.render(summary, unanalyzed, now);
      this.els.status.textContent = '';
      this.root.setAttribute('data-state', 'ready');
    } catch (err) {
      this.els.status.textContent = `Could not read your progress: ${err instanceof Error ? err.message : String(err)}`;
      this.root.setAttribute('data-state', 'error');
    }
  }

  private render(s: TodaySummary, unanalyzed: number, now: number): void {
    const due = s.dueReviews.personal + s.dueReviews.lichess;
    this.els.reviews.textContent = String(due);
    this.els.reviewsDetail.textContent =
      due > 0
        ? `${s.dueReviews.personal} from my games · ${s.dueReviews.lichess} Lichess`
        : s.nextDueAt !== null
          ? `All caught up. Next review ${formatDueIn(s.nextDueAt, now)}.`
          : 'Puzzles you miss come back here on a spaced-repetition schedule.';
    this.els.startReviews.disabled = due === 0;

    this.els.mistakes.textContent = String(s.newPersonal);
    this.els.mistakesDetail.textContent =
      s.totalPersonal > 0
        ? `${plural(s.totalPersonal, 'puzzle')} from my reviewed games in all.`
        : 'None yet: Mistakes, Blunders and Misses in my analyzed games become puzzles.';
    this.els.startMistakes.disabled = s.newPersonal === 0;

    this.els.rated.textContent = String(s.ratedToday);
    this.els.ratedDetail.textContent = `${s.ratedSolvedToday} solved · rating ${Math.round(s.rating.rating)} ±${Math.round(s.rating.rd)}`;

    this.els.games.textContent = String(unanalyzed);
    this.els.openGames.disabled = false;
  }
}
