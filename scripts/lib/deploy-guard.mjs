// The checks behind `npm run deploy:preview` and `npm run deploy:production` (scripts/deploy.mjs): a fingerprint of
// dist/, the record a preview deploy leaves behind, and the rule that production only gets the build that was checked.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Every file under `dir`, as sorted forward-slash paths relative to it. */
export function listFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  walk('');
  return out.sort();
}

/** A SHA-256 over every file's path and bytes: equal fingerprints mean the same files would be uploaded. */
export function fingerprintDir(dir) {
  const hash = crypto.createHash('sha256');
  for (const rel of listFiles(dir)) {
    hash.update(rel);
    hash.update('\0');
    hash.update(
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(dir, rel)))
        .digest(),
    );
  }
  return hash.digest('hex');
}

/** The short id a person types to say which preview they checked. */
export function buildIdOf(fingerprint) {
  return fingerprint.slice(0, 12);
}

/**
 * Finds the deployment URL in what `wrangler pages deploy` printed: its machine-readable output file first (one JSON
 * object per line), its console text otherwise.
 */
export function deploymentUrlOf(outputFileText, consoleText) {
  for (const line of (outputFileText ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && entry.type === 'pages-deploy-detailed' && typeof entry.url === 'string') return entry.url;
    } catch {
      // not a JSON line
    }
  }
  const match = /https:\/\/[a-z0-9.-]+\.pages\.dev\b/i.exec(consoleText ?? '');
  return match ? match[0] : null;
}

/**
 * Whether production may get dist/ now. `record` is what the last preview deploy wrote (or null), `current` is
 * `{ commit, fingerprint }` now, `checked` the build id the person passed with --checked. Returns null when it may,
 * otherwise the reason it may not.
 */
export function productionRefusal(record, current, checked) {
  if (!record) return 'No preview deploy is recorded. Run `npm run deploy:preview` first and check the preview URL.';
  if (!checked) {
    return `Say which preview you checked: npm run deploy:production -- --checked ${record.buildId} (preview ${record.url}).`;
  }
  if (checked !== record.buildId) {
    return `--checked ${checked} is not the last preview (build ${record.buildId}, ${record.url}).`;
  }
  if (current.commit !== record.commit) {
    return `HEAD (${current.commit.slice(0, 8)}) is not the previewed commit (${record.commit.slice(0, 8)}). Deploy a new preview first.`;
  }
  if (current.fingerprint !== record.fingerprint) {
    return 'dist/ has changed since the preview (rebuilt or edited). Deploy a new preview and check it first.';
  }
  return null;
}
