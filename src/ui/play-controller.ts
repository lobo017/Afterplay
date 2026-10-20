import { GameTree, type GameTermination } from '../core/game-tree';
import { writePgn } from '../core/pgn';
import {
  DEFAULT_POSITION,
  RulesAdapter,
  type Color,
  type ExecutedMove,
  type MoveInput,
  type PieceSymbol,
  type Square,
} from '../core/rules';
import {
  BOT_STYLE_PRESETS,
  BOT_TIERS,
  ChessBot,
  clampBotRating,
  computeBotThinkTimeMs,
  getTierForRating,
  type BotStyleId,
} from '../engine/bot';
import {
  EngineCancelledError,
  EngineClient,
  type EngineAnalysisResult,
} from '../engine/engine-client';
import { BotSelectionClient } from '../engine/bot-selection-client';
import { formatScore, type UciScore } from '../engine/uci-parser';
import { CathedralAudio } from '../render/audio';
import { BoardRenderer } from '../render/board-renderer';
import { getPieceSvgMarkup } from '../render/piece-sets';
import {
  ChessClock,
  TIME_CONTROL_PRESETS,
  type ClockSnapshot,
  type TimeControlPresetId,
} from './clock';
import type { DevOverlayController } from './dev-overlay';
import {
  AppSettingsStore,
  MAX_PREMOVES_LIMIT,
  type AppSettings,
  type NewGameOptions,
} from './app-settings';
import { icon } from './components/icons';
import { Menu } from './components/menu';
import { Tabs, tabListHtml, tabPanelAttrs } from './components/tabs';
import {
  bindChoiceGroups,
  chipsHtml,
  segmentedHtml,
  setChoice,
  switchRowHtml,
} from './components/controls';

export interface HintUsageRecord {
  ply: number;
  moveNumber: number;
  color: Color;
  fen: string;
  suggestedUci: string;
  suggestedSan: string;
  evalCp: number;
  timestamp: string;
}

export interface CapturedAndMaterialSummary {
  /** Black pieces captured by White, sorted high-to-low value. */
  capturedByWhite: PieceSymbol[];
  /** White pieces captured by Black, sorted high-to-low value. */
  capturedByBlack: PieceSymbol[];
  /** Net material advantage in pawns (positive = White ahead, negative = Black ahead). */
  netAdvantageWhite: number;
}

const PIECE_VALUES: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

const PIECE_SORT_ORDER: Record<PieceSymbol, number> = {
  q: 1,
  r: 2,
  b: 3,
  n: 4,
  p: 5,
  k: 6,
};

/**
 * Computes captured piece trays and net material advantage strictly from executed move history
 * (including promotions), preventing Legacy Bug #5 where promoted pawns were miscounted as captured.
 */
export function computeCapturedAndMaterial(
  executedMoves: ExecutedMove[],
): CapturedAndMaterialSummary {
  const capturedByWhite: PieceSymbol[] = [];
  const capturedByBlack: PieceSymbol[] = [];
  let netAdvantageWhite = 0;

  for (const move of executedMoves) {
    if (move.captured) {
      const capVal = PIECE_VALUES[move.captured] ?? 0;
      if (move.color === 'w') {
        capturedByWhite.push(move.captured);
        netAdvantageWhite += capVal;
      } else {
        capturedByBlack.push(move.captured);
        netAdvantageWhite -= capVal;
      }
    }

    if (move.promotion) {
      const promoGain =
        (PIECE_VALUES[move.promotion] ?? 0) - PIECE_VALUES.p;
      if (move.color === 'w') {
        netAdvantageWhite += promoGain;
      } else {
        netAdvantageWhite -= promoGain;
      }
    }
  }

  capturedByWhite.sort((a, b) => PIECE_SORT_ORDER[a] - PIECE_SORT_ORDER[b]);
  capturedByBlack.sort((a, b) => PIECE_SORT_ORDER[a] - PIECE_SORT_ORDER[b]);

  return {
    capturedByWhite,
    capturedByBlack,
    netAdvantageWhite,
  };
}

interface PlySnapshot {
  executedMove: ExecutedMove;
  whiteClockMs: number;
  blackClockMs: number;
  evalText: string;
  evalWhiteCp: number;
}

export interface PlayControllerOptions {
  container: HTMLElement;
  engine: EngineClient;
  /** Separate engine instance for bot moves so the bot never reuses full-strength analysis state. */
  botEngine?: EngineClient;
  /** Worker-backed bot move selection; created (and owned) here when not given. */
  botSelection?: BotSelectionClient;
  devOverlay?: DevOverlayController;
  /** Shared synthesizer, so the app builds only one AudioContext. */
  audio?: CathedralAudio;
  initialBotRating?: number;
  initialBotStyle?: BotStyleId;
  initialTimeControl?: TimeControlPresetId;
  maxHintsPerGame?: number;
  botMoveDelayMs?: number;
  botMinDelayMs?: number;
  botMaxDelayMs?: number;
  maxPremoves?: number;
  /** App settings: board, input, sound and the new-game choices (a private store if absent). */
  settings?: AppSettingsStore;
  /** ⋯ › Analyze this position: open the game in Review. */
  onAnalyzeGame?: () => void;
  /** Game over › Review this game. */
  onReviewGame?: () => void;
}

export const DEFAULT_MAX_PREMOVES = 10;

/**
 * Phase 3 Play Mode Controller.
 * Coordinates the 2D board, clocks, Web Audio synth, capture particles, Stockfish bot,
 * takebacks, draw offers, resign, limited hints, and optional infinite background analysis.
 */
export class PlayController {
  private readonly container: HTMLElement;
  private readonly engine: EngineClient;
  private readonly botEngine: EngineClient;
  private readonly ownsBotEngine: boolean;
  private readonly audio: CathedralAudio;
  private readonly clock: ChessClock;
  private readonly bot: ChessBot;
  private readonly botSelection: BotSelectionClient;
  private readonly ownsBotSelection: boolean;
  private board!: BoardRenderer;
  private readonly settings: AppSettingsStore;
  private readonly unsubscribeSettings: () => void;
  private readonly onAnalyzeGame: (() => void) | undefined;
  private readonly onReviewGame: (() => void) | undefined;
  private menu!: Menu;
  private panelEl!: HTMLElement;
  private flipBtnEl!: HTMLButtonElement;
  /** The side panel: the New game card, or the game. */
  private panelView: 'setup' | 'game' = 'setup';
  /** The New game card was opened from the menu, so moves don't switch the panel away. */
  private setupOpenedByUser = false;
  /** Where the game waiting for "End it and play" starts (Review's position), if not the start. */
  private pendingStartOptions: { fen?: string; playerColor?: Color } | undefined;

  private adapter: RulesAdapter;
  private gameTree: GameTree;
  private readonly plyHistory: PlySnapshot[] = [];
  private readonly hintsLog: HintUsageRecord[] = [];

  private playerColor: Color = 'w';
  private playerColorChoice: Color | 'random' = 'w';
  private botRating: number;
  private botStyle: BotStyleId;
  private timeControlId: TimeControlPresetId;
  private allowTakebacks = true;
  private maxHintsPerGame: number;
  private hintsRemaining: number;
  private botMinDelayMs: number;
  private botMaxDelayMs: number;
  private lastBotThinkTimeMs = 0;
  private maxPremoves: number;

  private gameOver = false;
  private gameResult: GameTermination = '*';
  private gameStatusText = 'White to move';
  private isBotThinking = false;
  private gameGeneration = 0;
  private botAbortController: AbortController | null = null;

