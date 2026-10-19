import { DevOverlayController } from './ui/dev-overlay';
import { initBoardSize } from './render/board-size';
import { boardFeel, type BoardFeelStore } from './render/board-feel';
import {
  DEFAULT_POSITION,
  RulesAdapter,
  validateChessFen,
} from './core/rules';
import { GameTree, nagToGlyph, resolveNagCode } from './core/game-tree';
import {
  parseCommentAnnotations,
  parsePgn,
  parsePgnGames,
  writePgn,
} from './core/pgn';
import {
  LATEST_SCHEMA_VERSION,
  WizardChessStorage,
  deleteWizardChessDB,
  openWizardChessDB,
} from './storage/db';
import {
  AnalysisCache,
  EngineCancelledError,
  EngineClient,
  MULTI_THREADED_ENGINE_URL,
  SINGLE_THREADED_ENGINE_URL,
  detectEngineCapabilities,
  normalizeFenForCache,
  type EngineClientOptions,
} from './engine/engine-client';
import {
  BOT_STYLE_PRESETS,
  BOT_TIERS,
  ChessBot,
  clampBotRating,
  computeBotEngineParams,
  computeBotThinkTimeMs,
  getTierForRating,
  selectHumanLikeMove,
} from './engine/bot';
import {
  formatScore,
  parseUciLine,
  scoreForWhite,
  scoreToCentipawns,
} from './engine/uci-parser';
import {
  BOARD_THEMES,
  PIECE_SETS,
} from './render/themes';
import { getPieceSvgMarkup } from './render/piece-sets';
import { BoardOverlay, squareToBoardCoords } from './render/overlay';
import {
  CaptureParticleSystem,
  PARTICLE_POOL_SIZE,
  SHARDS_PER_CAPTURE,
} from './render/particles';
import { CathedralAudio } from './render/audio';
import {
  BoardRenderer,
  computePremoveTargets,
} from './render/board-renderer';
import {
  ChessClock,
  TIME_CONTROL_PRESETS,
  formatClockMs,
} from './ui/clock';
import {
  PlayController,
  computeCapturedAndMaterial,
} from './ui/play-controller';
import {
  OPENINGS_BY_EPD,
  formatOpeningBadge,
  lookupGameOpening,
  lookupOpeningByFen,
} from './analysis/opening-lookup';
import {
  EvalBar,
  cpToWhiteWinPercent,
  formatEvalBarScore,
  pgnEvalToUciScore,
  scoreToEvalBarPercent,
  scoreToWhiteWinPercent,
} from './analysis/eval-bar';
import {
  buildNullMoveFen,
  detectOpponentThreat,
} from './analysis/threat-detector';
import {
  EngineLinesPanel,
  formatPvMovesToSan,
} from './analysis/engine-lines-panel';
import {
  PositionEditor,
  parseFenForEditor,
  serializeEditorBoardToFen,
} from './analysis/position-editor';
import { AnalysisController } from './analysis/analysis-controller';
import { BotSelectionClient } from './engine/bot-selection-client';
import { ReviewPanel } from './review/review-panel';
import { ReviewRunner } from './review/review-runner';
import { buildGameReview, buildAnnotatedPgn } from './review/review-game';
import { SAMPLE_GAME_PGN } from './review/sample-game';
import { mainLinePlies } from './review/review-game';
import { DEFAULT_USER_ACCOUNTS } from './review/perspective';
import { GameLibrary } from './library/library';
import { GamesList } from './library/games-list';
import { ReviewQueue } from './library/review-queue';
import { ExtensionBridgeClient } from './library/bridge-client';
import { toSavedReview } from './library/saved-review';
import type { StoredGameRecord } from './storage/db';
import type { MessageWindow } from './capture/protocol';
import { PuzzleStore } from './trainers/puzzle-store';
import { TodayScreen, type PuzzleMode } from './trainers/today-screen';
import type { PuzzleTrainer } from './trainers/puzzle-trainer';

export type AppWorkspaceMode = 'play' | 'analysis' | 'games' | 'today' | 'puzzles';

export interface AppShellEnvironment {
  crossOriginIsolated: boolean;
  hardwareConcurrency: boolean | number;
  offlineReady: boolean;
}

export interface WizardChessCoreApi {
  DEFAULT_POSITION: typeof DEFAULT_POSITION;
  RulesAdapter: typeof RulesAdapter;
  validateChessFen: typeof validateChessFen;
  GameTree: typeof GameTree;
  nagToGlyph: typeof nagToGlyph;
  resolveNagCode: typeof resolveNagCode;
  parseCommentAnnotations: typeof parseCommentAnnotations;
  parsePgn: typeof parsePgn;
  parsePgnGames: typeof parsePgnGames;
  writePgn: typeof writePgn;
  LATEST_SCHEMA_VERSION: typeof LATEST_SCHEMA_VERSION;
  WizardChessStorage: typeof WizardChessStorage;
  openWizardChessDB: typeof openWizardChessDB;
  deleteWizardChessDB: typeof deleteWizardChessDB;
}

