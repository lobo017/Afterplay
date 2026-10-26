import {
  DEFAULT_POSITION,
  RulesAdapter,
  type Color,
  type MoveInput,
  type PieceSymbol,
  type Square,
} from './rules';

export type AnnotationColor = 'G' | 'R' | 'Y' | 'B';

export interface PgnArrowAnnotation {
  color: AnnotationColor;
  from: Square;
  to: Square;
}

export interface PgnHighlightAnnotation {
  color: AnnotationColor;
  square: Square;
}

export interface PgnEvalAnnotation {
  /** Centipawn evaluation from White's perspective (e.g. +1.25 pawns -> 125). */
  cp?: number;
  /** Mate in N moves from White's perspective (positive = White mates, negative = Black mates). */
  mate?: number;
  /** Optional search depth if included in [%eval +1.25,24]. */
  depth?: number;
  /** Written by this app's own engine (live analysis or a review), not read from a PGN. */
  app?: true;
}

export type MoveClassification =
  | 'Best'
  | 'Excellent'
  | 'Good'
  | 'Inaccuracy'
  | 'Mistake'
  | 'Blunder'
  | 'Great'
  | 'Brilliant'
  | 'Book'
  | 'Miss';

export type GameTermination = '1-0' | '0-1' | '1/2-1/2' | '*';

export interface GameNode {
  id: string;
  parentId: string | null;
  ply: number;
  moveNumber: number;
  moveColor?: Color;
  turn: Color;
  san: string;
  uci: string;
  from?: Square;
  to?: Square;
  piece?: PieceSymbol;
  captured?: PieceSymbol;
  promotion?: PieceSymbol;
  fen: string;
  /** Comment placed immediately before this move in PGN (e.g. `{ Pre-move note } 1... c5`). */
  preComment: string;
  /** Comment placed after this move in PGN (or game intro comment on the root node). */
  comment: string;
  /** Numeric Annotation Glyphs (e.g. 1 for !, 2 for ?, 3 for !!, 4 for ??, 5 for !?, 6 for ?!). */
  nags: number[];
  /** Parsed [%eval ...] annotation on this node. */
  eval?: PgnEvalAnnotation;
  /** Parsed [%cal ...] arrow annotations on this node. */
  arrows: PgnArrowAnnotation[];
  /** Parsed [%csl ...] square highlight/circle annotations on this node. */
  highlights: PgnHighlightAnnotation[];
  /** Optional move review classification (Phase 5). */
  classification?: MoveClassification;
  /** Optional result token inside a variation (e.g. `(4... Qxf2# 0-1)`). */
  variationResult?: GameTermination;
  /** Child continuations: `children[0]` is main line; `children[1..]` are variations. */
  children: GameNode[];
}

export interface AddMoveOptions {
  fromNodeId?: string;
  preComment?: string;
  comment?: string;
  nags?: (number | string)[];
  eval?: PgnEvalAnnotation;
  arrows?: PgnArrowAnnotation[];
  highlights?: PgnHighlightAnnotation[];
  classification?: MoveClassification;
  variationResult?: GameTermination;
  /** If true, always creates a new variation node even if an identical SAN move child already exists. */
  forceNewVariation?: boolean;
}

export interface SerializedGameTree {
  headers: Record<string, string>;
  result: GameTermination;
  chess960: boolean;
  root: GameNode;
  currentNodeId: string;
}

const SYMBOL_TO_NAG: Record<string, number> = {
  '!': 1,
  '?': 2,
  '!!': 3,
  '??': 4,
  '!?': 5,
  '?!': 6,
  '□': 7,
  '=': 10,
  '∞': 13,
  '+=': 14,
  '⩲': 14,
  '=+': 15,
  '⩱': 15,
  '±': 16,
  '∓': 17,
  '+-': 18,
  '-+': 19,
  '⨀': 22,
  '↑': 36,
  '→': 40,
  '=/∞': 44,
  '⇆': 132,
  N: 146,
  D: 220,
};

const NAG_TO_SYMBOL: Record<number, string> = {
  1: '!',
  2: '?',
  3: '!!',
  4: '??',
  5: '!?',
  6: '?!',
  7: '□',
  10: '=',
  13: '∞',
  14: '+=',
  15: '=+',
  16: '±',
  17: '∓',
  18: '+-',
  19: '-+',
  22: '⨀',
  36: '↑',
  40: '→',
  44: '=/∞',
  132: '⇆',
  146: 'N',
  220: 'D',
};