  private infiniteAnalysisEnabled = false;
  private infiniteAbortController: AbortController | null = null;
  private latestEvalWhiteCp = 0;
  private latestEvalText = '+0.00';
  private pendingEvalRafId: number | null = null;

  // Cached DOM references
  private topPlayerNameEl!: HTMLElement;
  private bottomPlayerNameEl!: HTMLElement;
  private topClockEl!: HTMLElement;
  private bottomClockEl!: HTMLElement;
  private topCapturedEl!: HTMLElement;
  private bottomCapturedEl!: HTMLElement;
  private statusBannerEl!: HTMLElement;
  private evalBadgeEl!: HTMLElement;
  private moveListEl!: HTMLElement;
  private hintBtnEl!: HTMLButtonElement;
  private takebackBtnEl!: HTMLButtonElement;
  private hintsLogEl!: HTMLElement;

  constructor(options: PlayControllerOptions) {
    this.container = options.container;
    this.engine = options.engine;
    this.settings = options.settings ?? new AppSettingsStore();
    this.onAnalyzeGame = options.onAnalyzeGame;
    this.onReviewGame = options.onReviewGame;
    if (options.botEngine) {
      this.botEngine = options.botEngine;
      this.ownsBotEngine = false;
    } else {
      this.botEngine = new EngineClient({
        variant: 'single-threaded',
        hashMb: 16,
      });
      this.ownsBotEngine = true;
    }

    const ng = this.settings.get().newGame;
    this.playerColorChoice = ng.color;
    this.allowTakebacks = ng.takebacks;
    this.botRating = clampBotRating(options.initialBotRating ?? ng.botRating);
    this.botStyle = options.initialBotStyle ?? ng.botStyle;
    this.timeControlId = options.initialTimeControl ?? ng.timeControlId;
    this.maxHintsPerGame = options.maxHintsPerGame ?? 3;
    this.hintsRemaining = this.maxHintsPerGame;

    if (typeof options.botMoveDelayMs === 'number') {
      this.botMinDelayMs = Math.max(0, options.botMoveDelayMs);
      this.botMaxDelayMs = Math.max(0, options.botMoveDelayMs);
    } else {
      this.botMinDelayMs = Math.max(0, options.botMinDelayMs ?? ng.minThinkMs);
      this.botMaxDelayMs = Math.max(
        this.botMinDelayMs,
        options.botMaxDelayMs ?? ng.maxThinkMs,
      );
    }

    this.maxPremoves = Math.max(
      1,
      Math.min(
        MAX_PREMOVES_LIMIT,
        Math.floor(options.maxPremoves ?? this.settings.get().maxPremoves),
      ),
    );

    this.adapter = new RulesAdapter();
    this.gameTree = new GameTree();
    this.audio =
      options.audio ?? new CathedralAudio({ enabled: true, volume: 0.75 });
    // The bot's move selection runs in a worker so it never blocks the board
    if (options.botSelection) {
      this.botSelection = options.botSelection;
      this.ownsBotSelection = false;
    } else {
      this.botSelection = new BotSelectionClient();
      this.ownsBotSelection = true;
    }
    this.bot = new ChessBot(this.botEngine, {
      rating: this.botRating,
      style: this.botStyle,
      selectMove: (request, rng) => this.botSelection.select(request, rng),
    });

    this.clock = new ChessClock({
      config: TIME_CONTROL_PRESETS[this.timeControlId],
      onTick: (snap) => this.renderClockSnapshot(snap),
      onFlag: (flaggedColor) => this.handleClockFlag(flaggedColor),
    });

    this.mountLayout();
    this.infiniteAnalysisEnabled = this.settings.get().playLiveEval;
    this.unsubscribeSettings = this.settings.subscribe((next, prev) => this.applySettings(next, prev));
    this.updateAllHud();
  }

