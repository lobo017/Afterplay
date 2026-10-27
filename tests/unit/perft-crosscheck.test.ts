import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_POSITION, RulesAdapter } from '../../src/core/rules';
import { EngineClient, SINGLE_THREADED_STOCKFISH_FILE, type EngineTransport } from '../../src/engine/engine-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stockfishJsPath = path.resolve(
  __dirname,
  '..',
  '..',
  'node_modules',
  'stockfish',
  'src',
  SINGLE_THREADED_STOCKFISH_FILE,
);

function createNodeStockfishTransport(): EngineTransport {
  const proc: ChildProcessWithoutNullStreams = spawn(process.execPath, [stockfishJsPath], { stdio: 'pipe' });
  const messageHandlers: Array<(line: string) => void> = [];
  const errorHandlers: Array<(err: Error) => void> = [];
  let stdoutBuffer = '';

  const flushLines = (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    let newlineIdx = stdoutBuffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = stdoutBuffer.slice(0, newlineIdx).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      if (line) {
        for (const h of messageHandlers) {
          h(line);
        }
      }
      newlineIdx = stdoutBuffer.indexOf('\n');
    }
  };

  proc.stdout.on('data', flushLines);
  proc.stderr.on('data', flushLines);
  proc.on('error', (err) => {
    for (const h of errorHandlers) {
      h(err);
    }
  });

  return {
    send(command: string) {
      proc.stdin.write(`${command}\n`);
    },
    onMessage(handler: (line: string) => void) {
      messageHandlers.push(handler);
    },
    onError(handler: (err: Error) => void) {
      errorHandlers.push(handler);
    },
    terminate() {
      proc.kill();
    },
  };
}

interface PerftCrossCheckCase {
  name: string;
  fen: string;
  chess960: boolean;
  depths: number[];
}

const STANDARD_POSITIONS: PerftCrossCheckCase[] = [
  {
    name: 'Standard Start Position (depths 1–4)',
    fen: DEFAULT_POSITION,
    chess960: false,
    depths: [1, 2, 3, 4],
  },
  {
    name: 'Kiwipete (depths 1–3)',
    fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    chess960: false,
    depths: [1, 2, 3],
  },
];

const CHESS960_STARTING_POSITIONS: PerftCrossCheckCase[] = [
  {
    name: 'SP #000 (BBQNNRKR - King g1, Rooks f1/h1, depths 1–4)',
    fen: 'bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w HFhf - 0 1',
    chess960: true,
    depths: [1, 2, 3, 4],
  },
  {
    name: 'SP #001 (BQNBNRKR - King g1, Rooks f1/h1, depths 1–3)',
    fen: 'bqnbnrkr/pppppppp/8/8/8/8/PPPPPPPP/BQNBNRKR w HFhf - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'SP #107 (QNRBBKNR - King f1, Rooks c1/h1, depths 1–3)',
    fen: 'qnrbbknr/pppppppp/8/8/8/8/PPPPPPPP/QNRBBKNR w HChc - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'SP #198 (RKQNBBRN - King b1, Rooks a1/g1, depths 1–4)',
    fen: 'rkqnbbrn/pppppppp/8/8/8/8/PPPPPPPP/RKQNBBRN w GAga - 0 1',
    chess960: true,
    depths: [1, 2, 3, 4],
  },
  {
    name: 'SP #284 (NRKBBQNR - King c1, Rooks b1/h1, depths 1–3)',
    fen: 'nrkbbqnr/pppppppp/8/8/8/8/PPPPPPPP/NRKBBQNR w HBhb - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'SP #356 (RNQBBKNR - King f1, Rooks a1/h1, depths 1–3)',
    fen: 'rnqbbknr/pppppppp/8/8/8/8/PPPPPPPP/RNQBBKNR w HAha - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'SP #491 (RBKNQNBR - King c1, Rooks a1/h1, depths 1–3)',
    fen: 'rbknqnbr/pppppppp/8/8/8/8/PPPPPPPP/RBKNQNBR w HAha - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'SP #518 (RNBQKBNR Shredder-FEN HAha, depths 1–3)',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w HAha - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'SP #614 (RQNBBKRN - King f1, Rooks a1/g1, depths 1–3)',
    fen: 'rqnbbkrn/pppppppp/8/8/8/8/PPPPPPPP/RQNBBKRN w GAga - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'SP #742 (NRBBNKQR - King f1, Rooks b1/h1, depths 1–3)',
    fen: 'nrbbnkqr/pppppppp/8/8/8/8/PPPPPPPP/NRBBNKQR w HBhb - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'SP #855 (QBNNRKBR - King f1, Rooks e1/h1, depths 1–3)',
    fen: 'qbnnrkbr/pppppppp/8/8/8/8/PPPPPPPP/QBNNRKBR w HEhe - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'SP #959 (RKRNNQBB - King b1, Rooks a1/c1, depths 1–4)',
    fen: 'rkrnnqbb/pppppppp/8/8/8/8/PPPPPPPP/RKRNNQBB w CAca - 0 1',
    chess960: true,
    depths: [1, 2, 3, 4],
  },
];

