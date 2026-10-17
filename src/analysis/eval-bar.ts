import type { PgnEvalAnnotation } from '../core/game-tree';
import type { UciScore } from '../engine/uci-parser';

/**
 * Converts centipawn evaluation (from White's perspective) to Win% (0..100)
 * using the spec sigmoid formula:
 * Win% = 50 + 50 * (2 / (1 + e^(-0.00368208 * cp)) - 1)
 */
export function cpToWhiteWinPercent(cp: number): number {
  const clampedCp = Math.max(-4000, Math.min(4000, cp));
  const raw = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clampedCp)) - 1);
  return Math.max(0, Math.min(100, raw));
}

/**
 * Converts a White-perspective UCI score (`cp` or `mate`) to exact White Win% (0..100).
 * Forced mate counts as 100 (White mates) or 0 (Black mates).
 */
export function scoreToWhiteWinPercent(scoreWhite: UciScore): number {
  if (scoreWhite.type === 'mate') {
    if (scoreWhite.value > 0) return 100;
    if (scoreWhite.value < 0) return 0;
    return 50;
  }
  return cpToWhiteWinPercent(scoreWhite.value);
}

/**
 * Converts a White-perspective UCI score into the visual fill height percentage (0..100)
 * for the EvalBar. Non-mate scores are clamped to [4%, 96%] so both colors remain visible;
 * forced mates fill 100% or 0%.
 */
export function scoreToEvalBarPercent(scoreWhite: UciScore): number {
  if (scoreWhite.type === 'mate') {
    if (scoreWhite.value > 0) return 100;
    if (scoreWhite.value < 0) return 0;
    return 50;
  }
  const winPct = cpToWhiteWinPercent(scoreWhite.value);
  return Math.max(4, Math.min(96, winPct));
}

/**
 * Formats a White-perspective UCI score for the EvalBar badge (e.g. `+0.35`, `-1.20`, `M3`, `-M2`).
 */
export function formatEvalBarScore(scoreWhite: UciScore): string {
  if (scoreWhite.type === 'mate') {
    if (scoreWhite.value > 0) {
      return `M${scoreWhite.value}`;
    }
    if (scoreWhite.value < 0) {
      return `-M${Math.abs(scoreWhite.value)}`;
    }
    return 'M0';
  }
  const pawns = scoreWhite.value / 100;
  const sign = scoreWhite.value >= 0 ? '+' : '';
  return `${sign}${pawns.toFixed(2)}`;
}

/**
 * Converts a PgnEvalAnnotation (`{ cp?, mate? }`) into a White-perspective `UciScore`.
 */
export function pgnEvalToUciScore(evalAnnotation?: PgnEvalAnnotation): UciScore {
  if (!evalAnnotation) {
    return { type: 'cp', value: 0 };
  }
  if (typeof evalAnnotation.mate === 'number') {
    return { type: 'mate', value: evalAnnotation.mate };
  }
  return { type: 'cp', value: evalAnnotation.cp ?? 0 };
}

export interface EvalBarOptions {
  flipped?: boolean;
  initialScoreWhite?: UciScore;
}

/**
 * Animated, mate-aware Evaluation Bar component that flips orientation with the board.
 */
export class EvalBar {
  private readonly rootEl: HTMLElement;
  private readonly whiteFillEl: HTMLElement;
  private readonly blackFillEl: HTMLElement;
  private readonly scoreEl: HTMLElement;
  private readonly scoreTopEl: HTMLElement;
  private readonly scoreBottomEl: HTMLElement;

  private flipped: boolean;
  private scoreWhite: UciScore;

  constructor(parent: HTMLElement, options?: EvalBarOptions) {
    this.flipped = options?.flipped ?? false;
    this.scoreWhite = options?.initialScoreWhite ?? { type: 'cp', value: 0 };

    this.rootEl = document.createElement('div');
    this.rootEl.className = 'wc-eval-bar';
    this.rootEl.setAttribute('data-testid', 'eval-bar');
    this.rootEl.setAttribute('role', 'meter');
    this.rootEl.setAttribute('aria-label', 'Position evaluation bar');
    this.rootEl.setAttribute('aria-valuemin', '0');
    this.rootEl.setAttribute('aria-valuemax', '100');

    this.blackFillEl = document.createElement('div');
    this.blackFillEl.className = 'wc-eval-bar-black';
    this.blackFillEl.setAttribute('data-testid', 'eval-bar-black-fill');

    this.whiteFillEl = document.createElement('div');
    this.whiteFillEl.className = 'wc-eval-bar-white';
    this.whiteFillEl.setAttribute('data-testid', 'eval-bar-white-fill');

    const midlineEl = document.createElement('div');
    midlineEl.className = 'wc-eval-bar-midline';
    midlineEl.setAttribute('aria-hidden', 'true');

    // The score label has a fixed slot at each end of the bar. Switching ends moves the
    // text between slots instead of moving a box, so it never registers as a layout shift.
    this.scoreEl = document.createElement('div');
    this.scoreEl.className = 'wc-eval-bar-score';
    this.scoreEl.setAttribute('data-testid', 'eval-bar-score');
    this.scoreEl.setAttribute('aria-hidden', 'true');
    this.scoreTopEl = document.createElement('span');
    this.scoreTopEl.className = 'wc-eval-bar-score-slot';
    this.scoreTopEl.setAttribute('data-slot', 'top');
    this.scoreBottomEl = document.createElement('span');
    this.scoreBottomEl.className = 'wc-eval-bar-score-slot';
    this.scoreBottomEl.setAttribute('data-slot', 'bottom');
    this.scoreEl.appendChild(this.scoreTopEl);
    this.scoreEl.appendChild(this.scoreBottomEl);

    this.rootEl.appendChild(this.blackFillEl);
    this.rootEl.appendChild(this.whiteFillEl);
    this.rootEl.appendChild(midlineEl);
    this.rootEl.appendChild(this.scoreEl);
    parent.appendChild(this.rootEl);

    this.render();
  }