  private mountLayout(): void {
    const s = this.settings.get();
    const ng = s.newGame;
    const tierChoices = Object.values(BOT_TIERS);

    this.container.innerHTML = `
      <div class="wc-play-layout" data-testid="play-layout">
        <!-- Board column: opponent strip, board, my strip -->
        <div class="wc-board-column">
          <div class="wc-player-bar wc-player-bar-top" data-testid="player-bar-top">
            <div class="wc-player-info">
              <span class="wc-player-avatar" data-testid="top-player-avatar">${icon('bot')}</span>
              <div class="wc-player-text">
                <div class="wc-player-name" data-testid="top-player-name"></div>
                <div class="wc-captured-tray" data-testid="top-captured-tray" aria-label="Top player captured pieces"></div>
              </div>
            </div>
            <div class="wc-clock-box" data-testid="top-clock">5:00</div>
          </div>

          <div class="wc-board-mount" data-testid="board-mount"></div>

          <div class="wc-player-bar wc-player-bar-bottom" data-testid="player-bar-bottom">
            <div class="wc-player-info">
              <span class="wc-player-avatar wc-player-avatar-you" data-testid="bottom-player-avatar">${icon('person')}</span>
              <div class="wc-player-text">
                <div class="wc-player-name" data-testid="bottom-player-name"></div>
                <div class="wc-captured-tray" data-testid="bottom-captured-tray" aria-label="Bottom player captured pieces"></div>
              </div>
            </div>
            <div class="wc-clock-box wc-clock-active" data-testid="bottom-clock">5:00</div>
          </div>
        </div>

        <!-- Side panel: the New game card, or the game in progress -->
        <aside class="wc-panel wc-play-panel" data-testid="play-panel" data-view="setup" aria-label="Game">
          <div class="wc-panel-inner">
            <section class="wc-play-view" data-testid="new-game-card" data-view="setup" aria-labelledby="new-game-title">
              <div class="wc-panel-body wc-newgame">
                <div class="wc-panel-head">
                  <h2 class="wc-panel-title" id="new-game-title">New game</h2>
                  <button type="button" class="wc-btn wc-btn-ghost wc-btn-sm wc-btn-inline" data-testid="btn-back-to-game" hidden>Back to game${icon('next')}</button>
                </div>

                <div class="wc-field-block">
                  <div class="wc-label-row">
                    <span class="wc-label" id="new-game-opponent">Opponent</span>
                    <span class="wc-label-value" data-testid="bot-rating-label"></span>
                  </div>
                  <input type="range" class="wc-range" min="400" max="2400" step="50" value="${ng.botRating}" data-testid="slider-bot-rating" aria-labelledby="new-game-opponent" />
                  <div class="wc-tier-ticks" role="group" aria-label="Bot level">
                    ${tierChoices
                      .map(
                        (t) =>
                          `<button type="button" class="wc-tier-tick" data-rating="${t.defaultRating}" data-tier="${t.id}" data-testid="bot-tier-${t.id}" title="${t.label} · ${t.defaultRating}">${t.label}</button>`,
                      )
                      .join('')}
                  </div>
                  ${segmentedHtml(
                    'style',
                    'bot-style',
                    Object.values(BOT_STYLE_PRESETS).map((p) => ({ value: p.id, label: p.label })),
                    ng.botStyle,
                    'Bot style',
                  )}
                </div>

                <div class="wc-field-block">
                  <span class="wc-label">Time</span>
                  ${chipsHtml(
                    'time',
                    'time-control',
                    Object.values(TIME_CONTROL_PRESETS).map((tc) => {
                      const [main, sub] = tc.label.split(' · ');
                      return tc.id === 'unlimited'
                        ? { value: tc.id, label: '∞', sub: 'Unlimited', title: tc.label }
                        : { value: tc.id, label: (main ?? tc.id).replace(/ /g, ''), sub: sub ?? '', title: tc.label };
                    }),
                    ng.timeControlId,
                    'Time control',
                  )}
                </div>

                <div class="wc-field-block">
                  <span class="wc-label">Play as</span>
                  ${segmentedHtml(
                    'color',
                    'play-as',
                    [
                      { value: 'w', label: 'White' },
                      { value: 'random', label: 'Random' },
                      { value: 'b', label: 'Black' },
                    ],
                    ng.color,
                    'Play as',
                  )}
                </div>

                <details class="wc-disclosure" data-testid="new-game-more">
                  <summary>More options <span class="wc-disclosure-hint">think time, takebacks</span>${icon('caret')}</summary>
                  <div class="wc-disclosure-body">
                    <div class="wc-think-grid">
                      <label class="wc-field">
                        <span class="wc-field-label">Bot thinks at least (s)</span>
                        <input type="number" min="0" max="10" step="0.1" value="${(ng.minThinkMs / 1000).toFixed(1)}" class="wc-select" data-testid="input-bot-min-delay" />
                      </label>
                      <label class="wc-field">
                        <span class="wc-field-label">At most (s)</span>
                        <input type="number" min="0.1" max="15" step="0.1" value="${(ng.maxThinkMs / 1000).toFixed(1)}" class="wc-select" data-testid="input-bot-max-delay" />
                      </label>
                    </div>
                    ${switchRowHtml('toggle-takebacks', 'Allow takebacks', ng.takebacks)}
                  </div>
                </details>
              </div>
              <div class="wc-panel-foot wc-panel-foot-stack">
                <div class="wc-confirm-end" data-testid="new-game-confirm" role="alertdialog" aria-label="End your current game?" hidden>
                  <span>This ends the game in progress.</span>
                  <div class="wc-confirm-end-actions">
                    <button type="button" class="wc-btn wc-btn-secondary" data-testid="btn-new-game-keep">Keep playing</button>
                    <button type="button" class="wc-btn wc-btn-danger" data-testid="btn-new-game-end">End it and play</button>
                  </div>
                </div>
                <button type="button" class="wc-btn wc-btn-primary wc-btn-lg wc-btn-block" data-testid="btn-new-game">${icon('play')}Play</button>
              </div>
            </section>

            <section class="wc-play-view" data-testid="game-view" data-view="game" hidden>
              <div class="wc-status-header">
                <div class="wc-status-banner" data-testid="game-status-banner" role="status" aria-live="polite">White to move</div>
                <div class="wc-eval-pill" data-testid="live-eval-score" title="Evaluation (White's point of view)">+0.00</div>
              </div>
              ${tabListHtml('play', [{ id: 'moves', label: 'Moves' }, { id: 'analysis', label: 'Analysis' }], 'moves', 'Game')}
              <div class="wc-panel-body">
                <div class="wc-tab-panel wc-moves-panel" ${tabPanelAttrs('play', 'moves', 'moves')}>
                  <div class="wc-panel-section-title wc-panel-section-title-end">
                    <span class="wc-hints-log-badge" data-testid="hints-used-badge">0 hints used</span>
                  </div>
                  <div class="wc-move-list" data-testid="move-history-list" role="log" aria-label="Move history"></div>
                </div>
                <div class="wc-tab-panel" ${tabPanelAttrs('play', 'analysis', 'moves')}>
                  ${switchRowHtml(
                    'toggle-infinite-analysis',
                    'Live evaluation',
                    s.playLiveEval,
                    'Stockfish evaluates your position while it is your move; the score shows at the top.',
                  )}
                  <p class="wc-panel-note">For a full analysis with engine lines, use ⋯ › Analyze this position.</p>
                </div>
              </div>
              <div class="wc-panel-foot wc-action-bar" data-testid="play-actions">
                <button type="button" class="wc-btn wc-btn-secondary wc-btn-action" data-testid="btn-hint">${icon('hint')}<span class="wc-btn-text">Hint (${this.hintsRemaining})</span></button>
                <button type="button" class="wc-btn wc-btn-secondary wc-btn-action" data-testid="btn-takeback">${icon('undo')}<span class="wc-btn-text">Takeback</span></button>
                <button type="button" class="wc-btn wc-btn-secondary wc-btn-icon" data-testid="btn-flip-board" title="Flip board (F)" aria-label="Flip board">${icon('flip')}</button>
              </div>
              <div class="wc-panel-foot wc-action-bar" data-testid="game-over-actions" hidden>
                <button type="button" class="wc-btn wc-btn-primary wc-btn-lg wc-grow" data-testid="btn-review-game">${icon('review')}Review this game</button>
                <button type="button" class="wc-btn wc-btn-secondary wc-btn-lg" data-testid="btn-game-over-new">New game</button>
              </div>
            </section>
          </div>
        </aside>
      </div>
    `;

    const boardMount = this.container.querySelector(
      '[data-testid="board-mount"]',
    ) as HTMLElement;

    this.board = new BoardRenderer(boardMount, {
      flipped: false,
      interactiveColor: this.playerColor,
      enablePremoves: true,
      maxPremoves: this.maxPremoves,
      autoQueen: s.autoQueen,
      confirmMove: s.confirmMove,
      captureEffects: s.captureEffects,
      boardTheme: s.boardTheme,
      pieceSet: s.pieceSet,
      onMove: (move, wasDragged) => {
        this.handleUserMove(move, wasDragged);
      },
      onSelectSquare: () => {
        this.audio.playSelect();
      },
    });

    const q = <T extends HTMLElement>(id: string) =>
      this.container.querySelector(`[data-testid="${id}"]`) as T;
    this.topPlayerNameEl = q('top-player-name');
    this.bottomPlayerNameEl = q('bottom-player-name');
    this.topClockEl = q('top-clock');
    this.bottomClockEl = q('bottom-clock');
    this.topCapturedEl = q('top-captured-tray');
    this.bottomCapturedEl = q('bottom-captured-tray');
    this.statusBannerEl = q('game-status-banner');
    this.evalBadgeEl = q('live-eval-score');
    this.moveListEl = q('move-history-list');
    this.hintBtnEl = q('btn-hint');
    this.takebackBtnEl = q('btn-takeback');
    this.hintsLogEl = q('hints-used-badge');
    this.panelEl = q('play-panel');

    this.menu = new Menu(
      q('play-actions'),
      [
        { id: 'draw', label: 'Offer draw', testId: 'btn-offer-draw', icon: 'handshake', onSelect: () => void this.offerDraw() },
        {
          id: 'analyze',
          label: 'Analyze this position',
          testId: 'btn-analyze-game',
          icon: 'review',
          onSelect: () => this.onAnalyzeGame?.(),
        },
        { id: 'new', label: 'New game…', testId: 'menu-new-game', icon: 'plus', onSelect: () => this.showPanelView('setup', true) },
        { id: 'resign', label: 'Resign', testId: 'btn-resign', icon: 'flag', danger: true, separatorBefore: true, onSelect: () => this.resign() },
      ],
      { testId: 'play-menu', label: 'More game actions' },
    );

    this.bindUiControls();
    this.renderNewGameCard();
  }

