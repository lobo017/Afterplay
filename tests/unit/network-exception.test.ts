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

  it('the sync is started from the Settings button or from Start import / Continue on the Story, and nowhere else', () => {
    expect(filesWith(/\brunChessComSync\(/)).toEqual(['app.ts', 'sync/chesscom-sync.ts']);
    const app = files.find((f) => f.name === 'app.ts')!.text;
    // One network call in the whole app, inside the one shared runner
    expect(app.match(/runChessComSync\(/g)).toHaveLength(1);
    expect(app).toMatch(/const runSharedSync = async[^]*?runChessComSync\(/);
    // The runner has two callers: the Settings button's runSync and the Story's runStoryImport
    expect(app.match(/runSharedSync\(/g)).toHaveLength(2);
    expect(app).toMatch(/runSync: async \(onProgress, signal\) => \{[^]*?runSharedSync\(/);
    expect(app).toMatch(/const runStoryImport = async[^]*?runSharedSync\(/);
    // runStoryImport is called from one place: the Story view's start handler
    expect(app.match(/runStoryImport\(/g)).toHaveLength(1);
    expect(app).toMatch(/onStartImport: \(\) => runStoryImport\(\)/);

    // Settings: one runSync call, in the button's click handler
    const section = files.find((f) => f.name === 'ui/settings-data-section.ts')!.text;
    expect(section.match(/options\.runSync\(/g)).toHaveLength(1);
    expect(section).toMatch(/syncButton\.addEventListener\('click'/);

    // Story: one onStartImport call (in runImport), which only the 'Start import' and 'Continue' clicks reach
    const story = files.find((f) => f.name === 'story/view.ts')!.text;
    expect(story.match(/options\.onStartImport\(/g)).toHaveLength(1);
    expect(story.match(/this\.runImport\(/g)).toHaveLength(1);
    expect(story).toMatch(/case 'start-import':\s*case 'import-continue':\s*void this\.runImport\(\)/);
    // Nothing else in the Story starts a run: no timer, no idle callback
    expect(story).not.toMatch(/setInterval|requestIdleCallback/);
  });
});

describe('The bots-only update asks only for the link’s own preset file', () => {
  const firstRun = files.find((f) => f.name === 'preset/first-run.ts')!.text;
  const buildId = files.find((f) => f.name === 'preset/build-id.ts')!.text;
  const app = files.find((f) => f.name === 'app.ts')!.text;

  it('is one function, called from one place in the app, and makes its request through the first run’s own same-origin fetch', () => {
    expect(filesWith(/\bcheckBotsUpdate\(/)).toEqual(['app.ts', 'preset/first-run.ts']);
    expect(app.match(/\bcheckBotsUpdate\(/g)).toHaveLength(1);
    // The request is the link's preset file, by the same default fetch as the first run, and the file has no address of its own
    const update = firstRun.slice(firstRun.indexOf('export async function checkBotsUpdate'));
    expect(update).toMatch(/\(options\.fetchPreset \?\? defaultFetch\)\(presetUrl\(slug\), controller\.signal\)/);
    expect(update.match(/\bfetch\(/g)).toBeNull();
    expect(firstRun.match(/\bfetch\(/g)).toHaveLength(1);
    expect(firstRun).not.toMatch(/https?:\/\//);
  });

  it('runs once after start-up in an idle moment, on no timer of its own, and the build id reads the page only', () => {
    expect(app.match(/runBotsUpdate/g)).toHaveLength(2);
    expect(app).toMatch(/setTimeout\(\(\) => whenIdle\(runBotsUpdate, BOTS_UPDATE_IDLE_MS\), BOTS_UPDATE_DELAY_MS\)/);
    expect(app).not.toMatch(/setInterval/);
    expect(buildId).not.toMatch(/\bfetch\(|XMLHttpRequest|https?:\/\//);
  });
});