export interface WizardChessEngineApi {
  EngineClient: typeof EngineClient;
  EngineCancelledError: typeof EngineCancelledError;
  AnalysisCache: typeof AnalysisCache;
  ChessBot: typeof ChessBot;
  BOT_TIERS: typeof BOT_TIERS;
  BOT_STYLE_PRESETS: typeof BOT_STYLE_PRESETS;
  clampBotRating: typeof clampBotRating;
  getTierForRating: typeof getTierForRating;
  computeBotEngineParams: typeof computeBotEngineParams;
  computeBotThinkTimeMs: typeof computeBotThinkTimeMs;
  selectHumanLikeMove: typeof selectHumanLikeMove;
  detectEngineCapabilities: typeof detectEngineCapabilities;
  normalizeFenForCache: typeof normalizeFenForCache;
  parseUciLine: typeof parseUciLine;
  scoreToCentipawns: typeof scoreToCentipawns;
  scoreForWhite: typeof scoreForWhite;
  formatScore: typeof formatScore;
  MULTI_THREADED_ENGINE_URL: typeof MULTI_THREADED_ENGINE_URL;
  SINGLE_THREADED_ENGINE_URL: typeof SINGLE_THREADED_ENGINE_URL;
  createConnectedEngine: (options?: EngineClientOptions) => EngineClient;
  BotSelectionClient: typeof BotSelectionClient;
}

export interface WizardChessPlayApi {
  controller: PlayController;
  engine: EngineClient;
  botEngine: EngineClient;
  devOverlay: DevOverlayController;
  /** The shared board feel (tuned from the dev overlay). */
  boardFeel: BoardFeelStore;
  BoardRenderer: typeof BoardRenderer;
  BoardOverlay: typeof BoardOverlay;
  CaptureParticleSystem: typeof CaptureParticleSystem;
  CathedralAudio: typeof CathedralAudio;
  ChessClock: typeof ChessClock;
  PlayController: typeof PlayController;
  computeCapturedAndMaterial: typeof computeCapturedAndMaterial;
  computePremoveTargets: typeof computePremoveTargets;
  squareToBoardCoords: typeof squareToBoardCoords;
  getPieceSvgMarkup: typeof getPieceSvgMarkup;
  formatClockMs: typeof formatClockMs;
  BOARD_THEMES: typeof BOARD_THEMES;
  PIECE_SETS: typeof PIECE_SETS;
  TIME_CONTROL_PRESETS: typeof TIME_CONTROL_PRESETS;
  PARTICLE_POOL_SIZE: typeof PARTICLE_POOL_SIZE;
  SHARDS_PER_CAPTURE: typeof SHARDS_PER_CAPTURE;
}

export interface WizardChessAnalysisApi {
  controller: AnalysisController;
  switchToAnalysis: (copyPlayGame?: boolean) => void;
  switchToPlay: () => void;
  getMode: () => AppWorkspaceMode;
  AnalysisController: typeof AnalysisController;
  EvalBar: typeof EvalBar;
  cpToWhiteWinPercent: typeof cpToWhiteWinPercent;
  scoreToWhiteWinPercent: typeof scoreToWhiteWinPercent;
  scoreToEvalBarPercent: typeof scoreToEvalBarPercent;
  formatEvalBarScore: typeof formatEvalBarScore;
  pgnEvalToUciScore: typeof pgnEvalToUciScore;
  EngineLinesPanel: typeof EngineLinesPanel;
  formatPvMovesToSan: typeof formatPvMovesToSan;
  PositionEditor: typeof PositionEditor;
  parseFenForEditor: typeof parseFenForEditor;
  serializeEditorBoardToFen: typeof serializeEditorBoardToFen;
  lookupOpeningByFen: typeof lookupOpeningByFen;
  lookupGameOpening: typeof lookupGameOpening;
  formatOpeningBadge: typeof formatOpeningBadge;
  OPENINGS_BY_EPD: typeof OPENINGS_BY_EPD;
  buildNullMoveFen: typeof buildNullMoveFen;
  detectOpponentThreat: typeof detectOpponentThreat;
}

export interface WizardChessReviewApi {
  panel: ReviewPanel;
  /** The review's own engine (created on first use). */
  getEngine: () => EngineClient;
  /** Threads for the review engine; a change restarts it (EngineClient.configure). */
  setThreads: (threads: number) => Promise<void>;
  ReviewRunner: typeof ReviewRunner;
  buildGameReview: typeof buildGameReview;
  buildAnnotatedPgn: typeof buildAnnotatedPgn;
  SAMPLE_GAME_PGN: string;
}

