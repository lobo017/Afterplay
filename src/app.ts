import { DevOverlayController } from './ui/dev-overlay';
import { lazy, lazyProxy, whenIdle } from './ui/lazy';
import { SettingsPanel } from './ui/settings-panel';
import { InstallGuide, preventIosFocusZoom, readInstallEnvironment } from './ui/install-guide';
import { describePersistence, requestPersistentStorage } from './storage/persistence';
import {
  describeEngineProfile,
  detectDeviceProfile,
  engineProfileFor,
  type EngineProfile,
} from './engine/engine-profile';
import { AppSettingsStore, type AppSettings } from './ui/app-settings';
import { SETTINGS_ORDER, mountAppSettingsSections } from './ui/settings-sections';
import { mountBoardFeelSection } from './ui/settings-feel-section';
import { mountDataSection } from './ui/settings-data-section';
import {
  abortableSleep,
  browserFetch,
  describeSyncResult,
  librarySyncStore,
  runChessComSync,
} from './sync/chesscom-sync';
import { Preferences, loadStoredAppSettings } from './ui/settings-persistence';
import { icon, type IconName } from './ui/components/icons';
import { initBoardSize } from './render/board-size';
import { boardFeel, type BoardFeelStore } from './render/board-feel';
import { DEFAULT_POSITION, RulesAdapter, validateChessFen } from './core/rules';
import { GameTree, nagToGlyph, resolveNagCode } from './core/game-tree';
import { parseCommentAnnotations, parsePgn, parsePgnGames, writePgn } from './core/pgn';
import { LATEST_SCHEMA_VERSION, WizardChessStorage, deleteWizardChessDB, openWizardChessDB } from './storage/db';
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
import { formatScore, parseUciLine, scoreForWhite, scoreToCentipawns } from './engine/uci-parser';
import { BOARD_THEMES, PIECE_SETS } from './render/themes';
import { getPieceSvgMarkup } from './render/piece-sets';
import { BoardOverlay, squareToBoardCoords } from './render/overlay';
import { CaptureParticleSystem, PARTICLE_POOL_SIZE, SHARDS_PER_CAPTURE } from './render/particles';
import { CathedralAudio } from './render/audio';
import { BoardRenderer, computePremoveTargets } from './render/board-renderer';
import { ChessClock, TIME_CONTROL_PRESETS, formatClockMs } from './ui/clock';
import { PlayController, computeCapturedAndMaterial } from './ui/play-controller';
import { OPENINGS_BY_EPD, formatOpeningBadge, lookupGameOpening, lookupOpeningByFen } from './analysis/opening-lookup';
import {
  EvalBar,
  cpToWhiteWinPercent,
  formatEvalBarScore,
  pgnEvalToUciScore,
  scoreToEvalBarPercent,
  scoreToWhiteWinPercent,
} from './analysis/eval-bar';
import { buildNullMoveFen, detectOpponentThreat } from './analysis/threat-detector';
import { EngineLinesPanel, formatPvMovesToSan } from './analysis/engine-lines-panel';
import { PositionEditor, parseFenForEditor, serializeEditorBoardToFen } from './analysis/position-editor';
import { AnalysisController } from './analysis/analysis-controller';
import { BotSelectionClient } from './engine/bot-selection-client';
import { ReviewPanel } from './review/review-panel';
import { ReviewRunner } from './review/review-runner';
import { buildGameReview, buildAnnotatedPgn } from './review/review-game';
import { SAMPLE_GAME_PGN } from './review/sample-game';
import { mainLinePlies } from './review/review-game';
import { DEFAULT_USER_ACCOUNTS } from './review/perspective';
import { GameLibrary } from './library/library';
import { myColor } from './library/game-record';
import { GamesList } from './library/games-list';
import { InsightsView } from './library/insights-view';
import { Tabs, tabListHtml, tabPanelAttrs } from './ui/components/tabs';
import { ReviewQueue } from './library/review-queue';
import { ExtensionBridgeClient } from './library/bridge-client';
import { toSavedReview } from './library/saved-review';
import type { StoredGameRecord } from './storage/db';
import type { MessageWindow } from './capture/protocol';
import { PuzzleStore } from './trainers/puzzle-store';
import { TodayScreen, type PuzzleMode } from './trainers/today-screen';
import type { PuzzleTrainer } from './trainers/puzzle-trainer';
import { DrillStore, type DrillKind } from './trainers/drill-store';
import { TrainerTiles, type TrainerKind } from './trainers/trainer-tiles';
import { findDeparture } from './trainers/repertoire';
import type { RepertoireTrainer } from './trainers/repertoire-trainer';
import type { EndgameTrainer } from './trainers/endgame-trainer';
import type { GuessGame, VisualizationTrainer } from './trainers/visualization-trainer';
import { describeOffline, watchOffline } from './pwa';
import { mountUpdateBanner } from './ui/update-banner';
import { registerActivity } from './ui/activity';
import { mountGamesSettings } from './ui/settings-games-section';
import { mountProfileSection } from './ui/settings-profile-section';
import { WelcomeSheet } from './ui/welcome-sheet';
import { mountNotice } from './ui/notice';
import { startSlugFromPath, type Preset } from './preset/preset';
import { DEFAULT_APP_NAME, ProfileStore, welcomeWithAppName, type Profile } from './preset/profile';
import { loadFirstRunPreset, loadFirstRunState, loadHistoryFile, saveFirstRunState } from './preset/first-run';
import { landingScreen, readLanding, writeLanding, type StoryLanding } from './story/landing';
import { STORY_IMPORT_SETTING, readImportRecord, storeHistory } from './story/history-loader';
import { StoryView } from './story/view';
import { applyAppIdentity } from './preset/app-identity';

/** The four destinations. Review holds the analysis board; Train holds Today and the puzzles. */
export type AppWorkspaceMode = 'play' | 'train' | 'review' | 'games';

/** Where Train is: its hub (what's due, and the trainers) or a trainer's session. */
export type TrainView = 'hub' | 'session';

export type { TrainerKind };

const NAV_ITEMS: ReadonlyArray<{ mode: AppWorkspaceMode; label: string; icon: IconName }> = [
  { mode: 'play', label: 'Play', icon: 'play' },
  { mode: 'train', label: 'Train', icon: 'train' },
  { mode: 'review', label: 'Review', icon: 'review' },
  { mode: 'games', label: 'Games', icon: 'games' },
];

/**
 * The destination a URL asks for (`#review`, `?mode=review`). Links from before the four
 * destinations still work: analysis → review, today and puzzles → train.
 */