  /** Which view the side panel shows. `byUser`: opened from the menu, so moves don't leave it. */
  private showPanelView(view: 'setup' | 'game', byUser = false): void {
    this.panelView = view;
    this.setupOpenedByUser = view === 'setup' && byUser;
    this.panelEl.setAttribute('data-view', view);
    for (const el of this.panelEl.querySelectorAll<HTMLElement>('.wc-play-view')) {
      el.hidden = el.dataset.view !== view;
    }
    this.hideEndGameConfirm();
    this.renderNewGameCard();
  }

  public getPanelView(): 'setup' | 'game' {
    return this.panelView;
  }

  /** A move has been played and the game isn't over. */
  public isGameInProgress(): boolean {
    return this.plyHistory.length > 0 && !this.gameOver;
  }

  /** Shows the pending new-game choices on the card, and whether a game is waiting behind it. */
  private renderNewGameCard(): void {
    const ng = this.settings.get().newGame;
    const q = (id: string) => this.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const slider = q('slider-bot-rating') as HTMLInputElement | null;
    if (slider && Number(slider.value) !== ng.botRating) slider.value = String(ng.botRating);
    const tier = getTierForRating(ng.botRating);
    const label = q('bot-rating-label');
    if (label) label.textContent = `${ng.botRating} Elo (${tier})`;
    for (const el of this.container.querySelectorAll<HTMLElement>('.wc-tier-tick')) {
      el.setAttribute('aria-pressed', String(el.dataset.tier === tier));
    }
    setChoice(this.container.querySelector('[data-seg="style"]'), ng.botStyle);
    setChoice(this.container.querySelector('[data-seg="time"]'), ng.timeControlId);
    setChoice(this.container.querySelector('[data-seg="color"]'), ng.color);
    const minInput = q('input-bot-min-delay') as HTMLInputElement | null;
    const maxInput = q('input-bot-max-delay') as HTMLInputElement | null;
    if (minInput && document.activeElement !== minInput) minInput.value = (ng.minThinkMs / 1000).toFixed(1);
    if (maxInput && document.activeElement !== maxInput) maxInput.value = (ng.maxThinkMs / 1000).toFixed(1);
    const takebacks = q('toggle-takebacks') as HTMLInputElement | null;
    if (takebacks) takebacks.checked = ng.takebacks;
    const back = q('btn-back-to-game');
    if (back) back.hidden = !this.isGameInProgress();
  }

  private hideEndGameConfirm(): void {
    const confirm = this.container.querySelector<HTMLElement>('[data-testid="new-game-confirm"]');
    const play = this.container.querySelector<HTMLElement>('[data-testid="btn-new-game"]');
    if (confirm) confirm.hidden = true;
    if (play) play.hidden = false;
  }

  /**
   * Starts a new game (the card's choices, optionally from `options`' position and colour).
   * With a game in progress it asks first, on the New game card: nothing ends without a yes.
   */
  public requestNewGame(options?: { fen?: string; playerColor?: Color }): void {
    this.pendingStartOptions = options;
    if (!this.isGameInProgress()) {
      this.startNewGame(options);
      return;
    }
    this.showPanelView('setup', true);
    const confirm = this.container.querySelector<HTMLElement>('[data-testid="new-game-confirm"]');
    const play = this.container.querySelector<HTMLElement>('[data-testid="btn-new-game"]');
    if (confirm) confirm.hidden = false;
    if (play) play.hidden = true;
    this.container.querySelector<HTMLElement>('[data-testid="btn-new-game-keep"]')?.focus();
  }

  private bindUiControls(): void {
    const q = <T extends HTMLElement>(id: string) =>
      this.container.querySelector(`[data-testid="${id}"]`) as T;

    // New game card: every change only updates the pending choices
    q<HTMLButtonElement>('btn-new-game').addEventListener('click', () => this.requestNewGame());
    q<HTMLButtonElement>('btn-new-game-keep').addEventListener('click', () => this.showPanelView('game'));
    q<HTMLButtonElement>('btn-new-game-end').addEventListener('click', () => this.startNewGame(this.pendingStartOptions));
    q<HTMLButtonElement>('btn-back-to-game').addEventListener('click', () => this.showPanelView('game'));

    const slider = q<HTMLInputElement>('slider-bot-rating');
    slider.addEventListener('input', () => {
      this.settings.set({ newGame: { botRating: Number(slider.value) } });
    });
    for (const tick of this.container.querySelectorAll<HTMLButtonElement>('.wc-tier-tick')) {
      tick.addEventListener('click', () => {
        this.settings.set({ newGame: { botRating: Number(tick.dataset.rating) } });
      });
    }
    bindChoiceGroups(q('new-game-card'), (name, value) => {
      if (name === 'style') this.settings.set({ newGame: { botStyle: value as BotStyleId } });
      else if (name === 'time') this.settings.set({ newGame: { timeControlId: value as TimeControlPresetId } });
      else if (name === 'color') this.settings.set({ newGame: { color: value as Color | 'random' } });
    });
    const minInput = q<HTMLInputElement>('input-bot-min-delay');
    const maxInput = q<HTMLInputElement>('input-bot-max-delay');
    const syncThink = () => {
      const minSec = Number(minInput.value);
      const maxSec = Number(maxInput.value);
      const minMs = Number.isFinite(minSec) ? Math.max(0, Math.round(minSec * 1000)) : 500;
      const maxMs = Number.isFinite(maxSec) ? Math.max(minMs, Math.round(maxSec * 1000)) : Math.max(minMs, 3000);
      this.settings.set({ newGame: { minThinkMs: minMs, maxThinkMs: maxMs } });
    };
    minInput.addEventListener('change', syncThink);
    maxInput.addEventListener('change', syncThink);
    const takebacks = q<HTMLInputElement>('toggle-takebacks');
    takebacks.addEventListener('change', () => {
      this.settings.set({ newGame: { takebacks: takebacks.checked } });
    });

    // In game
    new Tabs(q('game-view'));
    this.flipBtnEl = q<HTMLButtonElement>('btn-flip-board');
    this.flipBtnEl.addEventListener('click', () => {
      this.board.setFlipped(!this.board.isFlipped());
      this.updatePlayerBars();
    });
    this.hintBtnEl.addEventListener('click', () => {
      void this.requestHint();
    });
    this.takebackBtnEl.addEventListener('click', () => {
      this.takeback();
    });
    const liveEval = q<HTMLInputElement>('toggle-infinite-analysis');
    liveEval.addEventListener('change', () => {
      this.setInfiniteAnalysis(liveEval.checked);
    });

    // Game over
    q<HTMLButtonElement>('btn-review-game').addEventListener('click', () => this.onReviewGame?.());
    q<HTMLButtonElement>('btn-game-over-new').addEventListener('click', () => this.showPanelView('setup', true));
  }

  /** Board, input and sound settings that apply to this board at once. */
  private applySettings(next: AppSettings, prev: AppSettings): void {
    if (next.boardTheme !== prev.boardTheme) this.board.setBoardTheme(next.boardTheme);
    if (next.pieceSet !== prev.pieceSet) {
      this.board.setPieceSet(next.pieceSet);
      this.updateCapturedTrays();
    }
    if (next.autoQueen !== prev.autoQueen) this.board.setAutoQueen(next.autoQueen);
    if (next.confirmMove !== prev.confirmMove) this.board.setConfirmMove(next.confirmMove);
    if (next.captureEffects !== prev.captureEffects) this.board.setCaptureEffectsEnabled(next.captureEffects);
    if (next.maxPremoves !== this.maxPremoves) {
      this.maxPremoves = next.maxPremoves;
      this.board.setMaxPremoves(next.maxPremoves);
    }
    if (next.playLiveEval !== this.infiniteAnalysisEnabled) this.setInfiniteAnalysis(next.playLiveEval);
    if (next.newGame !== prev.newGame) this.renderNewGameCard();
  }

