import {
  DEFAULT_POSITION,
  validateChessFen,
  type Color,
  type FenValidationResult,
  type Piece,
  type PieceSymbol,
  type Square,
} from '../core/rules';
import { getPieceSvgMarkup } from '../render/piece-sets';
import { DEFAULT_PIECE_SET, type PieceSetId } from '../render/themes';

export type EditorTool =
  | 'pointer'
  | 'trash'
  | 'wK'
  | 'wQ'
  | 'wR'
  | 'wB'
  | 'wN'
  | 'wP'
  | 'bK'
  | 'bQ'
  | 'bR'
  | 'bB'
  | 'bN'
  | 'bP';

const FILES = 'abcdefgh';

export interface ParsedEditorBoard {
  squares: Map<Square, Piece>;
  turn: Color;
  castling: string;
  epSquare: string;
  halfMoves: number;
  fullMoves: number;
}

/**
 * Parses any 6-field FEN (even one that fails chess legality checks like missing kings)
 * into a square map and metadata so the interactive position editor can manipulate individual squares.
 */
export function parseFenForEditor(fen: string): ParsedEditorBoard | null {
  const tokens = fen.trim().split(/\s+/);
  if (tokens.length < 1 || !tokens[0]) return null;

  const boardPart = tokens[0];
  const turn: Color = tokens[1] === 'b' ? 'b' : 'w';
  const castling = tokens[2] ?? '-';
  const epSquare = tokens[3] ?? '-';
  const halfMoves = Number.isFinite(Number(tokens[4]))
    ? Math.max(0, Number(tokens[4]))
    : 0;
  const fullMoves = Number.isFinite(Number(tokens[5]))
    ? Math.max(1, Number(tokens[5]))
    : 1;

  const rows = boardPart.split('/');
  if (rows.length !== 8) return null;

  const squares = new Map<Square, Piece>();
  for (let r = 0; r < 8; r++) {
    const rowStr = rows[r]!;
    let fileIdx = 0;
    for (let i = 0; i < rowStr.length; i++) {
      const ch = rowStr[i]!;
      if (ch >= '1' && ch <= '8') {
        fileIdx += Number(ch);
      } else if (/^[prnbqkPRNBQK]$/.test(ch)) {
        if (fileIdx >= 8) return null;
        const sq = `${FILES[fileIdx]}${8 - r}` as Square;
        const color: Color = ch === ch.toUpperCase() ? 'w' : 'b';
        const type = ch.toLowerCase() as PieceSymbol;
        squares.set(sq, { color, type });
        fileIdx++;
      } else {
        return null;
      }
    }
    if (fileIdx !== 8) return null;
  }

  return {
    squares,
    turn,
    castling,
    epSquare,
    halfMoves,
    fullMoves,
  };
}

/**
 * Serializes an `ParsedEditorBoard` state back into a 6-field FEN string.
 */
export function serializeEditorBoardToFen(board: ParsedEditorBoard): string {
  const rankStrings: string[] = [];
  for (let rank = 8; rank >= 1; rank--) {
    let rankStr = '';
    let emptyCount = 0;
    for (let f = 0; f < 8; f++) {
      const sq = `${FILES[f]}${rank}` as Square;
      const piece = board.squares.get(sq);
      if (!piece) {
        emptyCount++;
      } else {
        if (emptyCount > 0) {
          rankStr += String(emptyCount);
          emptyCount = 0;
        }
        rankStr +=
          piece.color === 'w'
            ? piece.type.toUpperCase()
            : piece.type.toLowerCase();
      }
    }
    if (emptyCount > 0) {
      rankStr += String(emptyCount);
    }
    rankStrings.push(rankStr);
  }

  const castlingClean = board.castling.trim() || '-';
  const epClean = board.epSquare.trim() || '-';
  return `${rankStrings.join('/')} ${board.turn} ${castlingClean} ${epClean} ${board.halfMoves} ${board.fullMoves}`;
}

