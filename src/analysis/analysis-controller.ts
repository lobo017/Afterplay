import {
  GameTree,
  nagToGlyph,
  type GameNode,
  type PgnArrowAnnotation,
  type PgnHighlightAnnotation,
} from '../core/game-tree';
import { parsePgn, writePgn } from '../core/pgn';
import {
  DEFAULT_POSITION,
  RulesAdapter,
  validateChessFen,
  type ExecutedMove,
  type MoveInput,
  type Square,
} from '../core/rules';
import {
  EngineCancelledError,
  EngineClient,
  type EngineAnalysisResult,
  type EngineLine,
} from '../engine/engine-client';
import type { UciScore } from '../engine/uci-parser';
import { CathedralAudio } from '../render/audio';
import { BoardRenderer } from '../render/board-renderer';
import {
  EngineLinesPanel,
  type GhostLinePreviewPayload,
  type SelectLineVariationPayload,
} from './engine-lines-panel';
import {
  EvalBar,
  formatEvalBarScore,
  pgnEvalToUciScore,
} from './eval-bar';
import {
  formatOpeningBadge,
  lookupGameOpening,
  lookupOpeningByFen,
} from './opening-lookup';
import { PositionEditor } from './position-editor';
import { classBadgeHtml, type ReviewTreeEntry } from '../review/review-panel';
import { stripEngineAnnotations } from '../review/annotations';
import type { AppSettings, AppSettingsStore } from '../ui/app-settings';
import { switchRowHtml } from '../ui/components/controls';
import { icon } from '../ui/components/icons';
import { Sheet } from '../ui/components/sheet';
import { Tabs, tabListHtml, tabPanelAttrs } from '../ui/components/tabs';
import {
  detectOpponentThreat,
  type ThreatDetectionResult,
} from './threat-detector';

export type NavAnimationMode = 'off' | 'fast' | 'normal';

/** Duration of the one-move animation when stepping with ← / →. */
export const NAV_ANIMATION_DURATION_MS: Record<NavAnimationMode, number> = {
  off: 0,
  fast: 60,
  normal: 100,
};

/** Steps closer together than this are "rapid": the engine restart waits for a pause. */
const RAPID_NAVIGATION_MS = 150;
const ANALYSIS_RESTART_DELAY_MS = 120;
const PGN_SYNC_DELAY_MS = 400;

export interface AnalysisControllerOptions {
  container: HTMLElement;
  engine: EngineClient;
  /** Shared synthesizer, so the app builds only one AudioContext. */
  audio?: CathedralAudio;
  initialNavAnimation?: NavAnimationMode;
  /** Optional dedicated secondary engine for null-move threat searches so main MultiPV analysis is never interrupted. */
  threatEngine?: EngineClient;
  initialFen?: string;
  initialPgn?: string;
  initialMultiPv?: number;
  analysisDepth?: number;
  threatSearchDepth?: number;
  engineEnabled?: boolean;
  showBestMoveArrow?: boolean;
  showThreatArrow?: boolean;
  initialActive?: boolean;
  /** App settings (board look, move animation); followed live when given. */
  settings?: AppSettingsStore;
}

/** The Review side panel's tabs. */
export type ReviewShellTab = 'review' | 'analysis' | 'moves';

/**
 * Phase 4 Analysis Board Controller.
 * Coordinates:
 * - Animated, mate-aware EvalBar that flips with the board
 * - Live MultiPV (1–5) EngineLinesPanel with ghost piece hover previews & click-to-insert variations
 * - Best-move arrow, null-move Threat arrow, and user-drawn arrows/circles (with modifier keys & PGN [%cal]/[%csl] sync)
 * - Opening lookup (ECO code + opening name from data/openings.json)
 * - Interactive GameTree variation navigator (promote, demote, delete, comments, NAGs)
 * - Position Editor with live FEN validation
 * - PGN Import / Export
 * - Keyboard controls (Left/Right, Up/Down variation switch, Home/End, F flip, Space engine toggle)
 */
export class AnalysisController {
  private readonly container: HTMLElement;
  private readonly engine: EngineClient;
  private readonly threatEngine: EngineClient;
  private readonly audio: CathedralAudio;

  private evalBar!: EvalBar;
  private board!: BoardRenderer;
  private linesPanel!: EngineLinesPanel;
  private positionEditor!: PositionEditor;

  private gameTree: GameTree;
  private adapter: RulesAdapter;

  private isActive: boolean;
  private engineEnabled: boolean;
  private multipv: number;
  private analysisDepth: number;
  private threatSearchDepth: number;
  private showBestMoveArrow: boolean;
  private showThreatArrow: boolean;
  private editorVisible = false;
  private navAnimation: NavAnimationMode;
  private readonly settings: AppSettingsStore | null;
  private unsubscribeSettings: (() => void) | null = null;
  private shellTabs!: Tabs;
  private loadSheet!: Sheet;
  private lastNavigationAt = -Infinity;
  /** The latest navigation came hard on the heels of the previous one. */
  private rapidNavigation = false;

  private analysisGeneration = 0;
  private analysisAbortController: AbortController | null = null;
  private threatAbortController: AbortController | null = null;
  private pendingRafId: number | null = null;
  private analysisStartTimer: ReturnType<typeof setTimeout> | null = null;
  private pgnSyncTimer: ReturnType<typeof setTimeout> | null = null;

  /** Tree button per node id, rebuilt whenever the tree is re-rendered. */
  private treeNodeEls = new Map<string, HTMLElement>();
  private activeTreeNodeId: string | null = null;
  /**
   * Node offsets inside the tree container, measured once after each render (or resize)
   * so keeping the active move in view never forces a layout during navigation.
   */
  private treeNodeOffsets: Map<string, { top: number; bottom: number }> | null = null;
  private treeViewportHeight = 0;
  private treeScrollTop = 0;
  private treeResizeObserver: ResizeObserver | null = null;
  private nagButtonEls: HTMLButtonElement[] = [];
  private statusCache: {
    adapter: RulesAdapter;
    checkmate: boolean;
    draw: boolean;
    inCheck: boolean;
  } | null = null;

  private latestLines: EngineLine[] = [];
  private latestDepth = 0;
  private latestNps = 0;
  private latestScoreWhite: UciScore = { type: 'cp', value: 0 };
  private latestThreat: ThreatDetectionResult | null = null;

  // Game review hooks (src/review/review-panel.ts)
  private readonly navigateListeners: Array<(node: GameNode) => void> = [];
  private readonly treeReplacedListeners: Array<() => void> = [];
  private moveInterceptor: ((node: GameNode, created: boolean) => void) | null = null;

  // Cached DOM references
  private openingEcoEl!: HTMLElement;
  private openingNameEl!: HTMLElement;
  private statusTextEl!: HTMLElement;
  private evalPillEl!: HTMLElement;
  private threatBadgeEl!: HTMLElement;
  private fenDisplayEl!: HTMLElement;
  private treeContainerEl!: HTMLElement;
  private commentInputEl!: HTMLInputElement;
  private pgnTextareaEl!: HTMLTextAreaElement;
  private pgnStatusEl!: HTMLElement;
  private editorMountEl!: HTMLElement;
  private toggleEditorBtnEl!: HTMLButtonElement;
  private promoteVarBtnEl!: HTMLButtonElement;
  private promoteMainBtnEl!: HTMLButtonElement;
  private demoteVarBtnEl!: HTMLButtonElement;
  private deleteVarBtnEl!: HTMLButtonElement;

  constructor(options: AnalysisControllerOptions) {
    this.container = options.container;
    this.engine = options.engine;
    this.threatEngine = options.threatEngine ?? options.engine;
    this.isActive = options.initialActive ?? true;
    this.engineEnabled = options.engineEnabled ?? true;
    this.multipv = Math.max(1, Math.min(5, options.initialMultiPv ?? 3));
    this.analysisDepth = options.analysisDepth ?? 16;
    this.threatSearchDepth = options.threatSearchDepth ?? 8;
    this.showBestMoveArrow = options.showBestMoveArrow ?? true;
    this.showThreatArrow = options.showThreatArrow ?? true;
    this.settings = options.settings ?? null;
    this.navAnimation =
      options.initialNavAnimation ?? this.settings?.get().navigationAnimation ?? 'normal';

    this.audio =
      options.audio ?? new CathedralAudio({ enabled: true, volume: 0.75 });

    if (options.initialPgn) {
      this.gameTree = parsePgn(options.initialPgn);
    } else {
      const startFen = options.initialFen?.trim() || DEFAULT_POSITION;
      this.gameTree = new GameTree(startFen);
    }
    this.adapter = new RulesAdapter(this.gameTree.currentNode.fen, {
      chess960: this.gameTree.isChess960(),
    });

    this.mountLayout();
    this.bindKeyboardShortcuts();
    this.syncAllFromCurrentNode({ treeChanged: true });
  }

