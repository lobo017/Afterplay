import type { PuzzleEntry } from '../core/datasets';
import { RulesAdapter, type Color, type ExecutedMove, type MoveInput } from '../core/rules';
import type { EngineClient } from '../engine/engine-client';
import type { UciScore } from '../engine/uci-parser';
import { CathedralAudio } from '../render/audio';
import { BoardRenderer } from '../render/board-renderer';
import { DEFAULT_BOARD_THEME, DEFAULT_PIECE_SET } from '../render/themes';
import { icon } from '../ui/components/icons';
import { Menu } from '../ui/components/menu';
import type { StoredPuzzleRecord } from '../storage/db';
import { PuzzleDatasetClient, type DatasetInfo } from './puzzle-dataset-client';
import { moveInputToUci, preparePuzzle, type PreparedPuzzle } from './puzzle-format';
import { PuzzleSession, type AttemptOutcome } from './puzzle-session';
import type { AttemptResult, PuzzleStore } from './puzzle-store';
import { judgeAlternative, type AlternativeVerdict } from './puzzle-validation';
import type { PuzzleMode } from './today-screen';

/** Engine time for each position when checking a move that isn't the solution. */
export const ALTERNATIVE_MOVETIME_MS = 500;
/** Pause before the opponent's setup move and before each reply is shown. */
const SETUP_DELAY_MS = 450;
const REPLY_DELAY_MS = 320;
/** A wrong move stays on the board this long before it is taken back. */
const WRONG_MOVE_MS = 650;

export interface PuzzleTrainerOptions {
  container: HTMLElement;
  store: PuzzleStore;
  /** Checks moves that aren't the solution (the live analysis engine). */
  engine: Pick<EngineClient, 'analyze'>;
  audio: CathedralAudio;
  /** Personal puzzles brought up to date with the reviewed games. */
  syncPersonal: () => Promise<void>;
  /** Opens a PGN on the analysis board at a ply of its main line. */
  onAnalyze: (pgn: string, ply: number) => void;
  onOpenGames: () => void;
  dataset?: PuzzleDatasetClient;
}

interface Loaded {
  source: StoredPuzzleRecord['source'];
  entry: PuzzleEntry | StoredPuzzleRecord;
  prepared: PreparedPuzzle;
  session: PuzzleSession;
  /** A retry: nothing is recorded. */
  practice: boolean;
  recorded: boolean;
}

const MODE_LABEL: Record<PuzzleMode, string> = { review: 'Due reviews', mistakes: 'My mistakes', rated: 'Rated' };
const SIDE: Record<Color, string> = { w: 'White', b: 'Black' };

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Moves in SAN with move numbers, starting at a FEN ("23… Rxf1 24. Qe1"). */
export function numberedLine(fen: string, sans: readonly string[]): string {
  const parts = fen.split(' ');
  let moveNo = Number(parts[5]) || 1;
  let white = parts[1] !== 'b';
  return sans
    .map((san, i) => {
      const text = white ? `${moveNo}. ${san}` : i === 0 ? `${moveNo}… ${san}` : san;
      if (!white) moveNo++;
      white = !white;
      return text;
    })
    .join(' ');
}

/** The puzzle (setup move and full solution) as a PGN for the analysis board. */
export function puzzlePgn(prepared: PreparedPuzzle, title: string): string {
  const sans = [prepared.setupMove.san, ...prepared.solutionSan];
  return [
    `[Event "${title.replace(/"/g, "'")}"]`,
    '[SetUp "1"]',
    `[FEN "${prepared.setupFen}"]`,
    '',
    `${numberedLine(prepared.setupFen, sans)} *`,
  ].join('\n');
}

function playUci(fen: string, uci: string): { adapter: RulesAdapter; move: ExecutedMove } {
  const adapter = new RulesAdapter(fen);
  const move = adapter.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci.length > 4 ? { promotion: uci[4] } : {}) });
  return { adapter, move };
}