export function modeFromLocation(search: string, hash: string): AppWorkspaceMode | null {
  const name = new URLSearchParams(search).get('mode') ?? hash.replace(/^#/, '');
  switch (name) {
    case 'play':
      return 'play';
    case 'review':
    case 'analysis':
      return 'review';
    case 'train':
    case 'today':
    case 'puzzles':
      return 'train';
    case 'games':
    case 'story':
      return 'games';
    default:
      return null;
  }
}

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
  /** Opens Review (the analysis board), optionally with the Play game on it. */
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

/** After start-up, the idle moments (each its own task) that build the Review screen and the audio context. */
const REVIEW_STACK_WARMUP_DELAY_MS = 150;
const AUDIO_PREWARM_DELAY_MS = 400;
/** After start-up, when to ask for persistent storage and when the first-run install guide may open (iPhone/iPad). */
const PERSIST_REQUEST_DELAY_MS = 1000;
const INSTALL_GUIDE_DELAY_MS = 600;
/** The lines panel's note while a review has a phone's only engine. */
export const REVIEW_PAUSES_ANALYSIS_NOTE =
  'Live analysis is paused while the review runs (this phone uses one engine).';

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
  /** Train's current view: the hub (Today) or a puzzle session. */
  getTrainView: () => TrainView;
  /** Opens the Puzzles tab on a session (loads the trainer and its dataset worker on first use). */
  open: (mode: PuzzleMode) => Promise<PuzzleTrainer>;
  /** The trainer once loaded (null before Puzzles was first opened). */
  getTrainer: () => PuzzleTrainer | null;
  /** Brings personal puzzles up to date with the reviewed games. */
  syncPersonal: () => Promise<void>;
}

export interface WizardChessDrillsApi {
  /** The repertoire, endgame and visualization stores (their cards feed Today with the puzzles'). */
  store: DrillStore;
  tiles: TrainerTiles;
  /** The trainer Train's session view shows (null at the hub). */
  getTrainSession: () => TrainerKind | null;
  openRepertoire: () => Promise<RepertoireTrainer>;
  openEndgames: () => Promise<EndgameTrainer>;
  openVisualization: () => Promise<VisualizationTrainer>;
  /** Each trainer once loaded (null before it was first opened). */
  getRepertoire: () => RepertoireTrainer | null;
  getEndgames: () => EndgameTrainer | null;
  getVisualization: () => VisualizationTrainer | null;
}

