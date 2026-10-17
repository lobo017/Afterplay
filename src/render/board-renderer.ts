import type {
  PgnArrowAnnotation,
  PgnHighlightAnnotation,
} from '../core/game-tree';
import {
  RulesAdapter,
  type Color,
  type ExecutedMove,
  type MoveInput,
  type Piece,
  type PieceSymbol,
  type Square,
} from '../core/rules';
import {
  ANNOTATION_COLOR_HEX,
  BoardOverlay,
  hexToAnnotationColor,
  resolveModifierAnnotationColor,
  squareToBoardCoords,
  type OverlayArrow,
  type OverlayCircle,
  type OverlayLegalTarget,
} from './overlay';
import { CaptureParticleSystem } from './particles';
import { getPieceSvgMarkup } from './piece-sets';
import {
  BOARD_THEMES,
  DEFAULT_BOARD_THEME,
  DEFAULT_PIECE_SET,
  type BoardThemeId,
  type PieceSetId,
} from './themes';

export interface PremoveInput {
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
}

export interface MoveAnimationDescriptor {
  from: Square;
  to: Square;
  wasDragged?: boolean;
  rookFrom?: Square;
  rookTo?: Square;
}

export interface GhostPreviewInput {
  targetFen: string;
  moves?: Array<{ from: Square; to: Square }>;
}

export interface BoardRendererOptions {
  flipped?: boolean;
  interactiveColor?: Color | 'both' | 'none';
  enablePremoves?: boolean;
  autoQueen?: boolean;
  confirmMove?: boolean;
  captureEffects?: boolean;
  boardTheme?: BoardThemeId;
  pieceSet?: PieceSetId;
  animationDurationMs?: number;
  onMove?: (move: MoveInput, wasDragged: boolean) => void;
  onPremoveChange?: (premove: PremoveInput | null) => void;
  onSelectSquare?: (square: Square, piece: Piece) => void;
  onSquareEdit?: (square: Square) => boolean;
  onAnnotationsChange?: (
    arrows: PgnArrowAnnotation[],
    highlights: PgnHighlightAnnotation[],
  ) => void;
  onFlipChange?: (flipped: boolean) => void;
}

interface ActiveDragState {
  pointerId: number;
  from: Square;
  piece: Piece;
  element: HTMLElement;
  startX: number;
  startY: number;
  isDragging: boolean;
}

interface PendingPromotionState {
  from: Square;
  to: Square;
  color: Color;
  isPremove: boolean;
  wasDragged: boolean;
}

interface PendingConfirmState {
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
  wasDragged: boolean;
}

const FILES = 'abcdefgh';

function parseFenBoardSquares(fen: string): Map<Square, Piece> {
  const squares = new Map<Square, Piece>();
  const boardPart = fen.trim().split(/\s+/)[0] ?? '';
  const rows = boardPart.split('/');
  if (rows.length !== 8) return squares;

  for (let r = 0; r < 8; r++) {
    const rowStr = rows[r]!;
    let f = 0;
    for (let i = 0; i < rowStr.length; i++) {
      const ch = rowStr[i]!;
      if (ch >= '1' && ch <= '8') {
        f += Number(ch);
      } else if (/^[prnbqkPRNBQK]$/.test(ch)) {
        if (f < 8) {
          const sq = `${FILES[f]}${8 - r}` as Square;
          squares.set(sq, {
            color: ch === ch.toUpperCase() ? 'w' : 'b',
            type: ch.toLowerCase() as PieceSymbol,
          });
        }
        f++;
      }
    }
  }
  return squares;
}

/**
 * Computes all pseudo-legal premove target squares for a piece at `from` of color `color`,
 * including empty-square pawn diagonal captures and castling destinations.
 */
export function computePremoveTargets(
  adapter: RulesAdapter,
  from: Square,
  color: Color,
): Square[] {
  const piece = adapter.get(from);
  if (!piece || piece.color !== color) return [];

  const f0 = FILES.indexOf(from[0] ?? 'a');
  const r0 = Number(from[1] ?? '1') - 1;
  const targets = new Set<Square>();

  const addIfValid = (f: number, r: number): void => {
    if (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const sq = `${FILES[f]}${r + 1}` as Square;
      if (sq !== from) {
        targets.add(sq);
      }
    }
  };

  switch (piece.type) {
    case 'p': {
      const dir = color === 'w' ? 1 : -1;
      const startRank = color === 'w' ? 1 : 6;
      addIfValid(f0, r0 + dir);
      if (r0 === startRank) {
        addIfValid(f0, r0 + dir * 2);
      }
      addIfValid(f0 - 1, r0 + dir);
      addIfValid(f0 + 1, r0 + dir);
      break;
    }
    case 'n': {
      const jumps: Array<[number, number]> = [
        [1, 2],
        [2, 1],
        [2, -1],
        [1, -2],
        [-1, -2],
        [-2, -1],
        [-2, 1],
        [-1, 2],
      ];
      for (const [df, dr] of jumps) {
        addIfValid(f0 + df, r0 + dr);
      }
      break;
    }
    case 'b': {
      for (let i = 1; i < 8; i++) {
        addIfValid(f0 + i, r0 + i);
        addIfValid(f0 + i, r0 - i);
        addIfValid(f0 - i, r0 + i);
        addIfValid(f0 - i, r0 - i);
      }
      break;
    }
    case 'r': {
      for (let i = 0; i < 8; i++) {
        addIfValid(i, r0);
        addIfValid(f0, i);
      }
      break;
    }
    case 'q': {
      for (let i = 0; i < 8; i++) {
        addIfValid(i, r0);
        addIfValid(f0, i);
      }
      for (let i = 1; i < 8; i++) {
        addIfValid(f0 + i, r0 + i);
        addIfValid(f0 + i, r0 - i);
        addIfValid(f0 - i, r0 + i);
        addIfValid(f0 - i, r0 - i);
      }
      break;
    }
    case 'k': {
      for (let df = -1; df <= 1; df++) {
        for (let dr = -1; dr <= 1; dr++) {
          if (df !== 0 || dr !== 0) {
            addIfValid(f0 + df, r0 + dr);
          }
        }
      }
      const homeRank = color === 'w' ? 0 : 7;
      if (r0 === homeRank) {
        addIfValid(2, homeRank); // c1 / c8
        addIfValid(6, homeRank); // g1 / g8
      }
      break;
    }
  }

  return Array.from(targets);
}

/**
 * Hand-written imperative 2D chessboard renderer.
 * - Moves pieces strictly via CSS `transform: translate3d(...)`.
 * - Animates moves via the Web Animations API (`element.animate()`).
 * - Uses a single SVG layer (`BoardOverlay`) that redraws only when state changes.
 * - Uses a dedicated ghost pieces layer (`wc-ghost-pieces-layer`) for MultiPV line previews.
 * - Uses a fixed-pool `<canvas>` layer (`CaptureParticleSystem`) for capture shatter particles.
 */
