import { expect, test, type Page } from '@playwright/test';

// Drag accuracy: the drop square is the square that contains the pointer, the same one the hover
// highlight shows, with no pull toward legal squares. Real mouse events at exact pixel positions.
const VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
] as const;
const FRACTIONS = [0.1, 0.5, 0.9] as const;

async function openPlay(page: Page, viewport: { width: number; height: number }, flipped: boolean): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto('/');
  await expect(page.getByTestId('play-layout')).toBeVisible();
  await page.evaluate(() => window.__wizardChessPlay!.boardFeel.reset());
  await page.evaluate((f) => {
    const c = window.__wizardChessPlay!.controller;
    c.getBoard().setFlipped(f);
  }, flipped);
}

async function squareBox(page: Page, sq: string) {
  const box = await page.getByTestId('play-layout').getByTestId(`square-${sq}`).boundingBox();
  if (!box) throw new Error(`square-${sq} has no box`);
  return box;
}

async function hasPiece(page: Page, sq: string): Promise<boolean> {
  return (await page.getByTestId('play-layout').getByTestId(`piece-${sq}`).count()) > 0;
}

test.describe('Drag accuracy: the drop square is the one under the pointer', () => {
  for (const viewport of VIEWPORTS) {
    for (const flipped of [false, true]) {
      test(`${viewport.width}x${viewport.height}, ${flipped ? 'black' : 'white'} at the bottom: hover square equals the square under the pointer at 10, 50 and 90 percent`, async ({
        page,
      }) => {
        await openPlay(page, viewport, flipped);
        const home = await squareBox(page, 'e2');
        const hover = page.getByTestId('overlay-hover-square');
        // The e2 pawn can go to e3 and e4. Probe squares around them, including its own square and
        // the squares just beside, above and below the legal ones.
        const probes = ['e2', 'e3', 'e4', 'e5', 'd3', 'f3', 'd2', 'f2', 'e1'];
        await page.mouse.move(home.x + home.width / 2, home.y + home.height / 2);
        await page.mouse.down();
        for (const sq of probes) {
          const box = await squareBox(page, sq);
          for (const fy of FRACTIONS) {
            for (const fx of FRACTIONS) {
              await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 3 });
              await expect(hover, `${sq} at ${fx},${fy}`).toHaveAttribute('data-square', sq);
            }
          }
        }
        await page.mouse.up();
      });
    }
  }

  test('releasing on a legal square at its 10, 50 and 90 percent edges plays that move; beside it does not', async ({
    page,
  }) => {
    await openPlay(page, VIEWPORTS[2], false);
    const checks: Array<{ over: string; expectMove: boolean }> = [
      { over: 'e3', expectMove: true },
      { over: 'e5', expectMove: false },
      { over: 'd3', expectMove: false },
    ];
    for (const { over, expectMove } of checks) {
      for (const f of FRACTIONS) {
        await page.goto('/');
        await expect(page.getByTestId('play-layout')).toBeVisible();
        await page.evaluate(() => window.__wizardChessPlay!.boardFeel.reset());
        const home = await squareBox(page, 'e2');
        const box = await squareBox(page, over);
        await page.mouse.move(home.x + home.width / 2, home.y + home.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * f, box.y + box.height * f, { steps: 6 });
        await page.mouse.up();
        if (expectMove) {
          await expect.poll(() => hasPiece(page, 'e3'), `${over} ${f}`).toBe(true);
        } else {
          expect(await hasPiece(page, 'e3'), `${over} ${f}`).toBe(false);
          expect(await hasPiece(page, 'e4'), `${over} ${f}`).toBe(false);
          expect(await hasPiece(page, 'e2'), `${over} ${f}`).toBe(true);
        }
      }
    }
  });

  test('releasing a drag on its own square cancels it, also with a small wobble', async ({ page }) => {
    await openPlay(page, VIEWPORTS[2], false);
    const home = await squareBox(page, 'e2');
    for (const [fx, fy] of [
      [0.5, 0.5],
      [0.1, 0.1],
      [0.9, 0.1],
      [0.1, 0.9],
      [0.9, 0.9],
    ] as const) {
      await page.mouse.move(home.x + home.width / 2, home.y + home.height / 2);
      await page.mouse.down();
      // Out past the drag threshold, then back to a point inside the origin square
      await page.mouse.move(home.x + home.width / 2, home.y - home.height * 2, { steps: 5 });
      await page.mouse.move(home.x + home.width * fx, home.y + home.height * fy, { steps: 5 });
      await page.mouse.up();
      expect(await hasPiece(page, 'e2'), `${fx},${fy}`).toBe(true);
      expect(await hasPiece(page, 'e3')).toBe(false);
      expect(await hasPiece(page, 'e4')).toBe(false);
    }
  });

  test('a wobble inside the drag threshold is a click, not a drag', async ({ page }) => {
    await openPlay(page, VIEWPORTS[2], false);
    const home = await squareBox(page, 'e2');
    await page.mouse.move(home.x + home.width / 2, home.y + home.height / 2);
    await page.mouse.down();
    await page.mouse.move(home.x + home.width / 2 + 1, home.y + home.height / 2 + 1);
    await page.mouse.up();
    expect(await hasPiece(page, 'e2')).toBe(true);
    expect(await hasPiece(page, 'e3')).toBe(false);
    await expect(page.getByTestId('overlay-selected-square')).toHaveAttribute('data-square', 'e2');
    // The second such click on it deselects it
    await page.mouse.move(home.x + home.width * 0.9, home.y + home.height * 0.1);
    await page.mouse.down();
    await page.mouse.move(home.x + home.width * 0.9 - 1, home.y + home.height * 0.1 + 1);
    await page.mouse.up();
    await expect(page.getByTestId('overlay-selected-square')).toHaveCount(0);
    expect(await hasPiece(page, 'e2')).toBe(true);
  });

  test('a premove drag (the opponent is on move) is accurate too, at 10, 50 and 90 percent', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS[1]);
    await page.goto('/');
    await expect(page.getByTestId('play-layout')).toBeVisible();
    await page.evaluate(() => {
      const c = window.__wizardChessPlay!.controller;
      c.setBotDelayRangeMs(30_000, 30_000);
      c.loadPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'b');
    });
    const home = await squareBox(page, 'e7');
    const hover = page.getByTestId('overlay-hover-square');
    await page.mouse.move(home.x + home.width / 2, home.y + home.height / 2);
    await page.mouse.down();
    for (const sq of ['e7', 'e6', 'e5', 'e4', 'd7', 'f7']) {
      const box = await squareBox(page, sq);
      for (const f of FRACTIONS) {
        await page.mouse.move(box.x + box.width * f, box.y + box.height * (1 - f), { steps: 3 });
        await expect(hover, `${sq} at ${f}`).toHaveAttribute('data-square', sq);
        await expect(hover, `${sq} at ${f}`).toHaveAttribute(
          'data-target',
          sq === 'e6' || sq === 'e5' ? 'true' : 'false',
        );
      }
    }
    await page.mouse.up();
  });

  test('a resize or a scroll during a drag re-measures the board: the piece and the hover keep following the pointer', async ({
    page,
  }) => {
    await openPlay(page, VIEWPORTS[2], false);
    const home = await squareBox(page, 'e2');
    const hover = page.getByTestId('overlay-hover-square');
    await page.mouse.move(home.x + home.width / 2, home.y + home.height / 2);
    await page.mouse.down();
    const e3 = await squareBox(page, 'e3');
    await page.mouse.move(e3.x + e3.width / 2, e3.y + e3.height / 2, { steps: 4 });
    await expect(hover).toHaveAttribute('data-square', 'e3');

    // The viewport changes mid-drag (the board is a different size and place afterwards)
    await page.setViewportSize({ width: 900, height: 700 });
    const e3After = await squareBox(page, 'e3');
    const e4After = await squareBox(page, 'e4');
    await page.mouse.move(e4After.x + e4After.width * 0.1, e4After.y + e4After.height * 0.9, { steps: 4 });
    await expect(hover).toHaveAttribute('data-square', 'e4');
    const held = await page
      .getByTestId('play-layout')
      .getByTestId('piece-e2')
      .evaluate((el) => (el as HTMLElement).style.transform);
    expect(held).toContain('scale(');
    expect(held).not.toBe('');

    // The board moves on screen by a scroll: the next move is measured against its new place
    await page.evaluate(() => {
      const layout = document.querySelector<HTMLElement>('[data-testid="play-layout"]')!;
      layout.style.position = 'relative';
      layout.style.top = '37px';
      window.dispatchEvent(new Event('scroll'));
    });
    const e3Moved = await squareBox(page, 'e3');
    expect(Math.round(e3Moved.y - e3After.y)).toBe(37);
    await page.mouse.move(e3Moved.x + e3Moved.width * 0.5, e3Moved.y + e3Moved.height * 0.1, { steps: 4 });
    await expect(hover).toHaveAttribute('data-square', 'e3');
    await page.mouse.up();
    await expect.poll(() => hasPiece(page, 'e3')).toBe(true);
  });
});