/**
 * Convert an annotation symbol (`!`, `?!`, `±`, `$14`, etc.) or number to a numeric NAG code.
 */
export function resolveNagCode(nagOrSymbol: number | string): number | null {
  if (typeof nagOrSymbol === 'number') {
    if (Number.isInteger(nagOrSymbol) && nagOrSymbol >= 1 && nagOrSymbol <= 255) {
      return nagOrSymbol;
    }
    return null;
  }
  const trimmed = nagOrSymbol.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('$')) {
    const code = Number(trimmed.slice(1));
    if (Number.isInteger(code) && code >= 1 && code <= 255) {
      return code;
    }
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    const code = Number(trimmed);
    if (Number.isInteger(code) && code >= 1 && code <= 255) {
      return code;
    }
    return null;
  }
  return SYMBOL_TO_NAG[trimmed] ?? null;
}

/**
 * Convert a numeric NAG code into its human-readable glyph (e.g. `1 -> '!'`, `16 -> '±'`).
 */
export function nagToGlyph(nag: number): string {
  return NAG_TO_SYMBOL[nag] ?? `$${nag}`;
}

export class GameTree {
  private nodesById = new Map<string, GameNode>();
  private rootNode: GameNode;
  private activeNodeId: string;
  private nextIdCounter = 1;
  private headersMap: Record<string, string> = {};
  private gameResult: GameTermination = '*';
  private isC960: boolean;

  constructor(
    initialFen: string = DEFAULT_POSITION,
    options?: {
      chess960?: boolean;
      headers?: Record<string, string>;
      result?: GameTermination;
    },
  ) {
    const adapter = new RulesAdapter(initialFen, {
      chess960: options?.chess960,
    });
    this.isC960 = adapter.isChess960();
    const canonicalFen = adapter.fen();

    if (options?.headers) {
      this.headersMap = { ...options.headers };
    }
    if (canonicalFen !== DEFAULT_POSITION) {
      this.headersMap.SetUp = '1';
      this.headersMap.FEN = canonicalFen;
    }
    if (this.isC960 && !this.headersMap.Variant) {
      this.headersMap.Variant = 'Chess960';
    }
    if (options?.result) {
      this.gameResult = options.result;
      if (Object.keys(this.headersMap).length > 0) {
        this.headersMap.Result = options.result;
      }
    } else if (
      this.headersMap.Result === '1-0' ||
      this.headersMap.Result === '0-1' ||
      this.headersMap.Result === '1/2-1/2' ||
      this.headersMap.Result === '*'
    ) {
      this.gameResult = this.headersMap.Result;
    } else if (Object.keys(this.headersMap).length > 0) {
      this.headersMap.Result = this.gameResult;
    }

    this.rootNode = {
      id: 'node_0',
      parentId: null,
      ply: 0,
      moveNumber: adapter.moveNumber(),
      turn: adapter.turn(),
      san: '',
      uci: '',
      fen: canonicalFen,
      preComment: '',
      comment: '',
      nags: [],
      arrows: [],
      highlights: [],
      children: [],
    };
    this.nodesById.set(this.rootNode.id, this.rootNode);
    this.activeNodeId = this.rootNode.id;
  }

  public get root(): GameNode {
    return this.rootNode;
  }

  public get currentNode(): GameNode {
    return this.nodesById.get(this.activeNodeId) ?? this.rootNode;
  }

  public get currentNodeId(): string {
    return this.activeNodeId;
  }

  public get result(): GameTermination {
    return this.gameResult;
  }

  public setResult(result: GameTermination): void {
    this.gameResult = result;
    if (Object.keys(this.headersMap).length > 0) {
      this.headersMap.Result = result;
    }
  }

  public isChess960(): boolean {
    return this.isC960;
  }

  public getHeaders(): Record<string, string> {
    return { ...this.headersMap };
  }

  public setHeader(key: string, value: string): void {
    this.headersMap[key] = value;
    if (
      key === 'Result' &&
      (value === '1-0' || value === '0-1' || value === '1/2-1/2' || value === '*')
    ) {
      this.gameResult = value;
    }
    if (
      key.toLowerCase() === 'variant' &&
      /^(?:chess960|fischerandom)$/i.test(value.trim())
    ) {
      this.isC960 = true;
    }
  }

  public removeHeader(key: string): boolean {
    if (key in this.headersMap) {
      delete this.headersMap[key];
      return true;
    }
    return false;
  }

