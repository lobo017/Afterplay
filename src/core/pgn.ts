import { DEFAULT_POSITION, type Square } from './rules';
import {
  GameTree,
  resolveNagCode,
  type AnnotationColor,
  type GameNode,
  type GameTermination,
  type PgnArrowAnnotation,
  type PgnEvalAnnotation,
  type PgnHighlightAnnotation,
} from './game-tree';

export interface WritePgnOptions {
  /** Include PGN header tag pairs (default: true when headers exist or non-default FEN). */
  includeHeaders?: boolean;
  /** Emit human move suffixes (!, ?, !!, ??, !?, ?!) for NAGs 1..6 instead of $1..$6 (default: false). */
  symbolicMoveSuffixes?: boolean;
}

type TokenType = 'HEADER' | 'COMMENT' | 'LPAREN' | 'RPAREN' | 'NAG' | 'MOVE_NUMBER' | 'RESULT' | 'SAN';

interface PgnToken {
  type: TokenType;
  value: string;
  headerKey?: string;
  headerVal?: string;
  nagCode?: number;
}

const SEVEN_TAG_ORDER = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'] as const;

const SUFFIX_SORT_ORDER: Record<number, string> = {
  1: '!',
  2: '?',
  3: '!!',
  4: '??',
  5: '!?',
  6: '?!',
};

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\v';
}

function isTokenBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return (
    isWhitespace(ch) || ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === ';' || ch === '[' || ch === '$'
  );
}

/**
 * Tokenize a single or multi-game PGN string using an explicit character state machine.
 */
