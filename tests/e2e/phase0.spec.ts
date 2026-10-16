import path from 'node:path';
import { expect, test } from '@playwright/test';

test.describe('Phase 0 — Application Shell & Offline Isolation', () => {
  test('renders app shell with COOP/COEP isolation, zero external requests, and working backtick dev overlay', async ({
    page,
  }) => {
    const externalRequests: string[] = [];
    const consoleErrors: string[] = [];

    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
        externalRequests.push(request.url());
      }
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    page.on('pageerror', (err) => {
      consoleErrors.push(err.message);
    });

    const response = await page.goto('/');
    expect(response?.status()).toBe(200);

    // Verify COOP/COEP headers on the HTTP response
    const headers = response?.headers() ?? {};
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-embedder-policy']).toBe('require-corp');

    // Verify window.crossOriginIsolated is true in the browser context
    const isIsolated = await page.evaluate(() => window.crossOriginIsolated);
    expect(isIsolated).toBe(true);

    // Verify shell renders cleanly
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page.getByRole('heading', { name: "Wizard's Chess" })).toBeVisible();
    await expect(page.getByTestId('isolation-badge')).toContainText('COOP/COEP Isolated');

    // Verify dev overlay is hidden initially and toggles on backtick (`) key
    const devOverlay = page.getByTestId('dev-overlay');
    await expect(devOverlay).toBeHidden();

    if (process.env.SCREENSHOT_DIR) {
      await page.screenshot({
        path: path.join(process.env.SCREENSHOT_DIR, 'phase0-shell.png'),
        fullPage: true,
      });
    }

    await page.keyboard.press('`');
    await expect(devOverlay).toBeVisible();
    await expect(devOverlay).toContainText('DEV OVERLAY');
    await expect(devOverlay).toContainText('FPS');
    await expect(devOverlay).toContainText('p95 Frame');

    if (process.env.SCREENSHOT_DIR) {
      await page.screenshot({
        path: path.join(process.env.SCREENSHOT_DIR, 'phase0-dev-overlay.png'),
        fullPage: true,
      });
    }

    // Toggle off via header button
    await page.getByTestId('toggle-dev-overlay').click();
    await expect(devOverlay).toBeHidden();

    // Ensure zero external network requests and zero console errors
    expect(externalRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
