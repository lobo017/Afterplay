import { expect, test, type Page } from '@playwright/test';

// The review speed names carry no seconds anywhere: the Review tab, Settings › How thorough and the Games list.
const NAMES = ['Quick', 'Standard', 'Deep'];

const touch = () => test.info().project.name === 'webkit-iphone';

async function press(page: Page, testId: string): Promise<void> {
  const el = page.getByTestId(testId);
  if (touch()) await el.tap();
  else await el.click();
}

const optionTexts = (page: Page, testId: string) => page.getByTestId(testId).locator('option').allTextContents();

test.describe('Phase 11 — review speed names', () => {
  test('Review, Settings and the Games list name the speeds without seconds', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('play-layout')).toBeVisible();

    await press(page, 'mode-tab-review');
    await expect(page.getByTestId('analysis-layout')).toBeVisible();
    expect(await optionTexts(page, 'select-review-preset')).toEqual(NAMES);

    await press(page, 'btn-settings');
    await expect(page.getByTestId('settings-sheet')).toBeVisible();
    expect(await optionTexts(page, 'select-review-default')).toEqual(NAMES);
    await press(page, 'settings-sheet-close');

    await press(page, 'mode-tab-games');
    await press(page, 'games-tab-library');
    expect(await optionTexts(page, 'games-analyze-preset')).toEqual(NAMES);
  });
});
