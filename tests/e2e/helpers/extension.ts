import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type BrowserContext, type Page, type Route, type Worker } from '@playwright/test';
import { EXTENSION_HEADLESS, SITE_URL, SITE_URL_LOCALHOST, extensionChannel } from './site';

export { SITE_URL, SITE_URL_LOCALHOST };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const EXTENSION_DIR = path.join(ROOT, 'dist-ext');
export const CAPTURE_FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'capture');

/** Builds dist-ext/ from the current sources (once per worker). */
let built = false;
export function buildExtension(): void {
  if (built) return;
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-extension.mjs')], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 120_000,
  });
  built = true;
}

export interface ExtensionSession {
  context: BrowserContext;
  extensionId: string;
  worker: Worker;
  /** Mocked responses for lichess.org / chess.com; the last matching one answers. */
  mocks: MockRule[];
  /** Every request to a site other than the analysis site (mocked or blocked). */
  externalRequests: string[];
  close(): Promise<void>;
}

export type MockHandler = MockResponse | ((route: Route) => Promise<void> | void);

export interface MockRule {
  method?: string;
  /** A full URL, a URL prefix ending in "*", or a test. */
  url: string | ((url: string) => boolean);
  respond: MockHandler;
}

/** Adds a mock rule (later rules win over earlier ones). */
export function mock(session: ExtensionSession, url: MockRule['url'], respond: MockHandler, method?: string): void {
  session.mocks.push({ url, respond, method });
}

function ruleMatches(rule: MockRule, method: string, url: string): boolean {
  if (rule.method && rule.method !== method) return false;
  if (typeof rule.url === 'function') return rule.url(url);
  return rule.url.endsWith('*') ? url.startsWith(rule.url.slice(0, -1)) : url === rule.url;
}

/** A recorded game page without its script and style links (nothing of the site runs). */
export function stripPageAssets(html: string): string {
  return html
    .replace(/<script\b[^>]*\bsrc=[^>]*>\s*<\/script>/g, '')
    .replace(/<link\b[^>]*>/g, '')
    .replace(/<script nonce[^>]*>[\s\S]*?<\/script>/g, '');
}

export interface MockResponse {
  status?: number;
  body: string;
  contentType?: string;
  headers?: Record<string, string>;
}

/**
 * Starts Chrome with a fresh profile and the unpacked extension. Branded Chrome ignores
 * --load-extension (since Chrome 137), so the extension is loaded through CDP
 * Extensions.loadUnpacked, which --enable-unsafe-extension-debugging allows.
 *
 * Nothing reaches the network: requests to the analysis site go to the local server,
 * requests matching `mocks` get the recorded fixture, everything else is aborted.
 */
export interface LaunchOptions {
  /** Emulated time zone of every page (e.g. 'Asia/Tokyo'); the machine's by default. */
  timezoneId?: string;
  /** Runs after the mocks are routed, before the extension is loaded (e.g. tabs that were open before it). */
  beforeLoad?: (context: BrowserContext, mocks: MockRule[]) => Promise<void>;
}

