// Process hygiene for the perf and e2e harnesses: find leftover browsers/servers from
// earlier runs, kill whole process trees, and clean up on every way a run can end.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { setInterval, setTimeout } from 'node:timers';

const IS_WINDOWS = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

/**
 * Linux: read /proc directly (the Playwright image is not guaranteed to have `ps`). Inside the Apptainer
 * container of a Juno job /proc only shows the job's own processes (private PID namespace), which keeps
 * the leftover checks from ever seeing another job's browsers on a shared node.
 */
function listProcessesFromProc() {
  const rows = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      // "pid (comm) state ppid ...": comm may hold spaces and parentheses, so cut at the last ')'
      const close = stat.lastIndexOf(')');
      const name = stat.slice(stat.indexOf('(') + 1, close);
      const ppid = Number(stat.slice(close + 2).split(' ')[1]);
      const cmd = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ') || name;
      rows.push({ pid: Number(entry), ppid, name, cmd });
    } catch {
      // the process ended while we looked
    }
  }
  return rows;
}

/** Every process on the machine: { pid, ppid, name, cmd }. */
export function listProcesses() {
  if (IS_WINDOWS) {
    const res = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    if (res.status !== 0 || !res.stdout) {
      throw new Error(`Could not list processes: ${res.stderr || res.error?.message || 'no output'}`);
    }
    const rows = JSON.parse(res.stdout);
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
      pid: r.ProcessId,
      ppid: r.ParentProcessId,
      name: String(r.Name ?? ''),
      cmd: String(r.CommandLine ?? ''),
    }));
  }
  if (IS_LINUX) return listProcessesFromProc();
  const res = spawnSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`Could not list processes: ${res.stderr}`);
  return res.stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3], cmd: m[4] }));
}

/** pid of this process and every ancestor, so a run never flags its own launcher. */
function ancestorPids(procs, pid) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Set();
  let cur = pid;
  while (cur && !out.has(cur)) {
    out.add(cur);
    cur = byPid.get(cur)?.ppid;
  }
  return out;
}

const isPlaywrightBrowser = (p) =>
  /chrom(e|ium)|headless_shell/i.test(p.name) &&
  /--headless/.test(p.cmd) &&
  /--remote-debugging-pipe|playwright/i.test(p.cmd);

/**
 * Processes left over from earlier perf or e2e runs:
 * - headless Chrome started by Playwright
 * - another perf-drag.mjs, perf-review.mjs or calibrate-bots.mjs, or a review script
 *   that runs Stockfish in Node (compare-review-presets.mjs, record-review-fixtures.mjs)
 * - a Playwright test runner or worker
 * - this repo's serve.mjs on one of `ports`
 * The current process and its ancestors are never included.
 */
