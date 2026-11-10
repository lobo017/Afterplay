import { OPENINGS_BY_EPD } from '../analysis/opening-lookup';
import type { GameTree } from '../core/game-tree';
import { announce } from '../ui/announcer';
import { parsePgn } from '../core/pgn';
import { RulesAdapter, type Color, type ExecutedMove, type MoveInput, type Piece, type Square } from '../core/rules';
import { SAMPLE_GAME_PGN } from '../review/sample-game';
import { CathedralAudio } from '../render/audio';
import type { BoardRenderer } from '../render/board-renderer';
import { segmentedHtml } from '../ui/components/controls';
import { Tabs, tabListHtml, tabPanelAttrs } from '../ui/components/tabs';
import { formatDueIn } from './today-screen';
import { moveInputToUci } from './puzzle-format';
import { gradeCoordinates, gradeGuess } from './visualization';
import {
  BLINDFOLD_START_PLIES,
  COORDINATE_ROUND_MS,
  CoordinateRound,
  buildBlindfoldDrill,
  guessPositions,
  judgeGuess,
  pickBlindfoldSource,
  visualizationCardTarget,
  type BlindfoldDrill,
  type BlindfoldQuestion,
  type GuessPosition,
  type GuessVerdict,
  type SequenceSource,
} from './visualization';
import { drillCardId } from './srs-cards';
import type { VisualizationStore } from './visualization-store';
import {
  Timers,
  createTrainerBoard,
  createTrainerRoot,
  fromExecuted,
  playMoveSound,
  plural,
  saveBeforeShow,
  trainerLayoutHtml,
  type SaveOutcome,
} from './trainer-kit';

/** A game of mine to guess through. */
export interface GuessGame {
  id: string;
  /** "Lobo017 vs hikaru · 2026-10-04". */
  label: string;
  pgn: string;
  /** My side in it. */
  color: Color;
  /** The saved review's best move at each ply, when the game was reviewed (read when the game is chosen). */
  loadBestMoves?: () => Promise<ReadonlyMap<number, string>>;
}

export interface VisualizationTrainerOptions {
  container: HTMLElement;
  store: VisualizationStore;
  audio: CathedralAudio;
  /** My games, newest first. */
  getGames: () => Promise<GuessGame[]>;
  onOpenGames: () => void;
  random?: () => number;
}

export type VisualizationMode = 'coordinates' | 'blindfold' | 'guess';
export type CoordinateState = 'idle' | 'running' | 'done';
export type BlindfoldState = 'idle' | 'reading' | 'asking' | 'feedback' | 'done';
export type GuessState = 'idle' | 'asking' | 'feedback' | 'done';

const FEEDBACK_MS = 380;
/** The pause on an answer before the next question. */
const BLINDFOLD_FEEDBACK_MS = 1100;
const GUESS_FEEDBACK_MS = 1500;

const MODES: ReadonlyArray<{ id: VisualizationMode; label: string }> = [
  { id: 'coordinates', label: 'Coordinates' },
  { id: 'blindfold', label: 'Blindfold' },
  { id: 'guess', label: 'Guess move' },
];

/** The lines blindfold drills are read from: opening lines, the sample game, and my games. */
function sourcesFor(plies: number, games: readonly { label: string; sans: string[] }[]): SequenceSource[] {
  const lines: SequenceSource[] = [];
  for (const o of Object.values(OPENINGS_BY_EPD)) {
    if (o.moves.length >= plies) lines.push({ label: `${o.eco} ${o.name}`, moves: o.moves });
  }
  for (const g of games) if (g.sans.length >= plies) lines.push({ label: g.label, moves: g.sans });
  return lines;
}

/**
 * The visualization drills: the coordinate trainer (find the named square, 30 seconds),
 * blindfold (moves read out with the board empty, then where pieces stand), and guess the move
 * (what I played, through my own games). Each drill's result grades a card that comes back on
 * the Today screen.
 */
