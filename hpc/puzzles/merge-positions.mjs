// Merges the shards of the mistake-puzzle search into the output file and its counts.
//
//   node hpc/puzzles/merge-positions.mjs --input <restore-phased.json> --dir <work folder> --shards <n>
//        [--out <file>] [--allow-partial]
//
// Reads <dir>/parts/part-<k>-of-<n>.jsonl for every shard, checks that they are one run of this input (same first line),
// that every chosen game has exactly one line, and writes
//   <out>                  puzzles.json (default <dir>/puzzles.json): schema version, a short hash of the input, the entries
//   <out without .json>.counts.json   counts only: games, left out by reason, chosen, kept, dropped by reason, classes
// Each file is written whole (through a temporary file and a rename). Without --allow-partial a missing part or a game
// with no line is an error and nothing is written. The input is never written. The log has counts only.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { makeDirGuard, writeThroughRename } from '../history/lib/reviews.mjs';
import { loadApp } from './lib/app.mjs';
import { mergeParts, partFileName, selectGames, sha256Hex } from './lib/positions.mjs';

function option(name, required = false) {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (required && !value) throw new Error(`usage: --${name} is required`);
  return value;
}

async function main() {
  const inputFile = path.resolve(option('input', true));
  const dir = option('dir', true);
  const shards = Number(option('shards', true));
  const allowPartial = process.argv.includes('--allow-partial');
  if (!Number.isInteger(shards) || shards < 1) throw new Error('--shards must be a whole number');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('the work folder does not exist');
  const guard = makeDirGuard(dir);
  const out = path.resolve(option('out') ?? guard('puzzles.json'));
  if (out === inputFile) throw new Error('--out is the input file');
  const countsOut = out.replace(/\.json$/, '') + '.counts.json';

  const inputText = fs.readFileSync(inputFile, 'utf8');
  const input = sha256Hex(inputText);
  const games = JSON.parse(inputText).games;
  if (!Array.isArray(games)) throw new Error('the input has no games list');

  const parts = [];
  for (let k = 0; k < shards; k++) {
    const file = guard(partFileName(k, shards));
    if (fs.existsSync(file)) parts.push(fs.readFileSync(file, 'utf8'));
  }

  const app = await loadApp();
  try {
    const selection = selectGames(games, app.deps);
    const { text, counts, countsText } = mergeParts({
      parts,
      candidates: selection.candidates,
      selection,
      input,
      shards,
      allowPartial,
    });
    const protect = [inputFile];
    writeThroughRename(fs, out, text, { protect });
    writeThroughRename(fs, countsOut, countsText, { protect });
    const dropped = Object.entries(counts.dropped)
      .filter(([, n]) => n > 0)
      .map(([r, n]) => `${n} ${r}`)
      .join(', ');
    console.log(
      `${parts.length} part file(s); ${counts.games} games, ${counts.selected} chosen, ${counts.kept} puzzles ` +
        `(${counts.classes.Mistake} Mistake, ${counts.classes.Blunder} Blunder, ${counts.mates} with a mate), ${counts.left} left; ` +
        `dropped: ${dropped || 'none'}; ${(counts.bytes / 1024).toFixed(1)} KiB`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(`mistake-puzzle merge failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
