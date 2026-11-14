// Reviews one chunk of a restore file at a fixed depth and appends one line per game to its part file:
//
//   node hpc/history/review-games.mjs --dir <history folder> --chunk <k> --chunks <n> --commit <sha>
//        [--stop-after-minutes <m>] [--limit <games>]
//
// <dir>/restore.json is read, never written. <dir>/engine/part-<k>-of-<n>.jsonl is the checkpoint (hpc/history/lib/reviews.mjs
// describes its lines). Runs the app's own ReviewRunner (loaded from src/ through Vite, as build-restore.mjs does) on the
// single-threaded Stockfish build through scripts/lib/node-stockfish.mjs, at depth 18. The log gets counts and timings only.
//
// Exit codes: 0 every game of the chunk is done; 3 stopped at --stop-after-minutes with games left (submit the same line
// again); 1 an error, or the engine failed twice on a game (stderr names its position in the chunk, never its id; no line
// is written for it and the run stops, so a resubmit retries it).
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createNodeStockfishTransport } from '../../scripts/lib/node-stockfish.mjs';
import {
  CLASS_LETTERS,
  chunkIds,
  gameLine,
  makeDirGuard,
  partFileName,
  resumePlan,
  sha256Hex,
  skipLine,
  moveHash,
  writeThroughRename,
} from './lib/reviews.mjs';
import { SETTINGS } from './lib/settings.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIN_PLIES = 10;
const round2 = (n) => Math.round(n * 100) / 100;

