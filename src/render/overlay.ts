import type { AnnotationColor } from '../core/game-tree';
import type { PieceSymbol, Square } from '../core/rules';

export interface OverlayLegalTarget {
  to: Square;
  isCapture: boolean;
}

export interface OverlayArrow {
  from: Square;
  to: Square;
  color: string;
  opacity?: number;
  dashed?: boolean;
  testId?: string;
}

export interface OverlayCircle {
  square: Square;
  color: string;
}

export const ANNOTATION_COLOR_HEX: Record<AnnotationColor, string> = {
  G: '#22c55e',
  R: '#ef4444',
  B: '#38bdf8',
  Y: '#eab308',
};

export function hexToAnnotationColor(hex: string): AnnotationColor {
  const lower = hex.trim().toLowerCase();
  if (lower === '#ef4444' || lower === 'red' || lower === 'r') return 'R';
  if (lower === '#38bdf8' || lower === 'blue' || lower === 'b') return 'B';
  if (lower === '#eab308' || lower === '#f59e0b' || lower === 'yellow' || lower === 'y') {
    return 'Y';
  }
  return 'G';
}

export function resolveModifierAnnotationColor(event: {
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): { code: AnnotationColor; hex: string } {
  if ((event.shiftKey && event.altKey) || event.ctrlKey || event.metaKey) {
    return { code: 'Y', hex: ANNOTATION_COLOR_HEX.Y };
  }
  if (event.shiftKey) {
    return { code: 'R', hex: ANNOTATION_COLOR_HEX.R };
  }
  if (event.altKey) {
    return { code: 'B', hex: ANNOTATION_COLOR_HEX.B };
  }
  return { code: 'G', hex: ANNOTATION_COLOR_HEX.G };
}

export interface BoardOverlayState {
  flipped: boolean;
  selectedSquare: Square | null;
  hoveredSquare: Square | null;
  /** The hovered square is one the held piece may be dropped on (stronger highlight). */
  hoveredIsTarget?: boolean;
  lastMove: { from: Square; to: Square } | null;
  checkSquare: Square | null;
  legalMoves: OverlayLegalTarget[];
  /** Queued premoves in execution order. */
  premoves: Array<{ from: Square; to: Square; promotion?: PieceSymbol }>;
  /** Squares of a premove queue that was just cancelled because a premove was illegal. */
  premoveFlash?: Square[];
  premoveTargets: Square[];
  pendingConfirmMove: { from: Square; to: Square } | null;
  hintMove: { from: Square; to: Square } | null;
  bestMove?: { from: Square; to: Square } | null;
  threatMove?: { from: Square; to: Square } | null;
  ghostArrows?: Array<{ from: Square; to: Square }>;
  arrows: OverlayArrow[];
  circles: OverlayCircle[];
}

const FILES = 'abcdefgh';

export function squareToBoardCoords(
  square: Square,
  flipped: boolean,
): { col: number; row: number; x: number; y: number; cx: number; cy: number } {
  const fileIdx = FILES.indexOf(square[0] ?? 'a');
  const rankIdx = Number(square[1] ?? '1') - 1; // 0 for rank 1, 7 for rank 8

  const col = flipped ? 7 - fileIdx : fileIdx;
  const row = flipped ? rankIdx : 7 - rankIdx;

  const x = col * 100;
  const y = row * 100;
  return {
    col,
    row,
    x,
    y,
    cx: x + 50,
    cy: y + 50,
  };
}

function buildStaticSignature(state: BoardOverlayState): string {
  const legalKey = state.legalMoves.map((m) => `${m.to}${m.isCapture ? 'x' : '.'}`).join(',');
  const premoveKey = state.premoves.map((p) => `${p.from}-${p.to}-${p.promotion ?? ''}`).join(',');
  const premoveFlashKey = (state.premoveFlash ?? []).join(',');
  const premoveTargetsKey = state.premoveTargets.join(',');
  const confirmKey = state.pendingConfirmMove ? `${state.pendingConfirmMove.from}-${state.pendingConfirmMove.to}` : '';
  const hintKey = state.hintMove ? `${state.hintMove.from}-${state.hintMove.to}` : '';
  const bestKey = state.bestMove ? `${state.bestMove.from}-${state.bestMove.to}` : '';
  const threatKey = state.threatMove ? `${state.threatMove.from}-${state.threatMove.to}` : '';
  const ghostKey = (state.ghostArrows ?? []).map((g) => `${g.from}>${g.to}`).join(',');
  const arrowsKey = state.arrows
    .map((a) => `${a.from}>${a.to}:${a.color}:${a.opacity ?? 0.85}:${a.dashed ? 1 : 0}`)
    .join(',');
  const circlesKey = state.circles.map((c) => `${c.square}:${c.color}`).join(',');

  return [
    state.flipped ? 'F1' : 'F0',
    state.selectedSquare ?? '',
    state.lastMove ? `${state.lastMove.from}-${state.lastMove.to}` : '',
    state.checkSquare ?? '',
    legalKey,
    premoveKey,
    premoveFlashKey,
    premoveTargetsKey,
    confirmKey,
    hintKey,
    bestKey,
    threatKey,
    ghostKey,
    arrowsKey,
    circlesKey,
  ].join('|');
}

function renderArrowSvg(
  from: Square,
  to: Square,
  flipped: boolean,
  color: string,
  opacity = 0.88,
  dashed = false,
  testId?: string,
): string {
  if (from === to) return '';
  const start = squareToBoardCoords(from, flipped);
  const end = squareToBoardCoords(to, flipped);

  const dx = end.cx - start.cx;
  const dy = end.cy - start.cy;
  const len = Math.hypot(dx, dy);
  if (len < 1) return '';

  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;

  // Offset start slightly from center, and pull shaft back for arrowhead
  const startOffset = 18;
  const headLength = 34;
  const headHalfWidth = 22;
  const shaftHalfWidth = 9;

  const sx = start.cx + ux * startOffset;
  const sy = start.cy + uy * startOffset;
  const tipX = end.cx - ux * 6;
  const tipY = end.cy - uy * 6;
  const baseCenterX = tipX - ux * headLength;
  const baseCenterY = tipY - uy * headLength;

  const dataAttrs = [
    testId ? `data-testid="${testId}"` : '',
    `data-from="${from}"`,
    `data-to="${to}"`,
    `data-color="${color}"`,
    `data-start-cx="${start.cx}"`,
    `data-start-cy="${start.cy}"`,
    `data-end-cx="${end.cx}"`,
    `data-end-cy="${end.cy}"`,
  ]
    .filter(Boolean)
    .join(' ');

  if (dashed) {
    return `<g opacity="${opacity}" ${dataAttrs}>
      <line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${baseCenterX.toFixed(1)}" y2="${baseCenterY.toFixed(1)}"
        stroke="${color}" stroke-width="14" stroke-dasharray="16 10" stroke-linecap="round" />
      <polygon points="${tipX.toFixed(1)},${tipY.toFixed(1)} ${(baseCenterX + px * headHalfWidth).toFixed(1)},${(baseCenterY + py * headHalfWidth).toFixed(1)} ${(baseCenterX - px * headHalfWidth).toFixed(1)},${(baseCenterY - py * headHalfWidth).toFixed(1)}"
        fill="${color}" />
    </g>`;
  }

  const p1x = sx + px * shaftHalfWidth;
  const p1y = sy + py * shaftHalfWidth;
  const p2x = baseCenterX + px * shaftHalfWidth;
  const p2y = baseCenterY + py * shaftHalfWidth;
  const p3x = baseCenterX + px * headHalfWidth;
  const p3y = baseCenterY + py * headHalfWidth;
  const p4x = tipX;
  const p4y = tipY;
  const p5x = baseCenterX - px * headHalfWidth;
  const p5y = baseCenterY - py * headHalfWidth;
  const p6x = baseCenterX - px * shaftHalfWidth;
  const p6y = baseCenterY - py * shaftHalfWidth;
  const p7x = sx - px * shaftHalfWidth;
  const p7y = sy - py * shaftHalfWidth;

  const points = [
    `${p1x.toFixed(1)},${p1y.toFixed(1)}`,
    `${p2x.toFixed(1)},${p2y.toFixed(1)}`,
    `${p3x.toFixed(1)},${p3y.toFixed(1)}`,
    `${p4x.toFixed(1)},${p4y.toFixed(1)}`,
    `${p5x.toFixed(1)},${p5y.toFixed(1)}`,
    `${p6x.toFixed(1)},${p6y.toFixed(1)}`,
    `${p7x.toFixed(1)},${p7y.toFixed(1)}`,
  ].join(' ');

  return `<polygon points="${points}" fill="${color}" stroke="rgba(7, 9, 14, 0.45)" stroke-width="2" opacity="${opacity}" ${dataAttrs} />`;
}

/**
 * Single-layer SVG overlay for arrows, square highlights, legal-move dots, capture rings,
 * king-in-check halo, best-move/threat/ghost arrows, and premove markers.
 * Redraws ONLY when state changes.
 */
export class BoardOverlay {
  private readonly svgEl: SVGSVGElement;
  private readonly staticGroupEl: SVGGElement;
  private readonly hoverRectEl: SVGRectElement;
  private lastStaticSignature = '';
  private lastHoverKey = '';
  private redrawCount = 0;

  constructor(parent: HTMLElement) {
    const ns = 'http://www.w3.org/2000/svg';
    this.svgEl = document.createElementNS(ns, 'svg');
    this.svgEl.setAttribute('class', 'wc-board-overlay');
    this.svgEl.setAttribute('viewBox', '0 0 800 800');
    this.svgEl.setAttribute('aria-hidden', 'true');
    this.svgEl.setAttribute('data-testid', 'board-overlay-svg');

    // Defs for radial check glow
    const defs = document.createElementNS(ns, 'defs');
    defs.innerHTML = `
      <radialGradient id="wc-check-halo" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ef4444" stop-opacity="0.88" />
        <stop offset="62%" stop-color="#dc2626" stop-opacity="0.52" />
        <stop offset="100%" stop-color="#ef4444" stop-opacity="0" />
      </radialGradient>
    `;
    this.svgEl.appendChild(defs);

    // The square under a dragged piece: an inset frame, bright on a legal drop square
    this.hoverRectEl = document.createElementNS(ns, 'rect');
    this.hoverRectEl.setAttribute('width', '92');
    this.hoverRectEl.setAttribute('height', '92');
    this.hoverRectEl.setAttribute('rx', '6');
    this.hoverRectEl.setAttribute('class', 'wc-drag-hover');
    this.hoverRectEl.setAttribute('visibility', 'hidden');
    this.hoverRectEl.setAttribute('data-testid', 'overlay-hover-square');
    this.svgEl.appendChild(this.hoverRectEl);

    this.staticGroupEl = document.createElementNS(ns, 'g');
    this.staticGroupEl.setAttribute('data-testid', 'overlay-static-layer');
    this.svgEl.appendChild(this.staticGroupEl);

    parent.appendChild(this.svgEl);
  }

  public getElement(): SVGSVGElement {
    return this.svgEl;
  }

  public getRedrawCount(): number {
    return this.redrawCount;
  }

  public render(state: BoardOverlayState): boolean {
    let changed = false;

    // 1. Check hover square fast path (only updates attributes on the single hover <rect>)
    const hoverKey = state.hoveredSquare
      ? `${state.flipped ? '1' : '0'}:${state.hoveredSquare}:${state.hoveredIsTarget ? 'T' : ''}`
      : '';
    if (hoverKey !== this.lastHoverKey) {
      this.lastHoverKey = hoverKey;
      changed = true;
      if (state.hoveredSquare) {
        const coords = squareToBoardCoords(state.hoveredSquare, state.flipped);
        this.hoverRectEl.setAttribute('x', String(coords.x + 4));
        this.hoverRectEl.setAttribute('y', String(coords.y + 4));
        this.hoverRectEl.setAttribute('data-square', state.hoveredSquare);
        this.hoverRectEl.setAttribute('data-target', String(Boolean(state.hoveredIsTarget)));
        this.hoverRectEl.setAttribute('visibility', 'visible');
      } else {
        this.hoverRectEl.setAttribute('visibility', 'hidden');
      }
    }

    // 2. Check static overlay signature (highlights, dots, arrows, circles)
    const staticSig = buildStaticSignature(state);
    if (staticSig === this.lastStaticSignature) {
      if (changed) {
        this.redrawCount++;
      }
      return changed;
    }

    this.lastStaticSignature = staticSig;
    this.redrawCount++;

    const parts: string[] = [];

    // Last-move square highlights (#f59e0b, opacity 0.25 from legacy audit)
    if (state.lastMove) {
      const fromC = squareToBoardCoords(state.lastMove.from, state.flipped);
      const toC = squareToBoardCoords(state.lastMove.to, state.flipped);
      parts.push(
        `<rect x="${fromC.x}" y="${fromC.y}" width="100" height="100" fill="#f59e0b" fill-opacity="0.25" data-testid="overlay-last-move-from" data-square="${state.lastMove.from}" />`,
      );
      parts.push(
        `<rect x="${toC.x}" y="${toC.y}" width="100" height="100" fill="#f59e0b" fill-opacity="0.29" data-testid="overlay-last-move-to" data-square="${state.lastMove.to}" />`,
      );
    }

    // Queued premoves (#10b981 origin 0.26, target 0.42, target ring #34d399 0.95 from the
    // legacy audit), each target numbered in execution order. A square used by several
    // premoves shows the last one that lands there.
    if (state.premoves.length > 0) {
      const targetOrder = new Map<Square, number>();
      state.premoves.forEach((p, i) => targetOrder.set(p.to, i + 1));
      const origins = new Set<Square>();
      state.premoves.forEach((p, i) => {
        if (targetOrder.has(p.from) || origins.has(p.from)) return;
        origins.add(p.from);
        const fromC = squareToBoardCoords(p.from, state.flipped);
        parts.push(
          `<rect x="${fromC.x}" y="${fromC.y}" width="100" height="100" fill="#10b981" fill-opacity="0.26" data-testid="overlay-premove-from" data-square="${p.from}" data-order="${i + 1}" />`,
        );
      });
      for (const [sq, order] of targetOrder) {
        const toC = squareToBoardCoords(sq, state.flipped);
        parts.push(
          `<rect x="${toC.x}" y="${toC.y}" width="100" height="100" fill="#10b981" fill-opacity="0.42" data-testid="overlay-premove-to" data-square="${sq}" data-order="${order}" />`,
        );
        parts.push(
          `<rect x="${toC.x + 4}" y="${toC.y + 4}" width="92" height="92" rx="8" fill="none" stroke="#34d399" stroke-width="5" stroke-opacity="0.95" />`,
        );
        parts.push(
          `<circle cx="${toC.x + 20}" cy="${toC.y + 20}" r="14" fill="#065f46" stroke="#34d399" stroke-width="2.5" />`,
        );
        parts.push(
          `<text x="${toC.x + 20}" y="${toC.y + 20}" text-anchor="middle" dominant-baseline="central" font-family="ui-monospace, Consolas, monospace" font-size="18" font-weight="700" fill="#ecfdf5" data-testid="overlay-premove-order" data-square="${sq}">${order}</text>`,
        );
      }
    }

    // Brief flash on the squares of a premove queue cancelled by an illegal premove
    for (const sq of state.premoveFlash ?? []) {
      const c = squareToBoardCoords(sq, state.flipped);
      parts.push(
        `<rect x="${c.x}" y="${c.y}" width="100" height="100" fill="#ef4444" class="wc-premove-flash" data-testid="overlay-premove-flash" data-square="${sq}" />`,
      );
    }

    // Pending confirm-move highlight
    if (state.pendingConfirmMove) {
      const fromC = squareToBoardCoords(state.pendingConfirmMove.from, state.flipped);
      const toC = squareToBoardCoords(state.pendingConfirmMove.to, state.flipped);
      parts.push(`<rect x="${fromC.x}" y="${fromC.y}" width="100" height="100" fill="#38bdf8" fill-opacity="0.24" />`);
      parts.push(
        `<rect x="${toC.x + 3}" y="${toC.y + 3}" width="94" height="94" rx="8" fill="#38bdf8" fill-opacity="0.30" stroke="#38bdf8" stroke-width="5" data-testid="overlay-confirm-target" data-square="${state.pendingConfirmMove.to}" />`,
      );
    }

    // King in check halo & pulsing ring (#ef4444, opacity 0.85 from legacy audit)
    if (state.checkSquare) {
      const checkC = squareToBoardCoords(state.checkSquare, state.flipped);
      parts.push(
        `<circle cx="${checkC.cx}" cy="${checkC.cy}" r="49" fill="url(#wc-check-halo)" data-testid="overlay-check-halo" data-square="${state.checkSquare}" />`,
      );
      parts.push(
        `<rect x="${checkC.x + 3}" y="${checkC.y + 3}" width="94" height="94" rx="10" fill="none" stroke="#ef4444" stroke-width="5.5" stroke-opacity="0.88" class="wc-check-pulse" />`,
      );
    }

    // Selected square ring (#fbbf24, opacity 0.90 from legacy audit)
    if (state.selectedSquare) {
      const selC = squareToBoardCoords(state.selectedSquare, state.flipped);
      parts.push(
        `<rect x="${selC.x + 3.5}" y="${selC.y + 3.5}" width="93" height="93" rx="8" fill="rgba(251, 191, 36, 0.14)" stroke="#fbbf24" stroke-width="5.5" stroke-opacity="0.90" data-testid="overlay-selected-square" data-square="${state.selectedSquare}" />`,
      );
    }

    // User-drawn circles
    for (const circle of state.circles) {
      const c = squareToBoardCoords(circle.square, state.flipped);
      parts.push(
        `<circle cx="${c.cx}" cy="${c.cy}" r="43" fill="none" stroke="${circle.color}" stroke-width="6" stroke-opacity="0.88" data-testid="overlay-user-circle" data-square="${circle.square}" data-color="${circle.color}" />`,
      );
    }

    // Legal move dots (#38bdf8) with a dark rim so they read on light marble too, and
    // capture rings (#ef4444)
    for (const move of state.legalMoves) {
      const c = squareToBoardCoords(move.to, state.flipped);
      if (move.isCapture) {
        parts.push(
          `<circle cx="${c.cx}" cy="${c.cy}" r="42" fill="none" stroke="#0b0e16" stroke-width="13" stroke-opacity="0.35" />`,
        );
        parts.push(
          `<circle cx="${c.cx}" cy="${c.cy}" r="42" fill="none" stroke="#ef4444" stroke-width="9" stroke-opacity="0.92" data-testid="overlay-legal-capture" data-square="${move.to}" />`,
        );
      } else {
        parts.push(
          `<circle cx="${c.cx}" cy="${c.cy}" r="19" fill="#38bdf8" fill-opacity="0.9" stroke="#0b0e16" stroke-width="3" stroke-opacity="0.45" data-testid="overlay-legal-dot" data-square="${move.to}" />`,
        );
      }
    }

    // Premove target dots (#10b981, opacity 0.65 from legacy audit)
    for (const sq of state.premoveTargets) {
      const c = squareToBoardCoords(sq, state.flipped);
      parts.push(
        `<circle cx="${c.cx}" cy="${c.cy}" r="13.5" fill="#10b981" fill-opacity="0.65" data-testid="overlay-premove-dot" data-square="${sq}" />`,
      );
    }

    // Threat arrow (null-move opponent threat, dashed crimson #ef4444)
    if (state.threatMove) {
      parts.push(
        renderArrowSvg(
          state.threatMove.from,
          state.threatMove.to,
          state.flipped,
          '#ef4444',
          0.86,
          true,
          'overlay-threat-arrow',
        ),
      );
    }

    // Best-move arrow (Stockfish top line move, solid emerald/cyan #10b981)
    if (state.bestMove) {
      parts.push(
        renderArrowSvg(
          state.bestMove.from,
          state.bestMove.to,
          state.flipped,
          '#10b981',
          0.9,
          false,
          'overlay-best-move-arrow',
        ),
      );
    }

    // Ghost preview trajectory arrows
    if (state.ghostArrows) {
      for (const ga of state.ghostArrows) {
        parts.push(renderArrowSvg(ga.from, ga.to, state.flipped, '#a855f7', 0.76, true, 'overlay-ghost-arrow'));
      }
    }

    // Hint arrow
    if (state.hintMove) {
      parts.push(
        renderArrowSvg(
          state.hintMove.from,
          state.hintMove.to,
          state.flipped,
          '#f59e0b',
          0.92,
          false,
          'overlay-hint-arrow',
        ),
      );
    }

    // Custom / user-drawn arrows
    for (const arrow of state.arrows) {
      parts.push(
        renderArrowSvg(
          arrow.from,
          arrow.to,
          state.flipped,
          arrow.color,
          arrow.opacity ?? 0.88,
          arrow.dashed ?? false,
          arrow.testId ?? 'overlay-user-arrow',
        ),
      );
    }

    this.staticGroupEl.innerHTML = parts.join('');
    return true;
  }
}