declare global {
  interface Window {
    __wizardChessDrills?: WizardChessDrillsApi;
    /** Resolves once the trainers' storage is open (it shares the game library's database). */
    __wizardChessDrillsReady?: Promise<WizardChessDrillsApi>;
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
  const isIsolated = typeof window !== 'undefined' && Boolean(window.crossOriginIsolated);
  const threads = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 1;

  return {
    crossOriginIsolated: isIsolated,
    hardwareConcurrency: threads,
    offlineReady: true,
  };
}

type ReadyHook = '__wizardChessPuzzlesReady' | '__wizardChessDrillsReady' | '__wizardChessLibraryReady';
const READY_HOOKS: readonly ReadyHook[] = [
  '__wizardChessPuzzlesReady',
  '__wizardChessDrillsReady',
  '__wizardChessLibraryReady',
];
const readyResolvers = new Map<ReadyHook, (value: Promise<never>) => void>();

/**
 * Publishes the "ready" promises (library, puzzles, drills) on `window` at once, before the app is mounted: the app is
 * built a frame after the page loads (see main.ts), and whoever awaits a promise (the tests, anything scripting the page)
 * must find it there from the first moment, as it always was. `mountAppShell` settles each with the real one.
 */
export function installReadyHooks(): void {
  for (const key of READY_HOOKS) {
    const placeholder = new Promise<never>((resolve) => {
      readyResolvers.set(key, resolve as (value: Promise<never>) => void);
    });
    placeholder.catch(() => undefined);
    (window as unknown as Record<string, Promise<never>>)[key] = placeholder;
  }
}

function publishReady(key: ReadyHook, promise: Promise<unknown>): void {
  const resolve = readyResolvers.get(key);
  if (resolve) resolve(promise as Promise<never>);
  else (window as unknown as Record<string, Promise<unknown>>)[key] = promise;
}

export function mountAppShell(container: HTMLElement): {
  devOverlay: DevOverlayController;
  env: AppShellEnvironment;
  playController: PlayController;
  analysisController: AnalysisController;
  setMode: (mode: AppWorkspaceMode, copyPlayGame?: boolean) => void;
} {
  const env = detectEnvironment();
  preventIosFocusZoom();
  const engineProfile: EngineProfile = engineProfileFor(detectDeviceProfile());
  const caps = detectEngineCapabilities();
  initBoardSize();
  container.innerHTML = `
    <div class="wc-shell" data-testid="app-shell" data-mode="play">
      <header class="wc-topbar">
        <div class="wc-brand">
          <div class="wc-brand-mark" aria-hidden="true">${icon('crest')}</div>
          <h1 class="wc-brand-title" data-testid="brand-title">Afterplay</h1>
          <span class="wc-screen-title" data-testid="screen-title" aria-hidden="true">Play</span>
        </div>
        <nav class="wc-nav" aria-label="Main" data-testid="main-nav">
          ${NAV_ITEMS.map(
            (item) =>
              `<button type="button" class="wc-nav-item" data-mode="${item.mode}" data-testid="mode-tab-${item.mode}"${
                item.mode === 'play' ? ' aria-current="page"' : ''
              }>${icon(item.icon)}<span class="wc-nav-label">${item.label}</span>${
                item.mode === 'train' ? '<span class="wc-nav-count" data-testid="nav-train-count" hidden></span>' : ''
              }</button>`,
          ).join('')}
        </nav>
        <div class="wc-topbar-actions">
          <button type="button" class="wc-icon-btn" data-testid="btn-settings" aria-label="Settings" aria-haspopup="dialog" title="Settings">${icon('settings')}</button>
        </div>
      </header>

      <main class="wc-main">
        <div id="wc-workspace-host" class="wc-workspace-host">
          <div id="wc-play-root" class="wc-play-root"></div>
        </div>
      </main>
    </div>
  `;

  const shellEl = container.querySelector('.wc-shell') as HTMLElement;
  const devOverlay = new DevOverlayController(shellEl);
  const installGuide = new InstallGuide(shellEl);
  const settings = new SettingsPanel({
    parent: shellEl,
    devOverlay,
    about: {
      crossOriginIsolated: env.crossOriginIsolated,
      hardwareConcurrency: env.hardwareConcurrency,
      schemaVersion: LATEST_SCHEMA_VERSION,
      engineProfile: describeEngineProfile(
        engineProfile,
        caps.multiThreadedSupported ? (engineProfile.live.threads ?? caps.recommendedThreads) : 1,
        engineProfile.live.hashMb ?? caps.recommendedHashMb,
      ),
    },
    onShowInstallGuide: () => {
      settings.close();
      installGuide.open();
    },
  });
  const settingsBtn = container.querySelector('[data-testid="btn-settings"]') as HTMLButtonElement;
  settingsBtn.addEventListener('click', () => settings.open());
  watchOffline((state) => settings.setOfflineStatus(describeOffline(state)));
  mountUpdateBanner(shellEl);
  registerActivity('settings', () => settings.isOpen());
  registerActivity('install-guide', () => installGuide.isOpen());
  if (typeof window !== 'undefined') {
    setTimeout(() => {
      whenIdle(() => {
        void requestPersistentStorage().then((state) =>
          settings.setStorageStatus(describePersistence(state, readInstallEnvironment().standalone)),
        );
      }, 3000);
    }, PERSIST_REQUEST_DELAY_MS);
  }

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

  const workspaceHostEl = container.querySelector('#wc-workspace-host') as HTMLElement;
  const playRootEl = container.querySelector('#wc-play-root') as HTMLElement;
  const analysisRootEl = document.createElement('div');
  analysisRootEl.id = 'wc-analysis-root';
  analysisRootEl.className = 'wc-analysis-root';
  const gamesRootEl = document.createElement('div');
  gamesRootEl.id = 'wc-games-root';
  gamesRootEl.className = 'wc-games-root';
  gamesRootEl.innerHTML = '<p class="wc-games-loading" data-testid="games-loading">Opening the game library…</p>';
  // Where the app opens (story/landing.ts): read here, before the first frame. A #link that names a screen wins.
  let landing: StoryLanding = readLanding();
  const setLanding = (value: StoryLanding): void => {
    landing = value;
    writeLanding(value);
  };
  const requestedAtStart =
    typeof window !== 'undefined' ? modeFromLocation(window.location.search, window.location.hash) : null;
  const startOnStory =
    typeof window !== 'undefined' &&
    (window.location.hash === '#story' || (requestedAtStart === null && landingScreen(landing) !== 'play'));
  let storyView: StoryView | null = null;
  let historyRunning = false;
  // A request cut off because the page is going away is not a failure: the load goes on at the next start
  let pageLeaving = false;
  if (typeof window !== 'undefined') {
    for (const type of ['pagehide', 'beforeunload']) window.addEventListener(type, () => (pageLeaving = true));
  }
  // Train: a hub (Today: what's due) and a session view (the puzzle trainer)
  const trainRootEl = document.createElement('div');
  trainRootEl.id = 'wc-train-root';
  trainRootEl.className = 'wc-train-root';
  trainRootEl.setAttribute('data-testid', 'train-root');
  trainRootEl.innerHTML = `
    <section class="wc-train-hub" data-testid="train-hub" aria-label="Train">
      <div class="wc-train-hub-head">
        <div>
          <h2 class="wc-page-title">Train</h2>
          <p class="wc-page-sub">Puzzles from your own games, spaced reviews and rated puzzles.</p>
        </div>
        <div class="wc-train-start">
          <button type="button" class="wc-btn wc-btn-primary wc-btn-lg" data-testid="btn-train-start">${icon('train')}Start training</button>
          <span class="wc-train-start-detail" data-testid="train-start-detail"></span>
        </div>
      </div>
      <div id="wc-trainer-tiles-root" class="wc-trainer-tiles-root"></div>
      <div id="wc-today-root" class="wc-today-root"><p class="wc-games-loading" data-testid="today-loading">Opening your progress…</p></div>
    </section>
    <section class="wc-train-session" data-testid="train-session" hidden>
      <div class="wc-train-session-bar">
        <button type="button" class="wc-btn wc-btn-ghost wc-btn-sm" data-testid="btn-train-hub">${icon('back')}Train</button>
      </div>
      <div id="wc-puzzles-root" class="wc-puzzles-root"><p class="wc-games-loading" data-testid="puzzles-loading">Loading puzzles…</p></div>
      <div id="wc-repertoire-root" class="wc-trainer-root" data-testid="repertoire-root" hidden><p class="wc-games-loading" data-testid="repertoire-loading">Opening the repertoire trainer…</p></div>
      <div id="wc-endgames-root" class="wc-trainer-root" data-testid="endgames-root" hidden><p class="wc-games-loading" data-testid="endgames-loading">Opening the endgame trainer…</p></div>
      <div id="wc-visualization-root" class="wc-trainer-root" data-testid="visualization-root" hidden><p class="wc-games-loading" data-testid="visualization-loading">Opening the visualization drills…</p></div>
    </section>`;
  const trainHubEl = trainRootEl.querySelector('[data-testid="train-hub"]') as HTMLElement;
  const trainSessionEl = trainRootEl.querySelector('[data-testid="train-session"]') as HTMLElement;
  const todayRootEl = trainRootEl.querySelector('#wc-today-root') as HTMLElement;
  const puzzlesRootEl = trainRootEl.querySelector('#wc-puzzles-root') as HTMLElement;
  const tilesRootEl = trainRootEl.querySelector('#wc-trainer-tiles-root') as HTMLElement;
  const trainerRoots: Record<TrainerKind, HTMLElement> = {
    puzzles: puzzlesRootEl,
    repertoire: trainRootEl.querySelector('#wc-repertoire-root') as HTMLElement,
    endgames: trainRootEl.querySelector('#wc-endgames-root') as HTMLElement,
    visualization: trainRootEl.querySelector('#wc-visualization-root') as HTMLElement,
  };

  // The Games list's library opens in the background; the board doesn't wait for it
  let library: GameLibrary | null = null;
  /** The Games list game on the analysis board, so a review run there is saved with it. */
  let openGameId: string | null = null;
  let openingGame = false;

  // On a phone one engine does everything (engine-profile.ts); on a desktop the bot and the review have their own
  const sharedEngine = createConnectedEngine({ variant: 'auto', ...engineProfile.live });
  const botEngine = engineProfile.singleEngine
    ? sharedEngine
    : new EngineClient({
        variant: 'single-threaded',
        hashMb: engineProfile.bot.hashMb,
      });

  // Every setting in one store: Settings and the New game card write it, every screen follows
  // it. Remembered on this device and mirrored into the database for the JSON backup.
  const appSettings = new AppSettingsStore(loadStoredAppSettings());
  // Who plays here and what the app is called (empty until a preset or Settings › Profile fills it)
  const profile = new ProfileStore();
  const preferences = new Preferences({ appSettings, boardFeel, profile });
  mountAppSettingsSections(settings, appSettings);
  mountBoardFeelSection(settings, SETTINGS_ORDER.boardFeel, SETTINGS_ORDER.board);

  // One synthesizer for every screen, so only one AudioContext is ever built.
  const audio = new CathedralAudio({
    enabled: appSettings.get().sound,
    volume: appSettings.get().volume / 100,
  });

  const playController = new PlayController({
    container: playRootEl,
    engine: sharedEngine,
    botEngine,
    devOverlay,
    audio,
    settings: appSettings,
    profile,
    onAnalyzeGame: () => {
      setMode('review', true);
      analysisController.showTab('analysis');
    },
    onReviewGame: () => {
      setMode('review', true);
      analysisController.showTab('review');
      void reviewPanel.start();
    },
    // Every finished game joins the library (waits for it to open)
    onGameFinished: (game) => {
      void libraryReady.then((api) => api.library.savePlayedGame(game)).catch(() => undefined);
    },
  });
  registerActivity('game', () => playController.isGameInProgress());

  // The first-run link (/start/<slug>/, preset/first-run.ts): its preset is applied once on this device, then its
  // welcome message is shown. In Safari on an iPhone (not the Home Screen app) the Add to Home Screen guide comes
  // first, without the welcome: the Home Screen app has its own storage and shows the welcome on its first launch, so
  // it would otherwise be read twice. "Continue in Safari" on the guide shows the welcome there instead. Without a
  // link (or on every later launch) only the guide's own first-visit rule applies.
  const startSlug = typeof window !== 'undefined' ? startSlugFromPath(window.location.pathname) : null;
  let firstRun = loadFirstRunState();
  let guideAfterWelcome = false;
  const brandTitleEl = container.querySelector('[data-testid="brand-title"]') as HTMLElement;
  const applyIdentity = (p: Profile): void => {
    const name = p.appName || DEFAULT_APP_NAME;
    if (brandTitleEl.textContent !== name) brandTitleEl.textContent = name;
    installGuide.setAppName(name);
    // The link's own manifest only once its preset is applied here: an unknown link has none
    applyAppIdentity(document, p.appName, startSlug !== null && firstRun.slug === startSlug ? startSlug : null);
  };
  const welcomeSheet = new WelcomeSheet(shellEl, () => {
    if (firstRun.slug && !firstRun.welcomeSeen) {
      firstRun = { ...firstRun, welcomeSeen: true };
      saveFirstRunState(firstRun);
    }
    if (guideAfterWelcome) {
      guideAfterWelcome = false;
      installGuide.openIfFirstRun();
    }
  });
  registerActivity('welcome', () => welcomeSheet.isOpen());
  const showNotice = mountNotice(shellEl);
  mountProfileSection(settings, profile, () => {
    const welcome = profile.get().welcome;
    if (!welcome) return;
    settings.close();
    welcomeSheet.show(welcome);
  });
  profile.subscribe(applyIdentity);
  applyIdentity(profile.get());

  const applyPreset = (slug: string, preset: Preset): Promise<void> => {
    appSettings.set(preset.settings);
    // What the preset names replaces what was there; what it leaves out stays
    profile.set({
      ...(preset.displayName ? { displayName: preset.displayName } : {}),
      ...(preset.title ? { title: preset.title } : {}),
      ...(preset.appName ? { appName: preset.appName } : {}),
      ...(preset.bots.length > 0 ? { bots: preset.bots } : {}),
      ...(preset.welcome ? { welcome: welcomeWithAppName(preset.welcome, preset.appName) } : {}),
    });
    firstRun = { slug, welcomeSeen: false };
    saveFirstRunState(firstRun);
    applyIdentity(profile.get());
    // The board waiting at the start position takes the preset's bot and time control
    playController.adoptPendingChoices();
    const usernames = preset.usernames;
    if (!usernames) return Promise.resolve();
    return libraryReady
      .then(async (api) => {
        const mine = api.library.getMyAccounts();
        await api.library.setMyAccounts({
          lichess: usernames.lichess || mine?.lichess || '',
          chesscom: usernames.chesscom || mine?.chesscom || '',
        });
        await api.gamesList.refresh();
      })
      .catch(() => undefined);
  };
  /** The welcome message if one is waiting (after the guide in iPhone Safari), otherwise the guide's own rule. */
  const showWelcomeOrGuide = (): void => {
    const welcome = profile.get().welcome;
    if (welcome && firstRun.slug && !firstRun.welcomeSeen) {
      const showWelcome = (): void => {
        guideAfterWelcome = true;
        welcomeSheet.show(welcome);
      };
      if (!installGuide.openForFirstRunLink(showWelcome)) showWelcome();
    } else {
      installGuide.openIfFirstRun();
    }
  };
  if (typeof window !== 'undefined') {
    shellEl.dataset.firstRun = startSlug === null ? 'none' : startSlug === firstRun.slug ? 'already' : 'loading';
    if (startSlug !== null && startSlug !== firstRun.slug) {
      const opened = performance.now();
      void loadFirstRunPreset({ pathname: window.location.pathname, appliedSlug: firstRun.slug }).then((result) => {
        // The link's game history (if it has one) loads once the preset is applied, with no press
        if (result.kind === 'loaded')
          void applyPreset(result.slug, result.preset).then(() => runHistoryLoad(result.slug));
        else if (result.kind === 'failed') showNotice(result.message);
        shellEl.dataset.firstRun = result.kind === 'loaded' ? 'applied' : result.kind;
        setTimeout(showWelcomeOrGuide, Math.max(0, INSTALL_GUIDE_DELAY_MS - (performance.now() - opened)));
      });
    } else {
      setTimeout(showWelcomeOrGuide, INSTALL_GUIDE_DELAY_MS);
    }
  }

  // On a desktop the review runs on its own engine, so live analysis keeps its worker while a review runs (created on
  // the first review). On a phone it shares the one engine, and a review started on the board pauses live analysis.
  let reviewEngine: EngineClient | null = null;
  let reviewThreads = engineProfile.review.threads;
  const getReviewEngine = (): EngineClient => {
    if (engineProfile.singleEngine) return sharedEngine;
    reviewEngine ??= createConnectedEngine({
      variant: 'auto',
      threads: reviewThreads,
      hashMb: engineProfile.review.hashMb,
    });
    return reviewEngine;
  };

  // The Review screen's controller and panel (a second board and a lot of DOM, hidden at start) are built
  // the first time anything touches them (a click on Review, a #review link, a test hook) or in an idle
  // moment after start-up, whichever comes first. Building them with everything else made the mount task
  // about 15-25 ms longer, and no task may run over 50 ms.
  const reviewStack = lazy(() => {
    const analysis = new AnalysisController({
      container: analysisRootEl,
      engine: sharedEngine,
      threatEngine: botEngine,
      audio,
      initialActive: false,
      settings: appSettings,
    });

    const review = new ReviewPanel(analysis.getReviewMount(), {
      initialPreset: appSettings.get().reviewPreset,
      onPresetChange: (preset) => appSettings.set({ reviewPreset: preset }),
      host: {
        getGameTree: () => analysis.getGameTree(),
        getCurrentNode: () => analysis.getGameTree().currentNode,
        goToNode: (nodeId) => {
          analysis.goToNode(nodeId);
        },
        setOrientation: (color) => analysis.setOrientation(color),
        importPgn: (pgn) => analysis.importPgn(pgn),
        importPgnFromStart: (pgn) => analysis.importPgnFromStart(pgn),
        addLine: (fromNodeId, ucis, options) => analysis.addLine(fromNodeId, ucis, options),
        deleteNode: (nodeId) => analysis.deleteNode(nodeId),
        stripEngineAnnotations: () => analysis.stripEngineAnnotations(),
        applyReview: (entries, rerender) => analysis.applyReview(entries, rerender),
        showPgnText: (pgn, status) => analysis.showPgnText(pgn, status),
        setMoveInterceptor: (fn) => analysis.setMoveInterceptor(fn),
        onNavigate: (listener) => analysis.onNavigate(listener),
        onTreeReplaced: (listener) => analysis.onTreeReplaced(listener),
      },
      getEngine: getReviewEngine,
      isBookPosition: (fen) => lookupOpeningByFen(fen) !== null,
      getAccounts: () => library?.getUserAccounts() ?? DEFAULT_USER_ACCOUNTS,
      // The repertoire the game was played from, to say where it was left
      findRepertoireDeparture: async (tree, color) => {
        const store = (await drillsReady).store;
        return findDeparture(await store.repertoire.load(color), tree);
      },
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
      ...(engineProfile.singleEngine
        ? {
            onRunningChange: (running: boolean) => analysis.setLivePaused(running ? REVIEW_PAUSES_ANALYSIS_NOTE : null),
          }
        : {}),
      onPlayVsBot: (fen) => {
        const turn = fen.trim().split(/\s+/)[1] === 'b' ? 'b' : 'w';
        setMode('play', false);
        playController.requestNewGame({ fen, playerColor: turn });
      },
    });
    analysis.onTreeReplaced(() => {
      if (!openingGame) openGameId = null;
    });
    registerActivity('review', () => review.getState() === 'running');
    return { analysis, review };
  });
  const analysisController = lazyProxy(() => reviewStack.get().analysis);
  const reviewPanel = lazyProxy(() => reviewStack.get().review);
  if (typeof window !== 'undefined') {
    setTimeout(() => whenIdle(() => void reviewStack.get(), 3000), REVIEW_STACK_WARMUP_DELAY_MS);
  }

  // The browser's audio stack starts cold: the first AudioContext of a browser process blocks the main
  // thread for 160-340 ms (measured; latencyHint and sampleRate make no difference) and the page cannot
  // avoid it. Pay it in an idle moment soon after start-up, when no input is waiting, rather than on the
  // first pointer movement, where it hit a user reaching for the board. Sound still starts on the first
  // gesture (init() resumes the suspended context), and a gesture before this runs builds it then.
  if (typeof window !== 'undefined') {
    setTimeout(() => {
      // (with sound off nothing is built; turning it on later builds it on the first gesture)
      if (appSettings.get().sound) whenIdle(() => audio.prewarm(), 2000);
    }, AUDIO_PREWARM_DELAY_MS);
  }

  let currentMode: AppWorkspaceMode = 'play';
  let trainView: TrainView = 'hub';
  let trainSession: TrainerKind | null = null;
  const navButtons = [...container.querySelectorAll<HTMLButtonElement>('.wc-nav-item')];
  const screenTitleEl = container.querySelector('[data-testid="screen-title"]') as HTMLElement;
  const trainCountEl = container.querySelector('[data-testid="nav-train-count"]') as HTMLElement;
  const trainStartDetailEl = trainRootEl.querySelector('[data-testid="train-start-detail"]') as HTMLElement;
  let gamesList: GamesList | null = null;
  let insightsView: InsightsView | null = null;
  let gamesTabs: Tabs | null = null;
  let todayScreen: TodayScreen | null = null;
  let trainerTiles: TrainerTiles | null = null;
  let drills: DrillStore | null = null;
  let puzzleTrainer: PuzzleTrainer | null = null;
  let repertoireTrainer: RepertoireTrainer | null = null;
  let endgameTrainer: EndgameTrainer | null = null;
  let visualizationTrainer: VisualizationTrainer | null = null;
  /** Puzzle storage opens with the game library; Train waits for it. */
  let resolvePuzzles!: (api: WizardChessPuzzlesApi) => void;
  let rejectPuzzles!: (err: unknown) => void;
  const puzzlesReady = new Promise<WizardChessPuzzlesApi>((resolve, reject) => {
    resolvePuzzles = resolve;
    rejectPuzzles = reject;
  });
  puzzlesReady.catch(() => undefined);
  /** The trainers' storage opens with the game library too. */
  let resolveDrills!: (api: WizardChessDrillsApi) => void;
  let rejectDrills!: (err: unknown) => void;
  const drillsReady = new Promise<WizardChessDrillsApi>((resolve, reject) => {
    resolveDrills = resolve;
    rejectDrills = reject;
  });
  drillsReady.catch(() => undefined);
  /** The trainer chunk, imported the first time a puzzle session starts. */
  let trainerLoading: Promise<PuzzleTrainer> | null = null;
  /** Serializes session starts, so the latest request wins and none interleave. */
  let puzzleStart: Promise<unknown> = Promise.resolve();

  /** Where "Start training" goes: what has the most to do, puzzles first, then the other trainers' due cards. */
  type StartTarget = { trainer: 'puzzles'; mode: PuzzleMode } | { trainer: Exclude<TrainerKind, 'puzzles'> };
  interface TrainingPlan {
    target: StartTarget;
    /** What the button says it will open. */
    detail: string;
    /** Everything waiting across the trainers (the count on the Train tab). */
    waiting: number;
  }
  const planTraining = async (): Promise<TrainingPlan | null> => {
    let api: WizardChessPuzzlesApi;
    try {
      api = await puzzlesReady;
    } catch {
      return null;
    }
    if (!drills) return null;
    const [today, rating, summary] = await Promise.all([
      api.store.todaySummary(),
      api.store.getRating(),
      drills.summary(),
    ]);
    const due = today.dueReviews.personal + today.dueReviews.lichess;
    const repertoire = summary.repertoire.due + summary.repertoire.fresh;
    const waiting = due + today.newPersonal + repertoire + summary.endgame.due + summary.visualization.due;
    const s = (n: number) => (n === 1 ? '' : 's');
    if (due > 0)
      return { target: { trainer: 'puzzles', mode: 'review' }, detail: `Your ${due} due review${s(due)}`, waiting };
    if (repertoire > 0) {
      return {
        target: { trainer: 'repertoire' },
        detail: `Your ${repertoire} repertoire position${s(repertoire)}`,
        waiting,
      };
    }
    if (summary.endgame.due > 0) {
      return {
        target: { trainer: 'endgames' },
        detail: `Your ${summary.endgame.due} due endgame drill${s(summary.endgame.due)}`,
        waiting,
      };
    }
    if (summary.visualization.due > 0) {
      return {
        target: { trainer: 'visualization' },
        detail: `Your ${summary.visualization.due} due visualization drill${s(summary.visualization.due)}`,
        waiting,
      };
    }
    if (today.newPersonal > 0) {
      return {
        target: { trainer: 'puzzles', mode: 'mistakes' },
        detail: `${today.newPersonal} new puzzle${s(today.newPersonal)} from your games`,
        waiting,
      };
    }
    return {
      target: { trainer: 'puzzles', mode: 'rated' },
      detail: `Rated puzzles near ${Math.round(rating.rating)}`,
      waiting,
    };
  };

  /** How much Train has waiting (reviews due, new puzzles and positions, due drills), on its tab. */
  const refreshTrainCount = async (): Promise<void> => {
    const plan = await planTraining();
    if (!plan) return;
    const waiting = plan.waiting;
    trainCountEl.textContent = waiting === 0 ? '' : waiting > 99 ? '99+' : String(waiting);
    trainCountEl.hidden = waiting === 0;
    trainCountEl.setAttribute('aria-label', `${waiting} waiting`);
    trainStartDetailEl.textContent = plan.detail;
  };

  /** Stops whatever a trainer is doing when its screen goes away (a drill started and left is not recorded). */
  const suspendTrainers = (): void => {
    repertoireTrainer?.suspend();
    endgameTrainer?.suspend();
    visualizationTrainer?.suspend();
  };

  const showTrainView = (view: TrainView, kind: TrainerKind | null = null): void => {
    trainView = view;
    trainSession = view === 'session' ? kind : null;
    trainHubEl.hidden = view !== 'hub';
    trainSessionEl.hidden = view !== 'session';
    for (const [k, el] of Object.entries(trainerRoots)) el.hidden = view !== 'session' || k !== kind;
    if (view === 'hub') {
      suspendTrainers();
      void todayScreen?.refresh();
      void trainerTiles?.refresh();
      void refreshTrainCount();
    }
  };

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
    shellEl.setAttribute('data-mode', mode);
    if (mode !== 'train') suspendTrainers();

    for (const btn of navButtons) {
      if (btn.dataset.mode === mode) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    }
    screenTitleEl.textContent = NAV_ITEMS.find((n) => n.mode === mode)?.label ?? '';

    if (mode === 'review') {
      workspaceHostEl.replaceChildren(analysisRootEl);
      analysisController.setActive(true);
    } else {
      // (a Review screen that was never built is inactive already)
      if (reviewStack.created()) analysisController.setActive(false);
      const roots: Record<Exclude<AppWorkspaceMode, 'review'>, HTMLElement> = {
        play: playRootEl,
        games: gamesRootEl,
        train: trainRootEl,
      };
      workspaceHostEl.replaceChildren(roots[mode]);
      if (mode === 'games') {
        void gamesList?.refresh();
        if (gamesTabs?.getSelected() === 'insights') void insightsView?.refresh();
      }
      if (mode === 'train' && trainView === 'hub') {
        void todayScreen?.refresh();
        void trainerTiles?.refresh();
        void refreshTrainCount();
      }
    }
  };

  /**
   * The puzzle trainer is its own chunk, imported the first time a session starts; its
   * dataset worker (the 20,000 bundled puzzles) starts then too. Neither is in the main bundle.
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
          setMode('review', false);
          if (!analysisController.importPgn(pgn)) return;
          analysisController.showTab('analysis');
          const node = analysisController.getGameTree().getMainLine()[ply - 1];
          if (node) analysisController.goToNode(node.id);
        },
        onOpenGames: () => setMode('games', false),
      });
      applyAppSettings(appSettings.get(), null);
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
   * Starts a puzzle session in Train. With no session given, the one with the most to do
   * (due reviews, then my mistakes, then rated puzzles).
   */
  const openPuzzles = (mode: PuzzleMode | null): Promise<PuzzleTrainer> => {
    setMode('train', false);
    showTrainView('session', 'puzzles');
    const run = puzzleStart.then(async () => {
      const trainer = await loadTrainer();
      if (mode) {
        await trainer.start(mode);
      } else {
        const today = await (await puzzlesReady).store.todaySummary();
        const due = today.dueReviews.personal + today.dueReviews.lichess;
        await trainer.start(due > 0 ? 'review' : today.newPersonal > 0 ? 'mistakes' : 'rated');
      }
      return trainer;
    });
    puzzleStart = run.catch(() => undefined);
    return run;
  };

  /** My games for guess the move: each with my side, and its review's best moves read only when it is chosen. */
  const getGuessGames = async (): Promise<GuessGame[]> => {
    const lib = library;
    if (!lib) return [];
    const accounts = lib.getUserAccounts();
    const out: GuessGame[] = [];
    for (const record of await lib.list()) {
      const color = myColor(record, accounts);
      if (!color) continue;
      const opponent = color === 'w' ? record.black : record.white;
      const me = color === 'w' ? record.white : record.black;
      out.push({
        id: record.id,
        label: [`${me} vs ${opponent}`, record.date ? record.date.replace(/\./g, '-') : null]
          .filter(Boolean)
          .join(' · '),
        pgn: record.pgn,
        color,
        loadBestMoves: async () => {
          const best = new Map<number, string>();
          const saved = record.analysis ? await lib.getReview(record.id) : undefined;
          for (const m of saved?.review.moves ?? []) if (m.bestMoveUci) best.set(m.ply, m.bestMoveUci);
          return best;
        },
      });
    }
    return out;
  };

  /** Creates a trainer in its own chunk the first time it is opened; its loading line stands in until then. */
  function lazyTrainer<T>(
    kind: Exclude<TrainerKind, 'puzzles'>,
    label: string,
    make: () => Promise<T>,
  ): () => Promise<T> {
    let loading: Promise<T> | null = null;
    return () => {
      if (!loading) {
        loading = Promise.all([puzzlesReady, make()]).then(([, trainer]) => {
          trainerRoots[kind].querySelector('.wc-games-loading')?.remove();
          applyAppSettings(appSettings.get(), null);
          return trainer;
        });
        loading.catch((err: unknown) => {
          loading = null;
          const msg = document.createElement('p');
          msg.className = 'wc-games-loading';
          msg.setAttribute('data-testid', `${kind}-loading`);
          msg.textContent = `${label} could not be opened: ${err instanceof Error ? err.message : String(err)}`;
          trainerRoots[kind].replaceChildren(msg);
        });
      }
      return loading;
    };
  }
  const loadRepertoire = lazyTrainer('repertoire', 'The repertoire trainer', () =>
    import('./trainers/repertoire-trainer').then((mod) => {
      trainerRoots.repertoire.replaceChildren();
      repertoireTrainer = new mod.RepertoireTrainer({
        container: trainerRoots.repertoire,
        store: drills!.repertoire,
        audio,
      });
      return repertoireTrainer;
    }),
  );
  const loadEndgames = lazyTrainer('endgames', 'The endgame trainer', () =>
    Promise.all([import('./trainers/endgame-trainer'), import('./trainers/endgame-tables-client')]).then(
      ([mod, tables]) => {
        trainerRoots.endgames.replaceChildren();
        endgameTrainer = new mod.EndgameTrainer({
          container: trainerRoots.endgames,
          store: drills!.endgames,
          engine: sharedEngine,
          defender: new tables.EndgameTablesClient(),
          audio,
        });
        return endgameTrainer;
      },
    ),
  );
  const loadVisualization = lazyTrainer('visualization', 'The visualization drills', () =>
    import('./trainers/visualization-trainer').then((mod) => {
      trainerRoots.visualization.replaceChildren();
      visualizationTrainer = new mod.VisualizationTrainer({
        container: trainerRoots.visualization,
        store: drills!.visualization,
        audio,
        getGames: getGuessGames,
        onOpenGames: () => setMode('games', false),
      });
      return visualizationTrainer;
    }),
  );
  const openRepertoire = async (): Promise<RepertoireTrainer> => {
    setMode('train', false);
    showTrainView('session', 'repertoire');
    const trainer = await loadRepertoire();
    await trainer.ready();
    return trainer;
  };
  const openEndgames = async (): Promise<EndgameTrainer> => {
    setMode('train', false);
    showTrainView('session', 'endgames');
    const trainer = await loadEndgames();
    if (!trainer.getEntry()) await trainer.start();
    return trainer;
  };
  const openVisualization = async (): Promise<VisualizationTrainer> => {
    setMode('train', false);
    showTrainView('session', 'visualization');
    return loadVisualization();
  };
  /** A Today card or Start training: the trainer opens on what is due in it. */
  const startDrill = async (kind: DrillKind): Promise<void> => {
    if (kind === 'repertoire') await (await openRepertoire()).openDue();
    else if (kind === 'endgame') await (await openEndgames()).openDue();
    else await (await openVisualization()).openDue();
  };
  const startTraining = async (): Promise<void> => {
    const plan = await planTraining();
    if (!plan) return;
    const target = plan.target;
    if (target.trainer === 'puzzles') await openPuzzles(target.mode);
    else await startDrill(target.trainer === 'endgames' ? 'endgame' : target.trainer);
  };
  const openTrainer = async (kind: TrainerKind): Promise<void> => {
    if (kind === 'puzzles') await openPuzzles(null);
    else if (kind === 'repertoire') await openRepertoire();
    else if (kind === 'endgames') await openEndgames();
    else await openVisualization();
  };

  for (const btn of navButtons) {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode as AppWorkspaceMode;
      // Train again while in a session goes back to its hub
      if (mode === 'train' && currentMode === 'train' && trainView === 'session') {
        showTrainView('hub');
        return;
      }
      setMode(mode, false);
      // Keep the address in step, so a reload or a shared link opens the same place
      if (modeFromLocation('', window.location.hash) !== mode) {
        history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}#${mode}`);
      }
    });
  }
  trainRootEl.querySelector('[data-testid="btn-train-start"]')?.addEventListener('click', () => void startTraining());
  trainRootEl.querySelector('[data-testid="btn-train-hub"]')?.addEventListener('click', () => showTrainView('hub'));

  /** Opens a Games list game on the analysis board, with its saved review if it has one. */
  const openLibraryGame = async (record: StoredGameRecord): Promise<boolean> => {
    if (!library) return false;
    const saved = record.analysis ? await library.getReview(record.id) : undefined;
    setMode('review', false);
    openingGame = true;
    const ok = analysisController.importPgn(record.pgn);
    openingGame = false;
    if (!ok) return false;
    openGameId = record.id;
    analysisController.goToNode(analysisController.getGameTree().root.id);
    if (saved) reviewPanel.showSavedReview(saved);
    analysisController.showTab('review');
    return true;
  };

  let resolveStorage!: (storage: WizardChessStorage) => void;
  const storageReady = new Promise<WizardChessStorage>((resolve) => {
    resolveStorage = resolve;
  });
  /** Brings every screen's data up to date after a restore. */
  let afterRestore: () => Promise<void> = async () => undefined;
  /** Brings Train up to date after a sync added games (the Games list follows the library by itself). */
  let afterSync: () => Promise<void> = async () => undefined;
  const dataSection = mountDataSection({
    panel: settings,
    order: SETTINGS_ORDER.data,
    getBackend: () => storageReady,
    beforeBackup: () => preferences.mirrorNow(),
    applyPreferences: (snapshot) => preferences.apply(snapshot),
    afterRestore: () => afterRestore(),
    // The app's one use of the network: only from the sync button, only Chess.com's public archive API
    runSync: async (onProgress, signal) => {
      const api = await libraryReady;
      const result = await runChessComSync({
        username: api.library.getMyAccounts()?.chesscom ?? '',
        fetchImpl: browserFetch,
        sleep: (ms) => abortableSleep(ms, signal),
        now: () => Date.now(),
        store: librarySyncStore(api.library),
        isOnline: () => navigator.onLine !== false,
        signal,
        onProgress,
        isAutoAnalyzeOn: () => api.gamesList.isAutoAnalyzeOn(),
        queueReviews: (ids) => api.gamesList.queueAutoReviews(ids),
      });
      if (result.added.length > 0) await afterSync();
      return describeSyncResult(result);
    },
  });
  registerActivity('chesscom-sync', () => dataSection.isSyncRunning());

  const libraryReady: Promise<WizardChessLibraryApi> = WizardChessStorage.create().then(async (storage) => {
    const lib = new GameLibrary(storage);
    await lib.init();
    library = lib;
    resolveStorage(storage);
    await preferences.attach(storage);
    const queue = new ReviewQueue({
      library: lib,
      getEngine: getReviewEngine,
      isBookPosition: (fen) => lookupOpeningByFen(fen) !== null,
    });
    registerActivity('background-review', () => queue.pending().length > 0);
    const bridge = new ExtensionBridgeClient(window as unknown as MessageWindow, {
      saveGames: (games) => lib.saveBridgeGames(games),
      setAccounts: (accounts) => lib.setMyAccounts(accounts),
    });
    const initialGamesTab = startOnStory ? 'story' : 'library';
    gamesRootEl.innerHTML = `
      <div class="wc-games-tabs">${tabListHtml(
        'games',
        [
          { id: 'library', label: 'Library' },
          { id: 'insights', label: 'Insights' },
          { id: 'story', label: 'Story' },
        ],
        initialGamesTab,
        'Games views',
      )}</div>
      <div class="wc-games-pane" ${tabPanelAttrs('games', 'library', initialGamesTab)}></div>
      <div class="wc-games-pane" ${tabPanelAttrs('games', 'insights', initialGamesTab)}></div>
      <div class="wc-games-pane" ${tabPanelAttrs('games', 'story', initialGamesTab)}></div>`;
    const libraryPane = gamesRootEl.querySelector('[data-tab-panel="library"]') as HTMLElement;
    const insightsPane = gamesRootEl.querySelector('[data-tab-panel="insights"]') as HTMLElement;
    const storyPane = gamesRootEl.querySelector('[data-tab-panel="story"]') as HTMLElement;
    gamesTabs = new Tabs(gamesRootEl, (id) => {
      if (id === 'insights') void insightsView?.refresh();
      if (id === 'story') storyView?.shown();
    });
    // "Seen": the first time the Story is on screen with a finished import (it then opens Play on later launches)
    const markSeenIfDue = (finished: boolean): void => {
      if (!finished || landing !== 'ready') return;
      if (currentMode !== 'games' || gamesTabs?.getSelected() !== 'story' || document.visibilityState === 'hidden') {
        return;
      }
      setLanding('seen');
    };
    const story = new StoryView({
      container: storyPane,
      library: lib,
      getLanding: () => landing,
      onSkip: () => {
        setLanding('skipped');
        setMode('play', false);
        if (window.location.hash === '#story') {
          history.replaceState(null, '', window.location.pathname + window.location.search);
        }
      },
      onContinue: () => {
        void readImportRecord(lib).then((rec) => runHistoryLoad(rec.file.slug || firstRun.slug));
      },
      onRendered: markSeenIfDue,
    });
    storyView = story;
    void story.recount();
    // A load that stopped part-way (or was cut off by closing the app) is offered again
    void readImportRecord(lib).then((rec) => {
      if (rec.file.status !== 'partial' || historyRunning) return;
      // Cut off by a reload or by closing the app (a first visit reloads once when the worker takes over): go on by
      // itself. A load that reported a failure waits for Continue.
      if (rec.file.interrupted && rec.file.slug) void runHistoryLoad(rec.file.slug);
      else {
        story.setLoad({
          kind: 'paused',
          loaded: rec.file.loaded,
          total: rec.file.total,
          message: rec.file.failure || 'The load stopped before it finished.',
        });
      }
    });
    const list = new GamesList({
      container: libraryPane,
      library: lib,
      queue,
      onOpen: (record) => void openLibraryGame(record),
      getExtensionStatus: () => bridge.getStatus(),
      onExtensionStatus: (listener) => bridge.onStatus(listener),
    });
    gamesList = list;
    const insightPuzzleStore = new PuzzleStore(storage);
    insightsView = new InsightsView({
      container: insightsPane,
      library: lib,
      getPuzzleRating: () => insightPuzzleStore.getRating(),
      onOpenPosition: (gameId, ply) => {
        void lib.get(gameId).then(async (record) => {
          if (!record || !(await openLibraryGame(record))) return;
          const node = analysisController.getGameTree().getMainLine()[ply - 1];
          if (node) analysisController.goToNode(node.id);
        });
      },
      onOpenGames: (filter) => {
        gamesTabs?.select('library');
        list.setFilter(filter);
      },
      onOpenPuzzle: (id) => {
        void openPuzzles('rated').then((trainer) => trainer.openPuzzle(id, 'lichess'));
      },
    });
    lib.onChange(() => {
      if (currentMode === 'games' && gamesTabs?.getSelected() === 'insights') void insightsView?.refresh();
    });
    mountGamesSettings(settings, lib, list);
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
    // Every attempt, review and new puzzle updates what's waiting on the Train tab
    puzzleStore.onChange(() => void refreshTrainCount());
    // The repertoire, endgame and visualization trainers keep their cards in the same database
    const drillStore = new DrillStore(storage);
    drills = drillStore;
    drillStore.onChange(() => void refreshTrainCount());
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
          if (currentMode === 'train' && trainView === 'hub') await todayScreen?.refresh();
          void refreshTrainCount();
        })();
      }
    });
    todayRootEl.replaceChildren();
    const today = new TodayScreen({
      container: todayRootEl,
      store: puzzleStore,
      syncPersonal,
      countUnanalyzed: async () => (await lib.list()).filter((g) => !g.analysis).length,
      drills: drillStore,
      onStartPuzzles: (mode) => void openPuzzles(mode),
      onStartDrill: (kind) => void startDrill(kind),
      onOpenGames: () => setMode('games', false),
    });
    todayScreen = today;
    tilesRootEl.replaceChildren();
    const tiles = new TrainerTiles({
      container: tilesRootEl,
      puzzles: puzzleStore,
      drills: drillStore,
      onOpen: (kind) => void openTrainer(kind),
    });
    trainerTiles = tiles;
    // The tiles and Today follow what the trainers record while the hub is showing
    const refreshHub = () => {
      if (currentMode === 'train' && trainView === 'hub') {
        void tiles.refresh();
        void today.refresh();
      }
    };
    drillStore.onChange(refreshHub);
    const puzzlesApi: WizardChessPuzzlesApi = {
      store: puzzleStore,
      today,
      getTrainView: () => trainView,
      open: (mode) => openPuzzles(mode),
      getTrainer: () => puzzleTrainer,
      syncPersonal,
    };
    window.__wizardChessPuzzles = puzzlesApi;
    const drillsApi: WizardChessDrillsApi = {
      store: drillStore,
      tiles,
      getTrainSession: () => trainSession,
      openRepertoire,
      openEndgames,
      openVisualization,
      getRepertoire: () => repertoireTrainer,
      getEndgames: () => endgameTrainer,
      getVisualization: () => visualizationTrainer,
    };
    window.__wizardChessDrills = drillsApi;
    resolveDrills(drillsApi);
    resolvePuzzles(puzzlesApi);
    afterRestore = async () => {
      await lib.init();
      await lib.reloadAccounts();
      await list.syncAutoAnalyze();
      await list.refresh();
      void insightsView?.refresh();
      // The repertoires and drill cards may have come from the backup
      drillStore.repertoire.reload();
      await syncPersonal();
      await today.refresh();
      await tiles.refresh();
      await refreshTrainCount();
    };
    afterSync = async () => {
      if (currentMode === 'train' && trainView === 'hub') await today.refresh();
      await refreshTrainCount();
    };
    if (currentMode === 'train' && trainView === 'hub') {
      void today.refresh();
      void tiles.refresh();
    }
    void refreshTrainCount();
    return api;
  });
  publishReady('__wizardChessPuzzlesReady', puzzlesReady);
  publishReady('__wizardChessDrillsReady', drillsReady);
  libraryReady.catch((err: unknown) => {
    rejectPuzzles(err);
    rejectDrills(err);
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
  publishReady('__wizardChessLibraryReady', libraryReady);

  // The link's game history (preset/first-run.ts fetches it, story/history-loader.ts stores it): batches of 200 that
  // never overwrite, so a load that stopped continues where it was. A link with no history file changes nothing.
  const runHistoryLoad = async (slug: string): Promise<void> => {
    if (historyRunning) return;
    historyRunning = true;
    try {
      const { library: lib } = await libraryReady;
      const view = storyView;
      const prior = (await readImportRecord(lib)).file;
      const same = prior.slug === slug;
      const loaded = same ? prior.loaded : 0;
      const total = same ? prior.total : 0;
      const write = (status: 'running' | 'partial' | 'never', failure = ''): Promise<void> =>
        lib.writeSetting(STORY_IMPORT_SETTING, { version: 1, file: { status, loaded, total, slug, failure } });
      // Marked before the request: a reload that cuts the request off (a first visit reloads once when the worker
      // takes over) is found at the next start and goes on by itself
      await write('running');
      const result = await loadHistoryFile({ slug });
      if (result.kind === 'none') {
        await write('never');
        view?.setLoad({ kind: 'idle' });
        return;
      }
      if (result.kind === 'failed' && pageLeaving) return;
      if (landing === 'new') setLanding('importing');
      if (result.kind === 'failed') {
        await write('partial', result.message);
        view?.setLoad({ kind: 'paused', loaded, total, message: result.message });
        return;
      }
      view?.setLoad({ kind: 'loading', loaded: 0, total: result.games.length });
      const { state } = await storeHistory({
        slug,
        games: result.games,
        monthRecord: result.monthRecord,
        store: lib,
        onProgress: (done, all) => view?.setLoad({ kind: 'loading', loaded: done, total: all }),
        onBatch: () => view?.scheduleRecount(),
      });
      if (state.status === 'done') {
        if (landing === 'importing') setLanding('ready');
        view?.setLoad({ kind: 'idle' });
      } else {
        view?.setLoad({ kind: 'paused', loaded: state.loaded, total: state.total, message: state.failure });
      }
      await view?.recount();
    } catch {
      // libraryReady failed: the games screen already says so
    } finally {
      historyRunning = false;
    }
  };

  /** Board look, effects and sound follow the settings (Play and Review follow them themselves). */
  const applyAppSettings = (next: AppSettings, prev: AppSettings | null): void => {
    const boards = [
      puzzleTrainer?.getBoard(),
      repertoireTrainer?.getBoard(),
      endgameTrainer?.getBoard(),
      visualizationTrainer?.getBoard(),
    ];
    for (const board of boards) {
      if (!board) continue;
      if (!prev || next.boardTheme !== prev.boardTheme) board.setBoardTheme(next.boardTheme);
      if (!prev || next.pieceSet !== prev.pieceSet) board.setPieceSet(next.pieceSet);
      if (!prev || next.captureEffects !== prev.captureEffects) board.setCaptureEffectsEnabled(next.captureEffects);
    }
    if (!prev || next.sound !== prev.sound) audio.setEnabled(next.sound);
    if (!prev || next.volume !== prev.volume) audio.setVolume(next.volume / 100);
    if (prev && next.analysisLines !== prev.analysisLines) analysisController.setMultiPv(next.analysisLines);
    if (prev && next.reviewPreset !== prev.reviewPreset && reviewPanel.getPreset() !== next.reviewPreset)
      reviewPanel.setPreset(next.reviewPreset);
  };
  applyAppSettings(appSettings.get(), null);
  appSettings.subscribe(applyAppSettings);

  if (typeof window !== 'undefined') {
    const requested = modeFromLocation(window.location.search, window.location.hash);
    if (requested) setMode(requested, false);
    else if (landingScreen(landing) !== 'play') setMode('games', false);
    // A typed or followed #link switches destination without a reload
    window.addEventListener('hashchange', () => {
      const mode = modeFromLocation('', window.location.hash);
      if (mode) setMode(mode, false);
      if (window.location.hash === '#story') gamesTabs?.select('story');
    });
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
      switchToAnalysis: (copyPlayGame = false) => setMode('review', copyPlayGame),
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

  // Global keyboard shortcut for Play Mode: 'f' / 'F' flips the play board when not typing in an input
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
      if (currentMode !== 'play') return;
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
      if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.altKey && !e.metaKey) {
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