/**
 * The Puzzles workspace: one board and a side panel with three sessions — due reviews
 * (spaced repetition across both kinds), puzzles from my mistakes, and rated bundled puzzles
 * by theme. Loaded on demand (dynamic import) the first time puzzles are opened, and the
 * bundled puzzles come from the dataset worker.
 */
export class PuzzleTrainer {
  public readonly dataset: PuzzleDatasetClient;
  private readonly root: HTMLElement;
  private readonly board: BoardRenderer;
  private mode: PuzzleMode = 'rated';
  private theme: string | null = null;
  private loaded: Loaded | null = null;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  /** Bumped on every load, so late timers and engine answers for an old puzzle are dropped. */
  private loadSeq = 0;
  private info: DatasetInfo | null = null;
  private lastResult: AttemptResult | null = null;
  private els!: {
    modes: HTMLButtonElement[];
    themeWrap: HTMLElement;
    theme: HTMLSelectElement;
    status: HTMLElement;
    rating: HTMLElement;
    prompt: HTMLElement;
    source: HTMLElement;
    line: HTMLElement;
    hint: HTMLButtonElement;
    solution: HTMLButtonElement;
    next: HTMLButtonElement;
    retry: HTMLButtonElement;
    analyze: HTMLButtonElement;
    flip: HTMLButtonElement;
    empty: HTMLElement;
    emptyText: HTMLElement;
    emptyActions: HTMLElement;
    stats: HTMLElement;
    todayDue: HTMLElement;
    todayNew: HTMLElement;
    todayRated: HTMLElement;
  };
  private menu!: Menu;

  constructor(private readonly options: PuzzleTrainerOptions) {
    this.dataset = options.dataset ?? new PuzzleDatasetClient();
    this.root = document.createElement('div');
    this.root.className = 'wc-play-layout wc-puzzle-layout';
    this.root.setAttribute('data-testid', 'puzzle-trainer');
    options.container.appendChild(this.root);
    this.mount();
    const mountEl = this.root.querySelector('[data-testid="puzzle-board-mount"]') as HTMLElement;
    this.board = new BoardRenderer(mountEl, {
      flipped: false,
      interactiveColor: 'none',
      enablePremoves: false,
      autoQueen: false,
      confirmMove: false,
      captureEffects: true,
      boardTheme: DEFAULT_BOARD_THEME,
      pieceSet: DEFAULT_PIECE_SET,
      onMove: (move) => this.handleMove(move),
      onSelectSquare: () => options.audio.playSelect(),
    });
    options.store.onChange(() => void this.renderStats());
    void this.renderStats();
    // The dataset worker starts now: puzzles were opened
    void this.dataset.info().then(
      (info) => {
        this.info = info;
        this.renderThemes();
      },
      (err: unknown) => this.setStatus(`The bundled puzzles could not be loaded: ${err instanceof Error ? err.message : String(err)}`, 'error'),
    );
  }

  public getMode(): PuzzleMode {
    return this.mode;
  }

  public getSession(): PuzzleSession | null {
    return this.loaded?.session ?? null;
  }

  public getLoaded(): { id: string; source: StoredPuzzleRecord['source']; playerColor: Color } | null {
    return this.loaded ? { id: this.loaded.entry.id, source: this.loaded.source, playerColor: this.loaded.prepared.playerColor } : null;
  }

  public getLastResult(): AttemptResult | null {
    return this.lastResult;
  }

  public getBoard(): BoardRenderer {
    return this.board;
  }

