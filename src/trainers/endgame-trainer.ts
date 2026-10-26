import type { EndgamePositionEntry } from '../core/datasets';
import type { ExecutedMove, MoveInput, Square } from '../core/rules';
import { EngineCancelledError, type EngineClient } from '../engine/engine-client';
import type { UciScore } from '../engine/uci-parser';
import { CathedralAudio } from '../render/audio';
import type { BoardRenderer } from '../render/board-renderer';
import { icon } from '../ui/components/icons';
import { Menu } from '../ui/components/menu';
import { EndgameSession, type EndgameEnd } from './endgame-session';
import type { EndgameRecordResult, EndgameStore } from './endgame-store';
import { ENDGAMES, GOAL_LABEL, endgameGoal, getEndgame, goalText } from './endgames';
import {
  Timers,
  createTrainerBoard,
  createTrainerRoot,
  escapeHtml,
  fromExecuted,
  negateScore,
  playMoveSound,
  plural,
  trainerLayoutHtml,
} from './trainer-kit';

/** Engine time for the opponent's move (and the verdict on a conversion), a hint and a draw offer. */
export const OPPONENT_MOVETIME_MS = 200;
export const HINT_MOVETIME_MS = 300;
export const DRAW_MOVETIME_MS = 300;
/** A short pause before the opponent's move is shown. */
const REPLY_DELAY_MS = 150;

export interface EndgameTrainerOptions {
  container: HTMLElement;
  store: EndgameStore;
  engine: Pick<EngineClient, 'analyze'>;
  audio: CathedralAudio;
}

export type EndgameState = 'idle' | 'playing' | 'thinking' | 'reached' | 'failed';

function toSquares(uci: string): { from: Square; to: Square } {
  return { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square };
}

/**
 * The endgame trainer: the six curated positions, each played out against the engine from the
 * side to move. A drill ends in the target result (mate, a decided conversion, or the draw) or
 * in a miss; either way it is recorded, with the moves it took against the best possible
 * where the position ends in mate, and its card is graded.
 */
export class EndgameTrainer {
  private readonly root: HTMLElement;
  private readonly board: BoardRenderer;
  private readonly timers = new Timers();
  private menu!: Menu;
  private entry: EndgamePositionEntry | null = null;
  private session: EndgameSession | null = null;
  private state: EndgameState = 'idle';
  /** Bumped by every load, finish and give-up, so a late engine answer for an old drill is dropped. */
  private seq = 0;
  private busy = false;
  private hintMove: string | null = null;
  private lastRecord: EndgameRecordResult | null = null;
  private els!: {
    list: HTMLElement;
    status: HTMLElement;
    pill: HTMLElement;
    goal: HTMLElement;
    note: HTMLElement;
    result: HTMLElement;
    hint: HTMLButtonElement;
    draw: HTMLButtonElement;
    restart: HTMLButtonElement;
    giveUp: HTMLButtonElement;
    flip: HTMLButtonElement;
    next: HTMLButtonElement;
    done: HTMLElement;
  };

