import type { PgnArrowAnnotation, PgnHighlightAnnotation } from '../core/game-tree';
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
import { announce } from '../ui/announcer';
import { CaptureParticleSystem } from './particles';
import { boardFeel, resolveDropSquare, type BoardFeel } from './board-feel';
import { attachBoardResizeHandle } from './board-size';
import { getPieceSvgMarkup } from './piece-sets';
import { BOARD_THEMES, DEFAULT_BOARD_THEME, DEFAULT_PIECE_SET, type BoardThemeId, type PieceSetId } from './themes';

export interface PremoveInput {
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
}

export interface PieceTransition {
  from: Square;
  to: Square;
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
  /** Move animation duration; by default the shared board feel's `animationMs`. */
  animationDurationMs?: number;
  /** Show the corner grip that resizes every board (default true). */
  resizable?: boolean;
  /** Longest premove queue; 1 gives Lichess-style single premoves. */
  maxPremoves?: number;
  onMove?: (move: MoveInput, wasDragged: boolean) => void;
  onSelectSquare?: (square: Square, piece: Piece) => void;
  onSquareEdit?: (square: Square) => boolean;
  onAnnotationsChange?: (arrows: PgnArrowAnnotation[], highlights: PgnHighlightAnnotation[]) => void;
  onFlipChange?: (flipped: boolean) => void;
}

interface ActiveDragState {
  pointerId: number;
  /** Touch drags draw the piece above the finger and need a longer threshold. */
  isTouch: boolean;
  from: Square;
  piece: Piece;
  element: HTMLElement;
  startX: number;
  startY: number;
  isDragging: boolean;
  /** The piece was already selected before this press, so a plain click deselects it. */
  wasSelected: boolean;
  /** Squares the held piece may be dropped on; null until needed or after a board update. */
  targets: Square[] | null;
}

/** A piece dropped on a legal square glides from where it was released into the square. */
interface DropGlide {
  element: HTMLElement;
  to: Square;
  fromTransform: string;
}

export interface SquareBadge {
  square: Square;
  /** Markup of the icon (e.g. a move classification badge). */
  html: string;
  /** What the icon means, for tests and screen readers. */
  label: string;
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
const PREMOVE_FLASH_MS = 450;

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

/** Reads every occupied square of `adapter` into a map. */
export function boardSquaresFromAdapter(adapter: RulesAdapter): Map<Square, Piece> {
  const squares = new Map<Square, Piece>();
  for (let r = 1; r <= 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = `${FILES[f]}${r}` as Square;
      const p = adapter.get(sq);
      if (p) {
        squares.set(sq, { color: p.color, type: p.type });
      }
    }
  }
  return squares;
}

/**
 * Plays `premove` on a hypothetical board where the opponent passes. Only piece geometry
 * matters here: castling also moves the rook, a pawn reaching the last rank becomes the
 * chosen piece (queen by default), and whatever stood on the target square is replaced.
 * Real legality is checked only when the premove executes.
 */
export function applyPremoveToSquares(squares: Map<Square, Piece>, premove: PremoveInput): void {
  const piece = squares.get(premove.from);
  if (!piece) return;
  squares.delete(premove.from);

  const fromFile = FILES.indexOf(premove.from[0] ?? 'a');
  const toFile = FILES.indexOf(premove.to[0] ?? 'a');
  const homeRank = piece.color === 'w' ? '1' : '8';
  if (
    piece.type === 'k' &&
    premove.from[1] === homeRank &&
    premove.to[1] === homeRank &&
    Math.abs(toFile - fromFile) === 2
  ) {
    const kingside = toFile > fromFile;
    const step = kingside ? 1 : -1;
    for (let f = fromFile + step; f >= 0 && f < 8; f += step) {
      const sq = `${FILES[f]}${homeRank}` as Square;
      const p = squares.get(sq);
      if (p && p.color === piece.color && p.type === 'r') {
        squares.delete(sq);
        squares.set(`${kingside ? 'f' : 'd'}${homeRank}` as Square, p);
        break;
      }
    }
  }

  const lastRank = piece.color === 'w' ? '8' : '1';
  const placed: Piece =
    piece.type === 'p' && premove.to[1] === lastRank ? { color: piece.color, type: premove.promotion ?? 'q' } : piece;
  squares.set(premove.to, placed);
}

/**
 * Computes premove destinations for the piece of `color` on `from`, following piece
 * movement geometry the way Lichess's chessground does: blockers are ignored, pawns may
 * premove diagonally onto empty squares, squares held by your own pieces are allowed
 * (they may be recaptured on by then), and a king on its home rank may castle toward
 * any of its own rooks there.
 */
export function computePremoveTargetsOnSquares(squares: Map<Square, Piece>, from: Square, color: Color): Square[] {
  const piece = squares.get(from);
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
        for (let f = 0; f < 8; f++) {
          const rook = squares.get(`${FILES[f]}${homeRank + 1}` as Square);
          if (rook && rook.color === color && rook.type === 'r') {
            addIfValid(f > f0 ? 6 : 2, homeRank); // g1/g8 or c1/c8
          }
        }
      }
      break;
    }
  }

  return Array.from(targets);
}

/** Premove destinations on the real position held by `adapter`. */
export function computePremoveTargets(adapter: RulesAdapter, from: Square, color: Color): Square[] {
  return computePremoveTargetsOnSquares(boardSquaresFromAdapter(adapter), from, color);
}

const squareDistance = (a: Square, b: Square): number => {
  const df = FILES.indexOf(a[0] ?? 'a') - FILES.indexOf(b[0] ?? 'a');
  const dr = Number(a[1]) - Number(b[1]);
  return df * df + dr * dr;
};

const isPromotionPair = (pawnSq: Square, pieceSq: Square, color: Color): boolean => {
  const pawnRank = color === 'w' ? '7' : '2';
  const lastRank = color === 'w' ? '8' : '1';
  return (
    pawnSq[1] === pawnRank &&
    pieceSq[1] === lastRank &&
    Math.abs(FILES.indexOf(pawnSq[0] ?? 'a') - FILES.indexOf(pieceSq[0] ?? 'a')) <= 1
  );
};

/**
 * Works out which pieces slid between two boards, the way chessground plans animations:
 * every piece that appeared is matched to the nearest vanished piece of the same color and
 * type. A second pass pairs a promoted piece with the pawn it came from (and back again
 * when stepping backward). This one plan covers normal moves, captures, castling, en
 * passant, moves played in reverse, and premoves snapping back.
 */