export class VisualizationTrainer {
  private readonly root: HTMLElement;
  private readonly board: BoardRenderer;
  private readonly timers = new Timers();
  private readonly random: () => number;
  private tabs!: Tabs;
  private mode: VisualizationMode = 'coordinates';
  /** Bumped whenever a drill stops or starts, so a late timer or save for an old one is dropped. */
  private seq = 0;
  // Coordinates
  private orientation: Color = 'w';
  private round: CoordinateRound | null = null;
  private coordState: CoordinateState = 'idle';
  private roundStartedAt = 0;
  private roundTimer: ReturnType<typeof setInterval> | null = null;
  // Blindfold
  private blindState: BlindfoldState = 'idle';
  private blind: BlindfoldDrill | null = null;
  private blindStep = 0;
  private blindQuestion = 0;
  private blindCorrect = 0;
  private blindPlies = BLINDFOLD_START_PLIES;
  // Guess
  private guessState: GuessState = 'idle';
  private guessGame: GuessGame | null = null;
  private guessList: GuessPosition[] = [];
  private guessIndex = 0;
  private guessHits = 0;
  private els!: {
    orient: HTMLElement;
    coordBest: HTMLElement;
    coordStatus: HTMLElement;
    coordTarget: HTMLElement;
    coordTime: HTMLElement;
    coordScore: HTMLElement;
    coordResult: HTMLElement;
    blindLevel: HTMLElement;
    blindStatus: HTMLElement;
    blindStage: HTMLElement;
    blindSan: HTMLElement;
    blindProgress: HTMLElement;
    blindFeedback: HTMLElement;
    blindResult: HTMLElement;
    guessStatus: HTMLElement;
    guessGame: HTMLElement;
    guessPrompt: HTMLElement;
    guessProgress: HTMLElement;
    guessFeedback: HTMLElement;
    guessResult: HTMLElement;
    guessSkip: HTMLButtonElement;
    guessEmpty: HTMLElement;
    openGames: HTMLButtonElement;
    footCoord: HTMLElement;
    footBlind: HTMLElement;
    footGuess: HTMLElement;
    coordStart: HTMLButtonElement;
    blindStart: HTMLButtonElement;
    guessStart: HTMLButtonElement;
  };

