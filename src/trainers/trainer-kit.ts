import type { ExecutedMove, MoveInput, PieceSymbol } from '../core/rules';
import { CathedralAudio } from '../render/audio';
import { BoardRenderer } from '../render/board-renderer';
import { DEFAULT_BOARD_THEME, DEFAULT_PIECE_SET } from '../render/themes';
import type { UciScore } from '../engine/uci-parser';

/** Pieces and pauses the trainers share. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface MoveSoundInfo {
  piece: PieceSymbol;
  isCapture: boolean;
}

/** The move sound (check, capture or slide) the other boards use. */
export function playMoveSound(audio: CathedralAudio, move: MoveSoundInfo, check: boolean): void {
  if (check) audio.playCheck();
  else if (move.isCapture) audio.playShatter();
  else audio.playSlide(CathedralAudio.shouldPieceLevitate(move.piece));
}

/** The same for a node of a game tree (its SAN says check and capture). */
export function soundForNode(audio: CathedralAudio, node: { piece?: PieceSymbol; captured?: PieceSymbol; san: string }): void {
  playMoveSound(audio, { piece: node.piece ?? 'p', isCapture: node.captured !== undefined || node.san.includes('x') }, /[+#]$/.test(node.san));
}

export function fromExecuted(move: ExecutedMove): MoveSoundInfo {
  return { piece: move.piece, isCapture: move.isCapture };
}

/** A score from the other side's point of view. */
export function negateScore(score: UciScore): UciScore {
  return { type: score.type, value: score.value === 0 ? 0 : -score.value };
}

export interface TrainerLayoutOptions {
  testId: string;
  label: string;
  /** Extra classes of the root and of the panel. */
  rootClass: string;
  panelClass: string;
  boardMountTestId: string;
  /** The board column's content under the board (optional). */
  belowBoard?: string;
  /** The panel's markup: scrolling body, then the foot (optional). */
  body: string;
  foot?: string;
  /** Markup above the body, inside the panel (tabs). */
  head?: string;
}

/** The two-column layout every trainer uses: the board on the left, a panel on the right (stacked on phones). */
export function trainerLayoutHtml(o: TrainerLayoutOptions): string {
  return `
    <div class="wc-board-column">
      <div class="wc-board-mount" data-testid="${o.boardMountTestId}"></div>
      ${o.belowBoard ?? ''}
    </div>
    <aside class="wc-panel wc-trainer-panel ${o.panelClass}" aria-label="${escapeHtml(o.label)}">
      <div class="wc-panel-inner">
        ${o.head ?? ''}
        <div class="wc-panel-body">${o.body}</div>
        ${o.foot ? `<div class="wc-panel-foot wc-action-bar">${o.foot}</div>` : ''}
      </div>
    </aside>`;
}

/** A trainer's root element, appended to `container`. */
export function createTrainerRoot(container: HTMLElement, testId: string, rootClass: string): HTMLElement {
  const root = document.createElement('div');
  root.className = `wc-play-layout wc-trainer-layout ${rootClass}`;
  root.setAttribute('data-testid', testId);
  container.appendChild(root);
  return root;
}

/** A board for a trainer (no premoves, no auto-queen: a promotion asks), looking as set in Settings once applied. */
export function createTrainerBoard(
  mount: HTMLElement,
  audio: CathedralAudio,
  onMove?: (move: MoveInput, wasDragged: boolean) => void,
): BoardRenderer {
  return new BoardRenderer(mount, {
    flipped: false,
    interactiveColor: 'none',
    enablePremoves: false,
    autoQueen: false,
    confirmMove: false,
    captureEffects: true,
    boardTheme: DEFAULT_BOARD_THEME,
    pieceSet: DEFAULT_PIECE_SET,
    ...(onMove ? { onMove } : {}),
    onSelectSquare: () => audio.playSelect(),
  });
}

/** Timers that are all cleared together (a drill's pauses and animations). */
export class Timers {
  private ids: Array<ReturnType<typeof setTimeout>> = [];

  public later(fn: () => void, ms: number): void {
    this.ids.push(setTimeout(fn, ms));
  }

  public clear(): void {
    for (const id of this.ids) clearTimeout(id);
    this.ids = [];
  }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Moves in SAN with move numbers, starting at a FEN ("23… Rxf1 24. Qe1"). */
export function numberedSans(fen: string, sans: readonly string[]): string {
  const parts = fen.trim().split(/\s+/);
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