function tokenizePgn(input: string): PgnToken[] {
  const tokens: PgnToken[] = [];
  const len = input.length;
  let i = 0;
  let atLineStart = true;

  while (i < len) {
    const ch = input[i]!;

    // PGN Spec Section 6: '%' at column 0 escapes the entire line
    if (atLineStart && ch === '%') {
      while (i < len && input[i] !== '\n') {
        i++;
      }
      if (i < len && input[i] === '\n') {
        i++;
      }
      atLineStart = true;
      continue;
    }

    // Whitespace
    if (isWhitespace(ch)) {
      if (ch === '\n') {
        atLineStart = true;
      }
      i++;
      continue;
    }

    atLineStart = false;

    // Brace comment `{ ... }`
    if (ch === '{') {
      i++; // skip '{'
      let raw = '';
      while (i < len && input[i] !== '}') {
        raw += input[i]!;
        i++;
      }
      if (i < len && input[i] === '}') {
        i++; // skip '}'
      }
      tokens.push({
        type: 'COMMENT',
        value: raw.replace(/[\r\n]+/g, ' ').trim(),
      });
      continue;
    }

    // Semicolon rest-of-line comment `; ...`
    if (ch === ';') {
      i++; // skip ';'
      let raw = '';
      while (i < len && input[i] !== '\r' && input[i] !== '\n') {
        raw += input[i]!;
        i++;
      }
      tokens.push({
        type: 'COMMENT',
        value: raw.trim(),
      });
      continue;
    }

    // Variation delimiters
    if (ch === '(') {
      tokens.push({ type: 'LPAREN', value: '(' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'RPAREN', value: ')' });
      i++;
      continue;
    }

    // Header tag pair `[TagName "TagValue"]`
    if (ch === '[') {
      const header = tryReadHeaderTag(input, i);
      if (header) {
        tokens.push({
          type: 'HEADER',
          value: header.raw,
          headerKey: header.key,
          headerVal: header.val,
        });
        i = header.nextIndex;
        continue;
      }
    }

    // Numeric Annotation Glyph `$123`
    if (ch === '$' && i + 1 < len && /^\d/.test(input[i + 1]!)) {
      i++; // skip '$'
      let numStr = '';
      while (i < len && /^\d/.test(input[i]!)) {
        numStr += input[i]!;
        i++;
      }
      tokens.push({
        type: 'NAG',
        value: `$${numStr}`,
        nagCode: Number(numStr),
      });
      continue;
    }

    // Check game termination markers ('1/2-1/2', '1-0', '0-1', '*') before move numbers/castling
    if (input.startsWith('1/2-1/2', i) && isTokenBoundary(input[i + 7])) {
      tokens.push({ type: 'RESULT', value: '1/2-1/2' });
      i += 7;
      continue;
    }
    if ((input.startsWith('1-0', i) || input.startsWith('0-1', i)) && isTokenBoundary(input[i + 3])) {
      const res = input.slice(i, i + 3);
      tokens.push({ type: 'RESULT', value: res });
      i += 3;
      continue;
    }
    if (ch === '*' && isTokenBoundary(input[i + 1])) {
      tokens.push({ type: 'RESULT', value: '*' });
      i++;
      continue;
    }

    // Zero-castling '0-0-0' or '0-0' (with optional check/eval suffixes like 0-0+!)
    if (input.startsWith('0-0-0', i) || input.startsWith('0-0', i)) {
      let sanCast = '';
      while (i < len && !isTokenBoundary(input[i])) {
        sanCast += input[i]!;
        i++;
      }
      tokens.push({ type: 'SAN', value: sanCast });
      continue;
    }

    // Standalone ellipsis `...`
    if (ch === '.') {
      let dots = '';
      while (i < len && (input[i] === '.' || input[i] === ' ')) {
        if (input[i] === '.') dots += '.';
        i++;
      }
      tokens.push({ type: 'MOVE_NUMBER', value: dots });
      continue;
    }

    // Move number: digits followed by optional whitespace and dots (e.g. `1.`, `1...`, `12.e4`, `1 . . .`)
    if (ch >= '0' && ch <= '9') {
      let numToken = '';
      while (i < len && input[i]! >= '0' && input[i]! <= '9') {
        numToken += input[i]!;
        i++;
      }
      // Consume any dots (including spaced dots like `1 . . .`)
      let cursor = i;
      let consumedDots = false;
      while (cursor < len) {
        if (input[cursor] === '.') {
          numToken += '.';
          consumedDots = true;
          cursor++;
        } else if ((input[cursor] === ' ' || input[cursor] === '\t') && cursor + 1 < len && input[cursor + 1] === '.') {
          cursor++;
        } else {
          break;
        }
      }
      if (consumedDots || isTokenBoundary(input[cursor])) {
        i = cursor;
        tokens.push({ type: 'MOVE_NUMBER', value: numToken });
        continue;
      }
    }

    // Otherwise read a SAN or annotation symbol token until a boundary character
    // Note: allow parenthesized promotion like `e8(Q)+` without splitting on `(` / `)`.
    let sanToken = '';
    while (i < len) {
      const c = input[i]!;
      if (c === '(' && /^\([qrbnQRBN]\)/.test(input.slice(i, i + 3))) {
        sanToken += input.slice(i, i + 3);
        i += 3;
        continue;
      }
      if (isTokenBoundary(c)) {
        break;
      }
      sanToken += c;
      i++;
    }

    if (!sanToken) {
      i++;
      continue;
    }

    // Check if the token is a standalone annotation symbol (e.g. `!`, `?!`, `±`, `+=`, `N`)
    const standaloneNag = resolveNagCode(sanToken);
    if (standaloneNag !== null && /^(?:[?!]{1,2}|[±∓∞=□N]|\+=|=\+|\+-|-\+|=\/∞|⨀|↑|→|⇆)$/.test(sanToken)) {
      tokens.push({
        type: 'NAG',
        value: sanToken,
        nagCode: standaloneNag,
      });
      continue;
    }

    tokens.push({ type: 'SAN', value: sanToken });
  }

  return tokens;
}