function option(name, required = false) {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (required && !value) throw new Error(`usage: --${name} is required`);
  return value;
}
function intOption(name, required = false) {
  const v = option(name, required);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a whole number`);
  return n;
}

async function main() {
  const dir = option('dir', true);
  const chunk = intOption('chunk', true);
  const chunks = intOption('chunks', true);
  const commit = option('commit', true);
  const stopMinutes = intOption('stop-after-minutes');
  const limit = intOption('limit');
  if (chunks < 1 || chunk >= chunks) throw new Error('--chunk must be below --chunks');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('the history folder does not exist');
  const guard = makeDirGuard(dir); // every path below comes from this
  const startedAt = Date.now();

  // The input: read once, hashed, never written
  const inputText = fs.readFileSync(guard('restore.json'), 'utf8');
  const input = sha256Hex(inputText);
  const games = JSON.parse(inputText).games;
  if (!Array.isArray(games)) throw new Error('restore.json has no games list');
  const byId = new Map(games.map((g) => [g.id, g]));
  const allIds = [...byId.keys()];
  const myIds = chunkIds(allIds, chunk, chunks);

  const vite = await createServer({
    root: rootDir,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  let engine = null;
  try {
    const { parsePgn } = await vite.ssrLoadModule('/src/core/pgn.ts');
    const { EngineClient } = await vite.ssrLoadModule('/src/engine/engine-client.ts');
    const { ReviewRunner } = await vite.ssrLoadModule('/src/review/review-runner.ts');
    const { summarizeReview } = await vite.ssrLoadModule('/src/review/summary.ts');
    const { lookupOpeningByFen } = await vite.ssrLoadModule('/src/analysis/opening-lookup.ts');
    const isBookPosition = (fen) => lookupOpeningByFen(fen) !== null;

    const startEngine = async () => {
      engine?.terminate();
      engine = new EngineClient({
        variant: SETTINGS.variant,
        hashMb: SETTINGS.hashMb,
        transportFactory: () => createNodeStockfishTransport(),
      });
      await engine.init();
      return new ReviewRunner(engine);
    };
    let runner = await startEngine();

    // The first line of the part file: this run's input, settings, engine and commit
    const expected = { input, settings: SETTINGS, engine: engine.getEngineName(), commit, chunk, chunks };
    const partPath = guard(partFileName(chunk, chunks));
    fs.mkdirSync(guard('engine'), { recursive: true });
    const existing = fs.existsSync(partPath) ? fs.readFileSync(partPath, 'utf8') : '';
    const plan = resumePlan({ text: existing, expected, ids: myIds }); // throws when the file is not this run's
    if (plan.rewrite) writeThroughRename(fs, partPath, plan.cleanText, { protect: [guard('restore.json')] });
    console.log(
      `chunk ${chunk} of ${chunks}: ${myIds.length} games, ${plan.done.size} already done, ${plan.todo.length} to do` +
        (plan.resumed ? ' (resumed)' : ''),
    );

    const counts = { reviewed: 0, skipped: 0, positions: 0, engineMs: 0 };
    let stoppedEarly = false;
    let engineFailed = false;
    for (const id of plan.todo) {
      if (limit !== undefined && counts.reviewed + counts.skipped >= limit) break;
      if (stopMinutes !== undefined && Date.now() - startedAt >= stopMinutes * 60_000) {
        stoppedEarly = true;
        break;
      }
      const game = byId.get(id);
      const skip = (reason) => {
        fs.appendFileSync(partPath, `${skipLine({ id, reason })}\n`);
        counts.skipped++;
      };

      let tree;
      try {
        tree = parsePgn(game.pgn);
      } catch {
        skip('the game could not be read');
        continue;
      }
      const moves = tree.getMainLine().map((n) => n.san);
      if (moves.length < MIN_PLIES) {
        skip(`under ${MIN_PLIES} plies`);
        continue;
      }
      const color = game.playerColor;
      if (color !== 'w' && color !== 'b') {
        skip('no player colour');
        continue;
      }

      // Two tries: a fresh engine process for the second
      let result = null;
      for (let attempt = 0; attempt < 2 && !result; attempt++) {
        try {
          if (attempt > 0) runner = await startEngine();
          await engine.newGame();
          const t0 = performance.now();
          result = await runner.run({ tree: parsePgn(game.pgn), isBookPosition, budget: { depth: SETTINGS.depth } });
          counts.engineMs += performance.now() - t0;
        } catch {
          result = null;
        }
      }
      if (!result) {
        // No line is written: the game stays to do, and a resubmit retries it
        console.error(
          `the engine failed twice on game ${myIds.indexOf(id) + 1} of ${myIds.length} in chunk ${chunk}; ` +
            'the game is not written and will be retried on resubmit',
        );
        engineFailed = true;
        break;
      }

      const review = result.review;
      const mine = (color === 'w' ? review.white : review.black).accuracy;
      if (mine === null || review.moves.length !== moves.length) {
        skip('no accuracy for the player');
        continue;
      }
      const first = review.moves[0];
      const whiteStart = first.color === 'w' ? first.winBefore : 100 - first.winBefore;
      counts.positions += review.moves.length + 1;
      fs.appendFileSync(
        partPath,
        `${gameLine({
          id,
          hash: moveHash(moves),
          summary: {
            ...summarizeReview(review, { side: color }),
            whiteAccuracy: color === 'w' ? round2(mine) : null,
            blackAccuracy: color === 'b' ? round2(mine) : null,
          },
          win: [whiteStart, ...review.moves.map((m) => m.whiteWinAfter)].map(round2),
          classes: review.moves.map((m) => CLASS_LETTERS[m.classification]).join(''),
        })}\n`,
      );
      counts.reviewed++;
    }

    const perPosition = counts.positions > 0 ? (counts.engineMs / 1000 / counts.positions).toFixed(2) : 'n/a';
    console.log(
      `reviewed ${counts.reviewed}, skipped ${counts.skipped}, left ${plan.todo.length - counts.reviewed - counts.skipped}` +
        `${stoppedEarly ? ' (stopped at the time limit: submit the same line again)' : ''}` +
        `${engineFailed ? ' (stopped: the engine failed twice on one game)' : ''}; ` +
        `${counts.positions} positions, ${perPosition} s per position, ${((Date.now() - startedAt) / 60000).toFixed(1)} min`,
    );
    if (engineFailed) process.exitCode = 1;
    else if (stoppedEarly) process.exitCode = 3;
  } finally {
    engine?.terminate();
    await vite.close();
  }
}

main().catch((err) => {
  console.error(`engine review failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