  constructor(private readonly options: VisualizationTrainerOptions) {
    this.random = options.random ?? Math.random;
    this.root = createTrainerRoot(
      options.container,
      'visualization-trainer',
      'wc-visualization-layout wc-viz-nocoords',
    );
    this.root.innerHTML = trainerLayoutHtml({
      testId: 'visualization-trainer',
      label: 'Visualization',
      rootClass: '',
      panelClass: 'wc-visualization-panel',
      boardMountTestId: 'viz-board-mount',
      head: tabListHtml('viz', MODES, 'coordinates', 'Visualization drills'),
      body: `
        <section class="wc-tab-panel" ${tabPanelAttrs('viz', 'coordinates', 'coordinates')}>
          <p class="wc-trainer-text">Click the square the name asks for. ${COORDINATE_ROUND_MS / 1000} seconds, as many as you can.</p>
          ${segmentedHtml(
            'orient',
            'viz-orient',
            [
              { value: 'w', label: 'From White’s side' },
              { value: 'b', label: 'From Black’s side' },
            ],
            'w',
            'Board side',
          )}
          <div class="wc-puzzle-card wc-trainer-card">
            <div class="wc-status-header">
              <div class="wc-status-banner" data-testid="viz-coord-status" role="status" aria-live="polite" data-state="idle">Ready</div>
              <div class="wc-eval-pill" data-testid="viz-coord-time" title="Seconds left">30</div>
            </div>
            <div class="wc-viz-target" data-testid="viz-coord-target" aria-live="off">–</div>
            <p class="wc-trainer-text" data-testid="viz-coord-score">0 right · 0 wrong</p>
            <p class="wc-trainer-text" data-testid="viz-coord-result"></p>
          </div>
          <p class="wc-trainer-text wc-trainer-muted" data-testid="viz-coord-best"></p>
        </section>
        <section class="wc-tab-panel" ${tabPanelAttrs('viz', 'blindfold', 'coordinates')}>
          <p class="wc-trainer-text">The moves are read out one at a time with the board empty. Then say where pieces stand by clicking their squares.</p>
          <div class="wc-puzzle-card wc-trainer-card">
            <div class="wc-status-header">
              <div class="wc-status-banner" data-testid="viz-blind-status" role="status" aria-live="polite" data-state="idle">Ready</div>
              <div class="wc-eval-pill" data-testid="viz-blind-progress" title="Move or question">–</div>
            </div>
            <div class="wc-viz-target wc-viz-spoken" data-testid="viz-blind-stage" aria-live="polite">–</div>
            <p class="wc-trainer-text wc-trainer-muted" data-testid="viz-blind-san"></p>
            <p class="wc-trainer-text" data-testid="viz-blind-feedback" role="status"></p>
            <p class="wc-trainer-text" data-testid="viz-blind-result"></p>
          </div>
          <p class="wc-trainer-text wc-trainer-muted" data-testid="viz-blind-level"></p>
        </section>
        <section class="wc-tab-panel" ${tabPanelAttrs('viz', 'guess', 'coordinates')}>
          <p class="wc-trainer-text">Step through one of your own games and play the move you played. A match with the move played, or with the review's best move, counts.</p>
          <div class="wc-puzzle-card wc-trainer-card" data-testid="viz-guess-card">
            <div class="wc-status-header">
              <div class="wc-status-banner" data-testid="viz-guess-status" role="status" aria-live="polite" data-state="idle">Ready</div>
              <div class="wc-eval-pill" data-testid="viz-guess-progress" title="Position">–</div>
            </div>
            <p class="wc-trainer-text wc-trainer-muted" data-testid="viz-guess-game"></p>
            <p class="wc-trainer-text wc-viz-question" data-testid="viz-guess-prompt"></p>
            <p class="wc-trainer-text" data-testid="viz-guess-feedback" role="status"></p>
            <p class="wc-trainer-text" data-testid="viz-guess-result"></p>
          </div>
          <div class="wc-action-bar">
            <button type="button" class="wc-btn wc-btn-secondary wc-btn-action" data-testid="btn-viz-guess-skip">Skip this move</button>
          </div>
          <div class="wc-puzzle-empty" data-testid="viz-guess-empty" hidden>
            <p>No games of yours yet. Games captured by the extension or imported are mine when a player's name is one of my usernames.</p>
            <div class="wc-puzzle-empty-actions"><button type="button" class="wc-btn wc-btn-secondary wc-btn-sm" data-testid="btn-viz-open-games">Open the Games list</button></div>
          </div>
        </section>`,
      foot: `
        <div class="wc-action-bar wc-grow" data-testid="viz-foot-coordinates"><button type="button" class="wc-btn wc-btn-primary wc-btn-lg wc-grow" data-testid="btn-coord-start">Start round</button></div>
        <div class="wc-action-bar wc-grow" data-testid="viz-foot-blindfold" hidden><button type="button" class="wc-btn wc-btn-primary wc-btn-lg wc-grow" data-testid="btn-blind-start">Start drill</button></div>
        <div class="wc-action-bar wc-grow" data-testid="viz-foot-guess" hidden><button type="button" class="wc-btn wc-btn-primary wc-btn-lg wc-grow" data-testid="btn-guess-start">Start a game</button></div>`,
    });
    const mount = this.root.querySelector('[data-testid="viz-board-mount"]') as HTMLElement;
    this.board = createTrainerBoard(mount, options.audio, (move) => this.handleMove(move));
    // Clicks on the empty board answer the coordinate and blindfold questions
    mount.addEventListener('pointerdown', (e) => this.handleBoardPress(e));
    const q = <T extends HTMLElement>(id: string) => this.root.querySelector(`[data-testid="${id}"]`) as T;
    this.els = {
      orient: this.root.querySelector('[data-seg="orient"]') as HTMLElement,
      coordBest: q('viz-coord-best'),
      coordStatus: q('viz-coord-status'),
      coordTarget: q('viz-coord-target'),
      coordTime: q('viz-coord-time'),
      coordScore: q('viz-coord-score'),
      coordResult: q('viz-coord-result'),
      blindLevel: q('viz-blind-level'),
      blindStatus: q('viz-blind-status'),
      blindStage: q('viz-blind-stage'),
      blindSan: q('viz-blind-san'),
      blindProgress: q('viz-blind-progress'),
      blindFeedback: q('viz-blind-feedback'),
      blindResult: q('viz-blind-result'),
      guessStatus: q('viz-guess-status'),
      guessGame: q('viz-guess-game'),
      guessPrompt: q('viz-guess-prompt'),
      guessProgress: q('viz-guess-progress'),
      guessFeedback: q('viz-guess-feedback'),
      guessResult: q('viz-guess-result'),
      guessSkip: q('btn-viz-guess-skip'),
      guessEmpty: q('viz-guess-empty'),
      openGames: q('btn-viz-open-games'),
      footCoord: q('viz-foot-coordinates'),
      footBlind: q('viz-foot-blindfold'),
      footGuess: q('viz-foot-guess'),
      coordStart: q('btn-coord-start'),
      blindStart: q('btn-blind-start'),
      guessStart: q('btn-guess-start'),
    };
    this.tabs = new Tabs(this.root, (id) => this.onTab(id as VisualizationMode));
    this.els.orient.addEventListener('click', (e) => {
      const value = (e.target as HTMLElement).closest<HTMLElement>('[role="radio"]')?.dataset.value;
      if (value === 'w' || value === 'b') this.setOrientation(value);
    });
    this.els.coordStart.addEventListener('click', () =>
      this.coordState === 'running' ? void this.finishRound() : this.startRound(),
    );
    this.els.blindStart.addEventListener('click', () => this.blindPress());
    this.els.guessStart.addEventListener('click', () => void this.startGuess());
    this.els.guessSkip.addEventListener('click', () => this.skipGuess());
    this.els.openGames.addEventListener('click', () => options.onOpenGames());
    options.store.onChange(() => void this.renderStats());
    this.root.setAttribute('data-viz-mode', this.mode);
    this.resetCoordinates();
    this.resetBlindfold();
    this.resetGuess();
    this.showEmptyBoard();
    void this.renderStats();
    this.updateButtons();
  }

  // ------------------------------------------------------------------ public API

  public getBoard(): BoardRenderer {
    return this.board;
  }

  public getMode(): VisualizationMode {
    return this.mode;
  }

  public showMode(mode: VisualizationMode): void {
    this.tabs.select(mode);
  }

  public getCoordinateState(): CoordinateState {
    return this.coordState;
  }

  public getRound(): CoordinateRound | null {
    return this.round;
  }

  public getBlindfoldState(): BlindfoldState {
    return this.blindState;
  }