function tryReadHeaderTag(
  input: string,
  startIdx: number,
): { key: string; val: string; raw: string; nextIndex: number } | null {
  const len = input.length;
  let i = startIdx + 1; // after '['

  while (i < len && isWhitespace(input[i]!)) i++;

  let key = '';
  while (i < len && /^[A-Za-z0-9_-]$/.test(input[i]!)) {
    key += input[i]!;
    i++;
  }
  if (!key) return null;

  while (i < len && isWhitespace(input[i]!)) i++;
  if (i >= len || input[i] !== '"') return null;
  i++; // skip opening '"'

  let val = '';
  let closedQuote = false;
  while (i < len) {
    const ch = input[i]!;
    if (ch === '\\' && i + 1 < len) {
      const next = input[i + 1]!;
      if (next === '"' || next === '\\') {
        val += next;
        i += 2;
        continue;
      }
    }
    if (ch === '"') {
      closedQuote = true;
      i++;
      break;
    }
    val += ch;
    i++;
  }
  if (!closedQuote) return null;

  while (i < len && isWhitespace(input[i]!)) i++;
  if (i >= len || input[i] !== ']') return null;
  i++; // skip ']'

  return {
    key,
    val,
    raw: input.slice(startIdx, i),
    nextIndex: i,
  };
}

/**
 * Extract `[%eval ...]`, `[%cal ...]`, and `[%csl ...]` tags from a comment string,
 * returning the parsed structured annotations and the cleaned human comment text.
 */
export function parseCommentAnnotations(rawComment: string): {
  text: string;
  eval?: PgnEvalAnnotation;
  arrows: PgnArrowAnnotation[];
  highlights: PgnHighlightAnnotation[];
} {
  let evalAnnotation: PgnEvalAnnotation | undefined;
  const arrows: PgnArrowAnnotation[] = [];
  const highlights: PgnHighlightAnnotation[] = [];

  let cleaned = rawComment;

  // 1. Extract [%eval ...]
  cleaned = cleaned.replace(/\[%eval\s+([^\]]+)\]/gi, (_, inner: string) => {
    const parts = inner.trim().split(',');
    const scorePart = (parts[0] ?? '').trim();
    const depthPart = parts[1]?.trim();
    const depth = depthPart && /^\d+$/.test(depthPart) ? Number(depthPart) : undefined;

    if (scorePart.startsWith('#')) {
      const mateVal = Number(scorePart.slice(1));
      if (!Number.isNaN(mateVal)) {
        evalAnnotation = {
          mate: Object.is(mateVal, -0) ? 0 : mateVal,
          ...(depth !== undefined ? { depth } : {}),
        };
      }
    } else {
      const floatVal = Number(scorePart);
      if (!Number.isNaN(floatVal)) {
        const cp = Math.round(floatVal * 100);
        evalAnnotation = {
          cp: Object.is(cp, -0) ? 0 : cp,
          ...(depth !== undefined ? { depth } : {}),
        };
      }
    }
    return '';
  });

  // 2. Extract [%cal ...]
  cleaned = cleaned.replace(/\[%cal\s+([^\]]+)\]/gi, (_, inner: string) => {
    const items = inner
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const item of items) {
      const match = item.match(/^([GRYB])([a-h][1-8])([a-h][1-8])$/i);
      if (match) {
        const color = match[1]!.toUpperCase() as AnnotationColor;
        const from = match[2]!.toLowerCase() as Square;
        const to = match[3]!.toLowerCase() as Square;
        if (!arrows.some((a) => a.color === color && a.from === from && a.to === to)) {
          arrows.push({ color, from, to });
        }
      }
    }
    return '';
  });

  // 3. Extract [%csl ...]
  cleaned = cleaned.replace(/\[%csl\s+([^\]]+)\]/gi, (_, inner: string) => {
    const items = inner
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const item of items) {
      const match = item.match(/^([GRYB])([a-h][1-8])$/i);
      if (match) {
        const color = match[1]!.toUpperCase() as AnnotationColor;
        const square = match[2]!.toLowerCase() as Square;
        if (!highlights.some((h) => h.color === color && h.square === square)) {
          highlights.push({ color, square });
        }
      }
    }
    return '';
  });

  const text = cleaned.replace(/\s+/g, ' ').trim();
  return {
    text,
    eval: evalAnnotation,
    arrows,
    highlights,
  };
}

