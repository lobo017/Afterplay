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
  type BotTierId,
} from '../engine/bot';
import {
  EngineCancelledError,
  EngineClient,
  type EngineAnalysisResult,
} from '../engine/engine-client';
import { formatScore, type UciScore } from '../engine/uci-parser';
import { CathedralAudio } from '../render/audio';
import { BoardRenderer } from '../render/board-renderer';
import { getPieceSvgMarkup } from '../render/piece-sets';
import {
  BOARD_THEMES,
  DEFAULT_BOARD_THEME,
  DEFAULT_PIECE_SET,
  PIECE_SETS,
  type BoardThemeId,
  type PieceSetId,
} from '../render/themes';
import {
  ChessClock,
  TIME_CONTROL_PRESETS,
  type ClockSnapshot,
  type TimeControlPresetId,
} from './clock';
import type { DevOverlayController } from './dev-overlay';

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
}

export const DEFAULT_MAX_PREMOVES = 10;
const MAX_PREMOVES_LIMIT = 20;

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
  private board!: BoardRenderer;

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
  private drawBtnEl!: HTMLButtonElement;
  private resignBtnEl!: HTMLButtonElement;
  private hintsLogEl!: HTMLElement;

  constructor(options: PlayControllerOptions) {
    this.container = options.container;
    this.engine = options.engine;
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

    this.botRating = clampBotRating(options.initialBotRating ?? 1400);
    this.botStyle = options.initialBotStyle ?? 'solid';
    this.timeControlId = options.initialTimeControl ?? '5+3';
    this.maxHintsPerGame = options.maxHintsPerGame ?? 3;
    this.hintsRemaining = this.maxHintsPerGame;

    if (typeof options.botMoveDelayMs === 'number') {
      this.botMinDelayMs = Math.max(0, options.botMoveDelayMs);
      this.botMaxDelayMs = Math.max(0, options.botMoveDelayMs);
    } else {
      this.botMinDelayMs = Math.max(0, options.botMinDelayMs ?? 500);
      this.botMaxDelayMs = Math.max(
        this.botMinDelayMs,
        options.botMaxDelayMs ?? 3000,
      );
    }

    this.maxPremoves = Math.max(
      1,
      Math.min(
        MAX_PREMOVES_LIMIT,
        Math.floor(options.maxPremoves ?? DEFAULT_MAX_PREMOVES),
      ),
    );

    this.adapter = new RulesAdapter();
    this.gameTree = new GameTree();
    this.audio =
      options.audio ?? new CathedralAudio({ enabled: true, volume: 0.75 });
    this.bot = new ChessBot(this.botEngine, {
      rating: this.botRating,
      style: this.botStyle,
    });

    this.clock = new ChessClock({
      config: TIME_CONTROL_PRESETS[this.timeControlId],
      onTick: (snap) => this.renderClockSnapshot(snap),
      onFlag: (flaggedColor) => this.handleClockFlag(flaggedColor),
    });

    this.mountLayout();
    this.updateAllHud();
  }

  private mountLayout(): void {
    const tier = getTierForRating(this.botRating);

    this.container.innerHTML = `
      <div class="wc-play-layout" data-testid="play-layout">
        <!-- Left column: Top Opponent Bar + 2D Board + Bottom Player Bar -->
        <div class="wc-board-column">
          <div class="wc-player-bar wc-player-bar-top" data-testid="player-bar-top">
            <div class="wc-player-info">
              <span class="wc-player-avatar" data-testid="top-player-avatar">♚</span>
              <div>
                <div class="wc-player-name" data-testid="top-player-name">Stockfish ${tier} (${this.botRating})</div>
                <div class="wc-captured-tray" data-testid="top-captured-tray" aria-label="Top player captured pieces"></div>
              </div>
            </div>
            <div class="wc-clock-box" data-testid="top-clock">5:00</div>
          </div>

          <div class="wc-board-mount" data-testid="board-mount"></div>

          <div class="wc-player-bar wc-player-bar-bottom" data-testid="player-bar-bottom">
            <div class="wc-player-info">
              <span class="wc-player-avatar wc-player-avatar-you" data-testid="bottom-player-avatar">♔</span>
              <div>
                <div class="wc-player-name" data-testid="bottom-player-name">You (White)</div>
                <div class="wc-captured-tray" data-testid="bottom-captured-tray" aria-label="Bottom player captured pieces"></div>
              </div>
            </div>
            <div class="wc-clock-box wc-clock-active" data-testid="bottom-clock">5:00</div>
          </div>
        </div>

        <!-- Right column: Status, Live Eval, Move History, Game Controls & Settings -->
        <aside class="wc-side-panel" aria-label="Game Controls and Move History">
          <div class="wc-status-header">
            <div class="wc-status-banner" data-testid="game-status-banner" role="status" aria-live="polite">
              White to move
            </div>
            <div class="wc-eval-pill" data-testid="live-eval-score" title="Current Position Evaluation (White perspective)">
              +0.00
            </div>
          </div>

          <!-- Primary Game Actions -->
          <div class="wc-action-row">
            <button type="button" class="wc-btn wc-btn-primary" data-testid="btn-new-game">
              New Game
            </button>
            <button type="button" class="wc-btn wc-btn-secondary" data-testid="btn-flip-board" title="Flip Board (F)">
              Flip Board
            </button>
            <button type="button" class="wc-btn wc-btn-secondary" data-testid="btn-hint">
              Hint (${this.hintsRemaining})
            </button>
          </div>

          <div class="wc-action-row">
            <button type="button" class="wc-btn wc-btn-ghost" data-testid="btn-takeback">
              Takeback
            </button>
            <button type="button" class="wc-btn wc-btn-ghost" data-testid="btn-offer-draw">
              Offer Draw
            </button>
            <button type="button" class="wc-btn wc-btn-danger" data-testid="btn-resign">
              Resign
            </button>
          </div>

          <!-- Move History List -->
          <div class="wc-moves-panel">
            <div class="wc-panel-section-title">
              <span>Moves</span>
              <span class="wc-hints-log-badge" data-testid="hints-used-badge">0 hints used</span>
            </div>
            <div class="wc-move-list" data-testid="move-history-list" role="log" aria-label="Move history"></div>
          </div>

          <!-- Match & Bot Configuration -->
          <div class="wc-settings-section">
            <div class="wc-panel-section-title">Match &amp; Opponent</div>
            <div class="wc-controls-grid">
              <label class="wc-field">
                <span class="wc-field-label">Play As</span>
                <select class="wc-select" data-testid="select-player-color">
                  <option value="w" selected>White</option>
                  <option value="b">Black</option>
                  <option value="random">Random</option>
                </select>
              </label>

              <label class="wc-field">
                <span class="wc-field-label">Time Control</span>
                <select class="wc-select" data-testid="select-time-control">
                  ${Object.values(TIME_CONTROL_PRESETS)
                    .map(
                      (tc) =>
                        `<option value="${tc.id}" ${tc.id === this.timeControlId ? 'selected' : ''}>${tc.label}</option>`,
                    )
                    .join('')}
                </select>
              </label>

              <label class="wc-field">
                <span class="wc-field-label">Bot Tier</span>
                <select class="wc-select" data-testid="select-bot-tier">
                  ${Object.values(BOT_TIERS)
                    .map(
                      (t) =>
                        `<option value="${t.id}" ${t.id === tier ? 'selected' : ''}>${t.label} (${t.defaultRating})</option>`,
                    )
                    .join('')}
                </select>
              </label>

              <label class="wc-field">
                <span class="wc-field-label">Bot Style</span>
                <select class="wc-select" data-testid="select-bot-style">
                  ${Object.values(BOT_STYLE_PRESETS)
                    .map(
                      (s) =>
                        `<option value="${s.id}" ${s.id === this.botStyle ? 'selected' : ''}>${s.label}</option>`,
                    )
                    .join('')}
                </select>
              </label>

              <label class="wc-field">
                <span class="wc-field-label">Min Think (s)</span>
                <input
                  type="number"
                  min="0"
                  max="10"
                  step="0.1"
                  value="${(this.botMinDelayMs / 1000).toFixed(1)}"
                  class="wc-select"
                  data-testid="input-bot-min-delay"
                />
              </label>

              <label class="wc-field">
                <span class="wc-field-label">Max Think (s)</span>
                <input
                  type="number"
                  min="0.1"
                  max="15"
                  step="0.1"
                  value="${(this.botMaxDelayMs / 1000).toFixed(1)}"
                  class="wc-select"
                  data-testid="input-bot-max-delay"
                />
              </label>
            </div>

            <label class="wc-field wc-field-slider">
              <div class="wc-field-row">
                <span class="wc-field-label">Bot Rating</span>
                <span class="wc-field-val" data-testid="bot-rating-label">${this.botRating} Elo (${tier})</span>
              </div>
              <input
                type="range"
                min="400"
                max="2400"
                step="50"
                value="${this.botRating}"
                class="wc-range"
                data-testid="slider-bot-rating"
              />
            </label>
          </div>

          <!-- Board, Input & Audio Settings -->
          <div class="wc-settings-section">
            <div class="wc-panel-section-title">Board, Input &amp; Audio</div>
            <div class="wc-controls-grid">
              <label class="wc-field">
                <span class="wc-field-label">Board Theme</span>
                <select class="wc-select" data-testid="select-board-theme">
                  ${Object.values(BOARD_THEMES)
                    .map(
                      (t) =>
                        `<option value="${t.id}" ${t.id === DEFAULT_BOARD_THEME ? 'selected' : ''}>${t.label}</option>`,
                    )
                    .join('')}
                </select>
              </label>

              <label class="wc-field">
                <span class="wc-field-label">Piece Set</span>
                <select class="wc-select" data-testid="select-piece-set">
                  ${Object.values(PIECE_SETS)
                    .map(
                      (s) =>
                        `<option value="${s.id}" ${s.id === DEFAULT_PIECE_SET ? 'selected' : ''}>${s.label}</option>`,
                    )
                    .join('')}
                </select>
              </label>

              <label class="wc-field" title="How many premoves you can queue during the opponent's turn. 1 = Lichess-style single premove.">
                <span class="wc-field-label">Max Premoves</span>
                <input
                  type="number"
                  min="1"
                  max="${MAX_PREMOVES_LIMIT}"
                  step="1"
                  value="${this.maxPremoves}"
                  class="wc-select"
                  data-testid="input-max-premoves"
                />
              </label>
            </div>

            <div class="wc-toggles-grid">
              <label class="wc-checkbox-label">
                <input type="checkbox" data-testid="toggle-auto-queen" />
                <span>Auto-Queen</span>
              </label>
              <label class="wc-checkbox-label">
                <input type="checkbox" data-testid="toggle-confirm-move" />
                <span>Confirm Move</span>
              </label>
              <label class="wc-checkbox-label">
                <input type="checkbox" data-testid="toggle-takebacks" checked />
                <span>Allow Takebacks</span>
              </label>
              <label class="wc-checkbox-label">
                <input type="checkbox" data-testid="toggle-capture-particles" checked />
                <span>Capture Shards</span>
              </label>
              <label class="wc-checkbox-label">
                <input type="checkbox" data-testid="toggle-audio-mute" checked />
                <span>Sound Effects</span>
              </label>
              <label class="wc-checkbox-label">
                <input type="checkbox" data-testid="toggle-infinite-analysis" />
                <span>Infinite Analysis</span>
              </label>
            </div>

            <label class="wc-field wc-field-slider">
              <div class="wc-field-row">
                <span class="wc-field-label">Audio Volume</span>
                <span class="wc-field-val" data-testid="audio-volume-label">75%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value="75"
                class="wc-range"
                data-testid="slider-audio-volume"
              />
            </label>
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
      autoQueen: false,
      confirmMove: false,
      captureEffects: true,
      boardTheme: DEFAULT_BOARD_THEME,
      pieceSet: DEFAULT_PIECE_SET,
      onMove: (move, wasDragged) => {
        this.handleUserMove(move, wasDragged);
      },
      onSelectSquare: () => {
        this.audio.playSelect();
      },
    });

    this.topPlayerNameEl = this.container.querySelector(
      '[data-testid="top-player-name"]',
    ) as HTMLElement;
    this.bottomPlayerNameEl = this.container.querySelector(
      '[data-testid="bottom-player-name"]',
    ) as HTMLElement;
    this.topClockEl = this.container.querySelector(
      '[data-testid="top-clock"]',
    ) as HTMLElement;
    this.bottomClockEl = this.container.querySelector(
      '[data-testid="bottom-clock"]',
    ) as HTMLElement;
    this.topCapturedEl = this.container.querySelector(
      '[data-testid="top-captured-tray"]',
    ) as HTMLElement;
    this.bottomCapturedEl = this.container.querySelector(
      '[data-testid="bottom-captured-tray"]',
    ) as HTMLElement;
    this.statusBannerEl = this.container.querySelector(
      '[data-testid="game-status-banner"]',
    ) as HTMLElement;
    this.evalBadgeEl = this.container.querySelector(
      '[data-testid="live-eval-score"]',
    ) as HTMLElement;
    this.moveListEl = this.container.querySelector(
      '[data-testid="move-history-list"]',
    ) as HTMLElement;
    this.hintBtnEl = this.container.querySelector(
      '[data-testid="btn-hint"]',
    ) as HTMLButtonElement;
    this.takebackBtnEl = this.container.querySelector(
      '[data-testid="btn-takeback"]',
    ) as HTMLButtonElement;
    this.drawBtnEl = this.container.querySelector(
      '[data-testid="btn-offer-draw"]',
    ) as HTMLButtonElement;
    this.resignBtnEl = this.container.querySelector(
      '[data-testid="btn-resign"]',
    ) as HTMLButtonElement;
    this.hintsLogEl = this.container.querySelector(
      '[data-testid="hints-used-badge"]',
    ) as HTMLElement;

    this.bindUiControls();
  }

  private bindUiControls(): void {
    this.container
      .querySelector('[data-testid="btn-new-game"]')
      ?.addEventListener('click', () => {
        this.startNewGame();
      });

    this.container
      .querySelector('[data-testid="btn-flip-board"]')
      ?.addEventListener('click', () => {
        this.board.setFlipped(!this.board.isFlipped());
        this.updatePlayerBars();
      });

    this.hintBtnEl.addEventListener('click', () => {
      void this.requestHint();
    });

    this.takebackBtnEl.addEventListener('click', () => {
      this.takeback();
    });

    this.drawBtnEl.addEventListener('click', () => {
      void this.offerDraw();
    });

    this.resignBtnEl.addEventListener('click', () => {
      this.resign();
    });

    const colorSelect = this.container.querySelector(
      '[data-testid="select-player-color"]',
    ) as HTMLSelectElement | null;
    colorSelect?.addEventListener('change', () => {
      this.playerColorChoice = colorSelect.value as Color | 'random';
      this.startNewGame();
    });

    const tcSelect = this.container.querySelector(
      '[data-testid="select-time-control"]',
    ) as HTMLSelectElement | null;
    tcSelect?.addEventListener('change', () => {
      this.timeControlId = tcSelect.value as TimeControlPresetId;
      this.startNewGame();
    });

    const tierSelect = this.container.querySelector(
      '[data-testid="select-bot-tier"]',
    ) as HTMLSelectElement | null;
    const ratingSlider = this.container.querySelector(
      '[data-testid="slider-bot-rating"]',
    ) as HTMLInputElement | null;
    const ratingLabel = this.container.querySelector(
      '[data-testid="bot-rating-label"]',
    ) as HTMLElement | null;

    tierSelect?.addEventListener('change', () => {
      const tierId = tierSelect.value as BotTierId;
      const preset = BOT_TIERS[tierId];
      if (preset) {
        this.setBotRating(preset.defaultRating);
        if (ratingSlider) ratingSlider.value = String(this.botRating);
        if (ratingLabel) {
          ratingLabel.textContent = `${this.botRating} Elo (${tierId})`;
        }
      }
    });

    ratingSlider?.addEventListener('input', () => {
      const rating = Number(ratingSlider.value);
      this.setBotRating(rating);
      const tier = getTierForRating(this.botRating);
      if (tierSelect) tierSelect.value = tier;
      if (ratingLabel) {
        ratingLabel.textContent = `${this.botRating} Elo (${tier})`;
      }
    });

    const styleSelect = this.container.querySelector(
      '[data-testid="select-bot-style"]',
    ) as HTMLSelectElement | null;
    styleSelect?.addEventListener('change', () => {
      this.botStyle = styleSelect.value as BotStyleId;
      this.bot.setStyle(this.botStyle);
    });

    const themeSelect = this.container.querySelector(
      '[data-testid="select-board-theme"]',
    ) as HTMLSelectElement | null;
    themeSelect?.addEventListener('change', () => {
      this.board.setBoardTheme(themeSelect.value as BoardThemeId);
    });

    const pieceSetSelect = this.container.querySelector(
      '[data-testid="select-piece-set"]',
    ) as HTMLSelectElement | null;
    pieceSetSelect?.addEventListener('change', () => {
      this.board.setPieceSet(pieceSetSelect.value as PieceSetId);
      this.updateCapturedTrays();
    });

    const autoQueenToggle = this.container.querySelector(
      '[data-testid="toggle-auto-queen"]',
    ) as HTMLInputElement | null;
    autoQueenToggle?.addEventListener('change', () => {
      this.board.setAutoQueen(autoQueenToggle.checked);
    });

    const confirmMoveToggle = this.container.querySelector(
      '[data-testid="toggle-confirm-move"]',
    ) as HTMLInputElement | null;
    confirmMoveToggle?.addEventListener('change', () => {
      this.board.setConfirmMove(confirmMoveToggle.checked);
    });

    const takebacksToggle = this.container.querySelector(
      '[data-testid="toggle-takebacks"]',
    ) as HTMLInputElement | null;
    takebacksToggle?.addEventListener('change', () => {
      this.allowTakebacks = takebacksToggle.checked;
      this.updateControlsDisabledState();
    });

    const particlesToggle = this.container.querySelector(
      '[data-testid="toggle-capture-particles"]',
    ) as HTMLInputElement | null;
    particlesToggle?.addEventListener('change', () => {
      this.board.setCaptureEffectsEnabled(particlesToggle.checked);
    });

    const muteToggle = this.container.querySelector(
      '[data-testid="toggle-audio-mute"]',
    ) as HTMLInputElement | null;
    muteToggle?.addEventListener('change', () => {
      this.audio.setEnabled(muteToggle.checked);
    });

    const volumeSlider = this.container.querySelector(
      '[data-testid="slider-audio-volume"]',
    ) as HTMLInputElement | null;
    const volumeLabel = this.container.querySelector(
      '[data-testid="audio-volume-label"]',
    ) as HTMLElement | null;
    volumeSlider?.addEventListener('input', () => {
      const pct = Number(volumeSlider.value);
      this.audio.setVolume(pct / 100);
      if (volumeLabel) {
        volumeLabel.textContent = `${pct}%`;
      }
    });

    const infiniteToggle = this.container.querySelector(
      '[data-testid="toggle-infinite-analysis"]',
    ) as HTMLInputElement | null;
    infiniteToggle?.addEventListener('change', () => {
      this.setInfiniteAnalysis(infiniteToggle.checked);
    });

    const minDelayInput = this.container.querySelector(
      '[data-testid="input-bot-min-delay"]',
    ) as HTMLInputElement | null;
    const maxDelayInput = this.container.querySelector(
      '[data-testid="input-bot-max-delay"]',
    ) as HTMLInputElement | null;

    const syncDelayInputs = () => {
      const minSec = Number(minDelayInput?.value ?? 0.5);
      const maxSec = Number(maxDelayInput?.value ?? 3.0);
      const minMs = Number.isFinite(minSec) ? Math.max(0, Math.round(minSec * 1000)) : 500;
      const maxMs = Number.isFinite(maxSec)
        ? Math.max(minMs, Math.round(maxSec * 1000))
        : Math.max(minMs, 3000);
      this.setBotDelayRangeMs(minMs, maxMs);
    };

    minDelayInput?.addEventListener('change', syncDelayInputs);
    maxDelayInput?.addEventListener('change', syncDelayInputs);

    const maxPremovesInput = this.container.querySelector(
      '[data-testid="input-max-premoves"]',
    ) as HTMLInputElement | null;
    maxPremovesInput?.addEventListener('change', () => {
      this.setMaxPremoves(Number(maxPremovesInput.value));
    });
  }

  public setMaxPremoves(max: number): void {
    const value = Number.isFinite(max)
      ? Math.max(1, Math.min(MAX_PREMOVES_LIMIT, Math.floor(max)))
      : DEFAULT_MAX_PREMOVES;
    this.maxPremoves = value;
    this.board.setMaxPremoves(value);
    const input = this.container.querySelector(
      '[data-testid="input-max-premoves"]',
    ) as HTMLInputElement | null;
    if (input && input.value !== String(value)) {
      input.value = String(value);
    }
  }

  public getMaxPremoves(): number {
    return this.maxPremoves;
  }

  public setBotRating(rating: number): void {
    this.botRating = clampBotRating(rating);
    this.bot.setRating(this.botRating);
    this.updatePlayerBars();
  }

  public setBotMoveDelayMs(delayMs: number): void {
    const clamped = Math.max(0, Math.round(delayMs));
    this.setBotDelayRangeMs(clamped, clamped);
  }

  public setBotDelayRangeMs(minMs: number, maxMs: number): void {
    this.botMinDelayMs = Math.max(0, Math.round(minMs));
    this.botMaxDelayMs = Math.max(this.botMinDelayMs, Math.round(maxMs));
    const minDelayInput = this.container.querySelector(
      '[data-testid="input-bot-min-delay"]',
    ) as HTMLInputElement | null;
    const maxDelayInput = this.container.querySelector(
      '[data-testid="input-bot-max-delay"]',
    ) as HTMLInputElement | null;
    if (minDelayInput) {
      minDelayInput.value = (this.botMinDelayMs / 1000).toFixed(1);
    }
    if (maxDelayInput) {
      maxDelayInput.value = (this.botMaxDelayMs / 1000).toFixed(1);
    }
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

  public startNewGame(options?: {
    fen?: string;
    playerColor?: Color;
  }): void {
    this.cancelInFlightBotSearch();
    this.cancelInfiniteAnalysis();

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
    this.moveListEl.scrollTop = this.moveListEl.scrollHeight;
  }

  private updateStatusBanner(): void {
    if (this.statusBannerEl.textContent !== this.gameStatusText) {
      this.statusBannerEl.textContent = this.gameStatusText;
    }
  }

  private updateControlsDisabledState(): void {
    this.hintBtnEl.textContent = `Hint (${this.hintsRemaining})`;
    this.hintBtnEl.disabled =
      this.gameOver ||
      this.hintsRemaining <= 0 ||
      this.isBotThinking ||
      this.adapter.turn() !== this.playerColor;

    this.takebackBtnEl.disabled =
      !this.allowTakebacks || this.plyHistory.length === 0;
    this.drawBtnEl.disabled = this.gameOver;
    this.resignBtnEl.disabled = this.gameOver;
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

  public getBot(): ChessBot {
    return this.bot;
  }

  public destroy(): void {
    this.cancelInFlightBotSearch();
    this.cancelInfiniteAnalysis();
    if (this.pendingEvalRafId !== null) {
      cancelAnimationFrame(this.pendingEvalRafId);
    }
    if (this.ownsBotEngine) {
      this.botEngine.terminate();
    }
    this.clock.destroy();
    this.board.destroy();
  }
}
