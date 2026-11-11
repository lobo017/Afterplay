// Reports on the downloaded monthly archives of one player (hpc/history/download.mjs):
//
//   node hpc/history/report.mjs --dir <history folder>
//
// Writes, all inside <dir>:
//   report.txt     games in total and per year, colours and results from the player's side, time controls, openings
//                  (ECO code and name), ratings over time, and every opponent with the number of games and the record
//   summary.txt    the same totals without any opponent's name
//   shortlist.txt  the opponents played most often (see shortlistOpponents)
// No file holds a move of any game. The log gets counts only.
import path from 'node:path';
import process from 'node:process';
import { historyDir, readPlayer, readRawArchives, writeWhole } from './lib/files.mjs';
import {
  collectGames,
  computeStats,
  formatBytes,
  formatReport,
  formatShortlist,
  formatSummary,
  shortlistOpponents,
} from './lib/history.mjs';

function main() {
  const dir = historyDir();
  const player = readPlayer(dir);
  const { archives, unreadable, files, bytes } = readRawArchives(dir);
  if (files === 0) throw new Error('no monthly files in raw/: run the download first');

  const { games, duplicates, malformed } = collectGames(archives);
  const stats = computeStats(games, player);
  const shortlist = shortlistOpponents(stats.opponents);

  const source = [
    '',
    `Source: ${files} monthly files (${formatBytes(bytes)}), ${games.length} different games`,
    `  listed twice and counted once: ${duplicates}; entries that are not a game: ${malformed}`,
    `  files that could not be read: ${unreadable.length > 0 ? unreadable.join(', ') : 'none'}`,
  ].join('\n');
  writeWhole(path.join(dir, 'report.txt'), formatReport(stats) + source + '\n');
  writeWhole(path.join(dir, 'summary.txt'), formatSummary(stats) + source + '\n');
  writeWhole(path.join(dir, 'shortlist.txt'), formatShortlist(shortlist));

  console.log(`monthly files: ${files} (${formatBytes(bytes)}), unreadable: ${unreadable.length}`);
  console.log(`games: ${games.length} (the player's: ${stats.mine}), listed twice: ${duplicates}`);
  console.log(`opponents: ${stats.opponents.length}, on the shortlist: ${shortlist.length}`);
  console.log('wrote report.txt, summary.txt and shortlist.txt');
  if (unreadable.length > 0) process.exitCode = 4;
}

try {
  main();
} catch (err) {
  console.error(`history report failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