/**
 * Strip and extract inline move suffixes (`!`, `?`, `!!`, `??`, `!?`, `?!`, `±`, `∓`, `+=`, `=+`, `+-`, `-+`, `∞`)
 * from a SAN token.
 */
function splitSanAndInlineNags(rawSan: string): {
  sanCore: string;
  inlineNags: number[];
} {
  let s = rawSan.trim();
  const inlineNags: number[] = [];

  // Check trailing symbolic evaluation glyphs
  const evalSuffixMatch = s.match(/(?:\+=|=\+|\+-|-\+|±|∓|∞|⩲|⩱)$/);
  let trailingEvalNag: number | null = null;
  if (evalSuffixMatch) {
    trailingEvalNag = resolveNagCode(evalSuffixMatch[0]);
    s = s.slice(0, s.length - evalSuffixMatch[0].length);
  }

  // Check trailing !/? move suffixes
  const bangMatch = s.match(/([?!]{1,2})$/);
  if (bangMatch) {
    const suffix = bangMatch[1]!;
    const code = resolveNagCode(suffix);
    if (code !== null) {
      inlineNags.push(code);
    } else {
      for (const ch of suffix) {
        const single = resolveNagCode(ch);
        if (single !== null && !inlineNags.includes(single)) {
          inlineNags.push(single);
        }
      }
    }
    s = s.slice(0, s.length - suffix.length);
  }

  if (trailingEvalNag !== null && !inlineNags.includes(trailingEvalNag)) {
    inlineNags.push(trailingEvalNag);
  }

  return { sanCore: s, inlineNags };
}

function mergeParsedCommentIntoNode(node: GameNode, rawComment: string, targetField: 'comment' | 'preComment'): void {
  const parsed = parseCommentAnnotations(rawComment);
  if (parsed.eval) {
    node.eval = parsed.eval;
  }
  for (const arrow of parsed.arrows) {
    if (!node.arrows.some((a) => a.color === arrow.color && a.from === arrow.from && a.to === arrow.to)) {
      node.arrows.push(arrow);
    }
  }
  for (const hl of parsed.highlights) {
    if (!node.highlights.some((h) => h.color === hl.color && h.square === hl.square)) {
      node.highlights.push(hl);
    }
  }
  if (parsed.text) {
    if (targetField === 'preComment') {
      node.preComment = node.preComment ? `${node.preComment} ${parsed.text}` : parsed.text;
    } else {
      node.comment = node.comment ? `${node.comment} ${parsed.text}` : parsed.text;
    }
  }
}

/**
 * Parse a single PGN game string into a `GameTree`.
 */
export function parsePgn(pgn: string): GameTree {
  const games = parsePgnGames(pgn);
  if (games.length === 0) {
    return new GameTree();
  }
  return games[0]!;
}

/**
 * Parse one or more PGN games from a PGN string into an array of `GameTree` instances.
 */
export function parsePgnGames(pgn: string): GameTree[] {
  const tokens = tokenizePgn(pgn);
  if (tokens.length === 0) {
    return [new GameTree()];
  }

  // Partition token stream into individual games when a new HEADER block starts after movetext
  const gameTokenSlices: PgnToken[][] = [];
  let currentSlice: PgnToken[] = [];
  let sawMovetextInCurrent = false;
  let parenDepth = 0;

  for (const tok of tokens) {
    if (tok.type === 'LPAREN') parenDepth++;
    if (tok.type === 'RPAREN' && parenDepth > 0) parenDepth--;

    if (tok.type === 'HEADER' && sawMovetextInCurrent && parenDepth === 0) {
      gameTokenSlices.push(currentSlice);
      currentSlice = [tok];
      sawMovetextInCurrent = false;
      continue;
    }

    if (tok.type !== 'HEADER') {
      sawMovetextInCurrent = true;
    }
    currentSlice.push(tok);
  }
  if (currentSlice.length > 0) {
    gameTokenSlices.push(currentSlice);
  }

  return gameTokenSlices.map((slice) => parseSingleGameTokens(slice));
}

