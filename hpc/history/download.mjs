// Downloads one player's monthly game archives from Chess.com's public API:
//
//   node hpc/history/download.mjs --dir <history folder>
//
// The player is the name in <dir>/player.txt. Each month goes to <dir>/raw/YYYY-MM.json as served, one request at a
// time with 1 second before each (the API asks for reasonable use). A month that fails is tried once more at the end;
// if it fails again it is listed in <dir>/download-summary.txt and the rest is kept. If the archive list itself cannot
// be fetched the script stops with exit code 3: no other route is tried.
// Output is months, counts and HTTP statuses only: never a name, never a game.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { historyDir, readPlayer, writeWhole } from './lib/files.mjs';
import { downloadArchives, formatDownloadSummary } from './lib/history.mjs';

async function main() {
  const dir = historyDir();
  const username = readPlayer(dir);
  const raw = path.join(dir, 'raw');
  fs.mkdirSync(raw, { recursive: true });

  const result = await downloadArchives({
    username,
    fetchImpl: (url, init) => fetch(url, init),
    sleep: (ms) => sleep(ms),
    save: (month, text) => writeWhole(path.join(raw, `${month}.json`), text),
    log: (line) => console.log(line),
  });

  const summary = formatDownloadSummary(result);
  writeWhole(path.join(dir, 'download-summary.txt'), summary);
  // The per-month lines are already in the log above
  console.log(summary.split('\nPer month')[0]);
  if (!result.ok) process.exitCode = 3;
}

main().catch((err) => {
  // The message of an unexpected error could name a file path but never the player (see lib/history.mjs)
  console.error(`history download failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