export async function launchWithExtension(options: LaunchOptions = {}): Promise<ExtensionSession> {
  buildExtension();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ext-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: extensionChannel(),
    headless: EXTENSION_HEADLESS,
    viewport: { width: 1440, height: 900 },
    // The extension's own service worker has to run, so service workers are allowed here even though
    // the config blocks them for every other test (the site's worker then caches the build quietly)
    serviceWorkers: 'allow',
    args: ['--enable-unsafe-extension-debugging'],
    ignoreDefaultArgs: ['--disable-extensions'],
    ...(options.timezoneId ? { timezoneId: options.timezoneId } : {}),
  });
  const mocks: MockRule[] = [];
  const externalRequests: string[] = [];
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    // The site under both loopback names (the extension delivers to either)
    if (
      url.startsWith(SITE_URL) ||
      url.startsWith(SITE_URL_LOCALHOST) ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('data:')
    ) {
      await route.continue();
      return;
    }
    externalRequests.push(`${req.method()} ${url}`);
    const mock = [...mocks].reverse().find((r) => ruleMatches(r, req.method(), url))?.respond;
    if (!mock) {
      await route.abort('blockedbyclient');
      return;
    }
    if (typeof mock === 'function') {
      await mock(route);
      return;
    }
    await route.fulfill({
      status: mock.status ?? 200,
      body: mock.body,
      contentType: mock.contentType ?? 'text/html; charset=utf-8',
      headers: mock.headers,
    });
  });

  await options.beforeLoad?.(context, mocks);
  const browser = context.browser();
  if (!browser) throw new Error('No browser handle for CDP');
  const cdp = await browser.newBrowserCDPSession();
  const { id: extensionId } = (await cdp.send(
    'Extensions.loadUnpacked' as never,
    { path: EXTENSION_DIR } as never,
  )) as {
    id: string;
  };
  const isOurs = (w: Worker) => w.url().startsWith(`chrome-extension://${extensionId}/`);
  const worker =
    context.serviceWorkers().find(isOurs) ??
    (await context.waitForEvent('serviceworker', { predicate: isOurs, timeout: 15_000 }));
  // onInstalled has registered the bridge on the default site URL
  await expect
    .poll(
      () =>
        worker.evaluate(async () =>
          (await chrome.scripting.getRegisteredContentScripts()).map((s) => [...(s.matches ?? [])].sort().join(',')),
        ),
      { timeout: 10_000 },
    )
    .toEqual([`${SITE_URL}/*,${SITE_URL_LOCALHOST}/*`]);

  return {
    context,
    extensionId,
    worker,
    mocks,
    externalRequests,
    async close() {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

export function readFixture(rel: string): string {
  return fs.readFileSync(path.join(CAPTURE_FIXTURES, rel), 'utf8');
}

export async function badgeText(worker: Worker): Promise<string> {
  return worker.evaluate(() => chrome.action.getBadgeText({}));
}

/**
 * Opens the popup as a page. `debugTab`: the tab its "Debug this tab" looks at (as a page of
 * its own, the popup's own tab is the active one).
 */
export async function openPopup(session: ExtensionSession, debugTab?: number): Promise<Page> {
  const page = await session.context.newPage();
  await page.goto(
    `chrome-extension://${session.extensionId}/popup.html${debugTab !== undefined ? `?tab=${debugTab}` : ''}`,
  );
  await expect(page.locator('body')).toHaveAttribute('data-loaded', 'true');
  return page;
}

/** Sets my usernames through the popup's settings form. */
export async function setUsernames(
  session: ExtensionSession,
  lichess: string,
  chesscom: string,
  options: { autoCapture?: boolean } = {},
): Promise<void> {
  const popup = await openPopup(session);
  await popup.getByTestId('popup-settings').locator('summary').click();
  await popup.getByTestId('popup-lichess-user').fill(lichess);
  await popup.getByTestId('popup-chesscom-user').fill(chesscom);
  await popup.getByTestId('popup-auto-capture').setChecked(options.autoCapture ?? true);
  await popup.getByTestId('popup-settings-save').click();
  await expect(popup.getByTestId('popup-settings-result')).toHaveText('Saved.');
  await popup.close();
}

export async function queueEntry(session: ExtensionSession, key: string): Promise<Record<string, unknown> | null> {
  return session.worker.evaluate(async (k) => {
    const api = (self as unknown as { __wizardChessCapture: { queue: { get(key: string): Promise<unknown> } } })
      .__wizardChessCapture;
    return (await api.queue.get(k)) as Record<string, unknown> | null;
  }, key);
}

/** The browser's tab ID of the tab showing `url` (for the popup's Debug view). */
export async function tabIdOf(session: ExtensionSession, url: string): Promise<number> {
  const id = await session.worker.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url === u)?.id ?? null;
  }, url);
  if (id === null) throw new Error(`No tab shows ${url}`);
  return id;
}

/** Opens the analysis site on the Games list and waits for its library. */
export async function openGamesList(session: ExtensionSession): Promise<Page> {
  const page = await session.context.newPage();
  await page.goto(`${SITE_URL}/#games`);
  await page.evaluate(() => window.__wizardChessLibraryReady);
  await expect(page.getByTestId('games-list')).toBeVisible();
  return page;
}
