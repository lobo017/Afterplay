import { expect, test, type Page } from '@playwright/test';

// The My mistakes tab says that its puzzles do not change the rating (they are practice; only Rated puzzles do). One line,
// under the puzzle, in the small muted text of the source line: it must not push the puzzle card down, nor be cut off or
// sit behind the tab bar on a phone.
const NOTE = 'Practice from your own games. Solve Rated puzzles to change your rating.';

async function openMode(page: Page, mode: 'mistakes' | 'rated' | 'review'): Promise<void> {
  await page.evaluate(async (m) => {
    const api = await window.__wizardChessPuzzlesReady!;
    await api.open(m);
  }, mode);
  await expect(page.getByTestId('puzzle-trainer')).toBeVisible();
  await expect(page.getByTestId(`puzzle-mode-${mode}`)).toHaveAttribute('aria-selected', 'true');
}

test.describe('My mistakes: the unrated note', () => {
  test('is there on My mistakes only, with the exact text', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 810 });
    await page.goto('/#train');
    await page.evaluate(() => window.__wizardChessPuzzlesReady);
    await expect(page.getByTestId('today-screen')).toHaveAttribute('data-state', 'ready');
    const note = page.getByTestId('puzzle-unrated-note');
    await openMode(page, 'mistakes');
    await expect(note).toBeVisible();
    await expect(note).toHaveText(NOTE);
    await openMode(page, 'rated');
    await expect(note).toBeHidden();
    await openMode(page, 'review');
    await expect(note).toBeHidden();
    await openMode(page, 'mistakes');
    await expect(note).toHaveText(NOTE);
  });

  for (const size of [
    { width: 375, height: 667 },
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
  ]) {
    test(`at ${size.width}x${size.height}: whole, not cut off, below the card and not pushing it`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto('/#train');
      await page.evaluate(() => window.__wizardChessPuzzlesReady);
      await expect(page.getByTestId('today-screen')).toHaveAttribute('data-state', 'ready');
      await openMode(page, 'mistakes');
      const note = page.getByTestId('puzzle-unrated-note');
      await expect(note).toBeVisible();
      await note.scrollIntoViewIfNeeded();
      const m = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-testid="puzzle-unrated-note"]')!;
        const card = document.querySelector<HTMLElement>('.wc-puzzle-card')!;
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const cardTop = card.getBoundingClientRect().top + window.scrollY;
        el.hidden = true;
        const cardTopWithout = card.getBoundingClientRect().top + window.scrollY;
        el.hidden = false;
        return {
          left: r.left,
          right: r.right,
          top: r.top + window.scrollY,
          cardBottom: card.getBoundingClientRect().bottom + window.scrollY,
          clippedX: el.scrollWidth > el.clientWidth + 1,
          clippedY: el.scrollHeight > el.clientHeight + 1,
          lines: Math.round(r.height / parseFloat(getComputedStyle(el).lineHeight)),
          onTop: hit !== null && (hit === el || el.contains(hit)),
          cardTop,
          cardTopWithout,
          docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      expect(m.cardTop, 'the card does not move for the note').toBe(m.cardTopWithout);
      expect(m.top, 'the note is below the card').toBeGreaterThanOrEqual(m.cardBottom);
      expect(m.left).toBeGreaterThanOrEqual(0);
      expect(m.right).toBeLessThanOrEqual(size.width);
      expect(m.clippedX).toBe(false);
      expect(m.clippedY).toBe(false);
      expect(m.lines, 'at most two lines').toBeLessThanOrEqual(2);
      expect(m.onTop, 'nothing (the banner, the tab bar) covers it').toBe(true);
      expect(m.docOverflow).toBeLessThanOrEqual(0);
    });
  }
});
