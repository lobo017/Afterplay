// Dev-time only (not part of the build, no network): adds the per-phase numbers to the reviewed games of a history file.
//
//   node scripts/history-phases.mjs [--dir gift.local/history]
//
// Reads <dir>/engine-parts/*.jsonl (the Juno engine review: per game the win% of every position and one class letter per
// move) and <dir>/restore-reviewed.json, replays every reviewed game to get the position before each move, and writes
// <dir>/restore-phased.json: the same file, with `phases` added to the player's side of each reviewed game's
// `analysis.sides` (src/review/phase-numbers.ts says what it holds). restore-reviewed.json, the part files and the
// start/<slug>/history.json are never written. Same inputs, same bytes. The log has counts and sizes only: no ids,
// names or game text.
//
// A game gets no `phases` (and is counted as excluded) when its numbers cannot be checked against its stored summary:
// the lists do not fit, or the moves or the blunder, mistake or miss counts do not add up. Nothing is guessed.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { MAX_RESTORE_BYTES, moveHash, parsePart, sha256Hex, writeThroughRename } from '../hpc/history/lib/reviews.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function option(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;

async function main() {
  const dir = path.resolve(rootDir, option('dir') ?? path.join('gift.local', 'history'));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('the history folder does not exist');
  const inputPath = path.join(dir, 'restore-reviewed.json');
  const outPath = path.join(dir, 'restore-phased.json');
  if (path.resolve(outPath) === path.resolve(inputPath)) throw new Error('refusing to write over the input');

  const inputText = fs.readFileSync(inputPath, 'utf8');
  const payload = JSON.parse(inputText);
  if (!Array.isArray(payload.games)) throw new Error('the input has no games list');

  const partsDir = path.join(dir, 'engine-parts');
  const lines = new Map();
  for (const name of fs
    .readdirSync(partsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()) {
    for (const e of parsePart(fs.readFileSync(path.join(partsDir, name), 'utf8')).entries) {
      if (e.kind === 'game') lines.set(e.id, e);
    }
  }

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
    const { phaseNumbers, totalPhases } = await vite.ssrLoadModule('/src/review/phase-numbers.ts');

    const counts = { reviewed: 0, phased: 0, excluded: 0, noLine: 0 };
    const phased = [];
    const games = payload.games.map((g) => {
      const side = g.analysis?.summaryOnly === true ? g.analysis.sides?.[g.playerColor] : undefined;
      if (!side) return g;
      const e = lines.get(g.id);
      counts.reviewed++;
      if (!e) {
        counts.noLine++;
        return g;
      }
      const tree = parsePgn(g.pgn);
      const main = tree.getMainLine();
      const fensBefore = main.map((n) => tree.getNode(n.parentId).fen);
      const numbers =
        e.hash === moveHash(main.map((n) => n.san))
          ? phaseNumbers({
              win: e.win,
              classes: e.classes,
              fensBefore,
              color: g.playerColor,
              firstMover: tree.root.fen.split(' ')[1] === 'b' ? 'b' : 'w',
            })
          : null;
      const sum = (k) => (numbers ? numbers.reduce((a, t) => a + t[k], 0) : -1);
      const fits =
        numbers !== null &&
        sum(0) === side.moves &&
        sum(2) === side.blunder &&
        sum(3) === side.mistake &&
        sum(4) === side.miss;
      if (!fits) {
        counts.excluded++;
        return g;
      }
      counts.phased++;
      phased.push(numbers);
      return {
        ...g,
        analysis: { ...g.analysis, sides: { ...g.analysis.sides, [g.playerColor]: { ...side, phases: numbers } } },
      };
    });

    const text = JSON.stringify({ ...payload, games });
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_RESTORE_BYTES)
      throw new Error(`the file would be ${bytes} bytes, above the limit of ${MAX_RESTORE_BYTES}`);
    writeThroughRename(fs, outPath, text, { protect: [inputPath] });

    console.log(
      `reviewed games ${counts.reviewed}: phases added to ${counts.phased}, excluded ${counts.excluded}, no engine line ${counts.noLine}`,
    );
    for (const t of totalPhases(phased)) {
      console.log(
        `${t.phase}: ${t.moves} moves in ${t.games} games, accuracy ${t.accuracy === null ? '-' : t.accuracy.toFixed(2)}, ` +
          `${t.blunders} blunders, ${t.mistakes} mistakes, ${t.misses} misses`,
      );
    }
    console.log(
      `input ${Buffer.byteLength(inputText)} bytes (${sha256Hex(inputText).slice(0, 8)}), output ${bytes} bytes (${kib(bytes)}, ` +
        `+${bytes - Buffer.byteLength(inputText)} bytes, ${sha256Hex(text).slice(0, 8)}), limit ${MAX_RESTORE_BYTES}`,
    );
  } finally {
    await vite.close();
  }
}

main().catch((err) => {
  console.error(`history phases failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
