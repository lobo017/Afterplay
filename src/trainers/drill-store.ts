import type { StoredSrsCardRecord, WizardChessStorage } from '../storage/db';
import { EndgameStore } from './endgame-store';
import { RepertoireStore } from './repertoire-store';
import { isDueReview } from './srs-cards';
import { VisualizationStore } from './visualization-store';

/** The three trainers beside the puzzles. */
export type DrillKind = 'repertoire' | 'endgame' | 'visualization';

export interface DeckSummary {
  /** Cards graded before and due again now. */
  due: number;
  /** Cards never graded: waiting to be learned (positions of a new repertoire). */
  fresh: number;
  /** Cards in all. */
  total: number;
}

export interface DrillSummary {
  repertoire: DeckSummary;
  endgame: DeckSummary;
  visualization: DeckSummary;
  /** When the next card that isn't due yet comes due, across the three decks (null: none). */
  nextDueAt: number | null;
}

export function summarizeCards(
  cards: readonly StoredSrsCardRecord[],
  now: number,
): { deck: DeckSummary; nextDueAt: number | null } {
  const deck: DeckSummary = { due: 0, fresh: 0, total: cards.length };
  let nextDueAt: number | null = null;
  for (const c of cards) {
    if (c.state === 'new') deck.fresh++;
    else if (isDueReview(c, now)) deck.due++;
    else if (nextDueAt === null || c.dueDate < nextDueAt) nextDueAt = c.dueDate;
  }
  return { deck, nextDueAt };
}

/**
 * The three Phase 7 trainers' stores, and what is due across them for the Today screen and
 * the Train tab. Their cards live in the same `srs_cards` store as the puzzles' (decks
 * `repertoire`, `endgame`, `visualization`) and follow the same FSRS schedule.
 */
export class DrillStore {
  public readonly repertoire: RepertoireStore;
  public readonly endgames: EndgameStore;
  public readonly visualization: VisualizationStore;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: WizardChessStorage) {
    this.repertoire = new RepertoireStore(storage);
    this.endgames = new EndgameStore(storage);
    this.visualization = new VisualizationStore(storage);
    for (const store of [this.repertoire, this.endgames, this.visualization]) {
      store.onChange(() => {
        for (const l of this.listeners) l();
      });
    }
  }

  /** Called after any trainer records something or a repertoire changes. */
  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async summary(now: number = Date.now()): Promise<DrillSummary> {
    const [repertoire, endgame, visualization] = await Promise.all([
      this.storage.listSrsCards('repertoire'),
      this.storage.listSrsCards('endgame'),
      this.storage.listSrsCards('visualization'),
    ]);
    const r = summarizeCards(repertoire, now);
    const e = summarizeCards(endgame, now);
    const v = summarizeCards(visualization, now);
    const next = [r.nextDueAt, e.nextDueAt, v.nextDueAt].filter((n): n is number => n !== null);
    return {
      repertoire: r.deck,
      endgame: e.deck,
      visualization: v.deck,
      nextDueAt: next.length > 0 ? Math.min(...next) : null,
    };
  }
}