function parseSingleGameTokens(tokens: PgnToken[]): GameTree {
  const headers: Record<string, string> = {};
  let idx = 0;

  while (idx < tokens.length && tokens[idx]!.type === 'HEADER') {
    const t = tokens[idx]!;
    if (t.headerKey !== undefined && t.headerVal !== undefined) {
      headers[t.headerKey] = t.headerVal;
    }
    idx++;
  }

  // Detect FEN (case-insensitive header key fallback) and Chess960 variant
  let initialFen = DEFAULT_POSITION;
  let isChess960 = false;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'fen' && v.trim()) {
      initialFen = v.trim();
    }
    if (k.toLowerCase() === 'variant' && /^(?:chess960|fischerandom|fischer\s*random)$/i.test(v.trim())) {
      isChess960 = true;
    }
  }

  const tree = new GameTree(initialFen, {
    chess960: isChess960,
    headers,
  });

  const parseVariationSequence = (startParentId: string, isVariation: boolean): void => {
    let currentParentId = startParentId;
    let lastMoveNode: GameNode | null = null;
    let sawMoveNumberSinceLastMove = false;
    let sawVariationSinceLastMove = false;
    let pendingPreComments: string[] = [];

    while (idx < tokens.length) {
      const tok = tokens[idx]!;

      if (tok.type === 'RPAREN') {
        if (isVariation) {
          idx++; // consume ')'
          return;
        }
        // Unmatched ')' at top level: skip defensively
        idx++;
        continue;
      }

      if (tok.type === 'LPAREN') {
        idx++; // consume '('
        // A variation replaces `lastMoveNode`, so it branches from `lastMoveNode.parentId`
        const branchParentId = lastMoveNode?.parentId ?? currentParentId;
        parseVariationSequence(branchParentId, true);
        sawVariationSinceLastMove = true;
        continue;
      }

      if (tok.type === 'MOVE_NUMBER') {
        sawMoveNumberSinceLastMove = true;
        idx++;
        continue;
      }

      if (tok.type === 'COMMENT') {
        idx++;
        if (lastMoveNode === null) {
          if (!isVariation && !sawMoveNumberSinceLastMove) {
            // Root-level game comment before `1.`
            mergeParsedCommentIntoNode(tree.root, tok.value, 'comment');
          } else {
            // Pre-move comment at start of variation `( { pre } 1... c5 )`
            // or after move 1's number `1. { pre } e4`
            pendingPreComments.push(tok.value);
          }
        } else if (sawMoveNumberSinceLastMove || sawVariationSinceLastMove) {
          // Comment placed after a move number (`1... { pre } e5`) or after a variation (`(1. d4) { pre } 1... e5`)
          pendingPreComments.push(tok.value);
        } else {
          // Post-move comment attached to `lastMoveNode`
          mergeParsedCommentIntoNode(lastMoveNode, tok.value, 'comment');
        }
        continue;
      }

      if (tok.type === 'NAG') {
        idx++;
        if (lastMoveNode && tok.nagCode !== undefined) {
          tree.addNag(lastMoveNode.id, tok.nagCode);
        }
        continue;
      }

      if (tok.type === 'RESULT') {
        idx++;
        const res = tok.value as GameTermination;
        if (isVariation) {
          if (lastMoveNode) {
            lastMoveNode.variationResult = res;
          }
          // In some PGNs a result token inside a variation is immediately followed by ')'
          continue;
        } else {
          tree.setResult(res);
          return;
        }
      }

      if (tok.type === 'SAN') {
        idx++;
        // Ignore standalone 'e.p.' / 'ep' tokens following a pawn capture
        if (/^e\.?p\.?$/i.test(tok.value)) {
          continue;
        }

        const { sanCore, inlineNags } = splitSanAndInlineNags(tok.value);
        if (!sanCore) {
          for (const nag of inlineNags) {
            if (lastMoveNode) tree.addNag(lastMoveNode.id, nag);
          }
          continue;
        }

        const node = tree.addMove(sanCore, {
          fromNodeId: currentParentId,
          nags: inlineNags,
          forceNewVariation: isVariation && lastMoveNode === null,
        });

        for (const pre of pendingPreComments) {
          mergeParsedCommentIntoNode(node, pre, 'preComment');
        }
        pendingPreComments = [];
        lastMoveNode = node;
        currentParentId = node.id;
        sawMoveNumberSinceLastMove = false;
        sawVariationSinceLastMove = false;
        continue;
      }

      idx++;
    }
  };

  parseVariationSequence(tree.root.id, false);
  tree.goToEnd();
  return tree;
}

