// Deep check of the bundled puzzles (data/puzzles.json) with the engine, in chunks:
//
//   node scripts/verify-puzzles.mjs --chunk 3 --chunks 20 [--out DIR]
//
// For every puzzle of the chunk (puzzle i belongs to chunk i % chunks, so each chunk has the same mix of themes
// and ratings):
//   1. the stored line must be well formed: the opponent's setup move and every solution move are legal and the
//      solution ends on a player move (the same check the app does when it loads a puzzle);
//   2. at each move of the player, Stockfish (single thread, fixed depth, MultiPV 2) must not find a clearly better
//      move than the stored one. The stored move passes when it is the engine's best, or when the app's own
//      alternative-move rule (src/trainers/puzzle-validation.ts: mates, forced mate, a decisive advantage, or within
//      the Excellent band of the engine's best) accepts it as just as good. A mate puzzle only accepts mates.
// Failures go to DIR/puzzles-chunk-K.jsonl (one JSON object per line), the totals to DIR/puzzles-chunk-K.json.
// --max-minutes N stops cleanly after N minutes (the totals then say complete:false). Fixed depth makes a run
// reproducible on the same engine build; WC_PUZZLE_DEPTH changes it (default 14).
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createNodeStockfishTransport } from './lib/node-stockfish.mjs';
import { installCleanup, killAllChildTrees } from './lib/process-guard.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPTH = Number(process.env.WC_PUZZLE_DEPTH || 14);
const HASH_MB = 32;

function numberArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  if (!Number.isFinite(n)) throw new Error(`--${name} needs a number`);
  return n;
}
function stringArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const CHUNKS = numberArg('chunks', 1);
const CHUNK = numberArg('chunk', 0);
const MAX_MINUTES = numberArg('max-minutes', 0);
const OUT_DIR = path.resolve(stringArg('out', path.join(rootDir, 'test-results', 'puzzles')));
if (!Number.isInteger(CHUNKS) || CHUNKS < 1 || !Number.isInteger(CHUNK) || CHUNK < 0 || CHUNK >= CHUNKS) {
  throw new Error(`--chunk must be 0..${CHUNKS - 1} (got chunk ${CHUNK} of ${CHUNKS})`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tag = `puzzles-chunk-${CHUNK}`;
  const failuresPath = path.join(OUT_DIR, `${tag}.jsonl`);
  const summaryPath = path.join(OUT_DIR, `${tag}.json`);
  fs.writeFileSync(failuresPath, '');

  const all = JSON.parse(fs.readFileSync(path.join(rootDir, 'data', 'puzzles.json'), 'utf8'));
  const mine = all.filter((_, i) => i % CHUNKS === CHUNK);

  const vite = await createServer({
    root: rootDir,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  const { RulesAdapter } = await vite.ssrLoadModule('/src/core/rules.ts');
  const { EngineClient } = await vite.ssrLoadModule('/src/engine/engine-client.ts');
  const { preparePuzzle } = await vite.ssrLoadModule('/src/trainers/puzzle-format.ts');
  const { judgeAlternative } = await vite.ssrLoadModule('/src/trainers/puzzle-validation.ts');

  const engine = new EngineClient({
    variant: 'single-threaded',
    hashMb: HASH_MB,
    transportFactory: () => createNodeStockfishTransport(),
  });
  await engine.init();

  const startedAt = Date.now();
  const totals = {
    chunk: CHUNK,
    chunks: CHUNKS,
    depth: DEPTH,
    puzzlesInChunk: mine.length,
    puzzlesChecked: 0,
    playerMovesChecked: 0,
    formatErrors: 0,
    engineBest: 0,
    acceptedAsGood: 0,
    failedMoves: 0,
    failedPuzzles: 0,
    complete: false,
    elapsedSec: 0,
  };
  const fail = (record) => fs.appendFileSync(failuresPath, `${JSON.stringify(record)}\n`);
  const writeSummary = () => {
    totals.elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    fs.writeFileSync(summaryPath, `${JSON.stringify(totals, null, 2)}\n`);
  };

  const { runCleanup } = installCleanup({
    log: (m) => console.error(m),
    cleanup: () => {
      writeSummary();
      killAllChildTrees();
    },
  });

  try {
    for (const entry of mine) {
      if (MAX_MINUTES > 0 && Date.now() - startedAt > MAX_MINUTES * 60_000) {
        console.log(`[stop] ${MAX_MINUTES} min limit reached after ${totals.puzzlesChecked} puzzles`);
        break;
      }
      totals.puzzlesChecked++;
      let prepared;
      try {
        prepared = preparePuzzle(entry);
      } catch (err) {
        totals.formatErrors++;
        totals.failedPuzzles++;
        fail({ id: entry.id, kind: 'format', message: String(err?.message ?? err) });
        continue;
      }

      const adapter = new RulesAdapter(prepared.startFen);
      let puzzleFailed = false;
      for (let i = 0; i < prepared.solution.length; i++) {
        const uci = prepared.solution[i];
        if (i % 2 === 0) {
          const fen = adapter.fen();
          totals.playerMovesChecked++;
          const res = await engine.analyze({ fen, depth: DEPTH, multipv: 2, useCache: false });
          const lines = [...res.lines].sort((a, b) => a.multipv - b.multipv);
          const best = lines[0];
          if (!best) {
            totals.failedMoves++;
            puzzleFailed = true;
            fail({ id: entry.id, kind: 'no-engine-line', ply: i, fen });
          } else if (best.pv[0] === uci) {
            totals.engineBest++;
          } else {
            // The stored move is not the engine's first choice: how good is it (search only that move)?
            const only = await engine.analyze({ fen, depth: DEPTH, multipv: 1, searchMoves: [uci], useCache: false });
            const moved = new RulesAdapter(fen);
            moved.move(uci);
            const verdict = judgeAlternative({
              givesMate: moved.isCheckmate(),
              altScore: only.lines[0]?.score ?? null,
              solutionScore: best.score,
              matePuzzle: prepared.endsInMate,
            });
            if (verdict.accepted) {
              totals.acceptedAsGood++;
            } else {
              totals.failedMoves++;
              puzzleFailed = true;
              fail({
                id: entry.id,
                kind: 'weaker-than-engine',
                ply: i,
                fen,
                stored: uci,
                storedScore: only.lines[0]?.score ?? null,
                engineMove: best.pv[0],
                engineScore: best.score,
                matePuzzle: prepared.endsInMate,
                rating: entry.rating,
                themes: entry.themes,
              });
            }
          }
        }
        adapter.move(uci);
      }
      if (puzzleFailed) totals.failedPuzzles++;

      if (totals.puzzlesChecked % 50 === 0) {
        const perPuzzle = (Date.now() - startedAt) / totals.puzzlesChecked / 1000;
        const left = Math.round(((mine.length - totals.puzzlesChecked) * perPuzzle) / 60);
        console.log(
          `[progress] ${totals.puzzlesChecked}/${mine.length} puzzles, ${totals.failedPuzzles} failed, ` +
            `${perPuzzle.toFixed(2)} s each, about ${left} min left`,
        );
        writeSummary();
      }
    }
    totals.complete = totals.puzzlesChecked === mine.length;
  } finally {
    engine.terminate();
    await vite.close();
  }

  writeSummary();
  console.log(JSON.stringify(totals, null, 2));
  runCleanup('done');
  // Any failed puzzle (or a run cut short) makes the job fail so it shows up. A weaker-than-engine move is a
  // finding to read, not automatically a broken puzzle: Lichess verified its puzzles with far deeper searches.
  process.exitCode = totals.failedPuzzles > 0 || !totals.complete ? 1 : 0;
}

main().catch((err) => {
  console.error('verify-puzzles failed:', err);
  process.exit(1);
});
