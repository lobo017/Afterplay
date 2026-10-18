import type { GameNode, GameTree, MoveClassification } from '../core/game-tree';
import { RulesAdapter } from '../core/rules';
import { EngineCancelledError, type EngineClient } from '../engine/engine-client';
import type { UciScore } from '../engine/uci-parser';
import { formatEvalBarScore } from '../analysis/eval-bar';
import { lookupOpeningByFen } from '../analysis/opening-lookup';
import { CLASS_THRESHOLDS, classFromWinDrop, isErrorClass } from './classification';
import { formatBotLevel, winPercentFromScore } from './formulas';
import {
  ALL_CLASSIFICATIONS,
  buildAnnotatedPgn,
  evalAnnotation,
  mainLinePlies,
  type ReviewPly,
} from './review-game';
import { ReviewAnalysisClient } from './review-analysis-client';
import { ReviewRunner, type ReviewRunResult } from './review-runner';
import { SAMPLE_GAME_PGN } from './sample-game';
import {
  REVIEW_PRESET_MOVETIME_MS,
  type GameReview,
  type PositionAnalysis,
  type ReviewPreset,
  type ReviewedMove,
  type SideReviewSummary,
} from './types';

/** Icon and label for each class: the tree, the card and the counts all use these. */
export const CLASS_BADGE: Record<MoveClassification, { glyph: string; slug: string }> = {
  Brilliant: { glyph: '!!', slug: 'brilliant' },
  Great: { glyph: '!', slug: 'great' },
  Best: { glyph: '★', slug: 'best' },
  Excellent: { glyph: '✓', slug: 'excellent' },
  Good: { glyph: '•', slug: 'good' },
  Book: { glyph: '≡', slug: 'book' },
  Inaccuracy: { glyph: '?!', slug: 'inaccuracy' },
  Mistake: { glyph: '?', slug: 'mistake' },
  Blunder: { glyph: '??', slug: 'blunder' },
  Miss: { glyph: '✗', slug: 'miss' },
};

export function classBadgeHtml(c: MoveClassification, extraClass = ''): string {
  const badge = CLASS_BADGE[c];
  return `<span class="wc-class-badge wc-class-${badge.slug} ${extraClass}" title="${c}" aria-label="${c}" data-class="${c}">${badge.glyph}</span>`;
}

/** What the review writes onto a tree node. */
export interface ReviewTreeEntry {
  nodeId: string;
  classification: MoveClassification;
  eval?: { cp?: number; mate?: number; depth?: number };
}

/** The analysis board as the review panel sees it. */
export interface ReviewPanelHost {
  getGameTree(): GameTree;
  getCurrentNode(): GameNode;
  goToNode(nodeId: string): void;
  importPgn(pgn: string): boolean;
  /**
   * Adds the moves as a line from `fromNodeId` without navigating; returns the nodes.
   * `forceNewVariation` starts a new branch even when the first move already exists.
   */
  addLine(fromNodeId: string, ucis: readonly string[], options?: { forceNewVariation?: boolean }): GameNode[];
  deleteNode(nodeId: string): void;
  /**
   * Removes earlier engine annotations (imported analysis, an earlier review) from the
   * main line before a review writes its own; returns how many were removed.
   */
  stripEngineAnnotations(): number;
  /** Writes classifications (and missing evals) onto the tree and shows the badges. */
  applyReview(entries: readonly ReviewTreeEntry[], rerender: boolean): void;
  showPgnText(pgn: string, status: string): void;
  /** Called after each board move with the resulting node and whether it is new. */
  setMoveInterceptor(fn: ((node: GameNode, created: boolean) => void) | null): void;
  onNavigate(listener: (node: GameNode) => void): void;
  onTreeReplaced(listener: () => void): void;
}

export interface ReviewPanelOptions {
  host: ReviewPanelHost;
  /** The review's own engine instance (created on first use). */
  getEngine: () => EngineClient;
  isBookPosition: (fen: string) => boolean;
  onPlayVsBot: (fen: string) => void;
  initialPreset?: ReviewPreset;
}

type PanelState = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

interface RetryState {
  move: ReviewedMove;
  parentId: string;
  /** Bumped per attempt so a late engine answer for an old attempt is ignored. */
  attempt: number;
}

const CHART_W = 1000;
const CHART_H = 100;
const RETRY_MOVETIME_MS = 500;

const CLASS_SENTENCE: Partial<Record<MoveClassification, string>> = {
  Brilliant: 'A sound sacrifice: the best move, and it gives up material.',
  Great: 'The only move that keeps the result.',
  Best: "The engine's top move.",
};

