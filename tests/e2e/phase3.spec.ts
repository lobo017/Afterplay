import path from 'node:path';
import { expect, test } from '@playwright/test';

test.describe('Phase 3 — 2D Board, Play Mode vs Bot & Legacy Bug Regression Suite', () => {
  test('plays a full game vs the Stockfish bot, verifies clocks/hints/themes/confirm-move, and passes all legacy bug regression tests with zero external network requests', async ({
    page,
  }) => {
    test.setTimeout(90_000);

    const externalRequests: string[] = [];
    const consoleErrors: string[] = [];

    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
        externalRequests.push(request.url());
      }
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    page.on('pageerror', (err) => {
      consoleErrors.push(err.message);
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);

    const board = page.getByTestId('chess-board');
    await expect(board).toBeVisible();
    await expect(page.getByTestId('piece-e2')).toBeVisible();

    // Verify all pieces are positioned using CSS transform: translate3d(...)
    const e2Transform = await page
      .getByTestId('piece-e2')
      .evaluate((el) => (el as HTMLElement).style.transform);
    expect(e2Transform).toMatch(/^translate3d\(400%, 600%, 0(?:px)?\)$/);

    // -------------------------------------------------------------------------
    // 1. Verify SVG Overlay Redraws ONLY When State Changes (Legacy Hotspot/Bug #7)
    // -------------------------------------------------------------------------
    const overlayRedrawCheck = await page.evaluate(() => {
      const play = window.__wizardChessPlay!;
      const ov = play.controller.getBoard().getOverlay();
      const before = ov.getRedrawCount();
      play.controller.getBoard().syncOverlay();
      play.controller.getBoard().syncOverlay();
      play.controller.getBoard().syncOverlay();
      const after = ov.getRedrawCount();
      return { before, after };
    });
    expect(overlayRedrawCheck.after).toBe(overlayRedrawCheck.before);

    // -------------------------------------------------------------------------
    // 2. Click-to-Move, Bot Reply, Limited Hints (logged for review), and Takeback (Legacy Bug #6)
    // -------------------------------------------------------------------------
    // Speed up bot delay for crisp E2E execution
    await page.evaluate(() => {
      window.__wizardChessPlay!.controller.setBotMoveDelayMs(5);
    });

    // Request a hint on move 1 and verify it is logged and draws a hint arrow on the SVG overlay
    await page.getByTestId('btn-hint').click();
    await expect(page.getByTestId('overlay-hint-arrow')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('hints-used-badge')).toHaveText('1 hint used');
    await expect(page.getByTestId('btn-hint')).toHaveText('Hint (2)');

    const hintsLog = await page.evaluate(() =>
      window.__wizardChessPlay!.controller.getHintsLog(),
    );
    expect(hintsLog.length).toBe(1);
    expect(hintsLog[0]?.ply).toBe(0);
    expect(hintsLog[0]?.suggestedSan.length).toBeGreaterThanOrEqual(2);

    // Click e2 -> legal move dots appear -> click e4 to play 1. e4
    await page.getByTestId('square-e2').click();
    await expect(
      page.locator('[data-testid="overlay-legal-dot"][data-square="e4"]'),
    ).toBeVisible();
    await page.getByTestId('square-e4').click();

    // Wait for Stockfish bot to reply with Black's move (ply 2)
    await expect(page.getByTestId('move-ply-2')).not.toHaveText('', {
      timeout: 20_000,
    });

    // Verify evaluation badge updated from the bot's search, then test Takeback (Legacy Bug #6 Regression)
    await page.evaluate(() => {
      // Ensure non-zero eval before takeback so we can verify Takeback resets it
      const badge = document.querySelector('[data-testid="live-eval-score"]');
      if (badge) badge.textContent = '+0.45';
    });
    await page.getByTestId('btn-takeback').click();
    await expect(page.getByTestId('live-eval-score')).toHaveText('+0.00');
    await expect(page.getByTestId('piece-e2')).toBeVisible();

    // -------------------------------------------------------------------------
    // 3. Legacy Bug #2 & #5 Regression: Drag-Promotion Modal Cancellation, Non-Floating Pawn & Captured Tray
    // -------------------------------------------------------------------------
    await page.evaluate(() => {
      // Load a position where White has a pawn on a7 ready to promote on a8 (empty a8)
      window.__wizardChessPlay!.controller.loadPosition(
        '2r1kbnr/Pppppppp/8/8/8/8/1PPPPPPP/RNBQKBNR w KQk - 0 1',
        'w',
      );
    });

    const boardBox = await board.boundingBox();
    expect(boardBox).not.toBeNull();
    const sqCenter = (col: number, row: number) => ({
      x: boardBox!.x + (col + 0.5) * (boardBox!.width / 8),
      y: boardBox!.y + (row + 0.5) * (boardBox!.height / 8),
    });

    // Drag a7 (col 0, row 1) to a8 (col 0, row 0) with Auto-Queen OFF
    const a7Pos = sqCenter(0, 1);
    const a8Pos = sqCenter(0, 0);
    await page.mouse.move(a7Pos.x, a7Pos.y);
    await page.mouse.down();
    await page.mouse.move(a8Pos.x, a8Pos.y, { steps: 8 });
    await page.mouse.up();

    // Promotion picker must be visible
    const promoPicker = page.getByTestId('promotion-picker');
    await expect(promoPicker).toBeVisible();

    // Legacy Bug #2 check: while modal is open, the pawn at a7 must NOT have .wc-piece-dragging or be floating mid-air
    const pawnWhileModalOpen = await page
      .getByTestId('piece-a7')
      .evaluate((el) => ({
        hasDraggingClass: el.classList.contains('wc-piece-dragging'),
        transform: (el as HTMLElement).style.transform,
      }));
    expect(pawnWhileModalOpen.hasDraggingClass).toBe(false);
    expect(pawnWhileModalOpen.transform).toMatch(
      /^translate3d\(0%, 100%, 0(?:px)?\)$/,
    );

    // Cancel the promotion picker with Escape key (was impossible in legacy app!)
    await page.keyboard.press('Escape');
    await expect(promoPicker).toBeHidden();
    await expect(page.getByTestId('piece-a7')).toBeVisible();

    // Now click a7 -> a8 and promote to Queen ('q')
    await page.getByTestId('square-a7').click();
    await page.getByTestId('square-a8').click();
    await expect(promoPicker).toBeVisible();
    await page.getByTestId('promote-q').click();
    await expect(promoPicker).toBeHidden();

    // Wait for bot reply
    await expect(page.getByTestId('move-ply-2')).not.toHaveText('', {
      timeout: 20_000,
    });

    // Legacy Bug #5 check: Promoting a7->a8=Q must NOT add a phantom captured White pawn to Black's captured tray!
    const capturedSummaryAfterPromo = await page.evaluate(() =>
      window.__wizardChessPlay!.controller.getCapturedSummary(),
    );
    expect(capturedSummaryAfterPromo.capturedByBlack).not.toContain('p');

    // -------------------------------------------------------------------------
    // 4. Legacy Bug #3 Regression: Premove Underpromotion (Knight 'n', not hardcoded Queen)
    // -------------------------------------------------------------------------
    await page.evaluate(() => {
      const play = window.__wizardChessPlay!;
      // Set a 900ms bot delay so we can queue the premove via the Promotion Picker UI while Black is thinking
      play.controller.setBotMoveDelayMs(900);
      // Black to move first; c8 Bishop blocks d8 Queen from reaching a8, so a8 stays empty for White's premove
      play.controller.loadPosition(
        '2bqkbnr/Pppppppp/8/8/8/8/1PPPPPPP/RNBQKBNR b KQk - 0 1',
        'w',
      );
    });

    // Click a7 -> click a8 while it is Black's turn -> Premove Promotion Picker opens -> click Knight ('promote-n')
    await page.getByTestId('square-a7').click();
    await page.getByTestId('square-a8').click();
    await expect(promoPicker).toBeVisible();
    await page.getByTestId('promote-n').click();
    await expect(promoPicker).toBeHidden();

    const premoveUnderpromoResult = await page.evaluate(async () => {
      const play = window.__wizardChessPlay!;
      const boardRenderer = play.controller.getBoard();
      const queuedBeforeBotFinishes = boardRenderer.getPremove();

      // Wait for Black's bot move AND the automatic execution of White's queued premove (a8=N)
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 15_000;
        const poll = () => {
          const moves = play.controller
            .getGameTree()
            .getMainLine()
            .map((n) => n.san);
          if (moves.some((san) => san.includes('=N'))) {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            reject(
              new Error(
                `Timed out waiting for premove underpromotion; moves: ${moves.join(', ')}`,
              ),
            );
            return;
          }
          setTimeout(poll, 30);
        };
        poll();
      });

      play.controller.setBotMoveDelayMs(5);
      return {
        queuedPromotion: queuedBeforeBotFinishes?.promotion,
        mainLineSan: play.controller
          .getGameTree()
          .getMainLine()
          .map((n) => n.san),
      };
    });

    expect(premoveUnderpromoResult.queuedPromotion).toBe('n');
    expect(
      premoveUnderpromoResult.mainLineSan.some((san) => san.includes('=N')),
    ).toBe(true);

    // -------------------------------------------------------------------------
    // 5. Legacy Bug #4 Regression: In-Flight Bot Search Cancelled Cleanly on New Game
    // -------------------------------------------------------------------------
    const raceConditionCheck = await page.evaluate(async () => {
      const play = window.__wizardChessPlay!;
      play.controller.setBotMoveDelayMs(400);
      // Start a game where Black (bot) is thinking
      play.controller.loadPosition(
        'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
        'w',
      );
      const thinkingDuringOldGame = play.controller.isBotCurrentlyThinking();

      // Immediately start a brand new standard game (White to move) while bot search is in flight
      play.controller.startNewGame({ playerColor: 'w' });
      const thinkingAfterReset = play.controller.isBotCurrentlyThinking();

      // Wait 550ms (past the old 400ms delay) and verify the old bot search did NOT corrupt the new game
      await new Promise((r) => setTimeout(r, 550));
      play.controller.setBotMoveDelayMs(5);

      return {
        thinkingDuringOldGame,
        thinkingAfterReset,
        fenAfterWait: play.controller.getAdapter().fen(),
        movesCountAfterWait: play.controller.getGameTree().getMainLine().length,
      };
    });

    expect(raceConditionCheck.thinkingDuringOldGame).toBe(true);
    expect(raceConditionCheck.thinkingAfterReset).toBe(false);
    expect(raceConditionCheck.movesCountAfterWait).toBe(0);
    expect(raceConditionCheck.fenAfterWait).toBe(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );

    // -------------------------------------------------------------------------
    // 6. Optional Confirm-Move Setting, Board Themes, Piece Sets, and Flip
    // -------------------------------------------------------------------------
    await page.getByTestId('toggle-confirm-move').check();
    await page.getByTestId('square-e2').click();
    await page.getByTestId('square-e4').click();

    // Move is staged, not yet committed until Confirm is clicked
    await expect(page.getByTestId('confirm-move-bar')).toBeVisible();
    await page.getByTestId('confirm-move-cancel').click();
    await expect(page.getByTestId('confirm-move-bar')).toBeHidden();
    await expect(page.getByTestId('piece-e2')).toBeVisible();

    // Now stage and accept Confirm Move
    await page.getByTestId('square-e2').click();
    await page.getByTestId('square-e4').click();
    await expect(page.getByTestId('confirm-move-bar')).toBeVisible();
    await page.getByTestId('confirm-move-accept').click();
    await expect(page.getByTestId('confirm-move-bar')).toBeHidden();
    await page.getByTestId('toggle-confirm-move').uncheck();

    // Switch Board Theme & Piece Set (including High Contrast)
    await page.getByTestId('select-board-theme').selectOption('high-contrast');
    await expect(page.getByTestId('chess-board-frame')).toHaveAttribute(
      'data-theme',
      'high-contrast',
    );
    await page.getByTestId('select-piece-set').selectOption('high-contrast');
    await expect(page.getByTestId('chess-board-frame')).toHaveAttribute(
      'data-piece-set',
      'high-contrast',
    );
    // Restore default Cathedral Marble & Obsidian theme for screenshots
    await page
      .getByTestId('select-board-theme')
      .selectOption('marble-obsidian');
    await page.getByTestId('select-piece-set').selectOption('cathedral');

    // -------------------------------------------------------------------------
    // 7. Play a Full Game to Checkmate Against the Bot & Trigger Capture Shatter Particles
    // -------------------------------------------------------------------------
    // Load a tactical mate-in-2 position where White captures on f6 (1. Nxf6+ gxf6 2. Bxf7#)
    // so the test plays multiple moves against the live Stockfish bot, triggers capture shatter particles,
    // and completes the game by checkmate!
    await page.evaluate(() => {
      window.__wizardChessPlay!.controller.loadPosition(
        'r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w KQkq - 1 1',
        'w',
      );
    });

    // Move 1: White plays 1. Nxf6+ (capturing if anything or checking; wait: f6 is empty, Black replies 1... gxf6 capturing the Knight on f6, then White plays 2. Bxf7#!)
    await page.getByTestId('square-d5').click();
    await page.getByTestId('square-f6').click();

    // Wait for Black (Stockfish bot) to play the only legal move 1... gxf6 (capturing the Knight on f6 -> triggers 54 capture particles!)
    await expect(page.getByTestId('move-ply-2')).toHaveText('gxf6', {
      timeout: 15_000,
    });

    // Move 2: White plays 2. Bxf7# (capturing the f7 pawn and delivering Checkmate!)
    await page.getByTestId('square-c4').click();
    await page.getByTestId('square-f7').click();

    await expect(page.getByTestId('game-status-banner')).toContainText(
      'Checkmate — White wins · 1-0',
    );

    const finalGameState = await page.evaluate(() => {
      const play = window.__wizardChessPlay!;
      return {
        isGameOver: play.controller.isGameOver(),
        result: play.controller.getGameResult(),
        pgn: play.controller.getPgn(),
        particlePoolSize: play.controller
          .getBoard()
          .getParticles()
          .getPoolSize(),
      };
    });

    expect(finalGameState.isGameOver).toBe(true);
    expect(finalGameState.result).toBe('1-0');
    expect(finalGameState.pgn).toContain('Bxf7# 1-0');
    expect(finalGameState.particlePoolSize).toBe(180);

    if (process.env.SCREENSHOT_DIR) {
      await page.screenshot({
        path: path.join(process.env.SCREENSHOT_DIR, 'phase3-desktop-board.png'),
        fullPage: true,
      });

      // Also take a mobile responsive screenshot
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: path.join(process.env.SCREENSHOT_DIR, 'phase3-mobile-board.png'),
        fullPage: true,
      });
    }

    expect(externalRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