  private mount(): void {
    this.root.innerHTML = `
      <div class="wc-board-column">
        <div class="wc-board-mount" data-testid="puzzle-board-mount"></div>
      </div>
      <aside class="wc-panel wc-puzzle-panel" aria-label="Puzzles">
        <div class="wc-panel-inner">
          <div class="wc-panel-body">
            <div class="wc-today-strip" data-testid="puzzle-today" aria-label="Today">
              <div class="wc-today-strip-item"><span class="wc-today-strip-n" data-testid="puzzle-today-due">–</span><span class="wc-today-strip-l">reviews due</span></div>
              <div class="wc-today-strip-item"><span class="wc-today-strip-n" data-testid="puzzle-today-new">–</span><span class="wc-today-strip-l">new from my games</span></div>
              <div class="wc-today-strip-item"><span class="wc-today-strip-n" data-testid="puzzle-today-rated">–</span><span class="wc-today-strip-l">rated today</span></div>
            </div>
            <div class="wc-seg wc-puzzle-modes" role="tablist" aria-label="Puzzle session">
              ${(Object.keys(MODE_LABEL) as PuzzleMode[])
                .map(
                  (m) =>
                    `<button type="button" role="tab" class="wc-seg-item wc-puzzle-mode" data-mode="${m}" data-testid="puzzle-mode-${m}" aria-selected="false">${MODE_LABEL[m]}</button>`,
                )
                .join('')}
            </div>
            <label class="wc-setting-row wc-puzzle-theme" data-testid="puzzle-theme-wrap"><span class="wc-setting-label">Theme</span>
              <select class="wc-select wc-setting-select" data-testid="puzzle-theme"><option value="">Mix (all themes)</option></select>
            </label>
            <div class="wc-puzzle-card">
              <div class="wc-status-header">
                <div class="wc-status-banner" data-testid="puzzle-status" role="status" aria-live="polite" data-state="idle">Loading…</div>
                <div class="wc-eval-pill wc-puzzle-rating" data-testid="puzzle-rating" title="Puzzle rating (Glicko-2)">1500</div>
              </div>
              <p class="wc-puzzle-prompt" data-testid="puzzle-prompt"></p>
              <p class="wc-puzzle-source" data-testid="puzzle-source"></p>
            </div>
            <div class="wc-action-bar" data-testid="puzzle-actions">
              <button type="button" class="wc-btn wc-btn-secondary wc-btn-action" data-testid="btn-puzzle-hint" title="Highlights the piece to move (a solve with a hint is unrated)">${icon('hint')}Hint</button>
              <button type="button" class="wc-btn wc-btn-secondary wc-btn-action" data-testid="btn-puzzle-solution">Show solution</button>
            </div>
            <p class="wc-puzzle-line" data-testid="puzzle-line"></p>
            <div class="wc-puzzle-empty" data-testid="puzzle-empty" hidden>
              <p data-testid="puzzle-empty-text"></p>
              <div class="wc-puzzle-empty-actions" data-testid="puzzle-empty-actions"></div>
            </div>
          </div>
          <div class="wc-panel-foot wc-action-bar">
            <dl class="wc-puzzle-stats" data-testid="puzzle-stats"></dl>
            <button type="button" class="wc-btn wc-btn-secondary wc-btn-lg wc-grow" data-testid="btn-puzzle-next">Next puzzle${icon('next')}</button>
          </div>
        </div>
      </aside>
    `;
    this.menu = new Menu(
      this.root.querySelector('[data-testid="puzzle-actions"]') as HTMLElement,
      [
        { id: 'retry', label: 'Retry this puzzle', testId: 'btn-puzzle-retry', icon: 'undo', onSelect: () => this.retry() },
        { id: 'analyze', label: 'Analyze the position', testId: 'btn-puzzle-analyze', icon: 'review', onSelect: () => this.analyze() },
        { id: 'flip', label: 'Flip board', testId: 'btn-puzzle-flip', icon: 'flip', onSelect: () => this.board.setFlipped(!this.board.isFlipped()) },
      ],
      { testId: 'puzzle-menu', label: 'More puzzle actions' },
    );
    const q = <T extends HTMLElement>(id: string) => this.root.querySelector(`[data-testid="${id}"]`) as T;
    this.els = {
      modes: Array.from(this.root.querySelectorAll<HTMLButtonElement>('.wc-puzzle-mode')),
      themeWrap: q('puzzle-theme-wrap'),
      theme: q('puzzle-theme'),
      status: q('puzzle-status'),
      rating: q('puzzle-rating'),
      prompt: q('puzzle-prompt'),
      source: q('puzzle-source'),
      line: q('puzzle-line'),
      hint: q('btn-puzzle-hint'),
      solution: q('btn-puzzle-solution'),
      next: q('btn-puzzle-next'),
      retry: q('btn-puzzle-retry'),
      analyze: q('btn-puzzle-analyze'),
      flip: q('btn-puzzle-flip'),
      empty: q('puzzle-empty'),
      emptyText: q('puzzle-empty-text'),
      emptyActions: q('puzzle-empty-actions'),
      stats: q('puzzle-stats'),
      todayDue: q('puzzle-today-due'),
      todayNew: q('puzzle-today-new'),
      todayRated: q('puzzle-today-rated'),
    };
    for (const btn of this.els.modes) {
      btn.addEventListener('click', () => void this.start(btn.dataset.mode as PuzzleMode));
    }
    this.els.theme.addEventListener('change', () => {
      this.theme = this.els.theme.value || null;
      if (this.mode === 'rated') void this.next();
    });
    this.els.hint.addEventListener('click', () => this.showHint());
    this.els.solution.addEventListener('click', () => this.showSolution());
    this.els.next.addEventListener('click', () => void this.next());
    this.updateButtons();
  }

