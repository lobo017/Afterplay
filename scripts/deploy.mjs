// Deploys the built app to Cloudflare Pages with Wrangler (a dev dependency; log in once with `npx wrangler login`).
//
//   npm run deploy:preview                          builds, uploads to the project's preview branch, prints the URL
//   npm run deploy:production -- --checked <id>     uploads the same dist/ to production (never rebuilds)
//
// Every build goes to a preview URL first. Production refuses unless dist/ and HEAD are exactly what the last
// preview deployed, and --checked names that preview's build id: production only ever gets a build someone checked.
// The headers (COOP/COEP for the engine's threads, caching) come from public/_headers, copied into dist/.
//
// Environment: WC_PAGES_PROJECT (default "wizards-chess"). Wrangler's usage metrics are switched off. What goes to
// Cloudflare is dist/, the commit hash and a message naming the build id; nothing else.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildIdOf, deploymentUrlOf, fingerprintDir, listFiles, productionRefusal } from './lib/deploy-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const RECORD_DIR = path.join(ROOT, '.deploy');
const PREVIEW_RECORD = path.join(RECORD_DIR, 'preview.json');
const PRODUCTION_RECORD = path.join(RECORD_DIR, 'production.json');
const PROJECT = process.env.WC_PAGES_PROJECT || 'wizards-chess';
const PRODUCTION_BRANCH = 'main';
const PREVIEW_BRANCH = 'preview';
// Cloudflare Pages limits (free plan): files per deployment and bytes per file
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const STEP_TIMEOUT_MS = 10 * 60 * 1000;

function fail(message) {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

function git(...args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) fail(`git ${args.join(' ')} failed: ${r.stderr || r.error}`);
  return r.stdout.trim();
}

/** Runs a command with its output shown, under a time limit; resolves with its console text. */
function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    const take = (out) => (chunk) => {
      text += chunk.toString();
      out.write(chunk);
    };
    child.stdout.on('data', take(process.stdout));
    child.stderr.on('data', take(process.stderr));
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(`${path.basename(args[0] ?? command)} took over ${STEP_TIMEOUT_MS / 60000} min and was stopped`),
      );
    }, STEP_TIMEOUT_MS);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(text);
      else reject(new Error(`${path.basename(args[0] ?? command)} exited with ${code}`));
    });
  });
}

function wranglerBin() {
  const require = createRequire(import.meta.url);
  let pkgPath;
  try {
    pkgPath = require.resolve('wrangler/package.json');
  } catch {
    fail('Wrangler is not installed (npm ci).');
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.wrangler;
  return path.join(path.dirname(pkgPath), bin);
}

function checkDist() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) fail('dist/ has no build (npm run build).');
  if (!fs.existsSync(path.join(DIST, '_headers'))) fail('dist/_headers is missing: the engine would lose its threads.');
  const files = listFiles(DIST);
  if (files.length > MAX_FILES) fail(`dist/ has ${files.length} files; Pages takes at most ${MAX_FILES}.`);
  for (const rel of files) {
    const size = fs.statSync(path.join(DIST, rel)).size;
    if (size > MAX_FILE_BYTES) fail(`${rel} is ${(size / 1048576).toFixed(1)} MiB; Pages takes at most 25 MiB a file.`);
  }
  return files.length;
}

/** Uploads dist/ to a branch of the Pages project; returns the deployment URL. */
async function pagesDeploy(branch, commit, buildId) {
  const outputFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-deploy-')), 'wrangler-output.ndjson');
  const consoleText = await run(
    process.execPath,
    [
      wranglerBin(),
      'pages',
      'deploy',
      DIST,
      `--project-name=${PROJECT}`,
      `--branch=${branch}`,
      `--commit-hash=${commit}`,
      `--commit-message=Wizard's Chess build ${buildId}`,
      '--commit-dirty=false',
    ],
    { WRANGLER_SEND_METRICS: 'false', WRANGLER_OUTPUT_FILE_PATH: outputFile },
  );
  const outputText = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';
  fs.rmSync(path.dirname(outputFile), { recursive: true, force: true });
  const url = deploymentUrlOf(outputText, consoleText);
  if (!url) fail('Wrangler finished but printed no deployment URL; check the Pages dashboard.');
  return url;
}

function writeRecord(file, record) {
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

async function preview() {
  if (git('status', '--porcelain'))
    fail('the working tree has uncommitted changes; commit first so the preview is a commit.');
  const commit = git('rev-parse', 'HEAD');
  const npmCli = process.env.npm_execpath;
  if (!npmCli) fail('run this through npm (npm run deploy:preview).');
  await run(process.execPath, [npmCli, 'run', 'build']);
  const count = checkDist();
  const fingerprint = fingerprintDir(DIST);
  const buildId = buildIdOf(fingerprint);
  console.log(
    `\ndeploy: ${count} files, build ${buildId}, commit ${commit.slice(0, 8)} → preview branch of "${PROJECT}"`,
  );
  const url = await pagesDeploy(PREVIEW_BRANCH, commit, buildId);
  writeRecord(PREVIEW_RECORD, { commit, fingerprint, buildId, url, deployedAt: new Date().toISOString() });
  console.log(`\nPreview: ${url}`);
  console.log(`Check it there (engine, offline, install). Then: npm run deploy:production -- --checked ${buildId}`);
}

async function production(checked) {
  const record = fs.existsSync(PREVIEW_RECORD) ? JSON.parse(fs.readFileSync(PREVIEW_RECORD, 'utf8')) : null;
  checkDist();
  const current = { commit: git('rev-parse', 'HEAD'), fingerprint: fingerprintDir(DIST) };
  const refusal = productionRefusal(record, current, checked);
  if (refusal) fail(refusal);
  console.log(`deploy: build ${record.buildId} (checked on ${record.url}) → production of "${PROJECT}"`);
  const url = await pagesDeploy(PRODUCTION_BRANCH, current.commit, record.buildId);
  writeRecord(PRODUCTION_RECORD, { ...record, url, previewUrl: record.url, deployedAt: new Date().toISOString() });
  console.log(`\nProduction: ${url} (and the project's production domain)`);
}

const [target, ...rest] = process.argv.slice(2);
const checkedIndex = rest.indexOf('--checked');
const checked =
  checkedIndex >= 0 ? rest[checkedIndex + 1] : (rest.find((a) => a.startsWith('--checked='))?.slice(10) ?? null);

try {
  if (target === 'preview') await preview();
  else if (target === 'production') await production(checked);
  else fail('usage: node scripts/deploy.mjs preview | production --checked <build id>');
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