const HAND_BUILT_CHESS960_POSITIONS: PerftCrossCheckCase[] = [
  // 1. Castling blocked by attacked squares
  {
    name: 'Attacked king path: Bishop on c4 attacks f1, blocking O-O (c1->g1)',
    fen: '2kr3r/pppppppp/8/8/2b5/8/PPPP1PPP/2KR3R w HDhd - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'King in check: Bishop on c4 checks King on f1, blocking both O-O and O-O-O',
    fen: '1r3kr1/pppp1ppp/8/8/2b5/8/PPPP1PPP/1R3KR1 w GBgb - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'Attacked rook-only path: Bishop on e4 attacks b1 while King stays on c1 (O-O-O still legal)',
    fen: 'r1k4r/pppp1ppp/8/8/4b3/8/PPPP1PPP/R1K4R w HAha - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'Attacked queenside transit: Bishop on g4 attacks d1, blocking O-O-O while O-O stays legal',
    fen: '1r2k2r/pppp1ppp/8/8/6b1/8/PPPP1PPP/1R2K2R w HBhb - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },

  // 2. Castling rook shields the king from a check along the rank
  {
    name: 'Rank shield (X-FEN KQ): Rook on b1 shields e1/c1 from Black rook on a1 (O-O-O illegal)',
    fen: '4k3/8/8/8/8/8/PPPPPPPP/rR2K2R w KQ - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'Rank shield (King on c1, Rook on b1): Rook on b1 shields King on c1 from Black rook on a1',
    fen: '4k3/8/8/8/8/8/PPPPPPPP/rRK4R w HB - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'Rank shield (King on d1, Rook on b1): Rook on b1 shields c1 from Black rook on a1',
    fen: '4k3/8/8/8/8/8/PPPPPPPP/rR1K3R w HB - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'Rank shield (Kingside): Rook on f1 shields King on e1 from Black rook on h1',
    fen: '4k3/7p/8/8/8/8/PPPPPPPP/1R2KR1r w FB - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },

  // 3. King and rook swap or stay on their squares
  {
    name: 'King and Rook swap on O-O: King on f1 and Rook on g1 swap squares (f1<->g1)',
    fen: '1r3kr1/pppppppp/8/8/8/8/PPPPPPPP/1R3KR1 w GBgb - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'King and Rook swap on O-O-O: King on d1 and Rook on c1 swap squares (d1<->c1)',
    fen: '2rk2r1/pppppppp/8/8/8/8/PPPPPPPP/2RK2R1 w GCgc - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'King stays on g1 on O-O: King on g1 stays in place while Rook jumps h1->f1',
    fen: '1r4kr/pppppppp/8/8/8/8/PPPPPPPP/1R4KR w HBhb - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'King stays on c1 on O-O-O: King on c1 stays in place while Rook jumps a1->d1',
    fen: 'r1k4r/pppppppp/8/8/8/8/PPPPPPPP/R1K4R w HAha - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'Rook stays on d1 on O-O-O: Rook on d1 stays in place while King jumps e1->c1',
    fen: '3rk1r1/pppppppp/8/8/8/8/PPPPPPPP/3RK1R1 w GDgd - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'Rook stays on f1 on O-O: Rook on f1 stays in place while King jumps e1->g1',
    fen: '1r2kr2/pppppppp/8/8/8/8/PPPPPPPP/1R2KR2 w FBfb - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
  {
    name: 'Distinct Kg1 (f1g1) and O-O (f1h1): King on f1, g1 vacant, Rook on h1',
    fen: '1r3k1r/pppppppp/8/8/8/8/PPPPPPPP/1R3K1R w HBhb - 0 1',
    chess960: true,
    depths: [1, 2, 3],
  },
];

describe('Phase 2 — Perft Cross-Check: RulesAdapter vs Stockfish 17.1 WASM `go perft`', () => {
  let engine: EngineClient;

  beforeAll(async () => {
    engine = new EngineClient({
      variant: 'single-threaded',
      transportFactory: () => createNodeStockfishTransport(),
    });
    await engine.init();
  }, 20000);

  afterAll(() => {
    engine?.terminate();
  });

  describe('Standard positions (Start Position & Kiwipete)', () => {
    for (const tc of STANDARD_POSITIONS) {
      it(`matches Stockfish perft on ${tc.name}`, async () => {
        for (const depth of tc.depths) {
          const adapter = new RulesAdapter(tc.fen, { chess960: tc.chess960 });
          const adapterNodes = adapter.perft(depth);
          const sfResult = await engine.perft({
            fen: tc.fen,
            depth,
            chess960: tc.chess960,
          });
          expect(
            adapterNodes,
            `Mismatch on "${tc.name}" (${tc.fen}) at depth ${depth}: RulesAdapter=${adapterNodes} vs Stockfish=${sfResult.nodes}`,
          ).toBe(sfResult.nodes);
        }
      }, 25000);
    }
  });

  describe('12 Chess960 (Fischer Random) starting positions', () => {
    for (const tc of CHESS960_STARTING_POSITIONS) {
      it(`matches Stockfish UCI_Chess960 perft on ${tc.name}`, async () => {
        for (const depth of tc.depths) {
          const adapter = new RulesAdapter(tc.fen, { chess960: tc.chess960 });
          const adapterNodes = adapter.perft(depth);
          const sfResult = await engine.perft({
            fen: tc.fen,
            depth,
            chess960: tc.chess960,
          });
          expect(
            adapterNodes,
            `Mismatch on "${tc.name}" (${tc.fen}) at depth ${depth}: RulesAdapter=${adapterNodes} vs Stockfish=${sfResult.nodes}`,
          ).toBe(sfResult.nodes);
        }
      }, 25000);
    }
  });

  describe('Hand-built Chess960 castling edge cases (attacked paths, rank-shielding rooks, swap/stay)', () => {
    for (const tc of HAND_BUILT_CHESS960_POSITIONS) {
      it(`matches Stockfish UCI_Chess960 perft on ${tc.name}`, async () => {
        for (const depth of tc.depths) {
          const adapter = new RulesAdapter(tc.fen, { chess960: tc.chess960 });
          const adapterNodes = adapter.perft(depth);
          const sfResult = await engine.perft({
            fen: tc.fen,
            depth,
            chess960: tc.chess960,
          });
          expect(
            adapterNodes,
            `Mismatch on "${tc.name}" (${tc.fen}) at depth ${depth}: RulesAdapter=${adapterNodes} vs Stockfish=${sfResult.nodes}`,
          ).toBe(sfResult.nodes);
        }
      }, 15000);
    }
  });
});
