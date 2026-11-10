import type { GameNode, GameTree, MoveClassification } from '../core/game-tree';
import { RulesAdapter, type Color } from '../core/rules';
import { describeDeparture, type RepertoireDeparture } from '../trainers/repertoire';
import { EngineCancelledError, type EngineClient } from '../engine/engine-client';
import type { UciScore } from '../engine/uci-parser';
import { formatEvalBarScore } from '../analysis/eval-bar';
import { lookupOpeningByFen } from '../analysis/opening-lookup';
import { describeHintedMoves, hintedMoves } from './hints';
import { CLASS_THRESHOLDS, classFromWinDrop, isErrorClass } from './classification';
import { formatBotLevel, winPercentFromScore } from './formulas';
import { buildAnnotatedPgn, evalAnnotation, mainLinePlies, type ReviewPly } from './review-game';
import { restoreSavedReview, type SavedReview } from '../library/saved-review';
import {
  DEFAULT_USER_ACCOUNTS,
  coversMove,
  defaultPerspective,
  movesOfClass,
  perspectiveErrors,
  perspectiveKeyMoments,
  perspectiveSeries,
  playerHeading,
  playerMeta,
  playerInfo,
  stepCycle,
  type ReviewPerspective,
  type UserAccount,
} from './perspective';
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
import { icon } from '../ui/components/icons';
import { Menu } from '../ui/components/menu';

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
  /** Shows the board from this side. */
  setOrientation(color: 'w' | 'b'): void;
  importPgn(pgn: string): boolean;
  /** The same, shown from the first position, parsed and shown in separate tasks. */
  importPgnFromStart(pgn: string): Promise<boolean>;
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
  /** The depth select was changed by the user. */
  onPresetChange?: (preset: ReviewPreset) => void;
  /** My accounts, for the default "Review as" side (the built-in default when absent). */
  getAccounts?: () => readonly UserAccount[];
  /** Called when a review run finishes (not when it is cancelled or fails). */
  onReviewFinished?: (result: ReviewRunResult, tree: GameTree) => void;
  /** A review starts running (true) or stops: finished, cancelled or failed (false). */
  onRunningChange?: (running: boolean) => void;
  /**
   * Where the reviewed game leaves my repertoire (null: it doesn't, or there is none). Asked
   * only for my own games: `color` is my side, from my usernames.
   */
  findRepertoireDeparture?: (tree: GameTree, color: Color) => Promise<RepertoireDeparture | null>;
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

/** Rows of the counts table, in the spec's order (Miss before Blunder). */
const COUNT_ORDER: readonly MoveClassification[] = [
  'Brilliant',
  'Great',
  'Best',
  'Excellent',
  'Good',
  'Book',
  'Inaccuracy',
  'Mistake',
  'Miss',
  'Blunder',
];

const PERSPECTIVES: ReadonlyArray<{ value: ReviewPerspective; label: string }> = [
  { value: 'w', label: 'White' },
  { value: 'b', label: 'Black' },
  { value: 'both', label: 'Both' },
];

const SIDE_NAME: Record<'w' | 'b', string> = { w: 'White', b: 'Black' };

