import path from 'node:path';
import { expect, test } from '@playwright/test';

const ARTIFACT_DIR = path.join('test-results', 'screenshots');

test.describe('Phase 4 — Analysis Board, Eval Bar, MultiPV Ghost Previews, Threat Arrows, Variations, Editor & PGN', () => {
  test('renders live MultiPV 1-5 analysis, eval bar, best/threat/user arrows, ghost previews in both board orientations, keyboard variation navigation, FEN editor validation, and PGN export with zero external network requests', async ({
    page,
  }) => {
    test.setTimeout(120_000);

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

    await page.setViewportSize({ width: 1440, height: 920 });
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);

    // Switch from Play Mode to Analysis Mode via the top mode tab
    await page.getByTestId('mode-tab-analysis').click();
    await expect(page.getByTestId('analysis-layout')).toBeVisible();
    await expect(page.getByTestId('eval-bar')).toBeVisible();
    await expect(page.getByTestId('engine-lines-panel')).toBeVisible();

    // -------------------------------------------------------------------------
    // 1. Opening Lookup (data/openings.json) & Interactive Move Entry
    // -------------------------------------------------------------------------
    // Play 1. e4 e5 2. Nf3 Nc6 3. Bc4 (Italian Game, C50)
    const playSquareMove = async (from: string, to: string) => {
      await page.getByTestId(`square-${from}`).click();
      await page.getByTestId(`square-${to}`).click();
    };

    await playSquareMove('e2', 'e4');
    await playSquareMove('e7', 'e5');
    await playSquareMove('g1', 'f3');
    await playSquareMove('b8', 'c6');
    await playSquareMove('f1', 'c4');

    await expect(page.getByTestId('opening-eco')).toHaveText('C50');
    await expect(page.getByTestId('opening-name')).toContainText(
      'Italian Game',
    );

    // -------------------------------------------------------------------------
    // 2. Live Engine Lines Panel (1–5 lines)
    // -------------------------------------------------------------------------
    // Wait for initial 3 lines to populate
    await expect(page.getByTestId('engine-line-row-1')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('engine-line-row-2')).toBeVisible();
    await expect(page.getByTestId('engine-line-row-3')).toBeVisible();

    // Switch MultiPV to 5 lines and verify 5 lines render live
    await page.getByTestId('select-multipv').selectOption('5');
    await expect(page.getByTestId('engine-line-row-4')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('engine-line-row-5')).toBeVisible({
      timeout: 20_000,
    });

    // Switch back to 3 lines for clean display
    await page.getByTestId('select-multipv').selectOption('3');
    await expect(page.getByTestId('engine-line-row-3')).toBeVisible({
      timeout: 15_000,
    });

    // -------------------------------------------------------------------------
    // 3. Best-Move Arrow, Null-Move Threat Arrow, User Arrows/Circles & Ghost Preview
    //    Verified + Screenshotted in BOTH Unflipped and Flipped Orientations
    // -------------------------------------------------------------------------
    // Load Scholar's Mate threat position:
    // After 1.e4 e5 2.Bc4 Nc6 3.Qf3, Black is to move (+ advantage for White),
    // and if Black passes their turn (null-move), White threatens Qxf7# (f3 -> f7).
    const scholarsThreatFen =
      'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR b KQkq - 3 3';
    await page.evaluate((fen) => {
      window.__wizardChessAnalysis!.controller.loadFen(fen);
    }, scholarsThreatFen);

    // Wait for both Best-Move Arrow and Null-Move Threat Arrow (f3 -> f7) to appear
    const bestArrow = page.getByTestId('overlay-best-move-arrow');
    const threatArrow = page.getByTestId('overlay-threat-arrow');
    await expect(bestArrow).toBeVisible({ timeout: 20_000 });
    await expect(threatArrow).toBeVisible({ timeout: 20_000 });
    await expect(threatArrow).toHaveAttribute('data-from', 'f3');
    await expect(threatArrow).toHaveAttribute('data-to', 'f7');
    await expect(page.getByTestId('threat-move-badge')).toHaveText(
      'Threat: Qxf7#',
    );

    // Draw user annotations with modifier colors:
    // - Right-click f7 (Green circle 'G')
    // - Shift + Right-click c4 (Red circle 'R')
    // - Alt + Right-drag c6 -> d4 (Blue arrow 'B')
    await page.getByTestId('square-f7').click({ button: 'right' });
    await page
      .getByTestId('square-c4')
      .click({ button: 'right', modifiers: ['Shift'] });

    const c6Box = await page.getByTestId('square-c6').boundingBox();
    const d4Box = await page.getByTestId('square-d4').boundingBox();
    expect(c6Box).not.toBeNull();
    expect(d4Box).not.toBeNull();
    if (c6Box && d4Box) {
      await page.keyboard.down('Alt');
      await page.mouse.move(
        c6Box.x + c6Box.width / 2,
        c6Box.y + c6Box.height / 2,
      );
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(
        d4Box.x + d4Box.width / 2,
        d4Box.y + d4Box.height / 2,
        { steps: 5 },
      );
      await page.mouse.up({ button: 'right' });
      await page.keyboard.up('Alt');
    }

    await expect(page.getByTestId('overlay-user-circle')).toHaveCount(2);
    await expect(page.getByTestId('overlay-user-arrow')).toHaveCount(1);
    await expect(page.getByTestId('overlay-user-arrow')).toHaveAttribute(
      'data-color',
      '#38bdf8',
    );

    // Hover the 3rd ply of Engine Line 1 to trigger faded ghost pieces & ghost arrows on the board
    await expect(page.getByTestId('engine-pv-move-1-2')).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId('engine-pv-move-1-2').hover();

    const ghostPieces = page.locator('.wc-ghost-piece');
    await expect(ghostPieces.first()).toBeVisible();
    await expect(
      page.getByTestId('overlay-ghost-arrow').first(),
    ).toBeVisible();

    // Verify Unflipped EvalBar & Arrow Geometry
    const unflippedState = await page.evaluate(() => {
      const evalBar = document.querySelector(
        '[data-testid="eval-bar"]',
      ) as HTMLElement;
      const whiteFill = document.querySelector(
        '[data-testid="eval-bar-white-fill"]',
      ) as HTMLElement;
      const scoreEl = document.querySelector(
        '[data-testid="eval-bar-score"]',
      ) as HTMLElement;
      const threatEl = document.querySelector(
        '[data-testid="overlay-threat-arrow"]',
      ) as HTMLElement;
      const userArrowEl = document.querySelector(
        '[data-testid="overlay-user-arrow"]',
      ) as HTMLElement;
      const ghostEl = document.querySelector(
        '.wc-ghost-piece',
      ) as HTMLElement;
      return {
        boardFlipped: document
          .querySelector('[data-testid="chess-board"]')
          ?.getAttribute('data-flipped'),
        evalFlipped: evalBar.getAttribute('data-flipped'),
        whiteFillBottom: whiteFill.style.bottom,
        whiteFillTop: whiteFill.style.top,
        whiteFillHeight: whiteFill.style.height,
        scorePosition: scoreEl.getAttribute('data-position'),
        threatStartCx: Number(threatEl.getAttribute('data-start-cx')),
        threatStartCy: Number(threatEl.getAttribute('data-start-cy')),
        userArrowStartCx: Number(userArrowEl.getAttribute('data-start-cx')),
        userArrowStartCy: Number(userArrowEl.getAttribute('data-start-cy')),
        ghostSquare: ghostEl.getAttribute('data-square'),
        ghostTransform: ghostEl.style.transform,
      };
    });

    expect(unflippedState.boardFlipped).toBe('false');
    expect(unflippedState.evalFlipped).toBe('false');
    expect(unflippedState.whiteFillBottom).toBe('0%');
    expect(unflippedState.whiteFillTop).toBe('auto');
    // f3 in unflipped 800x800 SVG viewBox: file f (idx 5 -> 550), rank 3 (row 5 -> 550)
    expect(unflippedState.threatStartCx).toBe(550);
    expect(unflippedState.threatStartCy).toBe(550);

    // Take Playwright screenshot in UNFLIPPED orientation
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, 'phase4-analysis-unflipped.png'),
    });

    // Now press 'F' to flip the board to Black's perspective and re-hover the engine line
    await page.keyboard.press('f');
    await page.getByTestId('engine-pv-move-1-2').hover();
    await expect(ghostPieces.first()).toBeVisible();

    const flippedState = await page.evaluate(() => {
      const evalBar = document.querySelector(
        '[data-testid="eval-bar"]',
      ) as HTMLElement;
      const whiteFill = document.querySelector(
        '[data-testid="eval-bar-white-fill"]',
      ) as HTMLElement;
      const scoreEl = document.querySelector(
        '[data-testid="eval-bar-score"]',
      ) as HTMLElement;
      const threatEl = document.querySelector(
        '[data-testid="overlay-threat-arrow"]',
      ) as HTMLElement;
      const userArrowEl = document.querySelector(
        '[data-testid="overlay-user-arrow"]',
      ) as HTMLElement;
      const ghostEl = document.querySelector(
        '.wc-ghost-piece',
      ) as HTMLElement;
      return {
        boardFlipped: document
          .querySelector('[data-testid="chess-board"]')
          ?.getAttribute('data-flipped'),
        evalFlipped: evalBar.getAttribute('data-flipped'),
        whiteFillBottom: whiteFill.style.bottom,
        whiteFillTop: whiteFill.style.top,
        whiteFillHeight: whiteFill.style.height,
        scorePosition: scoreEl.getAttribute('data-position'),
        threatStartCx: Number(threatEl.getAttribute('data-start-cx')),
        threatStartCy: Number(threatEl.getAttribute('data-start-cy')),
        userArrowStartCx: Number(userArrowEl.getAttribute('data-start-cx')),
        userArrowStartCy: Number(userArrowEl.getAttribute('data-start-cy')),
        ghostSquare: ghostEl.getAttribute('data-square'),
        ghostTransform: ghostEl.style.transform,
      };
    });

    expect(flippedState.boardFlipped).toBe('true');
    expect(flippedState.evalFlipped).toBe('true');
    expect(flippedState.whiteFillTop).toBe('0%');
    expect(flippedState.whiteFillBottom).toBe('auto');
    // In flipped orientation, every 800x800 SVG coordinate mirrors across the center (800 - unflipped)
    expect(flippedState.threatStartCx).toBe(800 - unflippedState.threatStartCx);
    expect(flippedState.threatStartCy).toBe(800 - unflippedState.threatStartCy);
    expect(flippedState.userArrowStartCx).toBe(
      800 - unflippedState.userArrowStartCx,
    );
    expect(flippedState.userArrowStartCy).toBe(
      800 - unflippedState.userArrowStartCy,
    );
    expect(flippedState.ghostTransform).not.toBe(unflippedState.ghostTransform);

    // Take Playwright screenshot in FLIPPED orientation
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, 'phase4-analysis-flipped.png'),
    });

    // Unflip board back to White at bottom via 'F'
    await page.keyboard.press('f');
    await expect(page.getByTestId('chess-board')).toHaveAttribute(
      'data-flipped',
      'false',
    );

    // -------------------------------------------------------------------------
    // 4. Click an Engine Line to Insert Variation & Keyboard Controls
    //    (←/→ prev/next, ↑/↓ switch variation, Home/End, Space engine on/off)
    // -------------------------------------------------------------------------
    // Reset to starting position and play 1. e4 e5
    await page.getByTestId('btn-reset-analysis').click();
    await playSquareMove('e2', 'e4');
    await playSquareMove('e7', 'e5');

    // Step back 1 ply to after 1. e4 (White's 1st move, Black to move) using ArrowLeft
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('analysis-current-fen')).toContainText(
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq',
    );

    // Wait for at least two engine lines, then click the first move of a line that differs
    // from the main-line 1... e5 (Stockfish's line order varies between runs, so this can
    // be line 1, 2 or 3) to insert a variation
    await expect(page.getByTestId('engine-pv-move-2-0')).toBeVisible({
      timeout: 15_000,
    });
    await page
      .locator('[data-testid^="engine-pv-move-"][data-testid$="-0"]')
      .filter({ hasNotText: /^\s*1\.\.\. e5\s*$/ })
      .first()
      .click();

    // Verify the move tree now contains a variation branch
    await expect(page.getByTestId('analysis-move-tree')).toContainText('(');

    // Test Up/Down arrows to switch between sibling variations at ply 2
    const fenInVariation = await page
      .getByTestId('analysis-current-fen')
      .textContent();
    await page.keyboard.press('ArrowUp');
    const fenInMainline = await page
      .getByTestId('analysis-current-fen')
      .textContent();
    expect(fenInMainline).not.toBe(fenInVariation);

    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('analysis-current-fen')).toHaveText(
      fenInVariation ?? '',
    );

    // Test Home (start of game) and End (end of mainline)
    await page.keyboard.press('Home');
    await expect(page.getByTestId('analysis-current-fen')).toHaveText(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
    await page.keyboard.press('End');
    await expect(page.getByTestId('analysis-current-fen')).toHaveText(
      fenInMainline ?? '',
    );

    // Test Spacebar to toggle Engine OFF and back ON
    await page.keyboard.press(' ');
    await expect(page.getByTestId('toggle-analysis-engine')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(page.getByTestId('engine-lines-disabled')).toBeVisible();

    await page.keyboard.press(' ');
    await expect(page.getByTestId('toggle-analysis-engine')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // -------------------------------------------------------------------------
    // 5. Mate-Aware Eval Bar Verification
    // -------------------------------------------------------------------------
    // Load a Mate-in-1 position (White plays Rd8#)
    await page.evaluate(() => {
      window.__wizardChessAnalysis!.controller.loadFen(
        '6k1/5ppp/8/8/8/8/8/3R2K1 w - - 0 1',
      );
    });
    await expect(page.getByTestId('eval-bar')).toHaveAttribute(
      'data-mate',
      'true',
      { timeout: 15_000 },
    );
    await expect(page.getByTestId('eval-bar-score')).toHaveText('M1');
    await expect(page.getByTestId('eval-bar')).toHaveAttribute(
      'data-white-pct',
      '100.0',
    );

    // -------------------------------------------------------------------------
    // 6. Position Editor with Live FEN Validation & Piece Placement
    // -------------------------------------------------------------------------
    await page.getByTestId('btn-toggle-editor').click();
    await expect(page.getByTestId('position-editor-panel')).toBeVisible();

    // Enter an invalid FEN (no White King)
    const fenInput = page.getByTestId('editor-fen-input');
    await fenInput.fill('4k3/8/8/8/8/8/8/8 w - - 0 1');
    await expect(page.getByTestId('editor-fen-status')).toHaveAttribute(
      'data-valid',
      'false',
    );
    await expect(page.getByTestId('btn-apply-fen')).toBeDisabled();

    // Click "Kings Only" preset, then select White Queen tool and click d1 on the board
    await page.getByTestId('btn-editor-kings-only').click();
    await expect(page.getByTestId('editor-fen-status')).toHaveAttribute(
      'data-valid',
      'true',
    );
    await page.getByTestId('editor-tool-wQ').click();
    await page.getByTestId('square-d1').click();
    await expect(page.getByTestId('analysis-current-fen')).toHaveText(
      '4k3/8/8/8/8/8/8/3QK3 w - - 0 1',
    );
    await expect(page.getByTestId('piece-d1')).toBeVisible();

    // Close the Position Editor
    await page.getByTestId('btn-toggle-editor').click();
    await expect(page.getByTestId('position-editor-panel')).toBeHidden();

    // -------------------------------------------------------------------------
    // 7. PGN Import & Export (with Variations, NAGs, Comments, [%eval], [%cal], [%csl])
    // -------------------------------------------------------------------------
    const samplePgn = [
      '[Event "Cathedral Study"]',
      '[White "Archmage"]',
      '[Black "Grandmaster"]',
      '',
      '1. e4 { [%eval +0.25] [%csl Ge4] } 1... e5 (1... c5 2. Nf3) 2. Nf3 Nc6 3. Bb5! { Ruy Lopez } *',
    ].join('\n');

    await page.getByTestId('textarea-pgn').fill(samplePgn);
    await page.getByTestId('btn-import-pgn').click();
    await expect(page.getByTestId('pgn-status')).toHaveText('PGN Loaded');
    await expect(page.getByTestId('opening-eco')).toHaveText('C60');
    await expect(page.getByTestId('opening-name')).toContainText('Ruy Lopez');

    // Navigate to end of mainline (3. Bb5!), add comment and user arrow, then export PGN
    await page.keyboard.press('End');
    await page.getByTestId('square-b5').click({ button: 'right' });
    await page.getByTestId('btn-export-pgn').click();

    const exportedPgn = await page.getByTestId('textarea-pgn').inputValue();
    expect(exportedPgn).toContain('1. e4');
    expect(exportedPgn).toContain('( 1... c5 2. Nf3 )');
    expect(exportedPgn).toContain('$1');
    expect(exportedPgn).toContain('Ruy Lopez');
    expect(exportedPgn).toContain('[%csl Gb5]');

    expect(externalRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
