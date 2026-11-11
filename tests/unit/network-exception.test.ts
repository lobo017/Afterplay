import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The website's one network exception (AGENTS.md): the Chess.com sync, on its button. These checks read the source, so
// a second place that asks another host for something cannot slip in unnoticed.
const SRC = path.resolve(__dirname, '..', '..', 'src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

const files = sourceFiles(SRC).map((file) => ({
  name: path.relative(SRC, file).split(path.sep).join('/'),
  text: fs.readFileSync(file, 'utf8'),
}));
const filesWith = (pattern: RegExp) =>
  files
    .filter((f) => pattern.test(f.text))
    .map((f) => f.name)
    .sort();

describe('The network exception is one address, in one place', () => {
  it('reads every source file', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('only the sync’s archive module names the API host', () => {
    expect(filesWith(/api\.chess\.com/i)).toEqual(['sync/chesscom-archive.ts']);
  });

  it('fetch is called only by the service worker, the first-run link (same origin) and the sync', () => {
    expect(filesWith(/\bfetch\(/)).toEqual(['preset/first-run.ts', 'sw.ts', 'sync/chesscom-sync.ts']);
  });

  it('nothing else can reach a network', () => {
    expect(filesWith(/XMLHttpRequest|new WebSocket|EventSource|sendBeacon|importScripts\(/)).toEqual([]);
  });

  it('the sync is started from the Settings button and nowhere else', () => {
    expect(filesWith(/\brunChessComSync\(/)).toEqual(['app.ts', 'sync/chesscom-sync.ts']);
    const app = files.find((f) => f.name === 'app.ts')!.text;
    expect(app.match(/runChessComSync\(/g)).toHaveLength(1);
    // In app.ts the call sits inside the data section's runSync, which only the button's click handler calls
    expect(app).toMatch(/runSync: async \(onProgress, signal\) => \{[^]*?runChessComSync\(/);
    const section = files.find((f) => f.name === 'ui/settings-data-section.ts')!.text;
    expect(section.match(/options\.runSync\(/g)).toHaveLength(1);
    expect(section).toMatch(/syncButton\.addEventListener\('click'/);
  });
});
