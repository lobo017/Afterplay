import { expect, test, type Page } from '@playwright/test';

/** Loads `fen` with the player on `color` and a fixed bot think time. */
async function setupGame(page: Page, fen: string, color: 'w' | 'b', botDelayMs: number): Promise<void> {
  await page.evaluate(
    ({ fen, color, botDelayMs }) => {
      const c = window.__wizardChessPlay!.controller;
      c.setBotDelayRangeMs(botDelayMs, botDelayMs);
      c.loadPosition(fen, color);
    },
    { fen, color, botDelayMs },
  );
}

async function squareCenter(page: Page, sq: string) {
  const box = await page.getByTestId(`square-${sq}`).boundingBox();
  if (!box) throw new Error(`square-${sq} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function clickSquare(page: Page, sq: string) {
  const c = await squareCenter(page, sq);
  await page.mouse.click(c.x, c.y);
}

async function mainLine(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    window
      .__wizardChessPlay!.controller.getGameTree()
      .getMainLine()
      .map((n) => n.san),
  );
}

async function waitForPly(page: Page, ply: number, timeout = 15_000) {
  await page.waitForFunction((n) => window.__wizardChessPlay!.controller.getGameTree().getMainLine().length >= n, ply, {
    timeout,
  });
}

/** Board piece elements vs. the real position: catches ghost or duplicate elements. */
async function boardMatchesPosition(page: Page) {
  return page.evaluate(() => {
    const controller = window.__wizardChessPlay!.controller;
    const placement = controller.getAdapter().fen().split(' ')[0] ?? '';
    const files = 'abcdefgh';
    const expected: string[] = [];
    placement.split('/').forEach((row, r) => {
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) {
          f += Number(ch);
        } else {
          expected.push(`${files[f]}${8 - r}:${ch === ch.toUpperCase() ? 'w' : 'b'}${ch.toLowerCase()}`);
          f++;
        }
      }
    });
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="board-pieces-layer"] .wc-piece'));
    const actual = els.map(
      (el) => `${el.getAttribute('data-square')}:${el.getAttribute('data-color')}${el.getAttribute('data-piece')}`,
    );
    return {
      expected: expected.sort(),
      actual: actual.sort(),
      dragging: document.querySelectorAll('.wc-piece-dragging').length,
    };
  });
}

test.describe('Phase 3 — Drag survival, drag cancel & premove queue', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByTestId('chess-board')).toBeVisible();
  });

  test('a drag held through an opponent move continues and plays the move on drop', async ({ page }) => {
    test.setTimeout(60_000);
    await setupGame(page, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'w', 1200);
    await clickSquare(page, 'e2');
    await clickSquare(page, 'e4');
    await expect(page.getByTestId('move-ply-1')).toHaveText('e4');

    // Pick up the d-pawn while the bot is thinking and keep holding it
    const d2 = await squareCenter(page, 'd2');
    const d3 = await squareCenter(page, 'd3');
    await page.mouse.move(d2.x, d2.y);
    await page.mouse.down();
    await page.mouse.move(d3.x, d3.y, { steps: 5 });
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.getBoard().isDragInProgress())).toBe(true);

    // The bot's reply arrives while the pawn is still in the air
    await waitForPly(page, 2);
    const held = await page.evaluate(() => {
      const board = window.__wizardChessPlay!.controller.getBoard();
      const el = document.querySelector('[data-testid="piece-d2"]');
      return {
        dragging: board.isDragInProgress(),
        hasDragClass: el?.classList.contains('wc-piece-dragging') ?? false,
        premoves: board.getPremoves().length,
      };
    });
    expect(held).toEqual({ dragging: true, hasDragClass: true, premoves: 0 });

    // The held piece still follows the pointer after the board update
    const d4 = await squareCenter(page, 'd4');
    await page.mouse.move(d4.x, d4.y, { steps: 4 });
    const followTransform = await page.getByTestId('piece-d2').evaluate((el) => (el as HTMLElement).style.transform);
    // Lifted at the board feel's lift scale (tunable since Phase 6b)
    const liftScale = await page.evaluate(() => window.__wizardChessPlay!.boardFeel.get().liftScale);
    expect(liftScale).toBeGreaterThan(1);
    expect(followTransform).toContain(`scale(${liftScale})`);

    // Dropping it now (our turn) plays a normal move
    await page.mouse.up();
    await expect(page.getByTestId('move-ply-3')).toHaveText('d4');
    const after = await boardMatchesPosition(page);
    expect(after.actual).toEqual(after.expected);
    expect(after.dragging).toBe(0);
  });

  test('a held piece that gets captured ends the drag cleanly with no ghost', async ({ page }) => {
    test.setTimeout(60_000);
    // Black's only legal move is Kxb8, capturing the rook we will be holding
    await setupGame(page, 'kR6/8/1K6/8/8/8/7P/8 b - - 0 1', 'w', 1200);

    const b8 = await squareCenter(page, 'b8');
    const c7 = await squareCenter(page, 'c7');
    await page.mouse.move(b8.x, b8.y);
    await page.mouse.down();
    await page.mouse.move(c7.x, c7.y, { steps: 5 });

    await waitForPly(page, 1);
    expect(await mainLine(page)).toEqual(['Kxb8']);

    const state = await page.evaluate(() => {
      const board = window.__wizardChessPlay!.controller.getBoard();
      return {
        dragging: board.isDragInProgress(),
        whiteRooks: document.querySelectorAll('.wc-piece[data-color="w"][data-piece="r"]').length,
      };
    });
    expect(state).toEqual({ dragging: false, whiteRooks: 0 });

    // Moving and releasing the mouse afterwards does nothing
    const c5 = await squareCenter(page, 'c5');
    await page.mouse.move(c5.x, c5.y, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await mainLine(page)).toEqual(['Kxb8']);
    const board = await boardMatchesPosition(page);
    expect(board.actual).toEqual(board.expected);
    expect(board.dragging).toBe(0);
  });

  test('right-click, Escape and an off-board drop cancel a drag; clicking the selected piece deselects it', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await setupGame(page, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'w', 1200);
    const homeTransform = (sq: string) =>
      page.getByTestId(`piece-${sq}`).evaluate((el) => (el as HTMLElement).style.transform);
    const e2Home = await homeTransform('e2');

    // 1. Right-click while dragging. Inspect the piece inside the same mousedown dispatch
    // (bubble phase, after the board's capture listener) to see the snap-back animation.
    await page.evaluate(() => {
      const w = window as unknown as { __rightClickState?: unknown };
      window.addEventListener('mousedown', (e) => {
        if (e.button !== 2) return;
        const el = document.querySelector<HTMLElement>('[data-testid="piece-e2"]')!;
        w.__rightClickState = {
          dragging: window.__wizardChessPlay!.controller.getBoard().isDragInProgress(),
          snapAnimations: el.getAnimations().length,
          transform: el.style.transform,
        };
      });
    });
    const e2 = await squareCenter(page, 'e2');
    const e4 = await squareCenter(page, 'e4');
    await page.mouse.move(e2.x, e2.y);
    await page.mouse.down();
    await page.mouse.move(e4.x, e4.y, { steps: 6 });
    await page.mouse.down({ button: 'right' });
    const afterRight = await page.evaluate(
      () => (window as unknown as { __rightClickState?: unknown }).__rightClickState,
    );
    expect(afterRight).toEqual({
      dragging: false,
      snapAnimations: 1, // short snap-back animation
      transform: e2Home,
    });
    await page.mouse.up({ button: 'right' });
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await mainLine(page)).toEqual([]);
    await expect(page.getByTestId('overlay-user-arrow')).toHaveCount(0);
    await expect(page.getByTestId('overlay-user-circle')).toHaveCount(0);
    expect(await homeTransform('e2')).toBe(e2Home);

    // 2. Escape while dragging
    const g1 = await squareCenter(page, 'g1');
    const f3 = await squareCenter(page, 'f3');
    const g1Home = await homeTransform('g1');
    await page.mouse.move(g1.x, g1.y);
    await page.mouse.down();
    await page.mouse.move(f3.x, f3.y, { steps: 6 });
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.getBoard().isDragInProgress())).toBe(false);
    await page.mouse.up(); // released over f3: must not play Nf3
    await page.waitForTimeout(200);
    expect(await mainLine(page)).toEqual([]);
    expect(await homeTransform('g1')).toBe(g1Home);

    // 3. Dropping off the board
    const boardBox = (await page.getByTestId('chess-board').boundingBox())!;
    const b1 = await squareCenter(page, 'b1');
    const b1Home = await homeTransform('b1');
    await page.mouse.move(b1.x, b1.y);
    await page.mouse.down();
    await page.mouse.move(boardBox.x + boardBox.width + 120, b1.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await mainLine(page)).toEqual([]);
    expect(await homeTransform('b1')).toBe(b1Home);
    await expect(page.getByTestId('overlay-selected-square')).toHaveCount(0);

    // 4. Clicking the selected piece again deselects it
    await clickSquare(page, 'd2');
    await expect(page.getByTestId('overlay-selected-square')).toHaveAttribute('data-square', 'd2');
    await clickSquare(page, 'd2');
    await expect(page.getByTestId('overlay-selected-square')).toHaveCount(0);
    await expect(page.getByTestId('overlay-legal-dot')).toHaveCount(0);

    const board = await boardMatchesPosition(page);
    expect(board.actual).toEqual(board.expected);
  });

  test('three queued premoves all execute across three bot moves, each in the bot move’s frame', async ({ page }) => {
    test.setTimeout(60_000);
    // Black has only a king and two pawns, so it can never check or block our knights
    // The New game card's time chips (applied when the game below starts)
    await page.getByTestId('time-control-5+3').click();
    await setupGame(page, '7k/6pp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQ - 0 1', 'w', 700);
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.getMaxPremoves())).toBe(10);

    // Sample the ply count and White's clock on every frame
    await page.evaluate(() => {
      const w = window as unknown as {
        __plySamples: Array<{ ply: number; whiteMs: number }>;
        __stopSampling: boolean;
      };
      w.__plySamples = [];
      w.__stopSampling = false;
      const controller = window.__wizardChessPlay!.controller;
      const tick = () => {
        if (w.__stopSampling) return;
        w.__plySamples.push({
          ply: controller.getGameTree().getMainLine().length,
          whiteMs: controller.getClock().getSnapshot().whiteMs,
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await clickSquare(page, 'e2');
    await clickSquare(page, 'e4');
    await expect(page.getByTestId('move-ply-1')).toHaveText('e4');

    // Premove 1 by click: Ng1-f3
    await clickSquare(page, 'g1');
    await clickSquare(page, 'f3');
    // Premove 2 by drag, planned on the hypothetical board: the knight now shows on f3
    const f3 = await squareCenter(page, 'f3');
    const g5 = await squareCenter(page, 'g5');
    await page.mouse.move(f3.x, f3.y);
    await page.mouse.down();
    await page.mouse.move(g5.x, g5.y, { steps: 6 });
    await page.mouse.up();
    // Premove 3 by click: Nb1-c3
    await clickSquare(page, 'b1');
    await clickSquare(page, 'c3');

    const queued = await page.evaluate(() => {
      const board = window.__wizardChessPlay!.controller.getBoard();
      return {
        thinking: window.__wizardChessPlay!.controller.isBotCurrentlyThinking(),
        premoves: board.getPremoves().map((p) => `${p.from}${p.to}`),
        orderLabels: Array.from(document.querySelectorAll('[data-testid="overlay-premove-order"]')).map(
          (el) => `${el.getAttribute('data-square')}:${el.textContent}`,
        ),
      };
    });
    expect(queued.thinking).toBe(true);
    expect(queued.premoves).toEqual(['g1f3', 'f3g5', 'b1c3']);
    expect(queued.orderLabels.sort()).toEqual(['c3:3', 'f3:1', 'g5:2']);

    await waitForPly(page, 7, 20_000);
    const result = await page.evaluate(() => {
      const w = window as unknown as {
        __plySamples: Array<{ ply: number; whiteMs: number }>;
        __stopSampling: boolean;
      };
      w.__stopSampling = true;
      return {
        samples: w.__plySamples,
        premovesLeft: window.__wizardChessPlay!.controller.getBoard().getPremoves().length,
      };
    });

    const line = await mainLine(page);
    expect(line).toHaveLength(7);
    expect(line[2]).toBe('Nf3');
    expect(line[4]).toMatch(/^Nx?g5$/);
    expect(line[6]).toBe('Nc3');
    expect(result.premovesLeft).toBe(0);

    // The bot's move and our premove land in the same frame: no frame ever shows the
    // position after the bot's move with our premove still pending (plies 2, 4, 6).
    const seenPlies = new Set(result.samples.map((s) => s.ply));
    expect([1, 3, 5, 7].every((p) => seenPlies.has(p))).toBe(true);
    expect([2, 4, 6].filter((p) => seenPlies.has(p))).toEqual([]);

    // Clock: each premove costs ~0 ms and earns the 3 s increment.
    const whiteAt = (ply: number) => result.samples.find((s) => s.ply === ply)!.whiteMs;
    for (const ply of [3, 5, 7]) {
      const delta = whiteAt(ply) - whiteAt(ply - 2);
      expect(delta).toBeGreaterThan(3000 - 60);
      expect(delta).toBeLessThanOrEqual(3000);
    }
  });

  test('an illegal premove cancels itself and every premove queued after it, with a flash', async ({ page }) => {
    test.setTimeout(60_000);
    // Black's only legal move is ...c3, which blocks our premoved Rc1-c4.
    await setupGame(page, 'k7/8/1Q6/8/2p5/8/8/2R4K b - - 0 1', 'w', 1200);

    await clickSquare(page, 'c1');
    await clickSquare(page, 'c4');
    await clickSquare(page, 'b6');
    await clickSquare(page, 'b5');
    await clickSquare(page, 'h1');
    await clickSquare(page, 'g1');
    expect(
      await page.evaluate(() =>
        window
          .__wizardChessPlay!.controller.getBoard()
          .getPremoves()
          .map((p) => `${p.from}${p.to}`),
      ),
    ).toEqual(['c1c4', 'b6b5', 'h1g1']);

    // Catch the board in the first frame after the bot's move
    const afterBot = await page.evaluate(
      () =>
        new Promise<{ ply: number; premoves: number; flash: string[]; overlayFlash: number }>((resolve) => {
          const controller = window.__wizardChessPlay!.controller;
          const tick = () => {
            if (controller.getGameTree().getMainLine().length >= 1) {
              resolve({
                ply: controller.getGameTree().getMainLine().length,
                premoves: controller.getBoard().getPremoves().length,
                flash: controller.getBoard().getPremoveFlashSquares().sort(),
                overlayFlash: document.querySelectorAll('[data-testid="overlay-premove-flash"]').length,
              });
              return;
            }
            requestAnimationFrame(tick);
          };
          tick();
        }),
    );
    expect(afterBot.ply).toBe(1);
    expect(afterBot.premoves).toBe(0);
    expect(afterBot.flash).toEqual(['b5', 'b6', 'c1', 'c4', 'g1', 'h1']);
    expect(afterBot.overlayFlash).toBe(6);

    // None of the cancelled premoves is played; it is simply our turn
    await page.waitForTimeout(600);
    expect(await mainLine(page)).toEqual(['c3']);
    await expect(page.getByTestId('overlay-premove-flash')).toHaveCount(0);
    const board = await boardMatchesPosition(page);
    expect(board.actual).toEqual(board.expected);
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.getAdapter().turn())).toBe('w');
  });

  test('right-click clears the premove queue; right-click still draws circles otherwise; max premoves applies', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await setupGame(page, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'w', 8000);
    await clickSquare(page, 'e2');
    await clickSquare(page, 'e4');
    await expect(page.getByTestId('move-ply-1')).toHaveText('e4');

    await clickSquare(page, 'd2');
    await clickSquare(page, 'd4');
    await clickSquare(page, 'g1');
    await clickSquare(page, 'f3');
    await expect(page.getByTestId('overlay-premove-order')).toHaveCount(2);

    // Right-click anywhere on the board: the queue is cleared and no circle is drawn
    const h5 = await squareCenter(page, 'h5');
    await page.mouse.click(h5.x, h5.y, { button: 'right' });
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.getBoard().getPremoves().length)).toBe(0);
    await expect(page.getByTestId('overlay-premove-order')).toHaveCount(0);
    await expect(page.getByTestId('overlay-user-circle')).toHaveCount(0);
    let board = await boardMatchesPosition(page);
    expect(board.actual).toEqual(board.expected);

    // With nothing queued, right-click draws a circle as before
    await page.mouse.click(h5.x, h5.y, { button: 'right' });
    await expect(page.getByTestId('overlay-user-circle')).toHaveCount(1);

    // Max premoves = 1 (Lichess style): a second premove is refused. Set in Settings › Moves.
    await page.getByTestId('btn-settings').click();
    await page.getByTestId('input-max-premoves').fill('1');
    await page.getByTestId('input-max-premoves').dispatchEvent('change');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-sheet')).toBeHidden();
    await clickSquare(page, 'd2');
    await clickSquare(page, 'd4');
    await clickSquare(page, 'g1');
    await clickSquare(page, 'f3');
    expect(
      await page.evaluate(() =>
        window
          .__wizardChessPlay!.controller.getBoard()
          .getPremoves()
          .map((p) => `${p.from}${p.to}`),
      ),
    ).toEqual(['d2d4']);

    // Escape also clears the queue
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__wizardChessPlay!.controller.getBoard().getPremoves().length)).toBe(0);
    board = await boardMatchesPosition(page);
    expect(board.actual).toEqual(board.expected);
  });
});
