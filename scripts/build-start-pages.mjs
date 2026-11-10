// The last step of the build: for every first-run link in dist/start/<slug>/ (a folder with a preset.json, copied
// there from public/start/), write the link's own index.html and manifest.webmanifest (scripts/lib/start-pages.mjs).
//
//   node scripts/build-start-pages.mjs            the committed links (public/start/)
//   node scripts/build-start-pages.mjs --local    also the personal ones in gift.local/start/ (never committed)
//
// `--local` copies personal presets into dist/. They stay on this machine unless that dist/ is deployed, which
// publishes them at their (unguessable) address: see README, "Presets and first-run links".
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { START_SLUG_PATTERN, presetAppName, startIndexHtml, startManifest } from './lib/start-pages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const DIST_START = path.join(DIST, 'start');
const LOCAL_START = path.join(ROOT, 'gift.local', 'start');
const withLocal = process.argv.includes('--local');

function fail(message) {
  console.error(`build-start-pages: ${message}`);
  process.exit(1);
}

const slugsIn = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'preset.json')))
        .map((entry) => entry.name)
    : [];

if (!fs.existsSync(path.join(DIST, 'index.html'))) fail('dist/ has no build (run vite build first).');
const indexHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const baseManifest = fs.readFileSync(path.join(DIST, 'manifest.webmanifest'), 'utf8');

let local = 0;
if (withLocal) {
  for (const slug of slugsIn(LOCAL_START)) {
    if (!START_SLUG_PATTERN.test(slug)) fail(`gift.local/start/${slug}: not a valid link name.`);
    if (fs.existsSync(path.join(DIST_START, slug))) fail(`gift.local/start/${slug}: a committed link has this name.`);
    fs.mkdirSync(path.join(DIST_START, slug), { recursive: true });
    fs.copyFileSync(path.join(LOCAL_START, slug, 'preset.json'), path.join(DIST_START, slug, 'preset.json'));
    local++;
  }
}

const slugs = slugsIn(DIST_START);
for (const slug of slugs) {
  if (!START_SLUG_PATTERN.test(slug)) fail(`start/${slug}: not a valid link name.`);
  const dir = path.join(DIST_START, slug);
  let appName;
  try {
    appName = presetAppName(fs.readFileSync(path.join(dir, 'preset.json'), 'utf8'));
  } catch (err) {
    // The folder's name is not printed for a local preset's sake: it is the secret part of its link
    fail(`a preset in dist/start/ is not usable: ${err instanceof Error ? err.message : String(err)}`);
  }
  fs.writeFileSync(path.join(dir, 'index.html'), startIndexHtml(indexHtml, slug, appName));
  fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), startManifest(baseManifest, slug, appName));
}
console.log(
  `build-start-pages: ${slugs.length} first-run link${slugs.length === 1 ? '' : 's'}` +
    (withLocal ? ` (${local} from gift.local/start/)` : ''),
);
