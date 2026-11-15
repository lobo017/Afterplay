import { expect, test } from '@playwright/test';

// The wording pass: "Tap" on a touch screen and "Click" with a mouse, and no capture-extension banner on the hosted site.
const touchProject = () => test.info().project.name === 'webkit-iphone';

test.describe('Wording: Tap or Click, and the capture banner', () => {
  test('captions say Tap on the phone project and Click on the desktop projects', async ({ page }) => {
    await page.setViewportSize(touchProject() ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.goto('/#games');
    await page.evaluate(() => window.__wizardChessLibraryReady);
    await page.getByTestId('games-tab-insights').click();
    const coarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
    expect(coarse).toBe(touchProject());
    const hint = page.locator('section[aria-labelledby="ins-phase"] .wc-insight-hint');
    await expect(hint).toHaveText(
      `How well you play each part of the game. ${touchProject() ? 'Tap' : 'Click'} a bar to see the moves.`,
    );
  });

  test('the capture status shows on localhost and not on a hosted address; the Review-new-games switch stays', async ({
    page,
  }) => {
    await page.goto('/#games');
    await page.evaluate(() => window.__wizardChessLibraryReady);
    await expect(page.getByTestId('games-extension-status')).toBeVisible();

    // The same app served from a name that is not localhost (the test answers it from the real server)
    const real = new URL(page.url());
    await page.route('http://afterplay.example/**', async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: `${real.origin}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    });
    await page.goto('http://afterplay.example/#games');
    await page.evaluate(() => window.__wizardChessLibraryReady);
    await expect(page.getByTestId('games-list')).toBeVisible();
    await expect(page.getByTestId('games-extension-status')).toBeHidden();
    await expect(page.getByTestId('games-capture-detail')).toBeHidden();
    await expect(page.getByTestId('games-auto-analyze')).toBeAttached();
  });
});
