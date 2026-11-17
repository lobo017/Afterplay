// One shard of the mistake-puzzle search: for each chosen game of the player, the engine's best move at the player's
// stored worst move.
//
//   node hpc/puzzles/mine-positions.mjs --input <restore-phased.json> --dir <work folder> --shard <k> --shards <n>
//        --commit <40 hex> [--stop-after-minutes <m>] [--limit <games>]
//
// <input> is read once (hashed, never written). Every file written is under <dir>/parts/ and goes through a path guard.
// Per game: replay to the stored worst move, search the position before it (depth 18, 2 lines), then, only when the
// position is worth a puzzle, search the position after the played move (1 line) to measure the loss. The part file is
// appended game by game, so a stopped or killed run resumes where it was (a game cut short is simply done again).
// The log has counts and timings only: never an id, a name or a move.
//
// Exit codes: 0 every game of the shard is done; 3 stopped at --stop-after-minutes (or --limit) with games left (run the
// same line again); 1 an error, or the engine failed twice on a game (no line is written for it).
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createNodeStockfishTransport } from '../../scripts/lib/node-stockfish.mjs';
import { makeDirGuard, writeThroughRename } from '../history/lib/reviews.mjs';
import { loadApp } from './lib/app.mjs';
import {
  SETTINGS,
  dropLine,
  finishPuzzle,
  judgeBefore,
  partFileName,
  puzzleLine,
  resumePlan,
  selectGames,
  sha256Hex,
  shardOf,
} from './lib/positions.mjs';

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
  const inputFile = path.resolve(option('input', true));
  const dir = option('dir', true);
  const shard = intOption('shard', true);
  const shards = intOption('shards', true);
  const commit = option('commit', true);
  const stopMinutes = intOption('stop-after-minutes');
  const limit = intOption('limit');
  if (shards < 1 || shard >= shards) throw new Error('--shard must be below --shards');
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('--commit must be the full 40-character hash');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('the work folder does not exist');
  const guard = makeDirGuard(dir);
  const startedAt = Date.now();

  const inputText = fs.readFileSync(inputFile, 'utf8');
  const input = sha256Hex(inputText);
  const games = JSON.parse(inputText).games;
  if (!Array.isArray(games)) throw new Error('the input has no games list');

  const app = await loadApp();
  let engine = null;
  try {
    const selection = selectGames(games, app.deps);
    const mine = shardOf(selection.candidates, shard, shards);
    const plans = new Map(mine.map((p) => [p.id, p]));
    console.log(
      `shard ${shard} of ${shards}: ${games.length} games in the input, ${selection.candidates.length} chosen, ${mine.length} in this shard`,
    );

    const startEngine = async () => {
      engine?.terminate();
      engine = new app.EngineClient({
        variant: SETTINGS.variant,
        hashMb: SETTINGS.hashMb,
        transportFactory: () => createNodeStockfishTransport(),
      });
      await engine.init();
    };
    await startEngine();
    const expected = { input, engine: engine.getEngineName(), commit, shard, shards };

    fs.mkdirSync(guard('parts'), { recursive: true });
    const partPath = guard(partFileName(shard, shards));
    const existing = fs.existsSync(partPath) ? fs.readFileSync(partPath, 'utf8') : '';
    const plan = resumePlan({ text: existing, expected, ids: mine.map((p) => p.id) });
    if (plan.rewrite) writeThroughRename(fs, partPath, plan.cleanText, { protect: [inputFile] });
    console.log(`${plan.done.size} already done, ${plan.todo.length} to do${plan.resumed ? ' (resumed)' : ''}`);

    const counts = { kept: 0, dropped: 0, searches: 0, engineMs: 0 };
    let stopped = false;
    let failed = false;
    const search = async (game, request) => {
      const t0 = performance.now();
      const result = await engine.analyze({
        fen: game.rootFen,
        depth: SETTINGS.depth,
        priority: 'review',
        useCache: false,
        ...request,
      });
      counts.engineMs += performance.now() - t0;
      counts.searches++;
      return result;
    };
    for (const id of plan.todo) {
      if (limit !== undefined && counts.kept + counts.dropped >= limit) {
        stopped = true;
        break;
      }
      if (stopMinutes !== undefined && Date.now() - startedAt >= stopMinutes * 60_000) {
        stopped = true;
        break;
      }
      const game = plans.get(id);
      // Two tries; the second on a fresh engine process
      let line = null;
      let isPuzzle = false;
      for (let attempt = 0; attempt < 2 && line === null; attempt++) {
        try {
          if (attempt > 0) await startEngine();
          await engine.newGame();
          const before = await search(game, {
            moves: game.ucis.slice(0, game.ply - 1),
            multipv: SETTINGS.multipv,
            resetGame: true,
          });
          const first = judgeBefore(game, { lines: before.lines }, app.deps);
          if (!first.keep) {
            line = dropLine(id, first.reason);
            continue;
          }
          const after = await search(game, { moves: game.ucis.slice(0, game.ply), multipv: 1 });
          // The after position is scored for the side to move, the opponent: the winning chances are read from there
          const second = finishPuzzle(game, first.kept, after.lines[0]?.score ?? null, app.deps);
          isPuzzle = second.keep;
          line = second.keep ? puzzleLine(second.entry) : dropLine(id, second.reason);
        } catch {
          line = null;
        }
      }
      if (line === null) {
        console.error(
          `the engine failed twice on game ${mine.findIndex((p) => p.id === id) + 1} of ${mine.length} in shard ${shard}; ` +
            'no line was written for it',
        );
        failed = true;
        break;
      }
      fs.appendFileSync(partPath, `${line}\n`);
      if (isPuzzle) counts.kept++;
      else counts.dropped++;
    }

    const perSearch = counts.searches > 0 ? (counts.engineMs / 1000 / counts.searches).toFixed(2) : 'n/a';
    const left = plan.todo.length - counts.kept - counts.dropped;
    console.log(
      `kept ${counts.kept}, dropped ${counts.dropped}, left ${left}${stopped ? ' (stopped: run the same line again)' : ''}${failed ? ' (stopped: the engine failed twice on one game)' : ''}; ` +
        `${counts.searches} positions, ${perSearch} s per position, ${((Date.now() - startedAt) / 60000).toFixed(1)} min`,
    );
    if (failed) process.exitCode = 1;
    else if (stopped && left > 0) process.exitCode = 3;
  } finally {
    engine?.terminate();
    await app.close();
  }
}

main().catch((err) => {
  console.error(`mistake-puzzle search failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