  public getNode(nodeId: string): GameNode | undefined {
    return this.nodesById.get(nodeId);
  }

  /**
   * Add a move from `options.fromNodeId` (or the current active node if omitted),
   * advancing `currentNode` to the new (or matched existing) child node.
   */
  public addMove(
    moveInput: string | MoveInput | null,
    options?: AddMoveOptions,
  ): GameNode {
    const parentId = options?.fromNodeId ?? this.activeNodeId;
    const parent = this.nodesById.get(parentId);
    if (!parent) {
      throw new Error(`Parent node not found: ${parentId}`);
    }

    const adapter = new RulesAdapter(parent.fen, { chess960: this.isC960 });
    const executed = adapter.move(moveInput);

    // Reuse existing child if same SAN already exists at this branch and forceNewVariation is false
    if (!options?.forceNewVariation) {
      const existing = parent.children.find((c) => c.san === executed.san);
      if (existing) {
        this.applyNodeMetadata(existing, options);
        this.activeNodeId = existing.id;
        return existing;
      }
    }

    const newNode: GameNode = {
      id: `node_${this.nextIdCounter++}`,
      parentId: parent.id,
      ply: parent.ply + 1,
      moveNumber:
        executed.color === 'w'
          ? parent.moveNumber
          : parent.ply === 0 && parent.turn === 'b'
            ? parent.moveNumber
            : parent.moveColor === 'w'
              ? parent.moveNumber
              : parent.moveNumber + (parent.moveColor === 'b' ? 1 : 0),
      moveColor: executed.color,
      turn: adapter.turn(),
      san: executed.san,
      uci: executed.uci,
      from: executed.from,
      to: executed.to,
      piece: executed.piece,
      captured: executed.captured,
      promotion: executed.promotion,
      fen: executed.after,
      preComment: '',
      comment: '',
      nags: [],
      arrows: [],
      highlights: [],
      children: [],
    };

    // Exact moveNumber calculation from parent's FEN full-move counter before the move:
    const parentFullMove = Number(parent.fen.split(' ')[5] ?? 1);
    newNode.moveNumber = parentFullMove;

    this.applyNodeMetadata(newNode, options);

    parent.children.push(newNode);
    this.nodesById.set(newNode.id, newNode);
    this.activeNodeId = newNode.id;
    return newNode;
  }

  /**
   * Explicitly add a variation move branching from `parentNodeId`.
   * Note: if `moveToReplaceNodeId` is passed (a move node whose alternative is being added),
   * the variation is attached to that move's parent (standard chess tree semantics).
   */
  public addVariation(
    parentOrTargetNodeId: string,
    moveInput: string | MoveInput | null,
    options?: Omit<AddMoveOptions, 'fromNodeId'>,
  ): GameNode {
    const refNode = this.nodesById.get(parentOrTargetNodeId);
    if (!refNode) {
      throw new Error(`Node not found: ${parentOrTargetNodeId}`);
    }

    // Check if the move is legal from refNode directly; if not and refNode has a parent
    // with the same side to move as the intended variation, branch from refNode.parentId.
    let targetParent = refNode;
    try {
      const probe = new RulesAdapter(refNode.fen, { chess960: this.isC960 });
      probe.move(moveInput);
    } catch {
      if (refNode.parentId) {
        const parentCandidate = this.nodesById.get(refNode.parentId);
        if (parentCandidate) {
          targetParent = parentCandidate;
        }
      }
    }

    return this.addMove(moveInput, {
      ...options,
      fromNodeId: targetParent.id,
    });
  }

  /**
   * Promote a variation one position higher among its parent's children.
   * If `nodeId` is deeper inside a variation, promotes the variation branch containing `nodeId`.
   */
  public promoteVariation(nodeId: string): boolean {
    const branch = this.findVariationBranchRoot(nodeId);
    if (!branch) return false;
    const { parent, index } = branch;
    if (index <= 0) return false;

    const temp = parent.children[index - 1]!;
    parent.children[index - 1] = parent.children[index]!;
    parent.children[index] = temp;
    return true;
  }

  /**
   * Promote a variation all the way to the main line (`children[0]`), including any outer variations.
   */
  public promoteToMainLine(nodeId: string): boolean {
    let curr = this.nodesById.get(nodeId);
    if (!curr) return false;
    let changed = false;

    while (curr && curr.parentId) {
      const parent = this.nodesById.get(curr.parentId);
      if (!parent) break;
      const idx = parent.children.indexOf(curr);
      if (idx > 0) {
        parent.children.splice(idx, 1);
        parent.children.unshift(curr);
        changed = true;
      }
      curr = parent;
    }

    return changed;
  }

