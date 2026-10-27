import { normalizeFenToEpd } from '../core/datasets';
import { GameTree, type GameNode, type AddMoveOptions } from '../core/game-tree';
import { parsePgnGames } from '../core/pgn';
import { DEFAULT_POSITION, type Color, type MoveInput } from '../core/rules';

/** The record ids of the two repertoires (one per colour). */
export function repertoireRecordId(color: Color): string {
  return `repertoire-${color}`;
}

export const REPERTOIRE_NAME: Record<Color, string> = { w: 'White repertoire', b: 'Black repertoire' };

/** The position a repertoire move is played from: board, side to move, castling, en passant. */
export function positionKey(fen: string): string {
  return normalizeFenToEpd(fen);
}

/** An empty repertoire for one colour: a tree with no moves, written out as a PGN file. */
export function newRepertoireTree(color: Color): GameTree {
  return new GameTree(DEFAULT_POSITION, { headers: { Event: REPERTOIRE_NAME[color], Result: '*' } });
}

function uciInput(uci: string): MoveInput {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci.length > 4 ? { promotion: uci[4]! } : {}) };
}

/**
 * Adds a move to the repertoire from `parentId`. A move already there is reused, so playing
 * the same line twice adds nothing. Returns the node and whether it is new.
 */
export function addRepertoireMove(
  tree: GameTree,
  parentId: string,
  move: MoveInput | string,
  options: Omit<AddMoveOptions, 'fromNodeId'> = {},
): { node: GameNode; created: boolean } {
  const parent = tree.getNode(parentId);
  if (!parent) throw new Error(`Node not found: ${parentId}`);
  const before = parent.children.length;
  const node = tree.addMove(
    typeof move === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move) ? uciInput(move) : move,
    {
      ...options,
      fromNodeId: parentId,
    },
  );
  return { node, created: parent.children.length > before };
}

/** Removes a move and everything that follows it. False for the start position. */
export function deleteRepertoireMove(tree: GameTree, nodeId: string): boolean {
  return tree.deleteNode(nodeId);
}

