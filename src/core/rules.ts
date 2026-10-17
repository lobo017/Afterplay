import {
  Chess,
  DEFAULT_POSITION,
  SQUARES,
  type Color,
  type Move,
  type Piece,
  type PieceSymbol,
  type Square,
} from 'chess.js';

export { DEFAULT_POSITION, SQUARES };
export type { Color, Piece, PieceSymbol, Square };

export interface MoveInput {
  from: string;
  to: string;
  promotion?: string;
}

export interface ExecutedMove {
  color: Color;
  from: Square;
  to: Square;
  piece: PieceSymbol;
  captured?: PieceSymbol;
  promotion?: PieceSymbol;
  san: string;
  uci: string;
  before: string;
  after: string;
  isCastle: boolean;
  isKingsideCastle: boolean;
  isQueensideCastle: boolean;
  isEnPassant: boolean;
  isPromotion: boolean;
  isCapture: boolean;
  isNullMove: boolean;
}

export interface FenValidationResult {
  ok: boolean;
  error?: string;
  isChess960?: boolean;
}

interface CastlingSideRight {
  rookFile: number; // 0..7 ('a'..'h')
  symbol: string; // 'K'/'Q'/'A'..'H' or 'k'/'q'/'a'..'h'
}

interface SideCastlingState {
  kingFile: number | null; //Initial king file 0..7 while unmoved
  kSide: CastlingSideRight | null;
  qSide: CastlingSideRight | null;
}

interface Chess960CastlingState {
  enabled: boolean;
  shredderNotation: boolean;
  order: 'kq' | 'alpha';
  w: SideCastlingState;
  b: SideCastlingState;
}

interface HistorySnapshot {
  fenBefore: string;
  chessFenBefore: string;
  c960Before: Chess960CastlingState;
  positionCountsBefore: Map<string, number>;
  executedMove: ExecutedMove;
}

const FILES = 'abcdefgh';

function fileIndex(fileChar: string): number {
  return FILES.indexOf(fileChar.toLowerCase());
}

function fileCharFromIndex(idx: number): string {
  return FILES[idx] ?? 'a';
}

function cloneC960State(state: Chess960CastlingState): Chess960CastlingState {
  return {
    enabled: state.enabled,
    shredderNotation: state.shredderNotation,
    order: state.order,
    w: {
      kingFile: state.w.kingFile,
      kSide: state.w.kSide ? { ...state.w.kSide } : null,
      qSide: state.w.qSide ? { ...state.w.qSide } : null,
    },
    b: {
      kingFile: state.b.kingFile,
      kSide: state.b.kSide ? { ...state.b.kSide } : null,
      qSide: state.b.qSide ? { ...state.b.qSide } : null,
    },
  };
}

function expandFenRank(rankStr: string): string[] | null {
  const squares: string[] = [];
  let prevDigit = false;
  for (let i = 0; i < rankStr.length; i++) {
    const ch = rankStr[i]!;
    if (ch >= '1' && ch <= '8') {
      if (prevDigit) return null;
      const count = Number(ch);
      for (let k = 0; k < count; k++) squares.push('');
      prevDigit = true;
    } else if (/^[prnbqkPRNBQK]$/.test(ch)) {
      squares.push(ch);
      prevDigit = false;
    } else {
      return null;
    }
  }
  return squares.length === 8 ? squares : null;
}

/**
 * Validates both standard FEN and Chess960 (Shredder-FEN / X-FEN) strings.
 */
