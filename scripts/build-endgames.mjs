import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '..', 'data');
const outPath = path.join(dataDir, 'endgames.json');

/**
 * Hand-curated fundamental endgame positions per docs/SPEC.md:
 * - K+Q v K
 * - K+R v K
 * - K+P opposition
 * - Lucena
 * - Philidor
 * - R+P v R
 *
 * The player always has the move. `optimalMoves` is the engine's mate distance (the player's
 * moves against the best defence) and is only set where the drill ends in checkmate; positions
 * without a move count (null) track only whether the target result was reached.
 * tests/unit/endgame-data.test.ts checks every entry with Stockfish, and the three mate counts also
 * against exact distances from a retrograde solver. The first draft of this file had K+Q v K as
 * 10 and K+R v K as 16 (the worst cases over all positions, not these ones) and an R+P v R
 * position that is a draw. The engine's mate distance only settles deep (K+Q v K reads 8 at
 * depth 44 and 7 from 50; K+P v K 12 at depth 50-80 and 11 from 100), so re-run that test after
 * changing anything here.
 */
const ENDGAME_POSITIONS = [
  {
    id: 'kq-vs-k',
    title: 'King & Queen vs King',
    category: 'K+Q v K',
    fen: '8/8/8/4k3/8/8/8/3QK3 w - - 0 1',
    sideToMove: 'w',
    targetResult: '1-0',
    optimalMoves: 7,
    description:
      'Drive the lone Black king to the edge of the board using the queen and king in tandem, avoiding stalemate traps.',
  },
  {
    id: 'kr-vs-k',
    title: 'King & Rook vs King',
    category: 'K+R v K',
    fen: '8/8/8/4k3/8/8/8/3RK3 w - - 0 1',
    sideToMove: 'w',
    targetResult: '1-0',
    optimalMoves: 14,
    description:
      'Use the rook to cut off ranks or files and combine with the king opposition to force checkmate on the edge.',
  },
  {
    id: 'kp-opposition',
    title: 'King & Pawn vs King — Direct Opposition',
    category: 'K+P opposition',
    fen: '4k3/8/4K3/4P3/8/8/8/8 w - - 0 1',
    sideToMove: 'w',
    targetResult: '1-0',
    optimalMoves: 11,
    description:
      'With the White king already on the 6th rank in front of the pawn, outflank the Black king to escort the e-pawn to promotion, then mate.',
  },
  {
    id: 'lucena-position',
    title: 'Lucena Position — Building a Bridge',
    category: 'Lucena',
    fen: '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1',
    sideToMove: 'w',
    targetResult: '1-0',
    optimalMoves: null,
    description:
      'Build the bridge: bring the rook to the 4th rank (Rc4, or Rd1+ and Rd4) to shield the king from the checks, step out and promote the b-pawn.',
  },
  {
    id: 'philidor-position',
    title: 'Philidor Position — Third-Rank Defense',
    category: 'Philidor',
    fen: '4k3/8/8/4PK2/8/r7/8/4R3 b - - 0 1',
    sideToMove: 'b',
    targetResult: '1/2-1/2',
    optimalMoves: null,
    description:
      'Hold the draw as Black by patrolling the 6th rank (1...Ra6!) until the pawn advances to e6, then switch to rear checks from the 1st rank.',
  },
  {
    id: 'rp-vs-r',
    title: 'Rook & Pawn vs Rook — Cut-off King',
    category: 'R+P v R',
    fen: '7k/8/4P3/3K4/8/8/r7/5R2 w - - 0 1',
    sideToMove: 'w',
    targetResult: '1-0',
    optimalMoves: null,
    description:
      "White's rook cuts the Black king off on the f-file. Push the supported e-pawn to e7 and use the rook's checks to promote it or win Black's rook.",
  },
];

async function main() {
  await fs.mkdir(dataDir, { recursive: true });

  for (const pos of ENDGAME_POSITIONS) {
    const chess = new Chess(pos.fen);
    if (chess.turn() !== pos.sideToMove) {
      throw new Error(`Invalid sideToMove for ${pos.id}: expected ${pos.sideToMove}`);
    }
    if (chess.isGameOver()) {
      throw new Error(`Endgame position ${pos.id} is already game over: ${pos.fen}`);
    }
    if (chess.moves().length === 0) {
      throw new Error(`Endgame position ${pos.id} has no legal moves: ${pos.fen}`);
    }
  }

  await fs.writeFile(outPath, JSON.stringify(ENDGAME_POSITIONS, null, 2), 'utf8');
  console.log(`Validated and wrote ${ENDGAME_POSITIONS.length} endgame positions to ${outPath}`);
}

main().catch((err) => {
  console.error('Error building endgames dataset:', err);
  process.exit(1);
});
