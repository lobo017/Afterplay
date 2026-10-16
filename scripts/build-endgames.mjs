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
 */
const ENDGAME_POSITIONS = [
  {
    id: 'kq-vs-k',
    title: 'King & Queen vs King',
    category: 'K+Q v K',
    fen: '8/8/8/4k3/8/8/8/3QK3 w - - 0 1',
    sideToMove: 'w',
    targetResult: '1-0',
    optimalMoves: 10,
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
    optimalMoves: 16,
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
      'With the White king already on the 6th rank in front of the pawn, outflank the Black king to escort the e-pawn to promotion.',
  },
  {
    id: 'lucena-position',
    title: 'Lucena Position — Building a Bridge',
    category: 'Lucena',
    fen: '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1',
    sideToMove: 'w',
    targetResult: '1-0',
    optimalMoves: 14,
    description:
      'Force promotion by placing the White rook on the 4th rank (1.Rc4) to shield the king from vertical checks when stepping out.',
  },
  {
    id: 'philidor-position',
    title: 'Philidor Position — Third-Rank Defense',
    category: 'Philidor',
    fen: '4k3/8/8/4PK2/8/r7/8/4R3 b - - 0 1',
    sideToMove: 'b',
    targetResult: '1/2-1/2',
    optimalMoves: 15,
    description:
      'Hold the draw as Black by patrolling the 6th rank (1...Ra6!) until the pawn advances to e6, then switch to rear checks from the 1st rank.',
  },
  {
    id: 'rp-vs-r',
    title: 'Rook & Pawn vs Rook — Practical Endgame',
    category: 'R+P v R',
    fen: '3k4/8/3KP3/8/8/8/r7/4R3 w - - 0 1',
    sideToMove: 'w',
    targetResult: '1-0',
    optimalMoves: 16,
    description:
      'Cut off the Black king and transition into a winning Lucena setup to convert the extra passed e-pawn.',
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
