import { defineConfig, devices } from '@playwright/test';
import { SITE_PORT, SITE_URL, pageChannel } from './tests/e2e/helpers/site';

const channel = pageChannel();
/** Specs that load the capture extension (a Chrome MV3 extension: Chromium only). */
const CHROME_ONLY_SPECS = [/phase5b-extension\.spec/, /phase5b-live-capture\.spec/, /phase5b-delivery\.spec/];
/**
 * Playwright's WebKit runs these tests 1.5-3× slower than Chromium (each locator click waits for the element to be
 * stable, 300-500 ms), so a test that takes 15-20 s in Chromium can take over 30 s. Tests that set their own limit keep it.
 */
const WEBKIT_TEST_TIMEOUT_MS = 60_000;
/** The localStorage entry the install guide writes once it has been seen (src/ui/install-guide.ts). */
const INSTALL_GUIDE_SEEN = { name: 'wc-install-guide-seen', value: '1' };

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
    // Safari's engine (Playwright's WebKit build), at desktop size and as an iPhone (390 × 664, touch,
    // iPhone user agent, so the app picks its phone engine profile). The capture extension is Chrome-only.
    {
      name: 'webkit',
      testIgnore: CHROME_ONLY_SPECS,
      timeout: WEBKIT_TEST_TIMEOUT_MS,
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'webkit-iphone',
      testIgnore: CHROME_ONLY_SPECS,
      timeout: WEBKIT_TEST_TIMEOUT_MS,
      use: {
        ...devices['iPhone 13'],
        // The first-run "Add to Home Screen" guide would cover the board in every test; its own test opens a
        // context without this (tests/e2e/phase11-iphone.spec.ts).
        storageState: { cookies: [], origins: [{ origin: SITE_URL, localStorage: [INSTALL_GUIDE_SEEN] }] },
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