  private renderThemes(): void {
    if (!this.info) return;
    const options = this.info.themes
      .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)} (${t.count})</option>`)
      .join('');
    this.els.theme.innerHTML = `<option value="">Mix (all ${this.info.size.toLocaleString('en-US')})</option>${options}`;
    this.els.theme.value = this.theme ?? '';
  }

  /** Opens a session and its first puzzle. */
  public async start(mode: PuzzleMode): Promise<void> {
    this.mode = mode;
    for (const btn of this.els.modes) {
      const on = btn.dataset.mode === mode;
      btn.classList.toggle('wc-puzzle-mode-active', on);
      btn.setAttribute('aria-selected', String(on));
    }
    this.els.themeWrap.hidden = mode !== 'rated';
    await this.next();
  }

  /** The session's next puzzle. */
  public async next(): Promise<void> {
    const seq = ++this.loadSeq;
    this.clearTimers();
    this.setStatus('Finding a puzzle…', 'loading');
    try {
      const pick = await this.pickNext();
      if (seq !== this.loadSeq) return;
      if (!pick) {
        this.showEmpty();
        return;
      }
      this.load(pick.entry, pick.source, false);
    } catch (err) {
      if (seq === this.loadSeq) this.setStatus(`Could not load a puzzle: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  private async pickNext(): Promise<{ entry: PuzzleEntry | StoredPuzzleRecord; source: StoredPuzzleRecord['source'] } | null> {
    const store = this.options.store;
    const current = this.loaded?.entry.id;
    if (this.mode === 'rated') {
      const [rating, tried] = await Promise.all([store.getRating(), store.triedBundledIds()]);
      const entry = await this.dataset.pick(this.theme, rating.rating, current ? [...tried, current] : tried);
      return entry ? { entry, source: 'lichess' } : null;
    }
    if (this.mode === 'mistakes') await this.options.syncPersonal();
    const { reviews, fresh } = await store.dueQueue();
    const personalOnly = this.mode === 'mistakes';
    const queue = this.mode === 'review' ? reviews : [...reviews, ...fresh];
    for (const card of queue) {
      if (card.targetId === current && queue.length > 1) continue;
      const record = await store.getPuzzle(card.targetId);
      if (!record) continue;
      if (personalOnly && record.source !== 'personal') continue;
      return { entry: record, source: record.source };
    }
    return null;
  }

  /** Loads a specific puzzle by id (tests and the page API). */
  public async openPuzzle(id: string, source: StoredPuzzleRecord['source']): Promise<boolean> {
    const stored = await this.options.store.getPuzzle(id);
    const entry = stored ?? (source === 'lichess' ? await this.dataset.get(id) : null);
    if (!entry) return false;
    ++this.loadSeq;
    this.load(entry, stored?.source ?? source, false);
    return true;
  }

  private load(entry: PuzzleEntry | StoredPuzzleRecord, source: StoredPuzzleRecord['source'], practice: boolean): void {
    const seq = this.loadSeq;
    this.clearTimers();
    this.els.empty.hidden = true;
    const prepared = preparePuzzle(entry);
    this.loaded = { source, entry, prepared, session: new PuzzleSession(prepared), practice, recorded: false };
    this.lastResult = null;
    this.board.clearUserAnnotations();
    this.board.setFlipped(prepared.playerColor === 'b');
    this.board.setInteractiveColor('none');
    this.board.setPosition(prepared.setupFen, { animate: false });
    this.root.setAttribute('data-puzzle-id', entry.id);
    this.root.setAttribute('data-puzzle-state', 'setup');
    this.renderSource();
    this.els.line.textContent = '';
    this.setStatus(`${SIDE[prepared.playerColor === 'w' ? 'b' : 'w']} moves…`, 'setup');
    this.els.prompt.textContent = '';
    this.updateButtons();
    this.later(() => {
      if (seq !== this.loadSeq || !this.loaded) return;
      // A fresh session starts its clock once the puzzle position is on the board
      this.loaded.session = new PuzzleSession(prepared);
      this.board.setPosition(prepared.startFen, { lastMove: prepared.setupMove, animate: true });
      this.playSound(prepared.setupMove, new RulesAdapter(prepared.startFen).inCheck());
      this.board.setInteractiveColor(prepared.playerColor);
      this.root.setAttribute('data-puzzle-state', 'playing');
      this.setStatus(`Find the best move for ${SIDE[prepared.playerColor]}`, 'playing');
      this.renderPrompt();
      this.updateButtons();
    }, SETUP_DELAY_MS);
  }

  private renderSource(): void {
    const l = this.loaded;
    if (!l) return;
    const e = l.entry as StoredPuzzleRecord;
    if (l.source === 'personal') {
      const ply = e.ply ?? 1;
      this.els.source.textContent = `From my game ${e.gameLabel ?? ''} · move ${Math.ceil(ply / 2)}${ply % 2 === 0 ? '…' : '.'}`;
    } else {
      this.els.source.textContent = `Lichess puzzle ${e.id} · rated ${e.rating}${this.themesText(e.themes)}`;
    }
  }

  private themesText(themes: readonly string[]): string {
    if (!this.info) return '';
    const labels = this.info.themes.filter((t) => themes.includes(t.id)).map((t) => t.label);
    return labels.length > 0 ? ` · ${labels.slice(0, 3).join(', ')}` : '';
  }

  private renderPrompt(): void {
    const l = this.loaded;
    if (!l) return;
    const e = l.entry as StoredPuzzleRecord;
    if (l.source === 'personal' && e.playedSan) {
      const cls = e.classification ? ` (${e.classification})` : '';
      this.els.prompt.textContent = `In the game I played ${e.playedSan}${cls}. What was better?`;
    } else {
      const n = Math.ceil(l.prepared.solution.length / 2);
      this.els.prompt.textContent = n === 1 ? 'One move wins.' : `${n} moves to find.`;
    }
  }

  private handleMove(move: MoveInput): void {
    const l = this.loaded;
    if (!l || l.session.status !== 'playing') return;
    const seq = this.loadSeq;
    const fenBefore = l.session.fen;
    const uci = moveInputToUci(move);
    const result = l.session.play(uci);
    switch (result.kind) {
      case 'illegal':
      case 'not-playing':
        this.board.setPosition(fenBefore, { animate: false });
        return;
      case 'correct': {
        const played = playUci(fenBefore, result.uci);
        this.board.setPosition(played.adapter, { lastMove: played.move, wasDragged: true });
        this.playSound(played.move, played.adapter.inCheck());
        if (result.solved) {
          this.finishSolved(false);
          return;
        }
        this.board.setInteractiveColor('none');
        this.board.clearUserAnnotations();
        this.root.setAttribute('data-puzzle-state', 'reply');
        this.setStatus('Best move! Keep going.', 'correct');
        const reply = result.reply!;
        this.later(() => {
          if (seq !== this.loadSeq) return;
          const r = playUci(played.adapter.fen(), reply);
          this.board.setPosition(r.adapter, { lastMove: r.move, animate: true });
          this.playSound(r.move, r.adapter.inCheck());
          this.board.setInteractiveColor(l.prepared.playerColor);
          this.root.setAttribute('data-puzzle-state', 'playing');
          this.setStatus(`Find the best move for ${SIDE[l.prepared.playerColor]}`, 'playing');
          this.updateButtons();
        }, REPLY_DELAY_MS);
        this.updateButtons();
        return;
      }
      case 'solved-alternative': {
        const played = playUci(fenBefore, result.uci);
        this.board.setPosition(played.adapter, { lastMove: played.move, wasDragged: true });
        this.playSound(played.move, true);
        this.finishSolved(true);
        return;
      }
      case 'check': {
        const played = playUci(fenBefore, result.uci);
        this.board.setPosition(played.adapter, { lastMove: played.move, wasDragged: true });
        this.playSound(played.move, played.adapter.inCheck());
        this.board.setInteractiveColor('none');
        this.root.setAttribute('data-puzzle-state', 'checking');
        this.setStatus('Not the expected move. Checking it…', 'checking');
        this.updateButtons();
        void this.checkAlternative(result.fen, result.uci, result.expected, l.prepared.endsInMate).then((verdict) => {
          if (seq !== this.loadSeq || l.session.status !== 'checking') return;
          l.session.resolveAlternative(verdict.accepted);
          if (verdict.accepted) {
            this.finishSolved(true);
            return;
          }
          this.root.setAttribute('data-puzzle-state', 'wrong');
          this.setStatus(verdict.error ? `Couldn't check that move (${verdict.error}). Try again.` : 'That’s not it. Try again.', 'wrong');
          this.guard(this.record());
          this.later(() => {
            if (seq !== this.loadSeq || l.session.status !== 'playing') return;
            this.board.setPosition(l.session.fen, { animate: true });
            this.board.setInteractiveColor(l.prepared.playerColor);
            this.root.setAttribute('data-puzzle-state', 'playing');
            this.updateButtons();
          }, WRONG_MOVE_MS);
        });
        return;
      }
    }
  }

  /** Whether a move other than the solution also wins, asked of the engine. */
  private async checkAlternative(
    fen: string,
    uci: string,
    expected: string,
    matePuzzle: boolean,
  ): Promise<AlternativeVerdict & { error?: string }> {
    const after = playUci(fen, uci).adapter;
    if (after.isGameOver()) return { accepted: false };
    const scoreAfter = async (move: string): Promise<UciScore | null> => {
      const res = await this.options.engine.analyze({
        fen,
        moves: [move],
        movetime: ALTERNATIVE_MOVETIME_MS,
        multipv: 1,
        priority: 'live',
      });
      const s = res.lines[0]?.score;
      // The engine scores the opponent's position; the player's view is the negation
      return s ? { type: s.type, value: -s.value } : null;
    };
    try {
      const altScore = await scoreAfter(uci);
      const needsSolution = !matePuzzle && !(altScore?.type === 'mate');
      const solutionScore = needsSolution ? await scoreAfter(expected) : null;
      return judgeAlternative({ givesMate: false, altScore, solutionScore, matePuzzle });
    } catch (err) {
      return { accepted: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private finishSolved(alternative: boolean): void {
    const l = this.loaded;
    if (!l) return;
    this.board.setInteractiveColor('none');
    this.root.setAttribute('data-puzzle-state', 'solved');
    const clean = l.session.outcome?.solved;
    this.setStatus(
      alternative ? (clean ? 'Solved! That also wins.' : 'That also wins — solved on a later try.') : clean ? 'Solved!' : 'Solved on a later try.',
      'solved',
    );
    this.options.audio.playGameOver(true);
    this.showLine();
    this.guard(this.record());
    this.updateButtons();
  }

  private showHint(): void {
    const l = this.loaded;
    if (!l) return;
    const square = l.session.hint();
    if (!square) return;
    this.board.setUserAnnotations([], [{ square, color: 'G' }]);
    this.setStatus('Hint: move the highlighted piece.', 'playing');
    this.updateButtons();
  }

  private showSolution(): void {
    const l = this.loaded;
    if (!l) return;
    const seq = this.loadSeq;
    const rest = l.session.showSolution();
    if (rest.length === 0) return;
    this.board.setInteractiveColor('none');
    this.board.clearUserAnnotations();
    this.root.setAttribute('data-puzzle-state', 'shown');
    this.setStatus('Solution shown.', 'shown');
    this.showLine();
    this.guard(this.record());
    this.updateButtons();
    let fen = l.session.fen;
    rest.forEach((uci, i) => {
      this.later(() => {
        if (seq !== this.loadSeq) return;
        const r = playUci(fen, uci);
        fen = r.adapter.fen();
        this.board.setPosition(r.adapter, { lastMove: r.move, animate: true });
        this.playSound(r.move, r.adapter.inCheck());
      }, 200 + i * 600);
    });
  }

  private retry(): void {
    const l = this.loaded;
    if (!l) return;
    ++this.loadSeq;
    this.load(l.entry, l.source, true);
    this.setStatus('Practice: this try is not recorded.', 'setup');
  }

  private analyze(): void {
    const l = this.loaded;
    if (!l) return;
    const title = l.source === 'personal' ? `Puzzle from my game ${(l.entry as StoredPuzzleRecord).gameLabel ?? ''}` : `Lichess puzzle ${l.entry.id}`;
    this.options.onAnalyze(puzzlePgn(l.prepared, title), 1);
  }

  /** The solution (and for personal puzzles the engine's line), once the puzzle is over. */
  private showLine(): void {
    const l = this.loaded;
    if (!l) return;
    const e = l.entry as StoredPuzzleRecord;
    const line =
      l.source === 'personal' && e.bestLineSan && e.bestLineSan.length > 0 ? e.bestLineSan : l.prepared.solutionSan;
    const explanation = l.source === 'personal' && e.explanation ? ` ${e.explanation}` : '';
    this.els.line.textContent = `${l.source === 'personal' ? 'Best line' : 'Solution'}: ${numberedLine(l.prepared.startFen, line)}.${explanation}`;
  }

  /** Records the attempt's outcome once it is decided (never for a practice retry). */
  private async record(): Promise<void> {
    const l = this.loaded;
    const outcome: AttemptOutcome | null = l?.session.outcome ?? null;
    if (!l || !outcome || l.recorded || l.practice) return;
    l.recorded = true;
    const result = await this.options.store.recordAttempt(l.entry, l.source, outcome);
    if (this.loaded === l) {
      this.lastResult = result;
      this.root.setAttribute('data-recorded', result.rated ? 'rated' : 'unrated');
      await this.renderStats();
    }
  }

  private async renderStats(): Promise<void> {
    const rating = await this.options.store.getRating();
    const r = this.lastResult;
    const change = r?.rated ? Math.round(r.ratingAfter) - Math.round(r.ratingBefore) : null;
    this.els.rating.textContent = String(Math.round(rating.rating));
    this.els.rating.setAttribute('data-change', change === null ? '' : String(change));
    const changeText = change === null ? '' : ` (${change >= 0 ? '+' : '−'}${Math.abs(change)})`;
    const today = await this.options.store.todaySummary();
    const due = today.dueReviews.personal + today.dueReviews.lichess;
    this.els.todayDue.textContent = String(due);
    this.els.todayNew.textContent = String(today.newPersonal);
    this.els.todayRated.textContent = `${today.ratedSolvedToday}/${today.ratedToday}`;
    this.els.todayNew.parentElement?.setAttribute('title', `${today.totalPersonal} puzzles from my games in all`);
    this.els.stats.innerHTML = `
      <div><dt>My puzzle rating</dt><dd data-testid="puzzle-stat-rating">${Math.round(rating.rating)} ±${Math.round(rating.rd)}${changeText}</dd></div>
    `;
  }

  private showEmpty(): void {
    this.loaded = null;
    this.board.setInteractiveColor('none');
    this.board.clearUserAnnotations();
    this.root.removeAttribute('data-puzzle-id');
    this.root.setAttribute('data-puzzle-state', 'empty');
    this.els.prompt.textContent = '';
    this.els.source.textContent = '';
    this.els.line.textContent = '';
    const actions: Array<[string, string, () => void]> = [];
    let text: string;
    if (this.mode === 'review') {
      text = 'No reviews are due. Puzzles you miss come back here on a spaced-repetition schedule.';
      actions.push(['My mistakes', 'btn-puzzle-empty-mistakes', () => void this.start('mistakes')]);
      actions.push(['Rated puzzles', 'btn-puzzle-empty-rated', () => void this.start('rated')]);
    } else if (this.mode === 'mistakes') {
      text =
        'No puzzles from my games are due. Mistakes, Blunders and Misses in my analyzed games become puzzles (my side only, recognized by my usernames).';
      actions.push(['Open the Games list', 'btn-puzzle-empty-games', () => this.options.onOpenGames()]);
      actions.push(['Rated puzzles', 'btn-puzzle-empty-rated', () => void this.start('rated')]);
    } else {
      text = 'Every bundled puzzle of this theme has been tried. Pick another theme.';
    }
    this.els.emptyText.textContent = text;
    this.els.emptyActions.replaceChildren(
      ...actions.map(([label, testId, fn]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wc-btn wc-btn-secondary wc-btn-sm';
        b.textContent = label;
        b.setAttribute('data-testid', testId);
        b.addEventListener('click', fn);
        return b;
      }),
    );
    this.els.empty.hidden = false;
    this.setStatus(`${MODE_LABEL[this.mode]}: nothing to do right now`, 'empty');
    this.updateButtons();
  }

  private setStatus(text: string, state: string): void {
    this.els.status.textContent = text;
    this.els.status.setAttribute('data-state', state);
  }

  private updateButtons(): void {
    const s = this.loaded?.session;
    const status = s?.status;
    // Board animations (the setup move, a reply, a wrong move being taken back) finish first
    const boardState = this.root.getAttribute('data-puzzle-state');
    const onTurn = status === 'playing' && boardState === 'playing';
    this.els.hint.disabled = !onTurn;
    this.els.solution.disabled = !onTurn;
    this.els.retry.disabled = !s || (status !== 'solved' && status !== 'shown' && !s.outcome);
    this.els.analyze.disabled = !this.loaded;
    this.els.next.disabled = status === 'checking';
    const over = !s || status === 'solved' || status === 'shown';
    this.els.next.classList.toggle('wc-btn-primary', over);
    this.els.next.classList.toggle('wc-btn-secondary', !over);
    this.els.next.setAttribute('data-ready', String(over));
    this.menu.setDisabled('retry', this.els.retry.disabled);
    this.menu.setDisabled('analyze', this.els.analyze.disabled);
  }

  private playSound(move: ExecutedMove, check: boolean): void {
    const audio = this.options.audio;
    if (check) audio.playCheck();
    else if (move.isCapture) audio.playShatter();
    else audio.playSlide(CathedralAudio.shouldPieceLevitate(move.piece));
  }

  private later(fn: () => void, ms: number): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private guard(p: Promise<unknown>): void {
    p.catch((err: unknown) => this.setStatus(`Could not save progress: ${err instanceof Error ? err.message : String(err)}`, 'error'));
  }
}
