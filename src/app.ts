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

declare global {
  interface Window {
    __wizardChessCore?: WizardChessCoreApi;
    __wizardChessEngine?: WizardChessEngineApi;
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
            <div class="wc-brand-subtitle">Offline Chess Learning &amp; Stockfish Analysis</div>
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
        <section class="wc-card" aria-labelledby="shell-heading">
          <h2 id="shell-heading" class="wc-card-title">Phase 2 — Stockfish 17.1 WASM Engine &amp; Human-Like Bot</h2>
          <p class="wc-card-desc">
            Stockfish 17.1 Lite NNUE WebAssembly (multi-threaded and single-threaded variants), MultiPV 1–5 streaming analysis, priority queue, LRU position cache, human-like bot (400–2400 Elo across Novice, Casual, Club, Expert, Master with Aggressive, Solid, and Gambiteer styles), rules adapter (standard + Chess960), recursive variation game tree, custom PGN parser/writer (<code class="wc-kbd">[%eval]</code>, <code class="wc-kbd">[%cal]</code>, <code class="wc-kbd">[%csl]</code>), and IndexedDB v${LATEST_SCHEMA_VERSION} schema migrations are bundled locally with zero runtime network requests. Press <kbd class="wc-kbd">\`</kbd> at any time to inspect live frame timing and engine telemetry.
          </p>
          <div class="wc-grid">
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
          </div>
        </section>
      </main>
    </div>
  `;

  const shellEl = container.querySelector('.wc-shell') as HTMLElement;
  const devOverlay = new DevOverlayController(shellEl);

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
      createConnectedEngine: (options?: EngineClientOptions) =>
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
        }),
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

  return { devOverlay, env };
}


