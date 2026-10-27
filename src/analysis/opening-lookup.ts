import openingsJson from '../../data/openings.json';
import { normalizeFenToEpd, type OpeningEntry, type OpeningsMap } from '../core/datasets';
import type { GameTree } from '../core/game-tree';

export const OPENINGS_BY_EPD: OpeningsMap = openingsJson as OpeningsMap;

/**
 * Looks up an opening entry by a 6-field FEN or 4-field EPD string.
 * Falls back to checking with `-` in the en-passant field if the exact 4-field EPD is not found.
 */
export function lookupOpeningByFen(fen: string): OpeningEntry | null {
  if (!fen || !fen.trim()) return null;
  const epd = normalizeFenToEpd(fen);
  const direct = OPENINGS_BY_EPD[epd];
  if (direct) {
    return direct;
  }

  const parts = epd.split(/\s+/);
  if (parts.length === 4 && parts[3] !== '-') {
    const withoutEp = `${parts[0]} ${parts[1]} ${parts[2]} -`;
    return OPENINGS_BY_EPD[withoutEp] ?? null;
  }

  return null;
}

/**
 * Resolves the most specific (deepest) opening reached along the path from the root
 * to `targetNodeId` (defaults to `tree.currentNodeId`).
 */
export function lookupGameOpening(tree: GameTree, targetNodeId?: string): OpeningEntry | null {
  const nodeId = targetNodeId ?? tree.currentNodeId;
  const rootMatch = lookupOpeningByFen(tree.root.fen);
  let latestOpening: OpeningEntry | null = rootMatch;

  const line = tree.getLineToNode(nodeId);
  for (const node of line) {
    const match = lookupOpeningByFen(node.fen);
    if (match) {
      latestOpening = match;
    }
  }

  return latestOpening;
}

/**
 * Formats an opening entry as `"ECO · Name"` (e.g. `"C65 · Ruy Lopez: Berlin Defense"`).
 */
export function formatOpeningBadge(opening: OpeningEntry | null): string {
  if (!opening) {
    return 'Starting Position';
  }
  return `${opening.eco} · ${opening.name}`;
}