  /** The blindfold drill being played (null before the first). */
  public getBlindfoldDrill(): BlindfoldDrill | null {
    return this.blind;
  }

  /** The question waiting for an answer, when one is. */
  public getBlindfoldQuestion(): BlindfoldQuestion | null {
    return this.blindState === 'asking' ? (this.blind?.questions[this.blindQuestion] ?? null) : null;
  }

  public getGuessState(): GuessState {
    return this.guessState;
  }

  /** The guess-the-move session: the game, the positions and where it is. */
  public getGuess(): { game: GuessGame; positions: readonly GuessPosition[]; index: number } | null {
    return this.guessGame ? { game: this.guessGame, positions: this.guessList, index: this.guessIndex } : null;
  }

  /** Opens the drill that is due (for the Today screen): the first card of the deck that has come due. */
  public async openDue(now: number = Date.now()): Promise<boolean> {
    const cards = (await this.options.store.listCards())
      .filter((c) => c.state !== 'new' && c.dueDate <= now)
      .sort((a, b) => a.dueDate - b.dueDate);
    const first = cards[0];
    if (!first) return false;
    const kind: VisualizationMode = first.targetId.startsWith('guess:')
      ? 'guess'
      : first.targetId === 'blindfold'
        ? 'blindfold'
        : 'coordinates';
    this.tabs.select(kind);
    return true;
  }

  // ------------------------------------------------------------------ shared

  /** The trainer's screen went away: a drill under way is dropped (nothing is recorded). */
  public suspend(): void {
    this.onTab(this.mode);
  }

  private onTab(mode: VisualizationMode): void {
    this.stopAll();
    this.mode = mode;
    this.root.setAttribute('data-viz-mode', mode);
    this.els.footCoord.hidden = mode !== 'coordinates';
    this.els.footBlind.hidden = mode !== 'blindfold';
    this.els.footGuess.hidden = mode !== 'guess';
    // The coordinate drill hides the board's labels; the others keep them (blindfold answers are squares)
    this.root.classList.toggle('wc-viz-nocoords', mode === 'coordinates');
    this.resetCoordinates();
    this.resetBlindfold();
    this.resetGuess();
    if (mode === 'guess') {
      this.board.setFlipped(false);
      this.board.setPosition(new RulesAdapter().fen(), { animate: false });
    } else {
      this.board.setFlipped(mode === 'coordinates' ? this.orientation === 'b' : false);
      this.showEmptyBoard();
    }
    this.board.setInteractiveColor('none');
    void this.renderStats();
    this.updateButtons();
  }

  /** Stops every drill: timers, the round's clock, and anything waiting on them. */
  private stopAll(): void {
    ++this.seq;
    this.timers.clear();
    if (this.roundTimer) clearInterval(this.roundTimer);
    this.roundTimer = null;
    this.board.clearUserAnnotations();
  }

  private showEmptyBoard(): void {
    this.board.setArbitrarySquares(new Map<Square, Piece>());
  }

  private handleMove(move: MoveInput): void {
    if (this.mode === 'guess') this.guessMove(move);
  }

  private handleBoardPress(e: PointerEvent): void {
    if (e.button !== 0 || (this.mode !== 'coordinates' && this.mode !== 'blindfold')) return;
    const square = this.board.squareFromClientPoint(e.clientX, e.clientY);
    if (!square) return;
    if (this.mode === 'coordinates') this.answerCoordinate(square);
    else this.answerBlindfold(square);
  }

  private flashSquares(squares: ReadonlyArray<{ square: Square; ok: boolean }>, ms = FEEDBACK_MS): void {
    const seq = this.seq;
    this.board.setUserAnnotations(
      [],
      squares.map((s) => ({ square: s.square, color: s.ok ? ('G' as const) : ('R' as const) })),
    );
    this.timers.later(() => {
      if (seq === this.seq) this.board.clearUserAnnotations();
    }, ms);
  }

  private async renderStats(): Promise<void> {
    const [coords, blind] = await Promise.all([
      this.options.store.coordinateStats(),
      this.options.store.blindfoldStats(),
    ]);
    this.els.coordBest.textContent =
      coords.rounds === 0
        ? 'No rounds yet.'
        : `Best round: ${coords.best} right · ${plural(coords.rounds, 'round')} played.`;
    this.blindPlies = blind.level;
    this.els.blindLevel.textContent =
      blind.drills === 0
        ? `Level: ${blind.level} moves. It goes up when you answer every question.`
        : `Level: ${blind.level} moves · best without a miss: ${blind.bestLevel || '–'} · ${plural(blind.drills, 'drill')} played.`;
  }

