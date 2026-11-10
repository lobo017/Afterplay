// Turns the results folder of a Juno job into a short report: pass/fail counts, every failure with its first
// error line, and the perf tables.
//
//   node hpc/summarize.mjs <results folder> [--write]
//
// <results folder> is results/<job-id>/ (one job) or results/<array-job-id>/ (an array: its task-N folders are
// summarized one by one, then compared: flaky e2e tests, calibration levels together, puzzle totals).
// --write also saves the report as summary.md in that folder. No dependencies; runs on Juno (inside the
// container, at the end of every job) and on Windows after `scp`.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const WRITE = args.includes('--write');
if (!dir || !fs.existsSync(dir)) {
  console.error('usage: node hpc/summarize.mjs <results folder> [--write]');
  process.exit(2);
}

// --- helpers ---------------------------------------------------------------------------------------
// Colour codes in Playwright's messages (built from a string: a literal ESC in a regex trips the linter)
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const firstLine = (text) =>
  String(text ?? '')
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) ?? '(no message)';
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
/** The objects of a .jsonl text; a half-written last line (a job killed mid-write) is skipped. */
const parseLines = (text) =>
  (text ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
const readJson = (file) => {
  const text = read(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const table = (head, rows) => {
  const line = (cells) => `| ${cells.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
};
const fmtSec = (s) =>
  s >= 3600
    ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`
    : s >= 60
      ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
      : `${Math.round(s)} s`;

// --- one job ---------------------------------------------------------------------------------------
function walkPlaywright(suite, titles, out) {
  const here = suite.title && !suite.file ? [...titles, suite.title] : titles;
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const results = t.results ?? [];
      const last = results[results.length - 1];
      out.push({
        file: spec.file ?? suite.file ?? '',
        line: spec.line ?? 0,
        title: [...here, spec.title].join(' › '),
        status: t.status, // expected | unexpected | flaky | skipped
        message: firstLine(last?.error?.message ?? last?.errors?.[0]?.message),
        ms: results.reduce((n, r) => n + (r.duration ?? 0), 0),
      });
    }
  }
  for (const child of suite.suites ?? []) walkPlaywright(child, here, out);
}

function playwrightTests(report) {
  const out = [];
  for (const s of report.suites ?? []) walkPlaywright(s, [], out);
  return out;
}

function summarizePlaywright(report, md) {
  const tests = playwrightTests(report);
  const count = (s) => tests.filter((t) => t.status === s).length;
  const failed = tests.filter((t) => t.status === 'unexpected');
  const flaky = tests.filter((t) => t.status === 'flaky');
  md.push(
    `**Playwright:** ${count('expected')} passed, ${failed.length} failed, ${flaky.length} flaky, ${count('skipped')} skipped ` +
      `(${tests.length} tests, ${fmtSec((report.stats?.duration ?? 0) / 1000)})`,
  );
  for (const e of report.errors ?? []) md.push(`- runner error: ${firstLine(e.message)}`);
  if (failed.length) {
    md.push('', 'Failures:');
    for (const t of failed) md.push(`- \`${t.file}:${t.line}\` ${t.title}: ${t.message}`);
  }
  if (flaky.length) {
    md.push('', 'Flaky (failed, then passed on retry):');
    for (const t of flaky) md.push(`- \`${t.file}:${t.line}\` ${t.title}: ${t.message}`);
  }
  return tests;
}

function summarizeVitest(report, md) {
  const failures = [];
  for (const file of report.testResults ?? []) {
    const failedTests = (file.assertionResults ?? []).filter((a) => a.status === 'failed');
    for (const a of failedTests)
      failures.push({ file: file.name, title: a.fullName, message: firstLine(a.failureMessages?.[0]) });
    if (file.status === 'failed' && failedTests.length === 0) {
      failures.push({ file: file.name, title: '(file failed to run)', message: firstLine(file.message) });
    }
  }
  md.push(
    `**Unit tests (vitest):** ${report.numPassedTests} passed, ${report.numFailedTests} failed, ` +
      `${report.numPendingTests ?? 0} skipped (${report.numTotalTests} tests in ${report.numTotalTestSuites} suites)`,
  );
  if (failures.length) {
    md.push('', 'Failures:');
    for (const f of failures) md.push(`- \`${path.basename(f.file)}\` ${f.title}: ${f.message}`);
  }
}

/** The JSON block a perf script prints after its header line. */
function jsonAfter(text, header) {
  const at = text.indexOf(header);
  if (at === -1) return null;
  const rest = text.slice(at + header.length);
  const start = rest.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < rest.length; i++) {
    const c = rest[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(rest.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function perfDrag(text, md) {
  const report = jsonAfter(text, 'Perf Report (perf:drag)');
  if (!report) return false;
  const rows = Object.entries(report)
    .filter(([k, v]) => k !== 'environmentFloor' && v && typeof v === 'object' && 'p95FrameMs' in v)
    .map(([name, v]) => [
      name,
      v.p95FrameMs,
      v.p99FrameMs ?? '',
      v.droppedFrames ?? '',
      v.longTaskCount ?? '',
      v.mainThread?.busyMsPerFrame ?? '',
      v.inputLatencyMs ?? '',
    ]);
  md.push(
    `blank page ${report.environmentFloor?.p50FrameMs} ms (p50) / ${report.environmentFloor?.p95FrameMs} ms (p95), ` +
      `display: ${report.display ?? '?'}; start-up ${report.startupInteractiveMs} ms; idle rAF ${report.idleRafCallbacksIn500Ms}; ` +
      `limit p95 ${report.p95LimitMs} ms; budget ${report.budgetPassed ? 'PASSED' : 'FAILED'}`,
    '',
    table(['window', 'p95 ms', 'p99 ms', 'dropped', 'long tasks', 'main thread ms/frame', 'input ms'], rows),
  );
  for (const f of report.failures ?? []) md.push(`- ${f}`);
  return true;
}

function perfMemory(text, md) {
  const report = jsonAfter(text, 'Memory report (perf:memory)');
  if (!report) return false;
  md.push(
    table(
      ['games', 'heap slope KB/game', 'heap growth MB', 'DOM growth', 'reachable DOM growth', 'listener growth'],
      [
        [
          report.games,
          report.heapSlopeKbPerGame,
          report.heapGrowthMB,
          JSON.stringify(report.domCounterGrowth),
          JSON.stringify(report.reachableDomGrowth),
          JSON.stringify(report.listenerGrowth),
        ],
      ],
    ),
    `budget ${/budgetPassed: true/.test(text) ? 'PASSED' : 'FAILED'}`,
  );
  return true;
}

function perfLines(text, md, pattern) {
  const lines = text.split(/\r?\n/).filter((l) => pattern.test(l));
  if (!lines.length) return false;
  md.push('```', ...lines, '```');
  return true;
}

function summarizePerf(name, text, md) {
  md.push(`#### perf:${name}`);
  let shown = false;
  if (name === 'drag') shown = perfDrag(text, md);
  else if (name === 'memory') shown = perfMemory(text, md);
  else if (name === 'review') shown = perfLines(text, md, /^\|/);
  else if (name === 'tasks') shown = perfLines(text, md, /^(ok {2}|note|LONG|tasks of |budgetPassed)/);
  if (!shown) {
    const tail = text.split(/\r?\n/).filter(Boolean).slice(-8);
    md.push('(no table in the log; last lines)', '```', ...tail, '```');
  }
  const abort = text.split(/\r?\n/).find((l) => l.startsWith('[abort]'));
  if (abort) md.push(`- ${abort}`);
}

function summarizeCalibration(rows, md) {
  md.push(
    table(
      ['level', 'status', 'ACPL', 'target', 'blunder %', 'target', 'score', 'moves'],
      rows.map((r) => [
        r.label,
        r.status,
        r.acpl,
        r.targetAcpl,
        r.blunderRatePct,
        r.targetBlunderPct,
        r.matchScore,
        r.movesEvaluated,
      ]),
    ),
  );
}

function summarizePuzzles(totalsList, failureLines, md) {
  const sum = (k) => totalsList.reduce((n, t) => n + (t[k] ?? 0), 0);
  const incomplete = totalsList.filter((t) => !t.complete);
  md.push(
    `**Puzzles:** ${sum('puzzlesChecked')} of ${sum('puzzlesInChunk')} checked in ${totalsList.length} chunk(s) at depth ` +
      `${totalsList[0]?.depth}; ${sum('playerMovesChecked')} player moves: ${sum('engineBest')} engine-best, ` +
      `${sum('acceptedAsGood')} accepted as just as good, ${sum('failedMoves')} weaker than the engine's; ` +
      `${sum('failedPuzzles')} puzzles failed, ${sum('formatErrors')} malformed.`,
  );
  if (incomplete.length) md.push(`- INCOMPLETE chunks (time limit): ${incomplete.map((t) => t.chunk).join(', ')}`);
  if (failureLines.length) {
    md.push('', `Failed puzzles (first ${Math.min(20, failureLines.length)} of ${failureLines.length} lines):`);
    for (const f of failureLines.slice(0, 20)) {
      md.push(
        f.kind === 'format'
          ? `- ${f.id}: malformed: ${f.message}`
          : `- ${f.id} (rating ${f.rating}) move ${f.ply / 2 + 1}: stored ${f.stored} ${JSON.stringify(f.storedScore)} vs engine ${f.engineMove} ${JSON.stringify(f.engineScore)}`,
      );
    }
  }
}

function summarizeJob(jobDir) {
  const md = [];
  const meta = readJson(path.join(jobDir, 'meta.json'));
  const exit = read(path.join(jobDir, 'exit-code.txt'))?.trim();
  const steps = (read(path.join(jobDir, 'steps.tsv')) ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split('\t'));

  if (meta) {
    md.push(
      `**Job ${meta.jobId}** (${meta.type}${meta.arrayTaskId ? `, task ${meta.arrayTaskId}` : ''}) on ${meta.node}, ` +
        `commit \`${String(meta.commit).slice(0, 10)}\` ${meta.commitSubject ? `“${meta.commitSubject}”` : ''}, ` +
        `started ${meta.startedAt}${exit !== undefined ? `, exit code ${exit}` : ' (no exit code: still running or killed)'}`,
    );
  }
  if (steps.length) {
    md.push(
      '',
      table(
        ['step', 'exit', 'time'],
        steps.map(([n, rc, s]) => [
          n,
          rc === '0' ? 'ok' : `FAILED (${rc}${rc === '124' ? ', time limit' : ''})`,
          fmtSec(Number(s)),
        ]),
      ),
    );
  }

  const result = { tests: null, flaky: [], failedSteps: steps.filter((s) => s[1] !== '0').map((s) => s[0]) };
  const pw = readJson(path.join(jobDir, 'playwright-report.json'));
  if (pw) {
    md.push('');
    result.tests = summarizePlaywright(pw, md);
  } else if (steps.some((s) => s[0] === 'e2e')) {
    md.push('', '**Playwright:** no report was written (the run ended before it could); see e2e.log');
  }
  const vt = readJson(path.join(jobDir, 'vitest-report.json'));
  if (vt) {
    md.push('');
    summarizeVitest(vt, md);
  }

  const files = fs.readdirSync(jobDir);
  const perf = files.filter((f) => /^perf-.*\.log$/.test(f));
  if (perf.length) {
    md.push(
      '',
      '### Performance',
      '',
      'Numbers from a headless Linux node: regression baselines for the code, not what a user would see on a screen.',
    );
    for (const f of perf) {
      md.push('');
      summarizePerf(f.replace(/^perf-|\.log$/g, ''), read(path.join(jobDir, f)), md);
    }
  }
  const cal = files.filter((f) => /^calibrate-\d+\.json$/.test(f));
  const calRows = cal.flatMap((f) => readJson(path.join(jobDir, f)) ?? []);
  if (calRows.length) {
    md.push('', '### Calibration', '');
    summarizeCalibration(calRows, md);
  }
  const pz = files.filter((f) => /^puzzles-chunk-\d+\.json$/.test(f));
  if (pz.length) {
    const totals = pz.map((f) => readJson(path.join(jobDir, f))).filter(Boolean);
    const failures = files
      .filter((f) => /^puzzles-chunk-\d+\.jsonl$/.test(f))
      .flatMap((f) => parseLines(read(path.join(jobDir, f))));
    md.push('');
    summarizePuzzles(totals, failures, md);
  }
  const smoke = readJson(path.join(jobDir, 'smoke.json'));
  if (smoke) {
    md.push(
      '',
      `**Smoke:** ${smoke.browserVersion ?? 'no browser'}; blank page p50 ${smoke.blankPageFrames?.p50FrameMs} ms; ` +
        `cross-origin isolated ${smoke.page?.crossOriginIsolated}; extension in new headless: ${smoke.extension?.newHeadless?.id ? 'loaded' : `NOT loaded (${smoke.extension?.newHeadless?.error ?? '?'})`}`,
    );
  }
  const changes = (read(path.join(jobDir, 'repo-changes.txt')) ?? '').trimEnd();
  if (changes) md.push('', '**Warning: the job changed files in the repo:**', '```', changes, '```');
  return { md, result, meta, exit };
}

// --- an array of tasks -----------------------------------------------------------------------------
function summarizeArray(root, taskDirs) {
  const md = [`## Results ${path.basename(path.resolve(root))}: ${taskDirs.length} task(s)`];
  const jobs = taskDirs.map((d) => ({ d, ...summarizeJob(path.join(root, d)) }));

  md.push(
    '',
    table(
      ['task', 'exit', 'failed steps'],
      jobs.map((j) => [j.d, j.exit ?? '?', j.result.failedSteps.join(', ') || '-']),
    ),
  );

  // e2e-repeat: the same tests in every run; one that does not always give the same result is flaky
  const runs = jobs.filter((j) => j.result.tests);
  if (runs.length > 1) {
    const byTest = new Map();
    runs.forEach((j, i) => {
      for (const t of j.result.tests) {
        const key = `${t.file} › ${t.title}`;
        const entry = byTest.get(key) ?? { key, line: t.line, outcomes: new Array(runs.length).fill('-'), message: '' };
        entry.outcomes[i] =
          t.status === 'expected'
            ? 'pass'
            : t.status === 'unexpected'
              ? 'FAIL'
              : t.status === 'flaky'
                ? 'flaky'
                : 'skip';
        if (t.status === 'unexpected' || t.status === 'flaky') entry.message = t.message;
        byTest.set(key, entry);
      }
    });
    const unstable = [...byTest.values()].filter(
      (e) => new Set(e.outcomes.filter((o) => o !== 'skip')).size > 1 || e.outcomes.includes('flaky'),
    );
    const alwaysFailing = [...byTest.values()].filter((e) => e.outcomes.every((o) => o === 'FAIL'));
    md.push('', `### Across ${runs.length} runs`);
    md.push(
      '',
      `${alwaysFailing.length} test(s) failed in every run, ${unstable.length} gave different results in different runs (flaky).`,
    );
    if (alwaysFailing.length) {
      md.push('', 'Failed every time:');
      for (const e of alwaysFailing) md.push(`- ${e.key}: ${e.message}`);
    }
    if (unstable.length) {
      md.push('', 'Flaky (result per run in task order):');
      for (const e of unstable) md.push(`- ${e.key}: ${e.outcomes.join(' / ')}: ${e.message}`);
    }
  }

  // calibrate: all levels together, with the monotonic check across them
  const calRows = jobs
    .flatMap((j) =>
      fs
        .readdirSync(path.join(root, j.d))
        .filter((f) => /^calibrate-\d+\.json$/.test(f))
        .flatMap((f) => readJson(path.join(root, j.d, f)) ?? []),
    )
    .sort((a, b) => a.rating - b.rating);
  if (calRows.length > 1) {
    md.push('', '### All calibration levels', '');
    summarizeCalibration(calRows, md);
    const bad = [];
    for (let i = 1; i < calRows.length; i++) {
      if (calRows[i].acpl >= calRows[i - 1].acpl)
        bad.push(`ACPL ${calRows[i].label} (${calRows[i].acpl}) >= ${calRows[i - 1].label} (${calRows[i - 1].acpl})`);
      if (calRows[i].blunderRatePct > calRows[i - 1].blunderRatePct)
        bad.push(`blunder% ${calRows[i].label} > ${calRows[i - 1].label}`);
    }
    md.push('', `Monotonic progression across levels: ${bad.length ? `FAIL (${bad.join('; ')})` : 'PASS'}`);
  }

  // puzzles: one total over all chunks
  const pzTotals = [];
  const pzFailures = [];
  for (const j of jobs) {
    for (const f of fs.readdirSync(path.join(root, j.d))) {
      if (/^puzzles-chunk-\d+\.json$/.test(f)) pzTotals.push(readJson(path.join(root, j.d, f)));
      if (/^puzzles-chunk-\d+\.jsonl$/.test(f)) {
        pzFailures.push(...parseLines(read(path.join(root, j.d, f))));
      }
    }
  }
  if (pzTotals.length > 1) {
    md.push('', '### All puzzle chunks', '');
    summarizePuzzles(pzTotals.filter(Boolean), pzFailures, md);
  }

  md.push('', '---', '', '## Per task');
  for (const j of jobs) md.push('', `### ${j.d}`, '', ...j.md);
  return md;
}

// --- main ------------------------------------------------------------------------------------------
const taskDirs = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^task-\d+$/.test(e.name))
  .map((e) => e.name)
  .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));

const md = taskDirs.length ? summarizeArray(dir, taskDirs) : summarizeJob(dir).md;
const report = `${md.join('\n')}\n`;
if (WRITE) fs.writeFileSync(path.join(dir, 'summary.md'), report);
process.stdout.write(report);