function escapeHeaderValue(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatEvalTag(evalObj: PgnEvalAnnotation): string {
  const depthSuffix = evalObj.depth !== undefined ? `,${evalObj.depth}` : '';
  if (evalObj.mate !== undefined) {
    return `[%eval #${evalObj.mate}${depthSuffix}]`;
  }
  const cp = evalObj.cp ?? 0;
  const pawns = (cp / 100).toFixed(2);
  return `[%eval ${pawns}${depthSuffix}]`;
}

function formatNodePostCommentBlock(node: GameNode): string | null {
  const parts: string[] = [];
  if (node.eval !== undefined) {
    parts.push(formatEvalTag(node.eval));
  }
  if (node.arrows.length > 0) {
    const calBody = node.arrows.map((a) => `${a.color}${a.from}${a.to}`).join(',');
    parts.push(`[%cal ${calBody}]`);
  }
  if (node.highlights.length > 0) {
    const cslBody = node.highlights.map((h) => `${h.color}${h.square}`).join(',');
    parts.push(`[%csl ${cslBody}]`);
  }
  if (node.comment.trim()) {
    parts.push(node.comment.trim().replace(/\}/g, ']'));
  }
  if (parts.length === 0) return null;
  return `{ ${parts.join(' ')} }`;
}

function formatPreCommentBlock(preComment: string): string | null {
  const trimmed = preComment.trim();
  if (!trimmed) return null;
  return `{ ${trimmed.replace(/\}/g, ']')} }`;
}

/**
 * Serialize a `GameTree` to canonical PGN format, preserving headers, nested variations,
 * pre-move and post-move comments, NAGs, `[%eval]`, `[%cal]`, `[%csl]`, and Chess960 tags.
 */