  private updateButtons(): void {
    this.els.coordStart.textContent =
      this.coordState === 'running' ? 'Finish round' : this.coordState === 'done' ? 'Another round' : 'Start round';
    this.els.coordStart.classList.toggle('wc-btn-primary', this.coordState !== 'running');
    this.els.coordStart.classList.toggle('wc-btn-secondary', this.coordState === 'running');
    const bs = this.blindState;
    this.els.blindStart.textContent =
      bs === 'reading'
        ? this.blind && this.blindStep >= this.blind.moves.length - 1
          ? 'Answer the questions'
          : 'Next move'
        : bs === 'done'
          ? 'Next drill'
          : bs === 'idle'
            ? 'Start drill'
            : 'Answer on the board';
    this.els.blindStart.disabled = bs === 'asking' || bs === 'feedback';
    const gs = this.guessState;
    this.els.guessStart.textContent = gs === 'done' ? 'Next game' : gs === 'idle' ? 'Start a game' : 'Restart';
    this.els.guessSkip.disabled = gs !== 'asking';
    // The one primary button is the one that starts something
    const startsBlind = bs === 'idle' || bs === 'done' || bs === 'reading';
    this.els.blindStart.classList.toggle('wc-btn-primary', startsBlind);
    this.els.blindStart.classList.toggle('wc-btn-secondary', !startsBlind);
    const startsGuess = gs === 'idle' || gs === 'done';
    this.els.guessStart.classList.toggle('wc-btn-primary', startsGuess);
    this.els.guessStart.classList.toggle('wc-btn-secondary', !startsGuess);
  }

  // ------------------------------------------------------------------ coordinates

  private setOrientation(color: Color): void {
    this.orientation = color;
    this.els.orient
      .querySelectorAll<HTMLElement>('[role="radio"]')
      .forEach((el) => el.setAttribute('aria-checked', String(el.dataset.value === color)));
    this.board.setFlipped(color === 'b');
  }

  private resetCoordinates(): void {
    this.round = null;
    this.coordState = 'idle';
    this.els.coordTarget.textContent = '–';
    this.els.coordTime.textContent = String(COORDINATE_ROUND_MS / 1000);
    this.els.coordScore.textContent = '0 right · 0 wrong';
    this.els.coordResult.textContent = '';
    this.setCoordStatus('Ready', 'idle');
    this.root.setAttribute('data-coord-state', 'idle');
  }

  private setCoordStatus(text: string, state: string): void {
    this.els.coordStatus.textContent = text;
    this.els.coordStatus.setAttribute('data-state', state);
  }

  private startRound(): void {
    this.stopAll();
    this.round = new CoordinateRound(this.random);
    this.coordState = 'running';
    this.roundStartedAt = performance.now();
    this.root.setAttribute('data-coord-state', 'running');
    this.showEmptyBoard();
    this.els.coordResult.textContent = '';
    this.setCoordStatus('Find the square', 'playing');
    this.renderRound();
    this.updateButtons();
    const seq = this.seq;
    this.roundTimer = setInterval(() => {
      if (seq !== this.seq) return;
      const left = COORDINATE_ROUND_MS - (performance.now() - this.roundStartedAt);
      if (left <= 0) void this.finishRound();
      else this.els.coordTime.textContent = String(Math.ceil(left / 1000));
    }, 200);
  }

  private renderRound(): void {
    const r = this.round;
    if (!r) return;
    this.els.coordTarget.textContent = r.target;
    this.els.coordScore.textContent = `${r.correct} right · ${r.wrong} wrong`;
  }

  private answerCoordinate(square: Square): void {
    const r = this.round;
    if (!r || this.coordState !== 'running') return;
    const target = r.target;
    const ok = r.answer(square);
    this.options.audio.playSelect();
    // A right click is ringed green; a wrong one red, with the square that was asked for in green
    this.flashSquares(
      ok
        ? [{ square, ok: true }]
        : [
            { square: target, ok: true },
            { square, ok: false },
          ],
    );
    this.renderRound();
  }

  private async finishRound(): Promise<void> {
    const r = this.round;
    if (!r || this.coordState !== 'running') return;
    const seq = ++this.seq;
    if (this.roundTimer) clearInterval(this.roundTimer);
    this.roundTimer = null;
    this.coordState = 'done';
    // Saved first, shown after (see saveBeforeShow): a phone app closed as the result appears has stored it
    const outcome = await saveBeforeShow(this.options.store.recordCoordinates({ correct: r.correct, wrong: r.wrong }));
    if (seq !== this.seq) return;
    this.root.setAttribute('data-coord-state', 'done');
    this.els.coordTime.textContent = '0';
    this.els.coordTarget.textContent = '–';
    this.board.clearUserAnnotations();
    const accuracy = Math.round(r.accuracy * 100);
    this.setCoordStatus('Round over', 'done');
    const base = `${r.correct} right · ${r.wrong} wrong · ${accuracy}% accuracy.`;
    const after = (saved: { newBest: boolean; card: { dueDate: number } }) =>
      `${saved.newBest ? ' New best!' : ''} ${this.nextText(saved.card.dueDate)}`;
    this.els.coordResult.textContent = 'saved' in outcome ? `${base}${after(outcome.saved)}` : base;
    this.options.audio.playGameOver(gradeCoordinates(r) >= 2);
    this.updateButtons();
    this.finishUpSave(outcome, this.els.coordResult, after);
  }