const PRESET_LABEL: Record<ReviewPreset, string> = {
  quick: 'Quick',
  standard: 'Standard',
  deep: 'Deep',
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A SAN line with move numbers, starting from `fen`: "15. Bxd7+ Nxd7 16. Qb8+". */
export function numberedLine(fen: string, sans: readonly string[], maxPlies = 6): string {
  const parts = fen.trim().split(/\s+/);
  let turn = parts[1] === 'b' ? 'b' : 'w';
  let moveNumber = Number(parts[5] ?? 1) || 1;
  const out: string[] = [];
  sans.slice(0, maxPlies).forEach((san, i) => {
    if (turn === 'w') out.push(`${moveNumber}. ${san}`);
    else out.push(i === 0 ? `${moveNumber}... ${san}` : san);
    if (turn === 'b') moveNumber++;
    turn = turn === 'w' ? 'b' : 'w';
  });
  return out.join(' ');
}

function whiteView(score: UciScore | null, mover: 'w' | 'b'): UciScore | null {
  if (!score) return null;
  return mover === 'w' ? score : { type: score.type, value: -score.value };
}

/**
 * Game review panel: preset and start/cancel, progress, the live win% chart, accuracy
 * and an approximate bot level per side (formulas in a tooltip), move counts, key moments,
 * the current move's class and explanation, and the review tools.
 *
 * Everything that changes while navigating has a fixed size, so stepping through a
 * reviewed game never shifts the layout.
 */
export class ReviewPanel {
  private readonly root: HTMLElement;
  private readonly host: ReviewPanelHost;
  private readonly options: ReviewPanelOptions;

  private state: PanelState = 'idle';
  private preset: ReviewPreset;
  private abort: AbortController | null = null;
  private runGeneration = 0;
  private tree: GameTree | null = null;
  private plies: ReviewPly[] = [];
  private review: GameReview | null = null;
  private positions: Array<PositionAnalysis | undefined> = [];
  private result: ReviewRunResult | null = null;
  private byNode = new Map<string, ReviewedMove>();
  private appliedNodes = new Set<string>();
  private retry: RetryState | null = null;
  private retryMessage: { text: string; tone: 'info' | 'ok' | 'bad' } | null = null;
  private lastError: string | null = null;
  /** Earlier engine annotations the current review replaced. */
  private strippedAnnotations = 0;
  /** Classifies and explains moves in a worker, shared by every review. */
  private readonly analysisClient = new ReviewAnalysisClient();

  private els!: {
    preset: HTMLSelectElement;
    start: HTMLButtonElement;
    cancel: HTMLButtonElement;
    sample: HTMLButtonElement;
    progressFill: HTMLElement;
    progressText: HTMLElement;
    body: HTMLElement;
    chart: SVGSVGElement;
    chartArea: SVGPathElement;
    chartLine: SVGPathElement;
    chartMarkers: SVGGElement;
    chartCursor: SVGLineElement;
    sides: Record<'w' | 'b', { accuracy: HTMLElement; botLevel: HTMLElement; acpl: HTMLElement }>;
    counts: HTMLElement;
    moments: HTMLElement;
    cardBadge: HTMLElement;
    cardTitle: HTMLElement;
    cardEval: HTMLElement;
    cardText: HTMLElement;
    cardDetail: HTMLElement;
    retryBtn: HTMLButtonElement;
    refutationBtn: HTMLButtonElement;
    playBtn: HTMLButtonElement;
    exportBtn: HTMLButtonElement;
  };

  constructor(mount: HTMLElement, options: ReviewPanelOptions) {
    this.options = options;
    this.host = options.host;
    this.preset = options.initialPreset ?? 'quick';
    this.root = document.createElement('section');
    this.root.className = 'wc-review-panel';
    this.root.setAttribute('data-testid', 'review-panel');
    this.root.setAttribute('aria-label', 'Game review');
    mount.appendChild(this.root);
    this.mount();

    this.host.onNavigate((node) => this.handleNavigate(node));
    this.host.onTreeReplaced(() => this.reset());
    this.renderState();
    this.renderMoveCard(this.host.getCurrentNode());
  }

  private mount(): void {
    const presetOptions = (Object.keys(REVIEW_PRESET_MOVETIME_MS) as ReviewPreset[])
      .map(
        (p) =>
          `<option value="${p}" ${p === this.preset ? 'selected' : ''}>${PRESET_LABEL[p]} · ${(REVIEW_PRESET_MOVETIME_MS[p] / 1000).toFixed(1)} s</option>`,
      )
      .join('');
    const side = (c: 'w' | 'b', name: string) => `
      <div class="wc-review-side wc-review-side-${c}">
        <span class="wc-review-side-name">${name}</span>
        <span class="wc-review-accuracy" data-testid="review-accuracy-${c}">—</span>
        <span class="wc-review-side-meta" title="Approximate: the in-app bot level whose average centipawn loss matches this game. Not a rating estimate; see the i tooltip.">Bot level (approx.) <b data-testid="review-bot-level-${c}">—</b></span>
        <span class="wc-review-side-meta">ACPL <b data-testid="review-acpl-${c}">—</b></span>
      </div>`;

    this.root.innerHTML = `
      <div class="wc-panel-section-title">
        <span>Game Review</span>
        <div class="wc-review-actions">
          <select class="wc-select wc-select-sm" data-testid="select-review-preset" aria-label="Review preset">${presetOptions}</select>
          <button type="button" class="wc-btn wc-btn-primary wc-btn-xs" data-testid="btn-review-start">Review Game</button>
          <button type="button" class="wc-btn wc-btn-danger wc-btn-xs" data-testid="btn-review-cancel" disabled>Cancel</button>
          <button type="button" class="wc-btn wc-btn-ghost wc-btn-xs" data-testid="btn-review-sample" title="Morphy vs. Duke Karl / Count Isouard, Paris 1858">Sample Game</button>
        </div>
      </div>
      <div class="wc-review-progress" data-testid="review-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div class="wc-review-progress-fill" data-testid="review-progress-fill"></div>
        <span class="wc-review-progress-text" data-testid="review-progress-text">Not reviewed</span>
      </div>
      <div class="wc-review-body" data-testid="review-body" hidden>
        <svg class="wc-review-chart" data-testid="review-chart" viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" role="img" aria-label="White's win percentage through the game; click to jump to a move">
          <rect class="wc-review-chart-bg" x="0" y="0" width="${CHART_W}" height="${CHART_H}"></rect>
          <path class="wc-review-chart-area" data-testid="review-chart-area" d=""></path>
          <path class="wc-review-chart-line" d=""></path>
          <line class="wc-review-chart-mid" x1="0" y1="${CHART_H / 2}" x2="${CHART_W}" y2="${CHART_H / 2}"></line>
          <g class="wc-review-chart-markers"></g>
          <line class="wc-review-chart-cursor" data-testid="review-chart-cursor" x1="0" y1="0" x2="0" y2="${CHART_H}"></line>
        </svg>
        <div class="wc-review-summary">
          ${side('w', 'White')}
          ${side('b', 'Black')}
          <div class="wc-review-formulas">
            <button type="button" class="wc-review-info-btn" data-testid="btn-review-formulas" aria-describedby="wc-review-formulas-tip" aria-expanded="false" title="How these numbers are computed">i</button>
            <div class="wc-review-tooltip" id="wc-review-formulas-tip" role="tooltip" data-testid="review-formulas-tooltip">
              <p><b>Win%</b> = 50 + 50·(2 / (1 + e<sup>−0.00368208·cp</sup>) − 1), from the engine score in centipawns, clamped to ±1000. A forced mate counts as ±1000 (97.5% / 2.5%), as on Lichess.</p>
              <p><b>Move accuracy</b> = 103.1668·e<sup>−0.04354·drop</sup> − 3.1669 + 1, clamped to 0–100, where drop is how much the move lowered your Win% (the +1 is Lichess's allowance for imprecise evaluations).</p>
              <p><b>Game accuracy</b> (Lichess method): the average of (a) your move accuracies weighted by how volatile the game was around each move (standard deviation of Win% over a sliding window) and (b) their harmonic mean, which pulls the result down for a few very bad moves.</p>
              <p><b>ACPL</b> (as on Lichess): the average over all your moves of how many centipawns each lost, with evaluations clamped to ±1000 and a mate counted as ±1000.</p>
              <p><b>Bot level (approx.)</b>: the in-app bot whose calibrated average loss matches yours in this game. It is not a rating estimate: the bots are calibrated against Stockfish, not people, and one game's average is dominated by its few biggest mistakes, so it usually reads far below a human player's rating.</p>
            </div>
          </div>
        </div>
        <div class="wc-review-counts" data-testid="review-counts"></div>
        <div class="wc-review-moments" data-testid="review-key-moments" aria-label="Key moments"></div>
        <div class="wc-review-card" data-testid="review-move-card">
          <div class="wc-review-card-head">
            <span class="wc-review-card-badge" data-testid="review-card-badge"></span>
            <span class="wc-review-card-title" data-testid="review-card-title"></span>
            <span class="wc-review-card-eval" data-testid="review-card-eval"></span>
          </div>
          <div class="wc-review-card-text" data-testid="review-card-text"></div>
          <div class="wc-review-card-detail" data-testid="review-card-detail"></div>
        </div>
        <div class="wc-review-tools">
          <button type="button" class="wc-btn wc-btn-secondary wc-btn-xs" data-testid="btn-review-retry">Retry This Mistake</button>
          <button type="button" class="wc-btn wc-btn-secondary wc-btn-xs" data-testid="btn-review-refutation">Show Refutation</button>
          <button type="button" class="wc-btn wc-btn-secondary wc-btn-xs" data-testid="btn-review-play-bot">Play vs Bot Here</button>
          <button type="button" class="wc-btn wc-btn-secondary wc-btn-xs" data-testid="btn-review-export">Export Annotated PGN</button>
        </div>
      </div>
    `;

    const q = <T extends Element>(id: string) =>
      this.root.querySelector(`[data-testid="${id}"]`) as T;
    const chart = q<SVGSVGElement>('review-chart');
    this.els = {
      preset: q('select-review-preset'),
      start: q('btn-review-start'),
      cancel: q('btn-review-cancel'),
      sample: q('btn-review-sample'),
      progressFill: q('review-progress-fill'),
      progressText: q('review-progress-text'),
      body: q('review-body'),
      chart,
      chartArea: q('review-chart-area'),
      chartLine: chart.querySelector('.wc-review-chart-line') as SVGPathElement,
      chartMarkers: chart.querySelector('.wc-review-chart-markers') as SVGGElement,
      chartCursor: q('review-chart-cursor'),
      sides: {
        w: { accuracy: q('review-accuracy-w'), botLevel: q('review-bot-level-w'), acpl: q('review-acpl-w') },
        b: { accuracy: q('review-accuracy-b'), botLevel: q('review-bot-level-b'), acpl: q('review-acpl-b') },
      },
      counts: q('review-counts'),
      moments: q('review-key-moments'),
      cardBadge: q('review-card-badge'),
      cardTitle: q('review-card-title'),
      cardEval: q('review-card-eval'),
      cardText: q('review-card-text'),
      cardDetail: q('review-card-detail'),
      retryBtn: q('btn-review-retry'),
      refutationBtn: q('btn-review-refutation'),
      playBtn: q('btn-review-play-bot'),
      exportBtn: q('btn-review-export'),
    };

    this.els.preset.addEventListener('change', () => {
      this.preset = this.els.preset.value as ReviewPreset;
    });
    this.els.start.addEventListener('click', () => {
      void this.start();
    });
    this.els.cancel.addEventListener('click', () => this.cancel());
    this.els.sample.addEventListener('click', () => {
      void this.loadSampleGame();
    });
    chart.addEventListener('click', (e) => this.handleChartClick(e));
    this.els.moments.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-node-id]');
      const id = btn?.getAttribute('data-node-id');
      if (id) this.host.goToNode(id);
    });
    const info = q<HTMLButtonElement>('btn-review-formulas');
    info.addEventListener('click', () => {
      const open = !this.root.classList.contains('wc-review-tooltip-open');
      this.root.classList.toggle('wc-review-tooltip-open', open);
      info.setAttribute('aria-expanded', String(open));
    });
    this.els.retryBtn.addEventListener('click', () => this.startRetry());
    this.els.refutationBtn.addEventListener('click', () => this.showRefutation());
    this.els.playBtn.addEventListener('click', () => {
      this.options.onPlayVsBot(this.host.getCurrentNode().fen);
    });
    this.els.exportBtn.addEventListener('click', () => {
      this.exportAnnotatedPgn();
    });
  }

  // ------------------------------------------------------------------ public API

  public getState(): PanelState {
    return this.state;
  }

  public getReview(): GameReview | null {
    return this.review;
  }

  public getRunResult(): ReviewRunResult | null {
    return this.result;
  }

  public getPositions(): ReadonlyArray<PositionAnalysis | undefined> {
    return this.positions;
  }

  /** Where moves were analyzed (worker vs. inline), for tests and diagnostics. */
  public getAnalysisStats(): ReturnType<ReviewAnalysisClient['getStats']> {
    return this.analysisClient.getStats();
  }

  public getPreset(): ReviewPreset {
    return this.preset;
  }

  public setPreset(preset: ReviewPreset): void {
    this.preset = preset;
    this.els.preset.value = preset;
  }

  public async loadSampleGame(): Promise<ReviewRunResult | null> {
    this.cancel();
    if (!this.host.importPgn(SAMPLE_GAME_PGN)) return null;
    this.host.goToNode(this.host.getGameTree().root.id);
    // Loading the game and starting the review are each ~20–30 ms of main-thread work;
    // run them as separate tasks so neither click becomes a long task
    await new Promise((resolve) => setTimeout(resolve, 0));
    return this.start();
  }

  /** Reviews the board's current game; resolves when the review finishes or is cancelled. */
  public async start(): Promise<ReviewRunResult | null> {
    this.cancel();
    const tree = this.host.getGameTree();
    if (tree.root.children.length === 0) {
      this.lastError = 'Play or load a game first.';
      this.state = 'error';
      this.renderState();
      return null;
    }
    this.strippedAnnotations = this.host.stripEngineAnnotations();
    const generation = ++this.runGeneration;
    const abort = new AbortController();
    this.abort = abort;
    this.tree = tree;
    this.plies = mainLinePlies(tree);
    this.review = null;
    this.result = null;
    this.positions = [];
    this.byNode.clear();
    this.appliedNodes.clear();
    this.exitRetry();
    this.lastError = null;
    this.state = 'running';
    this.els.body.hidden = false;
    this.renderState();
    this.renderMoveCard(this.host.getCurrentNode());

    const runner = new ReviewRunner(this.options.getEngine(), this.analysisClient);
    try {
      const result = await runner.run({
        tree,
        preset: this.preset,
        isBookPosition: this.options.isBookPosition,
        signal: abort.signal,
        onProgress: (review, positions) => {
          if (generation !== this.runGeneration) return;
          this.positions = [...positions];
          this.acceptReview(review, false);
        },
      });
      if (generation !== this.runGeneration) return result;
      this.result = result;
      this.positions = result.positions;
      this.state = result.cancelled ? 'cancelled' : 'done';
      this.acceptReview(result.review, true);
      return result;
    } catch (err) {
      if (generation !== this.runGeneration) return null;
      this.state = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.renderState();
      return null;
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  public cancel(): void {
    if (this.abort && this.state === 'running') {
      this.abort.abort();
    }
  }

  // ------------------------------------------------------------------ review updates

  private reset(): void {
    this.cancel();
    this.runGeneration++;
    this.exitRetry();
    this.tree = null;
    this.plies = [];
    this.review = null;
    this.result = null;
    this.positions = [];
    this.byNode.clear();
    this.appliedNodes.clear();
    this.state = 'idle';
    this.els.body.hidden = true;
    this.renderState();
  }

  private acceptReview(review: GameReview, final: boolean): void {
    this.review = review;
    const fresh: ReviewTreeEntry[] = [];
    for (const move of review.moves) {
      this.byNode.set(move.nodeId, move);
      if (!this.appliedNodes.has(move.nodeId) || final) {
        this.appliedNodes.add(move.nodeId);
        const after = this.positions[move.ply];
        const annotation = after ? evalAnnotation(after) : undefined;
        fresh.push({
          nodeId: move.nodeId,
          classification: move.classification,
          ...(annotation ? { eval: annotation } : {}),
        });
      }
    }
    if (fresh.length > 0 || final) this.host.applyReview(fresh, final);
    this.renderState();
    this.renderSummary(review);
    this.renderChart(review);
    this.renderMoveCard(this.host.getCurrentNode());
  }

  // ------------------------------------------------------------------ rendering

  private renderState(): void {
    const running = this.state === 'running';
    this.els.start.disabled = running;
    this.els.sample.disabled = running;
    this.els.preset.disabled = running;
    this.els.cancel.disabled = !running;
    this.root.setAttribute('data-state', this.state);

    const review = this.review;
    const total = review?.totalPositions ?? 0;
    const done = review?.analyzedPositions ?? 0;
    const fraction = total > 0 ? done / total : 0;
    this.els.progressFill.style.transform = `scaleX(${fraction})`;
    this.els.progressFill.parentElement?.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));

    let text: string;
    switch (this.state) {
      case 'idle':
        text = 'Not reviewed. Choose a preset and press Review Game.';
        break;
      case 'running':
        text = `Reviewing (${PRESET_LABEL[this.preset]})… ${done} / ${total || '…'} positions`;
        break;
      case 'done': {
        const stats = this.result?.stats;
        text = `Reviewed · ${PRESET_LABEL[this.preset]} · ${total} positions in ${((stats?.timeMs ?? 0) / 1000).toFixed(1)} s · mean depth ${(stats?.meanDepth ?? 0).toFixed(1)}${
          this.strippedAnnotations > 0 ? ` · replaced ${this.strippedAnnotations} earlier engine annotations` : ''
        }`;
        break;
      }
      case 'cancelled':
        text = `Cancelled at ${done} / ${total} positions (partial review)`;
        break;
      case 'error':
        text = `Review failed: ${this.lastError ?? 'unknown error'}`;
        break;
    }
    this.els.progressText.textContent = text;
    this.els.exportBtn.disabled = !review || review.moves.length === 0 || running;
  }

  private renderSummary(review: GameReview): void {
    const fill = (c: 'w' | 'b', side: SideReviewSummary) => {
      const els = this.els.sides[c];
      els.accuracy.textContent = side.accuracy === null ? '—' : side.accuracy.toFixed(1);
      els.botLevel.textContent = formatBotLevel(side.botLevel);
      els.acpl.textContent = side.acpl === null ? '—' : Math.round(side.acpl).toString();
    };
    fill('w', review.white);
    fill('b', review.black);

    this.els.counts.innerHTML = ALL_CLASSIFICATIONS.map(
      (c) => `
        <div class="wc-review-count-row" data-testid="review-count-${CLASS_BADGE[c].slug}">
          <span class="wc-review-count-num">${review.white.counts[c]}</span>
          ${classBadgeHtml(c)}
          <span class="wc-review-count-label">${c}</span>
          <span class="wc-review-count-num">${review.black.counts[c]}</span>
        </div>`,
    ).join('');

    const byId = new Map(review.moves.map((m) => [m.nodeId, m]));
    this.els.moments.innerHTML =
      review.keyMoments.length === 0
        ? '<span class="wc-review-muted">Key moments appear as the review runs.</span>'
        : review.keyMoments
            .map((k) => {
              const move = byId.get(k.nodeId);
              const glyph = move ? classBadgeHtml(move.classification) : '';
              const label = move ? `${move.moveNumber}${move.color === 'w' ? '.' : '...'}${move.san}` : k.label;
              return `<button type="button" class="wc-btn wc-btn-ghost wc-btn-xs wc-review-moment" data-node-id="${k.nodeId}" data-testid="review-moment-${k.ply}" title="${escapeHtml(k.label)} (${k.swing > 0 ? '+' : ''}${k.swing.toFixed(0)}% for White)">${glyph}<span>${escapeHtml(label)}</span></button>`;
            })
            .join('');
  }

  private renderChart(review: GameReview): void {
    const series = review.whiteWinSeries;
    const n = Math.max(1, series.length - 1);
    const x = (i: number) => (i / n) * CHART_W;
    const y = (w: number) => CHART_H - (w / 100) * CHART_H;
    const points: string[] = [];
    let last = -1;
    for (let i = 0; i < series.length; i++) {
      const w = series[i];
      if (w === null || w === undefined) break;
      points.push(`${x(i).toFixed(1)},${y(w).toFixed(2)}`);
      last = i;
    }
    if (last < 0) {
      this.els.chartArea.setAttribute('d', '');
      this.els.chartLine.setAttribute('d', '');
    } else {
      this.els.chartLine.setAttribute('d', `M${points.join(' L')}`);
      this.els.chartArea.setAttribute(
        'd',
        `M0,${CHART_H} L${points.join(' L')} L${x(last).toFixed(1)},${CHART_H} Z`,
      );
    }
    this.els.chart.setAttribute('data-analyzed', String(last + 1));

    const markers = review.moves
      .filter((m) => isErrorClass(m.classification) || m.classification === 'Brilliant' || m.classification === 'Great')
      .map(
        (m) =>
          `<line class="wc-review-chart-marker wc-class-${CLASS_BADGE[m.classification].slug}" x1="${x(m.ply).toFixed(1)}" x2="${x(m.ply).toFixed(1)}" y1="0" y2="${CHART_H}" data-ply="${m.ply}"><title>${escapeHtml(`${m.moveNumber}${m.color === 'w' ? '.' : '...'} ${m.san}: ${m.classification}`)}</title></line>`,
      )
      .join('');
    this.els.chartMarkers.innerHTML = markers;
    this.positionChartCursor(this.host.getCurrentNode());
  }

  private plyOfNode(node: GameNode): number | null {
    if (!this.tree || this.tree !== this.host.getGameTree()) return null;
    if (node.parentId === null) return 0;
    const reviewed = this.byNode.get(node.id);
    if (reviewed) return reviewed.ply;
    const index = this.plies.findIndex((p) => p.nodeId === node.id);
    return index >= 0 ? index + 1 : null;
  }

  private positionChartCursor(node: GameNode): void {
    const ply = this.plyOfNode(node);
    const n = Math.max(1, (this.review?.whiteWinSeries.length ?? 1) - 1);
    const cursor = this.els.chartCursor;
    if (ply === null) {
      cursor.style.visibility = 'hidden';
      return;
    }
    const xPos = ((ply / n) * CHART_W).toFixed(1);
    cursor.setAttribute('x1', xPos);
    cursor.setAttribute('x2', xPos);
    cursor.style.visibility = 'visible';
    cursor.setAttribute('data-ply', String(ply));
  }

  private handleChartClick(e: MouseEvent): void {
    const review = this.review;
    if (!review || !this.tree || this.tree !== this.host.getGameTree()) return;
    const rect = this.els.chart.getBoundingClientRect();
    if (rect.width <= 0) return;
    const n = Math.max(1, review.whiteWinSeries.length - 1);
    const ply = Math.max(0, Math.min(n, Math.round(((e.clientX - rect.left) / rect.width) * n)));
    const nodeId = ply === 0 ? this.tree.root.id : this.plies[ply - 1]?.nodeId;
    if (nodeId) this.host.goToNode(nodeId);
  }

  private handleNavigate(node: GameNode): void {
    if (this.retry && node.id !== this.retry.parentId && node.parentId !== this.retry.parentId) {
      this.exitRetry();
    }
    this.positionChartCursor(node);
    this.renderMoveCard(node);
  }

  private renderMoveCard(node: GameNode): void {
    const reviewed = this.tree === this.host.getGameTree() ? this.byNode.get(node.id) : undefined;
    const els = this.els;
    let badge = '';
    let title = '';
    let evalText = '';
    let text = '';
    let detail = '';
    let tone = '';

    if (this.retry) {
      const r = this.retry.move;
      const side = r.color === 'w' ? 'White' : 'Black';
      badge = classBadgeHtml(r.classification);
      title = `Retry: ${r.moveNumber}${r.color === 'w' ? '.' : '...'} ${r.san}`;
      text = this.retryMessage?.text ?? `Find a better move for ${side} than ${r.san}.`;
      tone = this.retryMessage?.tone ?? 'info';
      detail = 'Play a move on the board. Navigate away to stop retrying.';
    } else if (reviewed) {
      const prefix = `${reviewed.moveNumber}${reviewed.color === 'w' ? '.' : '...'} ${reviewed.san}`;
      badge = classBadgeHtml(reviewed.classification);
      title = `${prefix} — ${reviewed.classification}`;
      const before = whiteView(reviewed.scoreBefore, reviewed.color);
      const after = whiteView(reviewed.scoreAfter, reviewed.color);
      const afterText = after ? formatEvalBarScore(after) : reviewed.winAfter >= 100 ? '#' : '½';
      evalText = before ? `${formatEvalBarScore(before)} → ${afterText}` : '';
      text = reviewed.explanation ?? this.classSentence(reviewed);
      if (isErrorClass(reviewed.classification)) {
        const best = reviewed.bestLineSan.length > 0 ? numberedLine(reviewed.fenBefore, reviewed.bestLineSan, 5) : '';
        const refutation =
          reviewed.refutationSan.length > 0 ? numberedLine(reviewed.fenAfter, reviewed.refutationSan, 5) : '';
        detail = [best && `Best: ${best}`, refutation && `Refutation: ${refutation}`].filter(Boolean).join(' · ');
      } else if (reviewed.bestLineSan.length > 0) {
        detail = `Engine line: ${numberedLine(reviewed.fenBefore, reviewed.bestLineSan, 6)}`;
      }
    } else if (node.parentId === null && this.review) {
      title = 'Start position';
      text = 'Step through the game or use the key moments to see each move’s review.';
    } else if (this.review) {
      title = `${node.san}`;
      text =
        this.state === 'running' && this.tree === this.host.getGameTree()
          ? 'Not reviewed yet.'
          : 'This move is not part of the reviewed main line.';
    }

    els.cardBadge.innerHTML = badge;
    els.cardTitle.textContent = title;
    els.cardEval.textContent = evalText;
    els.cardText.textContent = text;
    els.cardText.setAttribute('data-tone', tone);
    els.cardDetail.textContent = detail;
    els.cardDetail.title = detail;

    const isError = Boolean(reviewed && isErrorClass(reviewed.classification));
    els.retryBtn.disabled = !isError && !this.retry;
    els.retryBtn.textContent = this.retry ? 'Stop Retrying' : 'Retry This Mistake';
    els.refutationBtn.disabled = !isError || (reviewed?.refutationUci.length ?? 0) === 0;
    let gameOver = false;
    try {
      const adapter = new RulesAdapter(node.fen, { chess960: this.host.getGameTree().isChess960() });
      gameOver = adapter.isGameOver();
    } catch {
      gameOver = true;
    }
    els.playBtn.disabled = gameOver;
  }

  private classSentence(move: ReviewedMove): string {
    const fixed = CLASS_SENTENCE[move.classification];
    if (fixed) return fixed;
    if (move.classification === 'Book') {
      const opening = lookupOpeningByFen(move.fenAfter);
      return opening ? `Book move: ${opening.eco} ${opening.name}.` : 'Book move.';
    }
    const best = move.bestMoveSan ?? 'the top move';
    if (move.classification === 'Excellent') return `Nearly as good as ${best}.`;
    if (move.classification === 'Good') return `A reasonable move; ${best} was a little better.`;
    return '';
  }

  // ------------------------------------------------------------------ tools

  private currentReviewedMove(): ReviewedMove | undefined {
    if (this.tree !== this.host.getGameTree()) return undefined;
    return this.byNode.get(this.host.getCurrentNode().id);
  }

  private startRetry(): void {
    if (this.retry) {
      this.exitRetry();
      this.renderMoveCard(this.host.getCurrentNode());
      return;
    }
    const move = this.currentReviewedMove();
    if (!move || !isErrorClass(move.classification)) return;
    const node = this.host.getGameTree().getNode(move.nodeId);
    if (!node?.parentId) return;
    this.retry = { move, parentId: node.parentId, attempt: 0 };
    this.retryMessage = null;
    this.host.setMoveInterceptor((played, created) => this.handleRetryMove(played, created));
    this.host.goToNode(node.parentId);
  }

  private exitRetry(): void {
    if (!this.retry) return;
    this.retry = null;
    this.retryMessage = null;
    this.host.setMoveInterceptor(null);
  }

  private retryFail(text: string, node: GameNode, created: boolean): void {
    const retry = this.retry;
    if (!retry) return;
    this.retryMessage = { text, tone: 'bad' };
    // Back to the position before the mistake; a move made only for this attempt goes away
    this.host.goToNode(retry.parentId);
    if (created) this.host.deleteNode(node.id);
    this.renderMoveCard(this.host.getCurrentNode());
  }

  private handleRetryMove(node: GameNode, created: boolean): void {
    const retry = this.retry;
    if (!retry || node.parentId !== retry.parentId) return;
    const attempt = ++retry.attempt;
    const target = retry.move;

    if (node.uci === target.uci) {
      this.retryFail(`${node.san} is the move from the game. Try another one.`, node, created);
      return;
    }
    if (node.uci === target.bestMoveUci) {
      this.retrySucceed(`${node.san} is the best move.`);
      return;
    }

    this.retryMessage = { text: `Checking ${node.san}…`, tone: 'info' };
    this.renderMoveCard(node);
    const fenAfter = node.fen;
    const terminal = (() => {
      try {
        const adapter = new RulesAdapter(fenAfter, { chess960: this.host.getGameTree().isChess960() });
        if (adapter.isCheckmate()) return 'mate';
        if (adapter.isDraw()) return 'draw';
      } catch {
        return null;
      }
      return null;
    })();

    const judge = (winAfter: number) => {
      if (!this.retry || this.retry.attempt !== attempt) return;
      const drop = Math.max(0, target.winBefore - winAfter);
      const cls = classFromWinDrop(drop);
      if (drop < CLASS_THRESHOLDS.inaccuracy) {
        this.retrySucceed(`${node.san} works (${cls}).`);
      } else {
        this.retryFail(`${node.san} is also a ${cls.toLowerCase()}. Try again.`, node, created);
      }
    };

    if (terminal === 'mate') {
      judge(100);
      return;
    }
    if (terminal === 'draw') {
      judge(50);
      return;
    }
    this.options
      .getEngine()
      .analyze({
        fen: fenAfter,
        movetime: RETRY_MOVETIME_MS,
        multipv: 1,
        chess960: this.host.getGameTree().isChess960(),
        priority: 'live',
        useCache: false,
      })
      .then((res) => {
        const best = res.lines[0];
        if (!best) return;
        judge(100 - winPercentFromScore(best.score));
      })
      .catch((err: unknown) => {
        if (err instanceof EngineCancelledError) return;
        if (this.retry && this.retry.attempt === attempt) {
          this.retryMessage = { text: 'The engine could not check that move.', tone: 'bad' };
          this.renderMoveCard(this.host.getCurrentNode());
        }
      });
  }

  private retrySucceed(text: string): void {
    this.retry = null;
    this.host.setMoveInterceptor(null);
    this.retryMessage = null;
    this.renderMoveCard(this.host.getCurrentNode());
    // The card shows the success until the next navigation
    this.els.cardTitle.textContent = 'Retry solved';
    this.els.cardText.textContent = `✓ ${text}`;
    this.els.cardText.setAttribute('data-tone', 'ok');
    this.els.cardBadge.innerHTML = '';
    this.els.cardEval.textContent = '';
  }

  private showRefutation(): void {
    const move = this.currentReviewedMove();
    const tree = this.host.getGameTree();
    const node = move ? tree.getNode(move.nodeId) : undefined;
    if (!move || !node || move.refutationUci.length === 0) return;
    // Follow moves that are already in the tree. If the refutation is what was played and
    // runs past the end of the game, its tail would become part of the game itself, so it
    // goes into a variation of its own instead.
    let cursor: GameNode = node;
    let matched = 0;
    for (const uci of move.refutationUci) {
      const child = cursor.children.find((c) => c.uci === uci);
      if (!child) break;
      cursor = child;
      matched++;
    }
    const mainLine = new Set(tree.getMainLine().map((n) => n.id));
    const extendsGame =
      matched < move.refutationUci.length && cursor.children.length === 0 && mainLine.has(cursor.id);
    const added = this.host.addLine(move.nodeId, move.refutationUci, {
      forceNewVariation: extendsGame,
    });
    const first = added[0];
    if (first) this.host.goToNode(first.id);
  }

  private exportAnnotatedPgn(): void {
    const review = this.review;
    const tree = this.tree;
    if (!review || !tree) return;
    const engineName = this.options.getEngine().getEngineName() || 'Stockfish 17.1';
    const pgn = buildAnnotatedPgn(tree, review, this.positions, engineName);
    this.host.showPgnText(pgn, 'Annotated PGN Exported');
    try {
      const url = URL.createObjectURL(new Blob([pgn], { type: 'application/x-chess-pgn' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'wizards-chess-review.pgn';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      // The annotated PGN is in the PGN box either way
    }
  }
}
