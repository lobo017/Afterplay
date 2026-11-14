// Merges the part files of the engine review into a new restore file:
//
//   node hpc/history/merge-reviews.mjs --dir <history folder> --chunks <n> [--out <path>] [--allow-partial]
//
// Reads <dir>/restore.json and <dir>/engine/part-<k>-of-<n>.jsonl for k = 0..n-1 (every part must exist), and writes the
// result (default <dir>/restore-reviewed.json) through a temporary file and a rename. restore.json and the part files are
// never written. All the merge rules live in hpc/history/lib/reviews.mjs (mergeReviews); this script only reads, calls
// it and writes. A part whose first line holds settings other than SETTINGS (hpc/history/lib/settings.mjs) is refused.
// The log gets counts only: no ids, names or game text.
//
// Not done here: the app's import test on the merged file. That is a separate step, run after the merge.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { makeDirGuard, mergeReviews, parsePart, partFileName, sha256Hex, writeThroughRename } from './lib/reviews.mjs';
import { SETTINGS } from './lib/settings.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function option(name, required = false) {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (required && (!value || value.startsWith('--'))) throw new Error(`usage: --${name} is required`);
  return value;
}

async function main() {
  const dir = option('dir', true);
  const chunks = Number(option('chunks', true));
  const outOption = option('out');
  const allowPartial = process.argv.includes('--allow-partial');
  if (!Number.isInteger(chunks) || chunks < 1) throw new Error('--chunks must be a positive whole number');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('the history folder does not exist');
  const guard = makeDirGuard(dir); // every path below comes from this

  const inputPath = guard('restore.json');
  const partPaths = Array.from({ length: chunks }, (_, k) => guard(partFileName(k, chunks)));
  const outPath = guard(outOption ?? 'restore-reviewed.json');
  const protect = [inputPath, ...partPaths];

  const absent = partPaths.filter((p) => !fs.existsSync(p)).length;
  if (absent > 0) throw new Error(`${absent} of ${chunks} part files are missing: refusing to merge`);

  const inputText = fs.readFileSync(inputPath, 'utf8');
  const payload = JSON.parse(inputText);
  const parts = partPaths.map((p) => ({ text: fs.readFileSync(p, 'utf8') }));

  // Each part must be the one its file name says. The settings are not read from a part: mergeReviews compares every
  // part's settings, by value, with SETTINGS below and refuses any that differ. The engine's name is the one thing only
  // the parts know (it comes from the engine at run time), so the first part's is expected of all of them.
  const heads = parts.map((p) => parsePart(p.text).header);
  heads.forEach((h, k) => {
    if (h === null) throw new Error(`part file ${k} has no first line`);
    if (h.chunk !== k || h.chunks !== chunks) throw new Error(`part file ${k} is not chunk ${k} of ${chunks}`);
  });
  const expected = { input: sha256Hex(inputText), settings: SETTINGS, engine: heads[0].engine };

  // The same module path and server options as review-games.mjs, so the move lists are the ones it hashed
  const vite = await createServer({
    root: rootDir,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { parsePgn } = await vite.ssrLoadModule('/src/core/pgn.ts');
    const movesOf = (game) => {
      try {
        return parsePgn(game.pgn)
          .getMainLine()
          .map((n) => n.san);
      } catch {
        throw new Error('a reviewed game could not be read again'); // never the game's text
      }
    };
    const result = mergeReviews({ payload, parts, expected, movesOf, now: Date.now(), allowPartial });
    const bytes = writeThroughRename(fs, outPath, result.text, { protect });

    const skipped = Object.entries(result.skipped).map(([reason, n]) => `${n} ${reason}`);
    console.log(
      `merged ${result.reviewed} games from ${result.parts} part files; ${result.missing} games without a line` +
        `${skipped.length > 0 ? `; skipped: ${skipped.join(', ')}` : ''}; ${(bytes / 1048576).toFixed(2)} MiB`,
    );
    if (result.missing > 0) console.log('partial merge (--allow-partial): games without a line keep their record');
  } finally {
    await vite.close();
  }
}

main().catch((err) => {
  console.error(`engine review merge failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
