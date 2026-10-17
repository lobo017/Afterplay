import {
  RulesAdapter,
  type Color,
  type ExecutedMove,
} from '../core/rules';
import type { EngineLine } from '../engine/cache';
import { formatEvalBarScore } from './eval-bar';

export interface FormattedPvMove {
  plyIndex: number;
  moveNumber: number;
  color: Color;
  uci: string;
  san: string;
  prefix: string;
  displayToken: string;
  fenAfter: string;
  executedMove: ExecutedMove;
}

export interface FormattedEngineLine {
  multipv: number;
  depth: number;
  scoreText: string;
  whiteAdvantage: boolean;
  isMate: boolean;
  moves: FormattedPvMove[];
  rawLine: EngineLine;
}

export interface GhostLinePreviewPayload {
  multipv: number;
  baseFen: string;
  moves: ExecutedMove[];
  targetFen: string;
}

export interface SelectLineVariationPayload {
  multipv: number;
  baseFen: string;
  moves: ExecutedMove[];
}

/**
 * Converts a sequence of UCI PV moves starting from `baseFen` into rich SAN move descriptors
 * with post-move FENs for ghost board previews and variation insertion.
 */
export function formatPvMovesToSan(
  baseFen: string,
  pvUci: string[],
  maxPlies = 10,
  chess960?: boolean,
): FormattedPvMove[] {
  const result: FormattedPvMove[] = [];
  if (!pvUci || pvUci.length === 0) return result;

  let adapter: RulesAdapter;
  try {
    adapter = new RulesAdapter(baseFen, { chess960 });
  } catch {
    return result;
  }

  const limit = Math.min(pvUci.length, maxPlies);
  for (let i = 0; i < limit; i++) {
    const uci = pvUci[i];
    if (!uci || uci === '(none)') break;

    const moveNum = adapter.moveNumber();
    const color = adapter.turn();
    try {
      const executed = adapter.move(uci);
      const prefix =
        color === 'w'
          ? `${moveNum}.`
          : i === 0
            ? `${moveNum}...`
            : '';
      const displayToken = prefix ? `${prefix} ${executed.san}` : executed.san;

      result.push({
        plyIndex: i,
        moveNumber: moveNum,
        color,
        uci: executed.uci,
        san: executed.san,
        prefix,
        displayToken,
        fenAfter: executed.after,
        executedMove: executed,
      });
    } catch {
      break;
    }
  }

  return result;
}

export interface EngineLinesPanelOptions {
  initialMultiPv?: number;
  initialEnabled?: boolean;
  onToggleEngine?: (enabled: boolean) => void;
  onChangeMultiPv?: (multipv: number) => void;
  onHoverLine?: (preview: GhostLinePreviewPayload | null) => void;
  onSelectLine?: (selection: SelectLineVariationPayload) => void;
}

const MAX_LINES = 5;
const PV_PLIES = 10;

interface LineRowSlot {
  rowEl: HTMLElement;
  evalEl: HTMLElement;
  pvEl: HTMLElement;
  /** fen + PV of what the row shows, so unchanged rows skip DOM writes. */
  pvKey: string;
  evalText: string;
  evalWhite: boolean | null;
  formatted: FormattedEngineLine | null;
}

type PendingPanelUpdate =
  | {
      kind: 'lines';
      fen: string;
      lines: EngineLine[];
      depth: number;
      nps: number;
      chess960: boolean;
    }
  | { kind: 'clear'; fen: string };

const formatNps = (nps: number): string =>
  nps >= 1_000_000
    ? `${(nps / 1_000_000).toFixed(2)} MN/s`
    : `${Math.round(nps / 1000)} kN/s`;

/**
 * Live MultiPV (1–5) Engine Lines Panel.
 * - Displays 1–5 live Stockfish evaluation lines with depth and NPS telemetry.
 * - Hovering a line or move token previews the continuation with faded "ghost" pieces on the board.
 * - Clicking a line or move token plays the moves into the GameTree as a variation.
 *
 * Layout is fixed: there is one persistent row per possible line, the list reserves the
 * height of the selected line count, and the status messages sit on top of the rows, so
 * the panel never changes size as lines stream in or the position changes. Incoming
 * updates are coalesced so the panel writes the DOM at most once per animation frame.
 */