  /** A save that was slow or failed: say so on the result once it is known (the result itself is already showing). */
  private finishUpSave<T>(outcome: SaveOutcome<T>, el: HTMLElement, after: (saved: T) => string): void {
    const seq = this.seq;
    const failed = (err: unknown) => {
      if (seq === this.seq) {
        el.textContent = `${el.textContent} Progress could not be saved: ${err instanceof Error ? err.message : String(err)}`;
      }
    };
    if ('error' in outcome) {
      failed(outcome.error);
    } else if ('pending' in outcome) {
      void outcome.pending.then((saved) => {
        if (seq === this.seq) el.textContent = `${el.textContent}${after(saved)}`;
      }, failed);
    }
  }

  private nextText(dueDate: number): string {
    return `Comes back ${formatDueIn(dueDate, Date.now())}.`;
  }

  // ------------------------------------------------------------------ blindfold

  private resetBlindfold(): void {
    this.blind = null;
    this.blindState = 'idle';
    this.blindStep = 0;
    this.blindQuestion = 0;
    this.blindCorrect = 0;
    this.els.blindStage.textContent = '–';
    this.els.blindSan.textContent = '';
    this.els.blindStage.textContent = '–';
    this.els.blindFeedback.textContent = '';
    this.els.blindResult.textContent = '';
    this.els.blindProgress.textContent = '–';
    this.setBlindStatus('Ready', 'idle');
    this.root.setAttribute('data-blind-state', 'idle');
  }

  private setBlindStatus(text: string, state: string): void {
    this.els.blindStatus.textContent = text;
    this.els.blindStatus.setAttribute('data-state', state);
  }

  private setBlindState(state: BlindfoldState): void {
    this.blindState = state;
    this.root.setAttribute('data-blind-state', state);
    this.updateButtons();
  }

  private blindPress(): void {
    if (this.blindState === 'idle' || this.blindState === 'done') void this.startBlindfold();
    else if (this.blindState === 'reading') this.nextBlindMove();
  }

  private async startBlindfold(): Promise<void> {
    this.stopAll();
    const seq = this.seq;
    let games: GuessGame[] = [];
    try {
      games = await this.options.getGames();
    } catch {
      games = [];
    }
    if (seq !== this.seq) return;
    const mine = games.map((g) => ({
      label: g.label,
      sans: parsePgn(g.pgn)
        .getMainLine()
        .map((n) => n.san),
    }));
    const sample = {
      label: "Morphy's opera game",
      sans: parsePgn(SAMPLE_GAME_PGN)
        .getMainLine()
        .map((n) => n.san),
    };
    const plies = this.blindPlies;
    const lines = sourcesFor(plies, [...mine, sample]);
    const source = pickBlindfoldSource(lines, plies, this.random) ?? { label: sample.label, moves: sample.sans };
    this.blind = buildBlindfoldDrill(source, plies, this.random);
    this.blindStep = 0;
    this.blindQuestion = 0;
    this.blindCorrect = 0;
    this.showEmptyBoard();
    this.board.clearUserAnnotations();
    this.board.setFlipped(false);
    this.els.blindResult.textContent = '';
    this.els.blindFeedback.textContent = '';
    this.els.blindStage.textContent = '–';
    this.setBlindState('reading');
    this.renderBlindMove();
  }

  private renderBlindMove(): void {
    const drill = this.blind;
    if (!drill) return;
    const move = drill.moves[this.blindStep];
    if (!move) return;
    const side = move.color === 'w' ? 'White' : 'Black';
    this.setBlindStatus('Picture the board', 'playing');
    this.els.blindStage.textContent = `${side}: ${move.spoken}`;
    this.els.blindSan.textContent = move.san;
    this.els.blindProgress.textContent = `${this.blindStep + 1}/${drill.moves.length}`;
    this.updateButtons();
  }

  private nextBlindMove(): void {
    const drill = this.blind;
    if (!drill || this.blindState !== 'reading') return;
    if (this.blindStep < drill.moves.length - 1) {
      this.blindStep++;
      this.renderBlindMove();
      return;
    }
    this.blindStep = drill.moves.length;
    this.els.blindStage.textContent = '–';
    this.els.blindSan.textContent = '';
    this.setBlindState('asking');
    this.renderBlindQuestion();
  }

  private renderBlindQuestion(): void {
    const drill = this.blind!;
    const q = drill.questions[this.blindQuestion];
    if (!q) {
      void this.finishBlindfold();
      return;
    }
    this.setBlindStatus('Click the square', 'asking');
    this.els.blindStage.textContent = q.text;
    this.els.blindProgress.textContent = `Q${this.blindQuestion + 1}/${drill.questions.length}`;
    this.els.blindFeedback.textContent = '';
  }