export interface PositionEditorOptions {
  initialFen?: string;
  pieceSet?: PieceSetId;
  onApplyPosition?: (fen: string) => void;
  onPreviewSquaresChange?: (squares: Map<Square, Piece>) => void;
  onToolChange?: (tool: EditorTool) => void;
}

/**
 * Position Editor with live FEN validation (`validateChessFen`), interactive piece palette,
 * turn/castling/en-passant controls, and board presets.
 */
export class PositionEditor {
  private readonly rootEl: HTMLElement;
  private readonly fenInputEl: HTMLInputElement;
  private readonly statusEl: HTMLElement;
  private readonly applyBtnEl: HTMLButtonElement;
  private readonly turnSelectEl: HTMLSelectElement;
  private readonly castleKCheckEl: HTMLInputElement;
  private readonly castleQCheckEl: HTMLInputElement;
  private readonly castlekCheckEl: HTMLInputElement;
  private readonly castleqCheckEl: HTMLInputElement;
  private readonly epInputEl: HTMLInputElement;
  private readonly paletteContainerEl: HTMLElement;

  private currentFen: string;
  private activeTool: EditorTool = 'pointer';
  private pieceSet: PieceSetId;
  private lastValidation: FenValidationResult;

  private readonly onApplyPosition?: (fen: string) => void;
  private readonly onPreviewSquaresChange?: (
    squares: Map<Square, Piece>,
  ) => void;
  private readonly onToolChange?: (tool: EditorTool) => void;

