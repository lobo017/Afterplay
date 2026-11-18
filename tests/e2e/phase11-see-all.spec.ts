import { expect, test } from '@playwright/test';

// The named bots on the New game card go lowest rating first. Every name here is invented.
const SAMPLE = '/start/sample/';

test.describe('Phase 11 — named bots by rating', () => {
  test('the New game card lists the named bots 800, 1200, 1500, 1800; test ids and the default stay', async ({
    page,
  }) => {
    // The sample preset with its bots in another order
    await page.route('**/start/sample/preset.json', async (route) => {
      const preset = (await (await route.fetch()).json()) as { bots: unknown[]; settings: Record<string, unknown> };
      preset.bots = [
        { name: 'Student Bot', rating: 1500, style: 'solid' },
        { name: 'Boss Bot', rating: 1800, style: 'aggressive' },
        { name: 'Warm-up Bot', rating: 800, style: 'solid' },
        { name: 'Even Bot', rating: 1200, style: 'gambiteer' },
      ];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(preset) });
    });
    await page.goto(SAMPLE);
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-first-run', 'applied', { timeout: 15_000 });
    const buttons = page.getByTestId('custom-bots').locator('button');
    await expect(buttons).toHaveCount(4);
    expect(await buttons.locator('.wc-custom-bot-rating').allTextContents()).toEqual(['800', '1200', '1500', '1800']);
    expect(await buttons.locator('.wc-custom-bot-name').allTextContents()).toEqual([
      'Warm-up Bot',
      'Even Bot',
      'Student Bot',
      'Boss Bot',
    ]);
    // Each test id still names the bot's place in the preset's list
    expect(await buttons.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).toEqual([
      'custom-bot-2',
      'custom-bot-3',
      'custom-bot-0',
      'custom-bot-1',
    ]);
    // The default selection (800) is still the one chosen
    await expect(page.getByTestId('custom-bot-2')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('bot-rating-label')).toHaveText('Warm-up Bot · Solid · 800 Elo');
    await page.getByTestId('welcome-done').click();
    await expect(page.getByTestId('welcome-sheet')).toBeHidden();
    await page.getByTestId('custom-bot-0').click();
    await expect(page.getByTestId('bot-rating-label')).toHaveText('Student Bot · Solid · 1500 Elo');
  });
});