/** Every node but the root, in tree order. */
export function allMoveNodes(tree: GameTree): GameNode[] {
  const out: GameNode[] = [];
  const walk = (node: GameNode) => {
    for (const child of node.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(tree.root);
  return out;
}

export interface RepertoireStats {
  /** Moves in the tree. */
  moves: number;
  /** Lines: paths from the start to the end of a branch. */
  lines: number;
  /** Positions where it is my turn and I have a move prepared: what is drilled. */
  myPositions: number;
}

/** What a repertoire tree is read as: its positions by key, and the ones I have to answer. */
export interface RepertoireIndex {
  color: Color;
  tree: GameTree;
  /** Every position of the tree (before its children's moves are played) with the nodes that have it. */
  nodesByKey: Map<string, GameNode[]>;
  /** The positions where it is my turn and the tree has a move for me, in tree order. */
  myKeys: string[];
}

export function indexRepertoire(tree: GameTree, color: Color): RepertoireIndex {
  const nodesByKey = new Map<string, GameNode[]>();
  const myKeys: string[] = [];
  const walk = (node: GameNode) => {
    const key = positionKey(node.fen);
    const list = nodesByKey.get(key);
    if (list) list.push(node);
    else nodesByKey.set(key, [node]);
    if (node.children.length > 0 && node.turn === color && !myKeys.includes(key)) myKeys.push(key);
    for (const child of node.children) walk(child);
  };
  walk(tree.root);
  return { color, tree, nodesByKey, myKeys };
}

export function repertoireStats(index: RepertoireIndex): RepertoireStats {
  let moves = 0;
  let lines = 0;
  const walk = (node: GameNode) => {
    if (node.children.length === 0 && node.parentId !== null) lines++;
    for (const child of node.children) {
      moves++;
      walk(child);
    }
  };
  walk(index.tree.root);
  return { moves, lines, myPositions: index.myKeys.length };
}

/** The moves the repertoire has from a position, from every place the position occurs (alternatives first-come). */
export function repertoireMovesAt(index: RepertoireIndex, fen: string): GameNode[] {
  const out: GameNode[] = [];
  for (const node of index.nodesByKey.get(positionKey(fen)) ?? []) {
    for (const child of node.children) {
      if (!out.some((o) => positionKey(o.fen) === positionKey(child.fen))) out.push(child);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------- PGN import

export interface RepertoireImportResult {
  /** Games found in the text. */
  games: number;
  /** Games whose moves went into the tree. */
  imported: number;
  /** Moves that were not in the tree yet. */
  added: number;
  /** Why games were left out ("Game 2: starts from a custom position"). */
  skipped: string[];
}

/** Copies the moves below `from` (the source tree's node) into `tree` under `toId`; returns the new nodes. */
function copyBranch(tree: GameTree, from: GameNode, toId: string): number {
  let added = 0;
  for (const child of from.children) {
    const meta: Omit<AddMoveOptions, 'fromNodeId'> = {
      ...(child.preComment ? { preComment: child.preComment } : {}),
      ...(child.comment ? { comment: child.comment } : {}),
      ...(child.nags.length > 0 ? { nags: child.nags } : {}),
      ...(child.arrows.length > 0 ? { arrows: child.arrows } : {}),
      ...(child.highlights.length > 0 ? { highlights: child.highlights } : {}),
    };
    const { node, created } = addRepertoireMove(tree, toId, child.uci, meta);
    if (created) added++;
    added += copyBranch(tree, child, node.id);
  }
  return added;
}

/**
 * Merges the games of a PGN text into a repertoire tree: the main line and every variation of
 * each game. A game must start from the standard position (a custom start or Chess960 can't be a
 * repertoire); a game that doesn't parse is skipped and the others still go in. Transposed move
 * orders are separate branches here, but they share their positions (and so their spaced-
 * repetition cards) once indexed.
 */
export function importRepertoirePgn(tree: GameTree, text: string): RepertoireImportResult {
  const result: RepertoireImportResult = { games: 0, imported: 0, added: 0, skipped: [] };
  if (text.trim() === '') {
    result.skipped.push('The text is empty.');
    return result;
  }
  let games: GameTree[];
  try {
    games = parsePgnGames(text);
  } catch (err) {
    result.skipped.push(`Not a valid PGN (${err instanceof Error ? err.message : String(err)}).`);
    return result;
  }
  games.forEach((game, i) => {
    result.games++;
    const label = games.length > 1 ? `Game ${i + 1}: ` : '';
    if (game.isChess960()) {
      result.skipped.push(`${label}Chess960 can't be a repertoire.`);
      return;
    }
    if (game.root.fen !== DEFAULT_POSITION) {
      result.skipped.push(`${label}starts from a custom position.`);
      return;
    }
    if (game.root.children.length === 0) {
      result.skipped.push(`${label}no moves.`);
      return;
    }
    result.added += copyBranch(tree, game.root, tree.root.id);
    result.imported++;
  });
  return result;
}

// ---------------------------------------------------------------------------- the drill

/** A tiny seeded generator (mulberry32), so drills and tests can be repeated. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type DrillAnswer =
  | { kind: 'correct'; node: GameNode }
  /** Not in the repertoire from here; `expected` are the moves it has. */
  | { kind: 'wrong'; expected: GameNode[] };

/**
 * One drill: a walk down the repertoire from the start position. The opponent's moves are
 * played for me and so are my moves in positions that aren't due; in a due position I have to
 * find a move of the repertoire. The walk heads for the first due position and then on towards
 * more of them, ending where the tree does. Any of my prepared moves is correct, and the walk
 * follows the one I played.
 */
export class RepertoireDrill {
  private readonly pathNodes: GameNode[];
  private readonly toward: Set<string>;
  private readonly dueMemo = new Map<string, boolean>();

  constructor(
    private readonly index: RepertoireIndex,
    /** Position keys that are due to be answered. */
    private readonly due: ReadonlySet<string>,
    private readonly random: () => number = Math.random,
    /** The due position to head for first (default: the first of `due` in the tree). */
    target?: string,
  ) {
    this.pathNodes = [index.tree.root];
    const goal = this.findTarget(target);
    this.toward = new Set(goal ? index.tree.getLineToNode(goal.id).map((n) => n.id) : []);
  }

  /** Whether the tree has any position that is due. */
  public static hasWork(index: RepertoireIndex, due: ReadonlySet<string>): boolean {
    return index.myKeys.some((k) => due.has(k));
  }

  private findTarget(target?: string): GameNode | null {
    const keys = target ? [target] : [...this.due];
    for (const key of keys) {
      const node = this.index.nodesByKey.get(key)?.find((n) => n.children.length > 0 && n.turn === this.index.color);
      if (node) return node;
    }
    return null;
  }

  public get current(): GameNode {
    return this.pathNodes[this.pathNodes.length - 1]!;
  }

  /** Nodes visited, starting with the start position. */
  public get path(): readonly GameNode[] {
    return this.pathNodes;
  }

  /** The tree has no move from here: the line is over. */
  public get done(): boolean {
    return this.current.children.length === 0;
  }

  public get myTurn(): boolean {
    return this.current.turn === this.index.color;
  }

  /** My turn in a due position: the drill asks for a move. */
  public get asking(): boolean {
    return !this.done && this.myTurn && this.due.has(positionKey(this.current.fen));
  }

  public get key(): string {
    return positionKey(this.current.fen);
  }

  private subtreeDue(node: GameNode): boolean {
    const memo = this.dueMemo.get(node.id);
    if (memo !== undefined) return memo;
    const own = node.children.length > 0 && node.turn === this.index.color && this.due.has(positionKey(node.fen));
    const result = own || node.children.some((c) => this.subtreeDue(c));
    this.dueMemo.set(node.id, result);
    return result;
  }

  /** The move the walk plays from the current position when nobody has to choose. */
  private defaultChild(): GameNode {
    const kids = this.current.children;
    const onWay = kids.filter((c) => this.toward.has(c.id));
    if (onWay.length > 0) return onWay[0]!;
    const withWork = kids.filter((c) => this.subtreeDue(c));
    const pool = withWork.length > 0 ? withWork : kids;
    return pool[Math.floor(this.random() * pool.length)]!;
  }

  /** Plays the next move for me or the opponent where nobody is asked; null when it is a question or the end. */
  public advance(): GameNode | null {
    if (this.done || this.asking) return null;
    const next = this.defaultChild();
    this.pathNodes.push(next);
    return next;
  }

  /** The moves I may play here (SAN first). */
  public expected(): GameNode[] {
    return this.current.children;
  }

  /** My answer in a due position: follows it when it is a repertoire move. */
  public answer(uci: string): DrillAnswer {
    const hit = this.current.children.find((c) => c.uci === uci);
    if (!hit) return { kind: 'wrong', expected: this.current.children };
    this.pathNodes.push(hit);
    return { kind: 'correct', node: hit };
  }

  /** Gives the answer away (the player gave up on it): plays the first prepared move. */
  public reveal(): GameNode {
    const next = this.current.children[0]!;
    this.pathNodes.push(next);
    return next;
  }
}

// ---------------------------------------------------------------------------- leaving the repertoire

export type DepartureKind =
  /** I played a move the repertoire doesn't have. */
  | 'left'
  /** The opponent played a move the repertoire has no answer to. */
  | 'opponent-left'
  /** The game followed the repertoire to the end of a line, then went on. */
  | 'ended'
  /** The game ended while still inside the repertoire. */
  | 'followed';

export interface RepertoireDeparture {
  kind: DepartureKind;
  /** Ply of the move outside the repertoire (`left`, `opponent-left`); the last move inside it otherwise. */
  ply: number;
  nodeId: string;
  /** The move of the game at `ply`, numbered ("7...Nc6"). */
  moveLabel: string;
  san: string;
  /** Who played it. */
  mover: Color;
  /** The repertoire's moves from that position, in SAN (`left`, `opponent-left`). */
  expected: string[];
  /** Plies of the game inside the repertoire. */
  followed: number;
}

function label(node: GameNode): string {
  return `${node.moveNumber}${node.moveColor === 'b' ? '...' : '.'}${node.san}`;
}

/**
 * Where a game (its main line) leaves a repertoire. Positions are compared, not move orders, so
 * a transposition stays inside. Null when the repertoire is empty or the game doesn't start
 * from the standard position.
 */
export function findDeparture(index: RepertoireIndex, game: GameTree): RepertoireDeparture | null {
  if (game.root.fen !== DEFAULT_POSITION || index.tree.root.children.length === 0) return null;
  const line = game.getMainLine();
  if (line.length === 0) return null;
  let fen = game.root.fen;
  let followed = 0;
  let last: GameNode | null = null;
  for (const node of line) {
    const prepared = repertoireMovesAt(index, fen);
    if (prepared.length === 0) {
      // The repertoire has nothing from this position: its line ended with the last move
      return {
        kind: 'ended',
        ply: followed,
        nodeId: (last ?? node).id,
        moveLabel: last ? label(last) : label(node),
        san: last?.san ?? node.san,
        mover: last?.moveColor ?? index.color,
        expected: [],
        followed,
      };
    }
    const hit = prepared.some((p) => positionKey(p.fen) === positionKey(node.fen));
    if (!hit) {
      const mine = node.moveColor === index.color;
      return {
        kind: mine ? 'left' : 'opponent-left',
        ply: node.ply,
        nodeId: node.id,
        moveLabel: label(node),
        san: node.san,
        mover: node.moveColor ?? (mine ? index.color : index.color === 'w' ? 'b' : 'w'),
        expected: prepared.map((p) => p.san),
        followed,
      };
    }
    followed++;
    last = node;
    fen = node.fen;
  }
  const lastNode = line[line.length - 1]!;
  return {
    kind: repertoireMovesAt(index, fen).length > 0 ? 'followed' : 'ended',
    ply: lastNode.ply,
    nodeId: lastNode.id,
    moveLabel: label(lastNode),
    san: lastNode.san,
    mover: lastNode.moveColor ?? index.color,
    expected: [],
    followed,
  };
}

/** The sentence the review shows for a departure. */
export function describeDeparture(d: RepertoireDeparture, color: Color): string {
  const side = color === 'w' ? 'White' : 'Black';
  switch (d.kind) {
    case 'left':
      return `You left your ${side} repertoire at ${d.moveLabel}. Your repertoire plays ${d.expected.join(' or ')} there.`;
    case 'opponent-left':
      return `Your opponent left your ${side} repertoire at ${d.moveLabel}: it has no reply prepared for that move. Your repertoire expected ${d.expected.join(' or ')}.`;
    case 'ended':
      return `You followed your ${side} repertoire to the end of the line (${d.followed} ${d.followed === 1 ? 'move' : 'moves'}); from here you were on your own.`;
    case 'followed':
      return `The whole game stayed inside your ${side} repertoire.`;
  }
}