export class EngineLinesPanel {
  private readonly rootEl: HTMLElement;
  private readonly toggleBtnEl: HTMLButtonElement;
  private readonly multiPvSelectEl: HTMLSelectElement;
  private readonly depthBadgeEl: HTMLElement;
  private readonly npsBadgeEl: HTMLElement;
  private readonly linesContainerEl: HTMLElement;
  private readonly emptyStatusEl: HTMLElement;
  private readonly disabledStatusEl: HTMLElement;
  private readonly slots: LineRowSlot[] = [];

  private enabled: boolean;
  private multipv: number;
  private currentFen = '';
  private formattedLines: FormattedEngineLine[] = [];

  private pending: PendingPanelUpdate | null = null;
  private layoutDirty = true;
  private rafId: number | null = null;
  private renderCount = 0;
  private lastHoverKey = '';
  /** Rows on screen still show the previous position's lines. */
  private stale = false;

  private readonly onToggleEngine?: (enabled: boolean) => void;
  private readonly onChangeMultiPv?: (multipv: number) => void;
  private readonly onHoverLine?: (
    preview: GhostLinePreviewPayload | null,
  ) => void;
  private readonly onSelectLine?: (
    selection: SelectLineVariationPayload,
  ) => void;

  constructor(parent: HTMLElement, options?: EngineLinesPanelOptions) {
    this.enabled = options?.initialEnabled ?? true;
    this.multipv = Math.max(1, Math.min(MAX_LINES, options?.initialMultiPv ?? 3));
    this.onToggleEngine = options?.onToggleEngine;
    this.onChangeMultiPv = options?.onChangeMultiPv;
    this.onHoverLine = options?.onHoverLine;
    this.onSelectLine = options?.onSelectLine;

    this.rootEl = document.createElement('section');
    this.rootEl.className = 'wc-engine-lines-panel';
    this.rootEl.setAttribute('data-testid', 'engine-lines-panel');
    this.rootEl.setAttribute('aria-label', 'Stockfish Engine Lines');

    const rowSlotsHtml = Array.from({ length: MAX_LINES }, (_, i) => {
      const k = i + 1;
      return `
        <div
          class="wc-engine-line-row"
          data-multipv-index="${k}"
          data-testid="engine-line-row-${k}"
          data-empty="true"
          role="button"
          tabindex="0"
          title="Hover to preview ghost pieces · Click to play line as variation"
        >
          <span class="wc-engine-line-eval" data-testid="engine-line-eval-${k}"></span>
          <div class="wc-engine-line-pv" data-testid="engine-line-pv-${k}"></div>
        </div>`;
    }).join('');

    this.rootEl.innerHTML = `
      <div class="wc-engine-panel-header">
        <div class="wc-engine-header-left">
          <button
            type="button"
            class="wc-btn wc-btn-sm ${this.enabled ? 'wc-btn-primary' : 'wc-btn-ghost'}"
            data-testid="toggle-analysis-engine"
            aria-pressed="${this.enabled}"
            title="Toggle Stockfish Engine (Space)"
          >
            ${this.enabled ? 'Engine: ON' : 'Engine: OFF'}
          </button>
          <span class="wc-engine-meta-badge wc-engine-depth-badge" data-testid="analysis-depth">Depth 0</span>
          <span class="wc-engine-meta-badge wc-engine-nps-badge" data-testid="analysis-nps">0 kN/s</span>
        </div>
        <div class="wc-engine-header-right">
          <label class="wc-inline-label">
            <span>Lines</span>
            <select class="wc-select wc-select-sm" data-testid="select-multipv" aria-label="Number of engine lines">
              ${[1, 2, 3, 4, 5]
                .map(
                  (n) =>
                    `<option value="${n}" ${n === this.multipv ? 'selected' : ''}>${n} ${n === 1 ? 'line' : 'lines'}</option>`,
                )
                .join('')}
            </select>
          </label>
        </div>
      </div>
      <div class="wc-engine-lines-list" data-testid="engine-lines-list">
        ${rowSlotsHtml}
        <div class="wc-engine-lines-status" data-testid="engine-lines-empty" hidden>
          Analyzing position...
        </div>
        <div class="wc-engine-lines-status" data-testid="engine-lines-disabled" hidden>
          Engine paused — press <kbd>Space</kbd> or click <strong>Engine: OFF</strong> to resume analysis.
        </div>
      </div>
    `;

    this.toggleBtnEl = this.rootEl.querySelector(
      '[data-testid="toggle-analysis-engine"]',
    ) as HTMLButtonElement;
    this.multiPvSelectEl = this.rootEl.querySelector(
      '[data-testid="select-multipv"]',
    ) as HTMLSelectElement;
    this.depthBadgeEl = this.rootEl.querySelector(
      '[data-testid="analysis-depth"]',
    ) as HTMLElement;
    this.npsBadgeEl = this.rootEl.querySelector(
      '[data-testid="analysis-nps"]',
    ) as HTMLElement;
    this.linesContainerEl = this.rootEl.querySelector(
      '[data-testid="engine-lines-list"]',
    ) as HTMLElement;
    this.emptyStatusEl = this.rootEl.querySelector(
      '[data-testid="engine-lines-empty"]',
    ) as HTMLElement;
    this.disabledStatusEl = this.rootEl.querySelector(
      '[data-testid="engine-lines-disabled"]',
    ) as HTMLElement;

    for (let k = 1; k <= MAX_LINES; k++) {
      const rowEl = this.rootEl.querySelector(
        `[data-testid="engine-line-row-${k}"]`,
      ) as HTMLElement;
      this.slots.push({
        rowEl,
        evalEl: rowEl.querySelector('.wc-engine-line-eval') as HTMLElement,
        pvEl: rowEl.querySelector('.wc-engine-line-pv') as HTMLElement,
        pvKey: '',
        evalText: '',
        evalWhite: null,
        formatted: null,
      });
    }

    parent.appendChild(this.rootEl);
    this.bindEvents();
    this.flush();
  }

