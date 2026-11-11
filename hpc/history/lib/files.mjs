// File access shared by the history scripts: the folder they work in, the player's name and the raw monthly files.
//
//   <dir>/player.txt        the Chess.com username (one line; written by hand, see hpc/README.md)
//   <dir>/raw/YYYY-MM.json  one monthly archive each, as the API served it
//
// The player's name is read here and never printed.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { isValidUsername } from './history.mjs';

/** The folder given as `--dir <folder>`. */
export function historyDir() {
  const i = process.argv.indexOf('--dir');
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (!value) throw new Error('usage: --dir <history folder>');
  const dir = path.resolve(value);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('the history folder does not exist');
  return dir;
}

export function readPlayer(dir) {
  const file = path.join(dir, 'player.txt');
  if (!fs.existsSync(file)) throw new Error('player.txt is missing in the history folder');
  const name = fs.readFileSync(file, 'utf8').trim();
  if (!isValidUsername(name)) throw new Error('player.txt does not hold one valid username');
  return name;
}

/** Every monthly file, oldest first. A file that is not JSON with a games list is reported, not skipped silently. */
export function readRawArchives(dir) {
  const raw = path.join(dir, 'raw');
  const names = fs.existsSync(raw)
    ? fs
        .readdirSync(raw)
        .filter((n) => /^\d{4}-\d{2}\.json$/.test(n))
        .sort()
    : [];
  const archives = [];
  const unreadable = [];
  let bytes = 0;
  for (const name of names) {
    const month = name.slice(0, 7);
    const text = fs.readFileSync(path.join(raw, name), 'utf8');
    bytes += Buffer.byteLength(text);
    try {
      const games = JSON.parse(text).games;
      if (!Array.isArray(games)) throw new Error('no games list');
      archives.push({ month, games });
    } catch {
      unreadable.push(month);
    }
  }
  return { archives, unreadable, files: names.length, bytes };
}

/** Writes a file in one step (a reader never sees half of it). */
export function writeWhole(file, text) {
  const part = `${file}.part`;
  fs.writeFileSync(part, text);
  fs.renameSync(part, file);
  return Buffer.byteLength(text);
}
