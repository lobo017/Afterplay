// Builds a restore file from the downloaded monthly archives of one player (hpc/history/download.mjs):
//
//   node hpc/history/build-restore.mjs --dir <history folder>
//
// <dir>/restore.json is a backup in the app's own format, so Settings > Your data > Restore accepts it. Every game goes
// through the app's own PGN check and record builder (loaded from src/ through Vite, as scripts/verify-puzzles.mjs
// does), so a record is what the app would have stored had it imported the game itself. Games only: no settings,
// reviews or puzzles. <dir>/restore-summary.txt says how many games were written and how many were left out, by reason.
// The log gets counts only.
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { historyDir, readPlayer, readRawArchives, writeWhole } from './lib/files.mjs';
import { buildRestorePayload, collectGames, formatBytes, formatRestoreSummary } from './lib/history.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main() {
  const dir = historyDir();
  const player = readPlayer(dir);
  const { archives, unreadable, files } = readRawArchives(dir);
  if (files === 0) throw new Error('no monthly files in raw/: run the download first');
  if (unreadable.length > 0) throw new Error(`monthly files that could not be read: ${unreadable.join(', ')}`);
  const { games } = collectGames(archives);

  // No config file (the modules used here need none of its plugins) and no file watching (nothing changes)
  const vite = await createServer({
    root: rootDir,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { checkPgnText, importProblemOf } = await vite.ssrLoadModule('/src/capture/pgn-games.ts');
    const { buildGameRecord } = await vite.ssrLoadModule('/src/library/game-record.ts');
    const { LATEST_SCHEMA_VERSION } = await vite.ssrLoadModule('/src/storage/db.ts');

    const result = buildRestorePayload(
      games,
      player,
      { checkPgnText, importProblemOf, buildGameRecord, schemaVersion: LATEST_SCHEMA_VERSION },
      Date.now(),
    );
    const bytes = writeWhole(path.join(dir, 'restore.json'), JSON.stringify(result.payload));
    writeWhole(path.join(dir, 'restore-summary.txt'), formatRestoreSummary(result, bytes));

    const left = Object.values(result.skipped).reduce((n, v) => n + v, 0);
    console.log(`games read: ${result.read}, written: ${result.written}, left out: ${left}`);
    console.log(`restore.json: ${formatBytes(bytes)}`);
    if (result.written === 0) throw new Error('no game was written');
  } finally {
    await vite.close();
  }
}

main().catch((err) => {
  console.error(`history restore build failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