/**
 * Threads for the review engine. A review searches each position for a fixed time, so
 * threads could only buy depth, and measured they don't: 2 and 4 threads search 1.9× and
 * 2.7× the nodes but reach no greater depth at 0.2 s or 0.6 s, while 4 threads next to
 * live analysis caused long tasks and slowed it by 15%. One thread leaves live analysis
 * untouched. See PROGRESS.md (Phase 5, review engine threads).
 */
export const REVIEW_ENGINE_THREADS = 1;
export const REVIEW_ENGINE_HASH_MB = 32;

export interface WizardChessLibraryApi {
  library: GameLibrary;
  gamesList: GamesList;
  queue: ReviewQueue;
  bridge: ExtensionBridgeClient;
  openGame: (id: string) => Promise<boolean>;
  /** The Games list game shown on the analysis board (null when the board shows something else). */
  getOpenGameId: () => string | null;
}

export interface WizardChessPuzzlesApi {
  store: PuzzleStore;
  today: TodayScreen;
  /** Opens the Puzzles tab on a session (loads the trainer and its dataset worker on first use). */
  open: (mode: PuzzleMode) => Promise<PuzzleTrainer>;
  /** The trainer once loaded (null before Puzzles was first opened). */
  getTrainer: () => PuzzleTrainer | null;
  /** Brings personal puzzles up to date with the reviewed games. */
  syncPersonal: () => Promise<void>;
}

declare global {
  interface Window {
    __wizardChessPuzzles?: WizardChessPuzzlesApi;
    /** Resolves once puzzle storage is open (it shares the game library's database). */
    __wizardChessPuzzlesReady?: Promise<WizardChessPuzzlesApi>;
    __wizardChessLibrary?: WizardChessLibraryApi;
    /** Resolves once the Games list's storage is open (rejects if IndexedDB is unavailable). */
    __wizardChessLibraryReady?: Promise<WizardChessLibraryApi>;
    __wizardChessReview?: WizardChessReviewApi;
    __wizardChessCore?: WizardChessCoreApi;
    __wizardChessEngine?: WizardChessEngineApi;
    __wizardChessPlay?: WizardChessPlayApi;
    __wizardChessAnalysis?: WizardChessAnalysisApi;
  }
}

export function detectEnvironment(): AppShellEnvironment {
  const isIsolated =
    typeof window !== 'undefined' && Boolean(window.crossOriginIsolated);
  const threads =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 1;

  return {
    crossOriginIsolated: isIsolated,
    hardwareConcurrency: threads,
    offlineReady: true,
  };
}