  /**
   * Demote a variation (or main-line branch when alternatives exist) one position lower
   * among its parent's children.
   */
  public demoteVariation(nodeId: string): boolean {
    const startNode = this.nodesById.get(nodeId);
    if (!startNode) return false;

    // First check if startNode itself can be demoted among its siblings
    if (startNode.parentId) {
      const directParent = this.nodesById.get(startNode.parentId);
      if (directParent) {
        const directIdx = directParent.children.indexOf(startNode);
        if (directIdx >= 0 && directIdx < directParent.children.length - 1) {
          const temp = directParent.children[directIdx + 1]!;
          directParent.children[directIdx + 1] = directParent.children[directIdx]!;
          directParent.children[directIdx] = temp;
          return true;
        }
      }
    }

    // Otherwise walk up to the nearest variation branch root that can be demoted
    let curr: GameNode | undefined = startNode;
    while (curr && curr.parentId) {
      const parent = this.nodesById.get(curr.parentId);
      if (!parent) break;
      const idx = parent.children.indexOf(curr);
      if (idx >= 0 && idx < parent.children.length - 1) {
        const temp = parent.children[idx + 1]!;
        parent.children[idx + 1] = parent.children[idx]!;
        parent.children[idx] = temp;
        return true;
      }
      curr = parent;
    }

    return false;
  }

  /**
   * Delete the variation branch containing `nodeId` (or `nodeId`'s subtree if `nodeId` is a direct branch root).
   */
  public deleteVariation(nodeId: string): boolean {
    const node = this.nodesById.get(nodeId);
    if (!node || !node.parentId) return false;

    const branch = this.findVariationBranchRoot(nodeId);
    const targetToDelete = branch ? branch.child : node;
    return this.deleteNode(targetToDelete.id);
  }

  /**
   * Delete `nodeId` and its entire descendant subtree.
   */
  public deleteNode(nodeId: string): boolean {
    const node = this.nodesById.get(nodeId);
    if (!node || !node.parentId) return false;

    const parent = this.nodesById.get(node.parentId);
    if (!parent) return false;

    const idx = parent.children.indexOf(node);
    if (idx === -1) return false;

    parent.children.splice(idx, 1);
    this.removeSubtreeIds(node);

    if (!this.nodesById.has(this.activeNodeId)) {
      this.activeNodeId = parent.id;
    }
    return true;
  }

  public setComment(nodeId: string, comment: string): void {
    const node = this.nodesById.get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    node.comment = comment;
  }

  public setPreComment(nodeId: string, preComment: string): void {
    const node = this.nodesById.get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    node.preComment = preComment;
  }

  public addNag(nodeId: string, nagOrSymbol: number | string): boolean {
    const node = this.nodesById.get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    const code = resolveNagCode(nagOrSymbol);
    if (code === null) return false;
    if (!node.nags.includes(code)) {
      node.nags.push(code);
    }
    return true;
  }

  public removeNag(nodeId: string, nagOrSymbol: number | string): boolean {
    const node = this.nodesById.get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    const code = resolveNagCode(nagOrSymbol);
    if (code === null) return false;
    const idx = node.nags.indexOf(code);
    if (idx === -1) return false;
    node.nags.splice(idx, 1);
    return true;
  }

  public setNags(nodeId: string, nags: (number | string)[]): void {
    const node = this.nodesById.get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    node.nags = [];
    for (const item of nags) {
      const code = resolveNagCode(item);
      if (code !== null && !node.nags.includes(code)) {
        node.nags.push(code);
      }
    }
  }

  public setEval(nodeId: string, evaluation: PgnEvalAnnotation | undefined): void {
    const node = this.nodesById.get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    node.eval = evaluation ? { ...evaluation } : undefined;
  }

  public setArrows(nodeId: string, arrows: PgnArrowAnnotation[]): void {
    const node = this.nodesById.get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    node.arrows = arrows.map((a) => ({ ...a }));
  }

  public setHighlights(nodeId: string, highlights: PgnHighlightAnnotation[]): void {
    const node = this.nodesById.get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    node.highlights = highlights.map((h) => ({ ...h }));
  }

  public setClassification(
    nodeId: string,
    classification: MoveClassification | undefined,
  ): void {
    const node = this.nodesById.get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    node.classification = classification;
  }