  private mountLayout(): void {
    this.container.innerHTML = `
      <div class="wc-analysis-layout" data-testid="analysis-layout">
        <!-- Board column: opening line, eval bar + board, move navigation -->
        <div class="wc-analysis-board-column">
          <div class="wc-opening-banner" data-testid="opening-badge">
            <span class="wc-opening-eco" data-testid="opening-eco">A00</span>
            <span class="wc-opening-name" data-testid="opening-name">Starting Position</span>
            <span class="wc-threat-pill" data-testid="threat-move-badge" title="Opponent threat from null-move search">
              Threat: —
            </span>
          </div>

          <div class="wc-board-with-eval" data-testid="board-with-eval">
            <div class="wc-eval-bar-mount" data-testid="eval-bar-mount"></div>
            <div class="wc-board-mount" data-testid="analysis-board-mount"></div>
          </div>

          <div class="wc-transport" role="group" aria-label="Move navigation">
            <button type="button" class="wc-btn wc-btn-secondary wc-transport-btn" data-testid="btn-nav-start" title="Start (Home)" aria-label="Start of game">${icon('first')}</button>
            <button type="button" class="wc-btn wc-btn-secondary wc-transport-btn" data-testid="btn-nav-prev" title="Previous move (←)" aria-label="Previous move">${icon('back')}</button>
            <button type="button" class="wc-btn wc-btn-secondary wc-transport-btn" data-testid="btn-nav-next" title="Next move (→)" aria-label="Next move">${icon('next')}</button>
            <button type="button" class="wc-btn wc-btn-secondary wc-transport-btn" data-testid="btn-nav-end" title="End (End)" aria-label="End of game">${icon('last')}</button>
            <button type="button" class="wc-btn wc-btn-secondary wc-transport-btn wc-transport-flip" data-testid="btn-flip-board" title="Flip board (F)" aria-label="Flip board">${icon('flip')}</button>
          </div>
        </div>

        <!-- Side panel: free-analysis tools, status, and the Review / Analysis / Moves tabs -->
        <aside class="wc-panel wc-review-shell" data-testid="review-shell" data-view="tabs" aria-label="Review and analysis">
          <div class="wc-panel-inner">
            <div class="wc-review-toolbar" role="toolbar" aria-label="Free analysis">
              <button type="button" class="wc-btn wc-btn-secondary wc-tool-btn" data-testid="btn-reset-analysis" title="An empty board at the starting position">${icon('board')}<span>New board</span></button>
              <button type="button" class="wc-btn wc-btn-secondary wc-tool-btn" data-testid="btn-toggle-editor" aria-expanded="false" title="Set up any position">${icon('edit')}<span>Edit position</span></button>
              <button type="button" class="wc-btn wc-btn-secondary wc-tool-btn" data-testid="btn-load-pgn" aria-haspopup="dialog" title="Paste a FEN or a PGN">${icon('upload')}<span>Load<span class="wc-tool-more"> FEN / PGN</span></span></button>
            </div>
            <div class="wc-status-header">
              <div class="wc-status-banner" data-testid="analysis-status-banner" role="status" aria-live="polite">White to move</div>
              <div class="wc-eval-pill" data-testid="analysis-eval-pill" title="Evaluation (White's point of view)">+0.00</div>
            </div>

            <section class="wc-review-editor-view" data-testid="review-editor-view" aria-label="Position editor" hidden>
              <div class="wc-panel-body">
                <div class="wc-panel-head">
                  <h2 class="wc-panel-title">Edit position</h2>
                  <button type="button" class="wc-btn wc-btn-primary wc-btn-inline" data-testid="btn-editor-done">Done</button>
                </div>
                <div data-testid="position-editor-mount"></div>
              </div>
            </section>

            <section class="wc-review-tabs-view" data-testid="review-tabs-view">
              ${tabListHtml(
                'review-shell',
                [
                  { id: 'review', label: 'Review' },
                  { id: 'analysis', label: 'Analysis' },
                  { id: 'moves', label: 'Moves' },
                ],
                'review',
                'Review and analysis',
              )}
              <div class="wc-panel-body">
                <div class="wc-tab-panel" ${tabPanelAttrs('review-shell', 'review', 'review')}>
                  <div data-testid="review-panel-mount"></div>
                </div>

                <div class="wc-tab-panel" ${tabPanelAttrs('review-shell', 'analysis', 'review')}>
                  <div data-testid="engine-lines-mount"></div>
                  <div class="wc-settings-sec-body">
                    ${switchRowHtml('toggle-best-arrow', 'Best-move arrow', this.showBestMoveArrow)}
                    ${switchRowHtml('toggle-threat-arrow', 'Threat arrow', this.showThreatArrow, 'What the opponent threatens (a null-move search)')}
                  </div>
                  <button type="button" class="wc-btn wc-btn-ghost wc-btn-inline wc-self-start" data-testid="btn-clear-arrows" title="Clear the arrows and circles you drew">${icon('close')}Clear my arrows</button>
                  <div class="wc-fen-readout-row">
                    <span class="wc-field-label">FEN</span>
                    <code class="wc-fen-readout" data-testid="analysis-current-fen">${this.adapter.fen()}</code>
                    <button type="button" class="wc-btn wc-btn-ghost wc-btn-icon wc-btn-icon-sm" data-testid="btn-copy-fen" title="Copy FEN" aria-label="Copy FEN">${icon('copy')}</button>
                  </div>
                </div>

                <div class="wc-tab-panel wc-moves-tab" ${tabPanelAttrs('review-shell', 'moves', 'review')}>
                  <div class="wc-moves-panel">
                    <div class="wc-panel-section-title">
                      <span>Moves &amp; variations</span>
                      <div class="wc-variation-actions">
                        <button type="button" class="wc-btn wc-btn-ghost wc-btn-xs" data-testid="btn-promote-variation" title="Promote variation up">↑ Promote</button>
                        <button type="button" class="wc-btn wc-btn-ghost wc-btn-xs" data-testid="btn-promote-mainline" title="Promote variation to main line">⇈ Main line</button>
                        <button type="button" class="wc-btn wc-btn-ghost wc-btn-xs" data-testid="btn-demote-variation" title="Demote variation down">↓ Demote</button>
                        <button type="button" class="wc-btn wc-btn-danger wc-btn-xs" data-testid="btn-delete-variation" title="Delete move / variation">✕ Delete</button>
                      </div>
                    </div>
                    <div class="wc-move-tree" data-testid="analysis-move-tree" role="tree" aria-label="Game moves and variations"></div>
                  </div>
                  <div class="wc-annotation-bar">
                    <div class="wc-nag-row" role="group" aria-label="Move annotation symbols">
                      ${[
                        { code: 1, sym: '!', title: 'Good move (!)' },
                        { code: 2, sym: '?', title: 'Mistake (?)' },
                        { code: 3, sym: '!!', title: 'Brilliant move (!!)' },
                        { code: 4, sym: '??', title: 'Blunder (??)' },
                        { code: 5, sym: '!?', title: 'Interesting move (!?)' },
                        { code: 6, sym: '?!', title: 'Dubious move (?!)' },
                      ]
                        .map(
                          (n) =>
                            `<button type="button" class="wc-btn wc-btn-ghost wc-btn-xs wc-nag-btn" data-nag-code="${n.code}" data-testid="btn-nag-${n.code}" title="${n.title}">${n.sym}</button>`,
                        )
                        .join('')}
                    </div>
                    <input type="text" class="wc-input wc-input-sm" data-testid="input-move-comment" placeholder="Add a comment on this move…" aria-label="Move comment" />
                  </div>
                </div>
              </div>
            </section>
          </div>
        </aside>
      </div>
    `;

    // Load FEN / PGN: a sheet with the game's PGN, kept in step with the board
    this.loadSheet = new Sheet(this.container, { title: 'Load FEN or PGN', testId: 'pgn-sheet' });
    this.loadSheet.body.innerHTML = `
      <div class="wc-pgn-section">
        <p class="wc-panel-note">Paste a FEN to analyze a position, or a PGN (variations, comments, NAGs, [%eval], [%cal], [%csl]) to look at or review a game. The box shows this game's PGN.</p>
        <div class="wc-panel-section-title">
          <span>FEN or PGN</span>
          <span class="wc-pgn-status" data-testid="pgn-status">Ready</span>
        </div>
        <textarea class="wc-textarea wc-input-mono" data-testid="textarea-pgn" rows="14" spellcheck="false" placeholder="Paste a FEN or a PGN…" aria-label="FEN or PGN"></textarea>
        <div class="wc-action-bar">
          <button type="button" class="wc-btn wc-btn-primary wc-btn-lg wc-grow" data-testid="btn-import-pgn">${icon('upload')}Load</button>
          <button type="button" class="wc-btn wc-btn-secondary wc-btn-lg" data-testid="btn-export-pgn" title="Show this game's PGN">This game</button>
          <button type="button" class="wc-btn wc-btn-secondary wc-btn-icon" data-testid="btn-copy-pgn" title="Copy" aria-label="Copy the text">${icon('copy')}</button>
        </div>
      </div>`;

    this.openingEcoEl = this.container.querySelector(
      '[data-testid="opening-eco"]',
    ) as HTMLElement;
    this.openingNameEl = this.container.querySelector(
      '[data-testid="opening-name"]',
    ) as HTMLElement;
    this.statusTextEl = this.container.querySelector(
      '[data-testid="analysis-status-banner"]',
    ) as HTMLElement;
    this.evalPillEl = this.container.querySelector(
      '[data-testid="analysis-eval-pill"]',
    ) as HTMLElement;
    this.threatBadgeEl = this.container.querySelector(
      '[data-testid="threat-move-badge"]',
    ) as HTMLElement;
    this.fenDisplayEl = this.container.querySelector(
      '[data-testid="analysis-current-fen"]',
    ) as HTMLElement;
    this.treeContainerEl = this.container.querySelector(
      '[data-testid="analysis-move-tree"]',
    ) as HTMLElement;
    this.commentInputEl = this.container.querySelector(
      '[data-testid="input-move-comment"]',
    ) as HTMLInputElement;
    this.pgnTextareaEl = this.container.querySelector(
      '[data-testid="textarea-pgn"]',
    ) as HTMLTextAreaElement;
    this.pgnStatusEl = this.container.querySelector(
      '[data-testid="pgn-status"]',
    ) as HTMLElement;
    this.editorMountEl = this.container.querySelector(
      '[data-testid="position-editor-mount"]',
    ) as HTMLElement;
    this.toggleEditorBtnEl = this.container.querySelector(
      '[data-testid="btn-toggle-editor"]',
    ) as HTMLButtonElement;
    this.promoteVarBtnEl = this.container.querySelector(
      '[data-testid="btn-promote-variation"]',
    ) as HTMLButtonElement;
    this.promoteMainBtnEl = this.container.querySelector(
      '[data-testid="btn-promote-mainline"]',
    ) as HTMLButtonElement;
    this.demoteVarBtnEl = this.container.querySelector(
      '[data-testid="btn-demote-variation"]',
    ) as HTMLButtonElement;
    this.deleteVarBtnEl = this.container.querySelector(
      '[data-testid="btn-delete-variation"]',
    ) as HTMLButtonElement;

    const evalBarMount = this.container.querySelector(
      '[data-testid="eval-bar-mount"]',
    ) as HTMLElement;
    const boardMount = this.container.querySelector(
      '[data-testid="analysis-board-mount"]',
    ) as HTMLElement;
    const linesMount = this.container.querySelector(
      '[data-testid="engine-lines-mount"]',
    ) as HTMLElement;

    this.evalBar = new EvalBar(evalBarMount, {
      flipped: false,
      initialScoreWhite: { type: 'cp', value: 0 },
    });

    this.board = new BoardRenderer(boardMount, {
      flipped: false,
      interactiveColor: 'both',
      enablePremoves: false,
      autoQueen: false,
      confirmMove: false,
      captureEffects: this.settings?.get().captureEffects ?? true,
      ...(this.settings
        ? { boardTheme: this.settings.get().boardTheme, pieceSet: this.settings.get().pieceSet }
        : {}),
      onMove: (move, wasDragged) => {
        this.handleBoardMove(move, wasDragged);
      },
      onSelectSquare: () => {
        this.audio.playSelect();
      },
      onSquareEdit: (sq) => {
        if (!this.editorVisible) return false;
        return this.positionEditor.handleBoardSquareClick(sq);
      },
      onAnnotationsChange: (arrows, highlights) => {
        this.handleBoardAnnotationsChange(arrows, highlights);
      },
      onFlipChange: (flipped) => {
        this.evalBar.setFlipped(flipped);
      },
    });

    this.linesPanel = new EngineLinesPanel(linesMount, {
      initialMultiPv: this.multipv,
      initialEnabled: this.engineEnabled,
      onToggleEngine: (enabled) => {
        this.setEngineEnabled(enabled);
      },
      onChangeMultiPv: (mpv) => {
        this.setMultiPv(mpv);
      },
      onHoverLine: (preview) => {
        this.handleHoverEngineLine(preview);
      },
      onSelectLine: (selection) => {
        this.handleSelectEngineLineVariation(selection);
      },
    });

    this.positionEditor = new PositionEditor(this.editorMountEl, {
      initialFen: this.adapter.fen(),
      pieceSet: this.board.getPieceSet(),
      onApplyPosition: (fen) => {
        this.loadFen(fen);
      },
      onPreviewSquaresChange: (squares) => {
        const validation = this.positionEditor.getValidation();
        if (!validation.ok) {
          this.board.setArbitrarySquares(squares);
        }
      },
    });

    this.shellTabs = new Tabs(
      this.container.querySelector('[data-testid="review-tabs-view"]') as HTMLElement,
    );
    this.bindUiEvents();
    if (this.settings) {
      this.unsubscribeSettings = this.settings.subscribe((next, prev) => this.applySettings(next, prev));
    }
  }