  public getElement(): HTMLElement {
    return this.rootEl;
  }

  public setScoreWhite(scoreWhite: UciScore): void {
    if (
      this.scoreWhite.type === scoreWhite.type &&
      this.scoreWhite.value === scoreWhite.value
    ) {
      return;
    }
    this.scoreWhite = { ...scoreWhite };
    this.render();
  }

  public getScoreWhite(): UciScore {
    return { ...this.scoreWhite };
  }

  public setFlipped(flipped: boolean): void {
    if (this.flipped === flipped) return;
    this.flipped = flipped;
    this.render();
  }

  public isFlipped(): boolean {
    return this.flipped;
  }

  public getWhiteFillPercent(): number {
    return scoreToEvalBarPercent(this.scoreWhite);
  }

  public getFormattedScore(): string {
    return formatEvalBarScore(this.scoreWhite);
  }

  private render(): void {
    const whitePct = scoreToEvalBarPercent(this.scoreWhite);
    const blackPct = 100 - whitePct;
    const isMate = this.scoreWhite.type === 'mate';
    const whiteAheadOrEqual =
      this.scoreWhite.type === 'mate'
        ? this.scoreWhite.value >= 0
        : this.scoreWhite.value >= 0;
    const scoreText = formatEvalBarScore(this.scoreWhite);

    this.rootEl.setAttribute('data-flipped', String(this.flipped));
    this.rootEl.setAttribute('data-white-pct', whitePct.toFixed(1));
    this.rootEl.setAttribute('data-mate', String(isMate));
    this.rootEl.setAttribute(
      'data-advantage',
      whiteAheadOrEqual ? 'w' : 'b',
    );
    this.rootEl.setAttribute('aria-valuenow', whitePct.toFixed(0));
    this.rootEl.setAttribute('aria-valuetext', scoreText);

    // When unflipped (White at bottom): White fill grows upward from bottom: 0
    // When flipped (Black at bottom, White at top): White fill grows downward from top: 0
    // Both fills are full height and scaled from their anchored edge with a transform,
    // which animates on the compositor and never shifts layout (a `height` change would).
    const whiteEdge = this.flipped ? 'top' : 'bottom';
    const blackEdge = this.flipped ? 'bottom' : 'top';
    this.whiteFillEl.style[whiteEdge] = '0%';
    this.whiteFillEl.style[blackEdge] = 'auto';
    this.blackFillEl.style[blackEdge] = '0%';
    this.blackFillEl.style[whiteEdge] = 'auto';
    this.whiteFillEl.style.transformOrigin = `center ${whiteEdge}`;
    this.blackFillEl.style.transformOrigin = `center ${blackEdge}`;
    this.whiteFillEl.style.transform = `scaleY(${(whitePct / 100).toFixed(4)})`;
    this.blackFillEl.style.transform = `scaleY(${(blackPct / 100).toFixed(4)})`;

    // Place the score label on the winning side's end of the bar
    const labelAtBottom = this.flipped ? !whiteAheadOrEqual : whiteAheadOrEqual;
    this.scoreEl.setAttribute(
      'data-position',
      labelAtBottom ? 'bottom' : 'top',
    );
    this.scoreEl.setAttribute(
      'data-theme-tone',
      whiteAheadOrEqual ? 'light' : 'dark',
    );
    const shown = labelAtBottom ? this.scoreBottomEl : this.scoreTopEl;
    const other = labelAtBottom ? this.scoreTopEl : this.scoreBottomEl;
    if (shown.textContent !== scoreText) {
      shown.textContent = scoreText;
    }
    if (other.textContent !== '') {
      other.textContent = '';
    }
  }
}