  private bindEvents(): void {
    this.toggleBtnEl.addEventListener('click', () => {
      this.setEnabled(!this.enabled);
      this.onToggleEngine?.(this.enabled);
    });

    this.multiPvSelectEl.addEventListener('change', () => {
      const next = Math.max(
        1,
        Math.min(MAX_LINES, Number(this.multiPvSelectEl.value) || 3),
      );
      this.setMultiPv(next);
      this.onChangeMultiPv?.(this.multipv);
    });

    this.linesContainerEl.addEventListener('mouseover', (e) => {
      const target = e.target as HTMLElement;
      const moveEl = target.closest(
        '[data-pv-move-index]',
      ) as HTMLElement | null;
      const rowEl = target.closest(
        '[data-multipv-index]',
      ) as HTMLElement | null;
      if (!rowEl) return;

      const multipvIdx = Number(rowEl.getAttribute('data-multipv-index'));
      const line = this.formattedLines.find((l) => l.multipv === multipvIdx);
      if (!line || line.moves.length === 0) return;

      const plyCount = moveEl
        ? Number(moveEl.getAttribute('data-pv-move-index')) + 1
        : Math.min(4, line.moves.length);
      const slice = line.moves.slice(0, Math.max(1, plyCount));
      const lastMove = slice[slice.length - 1];
      if (!lastMove) return;

      // mouseover fires for every child crossed; only emit when the preview changes
      const hoverKey = `${line.multipv}:${slice.length}:${lastMove.fenAfter}`;
      if (hoverKey === this.lastHoverKey) return;
      this.lastHoverKey = hoverKey;

      this.onHoverLine?.({
        multipv: line.multipv,
        baseFen: this.currentFen,
        moves: slice.map((m) => m.executedMove),
        targetFen: lastMove.fenAfter,
      });
    });

    this.linesContainerEl.addEventListener('mouseleave', () => {
      this.lastHoverKey = '';
      this.onHoverLine?.(null);
    });

    this.linesContainerEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const moveEl = target.closest(
        '[data-pv-move-index]',
      ) as HTMLElement | null;
      const rowEl = target.closest(
        '[data-multipv-index]',
      ) as HTMLElement | null;
      if (!rowEl) return;

      const multipvIdx = Number(rowEl.getAttribute('data-multipv-index'));
      const line = this.formattedLines.find((l) => l.multipv === multipvIdx);
      if (!line || line.moves.length === 0) return;

      const plyCount = moveEl
        ? Number(moveEl.getAttribute('data-pv-move-index')) + 1
        : Math.min(4, line.moves.length);
      const slice = line.moves.slice(0, Math.max(1, plyCount));
      if (slice.length === 0) return;

      this.lastHoverKey = '';
      this.onHoverLine?.(null);
      this.onSelectLine?.({
        multipv: line.multipv,
        baseFen: this.currentFen,
        moves: slice.map((m) => m.executedMove),
      });
    });
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.toggleBtnEl.setAttribute('aria-pressed', String(enabled));
    this.toggleBtnEl.textContent = enabled ? 'Engine: ON' : 'Engine: OFF';
    this.toggleBtnEl.className = `wc-btn wc-btn-sm ${
      enabled ? 'wc-btn-primary' : 'wc-btn-ghost'
    }`;
    if (!enabled) {
      this.lastHoverKey = '';
      this.onHoverLine?.(null);
    }
    this.layoutDirty = true;
    this.scheduleFlush();
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setMultiPv(multipv: number): void {
    this.multipv = Math.max(1, Math.min(MAX_LINES, Math.floor(multipv)));
    if (this.multiPvSelectEl.value !== String(this.multipv)) {
      this.multiPvSelectEl.value = String(this.multipv);
    }
    this.layoutDirty = true;
    this.scheduleFlush();
  }

  public getMultiPv(): number {
    return this.multipv;
  }

  public getFormattedLines(): FormattedEngineLine[] {
    return this.formattedLines;
  }

  /** Number of frames in which the panel wrote to the DOM (perf instrumentation). */
  public getRenderCount(): number {
    return this.renderCount;
  }

  /** Queues the latest engine output; it reaches the DOM on the next animation frame. */
  public updateLines(
    fen: string,
    lines: EngineLine[],
    telemetry?: { depth?: number; nps?: number; chess960?: boolean },
  ): void {
    this.pending = {
      kind: 'lines',
      fen,
      lines,
      depth: telemetry?.depth ?? lines[0]?.depth ?? 0,
      nps: telemetry?.nps ?? lines[0]?.nps ?? 0,
      chess960: Boolean(telemetry?.chess960),
    };
    this.scheduleFlush();
  }

  /**
   * The position changed: the rows on screen belong to the old position. They are hidden
   * right away (one attribute; `visibility` doesn't touch layout) and their data dropped,
   * so a click or hover in the frame before the next flush can't act on a stale line.
   */
  public clear(fen = ''): void {
    this.currentFen = fen;
    this.formattedLines = [];
    this.lastHoverKey = '';
    if (!this.stale) {
      this.stale = true;
      this.linesContainerEl.setAttribute('data-stale', 'true');
    }
    this.pending = { kind: 'clear', fen };
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.rafId !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      this.flush();
      return;
    }
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.flush();
    });
  }

  private flush(): void {
    const update = this.pending;
    this.pending = null;
    let wrote = false;

    if (update) {
      this.currentFen = update.fen;
      const depth = update.kind === 'lines' ? update.depth : 0;
      const nps = update.kind === 'lines' ? update.nps : 0;
      const depthText = `Depth ${depth}`;
      const npsText = formatNps(nps);
      if (this.depthBadgeEl.textContent !== depthText) {
        this.depthBadgeEl.textContent = depthText;
        wrote = true;
      }
      if (this.npsBadgeEl.textContent !== npsText) {
        this.npsBadgeEl.textContent = npsText;
        wrote = true;
      }

      // Row k always shows MultiPV line k, whatever order the engine reported them in
      const byMultipv: Array<EngineLine | undefined> = new Array(MAX_LINES);
      if (update.kind === 'lines') {
        for (const line of update.lines) {
          if (line.multipv >= 1 && line.multipv <= this.multipv) {
            byMultipv[line.multipv - 1] = line;
          }
        }
      }
      const formatted: FormattedEngineLine[] = [];
      for (let i = 0; i < MAX_LINES; i++) {
        const slot = this.slots[i]!;
        const line = byMultipv[i];
        if (!line || update.kind !== 'lines') {
          if (slot.pvKey !== '') {
            slot.pvKey = '';
            slot.formatted = null;
            slot.pvEl.textContent = '';
            slot.evalEl.textContent = '';
            slot.rowEl.setAttribute('data-empty', 'true');
            wrote = true;
          }
          continue;
        }

        const pvKey = `${update.fen}|${line.pv.slice(0, PV_PLIES).join(' ')}`;
        if (pvKey !== slot.pvKey || !slot.formatted) {
          const moves = formatPvMovesToSan(
            update.fen,
            line.pv,
            PV_PLIES,
            update.chess960,
          );
          slot.pvEl.innerHTML = moves
            .map(
              (m) =>
                `<span class="wc-engine-pv-move" data-pv-move-index="${m.plyIndex}" data-testid="engine-pv-move-${line.multipv}-${m.plyIndex}" title="Hover to preview · Click to insert variation up to ${m.san}">${m.displayToken}</span>`,
            )
            .join(' ');
          slot.pvKey = pvKey;
          slot.formatted = {
            multipv: line.multipv,
            depth: line.depth,
            scoreText: '',
            whiteAdvantage: true,
            isMate: false,
            moves,
            rawLine: line,
          };
          slot.rowEl.setAttribute('data-empty', 'false');
          if (this.lastHoverKey.startsWith(`${line.multipv}:`)) {
            this.lastHoverKey = '';
          }
          wrote = true;
        }

        const scoreText = formatEvalBarScore(line.scoreWhite);
        const whiteAdvantage = line.scoreWhite.value >= 0;
        if (slot.evalText !== scoreText) {
          slot.evalEl.textContent = scoreText;
          slot.evalText = scoreText;
          wrote = true;
        }
        if (slot.evalWhite !== whiteAdvantage) {
          slot.evalEl.className = `wc-engine-line-eval ${
            whiteAdvantage ? 'wc-engine-line-eval-white' : 'wc-engine-line-eval-black'
          }`;
          slot.evalWhite = whiteAdvantage;
          wrote = true;
        }

        const f = slot.formatted!;
        f.multipv = line.multipv;
        f.depth = line.depth;
        f.scoreText = scoreText;
        f.whiteAdvantage = whiteAdvantage;
        f.isMate = line.scoreWhite.type === 'mate';
        f.rawLine = line;
        formatted.push(f);
      }
      this.formattedLines = formatted;
      if (this.stale) {
        this.stale = false;
        this.linesContainerEl.removeAttribute('data-stale');
        wrote = true;
      }
    }

    if (this.layoutDirty) {
      this.layoutDirty = false;
      this.linesContainerEl.style.setProperty(
        '--wc-engine-rows',
        String(this.multipv),
      );
      this.linesContainerEl.setAttribute('data-enabled', String(this.enabled));
      this.slots.forEach((slot, i) => {
        slot.rowEl.hidden = i >= this.multipv;
      });
      wrote = true;
    }

    const showEmpty = this.enabled && this.formattedLines.length === 0;
    if (this.emptyStatusEl.hidden === showEmpty) {
      this.emptyStatusEl.hidden = !showEmpty;
      wrote = true;
    }
    if (this.disabledStatusEl.hidden === !this.enabled) {
      this.disabledStatusEl.hidden = this.enabled;
      wrote = true;
    }

    if (wrote) {
      this.renderCount++;
    }
  }

  public destroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
