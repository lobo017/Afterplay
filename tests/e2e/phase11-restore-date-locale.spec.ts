import { expect, test, type Page } from '@playwright/test';
import { SITE_URL } from './helpers/site';

// The date in the restore dialog is formatted by the background worker (so the page does not pay for the browser's
// first date formatting on the click that chooses a file). The worker and the page must agree on the person's locale
// and time zone: the dialog's date has to be exactly what the page itself writes for the same moment. Invented data only.

// 12 Nov 2026, 23:30 UTC: the 12th in UTC and in the Americas, the 13th in Auckland (UTC+13 in November)
const EXPORTED_AT = Date.UTC(2026, 10, 12, 23, 30, 0);

const LOCALES = [
  { locale: 'en-GB', timezoneId: 'Pacific/Auckland' },
  { locale: 'de-DE', timezoneId: 'Europe/Berlin' },
  { locale: 'en-US', timezoneId: 'America/Los_Angeles' },
] as const;

const backupText = (): string =>
  JSON.stringify({
    format: 'wizards-chess-backup',
    schemaVersion: 4,
    exportedAt: EXPORTED_AT,
    games: [],
    settings: [],
    puzzles: [],
    srsCards: [],
    reviews: [],
  });

/** What the page itself writes for the export moment, in its own locale and time zone. */
const pageDate = (page: Page): Promise<string> => page.evaluate((at) => new Date(at).toLocaleDateString(), EXPORTED_AT);

test.describe('Phase 0 — the restore dialog writes the backup date as the page would', () => {
  for (const { locale, timezoneId } of LOCALES) {
    test(`locale ${locale}, time zone ${timezoneId}`, async ({ browser }) => {
      const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = test.info().project.use;
      const context = await browser.newContext({
        baseURL: SITE_URL,
        serviceWorkers: 'block',
        locale,
        timezoneId,
        ...(viewport ? { viewport } : {}),
        ...(userAgent ? { userAgent } : {}),
        ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
        ...(isMobile !== undefined ? { isMobile } : {}),
        ...(hasTouch !== undefined ? { hasTouch } : {}),
        storageState: {
          cookies: [],
          origins: [
            {
              origin: SITE_URL,
              localStorage: [
                { name: 'wc.story.v1', value: 'skipped' },
                { name: 'wc-install-guide-seen', value: '1' },
              ],
            },
          ],
        },
      });
      try {
        const page = await context.newPage();
        await page.goto('/');
        await expect(page.getByTestId('play-layout')).toBeVisible();
        await page.evaluate(() => window.__wizardChessLibraryReady);

        // The page really runs in the locale and zone asked for (otherwise the comparison below proves nothing)
        const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions());
        expect(zone.timeZone).toBe(timezoneId);
        expect(zone.locale.startsWith(locale.slice(0, 2))).toBe(true);

        await page.getByTestId('btn-settings').click();
        await expect(page.getByTestId('settings-sheet')).toBeVisible();
        await page.getByTestId('backup-file-input').setInputFiles({
          name: 'backup.json',
          mimeType: 'application/json',
          buffer: Buffer.from(backupText()),
        });
        await expect(page.getByTestId('backup-confirm')).toBeVisible();

        const expected = await pageDate(page);
        const text = (await page.getByTestId('backup-confirm-text').textContent()) ?? '';
        const shown = /^Restore this backup from (.+?)\? It holds /.exec(text)?.[1];
        expect(shown, `the dialog's sentence did not carry a date: ${text.slice(0, 40)}`).toBeDefined();
        expect(shown).toBe(expected);
      } finally {
        await context.close();
      }
    });
  }
});