  constructor(private readonly options: EndgameTrainerOptions) {
    this.root = createTrainerRoot(options.container, 'endgame-trainer', 'wc-endgame-layout');
    this.root.innerHTML = trainerLayoutHtml({
      testId: 'endgame-trainer',
      label: 'Endgames',
      rootClass: '',
      panelClass: 'wc-endgame-panel',
      boardMountTestId: 'endgame-board-mount',
      body: `
        <div class="wc-endgame-list" role="radiogroup" aria-label="Endgame positions" data-testid="endgame-list"></div>
        <div class="wc-puzzle-card wc-trainer-card">
          <div class="wc-status-header">
            <div class="wc-status-banner" data-testid="endgame-status" role="status" aria-live="polite" data-state="idle">Pick a position</div>
            <div class="wc-eval-pill" data-testid="endgame-moves" title="Your moves in this drill">0 moves</div>
          </div>
          <p class="wc-trainer-text" data-testid="endgame-goal"></p>
          <p class="wc-trainer-text wc-trainer-muted" data-testid="endgame-note"></p>
          <p class="wc-trainer-text" data-testid="endgame-result"></p>
        </div>
        <div class="wc-action-bar" data-testid="endgame-actions">
          <button type="button" class="wc-btn wc-btn-secondary wc-btn-action" data-testid="btn-endgame-hint" title="Shows the engine's move (a drill with a hint is graded Hard at best)">${icon('hint')}Hint</button>
          <button type="button" class="wc-btn wc-btn-secondary wc-btn-action" data-testid="btn-endgame-draw" hidden>${icon('handshake')}Offer draw</button>
        </div>`,
      foot: `
        <dl class="wc-puzzle-stats" data-testid="endgame-stats"><div><dt>Completed</dt><dd data-testid="endgame-stat-done">–</dd></div></dl>
        <button type="button" class="wc-btn wc-btn-secondary wc-btn-lg wc-grow" data-testid="btn-endgame-next">Next position${icon('next')}</button>`,
    });
    const mount = this.root.querySelector('[data-testid="endgame-board-mount"]') as HTMLElement;
    this.board = createTrainerBoard(mount, options.audio, (move) => this.handleMove(move));
    const q = <T extends HTMLElement>(id: string) => this.root.querySelector(`[data-testid="${id}"]`) as T;
    this.menu = new Menu(
      q('endgame-actions'),
      [
        { id: 'restart', label: 'Restart this position', testId: 'btn-endgame-restart', icon: 'undo', onSelect: () => this.restart() },
        { id: 'giveup', label: 'Give up', testId: 'btn-endgame-giveup', icon: 'flag', onSelect: () => this.giveUp() },
        { id: 'flip', label: 'Flip board', testId: 'btn-endgame-flip', icon: 'flip', onSelect: () => this.board.setFlipped(!this.board.isFlipped()) },
      ],
      { testId: 'endgame-menu', label: 'More endgame actions' },
    );
    this.els = {
      list: q('endgame-list'),
      status: q('endgame-status'),
      pill: q('endgame-moves'),
      goal: q('endgame-goal'),
      note: q('endgame-note'),
      result: q('endgame-result'),
      hint: q('btn-endgame-hint'),
      draw: q('btn-endgame-draw'),
      restart: q('btn-endgame-restart'),
      giveUp: q('btn-endgame-giveup'),
      flip: q('btn-endgame-flip'),
      next: q('btn-endgame-next'),
      done: q('endgame-stat-done'),
    };
    this.els.hint.addEventListener('click', () => void this.showHint());
    this.els.draw.addEventListener('click', () => void this.offerDraw());
    this.els.next.addEventListener('click', () => void this.openNext());
    this.els.list.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('[data-endgame-id]');
      const entry = item ? getEndgame(item.dataset.endgameId ?? '') : undefined;
      if (entry) this.load(entry);
    });
    this.root.setAttribute('data-endgame-state', this.state);
    this.updateButtons();
    void this.renderList();
  }

  public getBoard(): BoardRenderer {
    return this.board;
  }

  public getState(): EndgameState {
    return this.state;
  }

  public getEntry(): EndgamePositionEntry | null {
    return this.entry;
  }

  public getSession(): EndgameSession | null {
    return this.session;
  }

  /** The engine's move shown by the last hint (UCI), until the position changes. */
  public getHint(): string | null {
    return this.hintMove;
  }

  public getLastRecord(): EndgameRecordResult | null {
    return this.lastRecord;
  }

  /** Opens the position that most needs a drill: one that is due, else one not completed yet. */
  public async start(): Promise<void> {
    await this.openNext(true);
  }

  /** Loads a position by id. */
  public open(id: string): boolean {
    const entry = getEndgame(id);
    if (!entry) return false;
    this.load(entry);
    return true;
  }

  private async pickNext(first: boolean): Promise<EndgamePositionEntry> {
    const now = Date.now();
    const currentId = this.entry?.id;
    const [cards, progress] = await Promise.all([this.options.store.listCards(), this.options.store.progress()]);
    const due = cards
      .filter((c) => c.dueDate <= now && c.targetId !== currentId)
      .sort((a, b) => a.dueDate - b.dueDate)
      .map((c) => getEndgame(c.targetId))
      .find((e): e is EndgamePositionEntry => e !== undefined);
    if (due) return due;
    const at = currentId ? ENDGAMES.findIndex((e) => e.id === currentId) : -1;
    const rotated = [...ENDGAMES.slice(at + 1), ...(first ? [] : ENDGAMES.slice(0, at + 1))];
    return rotated.find((e) => progress.get(e.id)?.completed !== 1) ?? rotated[0] ?? ENDGAMES[0]!;
  }

  public async openNext(first = false): Promise<void> {
    this.load(await this.pickNext(first));
  }

  /** Opens a position that is due now (for the Today screen). False when none is. */
  public async openDue(now: number = Date.now()): Promise<boolean> {
    const cards = (await this.options.store.listCards()).filter((c) => c.dueDate <= now).sort((a, b) => a.dueDate - b.dueDate);
    const entry = cards.map((c) => getEndgame(c.targetId)).find((e): e is EndgamePositionEntry => e !== undefined);
    if (!entry) return false;
    this.load(entry);
    return true;
  }

  private load(entry: EndgamePositionEntry): void {
    ++this.seq;
    this.timers.clear();
    this.busy = false;
    this.entry = entry;
    this.session = new EndgameSession(entry);
    this.hintMove = null;
    this.lastRecord = null;
    this.root.removeAttribute('data-hint');
    this.root.setAttribute('data-endgame-id', entry.id);
    this.board.clearUserAnnotations();
    this.board.setFlipped(this.session.player === 'b');
    this.board.setPosition(entry.fen, { animate: false });
    this.board.setInteractiveColor(this.session.player);
    this.setState('playing');
    this.setStatus(`Your move as ${this.session.player === 'w' ? 'White' : 'Black'}`, 'playing');
    this.els.goal.textContent = goalText(entry);
    this.els.note.textContent = entry.description;
    this.els.result.textContent = '';
    this.els.pill.textContent = '0 moves';
    this.els.draw.hidden = this.session.goal !== 'hold';
    this.updateButtons();
    void this.renderList();
  }

  private restart(): void {
    if (this.entry) this.load(this.entry);
  }

  /** The trainer's screen went away: a drill not finished is dropped (nothing is recorded) and the position starts again. */
  public suspend(): void {
    ++this.seq;
    this.timers.clear();
    this.busy = false;
    if (this.entry && this.session && !this.session.over) this.load(this.entry);
  }

  private setState(state: EndgameState): void {
    this.state = state;
    this.root.setAttribute('data-endgame-state', state);
  }

  private setStatus(text: string, state: string): void {
    this.els.status.textContent = text;
    this.els.status.setAttribute('data-state', state);
  }

  private showMove(move: ExecutedMove, dragged: boolean): void {
    const s = this.session!;
    this.board.setPosition(s.fen, { lastMove: move, ...(dragged ? { wasDragged: true } : { animate: true }) });
    playMoveSound(this.options.audio, fromExecuted(move), /[+#]$/.test(move.san));
    this.els.pill.textContent = plural(s.moves, 'move');
  }

  private handleMove(move: MoveInput): void {
    const s = this.session;
    if (!s) return;
    if (this.busy || s.over) {
      // Not the player's turn to move: the piece goes back
      this.board.setPosition(s.fen, { animate: false });
      return;
    }
    const seq = this.seq;
    const result = s.playerMove(move);
    switch (result.kind) {
      case 'illegal':
      case 'not-playing':
        this.board.setPosition(s.fen, { animate: false });
        return;
      case 'ended':
        this.showMove(result.move, true);
        this.finish(result.end);
        return;
      case 'continue':
        this.showMove(result.move, true);
        void this.answer(result.check, seq);
        return;
    }
  }

  private async analyze(fen: string, movetime: number): Promise<{ bestMove: string | null; score: UciScore | null } | null> {
    try {
      const res = await this.options.engine.analyze({ fen, movetime, multipv: 1, priority: 'live' });
      return { bestMove: res.bestMove, score: res.lines[0]?.score ?? null };
    } catch (err) {
      if (err instanceof EngineCancelledError) return null;
      throw err;
    }
  }

  /** The engine's answer to the player's move: the verdict on a conversion, then its reply. */
  private async answer(check: boolean, seq: number): Promise<void> {
    const s = this.session!;
    this.busy = true;
    this.board.setInteractiveColor('none');
    this.board.setBestMoveArrow(null);
    this.hintMove = null;
    this.root.removeAttribute('data-hint');
    this.setState('thinking');
    this.setStatus('The engine is thinking…', 'thinking');
    this.updateButtons();
    let res: { bestMove: string | null; score: UciScore | null } | null;
    try {
      res = await this.analyze(s.fen, OPPONENT_MOVETIME_MS);
    } catch (err) {
      if (seq === this.seq) this.fail(err);
      return;
    }
    if (seq !== this.seq || !res) return;
    // The engine scores the side to move, the opponent: the player's view is the negation
    const forPlayer = res.score ? negateScore(res.score) : null;
    if (check) {
      const end = s.judgeConversion(forPlayer);
      if (end) {
        this.finish(end);
        return;
      }
    }
    const best = res.bestMove;
    if (!best) {
      this.fail(new Error('the engine gave no move'));
      return;
    }
    this.timers.later(() => {
      if (seq !== this.seq) return;
      const r = s.opponentMove(best);
      if (r.kind === 'illegal') {
        this.fail(new Error(`the engine's move ${best} is not legal`));
        return;
      }
      this.showMove(r.move, false);
      if (r.kind === 'ended') {
        this.finish(r.end);
        return;
      }
      this.busy = false;
      this.board.setInteractiveColor(s.player);
      this.setState('playing');
      if (s.slipping(forPlayer)) {
        this.setStatus(s.goal === 'hold' ? 'Careful: the engine is pressing. Find the defence.' : 'Careful: the engine sees only equality now.', 'warn');
      } else {
        this.setStatus(`Your move as ${s.player === 'w' ? 'White' : 'Black'}`, 'playing');
      }
      this.updateButtons();
    }, REPLY_DELAY_MS);
  }

  private fail(err: unknown): void {
    this.busy = false;
    this.setState('failed');
    this.setStatus(`The engine could not answer: ${err instanceof Error ? err.message : String(err)}`, 'error');
    this.board.setInteractiveColor('none');
    this.updateButtons();
  }

  private async showHint(): Promise<void> {
    const s = this.session;
    if (!s || s.over || this.busy) return;
    const seq = this.seq;
    const fen = s.fen;
    this.busy = true;
    this.board.setInteractiveColor('none');
    this.updateButtons();
    let res: { bestMove: string | null } | null = null;
    try {
      res = await this.analyze(fen, HINT_MOVETIME_MS);
    } catch (err) {
      if (seq === this.seq) this.fail(err);
      return;
    }
    if (seq !== this.seq || !res) return;
    this.busy = false;
    this.board.setInteractiveColor(s.player);
    if (res.bestMove && s.fen === fen) {
      s.useHint();
      this.hintMove = res.bestMove;
      this.root.setAttribute('data-hint', res.bestMove);
      this.board.setBestMoveArrow(toSquares(res.bestMove));
      this.setStatus('Hint: the arrow shows the move.', 'playing');
    }
    this.updateButtons();
  }

  private async offerDraw(): Promise<void> {
    const s = this.session;
    if (!s || s.over || this.busy || s.goal !== 'hold') return;
    const seq = this.seq;
    this.busy = true;
    this.board.setInteractiveColor('none');
    this.updateButtons();
    let res: { score: UciScore | null } | null;
    try {
      res = await this.analyze(s.fen, DRAW_MOVETIME_MS);
    } catch (err) {
      if (seq === this.seq) this.fail(err);
      return;
    }
    if (seq !== this.seq || !res) return;
    this.busy = false;
    this.board.setInteractiveColor(s.player);
    // It is the player's turn, so the engine's score is the player's own
    const r = s.offerDraw(res.score);
    switch (r.kind) {
      case 'agreed':
        this.finish(r.end);
        return;
      case 'too-early':
        this.setStatus(`Too early to offer a draw: make ${plural(r.movesLeft, 'more move')} first.`, 'playing');
        break;
      case 'declined':
        this.setStatus('The engine declines: it still sees chances. Keep defending.', 'warn');
        break;
      case 'not-a-draw':
        break;
    }
    this.updateButtons();
  }

  private giveUp(): void {
    const s = this.session;
    if (!s || s.over) return;
    ++this.seq;
    this.timers.clear();
    this.finish(s.giveUp());
  }

  /** The drill is over: say how it went, record it, and grade its card. */
  private finish(end: EndgameEnd): void {
    const s = this.session!;
    const entry = this.entry!;
    ++this.seq;
    this.timers.clear();
    this.busy = false;
    this.board.setInteractiveColor('none');
    this.board.setBestMoveArrow(null);
    this.setState(end.reached ? 'reached' : 'failed');
    this.setStatus(end.reached ? 'Target reached!' : 'Not this time', end.reached ? 'solved' : 'wrong');
    const moveText = endgameGoal(entry) === 'mate' && end.reached ? ` Mate in ${plural(s.moves, 'move')}; best possible is ${entry.optimalMoves}.` : '';
    this.els.result.textContent = `${end.message}${moveText}`;
    this.options.audio.playGameOver(end.reached);
    this.updateButtons();
    void this.options.store.record(entry, s.outcome).then(
      (result) => {
        if (this.session !== s) return;
        this.lastRecord = result;
        if (result.newBest) this.els.result.textContent = `${this.els.result.textContent} New best!`;
        void this.renderList();
      },
      (err: unknown) => {
        if (this.session === s) this.els.result.textContent = `${this.els.result.textContent} (Progress could not be saved: ${err instanceof Error ? err.message : String(err)})`;
      },
    );
  }

  private updateButtons(): void {
    const s = this.session;
    const over = !s || s.over;
    const onTurn = !!s && !over && !this.busy && this.state === 'playing';
    this.els.hint.disabled = !onTurn;
    this.els.draw.disabled = !onTurn;
    this.menu.setDisabled('restart', !s);
    this.menu.setDisabled('giveup', over);
    const ready = over && !!s;
    this.els.next.classList.toggle('wc-btn-primary', ready);
    this.els.next.classList.toggle('wc-btn-secondary', !ready);
    this.els.next.setAttribute('data-ready', String(ready));
  }

  private async renderList(): Promise<void> {
    const progress = await this.options.store.progress();
    const current = this.entry?.id;
    let done = 0;
    this.els.list.innerHTML = ENDGAMES.map((e) => {
      const p = progress.get(e.id);
      const completed = p?.completed === 1;
      if (completed) done++;
      const best =
        e.optimalMoves === null
          ? GOAL_LABEL[endgameGoal(e)]
          : `${GOAL_LABEL.mate} · ${p?.bestMoves != null ? `best ${p.bestMoves} · ` : ''}ideal ${e.optimalMoves}`;

      return `<button type="button" role="radio" class="wc-endgame-item" data-endgame-id="${e.id}" data-testid="endgame-item-${e.id}" aria-checked="${e.id === current}" data-completed="${completed}">
        <span class="wc-endgame-item-mark" aria-hidden="true">${completed ? '✓' : ''}</span>
        <span class="wc-endgame-item-main"><span class="wc-endgame-item-title">${escapeHtml(e.category)}</span><span class="wc-endgame-item-meta" title="${escapeHtml(best)}${p && p.attempts > 0 ? ` · ${plural(p.attempts, 'try', 'tries')}` : ''}">${escapeHtml(best)}</span></span>
        <span class="sr-only wc-sr-only">${completed ? 'completed' : 'not completed'}</span>
      </button>`;
    }).join('');
    this.els.done.textContent = `${done} of ${ENDGAMES.length}`;
  }

  public destroy(): void {
    this.timers.clear();
    ++this.seq;
    this.menu.destroy();
    this.board.destroy();
  }
}
