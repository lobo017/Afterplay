import process from 'node:process';
import {
  findLeftoverTestProcesses,
  formatProcesses,
  installCleanup,
  killAllChildTrees,
  killCommandHint,
} from '../../scripts/lib/process-guard.mjs';

/**
 * Runs once in the Playwright runner process before any worker starts.
 * 1. Refuses to start while headless browsers or other test/perf runs from earlier
 *    sessions are still alive: they hold memory and slow these tests. A server already
 *    listening on 4173 is fine, since reuseExistingServer reuses it on purpose.
 * 2. Ties the runner to its launcher. If any ancestor (the terminal or shell that started
 *    `npx playwright test`) is killed, npx and the runner would otherwise keep running
 *    the whole suite with nobody watching. Instead the runner kills its workers, their
 *    browsers and the web server, and exits. Ctrl+C is left to Playwright, which already
 *    shuts down gracefully.
 */
export default function globalSetup(): void {
  const leftovers = findLeftoverTestProcesses({ ports: [] });
  if (leftovers.length > 0) {
    throw new Error(
      `Refusing to start: ${leftovers.length} browser/test process(es) from an earlier run are still running:\n` +
        `${formatProcesses(leftovers)}\nStop them first, for example:\n${killCommandHint(leftovers)}`,
    );
  }

  installCleanup({
    handleSignalsAndErrors: false,
    log: (msg) => process.stderr.write(`[e2e process guard] ${msg}\n`),
    cleanup: (reason) => {
      const killed = killAllChildTrees();
      process.stderr.write(`[e2e process guard] ${reason}: killed ${killed.length} child process tree(s)\n`);
    },
  });
}