export function mountAppShell(container: HTMLElement): {
  devOverlay: DevOverlayController;
  env: AppShellEnvironment;
  playController: PlayController;
  analysisController: AnalysisController;
  setMode: (mode: AppWorkspaceMode, copyPlayGame?: boolean) => void;
} {
  const env = detectEnvironment();
  initBoardSize();
  const threadModeLabel = env.crossOriginIsolated
    ? `Multi-threaded Capable (${env.hardwareConcurrency} cores)`
    : 'Single-threaded Fallback';

  container.innerHTML = `
    <div class="wc-shell" data-testid="app-shell">
      <header class="wc-header">
        <div class="wc-brand">
          <div class="wc-brand-mark" aria-hidden="true">♛</div>
          <div>
            <h1 class="wc-brand-title">Wizard's Chess</h1>
            <div class="wc-brand-subtitle">Cathedral Marble &amp; Obsidian · Offline Stockfish Training</div>
          </div>
        </div>

        <nav class="wc-mode-nav" aria-label="Workspace Mode">
          <button
            type="button"
            class="wc-mode-tab wc-mode-tab-active"
            data-testid="mode-tab-play"
            aria-selected="true"
          >
            ⚔ Play Board
          </button>
          <button
            type="button"
            class="wc-mode-tab"
            data-testid="mode-tab-analysis"
            aria-selected="false"
          >
            🔍 Analysis Board
          </button>
          <button
            type="button"
            class="wc-mode-tab"
            data-testid="mode-tab-games"
            aria-selected="false"
          >
            📚 Games
          </button>
          <button
            type="button"
            class="wc-mode-tab"
            data-testid="mode-tab-today"
            aria-selected="false"
          >
            ☀ Today
          </button>
          <button
            type="button"
            class="wc-mode-tab"
            data-testid="mode-tab-puzzles"
            aria-selected="false"
          >
            🧩 Puzzles
          </button>
          <button
            type="button"
            class="wc-mode-tab wc-mode-tab-action"
            data-testid="btn-analyze-game"
            title="Send the current Play game tree to the Analysis Board"
          >
            Analyze Game →
          </button>
        </nav>

        <div class="wc-status-bar">
          <span class="wc-badge" data-testid="isolation-badge">
            <span class="wc-dot ${env.crossOriginIsolated ? '' : 'wc-dot-warn'}"></span>
            <span>${env.crossOriginIsolated ? 'COOP/COEP Isolated' : 'Single-Thread Mode'}</span>
          </span>
          <span class="wc-badge" data-testid="network-badge">
            <span class="wc-dot"></span>
            <span>Zero-Network Offline Shell</span>
          </span>
          <span class="wc-badge" data-testid="core-badge">
            <span class="wc-dot"></span>
            <span>Core Rules · PGN · IDB v${LATEST_SCHEMA_VERSION}</span>
          </span>
          <span class="wc-badge" data-testid="engine-badge">
            <span class="wc-dot"></span>
            <span>Stockfish 17.1 WASM · Bot 400–2400</span>
          </span>
          <button
            type="button"
            class="wc-badge wc-badge-button"
            data-testid="toggle-dev-overlay"
            aria-pressed="false"
            title="Toggle Developer Performance Overlay (Backtick key)"
          >
            <span>Dev Overlay</span>
            <span class="wc-kbd">\`</span>
          </button>
        </div>
      </header>

      <main class="wc-main">
        <div id="wc-workspace-host" class="wc-workspace-host">
          <div id="wc-play-root" class="wc-play-root"></div>
        </div>

        <!-- System Architecture & Diagnostics Footer Bar (preserves Phase 0-2 telemetry selectors) -->
        <section class="wc-diagnostics-strip" aria-label="Architecture Diagnostics">
          <div class="wc-stat">
            <div class="wc-stat-label">Engine Threading</div>
            <div class="wc-stat-value" data-testid="stat-threading">${threadModeLabel}</div>
          </div>
          <div class="wc-stat">
            <div class="wc-stat-label">Runtime Network</div>
            <div class="wc-stat-value" data-testid="stat-network">0 External Requests</div>
          </div>
          <div class="wc-stat">
            <div class="wc-stat-label">Bundled Datasets</div>
            <div class="wc-stat-value" data-testid="stat-datasets">Openings · 20k Puzzles · Endgames</div>
          </div>
          <div class="wc-stat">
            <div class="wc-stat-label">Rules &amp; Variants</div>
            <div class="wc-stat-value" data-testid="stat-rules">Standard + Chess960 (Perft Verified)</div>
          </div>
          <div class="wc-stat">
            <div class="wc-stat-label">PGN &amp; GameTree</div>
            <div class="wc-stat-value" data-testid="stat-pgn">RAVs · NAGs · [%eval/%cal/%csl]</div>
          </div>
          <div class="wc-stat">
            <div class="wc-stat-label">Local Storage</div>
            <div class="wc-stat-value" data-testid="stat-storage">IndexedDB Schema v${LATEST_SCHEMA_VERSION}</div>
          </div>
          <div class="wc-stat">
            <div class="wc-stat-label">Stockfish Engine</div>
            <div class="wc-stat-value" data-testid="stat-engine">Stockfish 17.1 Lite NNUE (MultiPV 1–5)</div>
          </div>
          <div class="wc-stat">
            <div class="wc-stat-label">Playing Bot</div>
            <div class="wc-stat-value" data-testid="stat-bot">400–2400 Elo · Aggressive / Solid / Gambiteer</div>
          </div>
        </section>
      </main>
    </div>
  `;

  const shellEl = container.querySelector('.wc-shell') as HTMLElement;
  const devOverlay = new DevOverlayController(shellEl);

  const createConnectedEngine = (options?: EngineClientOptions) =>
    new EngineClient({
      ...options,
      onTelemetry: (telemetry) => {
        devOverlay.updateEngineStats(telemetry.depth, telemetry.nps);
        options?.onTelemetry?.(telemetry);
      },
      onCacheLookup: (hit) => {
        devOverlay.recordCacheLookup(hit);
        options?.onCacheLookup?.(hit);
      },
    });

  const workspaceHostEl = container.querySelector(
    '#wc-workspace-host',
  ) as HTMLElement;
  const playRootEl = container.querySelector('#wc-play-root') as HTMLElement;
  const analysisRootEl = document.createElement('div');
  analysisRootEl.id = 'wc-analysis-root';
  analysisRootEl.className = 'wc-analysis-root';
  const gamesRootEl = document.createElement('div');
  gamesRootEl.id = 'wc-games-root';
  gamesRootEl.className = 'wc-games-root';
  gamesRootEl.innerHTML = '<p class="wc-games-loading" data-testid="games-loading">Opening the game library…</p>';
  const todayRootEl = document.createElement('div');
  todayRootEl.id = 'wc-today-root';
  todayRootEl.className = 'wc-today-root';
  todayRootEl.innerHTML = '<p class="wc-games-loading" data-testid="today-loading">Opening your progress…</p>';
  const puzzlesRootEl = document.createElement('div');
  puzzlesRootEl.id = 'wc-puzzles-root';
  puzzlesRootEl.className = 'wc-puzzles-root';
  puzzlesRootEl.innerHTML = '<p class="wc-games-loading" data-testid="puzzles-loading">Loading puzzles…</p>';

  // The Games list's library opens in the background; the board doesn't wait for it
  let library: GameLibrary | null = null;
  /** The Games list game on the analysis board, so a review run there is saved with it. */
  let openGameId: string | null = null;
  let openingGame = false;

  const sharedEngine = createConnectedEngine({ variant: 'auto' });
  const botEngine = new EngineClient({
    variant: 'single-threaded',
    hashMb: 16,
  });

  // One synthesizer for both modes, so only one AudioContext is ever built.
  const audio = new CathedralAudio({ enabled: true, volume: 0.75 });

  const playController = new PlayController({
    container: playRootEl,
    engine: sharedEngine,
    botEngine,
    devOverlay,
    audio,
  });

  const analysisController = new AnalysisController({
    container: analysisRootEl,
    engine: sharedEngine,
    threatEngine: botEngine,
    audio,
    initialActive: false,
  });

  // The review runs on its own engine, so live analysis keeps its worker while a review
  // runs. Created on the first review.
  let reviewEngine: EngineClient | null = null;
  let reviewThreads = REVIEW_ENGINE_THREADS;
  const getReviewEngine = (): EngineClient => {
    reviewEngine ??= createConnectedEngine({
      variant: 'auto',
      threads: reviewThreads,
      hashMb: REVIEW_ENGINE_HASH_MB,
    });
    return reviewEngine;
  };

  const reviewPanel = new ReviewPanel(analysisController.getReviewMount(), {
    host: {
      getGameTree: () => analysisController.getGameTree(),
      getCurrentNode: () => analysisController.getGameTree().currentNode,
      goToNode: (nodeId) => {
        analysisController.goToNode(nodeId);
      },
      setOrientation: (color) => analysisController.setOrientation(color),
      importPgn: (pgn) => analysisController.importPgn(pgn),
      importPgnFromStart: (pgn) => analysisController.importPgnFromStart(pgn),
      addLine: (fromNodeId, ucis, options) => analysisController.addLine(fromNodeId, ucis, options),
      deleteNode: (nodeId) => analysisController.deleteNode(nodeId),
      stripEngineAnnotations: () => analysisController.stripEngineAnnotations(),
      applyReview: (entries, rerender) => analysisController.applyReview(entries, rerender),
      showPgnText: (pgn, status) => analysisController.showPgnText(pgn, status),
      setMoveInterceptor: (fn) => analysisController.setMoveInterceptor(fn),
      onNavigate: (listener) => analysisController.onNavigate(listener),
      onTreeReplaced: (listener) => analysisController.onTreeReplaced(listener),
    },
    getEngine: getReviewEngine,
    isBookPosition: (fen) => lookupOpeningByFen(fen) !== null,
    getAccounts: () => library?.getUserAccounts() ?? DEFAULT_USER_ACCOUNTS,
    onReviewFinished: (result) => {
      const id = openGameId;
      const lib = library;
      if (!id || !lib) return;
      void lib.get(id).then((record) => {
        const saved = toSavedReview(result);
        if (!record || !saved) return undefined;
        // Only when the board still shows the stored game's moves
        const stored = mainLinePlies(parsePgn(record.pgn)).map((ply) => ply.uci);
        if (stored.length === saved.ucis.length && stored.every((u, i) => u === saved.ucis[i])) {
          return lib.saveReview(id, saved);
        }
        return undefined;
      });
    },
    onPlayVsBot: (fen) => {
      const turn = fen.trim().split(/\s+/)[1] === 'b' ? 'b' : 'w';
      setMode('play', false);
      playController.startNewGame({ fen, playerColor: turn });
    },
  });

  // Building an AudioContext blocks the main thread for ~200 ms on some systems. Do it on
  // the first pointer movement, before the first click, so the first piece pickup isn't
  // where that stall lands. Sound still starts on the first gesture (init() resumes it).
  if (typeof window !== 'undefined') {
    window.addEventListener('pointermove', () => audio.prewarm(), {
      once: true,
      passive: true,
    });
  }

  let currentMode: AppWorkspaceMode = 'play';
  const modeTabPlayBtn = container.querySelector(
    '[data-testid="mode-tab-play"]',
  ) as HTMLButtonElement;
  const modeTabAnalysisBtn = container.querySelector(
    '[data-testid="mode-tab-analysis"]',
  ) as HTMLButtonElement;
  const modeTabGamesBtn = container.querySelector(
    '[data-testid="mode-tab-games"]',
  ) as HTMLButtonElement;
  let gamesList: GamesList | null = null;
  const modeTabTodayBtn = container.querySelector(
    '[data-testid="mode-tab-today"]',
  ) as HTMLButtonElement;
  const modeTabPuzzlesBtn = container.querySelector(
    '[data-testid="mode-tab-puzzles"]',
  ) as HTMLButtonElement;
  let todayScreen: TodayScreen | null = null;
  let puzzleTrainer: PuzzleTrainer | null = null;
  /** Puzzle storage opens with the game library; Today and Puzzles wait for it. */
  let resolvePuzzles!: (api: WizardChessPuzzlesApi) => void;
  let rejectPuzzles!: (err: unknown) => void;
  const puzzlesReady = new Promise<WizardChessPuzzlesApi>((resolve, reject) => {
    resolvePuzzles = resolve;
    rejectPuzzles = reject;
  });
  puzzlesReady.catch(() => undefined);
  /** The trainer chunk, imported the first time Puzzles opens. */
  let trainerLoading: Promise<PuzzleTrainer> | null = null;
  /** Serializes session starts, so the latest request wins and none interleave. */
  let puzzleStart: Promise<unknown> = Promise.resolve();
  const analyzeGameBtn = container.querySelector(
    '[data-testid="btn-analyze-game"]',
  ) as HTMLButtonElement;

  const setMode = (mode: AppWorkspaceMode, copyPlayGame = false): void => {
    if (copyPlayGame) {
      const playTree = playController.getGameTree();
      if (playTree.root.children.length > 0 || playTree.root.fen !== DEFAULT_POSITION) {
        analysisController.loadGameTree(playTree);
      }
    }
    if (currentMode === mode) {
      return;
    }
    currentMode = mode;

    const tabs: Array<[HTMLButtonElement, AppWorkspaceMode]> = [
      [modeTabPlayBtn, 'play'],
      [modeTabAnalysisBtn, 'analysis'],
      [modeTabGamesBtn, 'games'],
      [modeTabTodayBtn, 'today'],
      [modeTabPuzzlesBtn, 'puzzles'],
    ];
    for (const [btn, m] of tabs) {
      btn.classList.toggle('wc-mode-tab-active', m === mode);
      btn.setAttribute('aria-selected', String(m === mode));
    }

    if (mode === 'analysis') {
      workspaceHostEl.replaceChildren(analysisRootEl);
      analysisController.setActive(true);
    } else {
      analysisController.setActive(false);
      const roots: Record<Exclude<AppWorkspaceMode, 'analysis'>, HTMLElement> = {
        play: playRootEl,
        games: gamesRootEl,
        today: todayRootEl,
        puzzles: puzzlesRootEl,
      };
      workspaceHostEl.replaceChildren(roots[mode]);
      if (mode === 'games') void gamesList?.refresh();
      if (mode === 'today') void todayScreen?.refresh();
    }
  };

  /**
   * The puzzle trainer is its own chunk, imported the first time Puzzles opens; its dataset
   * worker (the 20,000 bundled puzzles) starts then too. Neither is in the main bundle.
   */
  const loadTrainer = (): Promise<PuzzleTrainer> => {
    trainerLoading ??= Promise.all([puzzlesReady, import('./trainers/puzzle-trainer')]).then(([api, mod]) => {
      puzzlesRootEl.replaceChildren();
      puzzleTrainer = new mod.PuzzleTrainer({
        container: puzzlesRootEl,
        store: api.store,
        engine: sharedEngine,
        audio,
        syncPersonal: api.syncPersonal,
        onAnalyze: (pgn, ply) => {
          setMode('analysis', false);
          if (!analysisController.importPgn(pgn)) return;
          const node = analysisController.getGameTree().getMainLine()[ply - 1];
          if (node) analysisController.goToNode(node.id);
        },
        onOpenGames: () => setMode('games', false),
      });
      return puzzleTrainer;
    });
    trainerLoading.catch((err: unknown) => {
      trainerLoading = null;
      const msg = document.createElement('p');
      msg.className = 'wc-games-loading';
      msg.setAttribute('data-testid', 'puzzles-loading');
      msg.textContent = `Puzzles could not be opened: ${err instanceof Error ? err.message : String(err)}`;
      puzzlesRootEl.replaceChildren(msg);
    });
    return trainerLoading;
  };

  /**
   * Shows Puzzles on a session; with no session given, the first open picks the one with
   * the most to do (due reviews, then my mistakes, then rated puzzles).
   */
  const openPuzzles = (mode: PuzzleMode | null): Promise<PuzzleTrainer> => {
    setMode('puzzles', false);
    const run = puzzleStart.then(async () => {
      const firstOpen = puzzleTrainer === null;
      const trainer = await loadTrainer();
      if (mode) {
        await trainer.start(mode);
      } else if (firstOpen) {
        const today = await (await puzzlesReady).store.todaySummary();
        const due = today.dueReviews.personal + today.dueReviews.lichess;
        await trainer.start(due > 0 ? 'review' : today.newPersonal > 0 ? 'mistakes' : 'rated');
      }
      return trainer;
    });
    puzzleStart = run.catch(() => undefined);
    return run;
  };

  modeTabPlayBtn.addEventListener('click', () => {
    setMode('play', false);
  });

  modeTabAnalysisBtn.addEventListener('click', () => {
    setMode('analysis', false);
  });

  modeTabGamesBtn.addEventListener('click', () => {
    setMode('games', false);
  });

  modeTabTodayBtn.addEventListener('click', () => {
    setMode('today', false);
  });

  modeTabPuzzlesBtn.addEventListener('click', () => {
    void openPuzzles(null);
  });

  analysisController.onTreeReplaced(() => {
    if (!openingGame) openGameId = null;
  });

  /** Opens a Games list game on the analysis board, with its saved review if it has one. */
  const openLibraryGame = async (record: StoredGameRecord): Promise<boolean> => {
    if (!library) return false;
    const saved = record.analysis ? await library.getReview(record.id) : undefined;
    setMode('analysis', false);
    openingGame = true;
    const ok = analysisController.importPgn(record.pgn);
    openingGame = false;
    if (!ok) return false;
    openGameId = record.id;
    analysisController.goToNode(analysisController.getGameTree().root.id);
    if (saved) reviewPanel.showSavedReview(saved);
    return true;
  };

  const libraryReady: Promise<WizardChessLibraryApi> = WizardChessStorage.create().then(async (storage) => {
    const lib = new GameLibrary(storage);
    await lib.init();
    library = lib;
    const queue = new ReviewQueue({
      library: lib,
      getEngine: getReviewEngine,
      isBookPosition: (fen) => lookupOpeningByFen(fen) !== null,
    });
    const bridge = new ExtensionBridgeClient(window as unknown as MessageWindow, {
      saveGames: (games) => lib.saveBridgeGames(games),
      setAccounts: (accounts) => lib.setMyAccounts(accounts),
    });
    gamesRootEl.replaceChildren();
    const list = new GamesList({
      container: gamesRootEl,
      library: lib,
      queue,
      onOpen: (record) => void openLibraryGame(record),
      getExtensionStatus: () => bridge.getStatus(),
      onExtensionStatus: (listener) => bridge.onStatus(listener),
    });
    gamesList = list;
    if (currentMode === 'games') await list.refresh();
    // Sync with the capture extension now, on focus and when the tab becomes visible
    bridge.start((wake) => {
      window.addEventListener('focus', wake);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') wake();
      });
    });
    const api: WizardChessLibraryApi = {
      library: lib,
      gamesList: list,
      queue,
      bridge,
      openGame: async (id) => {
        const record = await lib.get(id);
        return record ? openLibraryGame(record) : false;
      },
      getOpenGameId: () => openGameId,
    };
    window.__wizardChessLibrary = api;

    // Puzzles and the Today screen share the library's storage
    const puzzleStore = new PuzzleStore(storage);
    const syncPersonal = async (): Promise<void> => {
      await puzzleStore.syncAll(await lib.list(), (id) => lib.getReview(id), lib.getUserAccounts());
    };
    // A review saved for a game (from the list or the board) turns my errors into puzzles
    lib.onChange((change) => {
      for (const id of change.updated) {
        void (async () => {
          const record = await lib.get(id);
          if (!record?.analysis) return;
          await puzzleStore.syncReviewedGame(record, await lib.getReview(id), lib.getUserAccounts());
          if (currentMode === 'today') await todayScreen?.refresh();
        })();
      }
    });
    todayRootEl.replaceChildren();
    const today = new TodayScreen({
      container: todayRootEl,
      store: puzzleStore,
      syncPersonal,
      countUnanalyzed: async () => (await lib.list()).filter((g) => !g.analysis).length,
      onStartPuzzles: (mode) => void openPuzzles(mode),
      onOpenGames: () => setMode('games', false),
    });
    todayScreen = today;
    const puzzlesApi: WizardChessPuzzlesApi = {
      store: puzzleStore,
      today,
      open: (mode) => openPuzzles(mode),
      getTrainer: () => puzzleTrainer,
      syncPersonal,
    };
    window.__wizardChessPuzzles = puzzlesApi;
    resolvePuzzles(puzzlesApi);
    if (currentMode === 'today') void today.refresh();
    return api;
  });
  window.__wizardChessPuzzlesReady = puzzlesReady;
  libraryReady.catch((err: unknown) => {
    rejectPuzzles(err);
    todayRootEl.replaceChildren();
    const todayMsg = document.createElement('p');
    todayMsg.className = 'wc-games-loading';
    todayMsg.setAttribute('data-testid', 'today-loading');
    todayMsg.textContent = `Your progress could not be opened: ${err instanceof Error ? err.message : String(err)}`;
    todayRootEl.appendChild(todayMsg);
    gamesRootEl.replaceChildren();
    const msg = document.createElement('p');
    msg.className = 'wc-games-loading';
    msg.setAttribute('data-testid', 'games-loading');
    msg.textContent = `The game library could not be opened: ${err instanceof Error ? err.message : String(err)}`;
    gamesRootEl.appendChild(msg);
  });
  window.__wizardChessLibraryReady = libraryReady;

  analyzeGameBtn.addEventListener('click', () => {
    setMode('analysis', true);
  });

  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (
      params.get('mode') === 'analysis' ||
      window.location.hash === '#analysis'
    ) {
      setMode('analysis', false);
    } else if (params.get('mode') === 'games' || window.location.hash === '#games') {
      setMode('games', false);
    } else if (params.get('mode') === 'today' || window.location.hash === '#today') {
      setMode('today', false);
    } else if (params.get('mode') === 'puzzles' || window.location.hash === '#puzzles') {
      void openPuzzles(null);
    }
  }

  if (typeof window !== 'undefined') {
    window.__wizardChessCore = {
      DEFAULT_POSITION,
      RulesAdapter,
      validateChessFen,
      GameTree,
      nagToGlyph,
      resolveNagCode,
      parseCommentAnnotations,
      parsePgn,
      parsePgnGames,
      writePgn,
      LATEST_SCHEMA_VERSION,
      WizardChessStorage,
      openWizardChessDB,
      deleteWizardChessDB,
    };

    window.__wizardChessEngine = {
      EngineClient,
      EngineCancelledError,
      AnalysisCache,
      ChessBot,
      BOT_TIERS,
      BOT_STYLE_PRESETS,
      clampBotRating,
      getTierForRating,
      computeBotEngineParams,
      computeBotThinkTimeMs,
      selectHumanLikeMove,
      detectEngineCapabilities,
      normalizeFenForCache,
      parseUciLine,
      scoreToCentipawns,
      scoreForWhite,
      formatScore,
      MULTI_THREADED_ENGINE_URL,
      SINGLE_THREADED_ENGINE_URL,
      createConnectedEngine,
      BotSelectionClient,
    };

    window.__wizardChessPlay = {
      controller: playController,
      engine: sharedEngine,
      botEngine,
      devOverlay,
      boardFeel,
      BoardRenderer,
      BoardOverlay,
      CaptureParticleSystem,
      CathedralAudio,
      ChessClock,
      PlayController,
      computeCapturedAndMaterial,
      computePremoveTargets,
      squareToBoardCoords,
      getPieceSvgMarkup,
      formatClockMs,
      BOARD_THEMES,
      PIECE_SETS,
      TIME_CONTROL_PRESETS,
      PARTICLE_POOL_SIZE,
      SHARDS_PER_CAPTURE,
    };

    window.__wizardChessReview = {
      panel: reviewPanel,
      getEngine: getReviewEngine,
      setThreads: async (threads) => {
        reviewThreads = threads;
        if (reviewEngine) await reviewEngine.configure({ threads });
      },
      ReviewRunner,
      buildGameReview,
      buildAnnotatedPgn,
      SAMPLE_GAME_PGN,
    };

    window.__wizardChessAnalysis = {
      controller: analysisController,
      switchToAnalysis: (copyPlayGame = false) =>
        setMode('analysis', copyPlayGame),
      switchToPlay: () => setMode('play', false),
      getMode: () => currentMode,
      AnalysisController,
      EvalBar,
      cpToWhiteWinPercent,
      scoreToWhiteWinPercent,
      scoreToEvalBarPercent,
      formatEvalBarScore,
      pgnEvalToUciScore,
      EngineLinesPanel,
      formatPvMovesToSan,
      PositionEditor,
      parseFenForEditor,
      serializeEditorBoardToFen,
      lookupOpeningByFen,
      lookupGameOpening,
      formatOpeningBadge,
      OPENINGS_BY_EPD,
      buildNullMoveFen,
      detectOpponentThreat,
    };
  }

  const toggleBtn = container.querySelector(
    '[data-testid="toggle-dev-overlay"]',
  ) as HTMLButtonElement | null;

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      devOverlay.toggle();
    });
    devOverlay.onToggle((visible) => {
      toggleBtn.setAttribute('aria-pressed', String(visible));
    });
  }

  // Global keyboard shortcut for Play Mode: 'f' / 'F' flips the play board when not typing in an input
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
      if (currentMode !== 'play') return;
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
      if (
        (e.key === 'f' || e.key === 'F') &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        const board = playController.getBoard();
        board.setFlipped(!board.isFlipped());
      }
    });
  }

  return {
    devOverlay,
    env,
    playController,
    analysisController,
    setMode,
  };
}