  /** Copies the pending new-game choices into the game about to start. */
  private applyNewGameOptions(ng: NewGameOptions): void {
    this.playerColorChoice = ng.color;
    this.timeControlId = ng.timeControlId;
    this.botRating = clampBotRating(ng.botRating);
    this.bot.setRating(this.botRating);
    this.botStyle = ng.botStyle;
    this.bot.setStyle(this.botStyle);
    this.botMinDelayMs = ng.minThinkMs;
    this.botMaxDelayMs = Math.max(ng.minThinkMs, ng.maxThinkMs);
    this.allowTakebacks = ng.takebacks;
  }

  public setMaxPremoves(max: number): void {
    const value = Number.isFinite(max)
      ? Math.max(1, Math.min(MAX_PREMOVES_LIMIT, Math.floor(max)))
      : DEFAULT_MAX_PREMOVES;
    this.maxPremoves = value;
    this.board.setMaxPremoves(value);
    if (this.settings.get().maxPremoves !== value) this.settings.set({ maxPremoves: value });
  }

  public getMaxPremoves(): number {
    return this.maxPremoves;
  }

  /** Sets the bot's rating now (and as the next game's choice). */
  public setBotRating(rating: number): void {
    this.botRating = clampBotRating(rating);
    this.bot.setRating(this.botRating);
    this.settings.set({ newGame: { botRating: this.botRating } });
    this.updatePlayerBars();
  }

  public setBotMoveDelayMs(delayMs: number): void {
    const clamped = Math.max(0, Math.round(delayMs));
    this.setBotDelayRangeMs(clamped, clamped);
  }

  /** Sets the bot's think time now (and as the next game's choice). */
  public setBotDelayRangeMs(minMs: number, maxMs: number): void {
    this.botMinDelayMs = Math.max(0, Math.round(minMs));
    this.botMaxDelayMs = Math.max(this.botMinDelayMs, Math.round(maxMs));
    this.settings.set({ newGame: { minThinkMs: this.botMinDelayMs, maxThinkMs: this.botMaxDelayMs } });
  }

  public getBotDelayRangeMs(): { minMs: number; maxMs: number } {
    return {
      minMs: this.botMinDelayMs,
      maxMs: this.botMaxDelayMs,
    };
  }

  public getLastBotThinkTimeMs(): number {
    return this.lastBotThinkTimeMs;
  }

  private cancelInFlightBotSearch(): void {
    this.gameGeneration++;
    if (this.botAbortController) {
      this.botAbortController.abort();
      this.botAbortController = null;
    }
    this.isBotThinking = false;
  }

  private cancelInfiniteAnalysis(): void {
    if (this.infiniteAbortController) {
      this.infiniteAbortController.abort();
      this.infiniteAbortController = null;
    }
  }

  public setInfiniteAnalysis(enabled: boolean): void {
    this.infiniteAnalysisEnabled = enabled;
    if (this.settings.get().playLiveEval !== enabled) this.settings.set({ playLiveEval: enabled });
    const toggle = this.container.querySelector(
      '[data-testid="toggle-infinite-analysis"]',
    ) as HTMLInputElement | null;
    if (toggle && toggle.checked !== enabled) {
      toggle.checked = enabled;
    }

    if (!enabled) {
      this.cancelInfiniteAnalysis();
      return;
    }
    this.restartInfiniteAnalysisIfEnabled();
  }

  private restartInfiniteAnalysisIfEnabled(): void {
    this.cancelInfiniteAnalysis();
    if (
      !this.infiniteAnalysisEnabled ||
      this.gameOver ||
      this.adapter.turn() !== this.playerColor
    ) {
      return;
    }

    const ac = new AbortController();
    this.infiniteAbortController = ac;
    const currentFen = this.adapter.fen();

    void this.engine
      .analyze({
        fen: currentFen,
        infinite: true,
        multipv: 3,
        useCache: false,
        priority: 'background',
        signal: ac.signal,
        onInfo: (snapshot: EngineAnalysisResult) => {
          if (ac.signal.aborted) return;
          const topLine = snapshot.lines[0];
          if (topLine) {
            this.scheduleLiveEvalUpdate(topLine.scoreWhite, topLine.evalCp);
          }
        },
      })
      .catch((err: unknown) => {
        if (err instanceof EngineCancelledError) return;
      });
  }

  private scheduleLiveEvalUpdate(scoreWhite: UciScore, evalCp: number): void {
    this.latestEvalWhiteCp = evalCp;
    const nextText = formatScore(scoreWhite);
    if (nextText === this.latestEvalText) return;
    this.latestEvalText = nextText;
    if (this.pendingEvalRafId !== null) return;
    this.pendingEvalRafId = requestAnimationFrame(() => {
      this.pendingEvalRafId = null;
      if (this.evalBadgeEl.textContent !== this.latestEvalText) {
        this.evalBadgeEl.textContent = this.latestEvalText;
      }
    });
  }

  private setEvalImmediate(text: string, whiteCp: number): void {
    this.latestEvalText = text;
    this.latestEvalWhiteCp = whiteCp;
    if (this.pendingEvalRafId !== null) {
      cancelAnimationFrame(this.pendingEvalRafId);
      this.pendingEvalRafId = null;
    }
    if (this.evalBadgeEl.textContent !== text) {
      this.evalBadgeEl.textContent = text;
    }
  }

  /**
   * Starts a new game with the New game card's choices (the colour can be overridden, e.g.
   * for a position from Review). Ends any game in progress: the card asks first.
   */
  public startNewGame(options?: {
    fen?: string;
    playerColor?: Color;
  }): void {
    this.cancelInFlightBotSearch();
    this.cancelInfiniteAnalysis();
    this.applyNewGameOptions(this.settings.get().newGame);

    const startFen = options?.fen?.trim() || DEFAULT_POSITION;
    this.adapter = new RulesAdapter(startFen);
    this.gameTree = new GameTree(startFen);
    this.plyHistory.length = 0;
    this.hintsLog.length = 0;

    if (options?.playerColor) {
      this.playerColor = options.playerColor;
    } else if (this.playerColorChoice === 'random') {
      this.playerColor = Math.random() < 0.5 ? 'w' : 'b';
    } else {
      this.playerColor = this.playerColorChoice;
    }

    this.hintsRemaining = this.maxHintsPerGame;
    this.gameOver = false;
    this.gameResult = '*';
    this.gameStatusText = `${this.adapter.turn() === 'w' ? 'White' : 'Black'} to move`;
    this.setEvalImmediate('+0.00', 0);

    this.clock.reset(TIME_CONTROL_PRESETS[this.timeControlId]);
    this.board.setPremove(null);
    this.board.setInteractiveColor(this.playerColor);
    this.board.setFlipped(this.playerColor === 'b');
    this.board.setPosition(this.adapter, { lastMove: null });
    this.board.getParticles().clear();

    this.showPanelView('game');
    this.updateAllHud();

    // If the side to move is the bot, start the clock and trigger the bot's move
    if (this.adapter.turn() !== this.playerColor) {
      this.clock.start(this.adapter.turn());
      void this.triggerBotMove();
    } else {
      this.restartInfiniteAnalysisIfEnabled();
    }
  }

  public loadPosition(fen: string, playerColor: Color = this.playerColor): void {
    this.startNewGame({ fen, playerColor });
  }