  /** Board look and the move animation follow the app settings. */
  private applySettings(next: AppSettings, prev: AppSettings): void {
    if (next.boardTheme !== prev.boardTheme) this.board.setBoardTheme(next.boardTheme);
    if (next.pieceSet !== prev.pieceSet) {
      this.board.setPieceSet(next.pieceSet);
      this.positionEditor.setPieceSet(next.pieceSet);
    }
    if (next.captureEffects !== prev.captureEffects) this.board.setCaptureEffectsEnabled(next.captureEffects);
    if (next.navigationAnimation !== this.navAnimation) this.setNavAnimation(next.navigationAnimation);
  }

  /** Shows one of the side panel's tabs (Review, Analysis, Moves). */
  public showTab(tab: ReviewShellTab): void {
    if (this.editorVisible) this.setEditorVisible(false);
    this.shellTabs.select(tab);
  }

  public getTab(): ReviewShellTab {
    return this.shellTabs.getSelected() as ReviewShellTab;
  }

  /** Loads a FEN (a position to analyze) or a PGN (a game), whichever the text is. */
  public loadText(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed && !trimmed.includes('\n') && validateChessFen(trimmed).ok) {
      if (!this.loadFen(trimmed)) return false;
      this.pgnStatusEl.textContent = 'Position loaded';
      this.pgnStatusEl.setAttribute('data-status', 'ok');
      this.showTab('analysis');
      return true;
    }
    if (!this.importPgn(text)) return false;
    this.showTab('review');
    return true;
  }

  /** Opens the Load sheet showing this game's PGN (empty when there is no game yet). */
  public openLoadSheet(): void {
    this.syncPgnTextarea();
    const empty = this.gameTree.root.children.length === 0 && this.gameTree.root.fen === DEFAULT_POSITION;
    if (empty) this.pgnTextareaEl.value = '';
    this.pgnStatusEl.textContent = 'Ready';
    this.pgnStatusEl.removeAttribute('data-status');
    this.loadSheet.open();
  }

  public closeLoadSheet(): void {
    this.loadSheet.close();
  }

  private copyText(text: string, statusEl: HTMLElement | null): void {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        if (statusEl) {
          statusEl.textContent = 'Copied';
          statusEl.setAttribute('data-status', 'ok');
        }
      })
      .catch(() => {
        if (statusEl) {
          statusEl.textContent = 'Copy blocked: select the text and copy it';
          statusEl.setAttribute('data-status', 'error');
        }
      });
  }

  private bindUiEvents(): void {
    this.container
      .querySelector('[data-testid="btn-nav-start"]')
      ?.addEventListener('click', () => {
        this.goToStart();
      });

    this.container
      .querySelector('[data-testid="btn-nav-prev"]')
      ?.addEventListener('click', () => {
        this.goBack();
      });

    this.container
      .querySelector('[data-testid="btn-nav-next"]')
      ?.addEventListener('click', () => {
        this.goForward();
      });

    this.container
      .querySelector('[data-testid="btn-nav-end"]')
      ?.addEventListener('click', () => {
        this.goToEnd();
      });

    this.container
      .querySelector('[data-testid="btn-flip-board"]')
      ?.addEventListener('click', () => {
        this.flipBoard();
      });

    this.container
      .querySelector('[data-testid="btn-clear-arrows"]')
      ?.addEventListener('click', () => {
        this.board.clearUserAnnotations();
      });

    const bestArrowCheck = this.container.querySelector(
      '[data-testid="toggle-best-arrow"]',
    ) as HTMLInputElement | null;
    bestArrowCheck?.addEventListener('change', () => {
      this.setShowBestMoveArrow(bestArrowCheck.checked);
    });

    const threatArrowCheck = this.container.querySelector(
      '[data-testid="toggle-threat-arrow"]',
    ) as HTMLInputElement | null;
    threatArrowCheck?.addEventListener('change', () => {
      this.setShowThreatArrow(threatArrowCheck.checked);
    });

    this.promoteVarBtnEl.addEventListener('click', () => {
      this.promoteCurrentVariation();
    });

    this.promoteMainBtnEl.addEventListener('click', () => {
      this.promoteCurrentToMainLine();
    });

    this.demoteVarBtnEl.addEventListener('click', () => {
      this.demoteCurrentVariation();
    });

    this.deleteVarBtnEl.addEventListener('click', () => {
      this.deleteCurrentVariation();
    });

    // Track the tree's scroll position and size so navigation never has to read layout
    this.treeContainerEl.addEventListener(
      'scroll',
      () => {
        this.treeScrollTop = this.treeContainerEl.scrollTop;
      },
      { passive: true },
    );
    if (typeof ResizeObserver !== 'undefined') {
      // A width change reflows the moves: re-measure and keep the active move in view
      this.treeResizeObserver = new ResizeObserver(() => {
        this.treeNodeOffsets = null;
        this.keepActiveTreeNodeInView();
      });
      this.treeResizeObserver.observe(this.treeContainerEl);
    }

    this.treeContainerEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const nodeEl = target.closest('[data-node-id]') as HTMLElement | null;
      if (!nodeEl) return;
      const nodeId = nodeEl.getAttribute('data-node-id');
      if (nodeId) {
        this.goToNode(nodeId);
      }
    });

    this.commentInputEl.addEventListener('input', () => {
      const curr = this.gameTree.currentNode;
      this.gameTree.setComment(curr.id, this.commentInputEl.value);
      this.renderMoveTree();
      this.syncPgnTextarea();
    });

    const nagButtons = this.container.querySelectorAll('[data-nag-code]');
    nagButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = Number(btn.getAttribute('data-nag-code'));
        if (!code) return;
        const curr = this.gameTree.currentNode;
        if (curr.ply === 0) return;
        if (curr.nags.includes(code)) {
          this.gameTree.removeNag(curr.id, code);
        } else {
          // Replace primary move assessment NAGs (1..6) if another one is already set
          for (let c = 1; c <= 6; c++) {
            if (c !== code && curr.nags.includes(c)) {
              this.gameTree.removeNag(curr.id, c);
            }
          }
          this.gameTree.addNag(curr.id, code);
        }
        this.syncAnnotationControls();
        this.renderMoveTree();
        this.syncPgnTextarea();
      });
    });

    this.toggleEditorBtnEl.addEventListener('click', () => {
      this.setEditorVisible(!this.editorVisible);
    });
    this.container
      .querySelector('[data-testid="btn-editor-done"]')
      ?.addEventListener('click', () => {
        this.setEditorVisible(false);
      });

    // New board: the starting position, nothing from the last game, the engine lines in view
    this.container
      .querySelector('[data-testid="btn-reset-analysis"]')
      ?.addEventListener('click', () => {
        this.loadFen(DEFAULT_POSITION);
        this.showTab('analysis');
      });

    this.container
      .querySelector('[data-testid="btn-load-pgn"]')
      ?.addEventListener('click', () => {
        this.openLoadSheet();
      });

    this.container
      .querySelector('[data-testid="btn-copy-fen"]')
      ?.addEventListener('click', () => {
        this.copyText(this.adapter.fen(), null);
      });

    this.container
      .querySelector('[data-testid="btn-copy-pgn"]')
      ?.addEventListener('click', () => {
        this.copyText(this.pgnTextareaEl.value, this.pgnStatusEl);
      });

    this.container
      .querySelector('[data-testid="btn-import-pgn"]')
      ?.addEventListener('click', () => {
        if (this.loadText(this.pgnTextareaEl.value)) this.loadSheet.close();
      });

    this.container
      .querySelector('[data-testid="btn-export-pgn"]')
      ?.addEventListener('click', () => {
        this.exportPgn();
      });
  }

  private readonly handleWindowKeyDown = (e: KeyboardEvent): void => {
    if (!this.isActive || !this.container.isConnected) return;
    if (document.documentElement.classList.contains('wc-sheet-open')) return;

    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return;
    }

    if (e.ctrlKey || e.altKey || e.metaKey) return;

    switch (e.key) {
      case 'ArrowLeft': {
        e.preventDefault();
        this.goBack({ repeat: e.repeat });
        break;
      }
      case 'ArrowRight': {
        e.preventDefault();
        this.goForward(0, { repeat: e.repeat });
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        this.switchVariation(-1);
        break;
      }
      case 'ArrowDown': {
        e.preventDefault();
        this.switchVariation(1);
        break;
      }
      case 'Home': {
        e.preventDefault();
        this.goToStart();
        break;
      }
      case 'End': {
        e.preventDefault();
        this.goToEnd();
        break;
      }
      case 'f':
      case 'F': {
        e.preventDefault();
        this.flipBoard();
        break;
      }
      case ' ': {
        e.preventDefault();
        this.setEngineEnabled(!this.engineEnabled);
        break;
      }
    }
  };

  private bindKeyboardShortcuts(): void {
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.handleWindowKeyDown);
    }
  }

  public setActive(active: boolean): void {
    if (this.isActive === active) return;
    this.isActive = active;
    if (!active) {
      this.cancelActiveSearches();
      this.board.setGhostPreview(null);
      return;
    }
    this.startPositionAnalysis();
  }

  public setNavAnimation(mode: NavAnimationMode): void {
    this.navAnimation = mode in NAV_ANIMATION_DURATION_MS ? mode : 'normal';
    if (this.settings && this.settings.get().navigationAnimation !== this.navAnimation) {
      this.settings.set({ navigationAnimation: this.navAnimation });
    }
  }

  public getNavAnimation(): NavAnimationMode {
    return this.navAnimation;
  }

  /**
   * Engine depth for the analysis board. 'infinite' keeps searching until the position
   * changes (used by the perf benchmark to keep the engine busy).
   */
  public setAnalysisDepth(depth: number | 'infinite'): void {
    this.analysisDepth =
      depth === 'infinite' ? Infinity : Math.max(1, Math.floor(depth));
    if (this.engineEnabled && this.isActive) {
      this.startPositionAnalysis();
    }
  }

  /**
   * Animation length for a one-move step. Held keys and steps that arrive while the last
   * animation is still running snap, so navigation never lags behind input; quick
   * repeated presses get a shortened animation.
   */
  private stepAnimationMs(repeat: boolean): number {
    const sinceLast = this.markNavigation();
    const full = NAV_ANIMATION_DURATION_MS[this.navAnimation];
    if (full <= 0 || repeat || sinceLast < full) return 0;
    if (sinceLast < full * 2) return Math.round(full / 2);
    return full;
  }

  /** Jumps (Home/End, distant moves, variation switches) always snap. */
  private jumpAnimationMs(): number {
    this.markNavigation();
    return 0;
  }

  private markNavigation(): number {
    const now = performance.now();
    const sinceLast = now - this.lastNavigationAt;
    this.lastNavigationAt = now;
    this.rapidNavigation = sinceLast < RAPID_NAVIGATION_MS;
    return sinceLast;
  }

  public isCurrentlyActive(): boolean {
    return this.isActive;
  }

  public setEditorVisible(visible: boolean): void {
    this.editorVisible = visible;
    this.syncMoveBadge();
    const shell = this.container.querySelector<HTMLElement>('[data-testid="review-shell"]');
    shell?.setAttribute('data-view', visible ? 'editor' : 'tabs');
    const editorView = this.container.querySelector<HTMLElement>('[data-testid="review-editor-view"]');
    const tabsView = this.container.querySelector<HTMLElement>('[data-testid="review-tabs-view"]');
    if (editorView) editorView.hidden = !visible;
    if (tabsView) tabsView.hidden = visible;
    this.toggleEditorBtnEl.setAttribute('aria-expanded', String(visible));
    this.toggleEditorBtnEl.classList.toggle('wc-btn-primary', visible);
    if (!visible) {
      this.positionEditor.setTool('pointer');
      this.board.setPosition(this.adapter, {
        lastMove: this.getLastMoveCoords(this.gameTree.currentNode),
        animate: false,
        triggerCaptureParticles: false,
        preserveAnalysisArrows: true,
      });
    } else {
      this.positionEditor.setFen(this.adapter.fen(), false);
    }
  }

  public isEditorVisible(): boolean {
    return this.editorVisible;
  }

  public flipBoard(): void {
    const next = !this.board.isFlipped();
    this.board.setFlipped(next);
    this.evalBar.setFlipped(next);
  }

  /** Shows the board (and eval bar) from `color`'s side. */
  public setOrientation(color: 'w' | 'b'): void {
    const flipped = color === 'b';
    if (this.board.isFlipped() === flipped) return;
    this.board.setFlipped(flipped);
    this.evalBar.setFlipped(flipped);
  }

  public setEngineEnabled(enabled: boolean): void {
    this.engineEnabled = enabled;
    this.linesPanel.setEnabled(enabled);
    if (!enabled) {
      this.cancelActiveSearches();
      this.board.setBestMoveArrow(null);
      this.board.setThreatMoveArrow(null);
      this.board.setGhostPreview(null);
      this.threatBadgeEl.textContent = 'Threat: Off';
      return;
    }
    this.startPositionAnalysis();
  }

  public isEngineEnabled(): boolean {
    return this.engineEnabled;
  }

  public setMultiPv(multipv: number): void {
    const clamped = Math.max(1, Math.min(5, Math.floor(multipv)));
    if (this.multipv === clamped) return;
    this.multipv = clamped;
    this.linesPanel.setMultiPv(clamped);
    if (this.engineEnabled) {
      this.startPositionAnalysis();
    }
  }

  public getMultiPv(): number {
    return this.multipv;
  }

  public setShowBestMoveArrow(show: boolean): void {
    this.showBestMoveArrow = show;
    const checkbox = this.container.querySelector(
      '[data-testid="toggle-best-arrow"]',
    ) as HTMLInputElement | null;
    if (checkbox && checkbox.checked !== show) {
      checkbox.checked = show;
    }
    this.syncAnalysisArrows();
  }

  public setShowThreatArrow(show: boolean): void {
    this.showThreatArrow = show;
    const checkbox = this.container.querySelector(
      '[data-testid="toggle-threat-arrow"]',
    ) as HTMLInputElement | null;
    if (checkbox && checkbox.checked !== show) {
      checkbox.checked = show;
    }
    if (show && !this.latestThreat && this.engineEnabled) {
      void this.runThreatSearchForCurrentNode(
        this.analysisGeneration,
        this.adapter.fen(),
      );
    } else {
      this.syncAnalysisArrows();
    }
  }

  /**
   * The current move's review classification as an icon on the corner of its destination
   * square (none before a review, on unreviewed moves, and while the editor is open).
   */
  private syncMoveBadge(): void {
    const node = this.gameTree.currentNode;
    const cls = node.classification;
    this.board.setSquareBadge(
      cls && node.to && !this.editorVisible
        ? { square: node.to, html: classBadgeHtml(cls, 'wc-board-badge-icon'), label: cls }
        : null,
    );
  }

  private getLastMoveCoords(
    node: GameNode,
  ): { from: Square; to: Square } | null {
    if (node.from && node.to) {
      return { from: node.from, to: node.to };
    }
    return null;
  }

  private handleBoardMove(moveInput: MoveInput, wasDragged: boolean): void {
    const parent = this.gameTree.currentNode;
    const childIdsBefore = new Set(parent.children.map((c) => c.id));
    let executed: ExecutedMove;
    try {
      const probe = this.adapter.clone();
      executed = probe.move(moveInput);
    } catch {
      this.board.setPosition(this.adapter, {
        lastMove: this.getLastMoveCoords(this.gameTree.currentNode),
        animate: false,
        triggerCaptureParticles: false,
      });
      return;
    }

    const added = this.gameTree.addMove(executed.uci);
    this.syncAllFromCurrentNode({
      wasDragged,
      animationMs: this.stepAnimationMs(false),
      treeChanged: true,
    });
    this.moveInterceptor?.(added, !childIdsBefore.has(added.id));
  }

  private handleBoardAnnotationsChange(
    arrows: PgnArrowAnnotation[],
    highlights: PgnHighlightAnnotation[],
  ): void {
    const curr = this.gameTree.currentNode;
    this.gameTree.setArrows(curr.id, arrows);
    this.gameTree.setHighlights(curr.id, highlights);
    this.syncPgnTextarea();
  }

  public handleHoverEngineLine(preview: GhostLinePreviewPayload | null): void {
    if (!preview || preview.moves.length === 0) {
      this.board.setGhostPreview(null);
      return;
    }
    this.board.setGhostPreview({
      targetFen: preview.targetFen,
      moves: preview.moves.map((m) => ({ from: m.from, to: m.to })),
    });
  }

  public handleSelectEngineLineVariation(
    selection: SelectLineVariationPayload,
  ): void {
    if (selection.moves.length === 0) return;

    const anchorNodeId = this.gameTree.currentNodeId;
    let currId = anchorNodeId;
    for (const move of selection.moves) {
      try {
        const added = this.gameTree.addMove(move.uci, {
          fromNodeId: currId,
        });
        currId = added.id;
      } catch {
        break;
      }
    }

    this.syncAllFromCurrentNode({
      animationMs: this.jumpAnimationMs(),
      treeChanged: true,
    });
  }

  /**
   * Moves to `nodeId`. A neighbouring move (the parent or a child) animates like a step;
   * anything further away is a jump and snaps.
   */
  public goToNode(nodeId: string): GameNode {
    const curr = this.gameTree.currentNode;
    const target = this.gameTree.getNode(nodeId);
    const adjacent =
      target !== undefined &&
      (target.parentId === curr.id || curr.parentId === target.id);
    const node = this.gameTree.goToNode(nodeId);
    this.syncAllFromCurrentNode({
      animationMs: adjacent ? this.stepAnimationMs(false) : this.jumpAnimationMs(),
    });
    return node;
  }

  public goToStart(): GameNode {
    const node = this.gameTree.goToStart();
    this.syncAllFromCurrentNode({ animationMs: this.jumpAnimationMs() });
    return node;
  }

  public goToEnd(): GameNode {
    const node = this.gameTree.goToEnd();
    this.syncAllFromCurrentNode({ animationMs: this.jumpAnimationMs() });
    return node;
  }

  /** Steps back one move, playing it in reverse. */
  public goBack(options?: { repeat?: boolean }): GameNode | null {
    const node = this.gameTree.goBack();
    if (node) {
      this.syncAllFromCurrentNode({
        animationMs: this.stepAnimationMs(Boolean(options?.repeat)),
      });
    }
    return node;
  }

  public goForward(
    variationIndex = 0,
    options?: { repeat?: boolean },
  ): GameNode | null {
    const node = this.gameTree.goForward(variationIndex);
    if (node) {
      this.syncAllFromCurrentNode({
        animationMs: this.stepAnimationMs(Boolean(options?.repeat)),
      });
    }
    return node;
  }

  /**
   * Switches between sibling variations (Up = -1, Down = +1).
   * - If the current node's parent has multiple children, switches among those siblings.
   * - Otherwise walks up to the nearest variation branch point with sibling variations.
   * - Otherwise if the current node itself has multiple children, steps into the first/next variation child.
   */
  public switchVariation(direction: -1 | 1): GameNode | null {
    const curr = this.gameTree.currentNode;

    // 1. Walk from curr upward to find the nearest ancestor whose parent has >1 child
    let cursor: GameNode | undefined = curr;
    while (cursor && cursor.parentId) {
      const parent = this.gameTree.getNode(cursor.parentId);
      if (parent && parent.children.length > 1) {
        const idx = parent.children.indexOf(cursor);
        const nextIdx =
          (idx + direction + parent.children.length) % parent.children.length;
        const targetSibling = parent.children[nextIdx];
        if (targetSibling && targetSibling.id !== cursor.id) {
          return this.goToNode(targetSibling.id);
        }
        break;
      }
      cursor = parent;
    }

    // 2. If curr itself has multiple children (e.g. sitting at root before a branched move)
    if (curr.children.length > 1) {
      const targetIdx = direction > 0 ? 1 : curr.children.length - 1;
      const targetChild = curr.children[targetIdx];
      if (targetChild) {
        return this.goToNode(targetChild.id);
      }
    }

    return null;
  }

  public promoteCurrentVariation(): boolean {
    const ok = this.gameTree.promoteVariation(this.gameTree.currentNodeId);
    if (ok) {
      this.renderMoveTree();
      this.syncVariationButtonsState();
      this.syncPgnTextarea();
    }
    return ok;
  }

  public promoteCurrentToMainLine(): boolean {
    const ok = this.gameTree.promoteToMainLine(this.gameTree.currentNodeId);
    if (ok) {
      this.renderMoveTree();
      this.syncVariationButtonsState();
      this.syncPgnTextarea();
    }
    return ok;
  }

  public demoteCurrentVariation(): boolean {
    const ok = this.gameTree.demoteVariation(this.gameTree.currentNodeId);
    if (ok) {
      this.renderMoveTree();
      this.syncVariationButtonsState();
      this.syncPgnTextarea();
    }
    return ok;
  }

  public deleteCurrentVariation(): boolean {
    const ok = this.gameTree.deleteVariation(this.gameTree.currentNodeId);
    if (ok) {
      this.syncAllFromCurrentNode({ treeChanged: true });
    }
    return ok;
  }

  public loadFen(fen: string): boolean {
    const validation = validateChessFen(fen.trim());
    if (!validation.ok) {
      return false;
    }
    this.gameTree = new GameTree(fen.trim(), {
      chess960: validation.isChess960,
    });
    this.notifyTreeReplaced();
    this.positionEditor.setTool('pointer');
    this.syncAllFromCurrentNode({ treeChanged: true });
    return true;
  }

  public loadGameTree(tree: GameTree): void {
    this.gameTree = GameTree.fromJSON(tree.toJSON());
    this.notifyTreeReplaced();
    this.syncAllFromCurrentNode({ treeChanged: true });
  }

  public importPgn(pgnText: string): boolean {
    try {
      const parsed = parsePgn(pgnText);
      this.gameTree = parsed;
      this.notifyTreeReplaced();
      this.pgnStatusEl.textContent = 'PGN Loaded';
      this.pgnStatusEl.setAttribute('data-status', 'ok');
      this.syncAllFromCurrentNode({ treeChanged: true });
      return true;
    } catch (err) {
      this.pgnStatusEl.textContent =
        err instanceof Error ? err.message : 'Invalid PGN';
      this.pgnStatusEl.setAttribute('data-status', 'error');
      return false;
    }
  }

  /**
   * Loads a PGN shown from its first position, in two tasks: parsing, then showing it (one
   * render). importPgn does both in one task and shows the last position, which a caller
   * going to the start then renders again; on a busy machine that one task passed 50 ms.
   */
  public async importPgnFromStart(pgnText: string): Promise<boolean> {
    let parsed: GameTree;
    try {
      parsed = parsePgn(pgnText);
    } catch (err) {
      this.pgnStatusEl.textContent = err instanceof Error ? err.message : 'Invalid PGN';
      this.pgnStatusEl.setAttribute('data-status', 'error');
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    parsed.goToStart();
    this.gameTree = parsed;
    this.notifyTreeReplaced();
    this.pgnStatusEl.textContent = 'PGN Loaded';
    this.pgnStatusEl.setAttribute('data-status', 'ok');
    this.syncAllFromCurrentNode({ treeChanged: true });
    return true;
  }

  public exportPgn(): string {
    const pgn = writePgn(this.gameTree);
    this.pgnTextareaEl.value = pgn;
    this.pgnStatusEl.textContent = 'PGN Exported';
    this.pgnStatusEl.setAttribute('data-status', 'ok');
    return pgn;
  }

  private syncPgnTextarea(): void {
    if (this.pgnSyncTimer !== null) {
      clearTimeout(this.pgnSyncTimer);
      this.pgnSyncTimer = null;
    }
    this.pgnTextareaEl.value = writePgn(this.gameTree);
  }

  /**
   * Refreshes the PGN text once navigation pauses (the engine writes [%eval] onto the
   * nodes it visits). Never overwrites the textarea while the user is typing in it.
   */
  private schedulePgnTextareaSync(): void {
    if (this.pgnSyncTimer !== null) {
      clearTimeout(this.pgnSyncTimer);
    }
    this.pgnSyncTimer = setTimeout(() => {
      this.pgnSyncTimer = null;
      if (document.activeElement !== this.pgnTextareaEl) {
        this.syncPgnTextarea();
      }
    }, PGN_SYNC_DELAY_MS);
  }

  /**
   * Brings every panel in line with the current node.
   * - `animationMs`: duration of the board animation (0 snaps). Stepping backward plays
   *   the move in reverse; the board works that out from the position diff.
   * - `treeChanged`: the move tree's structure changed and must be re-rendered. Plain
   *   navigation only moves the active-node highlight, so nothing in the list reflows.
   */
  private syncAllFromCurrentNode(opts: {
    wasDragged?: boolean;
    animationMs?: number;
    treeChanged?: boolean;
  }): void {
    const node = this.gameTree.currentNode;
    this.adapter = new RulesAdapter(node.fen, {
      chess960: this.gameTree.isChess960(),
    });

    const animationMs = opts.animationMs ?? 0;
    const lastMove = this.getLastMoveCoords(node);
    this.board.setPosition(this.adapter, {
      lastMove,
      wasDragged: Boolean(opts.wasDragged),
      animate: animationMs > 0,
      animationDurationMs: animationMs,
      triggerCaptureParticles: false,
      preserveAnalysisArrows: false,
    });

    // Restore node's [%cal] and [%csl] user annotations onto the board
    this.board.setUserAnnotations(node.arrows, node.highlights);
    this.syncMoveBadge();

    // The (hidden) editor is re-synced when it opens; skip the work while navigating
    if (this.editorVisible) {
      this.positionEditor.setFen(node.fen, false);
    }
    this.fenDisplayEl.textContent = node.fen;

    // Sync Opening Lookup
    const opening =
      lookupOpeningByFen(node.fen) ??
      lookupGameOpening(this.gameTree, node.id);
    if (opening) {
      this.openingEcoEl.textContent = opening.eco;
      this.openingNameEl.textContent = opening.name;
    } else {
      this.openingEcoEl.textContent = 'A00';
      this.openingNameEl.textContent =
        node.ply === 0 ? 'Starting Position' : formatOpeningBadge(null);
    }

    // Sync status banner
    const status = this.positionStatus();
    if (status.checkmate) {
      const winner = this.adapter.turn() === 'w' ? 'Black' : 'White';
      this.statusTextEl.textContent = `Checkmate — ${winner} wins`;
    } else if (status.draw) {
      this.statusTextEl.textContent = 'Draw position';
    } else {
      const side = this.adapter.turn() === 'w' ? 'White' : 'Black';
      this.statusTextEl.textContent = `${side} to move${
        status.inCheck ? ' — Check!' : ''
      }`;
    }

    // Seed eval bar from node.eval if present before live Stockfish results arrive
    if (node.eval) {
      const initialScore = pgnEvalToUciScore(node.eval);
      this.latestScoreWhite = initialScore;
      this.evalBar.setScoreWhite(initialScore);
      this.evalPillEl.textContent = formatEvalBarScore(initialScore);
    } else if (node.ply === 0) {
      this.latestScoreWhite = { type: 'cp', value: 0 };
      this.evalBar.setScoreWhite(this.latestScoreWhite);
      this.evalPillEl.textContent = '+0.00';
    }

    this.syncAnnotationControls();
    this.syncVariationButtonsState();
    if (opts.treeChanged) {
      this.renderMoveTree();
      this.syncPgnTextarea();
    } else {
      this.updateActiveTreeNode();
      this.schedulePgnTextareaSync();
    }

    // While the user is flicking through moves, restart the engine once they pause
    if (this.rapidNavigation && !opts.treeChanged) {
      this.cancelActiveSearches();
      this.linesPanel.clear(node.fen);
      this.analysisStartTimer = setTimeout(() => {
        this.analysisStartTimer = null;
        this.startPositionAnalysis();
      }, ANALYSIS_RESTART_DELAY_MS);
    } else {
      this.startPositionAnalysis();
    }

    for (const listener of this.navigateListeners) listener(node);
  }

  /**
   * Checkmate / draw / check for the current adapter, computed once per position: legal
   * move generation is the most expensive part of a navigation step.
   */
  private positionStatus(): { checkmate: boolean; draw: boolean; inCheck: boolean } {
    if (this.statusCache?.adapter !== this.adapter) {
      const checkmate = this.adapter.isCheckmate();
      this.statusCache = {
        adapter: this.adapter,
        checkmate,
        draw: !checkmate && this.adapter.isDraw(),
        inCheck: this.adapter.inCheck(),
      };
    }
    return this.statusCache;
  }

  /** Moves the active highlight in the move tree and scrolls only the tree to show it. */
  private updateActiveTreeNode(): void {
    const activeId = this.gameTree.currentNodeId;
    if (this.activeTreeNodeId !== activeId) {
      if (this.activeTreeNodeId) {
        this.treeNodeEls
          .get(this.activeTreeNodeId)
          ?.classList.remove('wc-tree-node-active');
      }
      this.treeNodeEls.get(activeId)?.classList.add('wc-tree-node-active');
      this.activeTreeNodeId = activeId;
    }
    this.keepActiveTreeNodeInView();
  }

  /**
   * Adjusts the tree container's own scrollTop. Never uses scrollIntoView, which also
   * scrolls every scrollable ancestor, including the page.
   */
  private keepActiveTreeNodeInView(): void {
    const container = this.treeContainerEl;
    if (!container.isConnected) return;
    if (!this.treeNodeOffsets) {
      // One layout read per render or resize; navigation then works from the cache
      this.treeNodeOffsets = new Map();
      for (const [id, el] of this.treeNodeEls) {
        this.treeNodeOffsets.set(id, {
          top: el.offsetTop,
          bottom: el.offsetTop + el.offsetHeight,
        });
      }
      this.treeViewportHeight = container.clientHeight;
      this.treeScrollTop = container.scrollTop;
    }

    const offsets = this.activeTreeNodeId
      ? this.treeNodeOffsets.get(this.activeTreeNodeId)
      : undefined;
    const margin = 6;
    let next = this.treeScrollTop;
    if (!offsets) {
      next = 0;
    } else if (offsets.top - margin < this.treeScrollTop) {
      next = Math.max(0, offsets.top - margin);
    } else if (offsets.bottom + margin > this.treeScrollTop + this.treeViewportHeight) {
      next = offsets.bottom + margin - this.treeViewportHeight;
    }
    if (next !== this.treeScrollTop) {
      this.treeScrollTop = next;
      container.scrollTop = next;
    }
  }

  private syncAnnotationControls(): void {
    const curr = this.gameTree.currentNode;
    if (this.commentInputEl.value !== curr.comment) {
      this.commentInputEl.value = curr.comment;
    }

    if (this.nagButtonEls.length === 0) {
      this.nagButtonEls = Array.from(
        this.container.querySelectorAll<HTMLButtonElement>('[data-nag-code]'),
      );
    }
    for (const btn of this.nagButtonEls) {
      const code = Number(btn.getAttribute('data-nag-code'));
      const active = curr.nags.includes(code);
      btn.classList.toggle('wc-btn-primary', active);
      btn.setAttribute('aria-pressed', String(active));
      btn.disabled = curr.ply === 0;
    }
  }

  private syncVariationButtonsState(): void {
    const curr = this.gameTree.currentNode;
    const isRoot = curr.parentId === null;
    this.promoteVarBtnEl.disabled = isRoot;
    this.promoteMainBtnEl.disabled = isRoot;
    this.demoteVarBtnEl.disabled = isRoot;
    this.deleteVarBtnEl.disabled = isRoot;
  }

  private renderMoveTree(): void {
    const root = this.gameTree.root;
    if (root.children.length === 0 && !root.comment) {
      this.treeContainerEl.innerHTML = `<div class="wc-move-empty">Play moves on the board, click an engine line, or load a PGN to build variations.</div>`;
      this.treeNodeEls.clear();
      this.treeNodeOffsets = null;
      this.activeTreeNodeId = null;
      return;
    }

    const activeId = this.gameTree.currentNodeId;
    const htmlParts: string[] = [];

    if (root.comment) {
      htmlParts.push(
        `<span class="wc-tree-comment" data-testid="tree-root-comment">{ ${this.escapeHtml(root.comment)} }</span> `,
      );
    }

    const renderNodeMoveToken = (
      node: GameNode,
      forceMoveNumber: boolean,
    ): string => {
      const isWhite = node.moveColor === 'w';
      const prefix = isWhite
        ? `${node.moveNumber}.`
        : forceMoveNumber
          ? `${node.moveNumber}...`
          : '';
      const nagsText = node.nags.map((n) => nagToGlyph(n)).join('');
      const evalTag = node.eval
        ? `<span class="wc-tree-eval-tag">${formatEvalBarScore(pgnEvalToUciScore(node.eval))}</span>`
        : '';
      const activeClass = node.id === activeId ? 'wc-tree-node-active' : '';
      const preCommentHtml = node.preComment
        ? `<span class="wc-tree-comment">{ ${this.escapeHtml(node.preComment)} }</span> `
        : '';
      const postCommentHtml = node.comment
        ? ` <span class="wc-tree-comment">{ ${this.escapeHtml(node.comment)} }</span>`
        : '';

      return `${preCommentHtml}<button type="button" class="wc-tree-node ${activeClass}" data-node-id="${node.id}" data-node-san="${this.escapeHtml(node.san)}" data-testid="tree-node-${node.id}">${
        prefix ? `<span class="wc-tree-num">${prefix}</span>` : ''
      }<span class="wc-tree-san">${this.escapeHtml(node.san)}${this.escapeHtml(nagsText)}</span>${
        node.classification ? classBadgeHtml(node.classification, 'wc-tree-class') : ''
      }${evalTag}</button>${postCommentHtml}`;
    };

    const renderBranch = (
      startNode: GameNode,
      forceFirstMoveNum: boolean,
    ): string => {
      const segments: string[] = [];
      let curr: GameNode | undefined = startNode;
      let forceNum = forceFirstMoveNum;

      while (curr) {
        const parent = curr.parentId
          ? this.gameTree.getNode(curr.parentId)
          : undefined;
        const siblings =
          parent && parent.children[0]?.id === curr.id
            ? parent.children.slice(1)
            : [];

        segments.push(renderNodeMoveToken(curr, forceNum));
        forceNum = false;

        if (siblings.length > 0) {
          for (const sib of siblings) {
            segments.push(
              `<span class="wc-tree-variation" data-testid="tree-variation-${sib.id}">( ${renderBranch(sib, true)} )</span>`,
            );
          }
          forceNum = true;
        }

        curr = curr.children[0];
      }

      return segments.join(' ');
    };

    const firstMain = root.children[0];
    if (firstMain) {
      htmlParts.push(renderBranch(firstMain, true));
    }

    this.treeContainerEl.innerHTML = htmlParts.join(' ');

    this.treeNodeEls.clear();
    this.treeContainerEl
      .querySelectorAll<HTMLElement>('[data-node-id]')
      .forEach((el) => {
        const id = el.getAttribute('data-node-id');
        if (id) this.treeNodeEls.set(id, el);
      });
    this.activeTreeNodeId = activeId;
    this.treeNodeOffsets = null;
    this.keepActiveTreeNodeInView();
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private cancelActiveSearches(): void {
    this.analysisGeneration++;
    if (this.analysisStartTimer !== null) {
      clearTimeout(this.analysisStartTimer);
      this.analysisStartTimer = null;
    }
    if (this.analysisAbortController) {
      this.analysisAbortController.abort();
      this.analysisAbortController = null;
    }
    if (this.threatAbortController) {
      this.threatAbortController.abort();
      this.threatAbortController = null;
    }
    if (this.pendingRafId !== null) {
      cancelAnimationFrame(this.pendingRafId);
      this.pendingRafId = null;
    }
  }

  private startPositionAnalysis(): void {
    this.cancelActiveSearches();

    const gen = this.analysisGeneration;
    const node = this.gameTree.currentNode;
    const fen = node.fen;
    const chess960 = this.gameTree.isChess960();

    this.latestLines = [];
    this.latestThreat = null;

    if (!this.engineEnabled) {
      this.linesPanel.setEnabled(false);
      return;
    }

    const status = this.positionStatus();
    if (status.checkmate || status.draw) {
      if (status.checkmate) {
        const whiteMated = this.adapter.turn() === 'w';
        const mateScore: UciScore = {
          type: 'mate',
          value: whiteMated ? -1 : 1,
        };
        this.latestScoreWhite = mateScore;
        this.evalBar.setScoreWhite(mateScore);
        this.evalPillEl.textContent = formatEvalBarScore(mateScore);
      } else {
        const drawScore: UciScore = { type: 'cp', value: 0 };
        this.latestScoreWhite = drawScore;
        this.evalBar.setScoreWhite(drawScore);
        this.evalPillEl.textContent = '0.00';
      }
      this.linesPanel.clear(fen);
      this.threatBadgeEl.textContent = 'Threat: —';
      return;
    }

    if (!this.isActive) {
      this.linesPanel.clear(fen);
      return;
    }

    this.linesPanel.clear(fen);

    const sharedWorker = this.threatEngine === this.engine;
    if (!sharedWorker && this.showThreatArrow) {
      void this.runThreatSearchForCurrentNode(gen, fen);
    }

    const ac = new AbortController();
    this.analysisAbortController = ac;

    void this.engine
      .analyze({
        fen,
        ...(Number.isFinite(this.analysisDepth)
          ? { depth: this.analysisDepth }
          : { infinite: true }),
        multipv: this.multipv,
        chess960,
        priority: 'live',
        preempt: true,
        signal: ac.signal,
        onInfo: (snapshot: EngineAnalysisResult) => {
          if (gen !== this.analysisGeneration || ac.signal.aborted) return;
          this.latestLines = snapshot.lines;
          this.latestDepth = snapshot.depth;
          this.latestNps = snapshot.nps;
          this.scheduleUiUpdateFromEngine(node.id, fen, chess960);
        },
      })
      .then((finalResult: EngineAnalysisResult) => {
        if (gen !== this.analysisGeneration || ac.signal.aborted) return;
        this.latestLines = finalResult.lines;
        this.latestDepth = finalResult.depth;
        this.latestNps = finalResult.nps;
        // Same per-frame batch as streaming updates: at most one DOM update per frame
        this.scheduleUiUpdateFromEngine(node.id, fen, chess960);

        if (sharedWorker && this.showThreatArrow) {
          void this.runThreatSearchForCurrentNode(gen, fen);
        }
      })
      .catch((err: unknown) => {
        if (err instanceof EngineCancelledError) return;
      });
  }

  private async runThreatSearchForCurrentNode(
    gen: number,
    fen: string,
  ): Promise<void> {
    if (this.threatAbortController) {
      this.threatAbortController.abort();
    }
    const threatAc = new AbortController();
    this.threatAbortController = threatAc;
    this.threatBadgeEl.textContent = 'Threat: ...';

    const threat = await detectOpponentThreat(this.threatEngine, fen, {
      depth: this.threatSearchDepth,
      chess960: this.gameTree.isChess960(),
      signal: threatAc.signal,
    });

    if (gen !== this.analysisGeneration || threatAc.signal.aborted) {
      return;
    }

    this.latestThreat = threat;
    if (threat) {
      this.threatBadgeEl.textContent = `Threat: ${threat.san}`;
    } else {
      this.threatBadgeEl.textContent = 'Threat: None';
    }
    this.syncAnalysisArrows();
  }

  private scheduleUiUpdateFromEngine(
    nodeId: string,
    fen: string,
    chess960: boolean,
  ): void {
    if (this.pendingRafId !== null) return;
    this.pendingRafId = requestAnimationFrame(() => {
      this.pendingRafId = null;
      this.applyEngineSnapshotImmediate(nodeId, fen, chess960);
    });
  }

  private applyEngineSnapshotImmediate(
    nodeId: string,
    fen: string,
    chess960: boolean,
  ): void {
    if (this.gameTree.currentNodeId !== nodeId) return;

    const topLine = this.latestLines[0];
    if (topLine) {
      this.latestScoreWhite = topLine.scoreWhite;
      this.evalBar.setScoreWhite(topLine.scoreWhite);
      const formatted = formatEvalBarScore(topLine.scoreWhite);
      if (this.evalPillEl.textContent !== formatted) {
        this.evalPillEl.textContent = formatted;
      }

      // Store evaluation on current move node so PGN export includes [%eval]
      if (nodeId !== this.gameTree.root.id) {
        if (topLine.scoreWhite.type === 'mate') {
          this.gameTree.setEval(nodeId, {
            mate: topLine.scoreWhite.value,
            depth: topLine.depth,
          });
        } else {
          this.gameTree.setEval(nodeId, {
            cp: topLine.scoreWhite.value,
            depth: topLine.depth,
          });
        }
      }
    }

    this.linesPanel.updateLines(fen, this.latestLines, {
      depth: this.latestDepth,
      nps: this.latestNps,
      chess960,
    });

    this.syncAnalysisArrows();
  }

  private syncAnalysisArrows(): void {
    const topLine = this.latestLines[0];
    const bestUci = topLine?.pv[0];
    if (
      this.engineEnabled &&
      this.showBestMoveArrow &&
      bestUci &&
      bestUci.length >= 4
    ) {
      const from = bestUci.slice(0, 2) as Square;
      const to = bestUci.slice(2, 4) as Square;
      this.board.setBestMoveArrow({ from, to });
    } else {
      this.board.setBestMoveArrow(null);
    }

    if (
      this.engineEnabled &&
      this.showThreatArrow &&
      this.latestThreat
    ) {
      this.board.setThreatMoveArrow({
        from: this.latestThreat.from,
        to: this.latestThreat.to,
      });
    } else {
      this.board.setThreatMoveArrow(null);
    }
  }

  // ---------------------------------------------------------------- review hooks

  public getReviewMount(): HTMLElement {
    return this.container.querySelector('[data-testid="review-panel-mount"]') as HTMLElement;
  }

  /** Called after every position change (navigation, moves, loads). */
  public onNavigate(listener: (node: GameNode) => void): void {
    this.navigateListeners.push(listener);
  }

  /** Called when a different game is loaded (PGN, FEN, a game from Play mode). */
  public onTreeReplaced(listener: () => void): void {
    this.treeReplacedListeners.push(listener);
  }

  private notifyTreeReplaced(): void {
    for (const listener of this.treeReplacedListeners) listener();
  }

  /** Called after each move made on the board, with the node and whether it is new. */
  public setMoveInterceptor(fn: ((node: GameNode, created: boolean) => void) | null): void {
    this.moveInterceptor = fn;
  }

  /**
   * Adds `ucis` as a line from `fromNodeId` (as a variation where needed), without
   * navigating. `forceNewVariation` branches off even if the first move already exists.
   */
  public addLine(
    fromNodeId: string,
    ucis: readonly string[],
    options?: { forceNewVariation?: boolean },
  ): GameNode[] {
    const currentId = this.gameTree.currentNodeId;
    const added: GameNode[] = [];
    let from = fromNodeId;
    for (const uci of ucis) {
      try {
        const node = this.gameTree.addMove(uci, {
          fromNodeId: from,
          forceNewVariation: added.length === 0 && Boolean(options?.forceNewVariation),
        });
        added.push(node);
        from = node.id;
      } catch {
        break;
      }
    }
    this.gameTree.goToNode(currentId);
    this.renderMoveTree();
    this.syncPgnTextarea();
    return added;
  }

  /** Deletes a node (and what follows it); the current position must not be inside it. */
  public deleteNode(nodeId: string): void {
    if (this.gameTree.deleteNode(nodeId)) {
      this.renderMoveTree();
      this.syncVariationButtonsState();
      this.syncPgnTextarea();
    }
  }

  /**
   * Writes review classifications onto the tree, and evals where a node has none (or a
   * shallower one). `rerender` rebuilds the move list once (end of a review); otherwise
   * only the affected badges are patched in.
   */
  public applyReview(entries: readonly ReviewTreeEntry[], rerender: boolean): void {
    for (const entry of entries) {
      const node = this.gameTree.getNode(entry.nodeId);
      if (!node) continue;
      this.gameTree.setClassification(node.id, entry.classification);
      if (entry.eval && (!node.eval || (node.eval.depth ?? 0) < (entry.eval.depth ?? 0))) {
        this.gameTree.setEval(node.id, entry.eval);
      }
      if (!rerender) {
        const el = this.treeNodeEls.get(node.id);
        if (el) {
          el.querySelector('.wc-tree-class')?.remove();
          el.querySelector('.wc-tree-san')?.insertAdjacentHTML(
            'afterend',
            classBadgeHtml(entry.classification, 'wc-tree-class'),
          );
          this.treeNodeOffsets = null;
        }
      }
    }
    if (rerender) {
      this.renderMoveTree();
      this.schedulePgnTextareaSync();
    }
    this.syncMoveBadge();
  }

  /**
   * Removes earlier engine annotations (evals, move-quality NAGs, engine comments and
   * their variations) from the main line before a review; returns how many went.
   */
  public stripEngineAnnotations(): number {
    const currentBefore = this.gameTree.currentNodeId;
    const r = stripEngineAnnotations(this.gameTree);
    const total = r.evals + r.nags + r.comments + r.variations;
    if (total > 0) {
      if (this.gameTree.currentNodeId !== currentBefore) {
        this.syncAllFromCurrentNode({ treeChanged: true });
      } else {
        this.renderMoveTree();
        this.syncAnnotationControls();
        this.syncPgnTextarea();
      }
    }
    this.syncMoveBadge();
    return total;
  }

  /** Shows PGN text in the PGN box with a status note. */
  public showPgnText(pgn: string, status: string): void {
    // A pending refresh (scheduled by the review's last update) would replace this text
    if (this.pgnSyncTimer !== null) {
      clearTimeout(this.pgnSyncTimer);
      this.pgnSyncTimer = null;
    }
    this.pgnTextareaEl.value = pgn;
    this.pgnStatusEl.textContent = status;
    this.pgnStatusEl.setAttribute('data-status', 'ok');
    this.loadSheet.open();
  }

  public getBoard(): BoardRenderer {
    return this.board;
  }

  public getEvalBar(): EvalBar {
    return this.evalBar;
  }

  public getLinesPanel(): EngineLinesPanel {
    return this.linesPanel;
  }

  public getPositionEditor(): PositionEditor {
    return this.positionEditor;
  }

  public getGameTree(): GameTree {
    return this.gameTree;
  }

  public getAdapter(): RulesAdapter {
    return this.adapter;
  }

  public getLatestThreat(): ThreatDetectionResult | null {
    return this.latestThreat;
  }

  public getLatestLines(): EngineLine[] {
    return [...this.latestLines];
  }

  public destroy(): void {
    this.cancelActiveSearches();
    this.unsubscribeSettings?.();
    this.loadSheet.close();
    if (this.pgnSyncTimer !== null) {
      clearTimeout(this.pgnSyncTimer);
      this.pgnSyncTimer = null;
    }
    this.linesPanel.destroy();
    this.treeResizeObserver?.disconnect();
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.handleWindowKeyDown);
    }
    this.board.destroy();
  }
}