export function planPieceTransitions(prev: Map<Square, Piece>, next: Map<Square, Piece>): PieceTransition[] {
  const vanished: Array<{ sq: Square; piece: Piece }> = [];
  const appeared: Array<{ sq: Square; piece: Piece }> = [];
  for (const [sq, piece] of prev) {
    const n = next.get(sq);
    if (!n || n.color !== piece.color || n.type !== piece.type) {
      vanished.push({ sq, piece });
    }
  }
  for (const [sq, piece] of next) {
    const p = prev.get(sq);
    if (!p || p.color !== piece.color || p.type !== piece.type) {
      appeared.push({ sq, piece });
    }
  }

  const transitions: PieceTransition[] = [];
  const used = new Set<Square>();
  const unmatched: Array<{ sq: Square; piece: Piece }> = [];

  for (const a of appeared) {
    let best: Square | null = null;
    let bestDist = Infinity;
    for (const v of vanished) {
      if (used.has(v.sq)) continue;
      if (v.piece.color !== a.piece.color || v.piece.type !== a.piece.type) continue;
      const d = squareDistance(v.sq, a.sq);
      if (d < bestDist) {
        bestDist = d;
        best = v.sq;
      }
    }
    if (best) {
      used.add(best);
      transitions.push({ from: best, to: a.sq });
    } else {
      unmatched.push(a);
    }
  }

  for (const a of unmatched) {
    for (const v of vanished) {
      if (used.has(v.sq) || v.piece.color !== a.piece.color) continue;
      const forward = v.piece.type === 'p' && a.piece.type !== 'p' && isPromotionPair(v.sq, a.sq, a.piece.color);
      const backward = a.piece.type === 'p' && v.piece.type !== 'p' && isPromotionPair(a.sq, v.sq, a.piece.color);
      if (forward || backward) {
        used.add(v.sq);
        transitions.push({ from: v.sq, to: a.sq });
        break;
      }
    }
  }

  return transitions;
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
  private readonly badgeLayerEl: HTMLElement;
  private readonly detachResizeHandle: (() => void) | null;
  private readonly unsubscribeFeel: () => void;
  private feel: BoardFeel;

  private adapter: RulesAdapter;
  private flipped: boolean;
  private interactiveColor: Color | 'both' | 'none';
  private enablePremoves: boolean;
  private autoQueen: boolean;
  private confirmMove: boolean;
  private boardTheme: BoardThemeId;
  private pieceSet: PieceSetId;
  /** Set when the caller fixed the move animation duration; otherwise the feel's applies. */
  private readonly animationDurationOverride: number | null;

  private readonly pieceElements = new Map<Square, HTMLElement>();
  private readonly freePiecePool: HTMLElement[] = [];
  /** The one running animation per piece element (move, step, or snap-back). */
  private readonly pieceAnimations = new WeakMap<HTMLElement, Animation>();
  private readonly ghostPieceElements = new Map<Square, HTMLElement>();

  private selectedSquare: Square | null = null;
  private hoveredSquare: Square | null = null;
  /** The hovered drop square is one the held piece may go to. */
  private hoveredIsTarget = false;
  private dropGlide: DropGlide | null = null;
  private squareBadge: SquareBadge | null = null;
  /** The pointer is over a piece it could pick up (shows the grab cursor). */
  private grabHover = false;
  private lastMove: { from: Square; to: Square } | null = null;
  private premoves: PremoveInput[] = [];
  private maxPremoves: number;
  private premoveTargets: Square[] = [];
  private premoveFlashSquares: Square[] = [];
  private premoveFlashTimer: ReturnType<typeof setTimeout> | null = null;
  /** What the board shows: the real position, plus queued premoves played on top. */
  private displaySquares = new Map<Square, Piece>();
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
  /** A right-click that cancelled a drag must not also open the browser menu. */
  private suppressContextMenuUntil = 0;

  private onMoveCallback: ((move: MoveInput, wasDragged: boolean) => void) | undefined;
  private onSelectSquareCallback: ((square: Square, piece: Piece) => void) | undefined;
  private onSquareEditCallback: ((square: Square) => boolean) | undefined;
  private onAnnotationsChangeCallback:
    ((arrows: PgnArrowAnnotation[], highlights: PgnHighlightAnnotation[]) => void) | undefined;
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
    this.animationDurationOverride = options?.animationDurationMs ?? null;
    this.feel = boardFeel.get();
    this.unsubscribeFeel = boardFeel.subscribe((feel) => {
      this.feel = feel;
    });
    this.maxPremoves = Math.max(1, Math.floor(options?.maxPremoves ?? 10));

    this.onMoveCallback = options?.onMove;
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
    this.boardEl.setAttribute(
      'aria-label',
      'Chessboard. Arrow keys move the cursor; Enter or Space picks a piece up and puts it down.',
    );
    this.boardEl.tabIndex = 0;
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

    // Move classification badge (one at a time): inside the pieces layer, above resting
    // pieces and below a held one
    this.badgeLayerEl = document.createElement('div');
    this.badgeLayerEl.className = 'wc-board-badge-layer';
    this.badgeLayerEl.setAttribute('aria-hidden', 'true');
    this.piecesLayerEl.appendChild(this.badgeLayerEl);
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
    this.detachResizeHandle = options?.resizable === false ? null : attachBoardResizeHandle(this.frameEl);

    this.applyThemeVariables();
    this.renderSquaresGrid();
    this.renderCoordinates();
    this.displaySquares = this.computeDisplaySquares();
    this.renderPieces(this.displaySquares, { animate: false });
    this.syncOverlay();
    this.bindEvents();
  }

  private applyThemeVariables(): void {
    const theme = BOARD_THEMES[this.boardTheme] ?? BOARD_THEMES['marble-obsidian'];
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
    if (this.kbSquare) this.gridEl.querySelector(`[data-square="${this.kbSquare}"]`)?.classList.add('wc-kb-focus');
  }

  private renderCoordinates(): void {
    const files = this.flipped ? ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'] : ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const ranks = this.flipped ? ['1', '2', '3', '4', '5', '6', '7', '8'] : ['8', '7', '6', '5', '4', '3', '2', '1'];

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
    this.boardEl.addEventListener('keydown', this.handleBoardKeyDown);
    this.boardEl.addEventListener('focus', this.handleBoardFocus);
    this.boardEl.addEventListener('blur', this.handleBoardBlur);
    this.boardEl.addEventListener('pointermove', this.handleHoverMove, { passive: true });
    this.boardEl.addEventListener('pointerleave', this.handleHoverLeave, { passive: true });
    // Scrolling moves the board on screen: the cached rect is stale after it
    window.addEventListener('scroll', this.invalidateBoardRect, { passive: true, capture: true });
    window.addEventListener('pointermove', this.handlePointerMove, {
      passive: true,
    });
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerCancel);
    // Pressing a second mouse button mid-drag fires mousedown but no pointerdown.
    window.addEventListener('mousedown', this.handleWindowMouseDown, true);
    window.addEventListener('contextmenu', this.handleWindowContextMenu, true);
    this.boardEl.addEventListener('contextmenu', this.handleContextMenu);
    window.addEventListener('keydown', this.handleKeyDown);

    this.promotionBackdropEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });

    this.promotionBackdropEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement;
      const promoBtn = target.closest('[data-promotion-piece]') as HTMLElement | null;
      if (promoBtn) {
        const piece = promoBtn.getAttribute('data-promotion-piece') as PieceSymbol;
        this.resolvePromotionPicker(piece);
        return;
      }
      this.cancelPromotionPicker();
    });

    const acceptBtn = this.confirmBarEl.querySelector('[data-testid="confirm-move-accept"]');
    const cancelBtn = this.confirmBarEl.querySelector('[data-testid="confirm-move-cancel"]');
    acceptBtn?.addEventListener('click', () => this.acceptPendingConfirmMove());
    cancelBtn?.addEventListener('click', () => this.cancelPendingConfirmMove());

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.cachedBoardRect = null;
      });
      this.resizeObserver.observe(this.boardEl);
    }
  }

  private readonly invalidateBoardRect = (): void => {
    this.cachedBoardRect = null;
  };

  /** Whether a press on `square` would pick up a piece (for the grab cursor). */
  private canPickUp(square: Square): boolean {
    if (this.pendingPromotion || this.pendingConfirm) return false;
    const piece = this.pieceAt(square);
    if (!piece || !this.canInteractWithColor(piece.color)) return false;
    return piece.color === this.adapter.turn() || this.enablePremoves;
  }

  private setGrabHover(grab: boolean): void {
    if (grab === this.grabHover) return;
    this.grabHover = grab;
    if (grab) this.boardEl.setAttribute('data-cursor', 'grab');
    else this.boardEl.removeAttribute('data-cursor');
  }

  /** Mouse hover (no button held): the grab cursor over a piece that can be picked up. */
  private readonly handleHoverMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' || this.dragState || event.buttons !== 0) return;
    const sq = this.squareFromClientPoint(event.clientX, event.clientY);
    this.setGrabHover(sq !== null && this.canPickUp(sq));
  };

  private readonly handleHoverLeave = (): void => {
    this.setGrabHover(false);
  };

  /**
   * The squares' area on screen: the board's box without its border (the 8×8 grid fills the
   * padding box, so measuring the border box would put every square a few pixels off).
   */
  private measureBoardRect(): DOMRect {
    const outer = this.boardEl.getBoundingClientRect();
    const el = this.boardEl;
    if (el.clientWidth <= 0 || el.clientHeight <= 0) return outer;
    return new DOMRect(outer.left + el.clientLeft, outer.top + el.clientTop, el.clientWidth, el.clientHeight);
  }

  private getBoardRect(): DOMRect {
    if (!this.cachedBoardRect) {
      this.cachedBoardRect = this.measureBoardRect();
    }
    return this.cachedBoardRect;
  }

  public squareFromClientPoint(clientX: number, clientY: number): Square | null {
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

  private acquirePieceElement(square: Square, color: Color, piece: PieceSymbol): HTMLElement {
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

  /** The real position with every queued premove played on top (opponent passing). */
  private computeDisplaySquares(): Map<Square, Piece> {
    const squares = boardSquaresFromAdapter(this.adapter);
    for (const premove of this.premoves) {
      applyPremoveToSquares(squares, premove);
    }
    return squares;
  }

  private pieceAt(square: Square): Piece | undefined {
    return this.displaySquares.get(square);
  }

  private cancelPieceAnimations(el: HTMLElement): void {
    const anim = this.pieceAnimations.get(el);
    if (anim) {
      this.pieceAnimations.delete(el);
      anim.cancel();
    }
  }

  /** Starts a transform animation on a piece, replacing any it already had. */
  private startPieceAnimation(
    el: HTMLElement,
    fromTransform: string,
    toTransform: string,
    durationMs: number,
  ): Animation | null {
    this.cancelPieceAnimations(el);
    if (durationMs <= 0 || typeof el.animate !== 'function') return null;
    try {
      const anim = el.animate([{ transform: fromTransform }, { transform: toTransform }], {
        duration: durationMs,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      });
      this.pieceAnimations.set(el, anim);
      anim.addEventListener('finish', () => {
        if (this.pieceAnimations.get(el) === anim) {
          this.pieceAnimations.delete(el);
        }
      });
      return anim;
    } catch {
      // Ignore Web Animations API errors in headless/mock environments
      return null;
    }
  }

  private animatePiece(el: HTMLElement, fromTransform: string, toTransform: string, durationMs: number): void {
    this.startPieceAnimation(el, fromTransform, toTransform, durationMs);
  }

  /**
   * Brings the piece elements in line with `next`. Pieces that slid (per
   * `planPieceTransitions`) keep their element and animate to the new square; every
   * element whose square changes first drops its running animation, so an interrupted
   * animation always ends on the right square. Elements that stay put are left alone,
   * which lets an animation started by the previous update finish undisturbed.
   */
  private renderPieces(
    next: Map<Square, Piece>,
    opts: {
      animate: boolean;
      durationMs?: number;
      /** Destination of a piece that was dropped by drag: it is already there. */
      noAnimateTo?: Square | null;
      /** Element being held by an ongoing drag: never repositioned here. */
      keepElement?: HTMLElement | null;
    },
  ): void {
    const durationMs = opts.animate ? (opts.durationMs ?? this.animationDurationOverride ?? this.feel.animationMs) : 0;

    const prev = new Map<Square, Piece>();
    for (const [sq, el] of this.pieceElements) {
      prev.set(sq, {
        color: el.getAttribute('data-color') as Color,
        type: el.getAttribute('data-piece') as PieceSymbol,
      });
    }

    const moved = new Map<Square, { el: HTMLElement; from: Square }>();
    for (const t of planPieceTransitions(prev, next)) {
      const el = this.pieceElements.get(t.from);
      if (el) {
        moved.set(t.to, { el, from: t.from });
      }
    }
    for (const { from } of moved.values()) {
      this.pieceElements.delete(from);
    }

    for (const [sq, el] of this.pieceElements) {
      const nextPiece = next.get(sq);
      if (
        !nextPiece ||
        el.getAttribute('data-color') !== nextPiece.color ||
        el.getAttribute('data-piece') !== nextPiece.type
      ) {
        this.cancelPieceAnimations(el);
        this.releasePieceElement(el);
        this.pieceElements.delete(sq);
      }
    }

    for (const [sq, piece] of next) {
      const toTransform = this.getSquareTranslateTransform(sq);
      const mv = moved.get(sq);
      if (mv) {
        const { el, from } = mv;
        this.cancelPieceAnimations(el);
        el.classList.remove('wc-piece-ghost-vacated', 'wc-piece-dragging');
        el.setAttribute('data-square', sq);
        el.setAttribute('data-testid', `piece-${sq}`);
        if (el.getAttribute('data-piece') !== piece.type || el.getAttribute('data-color') !== piece.color) {
          el.setAttribute('data-color', piece.color);
          el.setAttribute('data-piece', piece.type);
          el.innerHTML = getPieceSvgMarkup(this.pieceSet, piece.color, piece.type);
        }
        el.style.transform = toTransform;
        this.pieceElements.set(sq, el);
        if (sq !== opts.noAnimateTo) {
          this.animatePiece(el, this.getSquareTranslateTransform(from), toTransform, durationMs);
        } else {
          // A dragged piece glides in from where it was released
          const glide = this.takeDropGlide(el, sq);
          if (glide) this.glidePiece(el, glide.fromTransform, toTransform);
        }
        continue;
      }

      const existing = this.pieceElements.get(sq);
      if (existing) {
        if (existing === opts.keepElement) continue;
        existing.classList.remove('wc-piece-ghost-vacated');
        if (existing.style.transform !== toTransform) {
          this.cancelPieceAnimations(existing);
          existing.style.transform = toTransform;
        }
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
          ghostEl.innerHTML = getPieceSvgMarkup(this.pieceSet, targetPiece.color, targetPiece.type);
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
    // Hovering keeps re-firing for the same line; skip identical previews.
    const key = (p: GhostPreviewInput | null) =>
      p ? `${p.targetFen}|${(p.moves ?? []).map((m) => m.from + m.to).join(',')}` : '';
    if (key(preview) === key(this.ghostPreview)) return;
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
      hoveredIsTarget: this.hoveredIsTarget,
      lastMove: this.lastMove,
      checkSquare,
      legalMoves,
      premoves: this.premoves,
      premoveFlash: this.premoveFlashSquares,
      premoveTargets: this.premoveTargets,
      pendingConfirmMove: this.pendingConfirm ? { from: this.pendingConfirm.from, to: this.pendingConfirm.to } : null,
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

  private readonly handleWindowContextMenu = (event: MouseEvent): void => {
    if (!this.boardEl.isConnected) return;
    if (this.dragState || performance.now() < this.suppressContextMenuUntil) {
      event.preventDefault();
      this.suppressContextMenuUntil = 0;
    }
  };

  private readonly handleWindowMouseDown = (event: MouseEvent): void => {
    if (!this.boardEl.isConnected) return;
    if (event.button === 2 && this.dragState) {
      event.preventDefault();
      this.cancelDrag(true);
    }
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.boardEl.isConnected) return;
    if (event.key === 'Escape') {
      if (this.dragState) {
        event.preventDefault();
        this.cancelDrag(true);
        return;
      }
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
      if (this.premoves.length > 0) {
        event.preventDefault();
        this.clearPremoves();
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

  /** Premove destinations for a freshly selected piece, or none when premoving isn't possible. */
  private selectionPremoveTargets(square: Square, piece: Piece): Square[] {
    if (!this.enablePremoves || piece.color === this.adapter.turn() || this.premoves.length >= this.maxPremoves) {
      return [];
    }
    return computePremoveTargetsOnSquares(this.displaySquares, square, piece.color);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (this.kbActive) {
      this.kbActive = false;
      this.setKeyboardCursor(null, false);
    }
    // Refresh cached board rect once on pointerdown (never inside pointermove!)
    this.cachedBoardRect = this.measureBoardRect();

    const sq = this.squareFromClientPoint(event.clientX, event.clientY);

    // Right-click: cancel a drag, else clear queued premoves, else start a circle/arrow
    if (event.button === 2) {
      if (this.dragState) {
        event.preventDefault();
        this.cancelDrag(true);
        return;
      }
      if (!sq) return;
      if (this.premoves.length > 0) {
        this.selectedSquare = null;
        this.premoveTargets = [];
        this.clearPremoves();
        return;
      }
      this.rightDragStart = sq;
      return;
    }

    if (!sq) return;
    if (event.button !== 0) return;
    if (this.pendingPromotion || this.pendingConfirm) return;
    this.dropGlide = null;

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

    const clickedPiece = this.pieceAt(sq);

    // 1. If a square is already selected, check if clicking `sq` completes a move or premove
    if (this.tryCompleteSelectedMove(sq)) return;

    // 2. Otherwise, check if the clicked square has an interactive piece to select / drag
    if (clickedPiece && this.canInteractWithColor(clickedPiece.color)) {
      const wasSelected = this.selectedSquare === sq;
      this.selectedSquare = sq;
      this.premoveTargets = this.selectionPremoveTargets(sq, clickedPiece);
      if (!wasSelected) {
        this.onSelectSquareCallback?.(sq, clickedPiece);
      }

      const pieceEl = this.pieceElements.get(sq);
      if (pieceEl) {
        const drag: ActiveDragState = {
          pointerId: event.pointerId,
          isTouch: event.pointerType === 'touch',
          from: sq,
          piece: clickedPiece,
          element: pieceEl,
          startX: event.clientX,
          startY: event.clientY,
          isDragging: false,
          wasSelected,
          targets: null,
        };
        this.dragState = drag;
        this.liftPiece(drag, event.clientX, event.clientY);
      }

      this.syncOverlay();
      return;
    }

    // Clicked an empty or opponent square that isn't a target: clear the selection.
    // Queued premoves stay; right-click or Escape clears them.
    this.selectedSquare = null;
    this.premoveTargets = [];
    this.syncOverlay();
  };

  /** With a piece selected, plays (or premoves) it to `sq` when that is one of its targets. */
  private tryCompleteSelectedMove(sq: Square): boolean {
    const turn = this.adapter.turn();
    if (this.selectedSquare && this.selectedSquare !== sq) {
      const selectedPiece = this.pieceAt(this.selectedSquare);
      if (selectedPiece && this.canInteractWithColor(selectedPiece.color)) {
        if (selectedPiece.color === turn) {
          const legalTargets = this.getLegalMovesForSelectedSquare();
          if (legalTargets.some((t) => t.to === sq)) {
            this.initiateMoveOrPromotion(this.selectedSquare, sq, selectedPiece, false, false);
            return true;
          }
        } else if (this.premoveTargets.includes(sq)) {
          this.initiateMoveOrPromotion(this.selectedSquare, sq, selectedPiece, true, false);
          return true;
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ keyboard

  /** The square the keyboard cursor is on (null until the board is used from the keyboard). */
  private kbSquare: Square | null = null;

  private moveKeyboardCursor(dFile: number, dRank: number): void {
    const from = this.kbSquare ?? (this.flipped ? 'e7' : 'e2');
    // Arrow keys follow the screen: Right is towards the right edge whichever side is at the bottom
    const sign = this.flipped ? -1 : 1;
    const file = Math.min(7, Math.max(0, FILES.indexOf(from[0]!) + dFile * sign));
    const rank = Math.min(8, Math.max(1, Number(from[1]) + dRank * sign));
    this.setKeyboardCursor(`${FILES[file]}${rank}` as Square, true);
  }

  private setKeyboardCursor(sq: Square | null, speak: boolean): void {
    this.gridEl.querySelector('.wc-kb-focus')?.classList.remove('wc-kb-focus');
    this.kbSquare = sq;
    if (!sq) return;
    this.gridEl.querySelector(`[data-square="${sq}"]`)?.classList.add('wc-kb-focus');
    if (speak) announce(this.describeSquare(sq));
  }

  private describeSquare(sq: Square): string {
    const piece = this.pieceAt(sq);
    const names: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
    const what = piece ? `${piece.color === 'w' ? 'white' : 'black'} ${names[piece.type] ?? piece.type}` : 'empty';
    let text = `${sq}, ${what}`;
    if (this.selectedSquare === sq) {
      text += `, picked up, ${this.getLegalMovesForSelectedSquare().length} moves`;
    } else if (this.selectedSquare) {
      const target = this.getLegalMovesForSelectedSquare().some((t) => t.to === sq);
      if (target) text += ', legal move';
    }
    return text;
  }

  private keyboardActivate(sq: Square): void {
    if (this.pendingPromotion || this.pendingConfirm || this.dragState) return;
    if (this.onSquareEditCallback && this.onSquareEditCallback(sq)) return;
    if (this.tryCompleteSelectedMove(sq)) return;
    const piece = this.pieceAt(sq);
    if (piece && this.canInteractWithColor(piece.color) && this.selectedSquare !== sq) {
      this.selectedSquare = sq;
      this.premoveTargets = this.selectionPremoveTargets(sq, piece);
      this.onSelectSquareCallback?.(sq, piece);
      this.syncOverlay();
      announce(this.describeSquare(sq));
      return;
    }
    if (this.selectedSquare) {
      this.selectedSquare = null;
      this.premoveTargets = [];
      this.syncOverlay();
      announce(`${sq}, put down`);
    }
  }

  private readonly handleBoardKeyDown = (event: KeyboardEvent): void => {
    if (event.target !== this.boardEl || event.altKey || event.ctrlKey || event.metaKey) return;
    // Only when the board was reached from the keyboard: after a click the arrow keys keep their
    // old job (stepping through moves on the analysis board, Space for the engine)
    if (!this.kbActive) return;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, 1],
      ArrowDown: [0, -1],
    };
    const step = arrows[event.key];
    if (step) {
      event.preventDefault();
      event.stopPropagation(); // the analysis board's own arrows step through moves
      this.moveKeyboardCursor(step[0], step[1]);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      if (this.pendingConfirm) return; // Enter accepts it (the window handler)
      event.preventDefault();
      event.stopPropagation();
      this.keyboardActivate(this.kbSquare ?? (this.flipped ? 'e7' : 'e2'));
      if (!this.kbSquare) this.setKeyboardCursor(this.flipped ? 'e7' : 'e2', false);
      return;
    }
    // The promotion picker: the piece's letter chooses it
    if (this.pendingPromotion && 'qrbn'.includes(event.key.toLowerCase()) && event.key.length === 1) {
      event.preventDefault();
      this.resolvePromotionPicker(event.key.toLowerCase() as PieceSymbol);
    }
  };

  /** The board was reached with the keyboard (Tab), not by a click: its arrow keys move the cursor. */
  private kbActive = false;

  private readonly handleBoardFocus = (): void => {
    this.kbActive = this.boardEl.matches(':focus-visible');
    if (this.kbActive) {
      this.setKeyboardCursor(this.kbSquare ?? (this.flipped ? 'e7' : 'e2'), true);
    }
  };

  private readonly handleBoardBlur = (): void => {
    this.kbActive = false;
    this.setKeyboardCursor(null, false);
  };

  /**
   * Picks the held piece up: it scales up with a shadow and is centred under the pointer at
   * once, before any movement, so pressing a piece already feels like holding it.
   */
  private liftPiece(drag: ActiveDragState, clientX: number, clientY: number): void {
    this.cancelPieceAnimations(drag.element);
    drag.element.classList.remove('wc-piece-snapback');
    drag.element.classList.add('wc-piece-dragging');
    if (!drag.isTouch) {
      document.documentElement.classList.add('wc-grabbing');
    }
    this.setGrabHover(false);
    this.placeHeldPiece(drag, clientX, clientY);
  }

  /**
   * Where the held piece's centre is, in squares from the board's top-left corner. A touch
   * drag draws the piece `touchOffset` squares above the finger so it stays visible; the
   * drop square is the one under the piece.
   */
  private heldPiecePoint(
    drag: ActiveDragState,
    clientX: number,
    clientY: number,
    rect: DOMRect,
  ): { x: number; y: number } {
    const x = ((clientX - rect.left) / rect.width) * 8;
    let y = ((clientY - rect.top) / rect.height) * 8;
    if (drag.isTouch && drag.isDragging) {
      y -= this.feel.touchOffset;
    }
    return { x, y };
  }

  /** Moves the held piece (compositor-only transform, no layout reads). */
  private placeHeldPiece(drag: ActiveDragState, clientX: number, clientY: number): void {
    const rect = this.cachedBoardRect;
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const { x, y } = this.heldPiecePoint(drag, clientX, clientY, rect);
    const pctX = (x - 0.5) * 100;
    const pctY = (y - 0.5) * 100;
    drag.element.style.transform = `translate3d(${pctX.toFixed(2)}%, ${pctY.toFixed(2)}%, 0) scale(${this.feel.liftScale})`;
  }

  /** The squares the held piece may be dropped on: legal moves, or premove targets. */
  private dragTargets(drag: ActiveDragState): Square[] {
    if (drag.targets) return drag.targets;
    if (drag.piece.color === this.adapter.turn()) {
      drag.targets = this.selectedSquare === drag.from ? this.getLegalMovesForSelectedSquare().map((t) => t.to) : [];
    } else {
      drag.targets = [...this.premoveTargets];
    }
    return drag.targets;
  }

  /** The drop square for the held piece at this pointer position (drop tolerance applied). */
  private dropSquareFor(drag: ActiveDragState, clientX: number, clientY: number): Square | null {
    const rect = this.cachedBoardRect ?? this.getBoardRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const { x, y } = this.heldPiecePoint(drag, clientX, clientY, rect);
    return resolveDropSquare(x, y, this.dragTargets(drag), this.feel.dropTolerance, this.flipped);
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.boardEl.isConnected) return;
    const drag = this.dragState;
    if (!drag || event.pointerId !== drag.pointerId) return;

    // A right button pressed during a drag arrives as a chorded pointermove
    if (event.button === 2) {
      this.cancelDrag(true);
      return;
    }

    const rect = this.cachedBoardRect;
    if (!rect || rect.width <= 0 || rect.height <= 0) return;

    if (!drag.isDragging) {
      const dist = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      const threshold = this.feel.dragThresholdPx * (drag.isTouch ? 2 : 1);
      if (dist < threshold) {
        // Not a drag yet, but the lifted piece still follows the pointer
        this.placeHeldPiece(drag, event.clientX, event.clientY);
        return;
      }
      drag.isDragging = true;
    }

    this.placeHeldPiece(drag, event.clientX, event.clientY);

    const nextHover = this.dropSquareFor(drag, event.clientX, event.clientY);
    const isTarget = nextHover !== null && this.dragTargets(drag).includes(nextHover);
    if (nextHover !== this.hoveredSquare || isTarget !== this.hoveredIsTarget) {
      this.hoveredSquare = nextHover;
      this.hoveredIsTarget = isTarget;
      this.syncOverlay();
    }
  };

  /**
   * Glides a piece from `fromTransform` (where it was released, lifted) to `toTransform`
   * over the feel's snap duration, above the other pieces while it moves.
   */
  private glidePiece(el: HTMLElement, fromTransform: string, toTransform: string): void {
    this.cancelPieceAnimations(el);
    el.style.transform = toTransform;
    if (fromTransform === toTransform) return;
    const anim = this.startPieceAnimation(el, fromTransform, `${toTransform} scale(1)`, this.feel.snapMs);
    if (!anim) return;
    el.classList.add('wc-piece-snapback');
    const done = () => el.classList.remove('wc-piece-snapback');
    anim.addEventListener('finish', done);
    anim.addEventListener('cancel', done);
  }

  /** Animates a released piece from where it was dropped back to its square. */
  private snapBack(el: HTMLElement, fromTransform: string, homeTransform: string): void {
    this.glidePiece(el, fromTransform, homeTransform);
  }

  /** The held piece is down (dropped, cancelled or gone): no lift, no grabbing cursor. */
  private releaseHeldPiece(drag: ActiveDragState): void {
    drag.element.classList.remove('wc-piece-dragging');
    document.documentElement.classList.remove('wc-grabbing');
    this.hoveredSquare = null;
    this.hoveredIsTarget = false;
  }

  /**
   * Ends the drag in progress: the piece returns to its square (animated when `animate`)
   * and the selection is cleared. Returns false when nothing was being dragged.
   */
  private cancelDrag(animate: boolean): boolean {
    const drag = this.dragState;
    if (!drag) return false;
    this.dragState = null;
    this.releaseHeldPiece(drag);

    const dropTransform = drag.element.style.transform;
    const homeTransform = this.getSquareTranslateTransform(drag.from);
    if (animate) {
      this.snapBack(drag.element, dropTransform, homeTransform);
    } else {
      this.cancelPieceAnimations(drag.element);
      drag.element.style.transform = homeTransform;
    }

    this.selectedSquare = null;
    this.premoveTargets = [];
    this.suppressContextMenuUntil = performance.now() + 1500;
    this.syncOverlay();
    return true;
  }

  public isDragInProgress(): boolean {
    return this.dragState !== null;
  }

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
          const idx = this.userArrows.findIndex((a) => a.from === startSq && a.to === endSq);
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

    const dropSq = drag.isDragging ? this.dropSquareFor(drag, event.clientX, event.clientY) : null;
    this.dragState = null;
    this.releaseHeldPiece(drag);

    // The piece always comes down on a square, never left floating (Legacy Bug #2). It
    // glides there from where it was released.
    const dropTransform = drag.element.style.transform;
    const homeTransform = this.getSquareTranslateTransform(drag.from);

    if (!drag.isDragging) {
      // A plain click on the piece that was already selected deselects it
      if (drag.wasSelected) {
        this.selectedSquare = null;
        this.premoveTargets = [];
      }
      this.snapBack(drag.element, dropTransform, homeTransform);
      this.syncOverlay();
      return;
    }

    if (dropSq === drag.from) {
      this.snapBack(drag.element, dropTransform, homeTransform);
      this.syncOverlay();
      return;
    }

    if (dropSq) {
      const isMove = drag.piece.color === this.adapter.turn();
      const legal = isMove
        ? this.getLegalMovesForSelectedSquare().some((t) => t.to === dropSq)
        : this.premoveTargets.includes(dropSq);
      if (legal) {
        // Rest at home until the move lands; the board update then glides it in
        this.cancelPieceAnimations(drag.element);
        drag.element.style.transform = homeTransform;
        this.dropGlide = { element: drag.element, to: dropSq, fromTransform: dropTransform };
        this.initiateMoveOrPromotion(drag.from, dropSq, drag.piece, !isMove, true);
        return;
      }
    }

    // Dropped off the board or on a square it can't go to: slide back and deselect
    this.snapBack(drag.element, dropTransform, homeTransform);
    this.selectedSquare = null;
    this.premoveTargets = [];
    this.syncOverlay();
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (!this.boardEl.isConnected) return;
    const drag = this.dragState;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.cancelDrag(false);
  };

  /** Takes the pending drop glide when it is for `element` landing on `square`. */
  private takeDropGlide(element: HTMLElement, square: Square): DropGlide | null {
    const glide = this.dropGlide;
    if (!glide || glide.element !== element || glide.to !== square) return null;
    this.dropGlide = null;
    return glide;
  }

  private emitAnnotationsChange(): void {
    this.onAnnotationsChangeCallback?.(this.getPgnArrows(), this.getPgnHighlights());
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

  public setUserAnnotations(arrows: PgnArrowAnnotation[], highlights: PgnHighlightAnnotation[]): void {
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

  private isPromotionMove(from: Square, to: Square, piece: Piece, isPremove: boolean): boolean {
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
        this.finalizeMoveOrPremove({ from, to, promotion: 'q' }, isPremove, wasDragged);
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
        class="wc-promotion-column ${isTopEdge ? 'wc-promotion-column-top' : 'wc-promotion-column-bottom'}"
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
    this.dropGlide = null;
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

  private finalizeMoveOrPremove(move: PremoveInput, isPremove: boolean, wasDragged: boolean): void {
    this.selectedSquare = null;
    this.premoveTargets = [];

    if (isPremove) {
      this.addPremove(move, { dragged: wasDragged });
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
      const toTransform = this.getSquareTranslateTransform(move.to);
      const glide = wasDragged ? this.takeDropGlide(fromEl, move.to) : null;
      if (glide) this.glidePiece(fromEl, glide.fromTransform, toTransform);
      else fromEl.style.transform = toTransform;
    }
    const targetEl = this.pieceElements.get(move.to);
    if (targetEl && targetEl !== fromEl) {
      targetEl.style.opacity = '0.25';
    }

    const labelEl = this.confirmBarEl.querySelector('[data-testid="confirm-move-label"]');
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
    this.dropGlide = null;
    this.pendingConfirm = null;
    this.confirmBarEl.hidden = true;

    const fromEl = this.pieceElements.get(pending.from);
    if (fromEl) {
      this.cancelPieceAnimations(fromEl);
      fromEl.style.transform = this.getSquareTranslateTransform(pending.from);
    }
    const targetEl = this.pieceElements.get(pending.to);
    if (targetEl) {
      targetEl.style.opacity = '';
    }
    this.syncOverlay();
  }

  /** Re-renders the board after the premove queue changed. */
  private refreshPremoveDisplay(animate: boolean, noAnimateTo?: Square): void {
    this.displaySquares = this.computeDisplaySquares();
    const drag = this.dragState;
    if (drag) drag.targets = null;
    const held = drag ? this.displaySquares.get(drag.from) : undefined;
    const keepDrag =
      drag !== null && held !== undefined && held.color === drag.piece.color && held.type === drag.piece.type;
    if (drag && !keepDrag) {
      this.endDragForRemovedPiece();
    }
    this.renderPieces(this.displaySquares, {
      animate,
      noAnimateTo: noAnimateTo ?? null,
      keepElement: keepDrag && drag ? drag.element : null,
    });
    this.syncOverlay();
  }

  /**
   * Appends a premove to the queue. It is planned on the hypothetical board (earlier
   * premoves played, opponent passing). Returns false when the queue is full or the
   * premove's piece isn't on its square in that hypothetical position.
   */
  public addPremove(premove: PremoveInput, options?: { dragged?: boolean }): boolean {
    const piece = this.displaySquares.get(premove.from);
    if (!piece || this.premoves.length >= this.maxPremoves) {
      this.syncOverlay();
      return false;
    }
    this.premoves.push({
      from: premove.from,
      to: premove.to,
      promotion: premove.promotion,
    });
    this.refreshPremoveDisplay(true, options?.dragged ? premove.to : undefined);
    return true;
  }

  /** Replaces the whole queue with `premove`, or clears it when null. */
  public setPremove(premove: PremoveInput | null): void {
    this.clearPremoveFlash();
    this.premoves = [];
    if (premove) {
      this.premoves.push({
        from: premove.from,
        to: premove.to,
        promotion: premove.promotion,
      });
    }
    this.refreshPremoveDisplay(false);
  }

  /** The next premove to execute (head of the queue), or null. */
  public getPremove(): PremoveInput | null {
    return this.premoves[0] ? { ...this.premoves[0] } : null;
  }

  public getPremoves(): PremoveInput[] {
    return this.premoves.map((p) => ({ ...p }));
  }

  /**
   * Clears every queued premove. With `flash`, the cancelled squares blink in the
   * premove failure color so the player sees that the queue was dropped.
   */
  public clearPremoves(options?: { flash?: boolean }): void {
    if (this.premoves.length === 0) return;
    if (options?.flash) {
      const flash = new Set<Square>();
      for (const p of this.premoves) {
        flash.add(p.from);
        flash.add(p.to);
      }
      this.premoveFlashSquares = [...flash];
      if (this.premoveFlashTimer !== null) {
        clearTimeout(this.premoveFlashTimer);
      }
      this.premoveFlashTimer = setTimeout(() => {
        this.premoveFlashTimer = null;
        this.premoveFlashSquares = [];
        this.syncOverlay();
      }, PREMOVE_FLASH_MS);
    }
    this.premoves = [];
    this.refreshPremoveDisplay(true);
  }

  private clearPremoveFlash(): void {
    if (this.premoveFlashTimer !== null) {
      clearTimeout(this.premoveFlashTimer);
      this.premoveFlashTimer = null;
    }
    this.premoveFlashSquares = [];
  }

  public getPremoveFlashSquares(): Square[] {
    return [...this.premoveFlashSquares];
  }

  public setMaxPremoves(max: number): void {
    this.maxPremoves = Math.max(1, Math.floor(max));
    if (this.premoves.length > this.maxPremoves) {
      this.premoves = this.premoves.slice(0, this.maxPremoves);
      this.refreshPremoveDisplay(true);
    }
  }

  public getMaxPremoves(): number {
    return this.maxPremoves;
  }

  /** The held piece no longer exists (captured or moved away): end the drag cleanly. */
  private endDragForRemovedPiece(): void {
    const drag = this.dragState;
    if (!drag) return;
    this.dragState = null;
    this.releaseHeldPiece(drag);
    this.selectedSquare = null;
    this.premoveTargets = [];
  }

  public isPromotionPickerOpen(): boolean {
    return this.pendingPromotion !== null;
  }

  public isConfirmMovePending(): boolean {
    return this.pendingConfirm !== null;
  }

  /**
   * Updates the board position from a RulesAdapter or FEN string and triggers the capture
   * particle burst for a capturing `lastMove`.
   *
   * Pieces animate from the board diff when `animate` is true (the default whenever a
   * `lastMove` is given): forward moves, moves played backward, castling rooks, and
   * premoves snapping back all come out of the same plan. A dragged move's piece is
   * already on its square and doesn't animate.
   *
   * A drag in progress is never cancelled by a board update. If the held piece is still
   * on its square, the drag continues against the new position; if it was captured, the
   * drag ends cleanly with no ghost element left behind.
   */
  public setPosition(
    fenOrAdapter: string | RulesAdapter,
    options?: {
      lastMove?: ExecutedMove | { from: Square; to: Square } | null;
      wasDragged?: boolean;
      triggerCaptureParticles?: boolean;
      preserveAnalysisArrows?: boolean;
      animate?: boolean;
      animationDurationMs?: number;
      /** The head of the premove queue was just played on the real board. */
      consumedPremove?: boolean;
      /**
       * The opponent's reply: a piece selected by a tap or click (not a drag) stays selected if it is still on its
       * square, so a move begun while the opponent thought can be finished after it answered.
       */
      keepSelection?: boolean;
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
    if (options?.consumedPremove) {
      this.premoves.shift();
    }
    if (!options?.wasDragged) {
      this.dropGlide = null;
    }

    this.hintMove = null;
    if (!options?.preserveAnalysisArrows) {
      this.bestMoveArrow = null;
      this.threatMoveArrow = null;
    }

    this.ghostPreview = null;
    this.renderGhostLayer();

    const lm = options?.lastMove;
    this.lastMove = lm ? { from: lm.from, to: lm.to } : null;

    if (lm && options?.triggerCaptureParticles !== false && 'isCapture' in lm && lm.isCapture) {
      const capturedColor: Color = lm.color === 'w' ? 'b' : 'w';
      this.particles.triggerCapture(lm.to, capturedColor, lm.from, this.flipped);
    }

    const selectedBefore = this.selectedSquare;
    const selectedPieceBefore = selectedBefore ? this.displaySquares.get(selectedBefore) : undefined;
    this.displaySquares = this.computeDisplaySquares();

    const drag = this.dragState;
    const held = drag ? this.displaySquares.get(drag.from) : undefined;
    const dragContinues =
      drag !== null &&
      held !== undefined &&
      held.color === drag.piece.color &&
      held.type === drag.piece.type &&
      this.canInteractWithColor(held.color);

    if (drag && dragContinues) {
      drag.targets = null;
      this.selectedSquare = drag.from;
      this.premoveTargets = this.selectionPremoveTargets(drag.from, drag.piece);
    } else {
      this.endDragForRemovedPiece();
      const after = selectedBefore ? this.displaySquares.get(selectedBefore) : undefined;
      const keep =
        Boolean(options?.keepSelection) &&
        drag === null &&
        selectedBefore !== null &&
        after !== undefined &&
        after.color === selectedPieceBefore?.color &&
        after.type === selectedPieceBefore.type &&
        this.canInteractWithColor(after.color);
      this.selectedSquare = keep ? selectedBefore : null;
      this.premoveTargets = keep && after ? this.selectionPremoveTargets(selectedBefore!, after) : [];
    }

    const animate = options?.animate ?? Boolean(lm);
    this.renderPieces(this.displaySquares, {
      animate,
      ...(typeof options?.animationDurationMs === 'number' ? { durationMs: options.animationDurationMs } : {}),
      noAnimateTo: options?.wasDragged && lm ? lm.to : null,
      keepElement: dragContinues && drag ? drag.element : null,
    });
    this.syncOverlay();
  }

  public setFlipped(flipped: boolean): void {
    if (this.flipped === flipped) return;
    this.flipped = flipped;
    this.boardEl.setAttribute('data-flipped', String(this.flipped));
    this.renderSquaresGrid();
    this.renderCoordinates();
    for (const [sq, el] of this.pieceElements.entries()) {
      if (this.dragState && el === this.dragState.element) continue;
      this.cancelPieceAnimations(el);
      el.style.transform = this.getSquareTranslateTransform(sq);
    }
    for (const [sq, el] of this.ghostPieceElements.entries()) {
      el.style.transform = this.getSquareTranslateTransform(sq);
    }
    this.renderSquareBadge();
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
    const drag = this.dragState;
    if (drag && !this.canInteractWithColor(drag.piece.color)) {
      this.cancelDrag(false);
    }
    if (this.dragState) {
      this.dragState.targets = null;
      this.selectedSquare = this.dragState.from;
      this.premoveTargets = this.selectionPremoveTargets(this.dragState.from, this.dragState.piece);
    } else {
      this.selectedSquare = null;
      this.premoveTargets = [];
    }
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

  /**
   * Shows one icon on the top-right corner of `badge.square` (e.g. the current move's review
   * classification), or removes it with null.
   */
  public setSquareBadge(badge: SquareBadge | null): void {
    const prev = this.squareBadge;
    if (
      prev === badge ||
      (prev && badge && prev.square === badge.square && prev.html === badge.html && prev.label === badge.label)
    ) {
      return;
    }
    this.squareBadge = badge ? { ...badge } : null;
    this.renderSquareBadge();
  }

  public getSquareBadge(): SquareBadge | null {
    return this.squareBadge ? { ...this.squareBadge } : null;
  }

  private renderSquareBadge(): void {
    const badge = this.squareBadge;
    if (!badge) {
      this.badgeLayerEl.replaceChildren();
      return;
    }
    let el = this.badgeLayerEl.firstElementChild as HTMLElement | null;
    if (!el) {
      el = document.createElement('div');
      el.className = 'wc-board-badge';
      el.setAttribute('data-testid', 'board-badge');
      this.badgeLayerEl.appendChild(el);
    }
    el.setAttribute('data-square', badge.square);
    el.setAttribute('data-label', badge.label);
    el.style.transform = this.getSquareTranslateTransform(badge.square);
    el.innerHTML = badge.html;
  }

  public getPieceElement(square: Square): HTMLElement | undefined {
    return this.pieceElements.get(square);
  }

  public getGhostPieceElement(square: Square): HTMLElement | undefined {
    return this.ghostPieceElements.get(square);
  }

  public destroy(): void {
    this.boardEl.removeEventListener('pointerdown', this.handlePointerDown);
    this.boardEl.removeEventListener('keydown', this.handleBoardKeyDown);
    this.boardEl.removeEventListener('focus', this.handleBoardFocus);
    this.boardEl.removeEventListener('blur', this.handleBoardBlur);
    this.boardEl.removeEventListener('pointermove', this.handleHoverMove);
    this.boardEl.removeEventListener('pointerleave', this.handleHoverLeave);
    window.removeEventListener('scroll', this.invalidateBoardRect, true);
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerCancel);
    window.removeEventListener('mousedown', this.handleWindowMouseDown, true);
    window.removeEventListener('contextmenu', this.handleWindowContextMenu, true);
    this.boardEl.removeEventListener('contextmenu', this.handleContextMenu);
    window.removeEventListener('keydown', this.handleKeyDown);
    this.clearPremoveFlash();
    if (this.dragState) this.releaseHeldPiece(this.dragState);
    this.unsubscribeFeel();
    this.detachResizeHandle?.();
    this.resizeObserver?.disconnect();
    this.particles.destroy();
    this.frameEl.remove();
  }
}