  private answerBlindfold(square: Square): void {
    const drill = this.blind;
    if (!drill || this.blindState !== 'asking') return;
    const q = drill.questions[this.blindQuestion];
    if (!q) return;
    const seq = this.seq;
    const ok = q.squares.includes(square);
    if (ok) this.blindCorrect++;
    this.options.audio.playSelect();
    const where = q.squares.join(' and ');
    this.els.blindFeedback.textContent = ok ? `Yes: ${where}.` : `Not there: it is on ${where}.`;
    this.setBlindState('feedback');
    this.board.setUserAnnotations(
      [],
      [...q.squares.map((s) => ({ square: s, color: 'G' as const })), ...(ok ? [] : [{ square, color: 'R' as const }])],
    );
    this.timers.later(() => {
      if (seq !== this.seq) return;
      this.board.clearUserAnnotations();
      this.blindQuestion++;
      if (this.blindQuestion >= drill.questions.length) void this.finishBlindfold();
      else {
        this.setBlindState('asking');
        this.renderBlindQuestion();
      }
    }, BLINDFOLD_FEEDBACK_MS);
  }

  private async finishBlindfold(): Promise<void> {
    const drill = this.blind;
    if (!drill) return;
    const seq = this.seq;
    const total = drill.questions.length;
    const correct = this.blindCorrect;
    // Saved first, shown after (see saveBeforeShow): a phone app closed as the result appears has stored it
    const outcome = await saveBeforeShow(
      this.options.store.recordBlindfold({ plies: drill.moves.length, correct, total }),
    );
    if (seq !== this.seq) return;
    this.setBlindState('done');
    this.setBlindStatus(correct === total ? 'All right!' : 'Drill over', correct === total ? 'solved' : 'done');
    this.els.blindStage.textContent = '–';
    this.els.blindProgress.textContent = `${correct}/${total}`;
    const base = `${correct} of ${total} right. ${drill.label}.`;
    const after = (saved: { stats: { level: number }; card: { dueDate: number } }) =>
      ` Next level: ${saved.stats.level} moves. ${this.nextText(saved.card.dueDate)}`;
    this.els.blindResult.textContent = 'saved' in outcome ? `${base}${after(outcome.saved)}` : base;
    // The board shows where the pieces really are
    this.board.setPosition(drill.finalFen, { animate: false });
    this.options.audio.playGameOver(correct === total);
    this.finishUpSave(outcome, this.els.blindResult, after);
  }

  // ------------------------------------------------------------------ guess the move

  private resetGuess(): void {
    this.guessGame = null;
    this.guessList = [];
    this.guessIndex = 0;
    this.guessHits = 0;
    this.guessState = 'idle';
    this.els.guessGame.textContent = '';
    this.els.guessPrompt.textContent = '';
    this.els.guessFeedback.textContent = '';
    this.els.guessResult.textContent = '';
    this.els.guessProgress.textContent = '–';
    this.els.guessEmpty.hidden = true;
    this.setGuessStatus('Ready', 'idle');
    this.root.setAttribute('data-guess-state', 'idle');
  }

  private setGuessStatus(text: string, state: string): void {
    this.els.guessStatus.textContent = text;
    this.els.guessStatus.setAttribute('data-state', state);
  }

  private setGuessState(state: GuessState): void {
    this.guessState = state;
    this.root.setAttribute('data-guess-state', state);
    this.updateButtons();
  }

  /** The game to guess through: one that is due, else one never guessed, else the one guessed longest ago. */
  private async pickGame(games: readonly GuessGame[]): Promise<GuessGame[]> {
    const [cards, stats] = await Promise.all([this.options.store.listCards(), this.options.store.guessStats()]);
    const now = Date.now();
    const dueAt = new Map(cards.filter((c) => c.state !== 'new').map((c) => [c.id, c.dueDate]));
    const rank = (g: GuessGame): number => {
      const due = dueAt.get(drillCardId('visualization', visualizationCardTarget('guess', g.id)));
      if (due !== undefined && due <= now) return due - 1e15; // due: first, the longest overdue first
      if (due === undefined && !stats[g.id]) return 0; // never guessed
      return (stats[g.id]?.at ?? 0) + 1e12; // otherwise the longest ago first
    };
    return [...games].sort((a, b) => rank(a) - rank(b));
  }