export class BoardRenderer {
  private readonly container: HTMLElement;
  private readonly frameEl: HTMLElement;
  private readonly boardEl: HTMLElement;
  private readonly gridEl: HTMLElement;
  private readonly coordsEl: HTMLElement;
  private readonly overlay: BoardOverlay;
  private readonly piecesLayerEl: HTMLElement;
  private readonly ghostLayerEl: HTMLElement;
  private readonly particles: CaptureParticleSystem;
  private readonly promotionBackdropEl: HTMLElement;
  private readonly confirmBarEl: HTMLElement;

  private adapter: RulesAdapter;
  private flipped: boolean;
  private interactiveColor: Color | 'both' | 'none';
  private enablePremoves: boolean;
  private autoQueen: boolean;
  private confirmMove: boolean;
  private boardTheme: BoardThemeId;
  private pieceSet: PieceSetId;
  private animationDurationMs: number;

  private readonly pieceElements = new Map<Square, HTMLElement>();
  private readonly freePiecePool: HTMLElement[] = [];
  private readonly ghostPieceElements = new Map<Square, HTMLElement>();

  private selectedSquare: Square | null = null;
  private hoveredSquare: Square | null = null;
  private lastMove: { from: Square; to: Square } | null = null;
  private premove: PremoveInput | null = null;
  private premoveTargets: Square[] = [];
  private hintMove: { from: Square; to: Square } | null = null;
  private bestMoveArrow: { from: Square; to: Square } | null = null;
  private threatMoveArrow: { from: Square; to: Square } | null = null;
  private ghostPreview: GhostPreviewInput | null = null;
  private ghostArrows: Array<{ from: Square; to: Square }> = [];
  private userArrows: OverlayArrow[] = [];
  private userCircles: OverlayCircle[] = [];

  private dragState: ActiveDragState | null = null;
  private rightDragStart: Square | null = null;
  private pendingPromotion: PendingPromotionState | null = null;
  private pendingConfirm: PendingConfirmState | null = null;
  private cachedBoardRect: DOMRect | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private onMoveCallback:
    | ((move: MoveInput, wasDragged: boolean) => void)
    | undefined;
  private onPremoveChangeCallback:
    | ((premove: PremoveInput | null) => void)
    | undefined;
  private onSelectSquareCallback:
    | ((square: Square, piece: Piece) => void)
    | undefined;
  private onSquareEditCallback: ((square: Square) => boolean) | undefined;
  private onAnnotationsChangeCallback:
    | ((
        arrows: PgnArrowAnnotation[],
        highlights: PgnHighlightAnnotation[],
      ) => void)
    | undefined;
  private onFlipChangeCallback: ((flipped: boolean) => void) | undefined;

  constructor(parent: HTMLElement, options?: BoardRendererOptions) {
    this.container = parent;
    this.adapter = new RulesAdapter();
    this.flipped = options?.flipped ?? false;
    this.interactiveColor = options?.interactiveColor ?? 'w';
    this.enablePremoves = options?.enablePremoves ?? true;
    this.autoQueen = options?.autoQueen ?? false;
    this.confirmMove = options?.confirmMove ?? false;
    this.boardTheme = options?.boardTheme ?? DEFAULT_BOARD_THEME;
    this.pieceSet = options?.pieceSet ?? DEFAULT_PIECE_SET;
    this.animationDurationMs = options?.animationDurationMs ?? 170;

    this.onMoveCallback = options?.onMove;
    this.onPremoveChangeCallback = options?.onPremoveChange;
    this.onSelectSquareCallback = options?.onSelectSquare;
    this.onSquareEditCallback = options?.onSquareEdit;
    this.onAnnotationsChangeCallback = options?.onAnnotationsChange;
    this.onFlipChangeCallback = options?.onFlipChange;

    // Outer carved cathedral frame
    this.frameEl = document.createElement('div');
    this.frameEl.className = 'wc-board-frame';
    this.frameEl.setAttribute('data-testid', 'chess-board-frame');
    this.frameEl.setAttribute('data-theme', this.boardTheme);

    // Inner interactive 8x8 surface
    this.boardEl = document.createElement('div');
    this.boardEl.className = 'wc-board-surface';
    this.boardEl.setAttribute('data-testid', 'chess-board');
    this.boardEl.setAttribute('data-flipped', String(this.flipped));
    this.boardEl.setAttribute('role', 'application');
    this.boardEl.setAttribute('aria-label', 'Chessboard');
    this.boardEl.tabIndex = 0;

    // 64 static squares grid
    this.gridEl = document.createElement('div');
    this.gridEl.className = 'wc-board-grid';
    this.boardEl.appendChild(this.gridEl);

    // Coordinate labels (A-H, 1-8)
    this.coordsEl = document.createElement('div');
    this.coordsEl.className = 'wc-board-coords';
    this.coordsEl.setAttribute('aria-hidden', 'true');
    this.boardEl.appendChild(this.coordsEl);

    // Single SVG overlay layer (below pieces for square highlights/dots, with arrows visible)
    this.overlay = new BoardOverlay(this.boardEl);

    // Imperative SVG pieces layer (pieces moved strictly via CSS transform: translate3d)
    this.piecesLayerEl = document.createElement('div');
    this.piecesLayerEl.className = 'wc-pieces-layer';
    this.piecesLayerEl.setAttribute('data-testid', 'board-pieces-layer');
    this.boardEl.appendChild(this.piecesLayerEl);

    // Ghost pieces layer for engine line hover previews
    this.ghostLayerEl = document.createElement('div');
    this.ghostLayerEl.className = 'wc-ghost-pieces-layer';
    this.ghostLayerEl.setAttribute('data-testid', 'board-ghost-layer');
    this.boardEl.appendChild(this.ghostLayerEl);

    // Single <canvas> capture shatter particle overlay
    this.particles = new CaptureParticleSystem(this.boardEl);
    if (options?.captureEffects === false) {
      this.particles.setEnabled(false);
    }

    // Promotion picker modal (hidden by default, cancellable via button, backdrop, or Escape)
    this.promotionBackdropEl = document.createElement('div');
    this.promotionBackdropEl.className = 'wc-promotion-backdrop';
    this.promotionBackdropEl.setAttribute('data-testid', 'promotion-backdrop');
    this.promotionBackdropEl.hidden = true;
    this.boardEl.appendChild(this.promotionBackdropEl);

    // Confirm move floating bar (hidden by default)
    this.confirmBarEl = document.createElement('div');
    this.confirmBarEl.className = 'wc-confirm-move-bar';
    this.confirmBarEl.setAttribute('data-testid', 'confirm-move-bar');
    this.confirmBarEl.hidden = true;
    this.confirmBarEl.innerHTML = `
      <span class="wc-confirm-label" data-testid="confirm-move-label">Confirm Move?</span>
      <div class="wc-confirm-actions">
        <button type="button" class="wc-btn wc-btn-primary wc-btn-sm" data-testid="confirm-move-accept">Confirm</button>
        <button type="button" class="wc-btn wc-btn-ghost wc-btn-sm" data-testid="confirm-move-cancel">Cancel</button>
      </div>
    `;
    this.frameEl.appendChild(this.boardEl);
    this.frameEl.appendChild(this.confirmBarEl);
    this.container.appendChild(this.frameEl);

    this.applyThemeVariables();
    this.renderSquaresGrid();
    this.renderCoordinates();
    this.syncPiecesFromAdapter();
    this.syncOverlay();
    this.bindEvents();
  }