export function validateChessFen(fen: string): FenValidationResult {
  const tokens = fen.trim().split(/\s+/);
  if (tokens.length !== 6) {
    return {
      ok: false,
      error: 'Invalid FEN: must contain six space-delimited fields',
    };
  }

  const [boardPart, turnPart, castlingPart, epPart, halfMovePart, fullMovePart] =
    tokens as [string, string, string, string, string, string];

  if (turnPart !== 'w' && turnPart !== 'b') {
    return { ok: false, error: 'Invalid FEN: side-to-move must be w or b' };
  }

  if (!/^\d+$/.test(halfMovePart) || Number(halfMovePart) < 0) {
    return {
      ok: false,
      error: 'Invalid FEN: half-move clock must be a non-negative integer',
    };
  }

  if (!/^\d+$/.test(fullMovePart) || Number(fullMovePart) <= 0) {
    return {
      ok: false,
      error: 'Invalid FEN: full-move number must be a positive integer',
    };
  }

  if (!/^(-|[a-h][36])$/.test(epPart)) {
    return { ok: false, error: 'Invalid FEN: en-passant square is invalid' };
  }
  if ((epPart[1] === '3' && turnPart === 'w') || (epPart[1] === '6' && turnPart === 'b')) {
    return { ok: false, error: 'Invalid FEN: illegal en-passant rank for side to move' };
  }

  const rows = boardPart.split('/');
  if (rows.length !== 8) {
    return { ok: false, error: 'Invalid FEN: board must have 8 ranks' };
  }

  const grid: string[][] = [];
  let whiteKings = 0;
  let blackKings = 0;

  for (let r = 0; r < 8; r++) {
    const expanded = expandFenRank(rows[r]!);
    if (!expanded) {
      return { ok: false, error: `Invalid FEN: malformed rank ${8 - r}` };
    }
    for (let f = 0; f < 8; f++) {
      const p = expanded[f]!;
      if (p === 'K') whiteKings++;
      if (p === 'k') blackKings++;
      if ((r === 0 || r === 7) && (p === 'P' || p === 'p')) {
        return { ok: false, error: 'Invalid FEN: pawns cannot be on rank 1 or 8' };
      }
    }
    grid.push(expanded);
  }

  if (whiteKings !== 1 || blackKings !== 1) {
    return { ok: false, error: 'Invalid FEN: must contain exactly one king per side' };
  }

  let isChess960 = false;
  if (castlingPart !== '-') {
    if (!/^[KQkqA-Ha-h]{1,4}$/.test(castlingPart)) {
      return { ok: false, error: 'Invalid FEN: invalid castling availability string' };
    }
    const seen = new Set<string>();
    for (const ch of castlingPart) {
      if (seen.has(ch)) {
        return { ok: false, error: 'Invalid FEN: duplicate castling right character' };
      }
      seen.add(ch);

      const isWhite = ch === ch.toUpperCase();
      const rankRow = isWhite ? grid[7]! : grid[0]!;
      const kingChar = isWhite ? 'K' : 'k';
      const rookChar = isWhite ? 'R' : 'r';
      const kingFile = rankRow.indexOf(kingChar);
      if (kingFile === -1) {
        return {
          ok: false,
          error: `Invalid FEN: castling right ${ch} specified but ${isWhite ? 'White' : 'Black'} king is not on back rank`,
        };
      }

      const upper = ch.toUpperCase();
      if (upper === 'K') {
        let foundRook = -1;
        for (let f = 7; f > kingFile; f--) {
          if (rankRow[f] === rookChar) {
            foundRook = f;
            break;
          }
        }
        if (foundRook === -1) {
          return {
            ok: false,
            error: `Invalid FEN: castling right ${ch} has no kingside rook on back rank`,
          };
        }
        if (kingFile !== 4 || foundRook !== 7) isChess960 = true;
      } else if (upper === 'Q') {
        let foundRook = -1;
        for (let f = 0; f < kingFile; f++) {
          if (rankRow[f] === rookChar) {
            foundRook = f;
            break;
          }
        }
        if (foundRook === -1) {
          return {
            ok: false,
            error: `Invalid FEN: castling right ${ch} has no queenside rook on back rank`,
          };
        }
        if (kingFile !== 4 || foundRook !== 0) isChess960 = true;
      } else {
        // Shredder-FEN A-H / a-h
        isChess960 = true;
        const rFile = fileIndex(upper);
        if (rankRow[rFile] !== rookChar) {
          return {
            ok: false,
            error: `Invalid FEN: Shredder-FEN castling right ${ch} has no rook on file ${upper.toLowerCase()}`,
          };
        }
      }
    }
  }

  // Verify the non-moving side is not already in check
  try {
    const sanitizedFen = [boardPart, turnPart, '-', '-', halfMovePart, fullMovePart].join(' ');
    const probe = new Chess(sanitizedFen);
    const activeTurn = turnPart as Color;
    const inactiveColor: Color = activeTurn === 'w' ? 'b' : 'w';
    const kingSquares = probe.findPiece({ type: 'k', color: inactiveColor });
    if (kingSquares[0] && probe.isAttacked(kingSquares[0], activeTurn)) {
      return {
        ok: false,
        error: 'Invalid FEN: side not to move is already in check',
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Invalid FEN',
    };
  }

  return { ok: true, isChess960 };
}

function parseCastlingConfig(
  boardPart: string,
  castlingPart: string,
  forceChess960 = false,
): Chess960CastlingState {
  const rows = boardPart.split('/');
  const whiteRow = expandFenRank(rows[7]!) ?? [];
  const blackRow = expandFenRank(rows[0]!) ?? [];

  const wKingFile = whiteRow.indexOf('K');
  const bKingFile = blackRow.indexOf('k');

  const state: Chess960CastlingState = {
    enabled: forceChess960,
    shredderNotation: false,
    order: 'kq',
    w: { kingFile: wKingFile >= 0 ? wKingFile : null, kSide: null, qSide: null },
    b: { kingFile: bKingFile >= 0 ? bKingFile : null, kSide: null, qSide: null },
  };

  if (castlingPart === '-') {
    return state;
  }

  let sawWhiteQBeforeK = false;
  let sawBlackQBeforeK = false;

  for (const ch of castlingPart) {
    const isWhite = ch === ch.toUpperCase();
    const row = isWhite ? whiteRow : blackRow;
    const sideState = isWhite ? state.w : state.b;
    const rookChar = isWhite ? 'R' : 'r';
    const kingFile = sideState.kingFile;
    if (kingFile === null || kingFile < 0) continue;

    const upper = ch.toUpperCase();
    if (upper === 'K') {
      for (let f = 7; f > kingFile; f--) {
        if (row[f] === rookChar) {
          sideState.kSide = { rookFile: f, symbol: ch };
          if (kingFile !== 4 || f !== 7) state.enabled = true;
          break;
        }
      }
    } else if (upper === 'Q') {
      for (let f = 0; f < kingFile; f++) {
        if (row[f] === rookChar) {
          sideState.qSide = { rookFile: f, symbol: ch };
          if (kingFile !== 4 || f !== 0) state.enabled = true;
          break;
        }
      }
    } else if (upper >= 'A' && upper <= 'H') {
      state.enabled = true;
      state.shredderNotation = true;
      const rFile = fileIndex(upper);
      if (row[rFile] === rookChar) {
        if (rFile > kingFile) {
          if (sideState.qSide) {
            if (isWhite) sawWhiteQBeforeK = true;
            else sawBlackQBeforeK = true;
          }
          sideState.kSide = { rookFile: rFile, symbol: ch };
        } else if (rFile < kingFile) {
          sideState.qSide = { rookFile: rFile, symbol: ch };
        }
      }
    }
  }

  if (sawWhiteQBeforeK || sawBlackQBeforeK) {
    state.order = 'alpha';
  }

  return state;
}

function serializeCastlingConfig(state: Chess960CastlingState): string {
  const formatSide = (side: SideCastlingState): string => {
    const kSym = side.kSide?.symbol ?? '';
    const qSym = side.qSide?.symbol ?? '';
    if (state.order === 'alpha' && kSym && qSym) {
      return kSym.toUpperCase() < qSym.toUpperCase() ? kSym + qSym : qSym + kSym;
    }
    return kSym + qSym;
  };
  const out = formatSide(state.w) + formatSide(state.b);
  return out || '-';
}

/**
 * Normalize a 4-field position key for threefold repetition tracking.
 */
function repetitionKey(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}

export class RulesAdapter {
  private chess: Chess;
  private c960: Chess960CastlingState;
  private historyStack: HistorySnapshot[] = [];
  private positionCounts = new Map<string, number>();

  constructor(fen: string = DEFAULT_POSITION, options?: { chess960?: boolean }) {
    this.chess = new Chess();
    this.c960 = {
      enabled: Boolean(options?.chess960),
      shredderNotation: false,
      order: 'kq',
      w: { kingFile: 4, kSide: null, qSide: null },
      b: { kingFile: 4, kSide: null, qSide: null },
    };
    this.load(fen, options);
  }

  /**
   * Load a standard or Chess960 FEN position.
   */
  public load(fen: string, options?: { chess960?: boolean }): void {
    let normalized = fen.trim();
    const parts = normalized.split(/\s+/);
    if (parts.length >= 2 && parts.length < 6) {
      const defaults = ['-', '-', '0', '1'];
      normalized = parts.concat(defaults.slice(-(6 - parts.length))).join(' ');
    }

    const validation = validateChessFen(normalized);
    if (!validation.ok) {
      throw new Error(validation.error ?? `Invalid FEN: ${fen}`);
    }

    const tokens = normalized.split(/\s+/) as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    this.c960 = parseCastlingConfig(
      tokens[0],
      tokens[2],
      Boolean(options?.chess960) || Boolean(validation.isChess960),
    );

    if (this.c960.enabled) {
      // Load into chess.js with '-' castling so chess.js does not reject Shredder-FEN
      // or misapply standard e1/e8 castling rules.
      const internalFen = [
        tokens[0],
        tokens[1],
        '-',
        tokens[3],
        tokens[4],
        tokens[5],
      ].join(' ');
      this.chess.load(internalFen);
    } else {
      this.chess.load(normalized);
    }

    this.historyStack = [];
    this.positionCounts.clear();
    this.incrementPositionCount(this.fen());
  }

  public reset(): void {
    this.load(DEFAULT_POSITION, { chess960: false });
  }

  public clone(): RulesAdapter {
    const copy = new RulesAdapter(this.fen(), { chess960: this.c960.enabled });
    copy.c960 = cloneC960State(this.c960);
    copy.positionCounts = new Map(this.positionCounts);
    return copy;
  }

  public isChess960(): boolean {
    return this.c960.enabled;
  }

  public fen(options?: { forceEnpassantSquare?: boolean }): string {
    const rawFen = this.chess.fen(options);
    if (!this.c960.enabled) {
      return rawFen;
    }
    const parts = rawFen.split(' ');
    parts[2] = serializeCastlingConfig(this.c960);
    return parts.join(' ');
  }

  public turn(): Color {
    return this.chess.turn();
  }

  public moveNumber(): number {
    return this.chess.moveNumber();
  }

  public halfMoves(): number {
    const parts = this.chess.fen().split(' ');
    return Number(parts[4] ?? 0);
  }

  public get(square: Square): Piece | undefined {
    return this.chess.get(square);
  }

  public board(): ({ square: Square; type: PieceSymbol; color: Color } | null)[][] {
    return this.chess.board();
  }

  public inCheck(): boolean {
    return this.chess.inCheck();
  }

  public isCheck(): boolean {
    return this.chess.isCheck();
  }

  public isAttacked(square: Square, attackedBy: Color): boolean {
    return this.chess.isAttacked(square, attackedBy);
  }

  public attackers(square: Square, attackedBy?: Color): Square[] {
    return this.chess.attackers(square, attackedBy);
  }

  // In standard chess, chess.js answers these with its internal move generator. The
  // verbose path also builds SAN for every move, which costs extra make/undo work per
  // move. Chess960 still goes through verboseMoves(), since it adds the castling moves
  // chess.js doesn't know about.
  public isCheckmate(): boolean {
    if (!this.c960.enabled) return this.chess.isCheckmate();
    return this.inCheck() && this.verboseMoves().length === 0;
  }

  public isStalemate(): boolean {
    if (!this.c960.enabled) return this.chess.isStalemate();
    return !this.inCheck() && this.verboseMoves().length === 0;
  }

  public isInsufficientMaterial(): boolean {
    return this.chess.isInsufficientMaterial();
  }

  public isDrawByFiftyMoves(): boolean {
    return this.chess.isDrawByFiftyMoves();
  }

  public isThreefoldRepetition(): boolean {
    if (!this.c960.enabled && this.chess.isThreefoldRepetition()) {
      return true;
    }
    const key = repetitionKey(this.fen());
    return (this.positionCounts.get(key) ?? 0) >= 3;
  }

  public isDraw(): boolean {
    return (
      this.isDrawByFiftyMoves() ||
      this.isStalemate() ||
      this.isInsufficientMaterial() ||
      this.isThreefoldRepetition()
    );
  }

  public isGameOver(): boolean {
    return this.isCheckmate() || this.isDraw();
  }

  /**
   * All legal moves as SAN strings. In standard chess this skips building verbose move
   * objects (chess.js serializes two FENs per verbose move), which makes it several
   * times cheaper than verboseMoves() for scanning many positions.
   */
  public sanMoves(): string[] {
    if (!this.c960.enabled) return this.chess.moves();
    return this.verboseMoves().map((m) => m.san);
  }

  /**
   * Returns all legal SAN moves in the current position.
   */
  public moves(options?: { square?: Square; piece?: PieceSymbol }): string[] {
    return this.verboseMoves(options).map((m) => m.san);
  }

  /**
   * Returns all legal verbose moves in the current position, including Chess960 castling.
   */
  public verboseMoves(options?: {
    square?: Square;
    piece?: PieceSymbol;
  }): ExecutedMove[] {
    const currentFen = this.fen();
    const rawMoves = this.chess.moves({
      verbose: true,
      square: options?.square,
      piece: options?.piece,
    });

    const result: ExecutedMove[] = rawMoves.map((m) => this.mapChessJsMove(m, currentFen));

    if (this.c960.enabled) {
      const us = this.turn();
      const rankChar = us === 'w' ? '1' : '8';
      const sideState = this.c960[us];
      if (sideState.kingFile !== null) {
        const kingSq = `${fileCharFromIndex(sideState.kingFile)}${rankChar}` as Square;
        const includeKing =
          (!options?.square || options.square === kingSq) &&
          (!options?.piece || options.piece === 'k');
        if (includeKing) {
          const kCastle = this.buildChess960CastleMove(us, 'k', currentFen);
          if (kCastle) result.push(kCastle);
          const qCastle = this.buildChess960CastleMove(us, 'q', currentFen);
          if (qCastle) result.push(qCastle);
        }
      }
    }

    return result;
  }

  /**
   * Execute a move given in SAN (including real-world PGN variants), UCI, MoveInput, or null move.
   */
  public move(moveInput: string | MoveInput | null): ExecutedMove {
    const fenBefore = this.fen();
    const chessFenBefore = this.chess.fen({ forceEnpassantSquare: true });
    const c960Before = cloneC960State(this.c960);
    const positionCountsBefore = new Map(this.positionCounts);

    // 1. Handle null moves ('--', 'Z0', '0000', null)
    if (
      moveInput === null ||
      (typeof moveInput === 'string' &&
        /^(?:--|Z0|0000)$/i.test(moveInput.trim()))
    ) {
      if (this.inCheck()) {
        throw new Error('Null move not allowed when in check');
      }
      const us = this.turn();
      const rawMove = this.chess.move('--');
      const kingSq =
        this.chess.findPiece({ type: 'k', color: us })[0] ??
        (us === 'w' ? 'e1' : 'e8');
      const fenAfter = this.fen();
      const executed: ExecutedMove = {
        color: us,
        from: kingSq,
        to: kingSq,
        piece: 'k',
        san: '--',
        uci: '0000',
        before: fenBefore,
        after: fenAfter,
        isCastle: false,
        isKingsideCastle: false,
        isQueensideCastle: false,
        isEnPassant: false,
        isPromotion: false,
        isCapture: false,
        isNullMove: true,
      };
      void rawMove;
      this.historyStack.push({
        fenBefore,
        chessFenBefore,
        c960Before,
        positionCountsBefore,
        executedMove: executed,
      });
      this.incrementPositionCount(fenAfter);
      return executed;
    }

    // 2. Handle Chess960 castling if in Chess960 mode
    if (this.c960.enabled) {
      const c960Castle = this.matchChess960CastleInput(moveInput, fenBefore);
      if (c960Castle) {
        this.applyChess960CastleState(c960Castle);
        const fenAfter = this.fen();
        c960Castle.after = fenAfter;
        this.historyStack.push({
          fenBefore,
          chessFenBefore,
          c960Before,
          positionCountsBefore,
          executedMove: c960Castle,
        });
        this.incrementPositionCount(fenAfter);
        return c960Castle;
      }
    }

    // 3. Execute standard or permissive move
    let rawMove: Move | null = null;
    if (typeof moveInput === 'string') {
      const cleaned = this.normalizeSanInput(moveInput);
      try {
        rawMove = this.chess.move(cleaned, { strict: false });
      } catch {
        rawMove = null;
      }
      if (!rawMove) {
        const fallback = this.resolvePermissiveSan(cleaned);
        if (fallback) {
          rawMove = this.chess.move({
            from: fallback.from,
            to: fallback.to,
            promotion: fallback.promotion,
          });
        }
      }
    } else {
      try {
        rawMove = this.chess.move({
          from: moveInput.from.toLowerCase(),
          to: moveInput.to.toLowerCase(),
          promotion: moveInput.promotion?.toLowerCase(),
        });
      } catch {
        rawMove = null;
      }
    }

    if (!rawMove) {
      throw new Error(
        `Illegal move: ${typeof moveInput === 'string' ? moveInput : JSON.stringify(moveInput)} in position ${fenBefore}`,
      );
    }

    if (this.c960.enabled) {
      this.updateC960RightsAfterRegularMove(rawMove);
    }

    const executed = this.mapChessJsMove(rawMove, fenBefore, this.c960);
    this.historyStack.push({
      fenBefore,
      chessFenBefore,
      c960Before,
      positionCountsBefore,
      executedMove: executed,
    });
    this.incrementPositionCount(executed.after);
    return executed;
  }

  /**
   * Undo the most recent move and restore exact board and castling state.
   */
  public undo(): ExecutedMove | null {
    const snapshot = this.historyStack.pop();
    if (!snapshot) {
      const undone = this.chess.undo();
      if (!undone) return null;
      return this.mapChessJsMove(undone, this.fen(), this.c960);
    }

    this.c960 = snapshot.c960Before;
    this.positionCounts = snapshot.positionCountsBefore;
    if (this.c960.enabled || snapshot.executedMove.isCastle) {
      this.chess.load(snapshot.chessFenBefore);
    } else {
      const undone = this.chess.undo();
      if (!undone) {
        this.chess.load(snapshot.chessFenBefore);
      }
    }
    return snapshot.executedMove;
  }

  /**
   * Standard perft node count at `depth`.
   */
  public perft(depth: number): number {
    if (depth <= 0) return 1;
    if (
      !this.c960.enabled ||
      (!this.c960.w.kSide &&
        !this.c960.w.qSide &&
        !this.c960.b.kSide &&
        !this.c960.b.qSide)
    ) {
      return this.chess.perft(depth);
    }

    const us = this.turn();
    if (depth === 1) {
      let count = this.chess.perft(1);
      if (this.c960[us].kingFile !== null) {
        if (this.canChess960Castle(us, 'k')) count++;
        if (this.canChess960Castle(us, 'q')) count++;
      }
      return count;
    }

    let nodes = 0;
    const rawMoves = this.chess.moves({ verbose: true });
    for (const m of rawMoves) {
      const prevC960 = cloneC960State(this.c960);
      this.chess.move({ from: m.from, to: m.to, promotion: m.promotion });
      this.updateC960RightsAfterRegularMove(m);
      nodes += this.perft(depth - 1);
      this.chess.undo();
      this.c960 = prevC960;
    }

    if (this.c960[us].kingFile !== null) {
      for (const side of ['k', 'q'] as const) {
        if (this.canChess960Castle(us, side)) {
          const rankChar = us === 'w' ? '1' : '8';
          const right = side === 'k' ? this.c960[us].kSide! : this.c960[us].qSide!;
          const kingFromSq = `${fileCharFromIndex(this.c960[us].kingFile!)}${rankChar}` as Square;
          const rookFromSq = `${fileCharFromIndex(right.rookFile)}${rankChar}` as Square;
          const kingToSq = (side === 'k' ? `g${rankChar}` : `c${rankChar}`) as Square;
          const rookToSq = (side === 'k' ? `f${rankChar}` : `d${rankChar}`) as Square;
          const nextInternalFen = this.computePostCastleInternalFen(
            us,
            kingFromSq,
            rookFromSq,
            kingToSq,
            rookToSq,
          );
          const childState = cloneC960State(this.c960);
          childState[us].kingFile = null;
          childState[us].kSide = null;
          childState[us].qSide = null;
          const parts = nextInternalFen.split(' ');
          parts[2] = serializeCastlingConfig(childState);
          const child = new RulesAdapter(parts.join(' '), { chess960: true });
          child.c960 = childState;
          nodes += child.perft(depth - 1);
        }
      }
    }

    return nodes;
  }

  private incrementPositionCount(fen: string): void {
    const key = repetitionKey(fen);
    this.positionCounts.set(key, (this.positionCounts.get(key) ?? 0) + 1);
  }

  private mapChessJsMove(
    m: Move,
    fenBefore: string,
    c960StateAfter?: Chess960CastlingState,
  ): ExecutedMove {
    const isKingsideCastle = m.isKingsideCastle();
    const isQueensideCastle = m.isQueensideCastle();
    const isCastle = isKingsideCastle || isQueensideCastle;
    const isEnPassant = m.isEnPassant();
    const isPromotion = m.isPromotion();
    const isCapture = m.isCapture() || isEnPassant;
    const uci = `${m.from}${m.to}${m.promotion ?? ''}`;
    let fenAfter = m.after;
    if (this.c960.enabled) {
      const nextState =
        c960StateAfter ?? this.computeC960StateAfterRegularMove(this.c960, m);
      const parts = m.after.split(' ');
      parts[2] = serializeCastlingConfig(nextState);
      fenAfter = parts.join(' ');
    }

    return {
      color: m.color,
      from: m.from,
      to: m.to,
      piece: m.piece,
      captured: m.captured,
      promotion: m.promotion,
      san: m.san,
      uci,
      before: fenBefore,
      after: fenAfter,
      isCastle,
      isKingsideCastle,
      isQueensideCastle,
      isEnPassant,
      isPromotion,
      isCapture,
      isNullMove: m.san === '--',
    };
  }

  private canChess960Castle(us: Color, side: 'k' | 'q'): boolean {
    const sideState = this.c960[us];
    const right = side === 'k' ? sideState.kSide : sideState.qSide;
    if (!right || sideState.kingFile === null) return false;

    const rankChar = us === 'w' ? '1' : '8';
    const kingFromFile = sideState.kingFile;
    const rookFromFile = right.rookFile;
    const kingToFile = side === 'k' ? 6 : 2; // g-file (6) or c-file (2)
    const rookToFile = side === 'k' ? 5 : 3; // f-file (5) or d-file (3)

    const kingFromSq = `${fileCharFromIndex(kingFromFile)}${rankChar}` as Square;
    const rookFromSq = `${fileCharFromIndex(rookFromFile)}${rankChar}` as Square;

    const kingPiece = this.chess.get(kingFromSq);
    const rookPiece = this.chess.get(rookFromSq);
    if (
      !kingPiece ||
      kingPiece.color !== us ||
      kingPiece.type !== 'k' ||
      !rookPiece ||
      rookPiece.color !== us ||
      rookPiece.type !== 'r'
    ) {
      return false;
    }

    if (this.chess.inCheck()) {
      return false;
    }

    // 1. Check all squares between kingFrom..kingTo and rookFrom..rookTo are vacant
    //    (ignoring kingFrom and rookFrom themselves).
    const minKing = Math.min(kingFromFile, kingToFile);
    const maxKing = Math.max(kingFromFile, kingToFile);
    for (let f = minKing; f <= maxKing; f++) {
      if (f === kingFromFile || f === rookFromFile) continue;
      const sq = `${fileCharFromIndex(f)}${rankChar}` as Square;
      if (this.chess.get(sq)) return false;
    }

    const minRook = Math.min(rookFromFile, rookToFile);
    const maxRook = Math.max(rookFromFile, rookToFile);
    for (let f = minRook; f <= maxRook; f++) {
      if (f === kingFromFile || f === rookFromFile) continue;
      const sq = `${fileCharFromIndex(f)}${rankChar}` as Square;
      if (this.chess.get(sq)) return false;
    }

    // 2. Check no square along the king's path is attacked by the opponent.
    const them: Color = us === 'w' ? 'b' : 'w';
    for (let f = minKing; f <= maxKing; f++) {
      const sq = `${fileCharFromIndex(f)}${rankChar}` as Square;
      if (this.chess.isAttacked(sq, them)) return false;
    }

    // 3. Check that moving kingFrom/rookFrom to kingTo/rookTo does not expose kingToFile
    //    to a horizontal rank attack (e.g. when the castling rook shielded the king along the rank).
    for (const step of [-1, 1] as const) {
      for (let f = kingToFile + step; f >= 0 && f <= 7; f += step) {
        if (f === rookToFile) break; // Our castling rook occupies rookToFile after castling
        if (f === kingFromFile || f === rookFromFile) continue; // Vacated by castling
        const sq = `${fileCharFromIndex(f)}${rankChar}` as Square;
        const piece = this.chess.get(sq);
        if (piece) {
          if (piece.color === them && (piece.type === 'r' || piece.type === 'q')) {
            return false;
          }
          break;
        }
      }
    }

    return true;
  }

  private buildChess960CastleMove(
    us: Color,
    side: 'k' | 'q',
    fenBefore: string,
  ): ExecutedMove | null {
    if (!this.canChess960Castle(us, side)) {
      return null;
    }

    const sideState = this.c960[us];
    const right = (side === 'k' ? sideState.kSide : sideState.qSide)!;
    const rankChar = us === 'w' ? '1' : '8';
    const kingFromFile = sideState.kingFile!;
    const rookFromFile = right.rookFile;
    const kingToFile = side === 'k' ? 6 : 2;
    const rookToFile = side === 'k' ? 5 : 3;

    const kingFromSq = `${fileCharFromIndex(kingFromFile)}${rankChar}` as Square;
    const rookFromSq = `${fileCharFromIndex(rookFromFile)}${rankChar}` as Square;
    const kingToSq = `${fileCharFromIndex(kingToFile)}${rankChar}` as Square;
    const rookToSq = `${fileCharFromIndex(rookToFile)}${rankChar}` as Square;

    const simFenAfter = this.computePostCastleInternalFen(
      us,
      kingFromSq,
      rookFromSq,
      kingToSq,
      rookToSq,
    );
    const simChess = new Chess(simFenAfter);

    const simState = cloneC960State(this.c960);
    simState[us].kingFile = null;
    simState[us].kSide = null;
    simState[us].qSide = null;
    const publicFenAfter = (() => {
      const parts = simFenAfter.split(' ');
      parts[2] = serializeCastlingConfig(simState);
      return parts.join(' ');
    })();

    let baseSan = side === 'k' ? 'O-O' : 'O-O-O';
    if (simChess.inCheck()) {
      const simAdapter = new RulesAdapter(publicFenAfter, { chess960: true });
      simAdapter.c960 = simState;
      baseSan += simAdapter.isCheckmate() ? '#' : '+';
    }

    return {
      color: us,
      from: kingFromSq,
      to: kingToSq,
      piece: 'k',
      san: baseSan,
      uci: `${kingFromSq}${rookFromSq}`,
      before: fenBefore,
      after: publicFenAfter,
      isCastle: true,
      isKingsideCastle: side === 'k',
      isQueensideCastle: side === 'q',
      isEnPassant: false,
      isPromotion: false,
      isCapture: false,
      isNullMove: false,
    };
  }

  private computePostCastleInternalFen(
    us: Color,
    kingFromSq: Square,
    rookFromSq: Square,
    kingToSq: Square,
    rookToSq: Square,
  ): string {
    const temp = new Chess(this.chess.fen());
    temp.remove(kingFromSq);
    temp.remove(rookFromSq);
    temp.put({ type: 'k', color: us }, kingToSq);
    temp.put({ type: 'r', color: us }, rookToSq);

    const parts = temp.fen().split(' ');
    const origParts = this.chess.fen().split(' ');
    const them: Color = us === 'w' ? 'b' : 'w';
    const nextHalfMoves = Number(origParts[4] ?? 0) + 1;
    const nextFullMoves = Number(origParts[5] ?? 1) + (us === 'b' ? 1 : 0);

    return [
      parts[0],
      them,
      '-',
      '-',
      String(nextHalfMoves),
      String(nextFullMoves),
    ].join(' ');
  }

  private matchChess960CastleInput(
    moveInput: string | MoveInput,
    fenBefore: string,
  ): ExecutedMove | null {
    const us = this.turn();
    const sideState = this.c960[us];
    if (sideState.kingFile === null) return null;

    if (typeof moveInput === 'string') {
      const clean = this.normalizeSanInput(moveInput)
        .replace(/[+#!?]+$/g, '')
        .trim();
      if (clean === 'O-O') {
        return this.buildChess960CastleMove(us, 'k', fenBefore);
      }
      if (clean === 'O-O-O') {
        return this.buildChess960CastleMove(us, 'q', fenBefore);
      }
      // Also support UCI king-to-rook or 2+ square king-to-target string if passed as string
      if (/^[a-h][18][a-h][18]$/.test(clean)) {
        return this.matchChess960CastleInput(
          { from: clean.slice(0, 2), to: clean.slice(2, 4) },
          fenBefore,
        );
      }
      return null;
    }

    const rankChar = us === 'w' ? '1' : '8';
    const kingFromSq = `${fileCharFromIndex(sideState.kingFile)}${rankChar}`;
    const from = moveInput.from.toLowerCase();
    const to = moveInput.to.toLowerCase();
    if (from !== kingFromSq) return null;

    if (sideState.kSide) {
      const kRookSq = `${fileCharFromIndex(sideState.kSide.rookFile)}${rankChar}`;
      if (
        to === kRookSq ||
        (to === `g${rankChar}` && Math.abs(6 - sideState.kingFile) > 1)
      ) {
        return this.buildChess960CastleMove(us, 'k', fenBefore);
      }
    }
    if (sideState.qSide) {
      const qRookSq = `${fileCharFromIndex(sideState.qSide.rookFile)}${rankChar}`;
      if (
        to === qRookSq ||
        (to === `c${rankChar}` && Math.abs(2 - sideState.kingFile) > 1)
      ) {
        return this.buildChess960CastleMove(us, 'q', fenBefore);
      }
    }
    return null;
  }

  private applyChess960CastleState(castleMove: ExecutedMove): void {
    const us = castleMove.color;
    const rankChar = us === 'w' ? '1' : '8';
    const sideState = this.c960[us];
    const right = castleMove.isKingsideCastle ? sideState.kSide : sideState.qSide;
    if (!right || sideState.kingFile === null) {
      throw new Error('Invalid Chess960 castling state');
    }

    const kingFromSq = `${fileCharFromIndex(sideState.kingFile)}${rankChar}` as Square;
    const rookFromSq = `${fileCharFromIndex(right.rookFile)}${rankChar}` as Square;
    const kingToSq = (castleMove.isKingsideCastle ? `g${rankChar}` : `c${rankChar}`) as Square;
    const rookToSq = (castleMove.isKingsideCastle ? `f${rankChar}` : `d${rankChar}`) as Square;

    const nextInternalFen = this.computePostCastleInternalFen(
      us,
      kingFromSq,
      rookFromSq,
      kingToSq,
      rookToSq,
    );
    sideState.kingFile = null;
    sideState.kSide = null;
    sideState.qSide = null;
    this.chess.load(nextInternalFen);
  }

  private computeC960StateAfterRegularMove(
    current: Chess960CastlingState,
    m: Move,
  ): Chess960CastlingState {
    const next = cloneC960State(current);
    const us = m.color;
    const them: Color = us === 'w' ? 'b' : 'w';
    const usRank = us === 'w' ? '1' : '8';
    const themRank = them === 'w' ? '1' : '8';

    if (m.piece === 'k') {
      next[us].kingFile = null;
      next[us].kSide = null;
      next[us].qSide = null;
    }

    if (m.piece === 'r' && m.from[1] === usRank) {
      const fromFile = fileIndex(m.from[0]!);
      if (next[us].kSide?.rookFile === fromFile) {
        next[us].kSide = null;
      }
      if (next[us].qSide?.rookFile === fromFile) {
        next[us].qSide = null;
      }
    }

    if (m.captured === 'r' && m.to[1] === themRank) {
      const toFile = fileIndex(m.to[0]!);
      if (next[them].kSide?.rookFile === toFile) {
        next[them].kSide = null;
      }
      if (next[them].qSide?.rookFile === toFile) {
        next[them].qSide = null;
      }
    }

    return next;
  }

  private updateC960RightsAfterRegularMove(m: Move): void {
    this.c960 = this.computeC960StateAfterRegularMove(this.c960, m);
  }


  /**
   * Normalizes real-world PGN SAN quirks before passing to chess.js.
   */
  private normalizeSanInput(raw: string): string {
    let s = raw.trim();
    // Strip trailing e.p. / ep
    s = s.replace(/\s*e\.?p\.?$/i, '');
    // Strip move evaluation suffixes (!, ?, !!, ??, !?, ?!)
    s = s.replace(/[?!]+$/g, '');
    // Normalize zero-castling 0-0-0 / 0-0
    if (/^(?:0-0-0|O-O-O|o-o-o)([+#])?$/.test(s)) {
      const checkSuffix = s.match(/([+#])$/)?.[1] ?? '';
      return `O-O-O${checkSuffix}`;
    }
    if (/^(?:0-0|O-O|o-o)([+#])?$/.test(s)) {
      const checkSuffix = s.match(/([+#])$/)?.[1] ?? '';
      return `O-O${checkSuffix}`;
    }
    // Normalize parenthesized promotion e8(Q)+ or e8=q+ or e8Q+
    s = s.replace(/\(([qrbnQRBN])\)/g, (_, p: string) => `=${p.toUpperCase()}`);
    s = s.replace(/=([qrbn])/g, (_, p: string) => `=${p.toUpperCase()}`);
    s = s.replace(
      /^([a-h](?:[x:][a-h])?[18])([QRBNqrbn])([+#]?)$/,
      (_, prefix: string, promo: string, chk: string) =>
        `${prefix}=${promo.toUpperCase()}${chk}`,
    );
    // Normalize ':' capture separator to 'x'
    s = s.replace(/:/g, 'x');
    return s;
  }

  /**
   * Resolves over-disambiguated or legacy SAN moves (e.g. Nge7 when c6 knight is pinned,
   * full-square disambiguation Ng1f3, Qh4xe1, e2-e4, or abbreviated pawn captures ed5 / ef).
   */
  private resolvePermissiveSan(cleanedSan: string): ExecutedMove | null {
    const core = cleanedSan.replace(/[+#?!]+$/g, '').trim();
    const legal = this.verboseMoves();

    // 1. Check UCI / LAN format: e2e4, e7e8q
    const uciMatch = core.match(/^([a-h][1-8])-?([a-h][1-8])=?([qrbnQRBN])?$/);
    if (uciMatch) {
      const [, from, to, promo] = uciMatch;
      const pLower = promo?.toLowerCase();
      const hit = legal.find(
        (m) =>
          m.from === from &&
          m.to === to &&
          (!pLower || m.promotion === pLower),
      );
      if (hit) return hit;
    }

    // 2. General piece/pawn move with optional file and/or rank disambiguation:
    //    e.g. Nge7, Ng1f3, Qh4xe1, R1a3, e4xd5, exd8=Q
    const sanMatch = core.match(
      /^([PNBRQK])?([a-h])?([1-8])?[x-]?([a-h][1-8])(?:=([QRBN]))?$/,
    );
    if (sanMatch) {
      const [, pieceUpper, fromFile, fromRank, targetSq, promoUpper] = sanMatch;
      const pieceType = (pieceUpper ? pieceUpper.toLowerCase() : 'p') as PieceSymbol;
      const promoType = promoUpper?.toLowerCase() as PieceSymbol | undefined;

      const candidates = legal.filter((m) => {
        if (m.piece !== pieceType) return false;
        if (m.to !== targetSq) return false;
        if (fromFile && m.from[0] !== fromFile) return false;
        if (fromRank && m.from[1] !== fromRank) return false;
        if (promoType && m.promotion !== promoType) return false;
        if (!promoType && m.promotion && m.promotion !== 'q') return false;
        return true;
      });

      if (candidates.length === 1) {
        return candidates[0]!;
      }
    }

    // 3. Abbreviated pawn capture: e.g. "ed" or "ef" when unique
    const shortPawnCapture = core.match(/^([a-h])x?([a-h])$/);
    if (shortPawnCapture) {
      const [, fFrom, fTo] = shortPawnCapture;
      const candidates = legal.filter(
        (m) =>
          m.piece === 'p' &&
          m.isCapture &&
          m.from[0] === fFrom &&
          m.to[0] === fTo &&
          (!m.promotion || m.promotion === 'q'),
      );
      if (candidates.length === 1) {
        return candidates[0]!;
      }
    }

    return null;
  }
}