  private async startGuess(): Promise<void> {
    this.stopAll();
    this.resetGuess();
    const seq = this.seq;
    let games: GuessGame[];
    try {
      games = await this.options.getGames();
    } catch (err) {
      this.setGuessStatus(`Your games could not be read: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return;
    }
    if (seq !== this.seq) return;
    const ordered = await this.pickGame(games);
    if (seq !== this.seq) return;
    for (const game of ordered) {
      let tree: GameTree;
      try {
        tree = parsePgn(game.pgn);
      } catch {
        continue;
      }
      let best: ReadonlyMap<number, string> = new Map();
      try {
        best = (await game.loadBestMoves?.()) ?? best;
      } catch {
        // Without its review the game is still guessed, against the moves played only
      }
      if (seq !== this.seq) return;
      const positions = guessPositions(tree, game.color, best);
      if (positions.length === 0) continue;
      this.guessGame = game;
      this.guessList = positions;
      this.guessIndex = 0;
      this.guessHits = 0;
      this.board.setFlipped(game.color === 'b');
      this.els.guessGame.textContent = game.label;
      this.showGuessPosition();
      return;
    }
    this.els.guessEmpty.hidden = false;
    this.setGuessStatus('No game to guess through', 'empty');
    this.board.setInteractiveColor('none');
  }

  private showGuessPosition(): void {
    const pos = this.guessList[this.guessIndex];
    const game = this.guessGame;
    if (!pos || !game) return;
    this.board.clearUserAnnotations();
    this.board.setPosition(pos.fen, { animate: false });
    this.board.setInteractiveColor(game.color);
    this.setGuessState('asking');
    this.setGuessStatus('Your move', 'asking');
    this.els.guessProgress.textContent = `${this.guessIndex + 1}/${this.guessList.length}`;
    this.els.guessPrompt.textContent = `Move ${/^\d+/.exec(pos.label)?.[0] ?? ''}: what did you play here?`;
    this.els.guessFeedback.textContent = '';
  }

  private guessMove(move: MoveInput): void {
    const pos = this.guessList[this.guessIndex];
    if (!pos || this.guessState !== 'asking') return;
    this.resolveGuess(pos, judgeGuess(pos, moveInputToUci(move)), move);
  }

  private skipGuess(): void {
    const pos = this.guessList[this.guessIndex];
    if (!pos || this.guessState !== 'asking') return;
    this.resolveGuess(pos, 'other', null);
  }

  /** Shows what was played, scores the guess, and goes on to the next position (or finishes). */
  private resolveGuess(pos: GuessPosition, verdict: GuessVerdict, guess: MoveInput | null): void {
    const seq = this.seq;
    if (verdict !== 'other') this.guessHits++;
    this.board.setInteractiveColor('none');
    this.setGuessState('feedback');
    let played: ExecutedMove | null = null;
    try {
      const adapter = new RulesAdapter(pos.fen);
      played = adapter.move(pos.uci);
      this.board.setPosition(adapter, {
        lastMove: played,
        ...(verdict === 'played' && guess ? { wasDragged: true } : { animate: true }),
      });
      playMoveSound(this.options.audio, fromExecuted(played), /[+#]$/.test(played.san));
      announce(`${played.color === 'w' ? 'White' : 'Black'} plays ${played.san}`);
    } catch {
      played = null;
    }
    const guessed = guess ? this.sanOf(pos, moveInputToUci(guess)) : null;
    this.els.guessFeedback.textContent =
      verdict === 'played'
        ? `Yes, you played ${pos.san}.`
        : verdict === 'best'
          ? `You played ${pos.san}. Your ${guessed} is the review's best move: that counts.`
          : `You played ${pos.san}.${guessed ? ` Your guess was ${guessed}.` : ''}${pos.bestUci ? ` The review's best move was ${this.sanOf(pos, pos.bestUci)}.` : ''}`;
    this.setGuessStatus(verdict === 'other' ? 'Not that one' : 'Match', verdict === 'other' ? 'wrong' : 'correct');
    this.timers.later(() => {
      if (seq !== this.seq) return;
      this.guessIndex++;
      if (this.guessIndex >= this.guessList.length) void this.finishGuess();
      else this.showGuessPosition();
    }, GUESS_FEEDBACK_MS);
  }

  private sanOf(pos: GuessPosition, uci: string): string {
    try {
      return new RulesAdapter(pos.fen).move(uci).san;
    } catch {
      return uci;
    }
  }

  private async finishGuess(): Promise<void> {
    const game = this.guessGame;
    if (!game) return;
    const seq = this.seq;
    const total = this.guessList.length;
    const hits = this.guessHits;
    this.board.setInteractiveColor('none');
    // Saved first, shown after (see saveBeforeShow): a phone app closed as the result appears has stored it
    const outcome = await saveBeforeShow(this.options.store.recordGuess(game.id, { hits, total }));
    if (seq !== this.seq) return;
    this.setGuessState('done');
    this.setGuessStatus('Game over', 'done');
    this.els.guessPrompt.textContent = '';
    this.els.guessFeedback.textContent = '';
    this.els.guessProgress.textContent = `${hits}/${total}`;
    const base = `${hits} of ${plural(total, 'move')} matched. Grade: ${['', 'Again', 'Hard', 'Good', 'Easy'][gradeGuess({ hits, total })]}.`;
    const after = (saved: { card: { dueDate: number } }) => ` ${this.nextText(saved.card.dueDate)}`;
    this.els.guessResult.textContent = 'saved' in outcome ? `${base}${after(outcome.saved)}` : base;
    this.options.audio.playGameOver(hits * 2 >= total);
    this.finishUpSave(outcome, this.els.guessResult, after);
  }

  public destroy(): void {
    this.stopAll();
    this.board.destroy();
  }
}