  public goToNode(nodeId: string): GameNode {
    const node = this.nodesById.get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    this.activeNodeId = node.id;
    return node;
  }

  public goToStart(): GameNode {
    this.activeNodeId = this.rootNode.id;
    return this.rootNode;
  }

  public goToEnd(): GameNode {
    let curr = this.currentNode;
    while (curr.children.length > 0) {
      curr = curr.children[0]!;
    }
    this.activeNodeId = curr.id;
    return curr;
  }

  public goBack(): GameNode | null {
    const curr = this.currentNode;
    if (!curr.parentId) return null;
    const parent = this.nodesById.get(curr.parentId) ?? null;
    if (parent) {
      this.activeNodeId = parent.id;
    }
    return parent;
  }

  public goForward(variationIndex = 0): GameNode | null {
    const curr = this.currentNode;
    const next = curr.children[variationIndex] ?? null;
    if (next) {
      this.activeNodeId = next.id;
    }
    return next;
  }

  /**
   * Returns the main-line sequence of move nodes (excluding the root node).
   */
  public getMainLine(): GameNode[] {
    const line: GameNode[] = [];
    let curr = this.rootNode.children[0];
    while (curr) {
      line.push(curr);
      curr = curr.children[0];
    }
    return line;
  }

  /**
   * Returns the sequence of move nodes from the root to `nodeId` (excluding the root node).
   */
  public getLineToNode(nodeId: string): GameNode[] {
    const line: GameNode[] = [];
    let curr = this.nodesById.get(nodeId);
    while (curr && curr.parentId !== null) {
      line.push(curr);
      curr = this.nodesById.get(curr.parentId);
    }
    return line.reverse();
  }

  public toJSON(): SerializedGameTree {
    return {
      headers: { ...this.headersMap },
      result: this.gameResult,
      chess960: this.isC960,
      root: structuredClone(this.rootNode),
      currentNodeId: this.activeNodeId,
    };
  }

  public static fromJSON(data: SerializedGameTree): GameTree {
    const tree = new GameTree(data.root.fen, {
      chess960: data.chess960,
      headers: data.headers,
      result: data.result,
    });
    tree.rootNode = structuredClone(data.root);
    tree.nodesById.clear();
    let maxNumericId = 0;

    const indexSubtree = (node: GameNode): void => {
      tree.nodesById.set(node.id, node);
      const match = node.id.match(/^node_(\d+)$/);
      if (match) {
        const num = Number(match[1]);
        if (num > maxNumericId) maxNumericId = num;
      }
      for (const child of node.children) {
        indexSubtree(child);
      }
    };
    indexSubtree(tree.rootNode);
    tree.nextIdCounter = maxNumericId + 1;
    tree.activeNodeId = tree.nodesById.has(data.currentNodeId)
      ? data.currentNodeId
      : tree.rootNode.id;
    return tree;
  }

  private applyNodeMetadata(node: GameNode, options?: AddMoveOptions): void {
    if (!options) return;
    if (options.preComment !== undefined) {
      node.preComment = options.preComment;
    }
    if (options.comment !== undefined) {
      node.comment = options.comment;
    }
    if (options.nags) {
      for (const n of options.nags) {
        const code = resolveNagCode(n);
        if (code !== null && !node.nags.includes(code)) {
          node.nags.push(code);
        }
      }
    }
    if (options.eval !== undefined) {
      node.eval = { ...options.eval };
    }
    if (options.arrows) {
      node.arrows = options.arrows.map((a) => ({ ...a }));
    }
    if (options.highlights) {
      node.highlights = options.highlights.map((h) => ({ ...h }));
    }
    if (options.classification !== undefined) {
      node.classification = options.classification;
    }
    if (options.variationResult !== undefined) {
      node.variationResult = options.variationResult;
    }
  }

  private findVariationBranchRoot(
    nodeId: string,
  ): { parent: GameNode; child: GameNode; index: number } | null {
    let curr = this.nodesById.get(nodeId);
    while (curr && curr.parentId) {
      const parent = this.nodesById.get(curr.parentId);
      if (!parent) break;
      const idx = parent.children.indexOf(curr);
      if (idx >= 1) {
        return { parent, child: curr, index: idx };
      }
      curr = parent;
    }
    return null;
  }

  private removeSubtreeIds(node: GameNode): void {
    this.nodesById.delete(node.id);
    for (const child of node.children) {
      this.removeSubtreeIds(child);
    }
  }
}