  private applyThemeVariables(): void {
    const theme =
      BOARD_THEMES[this.boardTheme] ?? BOARD_THEMES['marble-obsidian'];
    this.frameEl.setAttribute('data-theme', this.boardTheme);
    this.frameEl.setAttribute('data-piece-set', this.pieceSet);
    const s = this.frameEl.style;
    s.setProperty('--board-light-base', theme.lightSquareBase);
    s.setProperty('--board-light-vein', theme.lightSquareVein);
    s.setProperty('--board-light-chamfer', theme.lightSquareChamfer);
    s.setProperty('--board-dark-base', theme.darkSquareBase);
    s.setProperty('--board-dark-vein', theme.darkSquareVein);
    s.setProperty('--board-dark-chamfer', theme.darkSquareChamfer);
    s.setProperty('--board-frame-outer', theme.frameOuter);
    s.setProperty('--board-frame-inner', theme.frameInner);
    s.setProperty('--board-grout', theme.groutColor);
    s.setProperty('--board-inlay', theme.inlayTrim);
    s.setProperty('--board-coord-light', theme.coordLight);
    s.setProperty('--board-coord-dark', theme.coordDark);
  }

  private renderSquaresGrid(): void {
    const parts: string[] = [];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const fileIdx = this.flipped ? 7 - col : col;
        const rankIdx = this.flipped ? row : 7 - row;
        const sq = `${FILES[fileIdx]}${rankIdx + 1}` as Square;
        const isLight = (fileIdx + rankIdx) % 2 === 1;
        parts.push(
          `<div class="wc-square ${
            isLight ? 'wc-square-light' : 'wc-square-dark'
          }" data-square="${sq}" data-testid="square-${sq}"></div>`,
        );
      }
    }
    this.gridEl.innerHTML = parts.join('');
  }

  private renderCoordinates(): void {
    const files = this.flipped
      ? ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']
      : ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const ranks = this.flipped
      ? ['1', '2', '3', '4', '5', '6', '7', '8']
      : ['8', '7', '6', '5', '4', '3', '2', '1'];

    const rankHtml = ranks
      .map(
        (r, idx) =>
          `<span class="wc-coord-rank" style="top: ${idx * 12.5 + 1}%" data-testid="coord-rank-${r}">${r}</span>`,
      )
      .join('');
    const fileHtml = files
      .map(
        (f, idx) =>
          `<span class="wc-coord-file" style="left: ${(idx + 1) * 12.5 - 2.6}%" data-testid="coord-file-${f}">${f}</span>`,
      )
      .join('');

    this.coordsEl.innerHTML = rankHtml + fileHtml;
  }

  private bindEvents(): void {
    this.boardEl.addEventListener('pointerdown', this.handlePointerDown);
    window.addEventListener('pointermove', this.handlePointerMove, {
      passive: true,
    });
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerCancel);
    this.boardEl.addEventListener('contextmenu', this.handleContextMenu);
    window.addEventListener('keydown', this.handleKeyDown);

    this.promotionBackdropEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });

    this.promotionBackdropEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement;
      const promoBtn = target.closest(
        '[data-promotion-piece]',
      ) as HTMLElement | null;
      if (promoBtn) {
        const piece = promoBtn.getAttribute(
          'data-promotion-piece',
        ) as PieceSymbol;
        this.resolvePromotionPicker(piece);
        return;
      }
      this.cancelPromotionPicker();
    });

    const acceptBtn = this.confirmBarEl.querySelector(
      '[data-testid="confirm-move-accept"]',
    );
    const cancelBtn = this.confirmBarEl.querySelector(
      '[data-testid="confirm-move-cancel"]',
    );
    acceptBtn?.addEventListener('click', () => this.acceptPendingConfirmMove());
    cancelBtn?.addEventListener('click', () => this.cancelPendingConfirmMove());

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.cachedBoardRect = null;
      });
      this.resizeObserver.observe(this.boardEl);
    }
  }

  private getBoardRect(): DOMRect {
    if (!this.cachedBoardRect) {
      this.cachedBoardRect = this.boardEl.getBoundingClientRect();
    }
    return this.cachedBoardRect;
  }

  public squareFromClientPoint(
    clientX: number,
    clientY: number,
  ): Square | null {
    const rect = this.getBoardRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const relX = clientX - rect.left;
    const relY = clientY - rect.top;
    if (relX < 0 || relY < 0 || relX >= rect.width || relY >= rect.height) {
      return null;
    }

    const col = Math.max(0, Math.min(7, Math.floor((relX / rect.width) * 8)));
    const row = Math.max(0, Math.min(7, Math.floor((relY / rect.height) * 8)));

    const fileIdx = this.flipped ? 7 - col : col;
    const rankIdx = this.flipped ? row : 7 - row;
    return `${FILES[fileIdx]}${rankIdx + 1}` as Square;
  }

  private getSquareTranslateTransform(square: Square): string {
    const { col, row } = squareToBoardCoords(square, this.flipped);
    return `translate3d(${col * 100}%, ${row * 100}%, 0)`;
  }

  private acquirePieceElement(
    square: Square,
    color: Color,
    piece: PieceSymbol,
  ): HTMLElement {
    const el = this.freePiecePool.pop() ?? document.createElement('div');
    el.className = 'wc-piece';
    el.setAttribute('data-square', square);
    el.setAttribute('data-color', color);
    el.setAttribute('data-piece', piece);
    el.setAttribute('data-testid', `piece-${square}`);
    el.innerHTML = getPieceSvgMarkup(this.pieceSet, color, piece);
    el.style.transform = this.getSquareTranslateTransform(square);
    if (!el.parentElement) {
      this.piecesLayerEl.appendChild(el);
    }
    return el;
  }

  private releasePieceElement(el: HTMLElement): void {
    el.classList.remove('wc-piece-dragging', 'wc-piece-ghost-vacated');
    el.remove();
    if (this.freePiecePool.length < 32) {
      this.freePiecePool.push(el);
    }
  }

  private syncPiecesFromAdapter(animation?: MoveAnimationDescriptor): void {
    const nextSquares = new Map<Square, Piece>();
    for (let r = 1; r <= 8; r++) {
      for (let f = 0; f < 8; f++) {
        const sq = `${FILES[f]}${r}` as Square;
        const p = this.adapter.get(sq);
        if (p) {
          nextSquares.set(sq, p);
        }
      }
    }

    // If a move animation descriptor is supplied, move the existing DOM element from `from` to `to`
    const animatedTargets = new Map<
      Square,
      { el: HTMLElement; fromSquare: Square; wasDragged: boolean }
    >();

    if (animation) {
      const movingEl = this.pieceElements.get(animation.from);
      if (movingEl && nextSquares.has(animation.to)) {
        this.pieceElements.delete(animation.from);
        animatedTargets.set(animation.to, {
          el: movingEl,
          fromSquare: animation.from,
          wasDragged: Boolean(animation.wasDragged),
        });
      }
      if (
        animation.rookFrom &&
        animation.rookTo &&
        animation.rookFrom !== animation.rookTo
      ) {
        const rookEl = this.pieceElements.get(animation.rookFrom);
        if (rookEl && nextSquares.has(animation.rookTo)) {
          this.pieceElements.delete(animation.rookFrom);
          animatedTargets.set(animation.rookTo, {
            el: rookEl,
            fromSquare: animation.rookFrom,
            wasDragged: false,
          });
        }
      }
    }

    // Release any piece elements on squares that no longer match
    for (const [sq, el] of this.pieceElements.entries()) {
      const nextPiece = nextSquares.get(sq);
      if (
        !nextPiece ||
        animatedTargets.has(sq) ||
        el.getAttribute('data-color') !== nextPiece.color ||
        el.getAttribute('data-piece') !== nextPiece.type
      ) {
        this.releasePieceElement(el);
        this.pieceElements.delete(sq);
      }
    }

    // Place / update all pieces
    for (const [sq, piece] of nextSquares.entries()) {
      const animEntry = animatedTargets.get(sq);
      if (animEntry) {
        const { el, fromSquare, wasDragged } = animEntry;
        el.classList.remove('wc-piece-ghost-vacated');
        el.setAttribute('data-square', sq);
        el.setAttribute('data-color', piece.color);
        el.setAttribute('data-piece', piece.type);
        el.setAttribute('data-testid', `piece-${sq}`);
        el.innerHTML = getPieceSvgMarkup(
          this.pieceSet,
          piece.color,
          piece.type,
        );
        const toTransform = this.getSquareTranslateTransform(sq);
        el.style.transform = toTransform;
        this.pieceElements.set(sq, el);

        if (
          !wasDragged &&
          this.animationDurationMs > 0 &&
          typeof el.animate === 'function'
        ) {
          const fromTransform = this.getSquareTranslateTransform(fromSquare);
          try {
            el.animate(
              [{ transform: fromTransform }, { transform: toTransform }],
              {
                duration: this.animationDurationMs,
                easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
              },
            );
          } catch {
            // Ignore Web Animations API errors in headless/mock environments
          }
        }
        continue;
      }

      const existing = this.pieceElements.get(sq);
      if (existing) {
        existing.classList.remove('wc-piece-ghost-vacated');
        existing.style.transform = this.getSquareTranslateTransform(sq);
      } else {
        const el = this.acquirePieceElement(sq, piece.color, piece.type);
        this.pieceElements.set(sq, el);
      }
    }
  }

  /**
   * Renders an arbitrary square map directly on the board (used by the Position Editor
   * when previewing an in-progress board setup before full FEN validation passes).
   */
  public setArbitrarySquares(squares: Map<Square, Piece>): void {
    this.setGhostPreview(null);
    this.selectedSquare = null;
    this.premoveTargets = [];

    for (const [sq, el] of this.pieceElements.entries()) {
      const nextPiece = squares.get(sq);
      if (
        !nextPiece ||
        el.getAttribute('data-color') !== nextPiece.color ||
        el.getAttribute('data-piece') !== nextPiece.type
      ) {
        this.releasePieceElement(el);
        this.pieceElements.delete(sq);
      }
    }

    for (const [sq, piece] of squares.entries()) {
      const existing = this.pieceElements.get(sq);
      if (existing) {
        existing.style.transform = this.getSquareTranslateTransform(sq);
      } else {
        const el = this.acquirePieceElement(sq, piece.color, piece.type);
        this.pieceElements.set(sq, el);
      }
    }

    this.syncOverlay();
  }

  private renderGhostLayer(): void {
    // Clear existing ghost piece elements and vacated classes
    for (const el of this.ghostPieceElements.values()) {
      el.remove();
    }
    this.ghostPieceElements.clear();
    for (const el of this.pieceElements.values()) {
      el.classList.remove('wc-piece-ghost-vacated');
    }

    if (!this.ghostPreview) {
      this.ghostArrows = [];
      return;
    }

    const targetSquares = parseFenBoardSquares(this.ghostPreview.targetFen);

    for (let r = 1; r <= 8; r++) {
      for (let f = 0; f < 8; f++) {
        const sq = `${FILES[f]}${r}` as Square;
        const basePiece = this.adapter.get(sq);
        const targetPiece = targetSquares.get(sq);

        const changed =
          (basePiece?.color ?? '') !== (targetPiece?.color ?? '') ||
          (basePiece?.type ?? '') !== (targetPiece?.type ?? '');

        if (!changed) continue;

        if (basePiece) {
          const baseEl = this.pieceElements.get(sq);
          baseEl?.classList.add('wc-piece-ghost-vacated');
        }

        if (targetPiece) {
          const ghostEl = document.createElement('div');
          ghostEl.className = 'wc-piece wc-ghost-piece';
          ghostEl.setAttribute('data-square', sq);
          ghostEl.setAttribute('data-color', targetPiece.color);
          ghostEl.setAttribute('data-piece', targetPiece.type);
          ghostEl.setAttribute('data-testid', `ghost-piece-${sq}`);
          ghostEl.innerHTML = getPieceSvgMarkup(
            this.pieceSet,
            targetPiece.color,
            targetPiece.type,
          );
          ghostEl.style.transform = this.getSquareTranslateTransform(sq);
          this.ghostLayerEl.appendChild(ghostEl);
          this.ghostPieceElements.set(sq, ghostEl);
        }
      }
    }

    this.ghostArrows = (this.ghostPreview.moves ?? []).map((m) => ({
      from: m.from,
      to: m.to,
    }));
  }

  public setGhostPreview(preview: GhostPreviewInput | null): void {
    this.ghostPreview = preview
      ? {
          targetFen: preview.targetFen,
          ...(preview.moves ? { moves: [...preview.moves] } : {}),
        }
      : null;
    this.renderGhostLayer();
    this.syncOverlay();
  }

  public getGhostPreview(): GhostPreviewInput | null {
    return this.ghostPreview;
  }

  private canInteractWithColor(color: Color): boolean {
    if (this.interactiveColor === 'none') return false;
    if (this.interactiveColor === 'both') return true;
    return this.interactiveColor === color;
  }

  private getLegalMovesForSelectedSquare(): OverlayLegalTarget[] {
    if (!this.selectedSquare) return [];
    const piece = this.adapter.get(this.selectedSquare);
    if (!piece || piece.color !== this.adapter.turn()) return [];
    if (!this.canInteractWithColor(piece.color)) return [];

    const verbose = this.adapter.verboseMoves({ square: this.selectedSquare });
    const seen = new Map<Square, boolean>();
    for (const m of verbose) {
      seen.set(m.to, m.isCapture);
    }
    return Array.from(seen.entries()).map(([to, isCapture]) => ({
      to,
      isCapture,
    }));
  }

  private findCheckSquare(): Square | null {
    if (!this.adapter.inCheck()) return null;
    const turn = this.adapter.turn();
    for (let r = 1; r <= 8; r++) {
      for (let f = 0; f < 8; f++) {
        const sq = `${FILES[f]}${r}` as Square;
        const p = this.adapter.get(sq);
        if (p && p.type === 'k' && p.color === turn) {
          return sq;
        }
      }
    }
    return null;
  }

  public syncOverlay(): void {
    const legalMoves = this.getLegalMovesForSelectedSquare();
    const checkSquare = this.findCheckSquare();

    this.overlay.render({
      flipped: this.flipped,
      selectedSquare: this.selectedSquare,
      hoveredSquare: this.hoveredSquare,
      lastMove: this.lastMove,
      checkSquare,
      legalMoves,
      premove: this.premove,
      premoveTargets: this.premoveTargets,
      pendingConfirmMove: this.pendingConfirm
        ? { from: this.pendingConfirm.from, to: this.pendingConfirm.to }
        : null,
      hintMove: this.hintMove,
      bestMove: this.bestMoveArrow,
      threatMove: this.threatMoveArrow,
      ghostArrows: this.ghostArrows,
      arrows: this.userArrows,
      circles: this.userCircles,
    });
  }

  private readonly handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.boardEl.isConnected) return;
    if (event.key === 'Escape') {
      if (this.pendingPromotion) {
        event.preventDefault();
        this.cancelPromotionPicker();
        return;
      }
      if (this.pendingConfirm) {
        event.preventDefault();
        this.cancelPendingConfirmMove();
        return;
      }
      if (this.premove) {
        event.preventDefault();
        this.setPremove(null);
        return;
      }
      if (this.selectedSquare) {
        this.selectedSquare = null;
        this.premoveTargets = [];
        this.syncOverlay();
      }
    } else if (event.key === 'Enter' && this.pendingConfirm) {
      event.preventDefault();
      this.acceptPendingConfirmMove();
    }
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    // Refresh cached board rect once on pointerdown (never inside pointermove!)
    this.cachedBoardRect = this.boardEl.getBoundingClientRect();

    const sq = this.squareFromClientPoint(event.clientX, event.clientY);
    if (!sq) return;

    // Right-click: cancel premove or start user circle/arrow
    if (event.button === 2) {
      if (this.premove) {
        this.setPremove(null);
        return;
      }
      this.rightDragStart = sq;
      return;
    }

    if (event.button !== 0) return;
    if (this.pendingPromotion || this.pendingConfirm) return;

    // Check if an interactive Position Editor tool is consuming left clicks
    if (this.onSquareEditCallback && this.onSquareEditCallback(sq)) {
      return;
    }

    // Clear user-drawn annotations on left click
    if (this.userArrows.length > 0 || this.userCircles.length > 0) {
      this.userArrows = [];
      this.userCircles = [];
      this.emitAnnotationsChange();
    }

    // Clear active premove if user clicks when premove is set and no square is selected
    const turn = this.adapter.turn();
    const clickedPiece = this.adapter.get(sq);

    // 1. If a square is already selected, check if clicking `sq` completes a move or premove
    if (this.selectedSquare && this.selectedSquare !== sq) {
      const selectedPiece = this.adapter.get(this.selectedSquare);
      if (selectedPiece && this.canInteractWithColor(selectedPiece.color)) {
        if (selectedPiece.color === turn) {
          const legalTargets = this.getLegalMovesForSelectedSquare();
          if (legalTargets.some((t) => t.to === sq)) {
            this.initiateMoveOrPromotion(
              this.selectedSquare,
              sq,
              selectedPiece,
              false,
              false,
            );
            return;
          }
        } else if (
          this.enablePremoves &&
          this.premoveTargets.includes(sq)
        ) {
          this.initiateMoveOrPromotion(
            this.selectedSquare,
            sq,
            selectedPiece,
            true,
            false,
          );
          return;
        }
      }
    }

    // 2. Otherwise, check if the clicked square has an interactive piece to select / drag
    if (clickedPiece && this.canInteractWithColor(clickedPiece.color)) {
      this.selectedSquare = sq;
      if (clickedPiece.color !== turn && this.enablePremoves) {
        this.premoveTargets = computePremoveTargets(
          this.adapter,
          sq,
          clickedPiece.color,
        );
      } else {
        this.premoveTargets = [];
      }

      this.onSelectSquareCallback?.(sq, clickedPiece);

      const pieceEl = this.pieceElements.get(sq);
      if (pieceEl) {
        this.dragState = {
          pointerId: event.pointerId,
          from: sq,
          piece: clickedPiece,
          element: pieceEl,
          startX: event.clientX,
          startY: event.clientY,
          isDragging: false,
        };
      }

      this.syncOverlay();
      return;
    }

    // Clicked empty or opponent non-target square -> clear selection (and premove if active)
    this.selectedSquare = null;
    this.premoveTargets = [];
    if (this.premove) {
      this.setPremove(null);
    } else {
      this.syncOverlay();
    }
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.boardEl.isConnected) return;
    const drag = this.dragState;
    if (!drag || event.pointerId !== drag.pointerId) return;

    const rect = this.cachedBoardRect;
    if (!rect || rect.width <= 0 || rect.height <= 0) return;

    if (!drag.isDragging) {
      const dist = Math.hypot(
        event.clientX - drag.startX,
        event.clientY - drag.startY,
      );
      if (dist < 2.5) return;
      drag.isDragging = true;
      drag.element.classList.add('wc-piece-dragging');
    }

    // Compositor-only CSS transform update in percentage coordinates (zero layout reads!)
    const squareW = rect.width / 8;
    const squareH = rect.height / 8;
    const pctX = ((event.clientX - rect.left) / squareW - 0.5) * 100;
    const pctY = ((event.clientY - rect.top) / squareH - 0.5) * 100;
    drag.element.style.transform = `translate3d(${pctX.toFixed(2)}%, ${pctY.toFixed(2)}%, 0) scale(1.08)`;

    // O(1) square math from cached rect
    const col = Math.floor(((event.clientX - rect.left) / rect.width) * 8);
    const row = Math.floor(((event.clientY - rect.top) / rect.height) * 8);
    let nextHover: Square | null = null;
    if (col >= 0 && col < 8 && row >= 0 && row < 8) {
      const fileIdx = this.flipped ? 7 - col : col;
      const rankIdx = this.flipped ? row : 7 - row;
      nextHover = `${FILES[fileIdx]}${rankIdx + 1}` as Square;
    }

    if (nextHover !== this.hoveredSquare) {
      this.hoveredSquare = nextHover;
      this.syncOverlay();
    }
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.boardEl.isConnected) return;

    // Handle right-click / right-drag annotation
    if (event.button === 2 && this.rightDragStart) {
      const startSq = this.rightDragStart;
      this.rightDragStart = null;
      const endSq = this.squareFromClientPoint(event.clientX, event.clientY);
      if (endSq) {
        const { hex: color } = resolveModifierAnnotationColor(event);
        if (startSq === endSq) {
          const idx = this.userCircles.findIndex((c) => c.square === startSq);
          if (idx >= 0) {
            if (this.userCircles[idx]?.color === color) {
              this.userCircles.splice(idx, 1);
            } else {
              this.userCircles[idx] = { square: startSq, color };
            }
          } else {
            this.userCircles.push({ square: startSq, color });
          }
        } else {
          const idx = this.userArrows.findIndex(
            (a) => a.from === startSq && a.to === endSq,
          );
          if (idx >= 0) {
            if (this.userArrows[idx]?.color === color) {
              this.userArrows.splice(idx, 1);
            } else {
              this.userArrows[idx] = { from: startSq, to: endSq, color };
            }
          } else {
            this.userArrows.push({ from: startSq, to: endSq, color });
          }
        }
        this.syncOverlay();
        this.emitAnnotationsChange();
      }
      return;
    }

    const drag = this.dragState;
    if (!drag || event.pointerId !== drag.pointerId) return;

    this.dragState = null;
    this.hoveredSquare = null;

    // Always snap the piece element cleanly back to its resting square transform first
    // so a dragged piece NEVER remains floating in mid-air (fixes Legacy Bug #2)
    drag.element.classList.remove('wc-piece-dragging');
    drag.element.style.transform = this.getSquareTranslateTransform(drag.from);

    if (!drag.isDragging) {
      this.syncOverlay();
      return;
    }

    const dropSq = this.squareFromClientPoint(event.clientX, event.clientY);
    if (!dropSq || dropSq === drag.from) {
      this.syncOverlay();
      return;
    }

    const turn = this.adapter.turn();
    if (drag.piece.color === turn) {
      const legalTargets = this.getLegalMovesForSelectedSquare();
      if (legalTargets.some((t) => t.to === dropSq)) {
        this.initiateMoveOrPromotion(
          drag.from,
          dropSq,
          drag.piece,
          false,
          true,
        );
        return;
      }
    } else if (
      this.enablePremoves &&
      this.premoveTargets.includes(dropSq)
    ) {
      this.initiateMoveOrPromotion(
        drag.from,
        dropSq,
        drag.piece,
        true,
        true,
      );
      return;
    }

    this.syncOverlay();
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (!this.boardEl.isConnected) return;
    const drag = this.dragState;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.dragState = null;
    this.hoveredSquare = null;
    drag.element.classList.remove('wc-piece-dragging');
    drag.element.style.transform = this.getSquareTranslateTransform(drag.from);
    this.syncOverlay();
  };

  private emitAnnotationsChange(): void {
    this.onAnnotationsChangeCallback?.(
      this.getPgnArrows(),
      this.getPgnHighlights(),
    );
  }

  public getPgnArrows(): PgnArrowAnnotation[] {
    return this.userArrows.map((a) => ({
      color: hexToAnnotationColor(a.color),
      from: a.from,
      to: a.to,
    }));
  }

  public getPgnHighlights(): PgnHighlightAnnotation[] {
    return this.userCircles.map((c) => ({
      color: hexToAnnotationColor(c.color),
      square: c.square,
    }));
  }

  public setUserAnnotations(
    arrows: PgnArrowAnnotation[],
    highlights: PgnHighlightAnnotation[],
  ): void {
    this.userArrows = arrows.map((a) => ({
      from: a.from,
      to: a.to,
      color: ANNOTATION_COLOR_HEX[a.color] ?? ANNOTATION_COLOR_HEX.G,
    }));
    this.userCircles = highlights.map((h) => ({
      square: h.square,
      color: ANNOTATION_COLOR_HEX[h.color] ?? ANNOTATION_COLOR_HEX.G,
    }));
    this.syncOverlay();
  }

  public getUserArrows(): OverlayArrow[] {
    return [...this.userArrows];
  }

  public getUserCircles(): OverlayCircle[] {
    return [...this.userCircles];
  }

  public clearUserAnnotations(): void {
    if (this.userArrows.length === 0 && this.userCircles.length === 0) return;
    this.userArrows = [];
    this.userCircles = [];
    this.syncOverlay();
    this.emitAnnotationsChange();
  }

  private isPromotionMove(
    from: Square,
    to: Square,
    piece: Piece,
    isPremove: boolean,
  ): boolean {
    if (piece.type !== 'p') return false;
    const promoRank = piece.color === 'w' ? '8' : '1';
    if (to[1] !== promoRank) return false;
    if (isPremove) return true;
    const legal = this.adapter.verboseMoves({ square: from });
    return legal.some((m) => m.to === to && Boolean(m.promotion));
  }

  private initiateMoveOrPromotion(
    from: Square,
    to: Square,
    piece: Piece,
    isPremove: boolean,
    wasDragged: boolean,
  ): void {
    const needsPromotion = this.isPromotionMove(from, to, piece, isPremove);
    if (needsPromotion) {
      if (this.autoQueen) {
        this.finalizeMoveOrPremove(
          { from, to, promotion: 'q' },
          isPremove,
          wasDragged,
        );
      } else {
        this.openPromotionPicker({
          from,
          to,
          color: piece.color,
          isPremove,
          wasDragged,
        });
      }
      return;
    }

    this.finalizeMoveOrPremove({ from, to }, isPremove, wasDragged);
  }

  private openPromotionPicker(state: PendingPromotionState): void {
    this.pendingPromotion = state;
    const coords = squareToBoardCoords(state.to, this.flipped);
    const leftPct = coords.col * 12.5;
    const isTopEdge = coords.row < 4;

    const pieces: Array<{ symbol: PieceSymbol; label: string }> = [
      { symbol: 'q', label: 'Queen' },
      { symbol: 'n', label: 'Knight' },
      { symbol: 'r', label: 'Rook' },
      { symbol: 'b', label: 'Bishop' },
    ];

    const buttonsHtml = pieces
      .map(
        (p) => `
        <button
          type="button"
          class="wc-promotion-choice"
          data-promotion-piece="${p.symbol}"
          data-testid="promote-${p.symbol}"
          aria-label="Promote to ${p.label}"
          title="${p.label}"
        >
          <div class="wc-promotion-piece-icon">${getPieceSvgMarkup(this.pieceSet, state.color, p.symbol)}</div>
        </button>
      `,
      )
      .join('');

    this.promotionBackdropEl.innerHTML = `
      <div
        class="wc-promotion-column ${
          isTopEdge ? 'wc-promotion-column-top' : 'wc-promotion-column-bottom'
        }"
        data-testid="promotion-picker"
        data-color="${state.color}"
        data-file="${state.to[0]}"
        data-edge="${isTopEdge ? 'top' : 'bottom'}"
        role="dialog"
        aria-label="Choose promotion piece"
        style="left: ${leftPct}%; ${isTopEdge ? 'top: 0%;' : 'top: 50%;'}"
      >
        ${buttonsHtml}
      </div>
    `;
    this.promotionBackdropEl.hidden = false;
    this.syncOverlay();
  }

  public resolvePromotionPicker(piece: PieceSymbol): void {
    const pending = this.pendingPromotion;
    if (!pending) return;
    this.pendingPromotion = null;
    this.promotionBackdropEl.hidden = true;
    this.promotionBackdropEl.innerHTML = '';

    this.finalizeMoveOrPremove(
      { from: pending.from, to: pending.to, promotion: piece },
      pending.isPremove,
      pending.wasDragged,
    );
  }

  public cancelPromotionPicker(): void {
    if (!this.pendingPromotion) return;
    const fromSq = this.pendingPromotion.from;
    this.pendingPromotion = null;
    this.promotionBackdropEl.hidden = true;
    this.promotionBackdropEl.innerHTML = '';

    // Ensure the pawn element is cleanly resting at its origin square
    const el = this.pieceElements.get(fromSq);
    if (el) {
      el.classList.remove('wc-piece-dragging');
      el.style.transform = this.getSquareTranslateTransform(fromSq);
    }

    this.selectedSquare = null;
    this.premoveTargets = [];
    this.syncOverlay();
  }

  private finalizeMoveOrPremove(
    move: PremoveInput,
    isPremove: boolean,
    wasDragged: boolean,
  ): void {
    this.selectedSquare = null;
    this.premoveTargets = [];

    if (isPremove) {
      this.setPremove(move);
      return;
    }

    if (this.confirmMove) {
      this.stageConfirmMove(move, wasDragged);
      return;
    }

    this.onMoveCallback?.(move, wasDragged);
  }

  private stageConfirmMove(move: PremoveInput, wasDragged: boolean): void {
    this.pendingConfirm = {
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion } : {}),
      wasDragged,
    };

    const fromEl = this.pieceElements.get(move.from);
    if (fromEl) {
      fromEl.style.transform = this.getSquareTranslateTransform(move.to);
    }
    const targetEl = this.pieceElements.get(move.to);
    if (targetEl && targetEl !== fromEl) {
      targetEl.style.opacity = '0.25';
    }

    const labelEl = this.confirmBarEl.querySelector(
      '[data-testid="confirm-move-label"]',
    );
    if (labelEl) {
      labelEl.textContent = `Confirm ${move.from} → ${move.to}${
        move.promotion ? `=${move.promotion.toUpperCase()}` : ''
      }?`;
    }
    this.confirmBarEl.hidden = false;
    this.syncOverlay();
  }

  public acceptPendingConfirmMove(): void {
    const pending = this.pendingConfirm;
    if (!pending) return;
    this.pendingConfirm = null;
    this.confirmBarEl.hidden = true;

    const targetEl = this.pieceElements.get(pending.to);
    if (targetEl) {
      targetEl.style.opacity = '';
    }

    this.onMoveCallback?.(
      {
        from: pending.from,
        to: pending.to,
        ...(pending.promotion ? { promotion: pending.promotion } : {}),
      },
      pending.wasDragged,
    );
  }

  public cancelPendingConfirmMove(): void {
    const pending = this.pendingConfirm;
    if (!pending) return;
    this.pendingConfirm = null;
    this.confirmBarEl.hidden = true;

    const fromEl = this.pieceElements.get(pending.from);
    if (fromEl) {
      fromEl.style.transform = this.getSquareTranslateTransform(pending.from);
    }
    const targetEl = this.pieceElements.get(pending.to);
    if (targetEl) {
      targetEl.style.opacity = '';
    }
    this.syncOverlay();
  }

  public setPremove(premove: PremoveInput | null): void {
    this.premove = premove;
    this.syncOverlay();
    this.onPremoveChangeCallback?.(premove);
  }

  public getPremove(): PremoveInput | null {
    return this.premove;
  }

  public isPromotionPickerOpen(): boolean {
    return this.pendingPromotion !== null;
  }

  public isConfirmMovePending(): boolean {
    return this.pendingConfirm !== null;
  }

  /**
   * Updates the board position from a RulesAdapter or FEN string, optionally animating the executed move
   * and triggering the capture particle burst.
   */
  public setPosition(
    fenOrAdapter: string | RulesAdapter,
    options?: {
      lastMove?: ExecutedMove | { from: Square; to: Square } | null;
      wasDragged?: boolean;
      triggerCaptureParticles?: boolean;
      preserveAnalysisArrows?: boolean;
    },
  ): void {
    if (this.pendingPromotion) {
      this.cancelPromotionPicker();
    }
    if (this.pendingConfirm) {
      this.cancelPendingConfirmMove();
    }

    if (typeof fenOrAdapter === 'string') {
      this.adapter = new RulesAdapter(fenOrAdapter);
    } else {
      this.adapter = fenOrAdapter.clone();
    }

    this.selectedSquare = null;
    this.premoveTargets = [];
    this.hintMove = null;
    if (!options?.preserveAnalysisArrows) {
      this.bestMoveArrow = null;
      this.threatMoveArrow = null;
    }

    this.ghostPreview = null;
    this.renderGhostLayer();

    const lm = options?.lastMove;
    this.lastMove = lm ? { from: lm.from, to: lm.to } : null;

    let animDesc: MoveAnimationDescriptor | undefined;
    if (lm) {
      animDesc = {
        from: lm.from,
        to: lm.to,
        wasDragged: Boolean(options?.wasDragged),
      };

      // Check if it was a castling move so the rook also animates
      if ('isCastle' in lm && lm.isCastle) {
        const homeRank = lm.color === 'w' ? '1' : '8';
        animDesc.rookTo = (
          lm.isKingsideCastle ? `f${homeRank}` : `d${homeRank}`
        ) as Square;
        const beforeAdapter = new RulesAdapter(lm.before);
        for (let f = 0; f < 8; f++) {
          const sq = `${FILES[f]}${homeRank}` as Square;
          const p = beforeAdapter.get(sq);
          if (p && p.type === 'r' && p.color === lm.color) {
            const kingFile = FILES.indexOf(lm.from[0] ?? 'e');
            if (
              (lm.isKingsideCastle && f > kingFile) ||
              (lm.isQueensideCastle && f < kingFile)
            ) {
              animDesc.rookFrom = sq;
              break;
            }
          }
        }
      }

      if (
        options?.triggerCaptureParticles !== false &&
        'isCapture' in lm &&
        lm.isCapture
      ) {
        const capturedColor: Color = lm.color === 'w' ? 'b' : 'w';
        this.particles.triggerCapture(
          lm.to,
          capturedColor,
          lm.from,
          this.flipped,
        );
      }
    }

    this.syncPiecesFromAdapter(animDesc);
    this.syncOverlay();
  }

  public setFlipped(flipped: boolean): void {
    if (this.flipped === flipped) return;
    this.flipped = flipped;
    this.boardEl.setAttribute('data-flipped', String(this.flipped));
    this.renderSquaresGrid();
    this.renderCoordinates();
    for (const [sq, el] of this.pieceElements.entries()) {
      el.style.transform = this.getSquareTranslateTransform(sq);
    }
    for (const [sq, el] of this.ghostPieceElements.entries()) {
      el.style.transform = this.getSquareTranslateTransform(sq);
    }
    if (this.pendingPromotion) {
      this.openPromotionPicker(this.pendingPromotion);
    } else {
      this.syncOverlay();
    }
    this.onFlipChangeCallback?.(this.flipped);
  }

  public isFlipped(): boolean {
    return this.flipped;
  }

  public setInteractiveColor(color: Color | 'both' | 'none'): void {
    this.interactiveColor = color;
    this.selectedSquare = null;
    this.premoveTargets = [];
    this.syncOverlay();
  }

  public setAutoQueen(autoQueen: boolean): void {
    this.autoQueen = autoQueen;
  }

  public isAutoQueen(): boolean {
    return this.autoQueen;
  }

  public setConfirmMove(confirmMove: boolean): void {
    this.confirmMove = confirmMove;
    if (!confirmMove && this.pendingConfirm) {
      this.cancelPendingConfirmMove();
    }
  }

  public isConfirmMoveEnabled(): boolean {
    return this.confirmMove;
  }

  public setCaptureEffectsEnabled(enabled: boolean): void {
    this.particles.setEnabled(enabled);
  }

  public isCaptureEffectsEnabled(): boolean {
    return this.particles.isEnabled();
  }

  public setBoardTheme(theme: BoardThemeId): void {
    if (!BOARD_THEMES[theme]) return;
    this.boardTheme = theme;
    this.applyThemeVariables();
  }

  public getBoardTheme(): BoardThemeId {
    return this.boardTheme;
  }

  public setPieceSet(pieceSet: PieceSetId): void {
    if (this.pieceSet === pieceSet) return;
    this.pieceSet = pieceSet;
    this.frameEl.setAttribute('data-piece-set', pieceSet);
    for (const [sq, el] of this.pieceElements.entries()) {
      const color = el.getAttribute('data-color') as Color;
      const piece = el.getAttribute('data-piece') as PieceSymbol;
      if (color && piece) {
        el.innerHTML = getPieceSvgMarkup(this.pieceSet, color, piece);
        el.style.transform = this.getSquareTranslateTransform(sq);
      }
    }
    for (const [sq, el] of this.ghostPieceElements.entries()) {
      const color = el.getAttribute('data-color') as Color;
      const piece = el.getAttribute('data-piece') as PieceSymbol;
      if (color && piece) {
        el.innerHTML = getPieceSvgMarkup(this.pieceSet, color, piece);
        el.style.transform = this.getSquareTranslateTransform(sq);
      }
    }
    if (this.pendingPromotion) {
      this.openPromotionPicker(this.pendingPromotion);
    }
  }

  public getPieceSet(): PieceSetId {
    return this.pieceSet;
  }

  public setHintMove(hint: { from: Square; to: Square } | null): void {
    this.hintMove = hint;
    this.syncOverlay();
  }

  public setBestMoveArrow(arrow: { from: Square; to: Square } | null): void {
    this.bestMoveArrow = arrow ? { ...arrow } : null;
    this.syncOverlay();
  }

  public getBestMoveArrow(): { from: Square; to: Square } | null {
    return this.bestMoveArrow ? { ...this.bestMoveArrow } : null;
  }

  public setThreatMoveArrow(arrow: { from: Square; to: Square } | null): void {
    this.threatMoveArrow = arrow ? { ...arrow } : null;
    this.syncOverlay();
  }

  public getThreatMoveArrow(): { from: Square; to: Square } | null {
    return this.threatMoveArrow ? { ...this.threatMoveArrow } : null;
  }

  public getOverlay(): BoardOverlay {
    return this.overlay;
  }

  public getParticles(): CaptureParticleSystem {
    return this.particles;
  }

  public getPieceElement(square: Square): HTMLElement | undefined {
    return this.pieceElements.get(square);
  }

  public getGhostPieceElement(square: Square): HTMLElement | undefined {
    return this.ghostPieceElements.get(square);
  }

  public destroy(): void {
    this.boardEl.removeEventListener('pointerdown', this.handlePointerDown);
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerCancel);
    this.boardEl.removeEventListener('contextmenu', this.handleContextMenu);
    window.removeEventListener('keydown', this.handleKeyDown);
    this.resizeObserver?.disconnect();
    this.particles.destroy();
    this.frameEl.remove();
  }
}
