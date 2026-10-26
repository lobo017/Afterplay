import type { GameNode, GameTree } from '../core/game-tree';
import { writePgn } from '../core/pgn';
import { DEFAULT_POSITION, type Color, type MoveInput, type Square } from '../core/rules';
import { CathedralAudio } from '../render/audio';
import type { BoardRenderer } from '../render/board-renderer';
import { segmentedHtml } from '../ui/components/controls';
import { icon } from '../ui/components/icons';
import { Menu } from '../ui/components/menu';
import { Tabs, tabListHtml, tabPanelAttrs } from '../ui/components/tabs';
import {
  RepertoireDrill,
  addRepertoireMove,
  deleteRepertoireMove,
  importRepertoirePgn,
  repertoireStats,
  type RepertoireImportResult,
  type RepertoireIndex,
} from './repertoire';
import type { RepertoireDue, RepertoireStore } from './repertoire-store';
import { formatDueIn } from './today-screen';
import {
  Timers,
  createTrainerBoard,
  createTrainerRoot,
  escapeHtml,
  numberedSans,
  plural,
  soundForNode,
  trainerLayoutHtml,
} from './trainer-kit';

/** Pauses while a drill plays the opponent's moves and my moves in positions that aren't due. */
const AUTO_MOVE_MS = 420;
const AFTER_ANSWER_MS = 380;
const AFTER_REVEAL_MS = 950;

export interface RepertoireTrainerOptions {
  container: HTMLElement;
  store: RepertoireStore;
  audio: CathedralAudio;
}

export type RepertoireTab = 'build' | 'drill';
export type RepertoireDrillState = 'idle' | 'playing' | 'asking' | 'done';

const COLOR_LABEL: Record<Color, string> = { w: 'White', b: 'Black' };

function fromTo(node: GameNode): { from: Square; to: Square } {
  return { from: (node.from ?? node.uci.slice(0, 2)) as Square, to: (node.to ?? node.uci.slice(2, 4)) as Square };
}

/**
 * The repertoire trainer: a White and a Black repertoire, each a tree of moves built by playing
 * them on the board or importing a PGN (Build), and drilled with spaced repetition (Drill):
 * the opponent's moves are played for me, and in each position that is due I have to find a
 * move of the repertoire.
 */
export class RepertoireTrainer {
  private readonly root: HTMLElement;
  private readonly board: BoardRenderer;
  private readonly timers = new Timers();
  private tabs!: Tabs;
  private menu!: Menu;
  private color: Color = 'w';
  private tab: RepertoireTab = 'build';
  private index: RepertoireIndex | null = null;
  private cursor = '';
  private due: RepertoireDue | null = null;
  // Drill
  private drill: RepertoireDrill | null = null;
  private drillState: RepertoireDrillState = 'idle';
  private asked = 0;
  private right = 0;
  private wrongs = 0;
  private hinted = false;
  /** The drill under way (or just finished) is practice: every position is asked and no card is graded. */
  private practising = false;
  /** Bumped when a drill starts or stops, so a late timer or grade for an old one is dropped. */
  private seq = 0;
  /** The load of the current colour; every handler waits for it. */
  private loading: Promise<void> = Promise.resolve();
  private els!: {
    colors: HTMLElement;
    summary: HTMLElement;
    moves: HTMLElement;
    first: HTMLButtonElement;
    back: HTMLButtonElement;
    forward: HTMLButtonElement;
    last: HTMLButtonElement;
    del: HTMLButtonElement;
    importOpen: HTMLButtonElement;
    importBox: HTMLElement;
    importText: HTMLTextAreaElement;
    importFile: HTMLInputElement;
    importRun: HTMLButtonElement;
    importCancel: HTMLButtonElement;
    importResult: HTMLElement;
    exportBtn: HTMLButtonElement;
    footBuild: HTMLElement;
    footDrill: HTMLElement;
    due: HTMLElement;
    fresh: HTMLElement;
    lines: HTMLElement;
    status: HTMLElement;
    line: HTMLElement;
    prompt: HTMLElement;
    result: HTMLElement;
    hint: HTMLButtonElement;
    reveal: HTMLButtonElement;
    start: HTMLButtonElement;
    practise: HTMLButtonElement;
  };

