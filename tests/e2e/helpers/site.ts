/**
 * Where the e2e tests find the app. The port is 4173 unless WC_PORT says otherwise: on a shared
 * machine (the Juno cluster) every job picks its own, so two jobs never reuse each other's server.
 * The capture extension's default site URL is built with the same port (scripts/build-extension.mjs).
 */
export const SITE_PORT = Number(process.env.WC_PORT) || 4173;
export const SITE_URL = `http://127.0.0.1:${SITE_PORT}`;
/** The same server under its other name. */
export const SITE_URL_LOCALHOST = `http://localhost:${SITE_PORT}`;

/**
 * Which browser the tests drive. On the Windows laptop that is the installed Chrome. Elsewhere (the
 * Playwright image on Linux) it is the bundled Chromium; the extension tests use Chromium's new
 * headless mode (`channel: 'chromium'`), the only headless mode that can load extensions.
 * WC_BROWSER_CHANNEL overrides both, and WC_HEADED=1 makes the extension tests open a real window
 * (the job then runs under xvfb-run).
 */
export function pageChannel(): string | undefined {
  return process.env.WC_BROWSER_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined);
}
export function extensionChannel(): string {
  return process.env.WC_BROWSER_CHANNEL || (process.platform === 'win32' ? 'chrome' : 'chromium');
}
export const EXTENSION_HEADLESS = process.env.WC_HEADED !== '1';
