import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Phase 6b: board feel. Press lifts the piece at once, drags highlight the drop square, drops
// are forgiving near edges and glide in, touch drags draw the piece above the finger, grab
// cursors, a resizable remembered board, the live tuning panel, and the review's
// classification badge on the board.
const SCREENSHOT_DIR = path.join('test-results', 'phase6b-screens');

type FeelPatch = Partial<{
  dragThresholdPx: number;
  liftScale: number;
  snapMs: number;
  dropTolerance: number;
  touchOffset: number;
  animationMs: number;
}>;

async function openPlay(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByTestId('play-layout')).toBeVisible();
  await page.evaluate(() => window.__wizardChessPlay!.boardFeel.reset());
}

async function setFeel(page: Page, patch: FeelPatch): Promise<void> {
  await page.evaluate((p) => window.__wizardChessPlay!.boardFeel.set(p), patch);
}

async function squareBox(page: Page, sq: string, root = 'play-layout') {
  const box = await page.getByTestId(root).getByTestId(`square-${sq}`).boundingBox();
  if (!box) throw new Error(`square-${sq} has no box`);
  return { ...box, cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

async function pieceState(page: Page, sq: string) {
  return page
    .getByTestId('play-layout')
    .getByTestId(`piece-${sq}`)
    .evaluate((el) => ({
      transform: (el as HTMLElement).style.transform,
      lifted: el.classList.contains('wc-piece-dragging'),
      animations: el.getAnimations().length,
    }));
}

async function hasPiece(page: Page, sq: string): Promise<boolean> {
  return (await page.getByTestId('play-layout').getByTestId(`piece-${sq}`).count()) > 0;
}

test.describe('Phase 6b — board feel', () => {
  test('Settings › Board feel tunes the board live, remembers the values, and resets them', async ({ page }) => {
    await openPlay(page);
    // (Phase 6b: the tuning panel moved from the dev overlay into Settings)
    await page.getByTestId('btn-settings').click();
    const panel = page.getByTestId('settings-board-feel');
    await expect(panel).toBeVisible();
    for (const key of ['dragThresholdPx', 'liftScale', 'snapMs', 'dropTolerance', 'touchOffset', 'animationMs']) {
      await expect(panel.getByTestId(`feel-${key}`)).toBeVisible();
    }
    await expect(panel.getByTestId('feel-value-liftScale')).toHaveText('1.12 ×');

    // Moving a slider changes the board at once
    await panel.getByTestId('feel-liftScale').fill('1.25');
    await expect(panel.getByTestId('feel-value-liftScale')).toHaveText('1.25 ×');
    await panel.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-board-feel-panel.png') });
    await page.keyboard.press('Escape');
    const e2 = await squareBox(page, 'e2');
    await page.mouse.move(e2.cx, e2.cy);
    await page.mouse.down();
    expect((await pieceState(page, 'e2')).transform).toContain('scale(1.25)');
    await page.mouse.up();

    // Remembered across a reload
    await page.reload();
    await expect(page.getByTestId('play-layout')).toBeVisible();
    expect(await page.evaluate(() => window.__wizardChessPlay!.boardFeel.get().liftScale)).toBe(1.25);
    await page.getByTestId('btn-settings').click();
    await expect(page.getByTestId('feel-liftScale')).toHaveValue('1.25');

    await page.getByTestId('btn-feel-reset').click();
    await expect(page.getByTestId('feel-value-liftScale')).toHaveText('1.12 ×');
    expect(await page.evaluate(() => localStorage.getItem('wc.boardFeel.v1'))).toBeNull();
  });

  test('pressing a piece lifts it at once; a click still selects and a second click deselects', async ({ page }) => {
    await openPlay(page);
    const e2 = await squareBox(page, 'e2');
    // Press a little off-centre: the piece centres itself under the pointer
    await page.mouse.move(e2.cx + 10, e2.cy - 8);
    const home = (await pieceState(page, 'e2')).transform;
    expect(home).toBe('translate3d(400%, 600%, 0px)');
    await page.mouse.down();
    const pressed = await pieceState(page, 'e2');
    expect(pressed.lifted).toBe(true);
    expect(pressed.transform).toContain('scale(1.12)');
    expect(pressed.transform).not.toBe(home);
    await expect(page.locator('html')).toHaveClass(/wc-grabbing/);
    await page.mouse.up();

    // A click: selected, and the piece settles back on its square
    await expect(page.getByTestId('overlay-selected-square')).toHaveAttribute('data-square', 'e2');
    await expect(page.getByTestId('overlay-legal-dot')).toHaveCount(2);
    const released = await pieceState(page, 'e2');
    expect(released.lifted).toBe(false);
    expect(released.transform).toBe(home);
    await expect(page.locator('html')).not.toHaveClass(/wc-grabbing/);

    // A second click on it deselects
    await page.mouse.click(e2.cx, e2.cy);
    await expect(page.getByTestId('overlay-selected-square')).toHaveCount(0);

    // Click-to-move still works
    await page.mouse.click(e2.cx, e2.cy);
    const e4 = await squareBox(page, 'e4');
    await page.mouse.click(e4.cx, e4.cy);
    await expect.poll(() => hasPiece(page, 'e4')).toBe(true);
  });

  test('a drag highlights the drop square; a drop just past a legal square lands on it and glides in', async ({
    page,
  }) => {
    await openPlay(page);
    await setFeel(page, { snapMs: 300 });
    const g1 = await squareBox(page, 'g1');
    const f3 = await squareBox(page, 'f3');
    const e4 = await squareBox(page, 'e4');

    await page.mouse.move(g1.cx, g1.cy);
    await page.mouse.down();
    // Over e4 (not a knight move): a faint frame
    await page.mouse.move(e4.cx, e4.cy, { steps: 6 });
    const hover = page.getByTestId('overlay-hover-square');
    await expect(hover).toHaveAttribute('data-square', 'e4');
    await expect(hover).toHaveAttribute('data-target', 'false');
    // 0.15 squares above f3 (inside f4): the tolerance picks f3, highlighted as a target
    const nearF3 = { x: f3.cx, y: f3.y - f3.height * 0.15 };
    await page.mouse.move(nearF3.x, nearF3.y, { steps: 6 });
    await expect(hover).toHaveAttribute('data-square', 'f3');
    await expect(hover).toHaveAttribute('data-target', 'true');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'desktop-drag-target.png'),
      clip: { x: f3.x - f3.width * 2, y: f3.y - f3.height * 2, width: f3.width * 5, height: f3.height * 4 },
    });
    await page.mouse.up();

    // The knight landed on f3 and is gliding in from where it was released
    expect(await hasPiece(page, 'f3')).toBe(true);
    const landed = await pieceState(page, 'f3');
    expect(landed.transform).toBe('translate3d(500%, 500%, 0px)');
    expect(landed.animations).toBe(1);
    expect(landed.lifted).toBe(false);
    await expect.poll(async () => (await pieceState(page, 'f3')).animations).toBe(0);
    await expect(hover).toHaveAttribute('visibility', 'hidden');
  });

  test('with drop tolerance 0 the same drop is illegal and slides back', async ({ page }) => {
    await openPlay(page);
    await setFeel(page, { dropTolerance: 0, snapMs: 250 });
    const g1 = await squareBox(page, 'g1');
    const f3 = await squareBox(page, 'f3');
    await page.mouse.move(g1.cx, g1.cy);
    await page.mouse.down();
    await page.mouse.move(f3.cx, f3.y - f3.height * 0.15, { steps: 6 });
    await expect(page.getByTestId('overlay-hover-square')).toHaveAttribute('data-square', 'f4');
    await page.mouse.up();
    expect(await hasPiece(page, 'f3')).toBe(false);
    const back = await pieceState(page, 'g1');
    expect(back.transform).toBe('translate3d(600%, 700%, 0px)');
    expect(back.animations).toBe(1);
    await expect(page.getByTestId('overlay-selected-square')).toHaveCount(0);
  });

  test('touch: the dragged piece is drawn above the finger and drops on the square under it; a tap selects', async ({
    page,
  }) => {
    await openPlay(page);
    await setFeel(page, { touchOffset: 0.8 });
    const e2 = await squareBox(page, 'e2');
    const e3 = await squareBox(page, 'e3');

    const touch = async (type: string, x: number, y: number) => {
      await page.evaluate(
        ({ type, x, y }) => {
          const board = document.querySelector('[data-testid="play-layout"] [data-testid="chess-board"]')!;
          const target = type === 'pointerdown' ? board : document;
          target.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: 7,
              pointerType: 'touch',
              isPrimary: true,
              button: type === 'pointermove' ? -1 : 0,
              buttons: type === 'pointerup' ? 0 : 1,
              clientX: x,
              clientY: y,
            }),
          );
        },
        { type, x, y },
      );
    };

    // A tap selects without moving anything
    await touch('pointerdown', e2.cx, e2.cy);
    await touch('pointermove', e2.cx + 2, e2.cy + 2);
    await touch('pointerup', e2.cx + 2, e2.cy + 2);
    await expect(page.getByTestId('overlay-selected-square')).toHaveAttribute('data-square', 'e2');
    expect(await hasPiece(page, 'e2')).toBe(true);
    await expect(page.locator('html')).not.toHaveClass(/wc-grabbing/);

    // A drag: finger on e3, the pawn drawn 0.8 squares higher, over e4
    await touch('pointerdown', e2.cx, e2.cy);
    await touch('pointermove', e2.cx, e2.cy - e2.height * 0.5);
    await touch('pointermove', e3.cx, e3.cy);
    const held = await pieceState(page, 'e2');
    // e3's centre is 5.5 squares down; drawn at 4.7 → translate (4.7 − 0.5) × 100 = 420%
    const m = /^translate3d\(([\d.]+)%, ([\d.]+)%, 0px\) scale\(1\.12\)$/.exec(held.transform);
    expect(m, held.transform).not.toBeNull();
    expect(Number(m![1])).toBeCloseTo(400, 0);
    expect(Number(m![2])).toBeCloseTo(420, 0);
    await expect(page.getByTestId('overlay-hover-square')).toHaveAttribute('data-square', 'e4');
    await touch('pointerup', e3.cx, e3.cy);
    await expect.poll(() => hasPiece(page, 'e4')).toBe(true);
    expect(await hasPiece(page, 'e2')).toBe(false);
  });

  test('grab cursor over a piece that can be picked up, none elsewhere', async ({ page }) => {
    await openPlay(page);
    const board = page.getByTestId('play-layout').getByTestId('chess-board');
    const e2 = await squareBox(page, 'e2');
    const e4 = await squareBox(page, 'e4');
    const e7 = await squareBox(page, 'e7');
    await page.mouse.move(e2.cx, e2.cy);
    await expect(board).toHaveAttribute('data-cursor', 'grab');
    expect(await board.evaluate((el) => getComputedStyle(el).cursor)).toBe('grab');
    await page.mouse.move(e4.cx, e4.cy);
    await expect(board).not.toHaveAttribute('data-cursor', 'grab');
    // The bot's pieces can't be picked up
    await page.mouse.move(e7.cx, e7.cy);
    await expect(board).not.toHaveAttribute('data-cursor', 'grab');
  });

  test('the board resizes from its corner, and the size is remembered', async ({ page }) => {
    await openPlay(page);
    await page.evaluate(() => localStorage.removeItem('wc.boardSize.v1'));
    await page.reload();
    const frame = page.getByTestId('play-layout').getByTestId('chess-board-frame');
    const before = (await frame.boundingBox())!;
    expect(Math.round(before.width)).toBe(600);

    const handle = page.getByTestId('play-layout').getByTestId('board-resize-handle');
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + 60, hb.y + hb.height / 2 + 100, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await frame.boundingBox())!.width)).toBe(700);
    expect(await page.evaluate(() => localStorage.getItem('wc.boardSize.v1'))).toBe('700');

    // The squares grew with it, and the board still maps clicks correctly
    const e2 = await squareBox(page, 'e2');
    expect(Math.round(e2.width)).toBeGreaterThan(80);
    await page.mouse.click(e2.cx, e2.cy);
    await expect(page.getByTestId('overlay-selected-square')).toHaveAttribute('data-square', 'e2');

    await page.reload();
    await expect.poll(async () => Math.round((await frame.boundingBox())!.width)).toBe(700);
    // Analysis and Puzzles boards share the size
    await page.getByTestId('mode-tab-review').click();
    const analysisFrame = page.getByTestId('analysis-layout').getByTestId('chess-board-frame');
    expect(Math.round((await analysisFrame.boundingBox())!.width)).toBe(700);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-analysis-board-700.png') });

    // Keyboard, then double-click back to the default
    await page.getByTestId('analysis-layout').getByTestId('board-resize-handle').focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => Math.round((await analysisFrame.boundingBox())!.width)).toBe(684);
    await page.getByTestId('analysis-layout').getByTestId('board-resize-handle').dblclick();
    await expect.poll(async () => Math.round((await analysisFrame.boundingBox())!.width)).toBe(600);
    expect(await page.evaluate(() => localStorage.getItem('wc.boardSize.v1'))).toBeNull();
  });

  test('phone width: no resize grip, the board fills the column, no sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByTestId('play-layout')).toBeVisible();
    await expect(page.getByTestId('play-layout').getByTestId('board-resize-handle')).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('Phase 5 — board badges', () => {
  const CLASSES = [
    'Brilliant',
    'Great',
    'Best',
    'Excellent',
    'Good',
    'Book',
    'Inaccuracy',
    'Mistake',
    'Miss',
    'Blunder',
  ] as const;

  test('the current move’s class icon sits on its destination square’s corner, every class, both orientations', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByTestId('mode-tab-review').click();
    await expect(page.getByTestId('analysis-layout')).toBeVisible();

    // The sample game, with one class on each of its first ten moves (as a review writes them)
    const moves = await page.evaluate(
      (classes) => {
        const api = window.__wizardChessAnalysis!;
        const review = window.__wizardChessReview!;
        if (!api.controller.importPgn(review.SAMPLE_GAME_PGN)) throw new Error('import failed');
        const line = api.controller.getGameTree().getMainLine().slice(0, classes.length);
        api.controller.applyReview(
          line.map((node, i) => ({ nodeId: node.id, classification: classes[i]! })),
          true,
        );
        return line.map((node) => ({ id: node.id, to: node.to!, san: node.san }));
      },
      [...CLASSES],
    );

    const board = page.getByTestId('analysis-layout').getByTestId('chess-board');
    const badge = board.getByTestId('board-badge');

    // The start position has no move, so no badge
    await page.evaluate(() =>
      window.__wizardChessAnalysis!.controller.goToNode(window.__wizardChessAnalysis!.controller.getGameTree().root.id),
    );
    await expect(badge).toHaveCount(0);

    for (const flipped of [false, true]) {
      await page.evaluate((f) => {
        const c = window.__wizardChessAnalysis!.controller;
        if (c.getBoard().isFlipped() !== f) c.flipBoard();
      }, flipped);
      for (let i = 0; i < CLASSES.length; i++) {
        const move = moves[i]!;
        await page.evaluate((id) => window.__wizardChessAnalysis!.controller.goToNode(id), move.id);
        await expect(badge).toHaveAttribute('data-square', move.to);
        await expect(badge).toHaveAttribute('data-label', CLASSES[i]!);
        await expect(badge.locator('.wc-class-badge')).toHaveAttribute('data-class', CLASSES[i]!);

        // Inside the destination square, in its top-right corner, never clipped by the board
        await badge.locator('.wc-class-badge').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
        const sq = (await board.getByTestId(`square-${move.to}`).boundingBox())!;
        const icon = (await badge.locator('.wc-class-badge').boundingBox())!;
        const b = (await board.boundingBox())!;
        expect(icon.x).toBeGreaterThanOrEqual(sq.x + sq.width / 2 - 1);
        expect(icon.x + icon.width).toBeLessThanOrEqual(sq.x + sq.width + 1);
        expect(icon.y).toBeGreaterThanOrEqual(sq.y - 1);
        expect(icon.y + icon.height).toBeLessThanOrEqual(sq.y + sq.height / 2 + 1);
        expect(icon.x + icon.width).toBeLessThanOrEqual(b.x + b.width);
        expect(icon.width).toBeGreaterThan(sq.width * 0.3);
      }
      await board.screenshot({
        path: path.join(SCREENSHOT_DIR, `desktop-board-badge-${flipped ? 'black' : 'white'}.png`),
      });
    }

    // A move with no classification (past the first ten) shows none
    await page.evaluate(() => {
      const c = window.__wizardChessAnalysis!.controller;
      const node = c.getGameTree().getMainLine()[12]!;
      c.goToNode(node.id);
    });
    await expect(badge).toHaveCount(0);
  });

  test('a real review puts badges on the board as you step through it', async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByTestId('mode-tab-review').click();
    await page.getByTestId('select-review-preset').selectOption('quick');
    await page.getByTestId('btn-review-sample').click();
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
    await page.getByTestId('review-key-moments').locator('button').first().click();
    const node = await page.evaluate(() => {
      const n = window.__wizardChessAnalysis!.controller.getGameTree().currentNode;
      return { to: n.to, cls: n.classification };
    });
    const badge = page.getByTestId('analysis-layout').getByTestId('board-badge');
    await expect(badge).toHaveAttribute('data-square', node.to!);
    await expect(badge).toHaveAttribute('data-label', node.cls!);
    await page.keyboard.press('ArrowRight');
    const next = await page.evaluate(() => {
      const n = window.__wizardChessAnalysis!.controller.getGameTree().currentNode;
      return { to: n.to, cls: n.classification };
    });
    await expect(badge).toHaveAttribute('data-square', next.to!);
    await expect(badge).toHaveAttribute('data-label', next.cls!);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-review-badge.png') });
  });
});