  constructor(parent: HTMLElement, options?: PositionEditorOptions) {
    this.currentFen = options?.initialFen?.trim() || DEFAULT_POSITION;
    this.pieceSet = options?.pieceSet ?? DEFAULT_PIECE_SET;
    this.onApplyPosition = options?.onApplyPosition;
    this.onPreviewSquaresChange = options?.onPreviewSquaresChange;
    this.onToolChange = options?.onToolChange;
    this.lastValidation = validateChessFen(this.currentFen);

    this.rootEl = document.createElement('section');
    this.rootEl.className = 'wc-position-editor';
    this.rootEl.setAttribute('data-testid', 'position-editor-panel');
    this.rootEl.setAttribute('aria-label', 'Position Editor');

    this.rootEl.innerHTML = `
      <div class="wc-panel-section-title">
        <span>Position Editor &amp; FEN Validation</span>
        <span class="wc-editor-validation-pill" data-testid="editor-fen-status" data-valid="true">Valid FEN</span>
      </div>

      <div class="wc-editor-fen-row">
        <input
          type="text"
          class="wc-input wc-input-mono"
          data-testid="editor-fen-input"
          aria-label="FEN string"
          spellcheck="false"
          autocomplete="off"
        />
        <button
          type="button"
          class="wc-btn wc-btn-primary wc-btn-sm"
          data-testid="btn-apply-fen"
        >
          Apply FEN
        </button>
      </div>

      <div class="wc-editor-palette" data-testid="editor-piece-palette"></div>

      <div class="wc-editor-controls-row">
        <label class="wc-field">
          <span class="wc-field-label">Side to Move</span>
          <select class="wc-select wc-select-sm" data-testid="editor-select-turn">
            <option value="w">White (w)</option>
            <option value="b">Black (b)</option>
          </select>
        </label>

        <div class="wc-field">
          <span class="wc-field-label">Castling Rights</span>
          <div class="wc-editor-castling-row">
            <label class="wc-checkbox-label"><input type="checkbox" data-testid="editor-castle-K" checked /><span>K</span></label>
            <label class="wc-checkbox-label"><input type="checkbox" data-testid="editor-castle-Q" checked /><span>Q</span></label>
            <label class="wc-checkbox-label"><input type="checkbox" data-testid="editor-castle-k" checked /><span>k</span></label>
            <label class="wc-checkbox-label"><input type="checkbox" data-testid="editor-castle-q" checked /><span>q</span></label>
          </div>
        </div>

        <label class="wc-field">
          <span class="wc-field-label">En Passant</span>
          <input
            type="text"
            class="wc-input wc-input-mono wc-input-xs"
            data-testid="editor-ep-square"
            maxlength="2"
            placeholder="-"
            value="-"
          />
        </label>
      </div>

      <div class="wc-action-row">
        <button type="button" class="wc-btn wc-btn-secondary wc-btn-sm" data-testid="btn-editor-startpos">
          Start Pos
        </button>
        <button type="button" class="wc-btn wc-btn-secondary wc-btn-sm" data-testid="btn-editor-kings-only">
          Kings Only
        </button>
        <button type="button" class="wc-btn wc-btn-ghost wc-btn-sm" data-testid="btn-editor-clear">
          Clear Board
        </button>
      </div>
    `;

    this.fenInputEl = this.rootEl.querySelector(
      '[data-testid="editor-fen-input"]',
    ) as HTMLInputElement;
    this.statusEl = this.rootEl.querySelector(
      '[data-testid="editor-fen-status"]',
    ) as HTMLElement;
    this.applyBtnEl = this.rootEl.querySelector(
      '[data-testid="btn-apply-fen"]',
    ) as HTMLButtonElement;
    this.turnSelectEl = this.rootEl.querySelector(
      '[data-testid="editor-select-turn"]',
    ) as HTMLSelectElement;
    this.castleKCheckEl = this.rootEl.querySelector(
      '[data-testid="editor-castle-K"]',
    ) as HTMLInputElement;
    this.castleQCheckEl = this.rootEl.querySelector(
      '[data-testid="editor-castle-Q"]',
    ) as HTMLInputElement;
    this.castlekCheckEl = this.rootEl.querySelector(
      '[data-testid="editor-castle-k"]',
    ) as HTMLInputElement;
    this.castleqCheckEl = this.rootEl.querySelector(
      '[data-testid="editor-castle-q"]',
    ) as HTMLInputElement;
    this.epInputEl = this.rootEl.querySelector(
      '[data-testid="editor-ep-square"]',
    ) as HTMLInputElement;
    this.paletteContainerEl = this.rootEl.querySelector(
      '[data-testid="editor-piece-palette"]',
    ) as HTMLElement;

    parent.appendChild(this.rootEl);
    this.renderPalette();
    this.bindEvents();
    this.setFen(this.currentFen, false);
  }

  private renderPalette(): void {
    const tools: Array<{
      id: EditorTool;
      label: string;
      color?: Color;
      piece?: PieceSymbol;
      icon?: string;
    }> = [
      { id: 'pointer', label: 'Move Pieces', icon: '↖' },
      { id: 'trash', label: 'Clear Square', icon: '✕' },
      { id: 'wK', label: 'White King', color: 'w', piece: 'k' },
      { id: 'wQ', label: 'White Queen', color: 'w', piece: 'q' },
      { id: 'wR', label: 'White Rook', color: 'w', piece: 'r' },
      { id: 'wB', label: 'White Bishop', color: 'w', piece: 'b' },
      { id: 'wN', label: 'White Knight', color: 'w', piece: 'n' },
      { id: 'wP', label: 'White Pawn', color: 'w', piece: 'p' },
      { id: 'bK', label: 'Black King', color: 'b', piece: 'k' },
      { id: 'bQ', label: 'Black Queen', color: 'b', piece: 'q' },
      { id: 'bR', label: 'Black Rook', color: 'b', piece: 'r' },
      { id: 'bB', label: 'Black Bishop', color: 'b', piece: 'b' },
      { id: 'bN', label: 'Black Knight', color: 'b', piece: 'n' },
      { id: 'bP', label: 'Black Pawn', color: 'b', piece: 'p' },
    ];

    this.paletteContainerEl.innerHTML = tools
      .map((t) => {
        const active = t.id === this.activeTool;
        const inner =
          t.color && t.piece
            ? `<span class="wc-editor-tool-svg">${getPieceSvgMarkup(this.pieceSet, t.color, t.piece)}</span>`
            : `<span class="wc-editor-tool-glyph">${t.icon ?? ''}</span>`;
        return `
          <button
            type="button"
            class="wc-editor-tool-btn ${active ? 'wc-editor-tool-active' : ''}"
            data-editor-tool="${t.id}"
            data-testid="editor-tool-${t.id}"
            aria-pressed="${active}"
            title="${t.label}"
          >
            ${inner}
          </button>
        `;
      })
      .join('');
  }