  private handleUserMove(moveInput: MoveInput, wasDragged: boolean): boolean {
    if (this.gameOver) return false;
    if (this.adapter.turn() !== this.playerColor) return false;

    let executed: ExecutedMove;
    try {
      executed = this.adapter.move(moveInput);
    } catch {
      this.board.setPosition(this.adapter);
      return false;
    }

    this.applyExecutedMove(executed, wasDragged);

    if (!this.gameOver && this.adapter.turn() !== this.playerColor) {
      void this.triggerBotMove();
    }

    return true;
  }

  private applyExecutedMove(
    executed: ExecutedMove,
    wasDragged: boolean,
    options?: {
      /** `executed` is the head of the board's premove queue. */
      consumedPremove?: boolean;
      /** Another move follows in this same task, so don't restart analysis yet. */
      moreMovesFollow?: boolean;
    },
  ): void {
    // Switch clock turn (starts clock on move 1 or adds Fischer increment)
    const clockSnap =
      this.plyHistory.length === 0 && !this.clock.isRunning()
        ? this.clock.start(executed.color === 'w' ? 'b' : 'w')
        : this.clock.switchTurn(executed.color);

    this.gameTree.addMove(executed.uci);

    this.plyHistory.push({
      executedMove: executed,
      whiteClockMs: clockSnap.whiteMs,
      blackClockMs: clockSnap.blackMs,
      evalText: this.latestEvalText,
      evalWhiteCp: this.latestEvalWhiteCp,
    });

    this.board.setPosition(this.adapter, {
      lastMove: executed,
      wasDragged,
      triggerCaptureParticles: true,
      consumedPremove: Boolean(options?.consumedPremove),
    });

    // Trigger procedural Web Audio effects
    if (this.adapter.isGameOver()) {
      this.finalizeGameOverFromRules();
    } else {
      if (this.adapter.inCheck()) {
        this.audio.playCheck();
      } else if (executed.isCapture) {
        this.audio.playShatter();
      } else {
        this.audio.playSlide(
          CathedralAudio.shouldPieceLevitate(executed.piece),
        );
      }
      this.gameStatusText = `${
        this.adapter.turn() === 'w' ? 'White' : 'Black'
      } to move${this.adapter.inCheck() ? ' — Check!' : ''}`;
    }

    this.updateAllHud();
    if (!options?.moreMovesFollow) {
      this.restartInfiniteAnalysisIfEnabled();
    }
  }

  /**
   * Plays the head of the premove queue right after the opponent's move, in the same task
   * (so the same frame) and through the normal clock path: the player is charged the real
   * elapsed time, which is ~0 ms, and receives the increment. An illegal premove cancels
   * itself and everything queued after it, with a flash. Returns true when a move was played.
   */
  private executeQueuedPremove(): boolean {
    const next = this.board.getPremove();
    if (!next || this.gameOver || this.adapter.turn() !== this.playerColor) {
      return false;
    }

    let executed: ExecutedMove;
    try {
      executed = this.adapter.move({
        from: next.from,
        to: next.to,
        ...(next.promotion ? { promotion: next.promotion } : {}),
      });
    } catch {
      this.board.clearPremoves({ flash: true });
      return false;
    }

    this.applyExecutedMove(executed, false, { consumedPremove: true });
    if (!this.gameOver && this.adapter.turn() !== this.playerColor) {
      void this.triggerBotMove();
    }
    return true;
  }

