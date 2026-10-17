import { DevOverlayController } from './ui/dev-overlay';
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

export interface AppShellEnvironment {
  crossOriginIsolated: boolean;
  hardwareConcurrency: number;
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
}

export interface WizardChessPlayApi {
  controller: PlayController;
  engine: EngineClient;
  devOverlay: DevOverlayController;
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

declare global {
  interface Window {
    __wizardChessCore?: WizardChessCoreApi;
    __wizardChessEngine?: WizardChessEngineApi;
    __wizardChessPlay?: WizardChessPlayApi;
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
} {
  const env = detectEnvironment();
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
        <div id="wc-play-root" class="wc-play-root"></div>

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

  const playRootEl = container.querySelector('#wc-play-root') as HTMLElement;
  const sharedEngine = createConnectedEngine({ variant: 'auto' });

  const playController = new PlayController({
    container: playRootEl,
    engine: sharedEngine,
    devOverlay,
  });

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
    };

    window.__wizardChessPlay = {
      controller: playController,
      engine: sharedEngine,
      devOverlay,
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

  // Global keyboard shortcut: 'f' / 'F' flips the board when not typing in an input
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
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

  return { devOverlay, env, playController };
}
