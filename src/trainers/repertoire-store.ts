import { GameTree } from '../core/game-tree';
import { writePgn } from '../core/pgn';
import type { Color } from '../core/rules';
import type { StoredRepertoireRecord, StoredSrsCardRecord, WizardChessStorage } from '../storage/db';
import type { Grade } from './fsrs';
import {
  REPERTOIRE_NAME,
  indexRepertoire,
  newRepertoireTree,
  repertoireRecordId,
  type RepertoireIndex,
} from './repertoire';
import { drillCardId, freshCardRecord, gradeStoredCard, isDueReview } from './srs-cards';

/** The card's target: the colour and the position key ("w:rnbqkbnr/… w KQkq -"). */
export function repertoireCardTarget(color: Color, key: string): string {
  return `${color}:${key}`;
}

export interface RepertoireDue {
  /** Position keys to answer now: reviews by due time, then new ones in tree order. */
  ordered: string[];
  /** Positions learned before and due again. */
  reviews: number;
  /** Positions never answered yet. */
  fresh: number;
  /** Positions in all. */
  total: number;
  /** When the next card that isn't due yet comes due (null: none). */
  nextDueAt: number | null;
}

/**
 * The two repertoires (White and Black) in IndexedDB, each a game tree, and the spaced-repetition
 * card of every position where I have a move prepared (deck `repertoire`). Cards follow the tree:
 * a new position gets a new card, a deleted one loses its card.
 */
export class RepertoireStore {
  private readonly cache = new Map<Color, RepertoireIndex>();
  private readonly listeners = new Set<() => void>();
  private readonly reloadListeners = new Set<() => void>();
  /** Saves run one at a time, so card syncs never interleave. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: WizardChessStorage) {}

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** Called when what was read is dropped (after a restore): anything showing a repertoire reads it again. */
  public onReload(listener: () => void): () => void {
    this.reloadListeners.add(listener);
    return () => this.reloadListeners.delete(listener);
  }

  /** Forgets what was read, so the next load reads the database again (after a restore). */
  public reload(): void {
    this.cache.clear();
    for (const l of this.reloadListeners) l();
    this.emit();
  }

  /** The repertoire as an index (an empty tree when none is stored yet). The tree is shared: save after changing it. */
  public async load(color: Color): Promise<RepertoireIndex> {
    const cached = this.cache.get(color);
    if (cached) return cached;
    const record = await this.storage.getRepertoire(repertoireRecordId(color));
    const index = indexRepertoire(record ? GameTree.fromJSON(record.tree) : newRepertoireTree(color), color);
    this.cache.set(color, index);
    return index;
  }

  public getRecord(color: Color): Promise<StoredRepertoireRecord | undefined> {
    return this.storage.getRepertoire(repertoireRecordId(color));
  }

  /** Stores the tree and brings the cards in line with its positions. */
  public save(color: Color, tree: GameTree, now: number = Date.now()): Promise<RepertoireIndex> {
    const run = this.writes.then(async () => {
      const index = indexRepertoire(tree, color);
      await this.storage.saveRepertoire({
        id: repertoireRecordId(color),
        name: REPERTOIRE_NAME[color],
        color,
        pgn: writePgn(tree),
        tree: tree.toJSON(),
        updatedAt: now,
      });
      this.cache.set(color, index);
      await this.syncCards(color, index, now);
      this.emit();
      return index;
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  private async syncCards(color: Color, index: RepertoireIndex, now: number): Promise<void> {
    const wanted = new Set(index.myKeys.map((k) => repertoireCardTarget(color, k)));
    const mine = (await this.storage.listSrsCards('repertoire')).filter((c) => c.targetId.startsWith(`${color}:`));
    const have = new Set(mine.map((c) => c.targetId));
    for (const card of mine) {
      if (!wanted.has(card.targetId)) await this.storage.deleteSrsCard(card.id);
    }
    for (const target of wanted) {
      if (!have.has(target)) await this.storage.saveSrsCard(freshCardRecord('repertoire', target, now));
    }
  }

  public async cards(color: Color): Promise<StoredSrsCardRecord[]> {
    return (await this.storage.listSrsCards('repertoire')).filter((c) => c.targetId.startsWith(`${color}:`));
  }

  /** What is due in one repertoire now. */
  public async due(color: Color, now: number = Date.now()): Promise<RepertoireDue> {
    const cards = await this.cards(color);
    const prefix = `${color}:`;
    const keyOf = (c: StoredSrsCardRecord) => c.targetId.slice(prefix.length);
    const reviews = cards.filter((c) => isDueReview(c, now)).sort((a, b) => a.dueDate - b.dueDate);
    const fresh = cards.filter((c) => c.state === 'new');
    const waiting = cards.filter((c) => c.state !== 'new' && c.dueDate > now);
    const index = await this.load(color);
    const order = new Map(index.myKeys.map((k, i) => [k, i]));
    fresh.sort((a, b) => (order.get(keyOf(a)) ?? 0) - (order.get(keyOf(b)) ?? 0));
    return {
      ordered: [...reviews, ...fresh].map(keyOf),
      reviews: reviews.length,
      fresh: fresh.length,
      total: cards.length,
      nextDueAt: waiting.length > 0 ? Math.min(...waiting.map((c) => c.dueDate)) : null,
    };
  }

  /** Grades one position's card (Again after a miss, Hard after a hint, Good for a clean answer). */
  public async grade(color: Color, key: string, grade: Grade, now: number = Date.now()): Promise<StoredSrsCardRecord> {
    const card = await gradeStoredCard(this.storage, 'repertoire', repertoireCardTarget(color, key), grade, now);
    this.emit();
    return card;
  }

  public async getCard(color: Color, key: string): Promise<StoredSrsCardRecord | undefined> {
    return this.storage.getSrsCard(drillCardId('repertoire', repertoireCardTarget(color, key)));
  }
}
