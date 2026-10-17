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

/**
 * Live MultiPV (1–5) Engine Lines Panel.
 * - Displays 1–5 live Stockfish evaluation lines with depth and NPS telemetry.
 * - Hovering a line or move token previews the continuation with faded "ghost" pieces on the board.
 * - Clicking a line or move token plays the moves into the GameTree as a variation.
 */
export class EngineLinesPanel {
  private readonly rootEl: HTMLElement;
  private readonly toggleBtnEl: HTMLButtonElement;
  private readonly multiPvSelectEl: HTMLSelectElement;
  private readonly depthBadgeEl: HTMLElement;
  private readonly npsBadgeEl: HTMLElement;
  private readonly linesContainerEl: HTMLElement;

  private enabled: boolean;
  private multipv: number;
  private currentFen = '';
  private chess960 = false;
  private formattedLines: FormattedEngineLine[] = [];

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
    this.multipv = Math.max(1, Math.min(5, options?.initialMultiPv ?? 3));
    this.onToggleEngine = options?.onToggleEngine;
    this.onChangeMultiPv = options?.onChangeMultiPv;
    this.onHoverLine = options?.onHoverLine;
    this.onSelectLine = options?.onSelectLine;

    this.rootEl = document.createElement('section');
    this.rootEl.className = 'wc-engine-lines-panel';
    this.rootEl.setAttribute('data-testid', 'engine-lines-panel');
    this.rootEl.setAttribute('aria-label', 'Stockfish Engine Lines');

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
          <span class="wc-engine-meta-badge" data-testid="analysis-depth">Depth 0</span>
          <span class="wc-engine-meta-badge" data-testid="analysis-nps">0 kN/s</span>
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
      <div class="wc-engine-lines-list" data-testid="engine-lines-list"></div>
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

    parent.appendChild(this.rootEl);
    this.bindEvents();
    this.renderLines();
  }

  private bindEvents(): void {
    this.toggleBtnEl.addEventListener('click', () => {
      this.setEnabled(!this.enabled);
      this.onToggleEngine?.(this.enabled);
    });

    this.multiPvSelectEl.addEventListener('change', () => {
      const next = Math.max(
        1,
        Math.min(5, Number(this.multiPvSelectEl.value) || 3),
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

      this.onHoverLine?.({
        multipv: line.multipv,
        baseFen: this.currentFen,
        moves: slice.map((m) => m.executedMove),
        targetFen: lastMove.fenAfter,
      });
    });

    this.linesContainerEl.addEventListener('mouseleave', () => {
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
      this.onHoverLine?.(null);
      this.renderLines();
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setMultiPv(multipv: number): void {
    this.multipv = Math.max(1, Math.min(5, Math.floor(multipv)));
    if (this.multiPvSelectEl.value !== String(this.multipv)) {
      this.multiPvSelectEl.value = String(this.multipv);
    }
    this.renderLines();
  }

  public getMultiPv(): number {
    return this.multipv;
  }

  public getFormattedLines(): FormattedEngineLine[] {
    return this.formattedLines;
  }

  public updateLines(
    fen: string,
    lines: EngineLine[],
    telemetry?: { depth?: number; nps?: number; chess960?: boolean },
  ): void {
    this.currentFen = fen;
    this.chess960 = Boolean(telemetry?.chess960);

    const depth = telemetry?.depth ?? lines[0]?.depth ?? 0;
    const nps = telemetry?.nps ?? lines[0]?.nps ?? 0;
    this.depthBadgeEl.textContent = `Depth ${depth}`;
    this.npsBadgeEl.textContent =
      nps >= 1_000_000
        ? `${(nps / 1_000_000).toFixed(2)} MN/s`
        : `${Math.round(nps / 1000)} kN/s`;

    const visibleLines = lines.slice(0, this.multipv);
    this.formattedLines = visibleLines.map((line) => {
      const scoreText = formatEvalBarScore(line.scoreWhite);
      const whiteAdvantage =
        line.scoreWhite.type === 'mate'
          ? line.scoreWhite.value >= 0
          : line.scoreWhite.value >= 0;
      const moves = formatPvMovesToSan(
        fen,
        line.pv,
        10,
        this.chess960,
      );
      return {
        multipv: line.multipv,
        depth: line.depth,
        scoreText,
        whiteAdvantage,
        isMate: line.scoreWhite.type === 'mate',
        moves,
        rawLine: line,
      };
    });

    this.renderLines();
  }

  public clear(fen = ''): void {
    this.currentFen = fen;
    this.formattedLines = [];
    this.depthBadgeEl.textContent = 'Depth 0';
    this.npsBadgeEl.textContent = '0 kN/s';
    this.renderLines();
  }

  private renderLines(): void {
    if (!this.enabled) {
      this.linesContainerEl.innerHTML = `
        <div class="wc-engine-lines-empty" data-testid="engine-lines-disabled">
          Engine paused — press <kbd>Space</kbd> or click <strong>Engine: OFF</strong> to resume analysis.
        </div>
      `;
      return;
    }

    if (this.formattedLines.length === 0) {
      this.linesContainerEl.innerHTML = `
        <div class="wc-engine-lines-empty" data-testid="engine-lines-empty">
          Analyzing position...
        </div>
      `;
      return;
    }

    const rowsHtml = this.formattedLines
      .slice(0, this.multipv)
      .map((line) => {
        const movesHtml = line.moves
          .map(
            (m) => `
            <span
              class="wc-engine-pv-move"
              data-pv-move-index="${m.plyIndex}"
              data-testid="engine-pv-move-${line.multipv}-${m.plyIndex}"
              title="Hover to preview · Click to insert variation up to ${m.san}"
            >${m.displayToken}</span>
          `,
          )
          .join(' ');

        return `
          <div
            class="wc-engine-line-row"
            data-multipv-index="${line.multipv}"
            data-testid="engine-line-row-${line.multipv}"
            role="button"
            tabindex="0"
            title="Hover to preview ghost pieces · Click to play line as variation"
          >
            <span
              class="wc-engine-line-eval ${
                line.whiteAdvantage
                  ? 'wc-engine-line-eval-white'
                  : 'wc-engine-line-eval-black'
              }"
              data-testid="engine-line-eval-${line.multipv}"
            >${line.scoreText}</span>
            <div class="wc-engine-line-pv" data-testid="engine-line-pv-${line.multipv}">
              ${movesHtml}
            </div>
          </div>
        `;
      })
      .join('');

    this.linesContainerEl.innerHTML = rowsHtml;
  }
}
