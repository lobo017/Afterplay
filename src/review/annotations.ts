import type { GameNode, GameTree } from '../core/game-tree';

/*
 * A review owns the evaluation annotations of the line it reviews. Before it writes its
 * own, earlier engine-generated ones are removed from the main line, so an imported
 * Lichess analysis (or an earlier review) never mixes with the new one:
 * - `[%eval]` on every main-line move;
 * - move-quality NAGs ($1–$6: !, ?, !!, ??, !?, ?!);
 * - engine comments: Lichess's `(0.20 → 1.10) Mistake. Nc3 was best.` (lila
 *   `Advice.makeComment`) and this app's own `Review: …` text;
 * - the engine variation after a commented move: a variation of that move whose first
 *   move is the one the comment names as best.
 * Everything else stays: human comments, clock tags, other NAGs, other variations.
 */

/** Marks the app's own review text inside a comment; everything after it is review text. */
export const REVIEW_COMMENT_MARKER = 'Review:';

const MOVE_QUALITY_NAGS = new Set([1, 2, 3, 4, 5, 6]);

/** lila `Advice.makeComment`: optional "(before → after) ", the judgement, optional "X was best." */
const LICHESS_ADVICE =
  /(?:\([^()]*?→[^()]*?\)\s*)?(?:Inaccuracy|Mistake|Blunder|Checkmate is now unavoidable|Lost forced checkmate sequence|Not the best checkmate sequence)\.(?:\s+(\S+) was best\.)?/g;

/** This app's review text: from the marker to the end of the comment. */
const OWN_REVIEW = /(?:^|\s)(?:—\s*)?Review:(.*)$/s;

/** SAN moves inside the app's review text (its best-line variation starts with one). */
const SAN_TOKEN = /(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?|O-O(?:-O)?)[+#]?/g;

export interface StrippedComment {
  /** The comment without engine text, whitespace tidied. */
  human: string;
  /** Moves the removed engine text named as best (SAN). */
  bestMoves: string[];
}

export function stripEngineComment(comment: string): StrippedComment {
  const bestMoves: string[] = [];
  let text = comment.replace(LICHESS_ADVICE, (_match, best: string | undefined) => {
    if (best) bestMoves.push(best);
    return ' ';
  });
  const own = OWN_REVIEW.exec(text);
  if (own) {
    bestMoves.push(...((own[1] ?? '').match(SAN_TOKEN) ?? []));
    text = text.slice(0, own.index);
  }
  return { human: text.replace(/\s+/g, ' ').trim(), bestMoves };
}

/** Appends review text to a node's human comment, behind the marker. */
export function withReviewComment(human: string, review: string): string {
  if (!review) return human;
  return human ? `${human} — ${REVIEW_COMMENT_MARKER} ${review}` : `${REVIEW_COMMENT_MARKER} ${review}`;
}

export interface StripResult {
  evals: number;
  nags: number;
  comments: number;
  variations: number;
}

/**
 * Removes earlier engine annotations from the tree's main line (see above). Returns what
 * was removed. The tree is changed in place; its current node is kept unless it was in a
 * removed variation, in which case the tree moves to that variation's parent.
 */
export function stripEngineAnnotations(tree: GameTree): StripResult {
  const result: StripResult = { evals: 0, nags: 0, comments: 0, variations: 0 };
  const root = tree.root;
  const rootStripped = stripEngineComment(root.comment);
  if (rootStripped.human !== root.comment.trim()) {
    tree.setComment(root.id, rootStripped.human);
    result.comments++;
  }

  for (const node of tree.getMainLine()) {
    if (node.eval) {
      tree.setEval(node.id, undefined);
      result.evals++;
    }
    const keptNags = node.nags.filter((n) => !MOVE_QUALITY_NAGS.has(n));
    if (keptNags.length !== node.nags.length) {
      result.nags += node.nags.length - keptNags.length;
      tree.setNags(node.id, keptNags);
    }
    if (node.classification) tree.setClassification(node.id, undefined);

    const stripped = stripEngineComment(node.comment);
    if (stripped.human !== node.comment.trim()) {
      tree.setComment(node.id, stripped.human);
      result.comments++;
    }
    if (stripped.bestMoves.length > 0 && node.parentId) {
      result.variations += removeBestMoveVariations(tree, node, stripped.bestMoves);
    }
  }
  return result;
}

function removeBestMoveVariations(tree: GameTree, node: GameNode, bestMoves: string[]): number {
  const parent = tree.getNode(node.parentId!);
  if (!parent) return 0;
  const wanted = new Set(bestMoves.map((san) => san.replace(/[+#!?]+$/, '')));
  let removed = 0;
  for (const sibling of [...parent.children]) {
    if (sibling.id === node.id) continue;
    if (!wanted.has(sibling.san.replace(/[+#!?]+$/, ''))) continue;
    const current = tree.currentNodeId;
    const inside = tree.getLineToNode(current).some((n) => n.id === sibling.id);
    if (tree.deleteNode(sibling.id)) {
      removed++;
      if (inside) tree.goToNode(parent.id);
    }
  }
  return removed;
}