  private bindEvents(): void {
    this.fenInputEl.addEventListener('input', () => {
      this.setFen(this.fenInputEl.value, true);
    });

    this.fenInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.applyCurrentFen();
      }
    });

    this.applyBtnEl.addEventListener('click', () => {
      this.applyCurrentFen();
    });

    this.paletteContainerEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest(
        '[data-editor-tool]',
      ) as HTMLButtonElement | null;
      if (!btn) return;
      const tool = btn.getAttribute('data-editor-tool') as EditorTool;
      this.setTool(tool);
    });

    const syncMetadataToFen = () => {
      const parsed = parseFenForEditor(this.currentFen);
      if (!parsed) return;
      parsed.turn = this.turnSelectEl.value === 'b' ? 'b' : 'w';
      let castling = '';
      if (this.castleKCheckEl.checked) castling += 'K';
      if (this.castleQCheckEl.checked) castling += 'Q';
      if (this.castlekCheckEl.checked) castling += 'k';
      if (this.castleqCheckEl.checked) castling += 'q';
      parsed.castling = castling || '-';
      parsed.epSquare = this.epInputEl.value.trim() || '-';
      this.setFen(serializeEditorBoardToFen(parsed), true);
    };

    this.turnSelectEl.addEventListener('change', syncMetadataToFen);
    this.castleKCheckEl.addEventListener('change', syncMetadataToFen);
    this.castleQCheckEl.addEventListener('change', syncMetadataToFen);
    this.castlekCheckEl.addEventListener('change', syncMetadataToFen);
    this.castleqCheckEl.addEventListener('change', syncMetadataToFen);
    this.epInputEl.addEventListener('change', syncMetadataToFen);

    this.rootEl
      .querySelector('[data-testid="btn-editor-startpos"]')
      ?.addEventListener('click', () => {
        this.setFen(DEFAULT_POSITION, true);
        this.applyCurrentFen();
      });

    this.rootEl
      .querySelector('[data-testid="btn-editor-kings-only"]')
      ?.addEventListener('click', () => {
        this.setFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1', true);
        this.applyCurrentFen();
      });

    this.rootEl
      .querySelector('[data-testid="btn-editor-clear"]')
      ?.addEventListener('click', () => {
        this.setFen('8/8/8/8/8/8/8/8 w - - 0 1', true);
      });
  }

  public setTool(tool: EditorTool): void {
    this.activeTool = tool;
    this.renderPalette();
    this.onToolChange?.(tool);
  }

  public getTool(): EditorTool {
    return this.activeTool;
  }

  public setPieceSet(pieceSet: PieceSetId): void {
    if (this.pieceSet === pieceSet) return;
    this.pieceSet = pieceSet;
    this.renderPalette();
  }

  /**
   * Handles a square click on the board when an editor tool other than `pointer` is selected.
   * Returns true if the click was consumed by the editor.
   */
  public handleBoardSquareClick(square: Square): boolean {
    if (this.activeTool === 'pointer') {
      return false;
    }

    const parsed = parseFenForEditor(this.currentFen);
    if (!parsed) return false;

    if (this.activeTool === 'trash') {
      parsed.squares.delete(square);
    } else {
      const color: Color = this.activeTool[0] === 'w' ? 'w' : 'b';
      const type = this.activeTool[1]!.toLowerCase() as PieceSymbol;
      const existing = parsed.squares.get(square);
      if (existing && existing.color === color && existing.type === type) {
        parsed.squares.delete(square);
      } else {
        parsed.squares.set(square, { color, type });
      }
    }

    // Automatically prune standard castling flags if King or Rook is no longer on its home square
    const wK = parsed.squares.get('e1');
    if (!wK || wK.color !== 'w' || wK.type !== 'k') {
      parsed.castling = parsed.castling.replace(/[KQ]/g, '');
    } else {
      const h1 = parsed.squares.get('h1');
      if (!h1 || h1.color !== 'w' || h1.type !== 'r') {
        parsed.castling = parsed.castling.replace(/K/g, '');
      }
      const a1 = parsed.squares.get('a1');
      if (!a1 || a1.color !== 'w' || a1.type !== 'r') {
        parsed.castling = parsed.castling.replace(/Q/g, '');
      }
    }
    const bK = parsed.squares.get('e8');
    if (!bK || bK.color !== 'b' || bK.type !== 'k') {
      parsed.castling = parsed.castling.replace(/[kq]/g, '');
    } else {
      const h8 = parsed.squares.get('h8');
      if (!h8 || h8.color !== 'b' || h8.type !== 'r') {
        parsed.castling = parsed.castling.replace(/k/g, '');
      }
      const a8 = parsed.squares.get('a8');
      if (!a8 || a8.color !== 'b' || a8.type !== 'r') {
        parsed.castling = parsed.castling.replace(/q/g, '');
      }
    }
    if (!parsed.castling) parsed.castling = '-';

    const nextFen = serializeEditorBoardToFen(parsed);
    this.setFen(nextFen, true);
    if (this.lastValidation.ok) {
      this.onApplyPosition?.(this.currentFen);
    }
    return true;
  }

  public setFen(fen: string, emitPreview = false): FenValidationResult {
    this.currentFen = fen;
    if (this.fenInputEl.value !== fen) {
      this.fenInputEl.value = fen;
    }

    const validation = validateChessFen(fen.trim());
    this.lastValidation = validation;

    const parsed = parseFenForEditor(fen);
    if (parsed) {
      this.turnSelectEl.value = parsed.turn;
      this.castleKCheckEl.checked = parsed.castling.includes('K');
      this.castleQCheckEl.checked = parsed.castling.includes('Q');
      this.castlekCheckEl.checked = parsed.castling.includes('k');
      this.castleqCheckEl.checked = parsed.castling.includes('q');
      this.epInputEl.value = parsed.epSquare;
      if (emitPreview) {
        this.onPreviewSquaresChange?.(parsed.squares);
      }
    }

    if (validation.ok) {
      this.statusEl.textContent = validation.isChess960
        ? 'Valid Chess960 FEN'
        : 'Valid FEN';
      this.statusEl.setAttribute('data-valid', 'true');
      this.applyBtnEl.disabled = false;
    } else {
      this.statusEl.textContent = validation.error ?? 'Invalid FEN';
      this.statusEl.setAttribute('data-valid', 'false');
      this.applyBtnEl.disabled = true;
    }

    return validation;
  }

  public getFen(): string {
    return this.currentFen;
  }

  public getValidation(): FenValidationResult {
    return this.lastValidation;
  }

  public applyCurrentFen(): boolean {
    const validation = validateChessFen(this.currentFen.trim());
    this.lastValidation = validation;
    if (!validation.ok) {
      this.statusEl.textContent = validation.error ?? 'Invalid FEN';
      this.statusEl.setAttribute('data-valid', 'false');
      this.applyBtnEl.disabled = true;
      return false;
    }
    this.onApplyPosition?.(this.currentFen.trim());
    return true;
  }
}
