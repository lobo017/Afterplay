import type { StoredGameSource } from '../capture/game-id';
import { formatPlayedAt, localDateTime } from '../capture/pgn-time';
import { REVIEW_PRESET_MOVETIME_MS, type ReviewPreset } from '../review/types';
import type { StoredGameRecord } from '../storage/db';
import type { ExtensionStatus } from './bridge-client';
import { formatTimeControl, type MyResult } from './game-record';
import {
  NO_FILTER,
  activeFilters,
  matchesFilter,
  openingChoices,
  openingLabel,
  playedOf,
  sortRows,
  toRow,
  type AnalyzedFilter,
  type GameFilter,
  type GameRow as Row,
  type ResultFilter,
  type SortKey,
} from './game-rows';
import type { GameLibrary } from './library';
import type { ReviewQueue } from './review-queue';
import { icon } from '../ui/components/icons';
import { Menu } from '../ui/components/menu';

export interface GamesListOptions {
  container: HTMLElement;
  library: GameLibrary;
  queue: ReviewQueue;
  /** Opens a game on the analysis board (with its saved review, if it has one). */
  onOpen: (record: StoredGameRecord) => void;
  getExtensionStatus: () => ExtensionStatus;
  onExtensionStatus: (listener: (status: ExtensionStatus) => void) => void;
}

/** Games analyzed from the list use this preset unless another is picked. */
export const DEFAULT_LIST_PRESET: ReviewPreset = 'standard';
/** "Auto-analyze new games" reviews on this preset. */
export const AUTO_ANALYZE_PRESET: ReviewPreset = 'quick';
/** History imports aren't "new games": auto-analyze skips them. */
const BACKFILL_METHODS = new Set(['lichess-history', 'chesscom-archive-history']);
/** Rows drawn at once; "Show more" draws the next page. */
const PAGE_SIZE = 100;

const SOURCE_META: Record<StoredGameSource, { label: string; glyph: string }> = {
  play: { label: 'Played here', glyph: '♞' },
  lichess: { label: 'Lichess', glyph: 'L' },
  chesscom: { label: 'Chess.com', glyph: 'C' },
  paste: { label: 'Pasted / file', glyph: 'P' },
};

const RESULT_META: Record<MyResult, { label: string; short: string }> = {
  win: { label: 'Win', short: 'W' },
  loss: { label: 'Loss', short: 'L' },
  draw: { label: 'Draw', short: 'D' },
  unfinished: { label: 'Unfinished', short: '*' },
};

