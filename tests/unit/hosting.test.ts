import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildIdOf,
  deploymentUrlOf,
  fingerprintDir,
  listFiles,
  productionRefusal,
  type PreviewRecord,
} from '../../scripts/lib/deploy-guard.mjs';
import { activitiesInProgress, registerActivity } from '../../src/ui/activity';

/** public/_headers as { path pattern: { header name (lower case): value } }, in Cloudflare Pages' format. */
function parseHeadersFile(text: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = new Map();
      rules.set(raw.trim(), current);
      continue;
    }
    const colon = raw.indexOf(':');
    expect(current, `a header line outside a path block: ${raw}`).not.toBeNull();
    current!.set(raw.slice(0, colon).trim().toLowerCase(), raw.slice(colon + 1).trim());
  }
  return rules;
}

describe('Cloudflare Pages headers (public/_headers)', () => {
  const rules = parseHeadersFile(fs.readFileSync('public/_headers', 'utf8'));

  it('makes every path cross-origin isolated, with the same headers as npm run serve and the service worker', () => {
    const all = rules.get('/*')!;
    expect(all.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(all.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(all.get('cross-origin-resource-policy')).toBe('same-origin');
    for (const source of ['scripts/serve.mjs', 'src/sw.ts', 'vite.config.ts']) {
      const text = fs.readFileSync(source, 'utf8');
      expect(text, source).toMatch(/'Cross-Origin-Opener-Policy',?:? 'same-origin'/);
      expect(text, source).toMatch(/'Cross-Origin-Embedder-Policy',?:? 'require-corp'/);
    }
  });

  it('never lets a browser keep an old page or worker, and caches hashed files for good', () => {
    for (const p of ['/', '/index.html', '/sw.js', '/manifest.webmanifest']) {
      expect(rules.get(p)?.get('cache-control'), p).toBe('no-cache');
    }
    for (const p of ['/assets/*', '/stockfish/*']) {
      expect(rules.get(p)?.get('cache-control'), p).toContain('immutable');
    }
    // The engine files really are versioned by name, so "immutable" is safe for them
    const config = fs.readFileSync('vite.config.ts', 'utf8');
    for (const name of config.match(/'stockfish-[^']+'/g) ?? []) expect(name).toMatch(/-[0-9a-f]{7}\.(js|wasm)'$/);
  });
});

describe('deploy guard (scripts/deploy.mjs)', () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-deploy-test-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('fingerprints a folder by its paths and bytes', () => {
    const a = tempDir();
    fs.mkdirSync(path.join(a, 'assets'));
    fs.writeFileSync(path.join(a, 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(a, 'assets', 'x.js'), 'x');
    expect(listFiles(a)).toEqual(['assets/x.js', 'index.html']);
    const first = fingerprintDir(a);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintDir(a)).toBe(first);
    fs.writeFileSync(path.join(a, 'assets', 'x.js'), 'y');
    expect(fingerprintDir(a)).not.toBe(first);
    fs.writeFileSync(path.join(a, 'assets', 'x.js'), 'x');
    expect(fingerprintDir(a)).toBe(first);
    // A renamed file is a different build even with the same bytes
    fs.renameSync(path.join(a, 'assets', 'x.js'), path.join(a, 'assets', 'z.js'));
    expect(fingerprintDir(a)).not.toBe(first);
    expect(buildIdOf(first)).toBe(first.slice(0, 12));
  });

  it("reads the deployment URL from Wrangler's output file, or its console text", () => {
    const ndjson = [
      '{"type":"wrangler-session","version":1}',
      '{"type":"pages-deploy-detailed","version":1,"url":"https://abc123.wizards-chess.pages.dev","alias":"https://preview.wizards-chess.pages.dev"}',
    ].join('\n');
    expect(deploymentUrlOf(ndjson, '')).toBe('https://abc123.wizards-chess.pages.dev');
    expect(
      deploymentUrlOf('', '✨ Deployment complete! Take a peek over at https://f00d.wizards-chess.pages.dev\n'),
    ).toBe('https://f00d.wizards-chess.pages.dev');
    expect(deploymentUrlOf('not json', 'nothing here')).toBeNull();
  });

  it('lets production have only the exact build that was previewed and named as checked', () => {
    const record: PreviewRecord = {
      commit: 'a'.repeat(40),
      fingerprint: 'f'.repeat(64),
      buildId: 'f'.repeat(12),
      url: 'https://x.wizards-chess.pages.dev',
      deployedAt: '2026-11-10T00:00:00Z',
    };
    const same = { commit: record.commit, fingerprint: record.fingerprint };
    expect(productionRefusal(record, same, record.buildId)).toBeNull();
    expect(productionRefusal(null, same, record.buildId)).toMatch(/No preview/);
    expect(productionRefusal(record, same, null)).toMatch(/--checked ffffffffffff/);
    expect(productionRefusal(record, same, '123456789abc')).toMatch(/not the last preview/);
    expect(productionRefusal(record, { ...same, commit: 'b'.repeat(40) }, record.buildId)).toMatch(
      /not the previewed commit/,
    );
    expect(productionRefusal(record, { ...same, fingerprint: 'e'.repeat(64) }, record.buildId)).toMatch(
      /changed since/,
    );
  });
});

describe('activity registry (what an update must not interrupt)', () => {
  it('lists what is in progress, and forgets a check once it is removed', () => {
    let playing = false;
    const off = registerActivity('test-game', () => playing);
    expect(activitiesInProgress()).not.toContain('test-game');
    playing = true;
    expect(activitiesInProgress()).toContain('test-game');
    off();
    expect(activitiesInProgress()).not.toContain('test-game');
  });

  it('counts a failing check as busy, and a newer registration replaces an older one', () => {
    const offBroken = registerActivity('test-broken', () => {
      throw new Error('boom');
    });
    expect(activitiesInProgress()).toContain('test-broken');
    offBroken();
    const offOld = registerActivity('test-twice', () => true);
    const offNew = registerActivity('test-twice', () => false);
    expect(activitiesInProgress()).not.toContain('test-twice');
    offOld(); // removing the replaced one leaves the newer one in place
    expect(activitiesInProgress()).not.toContain('test-twice');
    offNew();
  });
});