export function findLeftoverTestProcesses({ ports = [] } = {}) {
  const procs = listProcesses();
  const self = ancestorPids(procs, process.pid);
  const portRe = ports.length > 0 ? new RegExp(`--port\\s+(${ports.join('|')})\\b`) : null;
  return procs.filter((p) => {
    if (self.has(p.pid)) return false;
    if (isPlaywrightBrowser(p)) return true;
    if (!/node/i.test(p.name)) return false;
    if (
      /scripts[\\/](perf-drag|perf-review|calibrate-bots|compare-review-presets|record-review-fixtures|verify-puzzles)\.mjs/.test(
        p.cmd,
      )
    ) {
      return true;
    }
    if (/playwright[\\/].*(cli\.js|process\.js)|playwright(\.cmd)?"?\s+test\b/.test(p.cmd)) return true;
    return Boolean(portRe && /scripts[\\/]serve\.mjs/.test(p.cmd) && portRe.test(p.cmd));
  });
}

/** Other serve.mjs instances: reported so the user knows, but not treated as leftovers. */
export function findOtherRepoServers({ ports = [] } = {}) {
  const portRe = ports.length > 0 ? new RegExp(`--port\\s+(${ports.join('|')})\\b`) : null;
  return listProcesses().filter(
    (p) => /node/i.test(p.name) && /scripts[\\/]serve\.mjs/.test(p.cmd) && !(portRe && portRe.test(p.cmd)),
  );
}

export function formatProcesses(procs) {
  return procs.map((p) => `  pid ${p.pid} (parent ${p.ppid}) ${p.name}: ${p.cmd.slice(0, 200)}`).join('\n');
}

export function killCommandHint(procs) {
  return IS_WINDOWS
    ? procs.map((p) => `taskkill /PID ${p.pid} /T /F`).join('\n')
    : `kill -9 ${procs.map((p) => p.pid).join(' ')}`;
}

/** Kills `pid` and all its descendants. Synchronous, so it also works in an 'exit' handler. */
export function killProcessTree(pid) {
  if (!pid) return;
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: 15_000,
      windowsHide: true,
    });
    return;
  }
  const procs = listProcesses();
  const tree = [pid];
  for (let i = 0; i < tree.length; i++) {
    for (const p of procs) if (p.ppid === tree[i]) tree.push(p.pid);
  }
  for (const id of tree.reverse()) {
    try {
      process.kill(id, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Kills every process tree whose root is a direct child of this process. */
/**
 * Kills every process tree whose root is a direct child of this process and returns the
 * processes killed. The probe used to list processes is itself a child, so it's skipped.
 */
export function killAllChildTrees() {
  let children = [];
  try {
    children = listProcesses().filter(
      (p) => p.ppid === process.pid && !/Get-CimInstance Win32_Process|ps -eo/.test(p.cmd),
    );
  } catch {
    return [];
  }
  for (const c of children) killProcessTree(c.pid);
  return children;
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export const freeMemoryBytes = () => os.freemem();

export const formatGb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

/**
 * Runs `cleanup` exactly once, however the process ends: normal exit, uncaught error,
 * Ctrl+C / Ctrl+Break, SIGTERM, SIGHUP, any ancestor dying, or `maxRunMs` passing.
 * A force kill of this process can't be caught; on Windows node's children die with it
 * (libuv job object), and serve.mjs also watches its parent (see exitWithParent).
 *
 * Hosts with their own shutdown handling (the Playwright runner) pass
 * `handleSignalsAndErrors: false` and get only the ancestor watchdog and the deadline.
 */
export function installCleanup({
  cleanup,
  log = console.error,
  parentWatchMs = 1000,
  maxRunMs = 0,
  handleSignalsAndErrors = true,
}) {
  let done = false;
  const runOnce = (reason) => {
    if (done) return;
    done = true;
    try {
      cleanup(reason);
    } catch (err) {
      log(`cleanup failed: ${err?.stack ?? err}`);
    }
  };

  const exitWith = (code, reason) => {
    runOnce(reason);
    process.exit(code);
  };

  if (handleSignalsAndErrors) {
    process.on('exit', () => runOnce('exit'));
    for (const [signal, code] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
      ['SIGBREAK', 149],
    ]) {
      process.on(signal, () => {
        log(`received ${signal}, cleaning up`);
        exitWith(code, signal);
      });
    }
    process.on('uncaughtException', (err) => {
      log(`uncaught exception:\n${err?.stack ?? err}`);
      exitWith(1, 'uncaughtException');
    });
    process.on('unhandledRejection', (err) => {
      log(`unhandled rejection:\n${err?.stack ?? err}`);
      exitWith(1, 'unhandledRejection');
    });
  }

  // Watch every ancestor, not just the parent: `npm run` / `npx` put npm and a shell
  // between the launching terminal and this script, and those survive when the terminal
  // is killed (that is how an earlier run was orphaned).
  if (parentWatchMs > 0) {
    let ancestors = [];
    try {
      // Windows never re-parents: a ParentProcessId can name a process that exited long
      // ago (Git Bash's fork emulation leaves such gaps). Only watch ancestors alive now.
      const procs = listProcesses();
      const alive = new Set(procs.map((p) => p.pid));
      ancestors = [...ancestorPids(procs, process.pid)].filter(
        (pid) => pid !== process.pid && pid > 4 && alive.has(pid),
      );
    } catch {
      ancestors = process.ppid ? [process.ppid] : [];
    }
    setInterval(() => {
      const gone = ancestors.find((pid) => !isProcessAlive(pid));
      if (gone !== undefined) {
        log(`ancestor process ${gone} exited, cleaning up`);
        exitWith(1, 'ancestor exited');
      }
    }, parentWatchMs).unref();
  }

  if (maxRunMs > 0) {
    setTimeout(() => {
      log(`run exceeded its ${Math.round(maxRunMs / 1000)} s limit, cleaning up`);
      exitWith(4, 'max run time');
    }, maxRunMs).unref();
  }

  return { runCleanup: runOnce };
}

/** For child servers: exit as soon as process `pid` is gone (survives a force kill of it). */
export function exitWithParent(pid, intervalMs = 1000) {
  if (!pid) return;
  setInterval(() => {
    if (!isProcessAlive(pid)) process.exit(0);
  }, intervalMs).unref();
}