  private async triggerBotMove(): Promise<void> {
    if (this.gameOver || this.adapter.turn() === this.playerColor) return;

    const gen = ++this.gameGeneration;
    const ac = new AbortController();
    this.botAbortController = ac;
    this.isBotThinking = true;
    this.gameStatusText = 'Stockfish is thinking...';
    this.updateStatusBanner();
    this.updateControlsDisabledState();

    const fen = this.adapter.fen();
    const searchStartedAt = performance.now();

    try {
      const decision = await this.bot.chooseMove(fen, {
        signal: ac.signal,
        priority: 'live',
      });

      if (gen !== this.gameGeneration || ac.signal.aborted || this.gameOver) {
        return;
      }

      const clockSnap = this.clock.getSnapshot();
      const botColor: Color = this.playerColor === 'w' ? 'b' : 'w';
      const botRemainingMs =
        botColor === 'w' ? clockSnap.whiteMs : clockSnap.blackMs;
      const lastPly = this.plyHistory[this.plyHistory.length - 1];

      const targetThinkMs = computeBotThinkTimeMs({
        fen,
        ply: this.plyHistory.length,
        minDelayMs: this.botMinDelayMs,
        maxDelayMs: this.botMaxDelayMs,
        botRemainingMs,
        incrementMs: this.clock.getConfig().incrementMs,
        unlimitedClock: clockSnap.unlimited,
        lastOpponentMove: lastPly
          ? {
              from: lastPly.executedMove.from,
              to: lastPly.executedMove.to,
              isCapture: lastPly.executedMove.isCapture,
            }
          : null,
        decision,
      });

      this.lastBotThinkTimeMs = targetThinkMs;
      const elapsedSearchMs = performance.now() - searchStartedAt;
      const remainingWaitMs = Math.max(
        0,
        Math.round(targetThinkMs - elapsedSearchMs),
      );

      if (remainingWaitMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remainingWaitMs);
          ac.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }

      // Guard against stale worker completion across New Game / Takeback / Color switch (Fixes Legacy Bug #4)
      if (gen !== this.gameGeneration || ac.signal.aborted || this.gameOver) {
        return;
      }

      this.isBotThinking = false;
      this.botAbortController = null;

      // Update live evaluation from bot's search
      this.setEvalImmediate(
        formatScore(decision.selectedLine.scoreWhite),
        decision.selectedLine.evalCp *
          (decision.executedMove.color === 'w' ? 1 : -1),
      );

      const executed = this.adapter.move(decision.uci);
      if (this.plyHistory.length > 0) {
        const lastSnap = this.plyHistory[this.plyHistory.length - 1];
        if (lastSnap) {
          lastSnap.evalText = this.latestEvalText;
          lastSnap.evalWhiteCp = this.latestEvalWhiteCp;
        }
      }

      // A queued premove plays in this same task, so the bot's move and the premove reach
      // the screen in one frame with no added delay.
      const premoveQueued = this.board.getPremove() !== null;
      this.applyExecutedMove(executed, false, {
        moreMovesFollow: premoveQueued,
      });
      if (premoveQueued && !this.executeQueuedPremove()) {
        this.restartInfiniteAnalysisIfEnabled();
      }
    } catch (err: unknown) {
      if (err instanceof EngineCancelledError || ac.signal.aborted) {
        return;
      }
      this.isBotThinking = false;
      this.updateControlsDisabledState();
    }
  }

  /**
   * Reverts the last move pair (or in-flight player move if the bot is still thinking),
   * restoring clocks AND evaluation display (fixes Legacy Bug #6).
   */
  public takeback(): boolean {
    if (!this.allowTakebacks || this.plyHistory.length === 0) {
      return false;
    }

    const wasBotThinking = this.isBotThinking;
    this.cancelInFlightBotSearch();
    this.board.setPremove(null);

    // If bot was thinking, undo 1 ply (player's move). Otherwise undo up to 2 plies back to player's turn.
    const pliesToUndo =
      wasBotThinking || this.plyHistory.length === 1 ? 1 : 2;

    for (let i = 0; i < pliesToUndo && this.plyHistory.length > 0; i++) {
      this.adapter.undo();
      this.plyHistory.pop();
      const curNode = this.gameTree.currentNode;
      if (curNode.parentId) {
        const parentId = curNode.parentId;
        this.gameTree.deleteNode(curNode.id);
        this.gameTree.goToNode(parentId);
      }
    }

    this.gameOver = false;
    this.gameResult = '*';

    const prevSnap = this.plyHistory[this.plyHistory.length - 1];
    if (prevSnap) {
      this.clock.setTimes(
        prevSnap.whiteClockMs,
        prevSnap.blackClockMs,
        this.adapter.turn(),
      );
      this.setEvalImmediate(prevSnap.evalText, prevSnap.evalWhiteCp);
    } else {
      const cfg = this.clock.getConfig();
      this.clock.setTimes(cfg.initialMs, cfg.initialMs, null);
      this.setEvalImmediate('+0.00', 0);
    }

    this.board.setInteractiveColor(this.playerColor);
    this.board.setPosition(this.adapter, {
      lastMove: prevSnap?.executedMove ?? null,
      wasDragged: false,
      triggerCaptureParticles: false,
    });

    this.gameStatusText = `${
      this.adapter.turn() === 'w' ? 'White' : 'Black'
    } to move (Takeback)`;
    this.updateAllHud();
    this.restartInfiniteAnalysisIfEnabled();
    return true;
  }

  /**
   * Requests a best-move hint from Stockfish, draws the hint arrow on the board,
   * decrements remaining hints, and logs a HintUsageRecord for Phase 5 review.
   */
  public async requestHint(): Promise<HintUsageRecord | null> {
    if (
      this.gameOver ||
      this.hintsRemaining <= 0 ||
      this.adapter.turn() !== this.playerColor
    ) {
      return null;
    }

    const fen = this.adapter.fen();
    const res = await this.engine.analyze({
      fen,
      depth: 8,
      multipv: 1,
      priority: 'live',
    });

    if (this.gameOver || this.adapter.fen() !== fen || !res.bestMove) {
      return null;
    }

    const from = res.bestMove.slice(0, 2) as Square;
    const to = res.bestMove.slice(2, 4) as Square;
    const promo = res.bestMove[4] as PieceSymbol | undefined;

    const probe = this.adapter.clone();
    let san = res.bestMove;
    try {
      const m = probe.move({
        from,
        to,
        ...(promo ? { promotion: promo } : {}),
      });
      san = m.san;
    } catch {
      san = res.bestMove;
    }

    this.hintsRemaining--;
    const record: HintUsageRecord = {
      ply: this.plyHistory.length,
      moveNumber: Math.floor(this.plyHistory.length / 2) + 1,
      color: this.playerColor,
      fen,
      suggestedUci: res.bestMove,
      suggestedSan: san,
      evalCp: res.lines[0]?.evalCp ?? 0,
      timestamp: new Date().toISOString(),
    };
    this.hintsLog.push(record);

    this.board.setHintMove({ from, to });
    this.gameStatusText = `Hint: ${san} (${this.hintsRemaining} left)`;
    this.updateAllHud();
    return record;
  }

  public resign(): void {
    if (this.gameOver) return;
    this.cancelInFlightBotSearch();
    this.cancelInfiniteAnalysis();
    this.clock.pause();
    this.board.setPremove(null);
    this.board.setInteractiveColor('none');

    this.gameOver = true;
    this.gameResult = this.playerColor === 'w' ? '0-1' : '1-0';
    this.gameTree.setResult(this.gameResult);
    this.gameStatusText = `${
      this.playerColor === 'w' ? 'White' : 'Black'
    } resigned · ${this.gameResult}`;
    this.audio.playGameOver(false);
    this.updateAllHud();
  }

  public async offerDraw(forceAccept = false): Promise<boolean> {
    if (this.gameOver) return false;

    const botColor: Color = this.playerColor === 'w' ? 'b' : 'w';
    const botEvalCp =
      botColor === 'w' ? this.latestEvalWhiteCp : -this.latestEvalWhiteCp;

    const accepted =
      forceAccept ||
      (this.plyHistory.length >= 2 && botEvalCp <= 55);

    if (accepted) {
      this.cancelInFlightBotSearch();
      this.cancelInfiniteAnalysis();
      this.clock.pause();
      this.board.setPremove(null);
      this.board.setInteractiveColor('none');

      this.gameOver = true;
      this.gameResult = '1/2-1/2';
      this.gameTree.setResult('1/2-1/2');
      this.gameStatusText = 'Game drawn by agreement · 1/2-1/2';
      this.audio.playGameOver(false);
      this.updateAllHud();
      return true;
    }

    this.gameStatusText = 'Bot declines draw offer — play on!';
    this.updateStatusBanner();
    return false;
  }

  private handleClockFlag(flaggedColor: Color): void {
    if (this.gameOver) return;
    this.cancelInFlightBotSearch();
    this.cancelInfiniteAnalysis();
    this.board.setPremove(null);
    this.board.setInteractiveColor('none');

    this.gameOver = true;
    this.gameResult = flaggedColor === 'w' ? '0-1' : '1-0';
    this.gameTree.setResult(this.gameResult);
    const winner = flaggedColor === 'w' ? 'Black' : 'White';
    this.gameStatusText = `${winner} wins on time · ${this.gameResult}`;
    this.audio.playGameOver(flaggedColor !== this.playerColor);
    this.updateAllHud();
  }

  private finalizeGameOverFromRules(): void {
    this.cancelInFlightBotSearch();
    this.cancelInfiniteAnalysis();
    this.clock.pause();
    this.board.setPremove(null);
    this.board.setInteractiveColor('none');
    this.gameOver = true;

    if (this.adapter.isCheckmate()) {
      const loser = this.adapter.turn();
      this.gameResult = loser === 'w' ? '0-1' : '1-0';
      const winnerLabel = loser === 'w' ? 'Black' : 'White';
      this.gameStatusText = `Checkmate — ${winnerLabel} wins · ${this.gameResult}`;
      this.audio.playGameOver(loser !== this.playerColor);
    } else {
      this.gameResult = '1/2-1/2';
      let reason = 'Draw';
      if (this.adapter.isStalemate()) reason = 'Stalemate';
      else if (this.adapter.isThreefoldRepetition())
        reason = 'Threefold repetition';
      else if (this.adapter.isDrawByFiftyMoves()) reason = '50-move rule';
      else if (this.adapter.isInsufficientMaterial())
        reason = 'Insufficient material';
      this.gameStatusText = `Draw by ${reason} · 1/2-1/2`;
      this.audio.playGameOver(false);
    }

    this.gameTree.setResult(this.gameResult);
  }

  private renderClockSnapshot(snap: ClockSnapshot): void {
    const flipped = this.board ? this.board.isFlipped() : false;
    const topColor: Color = flipped ? 'w' : 'b';
    const bottomColor: Color = flipped ? 'b' : 'w';

    if (this.topClockEl) {
      const topText =
        topColor === 'w' ? snap.whiteFormatted : snap.blackFormatted;
      if (this.topClockEl.textContent !== topText) {
        this.topClockEl.textContent = topText;
      }
      this.topClockEl.classList.toggle(
        'wc-clock-active',
        snap.activeColor === topColor && !this.gameOver,
      );
      this.topClockEl.classList.toggle(
        'wc-clock-low',
        !snap.unlimited &&
          (topColor === 'w' ? snap.whiteMs : snap.blackMs) < 20_000,
      );
    }

    if (this.bottomClockEl) {
      const bottomText =
        bottomColor === 'w' ? snap.whiteFormatted : snap.blackFormatted;
      if (this.bottomClockEl.textContent !== bottomText) {
        this.bottomClockEl.textContent = bottomText;
      }
      this.bottomClockEl.classList.toggle(
        'wc-clock-active',
        snap.activeColor === bottomColor && !this.gameOver,
      );
      this.bottomClockEl.classList.toggle(
        'wc-clock-low',
        !snap.unlimited &&
          (bottomColor === 'w' ? snap.whiteMs : snap.blackMs) < 20_000,
      );
    }
  }

  private updatePlayerBars(): void {
    const flipped = this.board.isFlipped();
    const topColor: Color = flipped ? 'w' : 'b';
    const tier = getTierForRating(this.botRating);

    const labelForColor = (c: Color): string =>
      c === this.playerColor
        ? `You (${c === 'w' ? 'White' : 'Black'})`
        : `Stockfish ${tier} (${this.botRating})`;

    this.topPlayerNameEl.textContent = labelForColor(topColor);
    this.bottomPlayerNameEl.textContent = labelForColor(
      topColor === 'w' ? 'b' : 'w',
    );
    this.renderClockSnapshot(this.clock.getSnapshot());
    this.updateCapturedTrays();
  }

  private updateCapturedTrays(): void {
    const executedMoves = this.plyHistory.map((p) => p.executedMove);
    const summary = computeCapturedAndMaterial(executedMoves);
    const flipped = this.board.isFlipped();
    const topColor: Color = flipped ? 'w' : 'b';
    const pieceSet = this.board.getPieceSet();

    const renderTrayHtml = (forColor: Color): string => {
      const capturedPieces =
        forColor === 'w' ? summary.capturedByWhite : summary.capturedByBlack;
      const capturedEnemyColor: Color = forColor === 'w' ? 'b' : 'w';
      const icons = capturedPieces
        .map(
          (p) =>
            `<span class="wc-captured-icon" data-piece="${p}" title="Captured ${p.toUpperCase()}">${getPieceSvgMarkup(pieceSet, capturedEnemyColor, p)}</span>`,
        )
        .join('');

      const adv =
        forColor === 'w'
          ? summary.netAdvantageWhite
          : -summary.netAdvantageWhite;
      const advBadge =
        adv > 0
          ? `<span class="wc-material-adv" data-testid="material-adv-${forColor}">+${adv}</span>`
          : '';
      return icons + advBadge;
    };

    this.topCapturedEl.innerHTML = renderTrayHtml(topColor);
    this.bottomCapturedEl.innerHTML = renderTrayHtml(
      topColor === 'w' ? 'b' : 'w',
    );
  }

  private updateMoveList(): void {
    if (this.panelView === 'setup' && !this.setupOpenedByUser && this.plyHistory.length > 0) {
      this.showPanelView('game');
    }
    if (this.panelView === 'setup') this.renderNewGameCard();
    if (this.plyHistory.length === 0) {
      this.moveListEl.innerHTML = `<div class="wc-move-empty">No moves played yet. Drag or click a piece to begin.</div>`;
      return;
    }

    const rows: string[] = [];
    for (let i = 0; i < this.plyHistory.length; i += 2) {
      const moveNum = Math.floor(i / 2) + 1;
      const whiteMove = this.plyHistory[i]?.executedMove;
      const blackMove = this.plyHistory[i + 1]?.executedMove;
      rows.push(`
        <div class="wc-move-row" data-testid="move-row-${moveNum}">
          <span class="wc-move-num">${moveNum}.</span>
          <span class="wc-move-san ${i === this.plyHistory.length - 1 ? 'wc-move-san-active' : ''}" data-testid="move-ply-${i + 1}">${whiteMove?.san ?? ''}</span>
          <span class="wc-move-san ${i + 1 === this.plyHistory.length - 1 ? 'wc-move-san-active' : ''}" data-testid="move-ply-${i + 2}">${blackMove?.san ?? ''}</span>
        </div>
      `);
    }
    this.moveListEl.innerHTML = rows.join('');
    // The latest move in view (the list scrolls sideways on phones)
    this.moveListEl.scrollTop = this.moveListEl.scrollHeight;
    this.moveListEl.scrollLeft = this.moveListEl.scrollWidth;
  }

  private updateStatusBanner(): void {
    if (this.statusBannerEl.textContent !== this.gameStatusText) {
      this.statusBannerEl.textContent = this.gameStatusText;
    }
  }

  private updateControlsDisabledState(): void {
    const hintText = this.hintBtnEl.querySelector('.wc-btn-text');
    if (hintText) hintText.textContent = `Hint (${this.hintsRemaining})`;
    this.hintBtnEl.disabled =
      this.gameOver ||
      this.hintsRemaining <= 0 ||
      this.isBotThinking ||
      this.adapter.turn() !== this.playerColor;

    this.takebackBtnEl.disabled =
      !this.allowTakebacks || this.plyHistory.length === 0;
    this.menu.setDisabled('draw', this.gameOver);
    this.menu.setDisabled('resign', this.gameOver);
    // Game over: Review this game takes the action bar's place
    const over = this.container.querySelector<HTMLElement>('[data-testid="game-over-actions"]');
    const actions = this.container.querySelector<HTMLElement>('[data-testid="play-actions"]');
    if (over) over.hidden = !this.gameOver;
    if (actions) actions.hidden = this.gameOver;
    this.hintsLogEl.textContent = `${this.hintsLog.length} hint${
      this.hintsLog.length === 1 ? '' : 's'
    } used`;
  }

  private updateAllHud(): void {
    this.updatePlayerBars();
    this.updateMoveList();
    this.updateStatusBanner();
    this.updateControlsDisabledState();
  }

  public getBoard(): BoardRenderer {
    return this.board;
  }

  public getAudio(): CathedralAudio {
    return this.audio;
  }

  public getClock(): ChessClock {
    return this.clock;
  }

  public getAdapter(): RulesAdapter {
    return this.adapter;
  }

  public getGameTree(): GameTree {
    return this.gameTree;
  }

  public getPgn(): string {
    return writePgn(this.gameTree);
  }

  public getHintsLog(): HintUsageRecord[] {
    return [...this.hintsLog];
  }

  public getCapturedSummary(): CapturedAndMaterialSummary {
    return computeCapturedAndMaterial(
      this.plyHistory.map((p) => p.executedMove),
    );
  }

  public isGameOver(): boolean {
    return this.gameOver;
  }

  public getGameResult(): GameTermination {
    return this.gameResult;
  }

  public isBotCurrentlyThinking(): boolean {
    return this.isBotThinking;
  }

  public getLatestEvalText(): string {
    return this.latestEvalText;
  }

  public getBotEngine(): EngineClient {
    return this.botEngine;
  }

  public getBotSelection(): BotSelectionClient {
    return this.botSelection;
  }

  public getBot(): ChessBot {
    return this.bot;
  }

  public destroy(): void {
    this.cancelInFlightBotSearch();
    this.cancelInfiniteAnalysis();
    this.unsubscribeSettings();
    this.menu.destroy();
    if (this.pendingEvalRafId !== null) {
      cancelAnimationFrame(this.pendingEvalRafId);
    }
    if (this.ownsBotEngine) {
      this.botEngine.terminate();
    }
    if (this.ownsBotSelection) {
      this.botSelection.terminate();
    }
    this.clock.destroy();
    this.board.destroy();
  }
}