export function writePgn(tree: GameTree, options?: WritePgnOptions): string {
  const headers = tree.getHeaders();
  const hasHeaders = Object.keys(headers).length > 0;
  const includeHeaders =
    options?.includeHeaders ?? (hasHeaders || tree.root.fen !== DEFAULT_POSITION || tree.isChess960());

  const headerLines: string[] = [];
  if (includeHeaders) {
    const emittedKeys = new Set<string>();

    // Emit present Seven Tag Roster keys first in canonical order
    for (const key of SEVEN_TAG_ORDER) {
      if (key in headers) {
        const val = key === 'Result' ? tree.result : headers[key]!;
        headerLines.push(`[${key} "${escapeHeaderValue(val)}"]`);
        emittedKeys.add(key);
      }
    }

    // Ensure Variant / SetUp / FEN are emitted if non-default or Chess960
    if (tree.isChess960() && !headers.Variant) {
      headerLines.push('[Variant "Chess960"]');
      emittedKeys.add('Variant');
    }
    if (tree.root.fen !== DEFAULT_POSITION) {
      if (!('SetUp' in headers)) {
        headerLines.push('[SetUp "1"]');
        emittedKeys.add('SetUp');
      }
      if (!('FEN' in headers)) {
        headerLines.push(`[FEN "${escapeHeaderValue(tree.root.fen)}"]`);
        emittedKeys.add('FEN');
      }
    }

    // Emit all remaining headers in their stored order
    for (const [key, val] of Object.entries(headers)) {
      if (emittedKeys.has(key)) continue;
      const finalVal = key === 'Result' ? tree.result : val;
      headerLines.push(`[${key} "${escapeHeaderValue(finalVal)}"]`);
      emittedKeys.add(key);
    }
  }

  const moveTokens: string[] = [];

  // Root-level intro comment / annotations
  const rootPostBlock = formatNodePostCommentBlock(tree.root);
  if (rootPostBlock) {
    moveTokens.push(rootPostBlock);
  }

  const serializeLine = (firstMove: GameNode | undefined, parentNode: GameNode, isVariation: boolean): void => {
    let currMove = firstMove;
    let currParent = parentNode;
    let forceMoveNumber = true;
    let isFirstInLine = true;

    while (currMove) {
      const isWhiteMove = currMove.moveColor === 'w';
      const preBlock = formatPreCommentBlock(currMove.preComment);

      if (isFirstInLine && isVariation && preBlock) {
        // Inside `( { preComment } 1... c5 )`, emit preComment before the variation's first move number
        moveTokens.push(preBlock);
      }

      const needsMoveNumber = isWhiteMove || forceMoveNumber || preBlock !== null;

      if (needsMoveNumber) {
        const moveNumStr = isWhiteMove ? `${currMove.moveNumber}.` : `${currMove.moveNumber}...`;
        moveTokens.push(moveNumStr);
      }

      if (!(isFirstInLine && isVariation) && preBlock) {
        // Emit `{ preComment }` after the move number and before the SAN move (`1. { pre } e4` or `1... { pre } e5`)
        moveTokens.push(preBlock);
      }

      // Emit SAN (plus optional symbolic suffix for NAG 1..6 if enabled)
      let sanOut = currMove.san;
      const remainingNags: number[] = [];
      for (const nag of currMove.nags) {
        if (options?.symbolicMoveSuffixes && SUFFIX_SORT_ORDER[nag]) {
          sanOut += SUFFIX_SORT_ORDER[nag];
        } else {
          remainingNags.push(nag);
        }
      }
      moveTokens.push(sanOut);

      for (const nag of remainingNags) {
        moveTokens.push(`$${nag}`);
      }

      const postBlock = formatNodePostCommentBlock(currMove);
      if (postBlock) {
        moveTokens.push(postBlock);
      }

      // If this is the first move of the main line (or a continuation), any alternative children
      // on `currParent` (when `!isVariation || !isFirstInLine`) are sibling variations to `currMove`!
      const siblingVariations = !isVariation || !isFirstInLine ? currParent.children.slice(1) : [];

      for (const sibling of siblingVariations) {
        moveTokens.push('(');
        serializeLine(sibling, currParent, true);
        moveTokens.push(')');
      }

      if (isVariation && currMove.variationResult && currMove.children.length === 0) {
        moveTokens.push(currMove.variationResult);
      }

      // If we emitted a post-comment or any variations after a White move, the next Black move must repeat `N...`
      forceMoveNumber = postBlock !== null || siblingVariations.length > 0;
      isFirstInLine = false;
      currParent = currMove;
      currMove = currMove.children[0];
    }
  };

  if (tree.root.children.length > 0) {
    serializeLine(tree.root.children[0], tree.root, false);
  }

  moveTokens.push(tree.result);

  // Format tokens cleanly (no space immediately inside '(' or before ')' if helpful, or standard spaced)
  const body = moveTokens.join(' ');
  if (headerLines.length > 0) {
    return `${headerLines.join('\n')}\n\n${body}`;
  }
  return body;
}
