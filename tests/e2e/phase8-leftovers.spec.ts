import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Phase 8 leftovers: the review's "replaced N earlier engine annotations" counts only what an
// imported PGN brought, and a key moment's sentence is never cut off at phone width.
const SCREENSHOT_DIR = path.join('test-results', 'phase8-screens');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const PLAIN = '[White "Me"]\n[Black "Them"]\n[Result "0-1"]\n\n1. e4 e5 2. Qh5 Nc6 3. Qxe5+ Nxe5 0-1';
const LICHESS_ANALYSED = `[White "Me"]
[Black "Them"]
[Result "0-1"]

1. e4 { [%eval 0.2] } 1... e5 { [%eval 0.3] } 2. Qh5 { [%eval 0.1] } 2... Nc6 { [%eval 0.9] } 3. Qxe5+?? { [%eval -8.0] (0.90 → -8.00) Blunder. Bc4 was best. } 3... Nxe5 { [%eval -8.1] } 0-1`;

async function openReview(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/#review');
  await expect(page.getByTestId('analysis-layout')).toBeVisible();
}

async function review(page: Page, pgn: string): Promise<void> {
  await page.evaluate((text) => window.__wizardChessAnalysis!.controller.importPgn(text), pgn);
  await page.getByTestId('btn-review-start').click();
  await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 90_000 });
}

/** The status line's details (its tooltip text). */
const details = (page: Page) => page.getByTestId('review-status-tooltip').textContent();

test.describe('Phase 8 — leftovers', () => {
  test('"replaced N earlier engine annotations" counts imported ones only, not the app’s own evals', async ({ page }) => {
    test.setTimeout(240_000);
    await openReview(page, 1440, 900);
    // Live analysis writes its own evals on the moves it looks at; none of them were imported
    await page.evaluate((pgn) => window.__wizardChessAnalysis!.controller.importPgn(pgn), PLAIN);
    await page.keyboard.press('Home');
    if ((await page.getByTestId('toggle-analysis-engine').getAttribute('aria-pressed')) !== 'true') {
      await page.getByTestId('toggle-analysis-engine').click();
    }
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => page.evaluate(() => window.__wizardChessAnalysis!.controller.getGameTree().currentNode.eval?.app === true), { timeout: 30_000 }).toBe(true);
    }
    await page.getByTestId('btn-review-start').click();
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 90_000 });
    expect(await details(page)).not.toContain('replaced');

    // A second review of the same game replaces the first one's evals and text: still nothing imported
    await page.getByTestId('btn-review-start').click();
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 90_000 });
    expect(await details(page)).not.toContain('replaced');

    // A PGN that came with another site's analysis: those are counted (6 evals, 1 NAG, 1 comment, 1 variation at least)
    await review(page, LICHESS_ANALYSED);
    expect(await details(page)).toMatch(/replaced \d+ earlier engine annotations/);
  });

  test('phone: a key moment’s sentence is complete and the row does not scroll sideways', async ({ page }) => {
    test.setTimeout(180_000);
    await openReview(page, 390, 844);
    // The built-in sample game has five key moments: the most a row of chips has to hold
    await page.getByTestId('select-review-preset').selectOption('quick');
    await page.getByTestId('btn-review-sample').click();
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 150_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const moments = page.getByTestId('review-key-moments').locator('.wc-review-moment');
    expect(await moments.count()).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'review-key-moments-phone.png'), fullPage: true });
    // All five chips are inside the row: none is scrolled or clipped out of sight
    const count = await moments.count();
    expect(count).toBe(5);
    const row = (await page.getByTestId('review-key-moments').boundingBox())!;
    for (let i = 0; i < count; i++) {
      const box = (await moments.nth(i).boundingBox())!;
      expect(box.x, `chip ${i}`).toBeGreaterThanOrEqual(row.x - 1);
      expect(box.x + box.width, `chip ${i}`).toBeLessThanOrEqual(row.x + row.width + 1);
      expect(box.y + box.height, `chip ${i}`).toBeLessThanOrEqual(row.y + row.height + 1);
    }
    // Every sentence of a key moment fits its box: nothing is clipped by an ellipsis or a line clamp
    const clipped = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('.wc-review-moment-text, .wc-review-moment-move, .wc-review-card-text, [data-testid="review-card-text"]')) {
        if (el.offsetParent === null) continue;
        const style = getComputedStyle(el);
        // Visually hidden helper text is clipped on purpose
        if (el.clientWidth <= 1) continue;
        if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) out.push(`${el.className}: ${el.textContent?.slice(0, 60)} (${style.overflow})`);
      }
      return out;
    });
    expect(clipped).toEqual([]);
  });

  test('Settings holds the analysis lines and the review depth, in step with the panels and remembered', async ({ page }) => {
    await openReview(page, 1440, 900);
    await page.getByTestId('review-shell-tab-analysis').click();
    await expect(page.getByTestId('select-multipv')).toHaveValue('3');
    await page.getByTestId('review-shell-tab-review').click();
    await expect(page.getByTestId('select-review-preset')).toHaveValue('quick');
    await page.getByTestId('btn-settings').click();
    await page.getByTestId('select-analysis-lines').selectOption('5');
    await page.getByTestId('select-review-default').selectOption('deep');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('select-review-preset')).toHaveValue('deep');
    await page.getByTestId('review-shell-tab-analysis').click();
    await expect(page.getByTestId('select-multipv')).toHaveValue('5');
    // And the other way round: the panels' own selects update Settings
    await page.getByTestId('select-multipv').selectOption('2');
    await page.getByTestId('review-shell-tab-review').click();
    await page.getByTestId('select-review-preset').selectOption('standard');
    await page.getByTestId('btn-settings').click();
    await expect(page.getByTestId('select-analysis-lines')).toHaveValue('2');
    await expect(page.getByTestId('select-review-default')).toHaveValue('standard');
    await page.keyboard.press('Escape');
    // Remembered
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.getByTestId('analysis-layout')).toBeVisible();
    await expect(page.getByTestId('select-review-preset')).toHaveValue('standard');
    await page.getByTestId('review-shell-tab-analysis').click();
    await expect(page.getByTestId('select-multipv')).toHaveValue('2');
  });
});
