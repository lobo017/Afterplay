// Loads the app's own modules for the puzzle scripts (the same way hpc/history/review-games.mjs does): through a Vite
// server in middleware mode, so the TypeScript sources run unchanged and nothing is bundled or written.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Starts the loader; `close()` stops it. `deps` is what lib/positions.mjs needs, `EngineClient` the engine's client. */
export async function loadApp() {
  const vite = await createServer({
    root: rootDir,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const load = (file) => vite.ssrLoadModule(file);
  const [pgn, record, board, formulas, classification, client] = await Promise.all([
    load('/src/core/pgn.ts'),
    load('/src/library/game-record.ts'),
    load('/src/review/board.ts'),
    load('/src/review/formulas.ts'),
    load('/src/review/classification.ts'),
    load('/src/engine/engine-client.ts'),
  ]);
  return {
    deps: {
      parsePgn: pgn.parsePgn,
      isStandardGame: record.isStandardGame,
      applyUci: board.applyUci,
      lineToSan: board.lineToSan,
      winPercentFromScore: formulas.winPercentFromScore,
      CLASS_THRESHOLDS: classification.CLASS_THRESHOLDS,
      classFromWinDrop: classification.classFromWinDrop,
    },
    EngineClient: client.EngineClient,
    close: () => vite.close(),
  };
}
