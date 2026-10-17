import { defineConfig, devices } from '@playwright/test';

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
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
      },
    },
  ],
  webServer: {
    command: 'node scripts/serve.mjs --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
    // Playwright starts the server through a shell, outside the runner's process tree,
    // so a force-killed runner used to leave it running. The server now exits when the
    // runner does.
    env: { WC_EXIT_WITH_PARENT_PID: String(process.pid) },
  },
});