const PRESET_LABEL: Record<ReviewPreset, string> = { quick: 'Quick', standard: 'Standard', deep: 'Deep' };

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The date cell: date and time in my time zone (converted from the PGN's UTC date and time). */
function dateCell(record: StoredGameRecord): string {
  const played = playedOf(record);
  if (!played) return record.date ? escapeHtml(record.date.replace(/\./g, '-')) : '—';
  if (!played.hasTime) return escapeHtml(formatPlayedAt(played));
  const local = localDateTime(played.ms);
  const title = `${played.isEnd ? 'Ended' : 'Started'} ${local.date} ${local.time} (${local.timeZone})`;
  return `<span class="wc-games-date" title="${escapeHtml(title)}">${local.date}</span> <span class="wc-games-time">${local.time}</span>`;
}

/**
 * The Games list: every captured, pasted and dropped game, with filters, sorting, a
 * multi-select "Analyze" that queues background reviews, and the auto-analyze toggle.
 */
export class GamesList {
  private readonly root: HTMLElement;
  private records: StoredGameRecord[] = [];
  private readonly selected = new Set<string>();
  private filter: GameFilter = { ...NO_FILTER };
  private sort: SortKey = 'newest';
  private shown = PAGE_SIZE;
  private autoAnalyze = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last analysis-cell markup per game, so queue progress only touches cells that changed. */
  private readonly renderedCells = new Map<string, string>();
  private loaded = false;
  private readonly autoListeners = new Set<(on: boolean) => void>();

  private els!: {
    extStatus: HTMLElement;
    pastePanel: HTMLElement;
    pasteText: HTMLTextAreaElement;
    pasteResult: HTMLElement;
    fileInput: HTMLInputElement;
    source: HTMLSelectElement;
    result: HTMLSelectElement;
    color: HTMLSelectElement;
    analyzed: HTMLSelectElement;
    opening: HTMLInputElement;
    openings: HTMLDataListElement;
    from: HTMLInputElement;
    to: HTMLInputElement;
    minAccuracy: HTMLInputElement;
    clear: HTMLButtonElement;
    filterCount: HTMLElement;
    sort: HTMLSelectElement;
    del: HTMLButtonElement;
    delConfirm: HTMLElement;
    selectAll: HTMLInputElement;
    selection: HTMLElement;
    preset: HTMLSelectElement;
    analyze: HTMLButtonElement;
    auto: HTMLInputElement;
    count: HTMLElement;
    body: HTMLElement;
    empty: HTMLElement;
    more: HTMLButtonElement;
    drop: HTMLElement;
    selbar: HTMLElement;
    summary: HTMLElement;
    captureDetail: HTMLElement;
  };
  private importMenu!: Menu;

  constructor(private readonly options: GamesListOptions) {
    this.root = document.createElement('section');
    this.root.className = 'wc-games';
    this.root.setAttribute('data-testid', 'games-list');
    this.root.setAttribute('aria-label', 'Games');
    options.container.appendChild(this.root);
    this.mount();
    options.library.onChange((change) => {
      this.autoAnalyzeAdded(change.added, change.methods);
      this.scheduleRefresh();
    });
    options.queue.onChange(() => this.renderAnalysisCells());
    options.onExtensionStatus((s) => this.renderExtensionStatus(s));
    this.renderExtensionStatus(options.getExtensionStatus());
    void options.library.getAutoAnalyze().then((on) => {
      this.autoAnalyze = on;
      this.els.auto.checked = on;
    });
  }

  private mount(): void {
    const presetOptions = (Object.keys(REVIEW_PRESET_MOVETIME_MS) as ReviewPreset[])
      .map(
        (p) =>
          `<option value="${p}" ${p === DEFAULT_LIST_PRESET ? 'selected' : ''}>${PRESET_LABEL[p]} · ${(REVIEW_PRESET_MOVETIME_MS[p] / 1000).toFixed(1)} s</option>`,
      )
      .join('');
    this.root.innerHTML = `
      <div class="wc-games-head">
        <h2 class="wc-page-title wc-games-title">Games</h2>
        <span class="wc-games-summary" data-testid="games-summary"></span>
        <div class="wc-games-head-actions" data-testid="games-import"></div>
        <input type="file" class="wc-games-file-input" accept=".pgn,text/plain,application/x-chess-pgn" multiple data-testid="games-file-input" tabindex="-1" aria-hidden="true" />
      </div>
      <section class="wc-games-capture" data-testid="games-capture" aria-label="Capture extension">
        <span class="wc-games-capture-dot" aria-hidden="true"></span>
        <div class="wc-games-capture-text">
          <span class="wc-games-ext" data-testid="games-extension-status" data-state="not-detected"></span>
          <span class="wc-games-capture-detail" data-testid="games-capture-detail"></span>
        </div>
        <label class="wc-games-auto" title="Reviews each new captured or imported game on the Quick preset">
          <span>Auto-analyze new games<span class="wc-setting-hint">Quick review of each new game</span></span>
          <input type="checkbox" role="switch" class="wc-switch-input" data-testid="games-auto-analyze" />
        </label>
      </section>
      <div class="wc-games-paste" data-testid="games-paste-panel" hidden>
        <textarea class="wc-games-paste-text" data-testid="games-paste-text" rows="6" spellcheck="false" placeholder="Paste one or more games in PGN" aria-label="PGN to import"></textarea>
        <div class="wc-games-paste-actions">
          <button type="button" class="wc-btn wc-btn-primary wc-btn-sm" data-testid="btn-games-paste-import">Import</button>
          <button type="button" class="wc-btn wc-btn-ghost wc-btn-sm" data-testid="btn-games-paste-cancel">Cancel</button>
        </div>
      </div>
      <div class="wc-games-message" data-testid="games-message" role="status"></div>
      <div class="wc-games-toolbar">
        <div class="wc-games-filters">
          <label>Source <select class="wc-select wc-select-sm" data-testid="games-filter-source">
            <option value="all">All</option><option value="lichess">Lichess</option><option value="chesscom">Chess.com</option><option value="paste">Pasted / file</option><option value="play">Played here</option>
          </select></label>
          <label>Colour <select class="wc-select wc-select-sm" data-testid="games-filter-color">
            <option value="all">Any</option><option value="w">White</option><option value="b">Black</option>
          </select></label>
          <label>Result <select class="wc-select wc-select-sm" data-testid="games-filter-result">
            <option value="all">All</option><option value="win">Wins</option><option value="loss">Losses</option><option value="draw">Draws</option>
          </select></label>
          <label>Analysis <select class="wc-select wc-select-sm" data-testid="games-filter-analyzed">
            <option value="all">All</option><option value="analyzed">Analyzed</option><option value="not-analyzed">Not analyzed</option>
          </select></label>
          <label>Opening <input type="search" class="wc-select wc-select-sm wc-games-opening-input" list="wc-games-openings" placeholder="Any" data-testid="games-filter-opening" /><datalist id="wc-games-openings" data-testid="games-openings-list"></datalist></label>
          <label>From <input type="date" class="wc-select wc-select-sm" data-testid="games-filter-from" /></label>
          <label>To <input type="date" class="wc-select wc-select-sm" data-testid="games-filter-to" /></label>
          <label>Accuracy ≥ <input type="number" min="0" max="100" step="1" class="wc-select wc-select-sm wc-games-acc-input" placeholder="Any" data-testid="games-filter-accuracy" /></label>
          <label>Sort <select class="wc-select wc-select-sm" data-testid="games-sort">
            <option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="opponent">Opponent A–Z</option><option value="accuracy">Accuracy</option>
          </select></label>
        </div>
        <button type="button" class="wc-btn wc-btn-ghost wc-btn-sm" data-testid="btn-games-clear-filters" hidden>Clear filters <span data-testid="games-filter-count"></span></button>
      </div>
      <div class="wc-games-table" role="table" aria-label="Games" data-testid="games-table">
        <div class="wc-games-row wc-games-row-head" role="row">
          <span role="columnheader" class="wc-games-c-check"><input type="checkbox" data-testid="games-select-all" aria-label="Select all shown games" /></span>
          <span role="columnheader" class="wc-games-c-source"><span class="wc-sr-only">Source</span></span>
          <span role="columnheader" class="wc-games-c-date">Date</span>
          <span role="columnheader" class="wc-games-c-color">Me</span>
          <span role="columnheader" class="wc-games-c-opp">Opponent</span>
          <span role="columnheader" class="wc-games-c-result">Result</span>
          <span role="columnheader" class="wc-games-c-tc">Time</span>
          <span role="columnheader" class="wc-games-c-opening">Opening</span>
          <span role="columnheader" class="wc-games-c-analysis">Analysis</span>
        </div>
        <div class="wc-games-body" role="rowgroup" data-testid="games-rows"></div>
        <p class="wc-games-empty" data-testid="games-empty">No games yet. Paste a PGN, drop .pgn files here, or capture games with the browser extension.</p>
        <button type="button" class="wc-btn wc-btn-ghost wc-btn-sm wc-games-more" data-testid="btn-games-more" hidden>Show more</button>
      </div>
      <div class="wc-games-count" data-testid="games-count"></div>
      <div class="wc-games-selbar" data-testid="games-selbar" role="region" aria-label="Selected games" hidden>
        <span class="wc-games-selection" data-testid="games-selection">0 selected</span>
        <select class="wc-select" data-testid="games-analyze-preset" aria-label="Review depth for Analyze">${presetOptions}</select>
        <button type="button" class="wc-btn wc-btn-primary wc-btn-lg" data-testid="btn-games-analyze" disabled>Analyze</button>
        <button type="button" class="wc-btn wc-btn-secondary wc-btn-lg" data-testid="btn-games-delete">Delete</button>
        <span class="wc-games-delete-confirm" data-testid="games-delete-confirm" hidden>
          <span data-testid="games-delete-question"></span>
          <button type="button" class="wc-btn wc-btn-secondary wc-btn-sm" data-testid="btn-games-delete-yes">Delete</button>
          <button type="button" class="wc-btn wc-btn-ghost wc-btn-sm" data-testid="btn-games-delete-no">Keep</button>
        </span>
        <button type="button" class="wc-btn wc-btn-ghost wc-btn-icon" data-testid="btn-games-clear-selection" aria-label="Clear the selection" title="Clear the selection">${icon('close')}</button>
      </div>
      <div class="wc-games-drop" data-testid="games-drop-overlay" aria-hidden="true">Drop PGN files to import</div>
    `;
    // Import: paste or open a file (and drop files anywhere on the list)
    const pasteToggle = (): void => {
      const open = this.els.pastePanel.hidden;
      this.els.pastePanel.hidden = !open;
      if (open) this.els.pasteText.focus();
    };
    this.importMenu = new Menu(
      this.root.querySelector('[data-testid="games-import"]') as HTMLElement,
      [
        { id: 'paste', label: 'Paste PGN…', testId: 'btn-games-paste', icon: 'copy', onSelect: pasteToggle },
        { id: 'file', label: 'Open PGN file…', testId: 'btn-games-file', icon: 'upload', onSelect: () => this.els.fileInput.click() },
      ],
      { testId: 'btn-games-import', label: 'Import games', buttonClass: 'wc-btn wc-btn-secondary wc-btn-lg wc-games-import-btn' },
    );
    this.importMenu.button.innerHTML = `${icon('plus')}<span>Import</span>${icon('caret')}`;
    this.importMenu.button.classList.add('wc-btn-inline');
    this.importMenu.button.parentElement?.querySelector('.wc-menu')?.classList.add('wc-menu-down');
    const q = <T extends Element>(id: string) => this.root.querySelector(`[data-testid="${id}"]`) as T;
    this.els = {
      extStatus: q('games-extension-status'),
      pastePanel: q('games-paste-panel'),
      pasteText: q('games-paste-text'),
      pasteResult: q('games-message'),
      fileInput: q('games-file-input'),
      source: q('games-filter-source'),
      result: q('games-filter-result'),
      color: q('games-filter-color'),
      analyzed: q('games-filter-analyzed'),
      opening: q('games-filter-opening'),
      openings: q('games-openings-list'),
      from: q('games-filter-from'),
      to: q('games-filter-to'),
      minAccuracy: q('games-filter-accuracy'),
      clear: q('btn-games-clear-filters'),
      filterCount: q('games-filter-count'),
      sort: q('games-sort'),
      del: q('btn-games-delete'),
      delConfirm: q('games-delete-confirm'),
      selectAll: q('games-select-all'),
      selection: q('games-selection'),
      preset: q('games-analyze-preset'),
      analyze: q('btn-games-analyze'),
      auto: q('games-auto-analyze'),
      count: q('games-count'),
      body: q('games-rows'),
      empty: q('games-empty'),
      more: q('btn-games-more'),
      drop: q('games-drop-overlay'),
      selbar: q('games-selbar'),
      summary: q('games-summary'),
      captureDetail: q('games-capture-detail'),
    };

    q<HTMLButtonElement>('btn-games-paste-cancel').addEventListener('click', () => {
      this.els.pastePanel.hidden = true;
    });
    q<HTMLButtonElement>('btn-games-paste-import').addEventListener('click', () => {
      void this.importText(this.els.pasteText.value).then((ok) => {
        if (ok) {
          this.els.pasteText.value = '';
          this.els.pastePanel.hidden = true;
        }
      });
    });
    q<HTMLButtonElement>('btn-games-clear-selection').addEventListener('click', () => {
      this.selected.clear();
      this.renderRows();
    });
    this.els.fileInput.addEventListener('change', () => {
      const files = [...(this.els.fileInput.files ?? [])];
      this.els.fileInput.value = '';
      void this.importFiles(files);
    });

    const onFilter = () => {
      const acc = this.els.minAccuracy.value.trim();
      this.filter = {
        source: this.els.source.value as GameFilter['source'],
        result: this.els.result.value as ResultFilter,
        color: this.els.color.value as GameFilter['color'],
        analyzed: this.els.analyzed.value as AnalyzedFilter,
        opening: this.els.opening.value,
        from: this.els.from.value,
        to: this.els.to.value,
        minAccuracy: acc === '' || !Number.isFinite(Number(acc)) ? null : Math.min(100, Math.max(0, Number(acc))),
      };
      this.sort = this.els.sort.value as SortKey;
      this.shown = PAGE_SIZE;
      this.renderRows();
    };
    for (const el of [this.els.source, this.els.result, this.els.color, this.els.analyzed, this.els.sort, this.els.from, this.els.to]) {
      el.addEventListener('change', onFilter);
    }
    for (const el of [this.els.opening, this.els.minAccuracy]) el.addEventListener('input', onFilter);
    this.els.clear.addEventListener('click', () => this.clearFilters());
    this.els.del.addEventListener('click', () => {
      const n = this.selectedVisibleIds().length;
      if (n === 0) return;
      this.els.delConfirm.hidden = false;
      this.els.del.hidden = true;
      q('games-delete-question').textContent = `Delete ${n} game${n === 1 ? '' : 's'} and their reviews?`;
    });
    q<HTMLButtonElement>('btn-games-delete-no').addEventListener('click', () => this.endDeleteConfirm());
    q<HTMLButtonElement>('btn-games-delete-yes').addEventListener('click', () => {
      const ids = this.selectedVisibleIds();
      this.endDeleteConfirm();
      if (ids.length === 0) return;
      for (const id of ids) {
        this.options.queue.cancel(id);
        this.selected.delete(id);
      }
      void this.options.library.deleteGames(ids).then(() => this.setMessage(`Deleted ${ids.length} game${ids.length === 1 ? '' : 's'}.`, 'ok'));
    });

    this.els.selectAll.addEventListener('change', () => {
      const visible = this.visibleRows().map((r) => r.record.id);
      if (this.els.selectAll.checked) for (const id of visible) this.selected.add(id);
      else for (const id of visible) this.selected.delete(id);
      this.renderRows();
    });
    this.els.analyze.addEventListener('click', () => {
      const ids = this.visibleRows()
        .map((r) => r.record.id)
        .filter((id) => this.selected.has(id));
      if (ids.length === 0) return;
      this.options.queue.enqueue(ids, this.els.preset.value as ReviewPreset);
      this.selected.clear();
      this.renderRows();
    });
    this.els.auto.addEventListener('change', () => {
      this.autoAnalyze = this.els.auto.checked;
      void this.options.library.setAutoAnalyze(this.autoAnalyze);
      for (const l of this.autoListeners) l(this.autoAnalyze);
    });
    this.els.more.addEventListener('click', () => {
      this.shown += PAGE_SIZE;
      this.renderRows();
    });

    this.els.body.addEventListener('change', (e) => {
      const box = (e.target as HTMLElement).closest<HTMLInputElement>('input[data-select]');
      if (!box) return;
      const id = box.getAttribute('data-select')!;
      if (box.checked) this.selected.add(id);
      else this.selected.delete(id);
      this.renderSelection();
    });
    this.els.body.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const cancel = target.closest<HTMLElement>('[data-cancel]');
      if (cancel) {
        this.options.queue.cancel(cancel.getAttribute('data-cancel')!);
        return;
      }
      if (target.closest('input, label, [data-cancel]')) return;
      const row = target.closest<HTMLElement>('[data-game-id]');
      const record = row ? this.records.find((r) => r.id === row.getAttribute('data-game-id')) : undefined;
      if (record) this.options.onOpen(record);
    });
    this.els.body.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-game-id]');
      if (!row || (e.target as HTMLElement).closest('input')) return;
      const record = this.records.find((r) => r.id === row.getAttribute('data-game-id'));
      if (record) this.options.onOpen(record);
    });

    // Drag and drop of PGN files anywhere on the list
    let dragDepth = 0;
    this.root.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      dragDepth++;
      this.root.setAttribute('data-dragging', 'true');
    });
    this.root.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) this.root.removeAttribute('data-dragging');
    });
    this.root.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    this.root.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      dragDepth = 0;
      this.root.removeAttribute('data-dragging');
      void this.importFiles([...e.dataTransfer.files]);
    });
  }

  private selectedVisibleIds(): string[] {
    return this.visibleRows()
      .map((r) => r.record.id)
      .filter((id) => this.selected.has(id));
  }

  private endDeleteConfirm(): void {
    this.els.delConfirm.hidden = true;
    this.els.del.hidden = false;
  }

  /** Sets the filters from outside (an insight's data point opens the games behind it). */
  public setFilter(patch: Partial<GameFilter>): void {
    this.filter = { ...NO_FILTER, ...patch };
    this.syncFilterControls();
    this.shown = PAGE_SIZE;
    this.renderRows();
  }

  public clearFilters(): void {
    this.setFilter({});
  }

  private syncFilterControls(): void {
    const f = this.filter;
    this.els.source.value = f.source;
    this.els.result.value = f.result;
    this.els.color.value = f.color;
    this.els.analyzed.value = f.analyzed;
    this.els.opening.value = f.opening;
    this.els.from.value = f.from;
    this.els.to.value = f.to;
    this.els.minAccuracy.value = f.minAccuracy === null ? '' : String(f.minAccuracy);
  }

  // ------------------------------------------------------------------ data

  /** Loads the list (first call) or reloads it. */
  public async refresh(): Promise<void> {
    this.records = await this.options.library.list();
    this.loaded = true;
    const ids = new Set(this.records.map((r) => r.id));
    for (const id of [...this.selected]) if (!ids.has(id)) this.selected.delete(id);
    this.renderRows();
  }

  public isLoaded(): boolean {
    return this.loaded;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 50);
  }

  /** New games from the extension or an import: reviewed on Quick when auto-analyze is on. */
  private autoAnalyzeAdded(ids: readonly string[], methods: Readonly<Record<string, string | null>>): void {
    if (!this.autoAnalyze || ids.length === 0) return;
    const fresh = ids.filter((id) => !BACKFILL_METHODS.has(methods[id] ?? ''));
    if (fresh.length > 0) this.options.queue.enqueue(fresh, AUTO_ANALYZE_PRESET);
  }

  /** Called when the auto-analyze switch changes here (Settings has the same switch). */
  public onAutoAnalyzeChange(listener: (on: boolean) => void): void {
    this.autoListeners.add(listener);
  }

  public isAutoAnalyzeOn(): boolean {
    return this.autoAnalyze;
  }

  private setMessage(text: string, tone: 'ok' | 'bad' | 'info' = 'info'): void {
    this.els.pasteResult.textContent = text;
    this.els.pasteResult.setAttribute('data-tone', tone);
  }

  private async importText(text: string): Promise<boolean> {
    if (text.trim() === '') {
      this.setMessage('Paste a PGN first.', 'bad');
      return false;
    }
    const outcome = await this.options.library.importPgnText(text, (p) => {
      if (p.total > 25) this.setMessage(`Importing… ${p.done} of ${p.total} games`, 'info');
    });
    const parts: string[] = [];
    if (outcome.saved.length > 0) parts.push(`Imported ${outcome.saved.length} game${outcome.saved.length === 1 ? '' : 's'}`);
    if (outcome.duplicates.length > 0) parts.push(`${outcome.duplicates.length} already in the list`);
    parts.push(...outcome.errors);
    const ok = outcome.saved.length > 0 || outcome.duplicates.length > 0;
    this.setMessage(parts.join(' · '), ok ? (outcome.errors.length > 0 ? 'info' : 'ok') : 'bad');
    return ok;
  }

  private async importFiles(files: readonly File[]): Promise<void> {
    if (files.length === 0) return;
    const texts = await Promise.all(files.map((f) => f.text()));
    await this.importText(texts.join('\n\n'));
  }

  // ------------------------------------------------------------------ rendering

  private toRow(record: StoredGameRecord): Row {
    return toRow(record, this.options.library.getUserAccounts());
  }

  private visibleRows(): Row[] {
    const rows = this.records.map((r) => this.toRow(r)).filter((row) => matchesFilter(row, this.filter));
    return sortRows(rows, this.sort);
  }

  private analysisCell(row: Row): string {
    const job = this.options.queue.getState(row.record.id);
    if (job?.status === 'running') {
      const pct = job.total > 0 ? Math.round((job.analyzed / job.total) * 100) : 0;
      return `<span class="wc-games-badge wc-games-badge-running" data-analysis="running">Analyzing ${pct}%</span><button type="button" class="wc-games-cancel" data-cancel="${escapeHtml(row.record.id)}" aria-label="Stop analyzing this game">×</button>`;
    }
    if (job?.status === 'queued') {
      return `<span class="wc-games-badge wc-games-badge-queued" data-analysis="queued">Queued · ${PRESET_LABEL[job.preset]}</span><button type="button" class="wc-games-cancel" data-cancel="${escapeHtml(row.record.id)}" aria-label="Remove from the queue">×</button>`;
    }
    if (job?.status === 'failed') {
      return `<span class="wc-games-badge wc-games-badge-failed" data-analysis="failed" title="${escapeHtml(job.error)}">Failed</span>`;
    }
    const a = row.record.analysis;
    if (a) {
      const acc = row.accuracy === null ? '' : ` · ${row.accuracy.toFixed(1)}%`;
      return `<span class="wc-games-badge wc-games-badge-done" data-analysis="analyzed" title="Reviewed on ${a.preset ? PRESET_LABEL[a.preset] : 'custom'}">Analyzed${acc}</span>`;
    }
    return `<span class="wc-games-badge" data-analysis="none">Not analyzed</span>`;
  }

  private rowHtml(row: Row): string {
    const r = row.record;
    const source = r.source ?? 'paste';
    const meta = SOURCE_META[source];
    const res = RESULT_META[row.result];
    // A game I'm not in shows its result as played, not as a win or loss
    const resultText = row.color === null ? (r.result === '1/2-1/2' ? '½' : r.result === '*' ? '*' : r.result) : res.short;
    const resultClass = row.color === null ? 'neutral' : row.result;
    const resultTitle = row.color === null ? r.result : `${res.label} (${r.result})`;
    const colorCell =
      row.color === null
        ? '<span class="wc-games-color-none" title="Not one of my games">—</span>'
        : `<span class="wc-games-color wc-games-color-${row.color}" title="I played ${row.color === 'w' ? 'White' : 'Black'}"></span><span class="wc-sr-only">${row.color === 'w' ? 'White' : 'Black'}</span>`;
    const ratings =
      row.color === null
        ? [r.whiteElo, r.blackElo].some(Boolean)
          ? `${r.whiteElo ?? '?'} / ${r.blackElo ?? '?'}`
          : ''
        : row.opponentElo !== null
          ? `${row.opponentElo}${row.myElo !== null ? ` · me ${row.myElo}` : ''}`
          : '';
    const opening = openingLabel(r) || '—';
    return `
      <div class="wc-games-row" role="row" tabindex="0" data-testid="games-row" data-game-id="${escapeHtml(r.id)}" data-source="${source}" data-result="${row.result}" aria-selected="${this.selected.has(r.id)}">
        <span role="cell" class="wc-games-c-check"><input type="checkbox" data-select="${escapeHtml(r.id)}" aria-label="Select game" ${this.selected.has(r.id) ? 'checked' : ''} /></span>
        <span role="cell" class="wc-games-c-source"><span class="wc-games-source wc-games-source-${source}" title="${meta.label}" aria-label="${meta.label}">${meta.glyph}</span></span>
        <span role="cell" class="wc-games-c-date" data-testid="games-row-date">${dateCell(r)}</span>
        <span role="cell" class="wc-games-c-color" data-testid="games-row-color" data-color="${row.color ?? 'none'}">${colorCell}</span>
        <span role="cell" class="wc-games-c-opp" data-testid="games-row-opponent" title="${escapeHtml(`${r.white} vs ${r.black}`)}"><span class="wc-games-opp-name">${escapeHtml(row.opponent)}</span><span class="wc-games-opp-elo">${ratings}</span></span>
        <span role="cell" class="wc-games-c-result"><span class="wc-games-result wc-games-result-${resultClass}" title="${resultTitle}" data-testid="games-row-result">${resultText}</span></span>
        <span role="cell" class="wc-games-c-tc" data-testid="games-row-tc">${escapeHtml(formatTimeControl(r.timeControl))}</span>
        <span role="cell" class="wc-games-c-opening" data-testid="games-row-opening" title="${escapeHtml(opening)}">${escapeHtml(opening)}</span>
        <span role="cell" class="wc-games-c-analysis" data-testid="games-row-analysis">${this.analysisCell(row)}</span>
      </div>`;
  }

  private renderRows(): void {
    const rows = this.visibleRows();
    const page = rows.slice(0, this.shown);
    this.renderedCells.clear();
    this.els.body.innerHTML = page.map((r) => this.rowHtml(r)).join('');
    this.els.empty.hidden = this.records.length > 0;
    if (this.records.length > 0 && rows.length === 0) {
      this.els.empty.hidden = false;
      this.els.empty.textContent = 'No games match these filters.';
    } else {
      this.els.empty.textContent =
        'No games yet. Paste a PGN, drop .pgn files here, or capture games with the browser extension.';
    }
    this.els.more.hidden = rows.length <= page.length;
    const active = activeFilters(this.filter);
    this.els.clear.hidden = active === 0;
    this.els.filterCount.textContent = active > 0 ? `(${active})` : '';
    this.els.openings.innerHTML = openingChoices(this.records)
      .slice(0, 100)
      .map((o) => `<option value="${escapeHtml(o)}"></option>`)
      .join('');
    this.els.count.textContent =
      this.records.length === 0
        ? ''
        : rows.length === this.records.length
          ? `${rows.length} game${rows.length === 1 ? '' : 's'}`
          : `${rows.length} of ${this.records.length} games`;
    const analyzedCount = this.records.filter((r) => r.analysis).length;
    this.els.summary.textContent =
      this.records.length === 0
        ? ''
        : `${this.records.length} game${this.records.length === 1 ? '' : 's'} · ${analyzedCount} analyzed`;
    this.renderSelection(rows);
  }

  /** Queue progress: only the analysis cells change, so focus and scroll stay where they are. */
  private renderAnalysisCells(): void {
    const byId = new Map(this.records.map((r) => [r.id, r]));
    for (const rowEl of this.els.body.querySelectorAll<HTMLElement>('[data-game-id]')) {
      const record = byId.get(rowEl.getAttribute('data-game-id')!);
      const cell = rowEl.querySelector<HTMLElement>('.wc-games-c-analysis');
      if (!record || !cell) continue;
      const html = this.analysisCell(this.toRow(record));
      if (this.renderedCells.get(record.id) === html) continue;
      this.renderedCells.set(record.id, html);
      cell.innerHTML = html;
    }
  }

  private renderSelection(rows: Row[] = this.visibleRows()): void {
    const visibleSelected = rows.filter((r) => this.selected.has(r.record.id)).length;
    this.els.selection.textContent = `${visibleSelected} selected`;
    this.els.analyze.disabled = visibleSelected === 0;
    this.els.analyze.textContent = visibleSelected > 0 ? `Analyze ${visibleSelected}` : 'Analyze';
    this.els.selbar.hidden = visibleSelected === 0;
    this.els.selectAll.checked = rows.length > 0 && visibleSelected === rows.length;
    this.els.selectAll.indeterminate = visibleSelected > 0 && visibleSelected < rows.length;
    for (const row of this.els.body.querySelectorAll<HTMLElement>('[data-game-id]')) {
      row.setAttribute('aria-selected', String(this.selected.has(row.getAttribute('data-game-id')!)));
    }
  }

  /** Re-reads the auto-analyze switch from storage (after a restore). */
  public async syncAutoAnalyze(): Promise<void> {
    this.autoAnalyze = await this.options.library.getAutoAnalyze();
    this.els.auto.checked = this.autoAnalyze;
    for (const l of this.autoListeners) l(this.autoAnalyze);
  }

  private renderExtensionStatus(status: ExtensionStatus): void {
    const el = this.els.extStatus;
    el.setAttribute('data-state', status.state);
    this.root.setAttribute('data-capture', status.state);
    const accounts = this.options.library.getUserAccounts();
    const mine = accounts.length
      ? `Your accounts: ${accounts.map((a) => `${a.site === 'lichess' ? 'Lichess' : 'Chess.com'} ${a.username}`).join(' · ')}.`
      : '';
    if (status.state === 'not-detected') {
      el.textContent = 'Capture extension not detected';
      el.title = 'Install the capture extension (see README) to collect your Lichess and Chess.com games here.';
      this.els.captureDetail.textContent =
        'Install the capture extension (README: npm run build:ext, then load dist-ext/ unpacked in Chrome) and your Lichess and Chess.com games arrive here by themselves.';
      return;
    }
    this.els.captureDetail.textContent = `Your Lichess and Chess.com games arrive here as you play; capture settings are in the extension's popup. ${mine}`.trim();
    const last = status.syncing
      ? 'syncing…'
      : status.lastSyncAt === null
        ? 'connected'
        : status.lastDelivered === 0
          ? 'up to date'
          : `${status.lastDelivered} game${status.lastDelivered === 1 ? '' : 's'} received`;
    el.textContent = `Capture extension v${status.extensionVersion} · ${last}`;
    el.title = 'Games captured by the extension arrive here as soon as they are captured while this page is open, and when it opens.';
  }
}
