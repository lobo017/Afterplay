import { defineConfig, devices } from '@playwright/test';
import { SITE_PORT, SITE_URL, pageChannel } from './tests/e2e/helpers/site';

const channel = pageChannel();

export default defineConfig({
  testDir: './tests/e2e',
  // Playwright wipes its output folder on every run; keep it apart from
  // test-results/perf-logs so perf run logs survive e2e runs.
  outputDir: './test-results/playwright',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  // On Juno the job also asks for a JSON report (PLAYWRIGHT_JSON_OUTPUT_NAME), which hpc/summarize.mjs reads
  reporter: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ? [['list'], ['json']] : 'list',
  use: {
    baseURL: SITE_URL,
    trace: 'on-first-retry',
    // The app's service worker caches the whole build on first load; tests run without it
    // (a fresh profile each, nothing to reuse) except phase8-offline.spec.ts, which turns it on.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(channel ? { channel } : {}),
      },
    },
  ],
  webServer: {
    command: `node scripts/serve.mjs --port ${SITE_PORT}`,
    url: SITE_URL,
    // A server already on the port is reused on the laptop. On a shared cluster node it would be somebody
    // else's build, so a job (WC_PORT set) always starts its own and fails if the port is taken.
    reuseExistingServer: !process.env.CI && !process.env.WC_PORT,
    timeout: 30000,
    // Playwright starts the server through a shell, outside the runner's process tree,
    // so a force-killed runner used to leave it running. The server now exits when the
    // runner does.
    env: { WC_EXIT_WITH_PARENT_PID: String(process.pid) },
  },
});