  constructor(private readonly options: RepertoireTrainerOptions) {
    this.root = createTrainerRoot(options.container, 'repertoire-trainer', 'wc-repertoire-layout');
    const tabList = [
      { id: 'build', label: 'Build' },
      { id: 'drill', label: 'Drill' },
    ];
    this.root.innerHTML = trainerLayoutHtml({
      testId: 'repertoire-trainer',
      label: 'Repertoire',
      rootClass: '',
      panelClass: 'wc-repertoire-panel',
      boardMountTestId: 'rep-board-mount',
      head: tabListHtml('rep', tabList, 'build', 'Repertoire'),
      body: `
        ${segmentedHtml('color', 'rep-color', [{ value: 'w', label: 'White repertoire' }, { value: 'b', label: 'Black repertoire' }], 'w', 'Repertoire colour')}
        <section class="wc-tab-panel" ${tabPanelAttrs('rep', 'build', 'build')}>
          <p class="wc-trainer-text" data-testid="rep-summary"></p>
          <div class="wc-rep-moves" data-testid="rep-moves" aria-label="Moves of the repertoire"></div>
          <div class="wc-action-bar wc-rep-nav">
            <button type="button" class="wc-btn wc-btn-secondary wc-btn-icon" data-testid="btn-rep-first" aria-label="Start position" title="Start position">${icon('first')}</button>
            <button type="button" class="wc-btn wc-btn-secondary wc-btn-icon" data-testid="btn-rep-back" aria-label="Previous move" title="Previous move">${icon('back')}</button>
            <button type="button" class="wc-btn wc-btn-secondary wc-btn-icon" data-testid="btn-rep-forward" aria-label="Next move" title="Next move">${icon('next')}</button>
            <button type="button" class="wc-btn wc-btn-secondary wc-btn-icon" data-testid="btn-rep-last" aria-label="End of the line" title="End of the line">${icon('last')}</button>
            <span class="wc-grow"></span>
            <button type="button" class="wc-btn wc-btn-secondary wc-btn-action wc-btn-inline" data-testid="btn-rep-delete" title="Deletes this move and everything after it">${icon('close')}Delete move</button>
          </div>
          <div class="wc-rep-import" data-testid="rep-import" hidden>
            <textarea class="wc-textarea wc-rep-import-text" data-testid="rep-import-text" rows="6" spellcheck="false" aria-label="PGN to import" placeholder="Paste a PGN: every game and variation is added to the repertoire."></textarea>
            <div class="wc-action-bar">
              <button type="button" class="wc-btn wc-btn-primary wc-btn-sm" data-testid="btn-rep-import-run">Import</button>
              <label class="wc-btn wc-btn-secondary wc-btn-sm wc-rep-file">Open a PGN file…<input type="file" accept=".pgn,.txt,text/plain" class="wc-sr-only" data-testid="rep-import-file" /></label>
              <button type="button" class="wc-btn wc-btn-ghost wc-btn-sm" data-testid="btn-rep-import-cancel">Cancel</button>
            </div>
          </div>
          <p class="wc-trainer-text wc-trainer-muted" data-testid="rep-import-result" role="status"></p>
        </section>
        <section class="wc-tab-panel" ${tabPanelAttrs('rep', 'drill', 'build')}>
          <div class="wc-today-strip" aria-label="Repertoire to drill">
            <div class="wc-today-strip-item"><span class="wc-today-strip-n" data-testid="rep-drill-due">–</span><span class="wc-today-strip-l">due</span></div>
            <div class="wc-today-strip-item"><span class="wc-today-strip-n" data-testid="rep-drill-new">–</span><span class="wc-today-strip-l">new</span></div>
            <div class="wc-today-strip-item"><span class="wc-today-strip-n" data-testid="rep-drill-lines">–</span><span class="wc-today-strip-l">lines</span></div>
          </div>
          <div class="wc-puzzle-card wc-trainer-card">
            <div class="wc-status-header">
              <div class="wc-status-banner" data-testid="rep-status" role="status" aria-live="polite" data-state="idle">Start a drill</div>
            </div>
            <p class="wc-trainer-text" data-testid="rep-prompt"></p>
            <p class="wc-trainer-text wc-trainer-muted" data-testid="rep-line"></p>
            <p class="wc-trainer-text" data-testid="rep-result"></p>
          </div>
          <div class="wc-action-bar">
            <button type="button" class="wc-btn wc-btn-secondary wc-btn-action" data-testid="btn-rep-hint" title="Highlights the piece to move (graded Hard at best)">${icon('hint')}Hint</button>
            <button type="button" class="wc-btn wc-btn-secondary wc-btn-action" data-testid="btn-rep-reveal">Show answer</button>
          </div>
        </section>`,
      foot: `
        <div class="wc-rep-foot wc-action-bar wc-grow" data-testid="rep-foot-build">
          <button type="button" class="wc-btn wc-btn-secondary wc-btn-lg wc-grow" data-testid="btn-rep-import">${icon('upload')}Import PGN</button>
        </div>
        <div class="wc-rep-foot wc-action-bar wc-grow" data-testid="rep-foot-drill" hidden>
          <button type="button" class="wc-btn wc-btn-primary wc-btn-lg wc-grow" data-testid="btn-rep-start">Start drill</button>
          <button type="button" class="wc-btn wc-btn-secondary wc-btn-lg wc-grow" data-testid="btn-rep-practise" title="Asks every position of this repertoire. Nothing is graded, so your schedule stays as it is." hidden>Practise anyway</button>
        </div>`,
    });
    const mount = this.root.querySelector('[data-testid="rep-board-mount"]') as HTMLElement;
    this.board = createTrainerBoard(mount, options.audio, (move) => this.handleMove(move));
    const q = <T extends HTMLElement>(id: string) => this.root.querySelector(`[data-testid="${id}"]`) as T;
    this.menu = new Menu(
      q('rep-foot-build'),
      [{ id: 'export', label: 'Export as PGN', testId: 'btn-rep-export', icon: 'download', onSelect: () => this.exportPgn() }],
      { testId: 'rep-menu', label: 'More repertoire actions' },
    );
    this.els = {
      colors: this.root.querySelector('[data-seg="color"]') as HTMLElement,
      summary: q('rep-summary'),
      moves: q('rep-moves'),
      first: q('btn-rep-first'),
      back: q('btn-rep-back'),
      forward: q('btn-rep-forward'),
      last: q('btn-rep-last'),
      del: q('btn-rep-delete'),
      importOpen: q('btn-rep-import'),
      importBox: q('rep-import'),
      importText: q('rep-import-text'),
      importFile: q('rep-import-file'),
      importRun: q('btn-rep-import-run'),
      importCancel: q('btn-rep-import-cancel'),
      importResult: q('rep-import-result'),
      exportBtn: q('btn-rep-export'),
      footBuild: q('rep-foot-build'),
      footDrill: q('rep-foot-drill'),
      due: q('rep-drill-due'),
      fresh: q('rep-drill-new'),
      lines: q('rep-drill-lines'),
      status: q('rep-status'),
      line: q('rep-line'),
      prompt: q('rep-prompt'),
      result: q('rep-result'),
      hint: q('btn-rep-hint'),
      reveal: q('btn-rep-reveal'),
      start: q('btn-rep-start'),
      practise: q('btn-rep-practise'),
    };
    this.tabs = new Tabs(this.root, (id) => void this.onTab(id as RepertoireTab));
    this.els.colors.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('[role="radio"]');
      const value = item?.dataset.value;
      if (value === 'w' || value === 'b') void this.setColor(value);
    });
    this.els.moves.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-node-id]');
      if (btn?.dataset.nodeId) this.goTo(btn.dataset.nodeId);
    });
    this.els.first.addEventListener('click', () => this.goTo(this.index?.tree.root.id ?? ''));
    this.els.back.addEventListener('click', () => this.goBack());
    this.els.forward.addEventListener('click', () => this.goForward());
    this.els.last.addEventListener('click', () => this.goLast());
    this.els.del.addEventListener('click', () => this.deleteCurrent());
    this.els.importOpen.addEventListener('click', () => this.toggleImport(true));
    this.els.importCancel.addEventListener('click', () => this.toggleImport(false));
    this.els.importRun.addEventListener('click', () => void this.runImport(this.els.importText.value));
    this.els.importFile.addEventListener('change', () => {
      const file = this.els.importFile.files?.[0];
      if (!file) return;
      void file.text().then((text) => {
        this.els.importText.value = text;
        this.els.importFile.value = '';
      });
    });
    this.els.hint.addEventListener('click', () => this.showHint());
    this.els.reveal.addEventListener('click', () => this.reveal());
    this.els.start.addEventListener('click', () => void this.startDrill());
    this.els.practise.addEventListener('click', () => void this.startDrill(true));
    options.store.onChange(() => void this.refreshDue());
    // A restored backup replaces the repertoires: read them again
    options.store.onReload(() => {
      this.endDrill();
      this.loading = this.load();
    });
    this.root.setAttribute('data-rep-tab', this.tab);
    this.root.setAttribute('data-rep-color', this.color);
    this.root.setAttribute('data-rep-state', this.drillState);
    this.loading = this.load();
  }

  // ------------------------------------------------------------------ public API

  public getBoard(): BoardRenderer {
    return this.board;
  }

  public getColor(): Color {
    return this.color;
  }

  public getTab(): RepertoireTab {
    return this.tab;
  }

  public getDrillState(): RepertoireDrillState {
    return this.drillState;
  }

  public getDrill(): RepertoireDrill | null {
    return this.drill;
  }

  /** The repertoire tree being built (null until loaded). */
  public getTree(): GameTree | null {
    return this.index?.tree ?? null;
  }

  public ready(): Promise<void> {
    return this.loading;
  }

  public showTab(tab: RepertoireTab): void {
    this.tabs.select(tab);
  }

  public async setColor(color: Color): Promise<void> {
    await this.loading;
    if (color === this.color && this.index) return;
    this.color = color;
    this.root.setAttribute('data-rep-color', color);
    this.endDrill();
    this.loading = this.load();
    await this.loading;
  }

  /** Imports a PGN text into the current repertoire (what the Import button does). */
  public async importPgn(text: string): Promise<RepertoireImportResult> {
    await this.loading;
    return this.runImport(text);
  }

  /** Opens a drill on a repertoire with positions due (for the Today screen). False when none has. */
  public async openDue(): Promise<boolean> {
    await this.loading;
    for (const color of [this.color, this.color === 'w' ? 'b' : 'w'] as const) {
      const due = await this.options.store.due(color);
      if (due.ordered.length === 0) continue;
      await this.setColor(color);
      this.tabs.select('drill');
      await this.startDrill();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ loading and tabs

  private async load(): Promise<void> {
    const color = this.color;
    const index = await this.options.store.load(color);
    if (color !== this.color) return;
    this.index = index;
    this.cursor = index.tree.root.id;
    this.els.colors.querySelectorAll<HTMLElement>('[role="radio"]').forEach((el) => el.setAttribute('aria-checked', String(el.dataset.value === color)));
    this.board.clearUserAnnotations();
    this.board.setFlipped(color === 'b');
    this.showBuildPosition(false);
    this.renderBuild();
    await this.refreshDue();
    this.renderDrillIdle();
  }

  private async onTab(tab: RepertoireTab): Promise<void> {
    await this.loading;
    this.tab = tab;
    this.root.setAttribute('data-rep-tab', tab);
    this.els.footBuild.hidden = tab !== 'build';
    this.els.footDrill.hidden = tab !== 'drill';
    this.endDrill();
    if (tab === 'build') {
      this.board.setInteractiveColor('both');
      this.showBuildPosition(false);
    } else {
      this.board.setInteractiveColor('none');
      this.board.clearUserAnnotations();
      this.board.setPosition(DEFAULT_POSITION, { animate: false });
      this.renderDrillIdle();
      await this.refreshDue();
    }
  }

  private async refreshDue(): Promise<void> {
    if (!this.index) return;
    const color = this.color;
    const due = await this.options.store.due(color);
    if (color !== this.color) return;
    this.due = due;
    const stats = repertoireStats(this.index);
    this.els.due.textContent = String(due.reviews);
    this.els.fresh.textContent = String(due.fresh);
    this.els.lines.textContent = String(stats.lines);
    this.updateDrillButtons();
  }

  // ------------------------------------------------------------------ build

  private node(id: string): GameNode | undefined {
    return this.index?.tree.getNode(id);
  }

  private showBuildPosition(animate: boolean, last?: GameNode): void {
    const node = this.node(this.cursor) ?? this.index?.tree.root;
    if (!node) return;
    this.board.setInteractiveColor(this.tab === 'build' ? 'both' : 'none');
    this.board.setPosition(node.fen, {
      animate,
      lastMove: node.parentId !== null ? fromTo(node) : null,
      ...(last ? { wasDragged: true } : {}),
    });
  }

  private goTo(id: string): void {
    if (!this.node(id) || this.tab !== 'build') return;
    const prev = this.cursor;
    this.cursor = id;
    const node = this.node(id)!;
    // Stepping one move forward animates it
    const stepForward = node.parentId === prev && node.parentId !== null;
    this.showBuildPosition(stepForward);
    if (stepForward) soundForNode(this.options.audio, node);
    this.renderBuild();
  }

  private goBack(): void {
    const parent = this.node(this.cursor)?.parentId;
    if (parent) this.goTo(parent);
  }

  private goForward(): void {
    const next = this.node(this.cursor)?.children[0];
    if (next) this.goTo(next.id);
  }

  private goLast(): void {
    let node = this.node(this.cursor);
    while (node && node.children.length > 0) node = node.children[0];
    if (node) this.goTo(node.id);
  }

  private handleMove(move: MoveInput): void {
    if (this.tab === 'build') this.buildMove(move);
    else this.drillMove(move);
  }

  /** A move played on the board in Build: added to the repertoire (or followed when it is already there). */
  private buildMove(move: MoveInput): void {
    const index = this.index;
    if (!index) return;
    let added: { node: GameNode; created: boolean };
    try {
      added = addRepertoireMove(index.tree, this.cursor, move);
    } catch {
      this.showBuildPosition(false);
      return;
    }
    this.cursor = added.node.id;
    this.board.setPosition(added.node.fen, { lastMove: fromTo(added.node), wasDragged: true });
    soundForNode(this.options.audio, added.node);
    this.els.importResult.textContent = '';
    if (added.created) void this.save();
    this.renderBuild();
  }

  private async save(): Promise<void> {
    const index = this.index;
    if (!index) return;
    try {
      this.index = await this.options.store.save(this.color, index.tree);
    } catch (err) {
      this.els.importResult.textContent = `The repertoire could not be saved: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.renderBuild();
    await this.refreshDue();
  }

  private deleteCurrent(): void {
    const index = this.index;
    const node = this.node(this.cursor);
    if (!index || !node || node.parentId === null) return;
    const parent = node.parentId;
    if (deleteRepertoireMove(index.tree, node.id)) {
      this.cursor = parent;
      this.showBuildPosition(false);
      void this.save();
    }
  }

  private toggleImport(open: boolean): void {
    this.els.importBox.hidden = !open;
    if (open) this.els.importText.focus();
  }

  private async runImport(text: string): Promise<RepertoireImportResult> {
    const index = this.index!;
    const result = importRepertoirePgn(index.tree, text);
    const parts: string[] = [];
    if (result.imported > 0) parts.push(`Imported ${plural(result.imported, 'game')}: ${plural(result.added, 'new move')}.`);
    if (result.skipped.length > 0) parts.push(`Left out: ${result.skipped.join(' ')}`);
    this.els.importResult.textContent = parts.join(' ') || 'Nothing to import.';
    if (result.imported > 0) {
      this.els.importText.value = '';
      this.toggleImport(false);
      this.cursor = index.tree.root.id;
      this.showBuildPosition(false);
      await this.save();
    }
    return result;
  }

  private exportPgn(): void {
    const tree = this.index?.tree;
    if (!tree || tree.root.children.length === 0) return;
    const blob = new Blob([writePgn(tree)], { type: 'application/x-chess-pgn' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.color === 'w' ? 'white' : 'black'}-repertoire.pgn`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private renderBuild(): void {
    const index = this.index;
    if (!index) return;
    const stats = repertoireStats(index);
    const empty = stats.moves === 0;
    this.els.summary.textContent = empty
      ? `${COLOR_LABEL[this.color]} repertoire: empty. Play your moves and the replies you expect on the board, or import a PGN.`
      : `${COLOR_LABEL[this.color]} repertoire: ${plural(stats.moves, 'move')} in ${plural(stats.lines, 'line')}, ${plural(stats.myPositions, 'position')} to answer.`;
    this.els.moves.innerHTML = empty ? '' : this.movesHtml(index.tree.root, false);
    this.els.moves.hidden = empty;
    const node = this.node(this.cursor);
    this.els.back.disabled = !node || node.parentId === null;
    this.els.first.disabled = this.els.back.disabled;
    this.els.forward.disabled = !node || node.children.length === 0;
    this.els.last.disabled = this.els.forward.disabled;
    this.els.del.disabled = !node || node.parentId === null;
    this.menu.setDisabled('export', empty);
    this.keepCurrentInView();
  }

  /** Scrolls the move list (only it) so the current move shows. */
  private keepCurrentInView(): void {
    const box = this.els.moves;
    const current = box.querySelector<HTMLElement>('[aria-current="true"]');
    if (!current) return;
    const top = current.offsetTop - box.offsetTop;
    if (top < box.scrollTop) box.scrollTop = top - 4;
    else if (top + current.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + current.offsetHeight - box.clientHeight + 4;
  }

  /** The tree as a move list: the main line, with variations in brackets. */
  private movesHtml(parent: GameNode, needNumber: boolean): string {
    const kids = parent.children;
    if (kids.length === 0) return '';
    const [main, ...variations] = kids as [GameNode, ...GameNode[]];
    let html = this.moveHtml(main, needNumber);
    for (const v of variations) html += ` <span class="wc-rep-var">(${this.moveHtml(v, true)}${this.movesHtml(v, false)})</span>`;
    const rest = this.movesHtml(main, variations.length > 0);
    return rest ? `${html} ${rest}` : html;
  }

  private moveHtml(node: GameNode, needNumber: boolean): string {
    const white = node.moveColor !== 'b';
    const number = white ? `${node.moveNumber}. ` : needNumber ? `${node.moveNumber}… ` : '';
    const mine = node.moveColor === this.color;
    const current = node.id === this.cursor;
    return `${number ? `<span class="wc-rep-no">${number}</span>` : ''}<button type="button" class="wc-rep-move${mine ? ' wc-rep-mine' : ''}" data-node-id="${node.id}" data-testid="rep-move-${node.ply}-${escapeHtml(node.san)}"${current ? ' aria-current="true"' : ''}>${escapeHtml(node.san)}</button>`;
  }

  // ------------------------------------------------------------------ drill

  private setDrillStatus(text: string, state: string): void {
    this.els.status.textContent = text;
    this.els.status.setAttribute('data-state', state);
  }

  private setDrillState(state: RepertoireDrillState): void {
    this.drillState = state;
    this.root.setAttribute('data-rep-state', state);
    this.updateDrillButtons();
  }

  private renderDrillIdle(): void {
    this.els.prompt.textContent = '';
    this.els.line.textContent = '';
    this.els.result.textContent = '';
    const due = this.due;
    const stats = this.index ? repertoireStats(this.index) : null;
    if (!stats || stats.moves === 0) {
      this.setDrillStatus('Build a repertoire first', 'empty');
      this.els.prompt.textContent = `The ${COLOR_LABEL[this.color]} repertoire is empty. Add moves in Build, or import a PGN.`;
    } else if (due && due.ordered.length === 0) {
      this.setDrillStatus('Nothing due right now', 'empty');
      this.els.prompt.textContent = `${due.nextDueAt !== null ? `All caught up. The next position comes due ${formatDueIn(due.nextDueAt, Date.now())}.` : 'All caught up.'} You can still practise: nothing is graded.`;
    } else {
      this.setDrillStatus('Ready to drill', 'idle');
      this.els.prompt.textContent = due ? `${plural(due.reviews + due.fresh, 'position')} to answer.` : '';
    }
    this.setDrillState('idle');
  }

  private updateDrillButtons(): void {
    const asking = this.drillState === 'asking';
    this.els.hint.disabled = !asking;
    this.els.reveal.disabled = !asking;
    const hasWork = !!this.due && this.due.ordered.length > 0 && !!this.index && repertoireStats(this.index).moves > 0;
    const running = this.drillState === 'playing' || this.drillState === 'asking';
    // With nothing due, "Practise anyway" takes the place of "Start drill"
    const canPractise = !running && !hasWork && !!this.index && repertoireStats(this.index).myPositions > 0;
    this.els.start.hidden = canPractise;
    this.els.start.disabled = running || !hasWork;
    this.els.practise.hidden = !canPractise;
    // The one primary button is the one that starts something
    this.els.start.classList.toggle('wc-btn-primary', !running);
    this.els.start.classList.toggle('wc-btn-secondary', running);
    this.els.start.textContent = this.drillState === 'done' ? 'Next line' : 'Start drill';
    this.els.practise.classList.toggle('wc-btn-primary', canPractise);
    this.els.practise.classList.toggle('wc-btn-secondary', !canPractise);
    this.els.practise.textContent = this.drillState === 'done' && this.practising ? 'Practise another line' : 'Practise anyway';
  }

  /** The trainer's screen went away: a drill under way is dropped (answers already given stay graded). */
  public suspend(): void {
    if (this.drillState !== 'playing' && this.drillState !== 'asking') return;
    this.endDrill();
    this.board.clearUserAnnotations();
    this.board.setPosition(DEFAULT_POSITION, { animate: false });
    this.renderDrillIdle();
  }

  /** Starts a drill on what is due, or with `practise` on every position, ungraded (for when nothing is due). */
  public async startDrill(practise = false): Promise<void> {
    await this.loading;
    const index = this.index;
    if (!index) return;
    await this.refreshDue();
    const due = this.due;
    this.timers.clear();
    const seq = ++this.seq;
    const keys = practise ? index.myKeys : (due?.ordered ?? []);
    if (!due || keys.length === 0 || !RepertoireDrill.hasWork(index, new Set(keys))) {
      this.practising = false;
      this.renderDrillIdle();
      return;
    }
    this.practising = practise;
    this.drill = new RepertoireDrill(index, new Set(keys));
    this.asked = 0;
    this.right = 0;
    this.wrongs = 0;
    this.hinted = false;
    this.els.result.textContent = '';
    this.board.clearUserAnnotations();
    this.board.setFlipped(this.color === 'b');
    this.board.setPosition(DEFAULT_POSITION, { animate: false });
    this.board.setInteractiveColor('none');
    this.step(seq);
  }

  private endDrill(): void {
    ++this.seq;
    this.timers.clear();
    this.drill = null;
    this.practising = false;
    this.board.setInteractiveColor(this.tab === 'build' ? 'both' : 'none');
    if (this.drillState !== 'idle') this.setDrillState('idle');
  }

  /** Plays on until I am asked a question or the line ends. */
  private step(seq: number): void {
    const d = this.drill;
    if (!d || seq !== this.seq) return;
    if (d.done) {
      this.endLine();
      return;
    }
    if (d.asking) {
      this.ask();
      return;
    }
    this.setDrillState('playing');
    this.setDrillStatus('Playing the line…', 'playing');
    this.board.setInteractiveColor('none');
    const node = d.advance()!;
    this.timers.later(() => {
      if (seq !== this.seq) return;
      this.board.setPosition(node.fen, { lastMove: fromTo(node), animate: true });
      soundForNode(this.options.audio, node);
      this.timers.later(() => this.step(seq), AUTO_MOVE_MS);
    }, 120);
  }

  private ask(): void {
    const d = this.drill!;
    this.wrongs = 0;
    this.hinted = false;
    this.board.clearUserAnnotations();
    this.board.setInteractiveColor(this.color);
    this.setDrillState('asking');
    const sans = d.path.slice(1).map((n) => n.san);
    this.setDrillStatus(`Your move as ${COLOR_LABEL[this.color]}`, 'asking');
    this.els.prompt.textContent = sans.length === 0 ? 'What is your first move?' : 'What do you play here?';
    this.els.line.textContent = sans.length === 0 ? '' : numberedSans(DEFAULT_POSITION, sans);
    this.els.result.textContent = '';
  }

  private drillMove(move: MoveInput): void {
    const d = this.drill;
    if (!d || this.drillState !== 'asking') return;
    const seq = this.seq;
    const key = d.key;
    const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
    const res = d.answer(uci);
    if (res.kind === 'wrong') {
      this.wrongs++;
      this.board.setPosition(d.current.fen, { animate: false });
      this.setDrillStatus('Not a move from your repertoire. Try again.', 'wrong');
      return;
    }
    const grade = this.wrongs > 0 ? 1 : this.hinted ? 2 : 3;
    this.settle(key, grade, seq);
    this.board.clearUserAnnotations();
    this.board.setPosition(res.node.fen, { lastMove: fromTo(res.node), wasDragged: true });
    soundForNode(this.options.audio, res.node);
    this.board.setInteractiveColor('none');
    this.setDrillState('playing');
    this.setDrillStatus(grade === 3 ? 'Correct!' : this.practising ? 'Correct, but not first time.' : 'Correct, but it will come back.', 'correct');
    this.timers.later(() => this.step(seq), AFTER_ANSWER_MS);
  }

  /** Records the answer to one position: its card is graded now. */
  private settle(key: string, grade: 1 | 2 | 3, seq: number): void {
    this.asked++;
    if (grade === 3) this.right++;
    if (this.practising) return; // practice never touches the schedule
    void this.options.store.grade(this.color, key, grade).catch((err: unknown) => {
      if (seq === this.seq) this.els.result.textContent = `Progress could not be saved: ${err instanceof Error ? err.message : String(err)}`;
    });
  }

  private showHint(): void {
    const d = this.drill;
    if (!d || this.drillState !== 'asking') return;
    const first = d.expected()[0];
    if (!first) return;
    this.hinted = true;
    this.board.setUserAnnotations([], [{ square: fromTo(first).from, color: 'G' }]);
    this.setDrillStatus('Hint: move the highlighted piece.', 'asking');
  }

  private reveal(): void {
    const d = this.drill;
    if (!d || this.drillState !== 'asking') return;
    const seq = this.seq;
    const key = d.key;
    const node = d.reveal();
    this.settle(key, 1, seq);
    this.board.clearUserAnnotations();
    this.board.setInteractiveColor('none');
    this.board.setPosition(node.fen, { lastMove: fromTo(node), animate: true });
    soundForNode(this.options.audio, node);
    this.setDrillState('playing');
    this.setDrillStatus(`Your repertoire plays ${node.san}.`, 'wrong');
    this.timers.later(() => this.step(seq), AFTER_REVEAL_MS);
  }

  private endLine(): void {
    this.board.setInteractiveColor('none');
    this.board.clearUserAnnotations();
    this.setDrillState('done');
    this.setDrillStatus(this.practising ? 'Practice line complete' : 'Line complete', 'done');
    this.els.prompt.textContent = '';
    this.els.line.textContent = '';
    this.els.result.textContent =
      this.asked === 0 ? 'The line ended without a question.' : `${this.right} of ${plural(this.asked, 'position')} right first time.`;
    void this.refreshDue().then(() => this.updateDrillButtons());
  }

  public destroy(): void {
    this.endDrill();
    this.menu.destroy();
    this.board.destroy();
  }
}
