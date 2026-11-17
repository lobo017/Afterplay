import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Two small fixes: the named bots on the New game card go lowest rating first, and the Review tab's key-moment chips
// get a "Browse all N moments" link that opens "All moves by class". Every game and name here is invented.
const SCREENSHOT_DIR = path.join('test-results', 'phase11-screens');
const SAMPLE = '/start/sample/';

// An invented game with errors on both sides: more Mistake, Blunder and Miss moves than five chips can hold
const ERRORS_PGN = `[White "Ann"]
[Black "Ben"]
[Result "*"]

1. e4 e5 2. Qh5 Nc6 3. Qxe5+ Nxe5 4. d4 Nc6 5. d5 Nb4 6. a3 Nxd5 7. exd5 Qe7+ 8. Be2 Qxe2+ 9. Nxe2 d6 10. Nbc3 Bg4 11. Nf4 Nf6 12. Nb5 a6 13. Nxc7+ Kd7 14. Nxa8 *`;

const touch = () => test.info().project.name === 'webkit-iphone';

async function press(page: Page, testId: string): Promise<void> {
  const el = page.getByTestId(testId);
  if (touch()) await el.tap();
  else await el.click();
}

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

const SIZES = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
] as const;

/** Opens Review, reviews the invented game at Quick, and waits for it. */
async function reviewErrorsGame(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto('/#review');
  await expect(page.getByTestId('analysis-layout')).toBeVisible();
  await page.getByTestId('select-review-preset').selectOption('quick');
  await page.evaluate((pgn) => window.__wizardChessAnalysis!.controller.importPgn(pgn), ERRORS_PGN);
  await page.getByTestId('btn-review-start').click();
  await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 150_000 });
}

test.describe('Phase 11 — Browse all moments', () => {
  for (const size of SIZES) {
    test(`the link follows the fold's counts when the chips already show them all (${size.width}x${size.height})`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await reviewErrorsGame(page, size);
      const link = page.getByTestId('btn-review-see-all');
      const chips = page.getByTestId('review-key-moments').locator('.wc-review-moment');
      const slugs = ['brilliant', 'great', 'miss', 'mistake', 'blunder'];
      const row = page.getByTestId('review-key-moments');
      const card = page.getByTestId('review-move-card');
      const measure = async () => ({
        height: await page.evaluate(() => document.documentElement.scrollHeight),
        row: (await row.boundingBox())!.height,
        gap: (await card.boundingBox())!.y - (await row.boundingBox())!.y - (await row.boundingBox())!.height,
      });
      // Nothing moves after the review finishes
      const first = await measure();
      await page.waitForTimeout(600);
      expect(await measure()).toEqual(first);
      for (const [perspective, sides] of [
        ['both', ['w', 'b']],
        ['w', ['w']],
        ['b', ['b']],
      ] as const) {
        await press(page, `review-perspective-${perspective}`);
        // N from the fold's own counts for the viewed side(s)
        let n = 0;
        for (const slug of slugs)
          for (const c of sides) n += Number(await page.getByTestId(`review-count-${slug}-${c}`).textContent());
        const shown = await chips.count();
        if (n > shown) await expect(link).toBeVisible();
        else {
          await expect(link).toBeHidden();
          // Hidden, the link takes no room: it is not rendered, the card follows the chips at the usual gap, and the
          // page and the chip rows stay as they were
          await expect(link).toHaveCSS('display', 'none');
          const now = await measure();
          expect(now.gap).toBeLessThan(24);
          expect(now.row).toBeCloseTo(first.row, 0);
          expect(now.height).toBe(first.height);
        }
      }
    });

    test(`with more moments than chips the link shows, opens the fold and fits (${size.width}x${size.height})`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await reviewErrorsGame(page, size);
      const link = page.getByTestId('btn-review-see-all');
      const fold = page.getByTestId('review-classes');
      const row = page.getByTestId('review-key-moments');
      const rowBefore = (await row.boundingBox())!;
      const bodyBefore = await page.evaluate(() => document.documentElement.scrollHeight);

      // Give the first twelve plies the classes the link counts (the engine alone finds only a few at Quick)
      await page.evaluate(() => {
        const panel = window.__wizardChessReview!.panel;
        const classes = ['Mistake', 'Blunder', 'Miss', 'Brilliant', 'Great', 'Mistake'] as const;
        panel
          .getReview()!
          .moves.slice(0, 12)
          .forEach((m, i) => (m.classification = classes[i % classes.length]!));
        panel.setPerspective('both');
      });
      const expected = (perspective: 'w' | 'b' | 'both') =>
        page.evaluate((p) => {
          const wanted = ['Brilliant', 'Great', 'Miss', 'Mistake', 'Blunder'];
          return window
            .__wizardChessReview!.panel.getReview()!
            .moves.filter((m) => (p === 'both' || m.color === p) && wanted.includes(m.classification)).length;
        }, perspective);

      for (const perspective of ['both', 'w', 'b'] as const) {
        await press(page, `review-perspective-${perspective}`);
        const n = await expected(perspective);
        const shown = await page.getByTestId('review-key-moments').locator('.wc-review-moment').count();
        expect(n).toBeGreaterThan(0);
        if (n > shown) {
          await expect(link).toBeVisible();
          await expect(link).toHaveText(`Browse all ${n} moments`);
          await expect(link).toHaveAccessibleName('Browse all moments');
          const box = (await link.boundingBox())!;
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(size.width);
        } else {
          await expect(link).toBeHidden();
        }
        // The three reserved chip rows never change, nothing below moves, and the page never scrolls sideways
        expect((await row.boundingBox())!.height).toBeCloseTo(rowBefore.height, 0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
        // Hidden, the link adds nothing to the page; shown, it adds its own 44 px or more
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        if (n > shown) expect(height).toBeGreaterThanOrEqual(bodyBefore + 44);
        else expect(height).toBe(bodyBefore);
      }

      await press(page, 'review-perspective-both');
      await expect(link).toBeVisible();
      await link.scrollIntoViewIfNeeded();
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `${test.info().project.name}-see-all-${size.width}.png`),
      });
      await expect(fold).not.toHaveJSProperty('open', true);
      await press(page, 'btn-review-see-all');
      await expect(fold).toHaveJSProperty('open', true);
      await expect(page.getByTestId('review-counts')).toBeInViewport({ timeout: 5000 });
    });
  }
});