function moveLabel(move: ReviewedMove): string {
  return `${move.moveNumber}${move.color === 'w' ? '.' : '...'} ${move.san}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  /** The mistake just solved in Retry, until the next navigation (next/previous keeps retrying). */
  private retrySolved: ReviewedMove | null = null;
  private perspective: ReviewPerspective = 'both';
  /** The tooltip opened by a tap, click or Enter (hover and keyboard focus show them too). */
  private openTip: 'formulas' | 'status' | null = null;
  /** The status line's details, shown in its tooltip ('' while there are none). */
  private statusDetails = '';
  private lastError: string | null = null;
  /** Earlier engine annotations the current review replaced. */
  private strippedAnnotations = 0;
  /** When the review shown was loaded from storage instead of run now. */
  private savedAt: number | null = null;
  /** Bumped for each repertoire check, so a late answer for an earlier game is dropped. */
  private noteSeq = 0;
  /** The move of the game the repertoire note points at. */
  private noteNodeId: string | null = null;
  /** Classifies and explains moves in a worker, shared by every review. */
  private readonly analysisClient = new ReviewAnalysisClient();

  private els!: {
    preset: HTMLSelectElement;
    start: HTMLButtonElement;
    cancel: HTMLButtonElement;
    sample: HTMLButtonElement;
    progress: HTMLElement;
    statusTip: HTMLElement;
    info: HTMLButtonElement;
    progressFill: HTMLElement;
    progressText: HTMLElement;
    body: HTMLElement;
    perspective: HTMLElement;
    chart: SVGSVGElement;
    chartLabel: HTMLElement;
    chartArea: SVGPathElement;
    chartLine: SVGPathElement;
    chartMarkers: SVGGElement;
    chartCursor: SVGLineElement;
    sides: Record<
      'w' | 'b',
      {
        card: HTMLElement;
        heading: HTMLElement;
        accuracy: HTMLElement;
        acpl: HTMLElement;
        botName: HTMLElement;
        botLevel: HTMLElement;
        countHead: HTMLElement;
      }
    >;
    counts: HTMLTableElement;
    moments: HTMLElement;
    errorPrev: HTMLButtonElement;
    errorNext: HTMLButtonElement;
    errorLabel: HTMLElement;
    cardBadge: HTMLElement;
    cardTitle: HTMLElement;
    cardEval: HTMLElement;
    cardText: HTMLElement;
    cardDetail: HTMLElement;
    retryBtn: HTMLButtonElement;
    refutationBtn: HTMLButtonElement;
    playBtn: HTMLButtonElement;
    exportBtn: HTMLButtonElement;
    coachLabel: HTMLElement;
    coachPrev: HTMLButtonElement;
    coachNext: HTMLButtonElement;
    coachNextLabel: HTMLElement;
    startLabel: HTMLElement;
    repertoire: HTMLElement;
    repertoireText: HTMLElement;
    repertoireJump: HTMLButtonElement;
  };
  private menu!: Menu;

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
    const side = (c: 'w' | 'b') => `
      <div class="wc-review-side wc-review-side-${c}" data-testid="review-side-${c}" data-emphasis="none">
        <span class="wc-review-side-name"><i class="wc-review-side-dot" aria-hidden="true"></i><span data-testid="review-player-${c}">${SIDE_NAME[c]}</span></span>
        <span class="wc-review-accuracy-row"><span class="wc-review-accuracy" data-testid="review-accuracy-${c}">—</span><span class="wc-review-accuracy-unit">accuracy</span></span>
        <span class="wc-review-side-meta">ACPL <b data-testid="review-acpl-${c}">—</b></span>
      </div>`;
    const countCell = (c: 'w' | 'b', cls: MoveClassification) =>
      `<td class="wc-review-col-${c}"><button type="button" class="wc-review-count-btn" data-testid="review-count-${CLASS_BADGE[cls].slug}-${c}" data-class="${cls}" data-color="${c}" disabled>0</button></td>`;
    const countRows = COUNT_ORDER.map(
      (cls) => `
        <tr data-testid="review-count-${CLASS_BADGE[cls].slug}">
          <th scope="row">${classBadgeHtml(cls)}<span class="wc-review-count-label">${cls}</span></th>
          ${countCell('w', cls)}
          ${countCell('b', cls)}
        </tr>`,
    ).join('');
    const perspectiveButtons = PERSPECTIVES.map(
      (p) =>
        `<button type="button" role="radio" class="wc-review-perspective-btn" data-perspective="${p.value}" data-testid="review-perspective-${p.value}" aria-checked="${p.value === this.perspective}">${p.label}</button>`,
    ).join('');

    this.root.innerHTML = `
      <div class="wc-review-head">
        <div class="wc-review-intro" data-testid="review-intro">
          <h3 class="wc-review-intro-title">Review this game</h3>
          <p class="wc-review-intro-text">Stockfish checks every move: your accuracy, the key moments, and what to play instead, explained one at a time.</p>
        </div>
        <div class="wc-review-actions">
          <select class="wc-select wc-select-sm" data-testid="select-review-preset" aria-label="Review depth">${presetOptions}</select>
          <button type="button" class="wc-btn wc-btn-primary wc-review-start-btn" data-testid="btn-review-start">${icon('review')}<span data-testid="review-start-label">Start review</span></button>
          <button type="button" class="wc-btn wc-btn-danger" data-testid="btn-review-cancel" disabled>Cancel</button>
          <button type="button" class="wc-btn wc-btn-ghost" data-testid="btn-review-sample" title="Morphy vs. Duke Karl / Count Isouard, Paris 1858">Sample game</button>
        </div>
      </div>
      <div class="wc-review-status" data-tip="status" data-has-details="false">
        <div class="wc-review-progress" data-testid="review-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-describedby="wc-review-status-tip">
          <div class="wc-review-progress-fill" data-testid="review-progress-fill"></div>
          <span class="wc-review-progress-text" data-testid="review-progress-text">Not reviewed</span>
          <span class="wc-review-status-more" aria-hidden="true">i</span>
        </div>
        <div class="wc-review-tooltip wc-review-status-tip" id="wc-review-status-tip" role="tooltip" data-testid="review-status-tooltip"></div>
      </div>
      <div class="wc-review-body" data-testid="review-body" hidden>
        <div class="wc-review-repertoire" data-testid="review-repertoire" data-kind="" role="status" hidden>
          <span class="wc-review-repertoire-icon" aria-hidden="true">${icon('book')}</span>
          <span class="wc-review-repertoire-text" data-testid="review-repertoire-text"></span>
          <button type="button" class="wc-btn wc-btn-ghost wc-btn-sm" data-testid="btn-review-repertoire-jump" hidden>Show move</button>
        </div>
        <section class="wc-coach" data-testid="review-coach" aria-label="Key moments">
          <div class="wc-coach-head">
            <span class="wc-coach-label" data-testid="review-coach-label">Key moments</span>
            <ol class="wc-review-moments" data-testid="review-key-moments" aria-label="Key moments"></ol>
          </div>
          <div class="wc-review-card" data-testid="review-move-card">
            <div class="wc-review-card-head">
              <span class="wc-review-card-badge" data-testid="review-card-badge"></span>
              <span class="wc-review-card-title" data-testid="review-card-title"></span>
              <span class="wc-review-card-eval" data-testid="review-card-eval"></span>
            </div>
            <div class="wc-review-card-text" data-testid="review-card-text"></div>
            <div class="wc-review-card-detail" data-testid="review-card-detail"></div>
          </div>
          <div class="wc-coach-actions">
            <button type="button" class="wc-btn wc-btn-primary wc-btn-action" data-testid="btn-review-retry">Try it</button>
            <button type="button" class="wc-btn wc-btn-secondary wc-btn-action" data-testid="btn-review-refutation">Show refutation</button>
            <span class="wc-grow"></span>
            <button type="button" class="wc-btn wc-btn-secondary wc-btn-icon" data-testid="btn-coach-prev" aria-label="Previous key moment" title="Previous key moment">${icon('back')}</button>
            <button type="button" class="wc-btn wc-btn-secondary wc-btn-action wc-coach-next" data-testid="btn-coach-next"><span data-testid="coach-next-label">Next moment</span>${icon('next')}</button>
          </div>
        </section>
        <div class="wc-review-errnav">
          <button type="button" class="wc-btn wc-btn-ghost wc-btn-sm" data-testid="btn-review-prev-mistake" aria-label="Previous mistake">${icon('back')}</button>
          <span class="wc-review-errnav-label" data-testid="review-mistake-position">No errors</span>
          <button type="button" class="wc-btn wc-btn-ghost wc-btn-sm" data-testid="btn-review-next-mistake" aria-label="Next mistake">${icon('next')}</button>
        </div>
        <div class="wc-review-chart-wrap">
          <svg class="wc-review-chart" data-testid="review-chart" viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" role="img" aria-label="White's win percentage through the game; click to jump to a move">
            <rect class="wc-review-chart-bg" x="0" y="0" width="${CHART_W}" height="${CHART_H}"></rect>
            <path class="wc-review-chart-area" data-testid="review-chart-area" d=""></path>
            <path class="wc-review-chart-line" d=""></path>
            <line class="wc-review-chart-mid" x1="0" y1="${CHART_H / 2}" x2="${CHART_W}" y2="${CHART_H / 2}"></line>
            <g class="wc-review-chart-markers"></g>
            <line class="wc-review-chart-cursor" data-testid="review-chart-cursor" x1="0" y1="0" x2="0" y2="${CHART_H}"></line>
          </svg>
          <span class="wc-review-chart-label" data-testid="review-chart-label" aria-hidden="true">White ↑</span>
        </div>
        <div class="wc-review-summary">
          ${side('w')}
          ${side('b')}
          <div class="wc-review-formulas" data-tip="formulas">
            <button type="button" class="wc-review-info-btn" data-testid="btn-review-formulas" aria-describedby="wc-review-formulas-tip" aria-expanded="false" aria-label="How these numbers are computed">i</button>
            <div class="wc-review-tooltip" id="wc-review-formulas-tip" role="tooltip" data-testid="review-formulas-tooltip">
              <p class="wc-review-tooltip-levels"><b>Bot level (approx.)</b>: <span data-testid="review-bot-name-w">White</span> <b data-testid="review-bot-level-w">—</b> · <span data-testid="review-bot-name-b">Black</span> <b data-testid="review-bot-level-b">—</b></p>
              <p><b>Win%</b> = 50 + 50·(2 / (1 + e<sup>−0.00368208·cp</sup>) − 1), from the engine score in centipawns, clamped to ±1000. A forced mate counts as ±1000 (97.5% / 2.5%), as on Lichess.</p>
              <p><b>Move accuracy</b> = 103.1668·e<sup>−0.04354·drop</sup> − 3.1669 + 1, clamped to 0–100, where drop is how much the move lowered your Win% (the +1 is Lichess's allowance for imprecise evaluations).</p>
              <p><b>Game accuracy</b> (Lichess method): the average of (a) your move accuracies weighted by how volatile the game was around each move (standard deviation of Win% over a sliding window) and (b) their harmonic mean, which pulls the result down for a few very bad moves.</p>
              <p><b>ACPL</b> (as on Lichess): the average over all your moves of how many centipawns each lost, with evaluations clamped to ±1000 and a mate counted as ±1000.</p>
              <p><b>Bot level (approx.)</b>: the in-app bot whose calibrated average loss matches yours in this game. It is not a rating estimate: the bots are calibrated against Stockfish, not people, and one game's average is dominated by its few biggest mistakes, so it usually reads far below a human player's rating.</p>
            </div>
          </div>
        </div>
        <details class="wc-disclosure wc-review-classes" data-testid="review-classes">
          <summary>All moves by class${icon('caret')}</summary>
          <div class="wc-disclosure-body">
          <table class="wc-review-counts" data-testid="review-counts" data-perspective="both">
            <thead>
              <tr>
                <th scope="col"><span class="wc-sr-only">Move class</span></th>
                <th scope="col" class="wc-review-col-w" data-testid="review-counts-head-w">White</th>
                <th scope="col" class="wc-review-col-b" data-testid="review-counts-head-b">Black</th>
              </tr>
            </thead>
            <tbody>${countRows}</tbody>
          </table>
          </div>
        </details>
        <div class="wc-review-foot" data-testid="review-foot">
          <div class="wc-review-perspective" role="radiogroup" aria-label="Review as" data-testid="review-perspective">
            <span class="wc-review-perspective-label">Review as</span>
            ${perspectiveButtons}
          </div>
        </div>
      </div>
    `;
    // ⋯ on the footer: the review's other tools
    this.menu = new Menu(
      this.root.querySelector('[data-testid="review-foot"]') as HTMLElement,
      [
        {
          id: 'play',
          label: 'Play vs bot from here',
          testId: 'btn-review-play-bot',
          icon: 'play',
          onSelect: () => this.options.onPlayVsBot(this.host.getCurrentNode().fen),
        },
        {
          id: 'export',
          label: 'Export annotated PGN',
          testId: 'btn-review-export',
          icon: 'download',
          onSelect: () => this.exportAnnotatedPgn(),
        },
      ],
      { testId: 'review-menu', label: 'More review tools' },
    );

    const q = <T extends Element>(id: string) => this.root.querySelector(`[data-testid="${id}"]`) as T;
    const chart = q<SVGSVGElement>('review-chart');
    const sideEls = (c: 'w' | 'b') => ({
      card: q<HTMLElement>(`review-side-${c}`),
      heading: q<HTMLElement>(`review-player-${c}`),
      accuracy: q<HTMLElement>(`review-accuracy-${c}`),
      acpl: q<HTMLElement>(`review-acpl-${c}`),
      botName: q<HTMLElement>(`review-bot-name-${c}`),
      botLevel: q<HTMLElement>(`review-bot-level-${c}`),
      countHead: q<HTMLElement>(`review-counts-head-${c}`),
    });
    this.els = {
      preset: q('select-review-preset'),
      start: q('btn-review-start'),
      cancel: q('btn-review-cancel'),
      sample: q('btn-review-sample'),
      progress: q('review-progress'),
      statusTip: q('review-status-tooltip'),
      info: q('btn-review-formulas'),
      progressFill: q('review-progress-fill'),
      progressText: q('review-progress-text'),
      body: q('review-body'),
      perspective: q('review-perspective'),
      chart,
      chartLabel: q('review-chart-label'),
      chartArea: q('review-chart-area'),
      chartLine: chart.querySelector('.wc-review-chart-line') as SVGPathElement,
      chartMarkers: chart.querySelector('.wc-review-chart-markers') as SVGGElement,
      chartCursor: q('review-chart-cursor'),
      sides: { w: sideEls('w'), b: sideEls('b') },
      counts: q('review-counts'),
      moments: q('review-key-moments'),
      errorPrev: q('btn-review-prev-mistake'),
      errorNext: q('btn-review-next-mistake'),
      errorLabel: q('review-mistake-position'),
      cardBadge: q('review-card-badge'),
      cardTitle: q('review-card-title'),
      cardEval: q('review-card-eval'),
      cardText: q('review-card-text'),
      cardDetail: q('review-card-detail'),
      retryBtn: q('btn-review-retry'),
      refutationBtn: q('btn-review-refutation'),
      playBtn: q('btn-review-play-bot'),
      exportBtn: q('btn-review-export'),
      coachLabel: q('review-coach-label'),
      coachPrev: q('btn-coach-prev'),
      coachNext: q('btn-coach-next'),
      coachNextLabel: q('coach-next-label'),
      startLabel: q('review-start-label'),
      repertoire: q('review-repertoire'),
      repertoireText: q('review-repertoire-text'),
      repertoireJump: q('btn-review-repertoire-jump'),
    };
    this.els.repertoireJump.addEventListener('click', () => {
      if (this.noteNodeId) this.host.goToNode(this.noteNodeId);
    });

    this.els.preset.addEventListener('change', () => {
      this.preset = this.els.preset.value as ReviewPreset;
      this.options.onPresetChange?.(this.preset);
    });
    this.els.start.addEventListener('click', () => {
      void this.start();
    });
    this.els.cancel.addEventListener('click', () => this.cancel());
    this.els.sample.addEventListener('click', () => {
      void this.loadSampleGame();
    });
    this.els.perspective.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-perspective]');
      const value = btn?.getAttribute('data-perspective') as ReviewPerspective | null;
      if (value) this.setPerspective(value);
    });
    chart.addEventListener('click', (e) => this.handleChartClick(e));
    this.els.moments.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-node-id]');
      const id = btn?.getAttribute('data-node-id');
      if (id) this.host.goToNode(id);
    });
    this.els.counts.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-class]');
      if (!btn) return;
      this.stepThroughClass(
        btn.getAttribute('data-color') as 'w' | 'b',
        btn.getAttribute('data-class') as MoveClassification,
      );
    });
    this.els.errorPrev.addEventListener('click', () => this.stepError(-1));
    this.els.errorNext.addEventListener('click', () => this.stepError(1));
    // Tooltips open on hover (devices that hover), keyboard focus, or a tap / click, which
    // toggles; a tap outside or Escape closes them
    this.els.info.addEventListener('click', () => this.toggleTip('formulas'));
    this.els.progress.addEventListener('click', () => {
      if (this.statusDetails) this.toggleTip('status');
    });
    this.els.progress.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && this.statusDetails) {
        e.preventDefault();
        this.toggleTip('status');
      }
    });
    document.addEventListener(
      'pointerdown',
      (e) => {
        const tip = this.openTip;
        if (tip && !(e.target as Element | null)?.closest?.(`[data-tip="${tip}"]`)) this.setTip(null);
      },
      true,
    );
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.openTip) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest('[data-tip]') && this.root.contains(focused)) {
        focused.blur();
      }
      this.setTip(null);
    });
    this.els.retryBtn.addEventListener('click', () => this.startRetry());
    this.els.refutationBtn.addEventListener('click', () => this.showRefutation());
    this.els.coachPrev.addEventListener('click', () => this.stepMoment(-1));
    this.els.coachNext.addEventListener('click', () => this.stepMoment(1));
  }

  private toggleTip(tip: 'formulas' | 'status'): void {
    this.setTip(this.openTip === tip ? null : tip);
  }

  private setTip(tip: 'formulas' | 'status' | null): void {
    this.openTip = tip;
    if (tip) this.root.setAttribute('data-tip-open', tip);
    else this.root.removeAttribute('data-tip-open');
    this.els.info.setAttribute('aria-expanded', String(tip === 'formulas'));
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

  public getPerspective(): ReviewPerspective {
    return this.perspective;
  }

  /**
   * Shows the review from one side (or both). Only the view changes: the engine results
   * are reused. Choosing a side flips the board to it; Both leaves the board as it is.
   */
  public setPerspective(perspective: ReviewPerspective): void {
    this.perspective = perspective;
    if (perspective !== 'both') this.host.setOrientation(perspective);
    this.renderPerspective();
  }

  public async loadSampleGame(): Promise<ReviewRunResult | null> {
    this.cancel();
    // Parsing the game, showing it and starting the review are each ~10–30 ms of main-thread
    // work (more on a busy machine): separate tasks, so none becomes a long task
    if (!(await this.host.importPgnFromStart(SAMPLE_GAME_PGN))) return null;
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
    this.options.onRunningChange?.(true);
    this.els.body.hidden = false;
    this.savedAt = null;
    this.renderPlayers(tree.getHeaders());
    this.setPerspective(defaultPerspective(tree.getHeaders(), this.accounts()));
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
      if (!result.cancelled) this.options.onReviewFinished?.(result, tree); // stored first, shown after
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
      // (a newer run already replaced this one: it reports its own end)
      if (this.abort === abort) {
        this.abort = null;
        this.options.onRunningChange?.(false);
      }
    }
  }

  public cancel(): void {
    if (this.abort && this.state === 'running') {
      this.abort.abort();
    }
  }

  private accounts(): readonly UserAccount[] {
    return this.options.getAccounts?.() ?? DEFAULT_USER_ACCOUNTS;
  }

  /**
   * Shows a stored review of the board's game without running the engine. False (and
   * nothing changes) when the board's main line isn't the one the review covers.
   */
  public showSavedReview(saved: SavedReview): boolean {
    const tree = this.host.getGameTree();
    const restored = restoreSavedReview(saved, tree);
    if (!restored) return false;
    this.cancel();
    this.strippedAnnotations = this.host.stripEngineAnnotations();
    this.runGeneration++;
    this.tree = tree;
    this.plies = restored.plies;
    this.review = null;
    this.result = restored;
    this.positions = restored.positions;
    this.byNode.clear();
    this.appliedNodes.clear();
    this.exitRetry();
    this.lastError = null;
    this.savedAt = saved.savedAt;
    if (saved.preset) this.setPreset(saved.preset);
    this.state = 'done';
    this.els.body.hidden = false;
    this.renderPlayers(tree.getHeaders());
    this.setPerspective(defaultPerspective(tree.getHeaders(), this.accounts()));
    this.acceptReview(restored.review, true);
    return true;
  }

  /** When the review shown was saved (null for a review run in this session). */
  public getSavedAt(): number | null {
    return this.savedAt;
  }

  // ------------------------------------------------------------------ review updates

  private reset(): void {
    this.cancel();
    this.menu.close();
    this.runGeneration++;
    this.exitRetry();
    this.tree = null;
    this.plies = [];
    this.review = null;
    this.result = null;
    this.positions = [];
    this.byNode.clear();
    this.appliedNodes.clear();
    this.savedAt = null;
    this.state = 'idle';
    this.perspective = 'both';
    this.noteSeq++;
    this.noteNodeId = null;
    this.els.repertoire.hidden = true;
    this.els.body.hidden = true;
    this.renderPerspective();
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
    this.renderMoments(review);
    this.renderChart(review);
    this.renderErrorNav();
    this.renderMoveCard(this.host.getCurrentNode());
    if (final) void this.renderRepertoireNote();
  }

  /**
   * One line when this is my game and it leaves my repertoire (or follows it to the end): where
   * it happened, with a button to the move. Nothing for games that aren't mine (matched by my
   * usernames), or when I have no repertoire for my side.
   */
  private async renderRepertoireNote(): Promise<void> {
    const seq = ++this.noteSeq;
    const tree = this.tree;
    const find = this.options.findRepertoireDeparture;
    const hide = () => {
      this.noteNodeId = null;
      this.els.repertoire.hidden = true;
      this.els.repertoire.setAttribute('data-kind', '');
    };
    if (!find || !tree) {
      hide();
      return;
    }
    const mine = defaultPerspective(tree.getHeaders(), this.accounts());
    if (mine === 'both') {
      hide();
      return;
    }
    let departure: RepertoireDeparture | null = null;
    try {
      departure = await find(tree, mine);
    } catch {
      departure = null;
    }
    if (seq !== this.noteSeq || this.tree !== tree) return;
    if (!departure) {
      hide();
      return;
    }
    this.noteNodeId = departure.kind === 'followed' ? null : departure.nodeId;
    this.els.repertoireText.textContent = describeDeparture(departure, mine);
    this.els.repertoire.setAttribute('data-kind', departure.kind);
    this.els.repertoireJump.hidden = this.noteNodeId === null;
    this.els.repertoire.hidden = false;
  }

  // ------------------------------------------------------------------ rendering

  private renderState(): void {
    const running = this.state === 'running';
    this.els.start.disabled = running;
    this.els.sample.disabled = running;
    this.els.preset.disabled = running;
    this.els.cancel.disabled = !running;
    this.root.setAttribute('data-state', this.state);
    this.root.setAttribute('data-reviewed', String(this.review !== null));
    this.els.startLabel.textContent = this.review !== null && !running ? 'Review again' : 'Start review';

    const review = this.review;
    const total = review?.totalPositions ?? 0;
    const done = review?.analyzedPositions ?? 0;
    const fraction = total > 0 ? done / total : 0;
    this.els.progressFill.style.transform = `scaleX(${fraction})`;
    this.els.progressFill.parentElement?.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));

    let text: string;
    let details = '';
    switch (this.state) {
      case 'idle':
        text = 'Not reviewed yet. Choose a depth and press Start review.';
        break;
      case 'running':
        text = `Reviewing (${PRESET_LABEL[this.preset]})… ${done} / ${total || '…'} positions`;
        break;
      case 'done': {
        // Short line; the details go in the tooltip
        const stats = this.result?.stats;
        const seconds = (stats?.timeMs ?? 0) / 1000;
        const hinted = hintedMoves(this.host.getGameTree());
        text = `Reviewed · ${PRESET_LABEL[this.preset]} · ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
        details = [
          this.savedAt !== null ? `saved review from ${new Date(this.savedAt).toLocaleString()}` : '',
          `${total} positions in ${seconds.toFixed(1)} s`,
          `mean depth ${(stats?.meanDepth ?? 0).toFixed(1)}`,
          `${(REVIEW_PRESET_MOVETIME_MS[this.preset] / 1000).toFixed(1)} s per position`,
          this.strippedAnnotations > 0
            ? `replaced ${this.strippedAnnotations} earlier engine annotation${this.strippedAnnotations === 1 ? '' : 's'}`
            : '',
          hinted.length > 0
            ? `${hinted.length} move${hinted.length === 1 ? '' : 's'} played after a hint (${describeHintedMoves(hinted)})`
            : '',
        ]
          .filter(Boolean)
          .join(' · ');
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
    this.statusDetails = details;
    this.els.statusTip.textContent = details;
    this.els.progress.setAttribute('data-details', details);
    this.els.progress.parentElement?.setAttribute('data-has-details', String(details !== ''));
    if (details) {
      this.els.progress.tabIndex = 0;
      this.els.progress.setAttribute('aria-label', `${text}. Press for details.`);
    } else {
      this.els.progress.removeAttribute('tabindex');
      this.els.progress.removeAttribute('aria-label');
      if (this.openTip === 'status') this.setTip(null);
    }
    this.els.exportBtn.disabled = !review || review.moves.length === 0 || running;
  }

  /** Player names and ratings from the PGN headers: the side cards, the table, the tooltip. */
  private renderPlayers(headers: Readonly<Record<string, string>>): void {
    for (const c of ['w', 'b'] as const) {
      const info = playerInfo(headers, c);
      const els = this.els.sides[c];
      // Name, then "rating · color"; on a narrow panel the second part gets its own line
      const meta = playerMeta(info);
      els.heading.innerHTML = `<span class="wc-review-player-name">${escapeHtml(info.name)}</span>${
        meta
          ? `<span class="wc-review-player-sep"> · </span><span class="wc-review-player-meta">${escapeHtml(meta)}</span>`
          : ''
      }`;
      els.heading.title = playerHeading(info);
      els.botName.textContent = info.name;
      els.countHead.textContent = info.name;
      els.countHead.title = `${info.name} (${SIDE_NAME[c]})`;
      this.els.perspective
        .querySelector(`[data-perspective="${c}"]`)
        ?.setAttribute('title', `Review as ${SIDE_NAME[c]}: ${info.name}`);
    }
  }

  private renderSummary(review: GameReview): void {
    const fill = (c: 'w' | 'b', side: SideReviewSummary) => {
      const els = this.els.sides[c];
      els.accuracy.textContent = side.accuracy === null ? '—' : side.accuracy.toFixed(1);
      els.botLevel.textContent = formatBotLevel(side.botLevel);
      els.acpl.textContent = side.acpl === null ? '—' : Math.round(side.acpl).toString();
      for (const cls of COUNT_ORDER) {
        const btn = this.els.counts.querySelector<HTMLButtonElement>(
          `[data-testid="review-count-${CLASS_BADGE[cls].slug}-${c}"]`,
        );
        if (!btn) continue;
        const count = side.counts[cls];
        btn.textContent = String(count);
        btn.disabled = count === 0;
        btn.setAttribute('data-zero', String(count === 0));
        btn.setAttribute(
          'aria-label',
          `${SIDE_NAME[c]}: ${count} ${cls}${count === 0 ? '' : ', jump to the next one'}`,
        );
      }
    };
    fill('w', review.white);
    fill('b', review.black);
  }

  /** Everything the perspective changes; the engine results are untouched. */
  private renderPerspective(): void {
    const p = this.perspective;
    this.root.setAttribute('data-perspective', p);
    for (const btn of this.els.perspective.querySelectorAll<HTMLElement>('[data-perspective]')) {
      btn.setAttribute('aria-checked', String(btn.getAttribute('data-perspective') === p));
    }
    for (const c of ['w', 'b'] as const) {
      this.els.sides[c].card.setAttribute('data-emphasis', p === 'both' ? 'none' : p === c ? 'primary' : 'secondary');
    }
    this.els.counts.setAttribute('data-perspective', p);
    this.els.chartLabel.textContent = `${p === 'b' ? 'Black' : 'White'} ↑`;
    this.els.chart.setAttribute(
      'aria-label',
      `${p === 'b' ? 'Black' : 'White'}'s win percentage through the game; click to jump to a move`,
    );
    this.els.chart.setAttribute('data-perspective', p);
    const review = this.review;
    if (!review) {
      this.renderErrorNav();
      return;
    }
    this.renderMoments(review);
    this.renderChart(review);
    this.renderErrorNav();
    this.renderMoveCard(this.host.getCurrentNode());
  }

  private renderMoments(review: GameReview): void {
    const moments = perspectiveKeyMoments(review, this.perspective);
    const byId = new Map(review.moves.map((m) => [m.nodeId, m]));
    if (moments.length === 0) {
      this.els.moments.innerHTML = `<li class="wc-review-muted">${
        review.complete || this.state !== 'running' ? 'No big swings.' : 'Key moments appear as the review runs.'
      }</li>`;
      return;
    }
    const forSide = this.perspective === 'both' ? 'White' : SIDE_NAME[this.perspective];
    this.els.moments.innerHTML = moments
      .map((k) => {
        const move = byId.get(k.nodeId);
        if (!move) return '';
        const sentence = move.explanation ?? this.classSentence(move);
        const swing = this.perspective === 'b' ? -k.swing : k.swing;
        const title = `${moveLabel(move)} — ${move.classification} (${swing > 0 ? '+' : ''}${swing.toFixed(0)}% for ${forSide}). ${sentence}`;
        return `<li><button type="button" class="wc-review-moment" data-node-id="${k.nodeId}" data-testid="review-moment-${k.ply}" data-color="${move.color}" title="${escapeHtml(title)}">${classBadgeHtml(move.classification)}<span class="wc-review-moment-move">${escapeHtml(moveLabel(move))}</span><span class="wc-review-moment-text">${escapeHtml(sentence)}</span></button></li>`;
      })
      .join('');
  }

  private renderChart(review: GameReview): void {
    const series = perspectiveSeries(review.whiteWinSeries, this.perspective);
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
      this.els.chartArea.setAttribute('d', `M0,${CHART_H} L${points.join(' L')} L${x(last).toFixed(1)},${CHART_H} Z`);
    }
    this.els.chart.setAttribute('data-analyzed', String(last + 1));

    const markers = review.moves
      .filter((m) => coversMove(this.perspective, m))
      .filter((m) => isErrorClass(m.classification) || m.classification === 'Brilliant' || m.classification === 'Great')
      .map(
        (m) =>
          `<line class="wc-review-chart-marker wc-class-${CLASS_BADGE[m.classification].slug}" x1="${x(m.ply).toFixed(1)}" x2="${x(m.ply).toFixed(1)}" y1="0" y2="${CHART_H}" data-ply="${m.ply}"><title>${escapeHtml(`${moveLabel(m)}: ${m.classification}`)}</title></line>`,
      )
      .join('');
    this.els.chartMarkers.innerHTML = markers;
    this.positionChartCursor(this.host.getCurrentNode());
  }

  /** The perspective's errors and where the current move is among them. */
  /** The coach card's head: which key moment this is, and where Previous / Next go. */
  private renderCoach(): void {
    const review = this.review;
    const moments = review ? [...perspectiveKeyMoments(review, this.perspective)].sort((a, b) => a.ply - b.ply) : [];
    const current = this.retry?.move ?? this.retrySolved ?? this.currentReviewedMove();
    const index = current ? moments.findIndex((k) => k.nodeId === current.nodeId) : -1;
    const n = moments.length;
    this.els.coachLabel.textContent =
      n === 0
        ? review?.complete === false
          ? 'Key moments appear as the review runs'
          : 'No big swings in this game'
        : index >= 0
          ? `Key moment ${index + 1} of ${n}`
          : `${n} key moment${n === 1 ? '' : 's'}`;
    const curPly = current?.ply ?? this.plyOfNode(this.host.getCurrentNode()) ?? 0;
    this.els.coachNextLabel.textContent =
      index < 0 && moments.every((k) => k.ply > curPly) ? 'First moment' : 'Next moment';
    this.els.coachPrev.disabled = n === 0;
    this.els.coachNext.disabled = n === 0;
    for (const el of this.els.moments.querySelectorAll<HTMLElement>('[data-node-id]')) {
      if (current && el.getAttribute('data-node-id') === current.nodeId) el.setAttribute('aria-current', 'step');
      else el.removeAttribute('aria-current');
    }
  }

  /** The perspective's next (1) or previous (−1) key moment by game order, wrapping around. */
  private stepMoment(dir: 1 | -1): void {
    const review = this.review;
    if (!review) return;
    const moments = [...perspectiveKeyMoments(review, this.perspective)].sort((a, b) => a.ply - b.ply);
    if (moments.length === 0) return;
    const current = this.retry?.move ?? this.retrySolved ?? this.currentReviewedMove();
    const fromPly = current?.ply ?? this.plyOfNode(this.host.getCurrentNode()) ?? 0;
    const target =
      dir === 1
        ? (moments.find((k) => k.ply > fromPly) ?? moments[0])
        : ([...moments].reverse().find((k) => k.ply < fromPly) ?? moments[moments.length - 1]);
    if (this.retry) this.exitRetry();
    if (target) this.host.goToNode(target.nodeId);
  }

  private renderErrorNav(): void {
    this.renderCoach();
    const errors = this.review ? perspectiveErrors(this.review.moves, this.perspective) : [];
    const whose = this.perspective === 'both' ? 'All' : SIDE_NAME[this.perspective];
    const current = this.retry?.move ?? this.retrySolved ?? this.currentReviewedMove();
    const index = current ? errors.findIndex((m) => m.nodeId === current.nodeId) : -1;
    this.els.errorPrev.disabled = errors.length === 0;
    this.els.errorNext.disabled = errors.length === 0;
    this.els.errorLabel.textContent =
      errors.length === 0
        ? `${whose === 'All' ? 'No' : `No ${whose}`} errors`
        : `${whose} errors · ${index >= 0 ? index + 1 : '–'} / ${errors.length}`;
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
    this.retrySolved = null;
    this.positionChartCursor(node);
    this.renderMoveCard(node);
    this.renderErrorNav();
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
    const canRetry = Boolean(isError && reviewed && coversMove(this.perspective, reviewed));
    els.retryBtn.disabled = !canRetry && !this.retry;
    els.retryBtn.title =
      isError && !canRetry && this.perspective !== 'both'
        ? `Reviewing as ${SIDE_NAME[this.perspective]}: retry covers ${SIDE_NAME[this.perspective]}'s moves`
        : '';
    els.retryBtn.textContent = this.retry ? 'Stop trying' : 'Try it';
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
    if (!move || !isErrorClass(move.classification) || !coversMove(this.perspective, move)) return;
    const node = this.host.getGameTree().getNode(move.nodeId);
    if (!node?.parentId) return;
    this.retry = { move, parentId: node.parentId, attempt: 0 };
    this.retryMessage = null;
    this.host.setMoveInterceptor((played, created) => this.handleRetryMove(played, created));
    this.host.goToNode(node.parentId);
  }

  /**
   * Jumps to the perspective's next (1) or previous (−1) error, wrapping around. While
   * retrying (or right after solving one), the retry moves on to that error.
   */
  private stepError(dir: 1 | -1): void {
    const review = this.review;
    if (!review) return;
    const errors = perspectiveErrors(review.moves, this.perspective);
    const from = this.retry?.move ?? this.retrySolved ?? this.currentReviewedMove();
    const fromPly = from?.ply ?? this.plyOfNode(this.host.getCurrentNode()) ?? 0;
    const target = stepCycle(errors, fromPly, dir);
    if (!target) return;
    const keepRetrying = this.retry !== null || this.retrySolved !== null;
    this.host.goToNode(target.nodeId);
    if (keepRetrying) this.startRetry();
  }

  /** A click on a count: the next move of that class by that side, wrapping around. */
  private stepThroughClass(color: 'w' | 'b', classification: MoveClassification): void {
    const review = this.review;
    if (!review) return;
    const fromPly = this.plyOfNode(this.host.getCurrentNode()) ?? 0;
    const target = stepCycle(movesOfClass(review.moves, color, classification), fromPly, 1);
    if (target) this.host.goToNode(target.nodeId);
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
    this.retrySolved = this.retry?.move ?? null;
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
    const extendsGame = matched < move.refutationUci.length && cursor.children.length === 0 && mainLine.has(cursor.id);
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
