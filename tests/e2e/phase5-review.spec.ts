import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  FORTY_MOVE_PGN,
  startLayoutShiftRecorder,
  stopLayoutShiftRecorder,
  summarizeShiftSources,
} from './helpers/layout-shift';

// Screenshots go outside Playwright's output folder, which is wiped on every run
const SCREENSHOT_DIR = path.join('test-results', 'phase5-screens');

/** White hangs the queen: 3.Qxe5+?? Nxe5. After 3.Qxe5+ Black is to move and winning. */
const QUEEN_BLUNDER_PGN = `[Event "Review sign check"]
[White "White"]
[Black "Black"]
[Result "0-1"]

1. e4 e5 2. Qh5 Nc6 3. Qxe5+ Nxe5 0-1`;

interface ReviewSnapshot {
  state: string;
  complete: boolean;
  analyzed: number;
  total: number;
  moves: Array<{
    ply: number;
    nodeId: string;
    san: string;
    uci: string;
    color: string;
    classification: string;
    explanation: string | null;
    bestMoveUci: string | null;
    refutationUci: string[];
    whiteWinAfter: number;
  }>;
  series: Array<number | null>;
  white: { accuracy: number | null; acpl: number | null };
  black: { accuracy: number | null; acpl: number | null };
  keyMoments: Array<{ ply: number; nodeId: string }>;
}

async function openAnalysis(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('mode-tab-analysis').click();
  await expect(page.getByTestId('analysis-layout')).toBeVisible();
  await expect(page.getByTestId('review-panel')).toBeVisible();
}

async function readReview(page: Page): Promise<ReviewSnapshot> {
  return page.evaluate(() => {
    const panel = window.__wizardChessReview!.panel;
    const r = panel.getReview();
    return {
      state: panel.getState(),
      complete: r?.complete ?? false,
      analyzed: r?.analyzedPositions ?? 0,
      total: r?.totalPositions ?? 0,
      moves: (r?.moves ?? []).map((m) => ({
        ply: m.ply,
        nodeId: m.nodeId,
        san: m.san,
        uci: m.uci,
        color: m.color,
        classification: m.classification,
        explanation: m.explanation,
        bestMoveUci: m.bestMoveUci,
        refutationUci: m.refutationUci,
        whiteWinAfter: m.whiteWinAfter,
      })),
      series: r?.whiteWinSeries ?? [],
      white: { accuracy: r?.white.accuracy ?? null, acpl: r?.white.acpl ?? null },
      black: { accuracy: r?.black.accuracy ?? null, acpl: r?.black.acpl ?? null },
      keyMoments: (r?.keyMoments ?? []).map((k) => ({ ply: k.ply, nodeId: k.nodeId })),
    };
  });
}

async function currentNode(page: Page) {
  return page.evaluate(() => {
    const tree = window.__wizardChessAnalysis!.controller.getGameTree();
    const node = tree.currentNode;
    return {
      id: node.id,
      ply: node.ply,
      uci: node.uci,
      fen: node.fen,
      parentId: node.parentId,
      mainLineLength: tree.getMainLine().length,
    };
  });
}

async function goToNode(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((id) => window.__wizardChessAnalysis!.controller.goToNode(id), nodeId);
}

async function startLongTaskObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[]; __longTaskObserver?: PerformanceObserver };
    w.__longTasks = [];
    w.__longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__longTasks.push(Math.round(entry.duration));
    });
    w.__longTaskObserver.observe({ entryTypes: ['longtask'] });
  });
}

async function stopLongTaskObserver(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[]; __longTaskObserver?: PerformanceObserver };
    w.__longTaskObserver?.disconnect();
    return w.__longTasks;
  });
}

test.describe('Phase 5 — Game review', () => {
  test('reviews the built-in sample game: live chart, classes, accuracy, key moments, zero layout shift', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const externalRequests: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.hostname !== '127.0.0.1' && url.protocol !== 'data:' && url.protocol !== 'blob:') {
        externalRequests.push(req.url());
      }
    });
    await openAnalysis(page);
    await expect(page.getByTestId('review-body')).toBeHidden();
    await expect(page.getByTestId('review-progress-text')).toContainText('Not reviewed');

    await startLongTaskObserver(page);
    await page.getByTestId('btn-review-sample').click();
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'running');
    await expect(page.getByTestId('btn-review-cancel')).toBeEnabled();
    await expect(page.getByTestId('review-body')).toBeVisible();

    // The chart fills in live: it shows a partial series before the review completes
    const chart = page.getByTestId('review-chart');
    await expect
      .poll(async () => Number(await chart.getAttribute('data-analyzed')), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(5);
    const partial = await readReview(page);
    expect(partial.state).toBe('running');
    expect(partial.analyzed).toBeLessThan(partial.total);
    await expect(page.getByTestId('review-progress-text')).toContainText('Reviewing');

    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', {
      timeout: 120_000,
    });
    const longTasks = await stopLongTaskObserver(page);
    const review = await readReview(page);
    console.log(
      `[review] sample game: ${review.moves.length} moves, accuracy W ${review.white.accuracy?.toFixed(1)} / B ${review.black.accuracy?.toFixed(1)}, long tasks: ${JSON.stringify(longTasks)}`,
    );
    console.log(
      `[review] classes: ${review.moves.map((m) => `${m.san}:${m.classification}`).join(' ')}`,
    );

    // Every move of the 33-ply game is classified
    expect(review.complete).toBe(true);
    expect(review.total).toBe(34);
    expect(review.moves).toHaveLength(33);
    expect(review.series.every((v) => typeof v === 'number')).toBe(true);
    expect(review.moves[0]).toMatchObject({ san: 'e4', classification: 'Book' });
    // Rd8# is the top move; after 16...Nxb8 every other move loses, so it can be Great
    expect(review.moves[32]!.san).toBe('Rd8#');
    expect(['Best', 'Great']).toContain(review.moves[32]!.classification);
    // The mated side counts as −1000 cp, as in Lichess's analysis: 97.5% for White
    expect(review.series[33]).toBeCloseTo(97.54, 1);
    // Black lost to a mating attack: Black made errors, and Morphy played more accurately
    const blackErrors = review.moves.filter(
      (m) => m.color === 'b' && ['Inaccuracy', 'Mistake', 'Blunder', 'Miss'].includes(m.classification),
    );
    expect(blackErrors.length).toBeGreaterThanOrEqual(1);
    for (const m of review.moves.filter((x) => ['Inaccuracy', 'Mistake', 'Blunder', 'Miss'].includes(x.classification))) {
      expect(m.explanation, `${m.san} explanation`).toBeTruthy();
    }
    expect(review.white.accuracy).not.toBeNull();
    expect(review.black.accuracy).not.toBeNull();
    expect(review.white.accuracy!).toBeGreaterThan(review.black.accuracy!);
    expect(review.keyMoments.length).toBeGreaterThanOrEqual(3);
    expect(review.keyMoments.length).toBeLessThanOrEqual(5);

    // The UI stayed responsive: no main-thread task over 50 ms during the whole review.
    // Classification and explanations ran in the review worker, not on the main thread.
    expect(longTasks).toEqual([]);
    const analysisStats = await page.evaluate(() => window.__wizardChessReview!.panel.getAnalysisStats());
    expect(analysisStats.inline).toBe(0);
    expect(analysisStats.worker).toBeGreaterThanOrEqual(33);
    // Zero runtime network requests
    expect(externalRequests).toEqual([]);

    // Summary, counts, progress text: a short status line, the details in its tooltip
    await expect(page.getByTestId('review-progress-text')).toHaveText(/^Reviewed · Quick · \d+(\.\d)? s$/);
    await expect(page.getByTestId('review-status-tooltip')).toHaveText(/^34 positions in \d+\.\d s · mean depth/);
    // On a device that hovers, hovering the status line shows its details
    await expect(page.getByTestId('review-status-tooltip')).toBeHidden();
    await page.getByTestId('review-progress').hover();
    await expect(page.getByTestId('review-status-tooltip')).toBeVisible();
    await page.mouse.move(5, 450);
    await expect(page.getByTestId('review-status-tooltip')).toBeHidden();
    await expect(page.getByTestId('review-accuracy-w')).toHaveText(review.white.accuracy!.toFixed(1));
    await expect(page.getByTestId('review-count-book')).toBeVisible();
    // Neither player is one of my accounts: both sides, White's chart, names from the PGN
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-perspective', 'both');
    await expect(page.getByTestId('review-perspective-both')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('review-player-w')).toHaveText('Paul Morphy · White');
    await expect(page.getByTestId('review-counts-head-w')).toHaveText('Paul Morphy');
    // Class badges in the move tree, each with a label
    const lastBadge = page.locator(`[data-testid="tree-node-${review.moves[32]!.nodeId}"] .wc-tree-class`);
    await expect(lastBadge).toHaveAttribute('aria-label', review.moves[32]!.classification);
    await expect(page.locator('[data-testid="analysis-move-tree"] .wc-tree-class')).toHaveCount(33);

    // The formulas tooltip explains every number
    await page.getByTestId('btn-review-formulas').hover();
    await expect(page.getByTestId('review-formulas-tooltip')).toBeVisible();
    await expect(page.getByTestId('review-formulas-tooltip')).toContainText('0.00368208');
    await expect(page.getByTestId('review-formulas-tooltip')).toContainText('103.1668');
    await expect(page.getByTestId('review-formulas-tooltip')).toContainText('harmonic mean');
    await page.mouse.move(5, 450);

    // Key moments jump to their move
    const moment = review.keyMoments[review.keyMoments.length - 1]!;
    await page.getByTestId(`review-moment-${moment.ply}`).click();
    expect((await currentNode(page)).id).toBe(moment.nodeId);
    await expect(page.getByTestId('review-chart-cursor')).toHaveAttribute('data-ply', String(moment.ply));

    // Clicking the chart jumps to that move
    const box = (await chart.boundingBox())!;
    await page.mouse.click(box.x + (10 / 33) * box.width, box.y + box.height / 2);
    expect((await currentNode(page)).ply).toBe(10);
    await expect(page.getByTestId('review-card-title')).toContainText('5... dxe5');

    // The card for Morphy's queen sacrifice
    const qb8 = review.moves.find((m) => m.san === 'Qb8+')!;
    await goToNode(page, qb8.nodeId);
    await expect(page.getByTestId('review-card-title')).toHaveText(`16. Qb8+ — ${qb8.classification}`);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'review-sample-qb8.png'), fullPage: true });

    // A Black error's card: explanation and the tools for mistakes
    const error = blackErrors[0]!;
    await goToNode(page, error.nodeId);
    await expect(page.getByTestId('review-card-text')).toHaveText(error.explanation!);
    await expect(page.getByTestId('btn-review-retry')).toBeEnabled();
    await expect(page.getByTestId('btn-review-refutation')).toBeEnabled();
    await page.getByTestId('review-panel').screenshot({ path: path.join(SCREENSHOT_DIR, 'review-panel-error.png') });

    // Stepping through the reviewed game shifts nothing
    await page.evaluate(() => window.__wizardChessAnalysis!.controller.goToStart());
    await page.mouse.click(5, 450);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await startLayoutShiftRecorder(page);
    for (let i = 0; i < 33; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(90);
    }
    for (let i = 0; i < 33; i++) {
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(60);
    }
    const shifts = await stopLayoutShiftRecorder(page);
    const summary = summarizeShiftSources(shifts);
    for (const s of summary) {
      console.log(`[layout-shift] ${s.count}× ${s.node} prev=${JSON.stringify(s.example.previousRect)} curr=${JSON.stringify(s.example.currentRect)}`);
    }
    expect((await currentNode(page)).ply).toBe(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    expect(summary).toEqual([]);
    expect(shifts.length).toBe(0);
  });

  test('Black-to-move positions reached through move history keep the right sign everywhere', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openAnalysis(page);
    await page.evaluate((pgn) => window.__wizardChessAnalysis!.controller.importPgn(pgn), QUEEN_BLUNDER_PGN);
    await page.getByTestId('btn-review-start').click();
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', {
      timeout: 60_000,
    });
    const review = await readReview(page);
    const blunder = review.moves[4]!;
    expect(blunder).toMatchObject({ san: 'Qxe5+', color: 'w', classification: 'Blunder' });
    // After 3.Qxe5+ Black is to move and a queen up for a pawn: White's win% is low (a
    // flipped sign would put it near 90%; Quick on one thread reads about −5 to −8 pawns)
    expect(review.series[5]!).toBeLessThan(25);
    expect(blunder.whiteWinAfter).toBeLessThan(25);
    expect(review.series[6]!).toBeLessThan(25);

    // The card's eval, the eval bar (seeded from the review's [%eval]) and the engine
    // lines all show Black ahead at the Black-to-move node
    await goToNode(page, blunder.nodeId);
    expect((await currentNode(page)).fen.split(' ')[1]).toBe('b');
    await expect(page.getByTestId('review-card-eval')).toContainText('→ -');
    const evalBar = page.getByTestId('eval-bar');
    await expect.poll(async () => Number(await evalBar.getAttribute('data-white-pct'))).toBeLessThan(25);
    await expect(page.getByTestId('eval-bar-score')).toHaveText(/^-/);
    await expect(page.getByTestId('analysis-eval-pill')).toHaveText(/^-/);
    await expect(page.getByTestId('engine-line-eval-1')).toHaveText(/^-/, { timeout: 20_000 });
    await expect(page.getByTestId('engine-line-eval-2')).toHaveText(/^-/, { timeout: 20_000 });
    // Still negative once live analysis has gone deeper
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('eval-bar-score')).toHaveText(/^-/);
    expect(Number(await evalBar.getAttribute('data-white-pct'))).toBeLessThan(25);
    // And the annotated PGN writes it from White's point of view
    await page.getByTestId('btn-review-export').click();
    const pgn = await page.getByTestId('textarea-pgn').inputValue();
    expect(pgn).toMatch(/Qxe5\+ \$4 \{ \[%eval -\d+\.\d\d,\d+\]/);
  });

  test('review tools: retry the mistake, show the refutation, export, play vs bot here', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await openAnalysis(page);
    await page.evaluate((pgn) => window.__wizardChessAnalysis!.controller.importPgn(pgn), QUEEN_BLUNDER_PGN);
    await page.getByTestId('btn-review-start').click();
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', {
      timeout: 60_000,
    });
    const review = await readReview(page);
    const blunder = review.moves[4]!;

    // --- Retry This Mistake
    await goToNode(page, blunder.nodeId);
    await page.getByTestId('btn-review-retry').click();
    const parent = await currentNode(page);
    expect(parent.id).not.toBe(blunder.nodeId);
    expect(parent.ply).toBe(4);
    await expect(page.getByTestId('review-card-title')).toHaveText('Retry: 3. Qxe5+');
    await expect(page.getByTestId('btn-review-retry')).toHaveText('Stop Retrying');

    // The game move again: refused, and the game itself is untouched
    await page.getByTestId('square-h5').click();
    await page.getByTestId('square-e5').click();
    await expect(page.getByTestId('review-card-text')).toHaveText(
      'Qxe5+ is the move from the game. Try another one.',
    );
    expect((await currentNode(page)).id).toBe(parent.id);
    expect((await currentNode(page)).mainLineLength).toBe(6);

    // Another losing move: checked by the engine, refused, and removed again
    await page.getByTestId('square-h5').click();
    await page.getByTestId('square-f7').click();
    await expect(page.getByTestId('review-card-text')).toHaveText('Qxf7+ is also a blunder. Try again.', {
      timeout: 15_000,
    });
    expect((await currentNode(page)).id).toBe(parent.id);
    const childCount = await page.evaluate(
      (id) => window.__wizardChessAnalysis!.controller.getGameTree().getNode(id)!.children.length,
      parent.id,
    );
    expect(childCount).toBe(1);

    // The engine's best move solves it
    const best = blunder.bestMoveUci!;
    await page.getByTestId(`square-${best.slice(0, 2)}`).click();
    await page.getByTestId(`square-${best.slice(2, 4)}`).click();
    await expect(page.getByTestId('review-card-text')).toHaveText(/^✓ .+ is the best move\.$/);
    await expect(page.getByTestId('review-card-title')).toHaveText('Retry solved');
    expect((await currentNode(page)).uci).toBe(best);
    await page.getByTestId('review-panel').screenshot({ path: path.join(SCREENSHOT_DIR, 'review-retry-solved.png') });

    // --- Show Refutation
    await goToNode(page, blunder.nodeId);
    await page.getByTestId('btn-review-refutation').click();
    const afterRefutation = await currentNode(page);
    expect(afterRefutation.parentId).toBe(blunder.nodeId);
    expect(afterRefutation.uci).toBe(blunder.refutationUci[0]);
    // The refutation starts with the move Black played; it goes into its own variation
    // and never extends the game's main line
    expect(afterRefutation.mainLineLength).toBe(6);
    const refutationLength = await page.evaluate((id) => {
      const tree = window.__wizardChessAnalysis!.controller.getGameTree();
      let n = tree.getNode(id);
      let count = 0;
      while (n) {
        count++;
        n = n.children[0];
      }
      return count;
    }, afterRefutation.id);
    expect(refutationLength).toBe(Math.min(8, blunder.refutationUci.length));

    // --- Export Annotated PGN (into the PGN box and as a download)
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('btn-review-export').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('wizards-chess-review.pgn');
    const pgn = await page.getByTestId('textarea-pgn').inputValue();
    expect(pgn).toContain('[Annotator "Wizard\'s Chess review (Stockfish');
    expect(pgn).toContain('Quick, 0.2 s per move');
    expect(pgn).toContain('$4');
    expect(pgn).toContain('Blunder.');
    expect(pgn).toMatch(/White accuracy \d+\.\d%/);
    await expect(page.getByTestId('pgn-status')).toHaveText('Annotated PGN Exported');
    // The exported PGN loads back
    const parsed = await page.evaluate((text) => {
      const tree = window.__wizardChessCore!.parsePgn(text);
      return tree.getMainLine().length;
    }, pgn);
    expect(parsed).toBe(6);

    // --- Play vs Bot Here (from the position after 2...Nc6, White to move)
    await goToNode(page, parent.id);
    await page.getByTestId('btn-review-play-bot').click();
    await expect.poll(() => page.evaluate(() => window.__wizardChessAnalysis!.getMode())).toBe('play');
    const play = await page.evaluate(() => {
      const controller = window.__wizardChessPlay!.controller;
      return { fen: controller.getAdapter().fen(), flipped: controller.getBoard().isFlipped() };
    });
    expect(play.fen).toBe(parent.fen);
    expect(play.flipped).toBe(false);
  });

  test('reviewing an imported Lichess analysis replaces it: one consistent annotation per move', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const fixture = JSON.parse(
      fs.readFileSync(path.join('tests', 'fixtures', 'review', 'lichess-Bjl39T9x.json'), 'utf8'),
    ) as { pgn: string };
    await openAnalysis(page);
    await page.evaluate((pgn) => window.__wizardChessAnalysis!.controller.importPgn(pgn), fixture.pgn);
    // Before the review, the move list shows Lichess's ?! / ? / ?? and evals
    const before = await page.evaluate(() =>
      window.__wizardChessAnalysis!.controller
        .getGameTree()
        .getMainLine()
        .filter((n) => n.nags.length > 0).length,
    );
    expect(before).toBeGreaterThan(10);

    await page.getByTestId('btn-review-start').click();
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', {
      timeout: 90_000,
    });
    await expect(page.getByTestId('review-status-tooltip')).toContainText(
      /replaced \d+ earlier engine annotations/,
    );

    const state = await page.evaluate(() => {
      const tree = window.__wizardChessAnalysis!.controller.getGameTree();
      const review = window.__wizardChessReview!.panel.getReview()!;
      return {
        main: tree.getMainLine().map((n) => ({
          id: n.id,
          nags: n.nags,
          classification: n.classification ?? null,
          comment: n.comment,
          siblings: tree.getNode(n.parentId!)!.children.length,
        })),
        moves: review.moves.map((m) => ({ nodeId: m.nodeId, classification: m.classification })),
      };
    });
    // The live move tree: no imported quality NAGs, no Lichess comments or variations left,
    // and every move carries the app's own class
    expect(state.moves).toHaveLength(46);
    for (const [i, node] of state.main.entries()) {
      expect(node.nags.filter((n) => n >= 1 && n <= 6), `ply ${i + 1}`).toEqual([]);
      expect(node.comment).not.toMatch(/was best|Checkmate is now unavoidable/);
      expect(node.siblings, `ply ${i + 1}`).toBe(1);
      expect(node.classification).toBe(state.moves[i]!.classification);
    }
    await expect(page.locator('[data-testid="analysis-move-tree"] .wc-tree-class')).toHaveCount(46);

    // The export: exactly the app's NAG per move, one eval per move, no Lichess text. It is
    // clicked right after the review ends and read after the board's 400 ms PGN refresh,
    // which used to overwrite the annotated PGN with the plain game
    await page.getByTestId('btn-review-export').click();
    await page.waitForTimeout(600);
    const pgn = await page.getByTestId('textarea-pgn').inputValue();
    expect(pgn).not.toMatch(/was best|Checkmate is now unavoidable/);
    // The app's own sentences may quote an evaluation change; nothing else may
    expect(pgn.replace(/Review:[^}]*/g, '')).not.toMatch(/→/);
    expect(pgn).toContain('[Annotator "Wizard\'s Chess review');
    const exported = await page.evaluate((text) => {
      const tree = window.__wizardChessCore!.parsePgn(text);
      return tree.getMainLine().map((n) => ({ nags: n.nags, hasEval: Boolean(n.eval), reviews: (n.comment.match(/Review:/g) ?? []).length }));
    }, pgn);
    const nagFor: Record<string, number | undefined> = {
      Brilliant: 3,
      Great: 1,
      Inaccuracy: 6,
      Mistake: 2,
      Blunder: 4,
      Miss: 2,
    };
    exported.forEach((node, i) => {
      const expected = nagFor[state.moves[i]!.classification];
      expect(node.nags, `ply ${i + 1}`).toEqual(expected === undefined ? [] : [expected]);
      expect(node.reviews).toBeLessThanOrEqual(1);
      if (i < 45) expect(node.hasEval, `ply ${i + 1}`).toBe(true);
    });
  });

  test('cancelling keeps a partial review; a new game resets the panel', async ({ page }) => {
    test.setTimeout(120_000);
    await openAnalysis(page);
    await page.evaluate((pgn) => window.__wizardChessAnalysis!.controller.importPgn(pgn), FORTY_MOVE_PGN);
    await page.getByTestId('select-review-preset').selectOption('deep');
    await page.getByTestId('btn-review-start').click();
    const chart = page.getByTestId('review-chart');
    await expect
      .poll(async () => Number(await chart.getAttribute('data-analyzed')), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(4);
    await page.getByTestId('btn-review-cancel').click();
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'cancelled');
    await expect(page.getByTestId('review-progress-text')).toContainText('Cancelled at');
    const review = await readReview(page);
    expect(review.complete).toBe(false);
    expect(review.total).toBe(82);
    expect(review.analyzed).toBeGreaterThanOrEqual(4);
    expect(review.analyzed).toBeLessThan(82);
    expect(review.moves.length).toBe(review.analyzed - 1);
    await expect(page.locator('[data-testid="analysis-move-tree"] .wc-tree-class')).toHaveCount(
      review.moves.length,
    );
    await expect(page.getByTestId('btn-review-export')).toBeEnabled();
    await expect(page.getByTestId('btn-review-start')).toBeEnabled();

    // Loading another game clears the review
    await page.evaluate(() => window.__wizardChessAnalysis!.controller.loadFen('8/8/8/4k3/8/8/4P3/4K3 w - - 0 1'));
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'idle');
    await expect(page.getByTestId('review-body')).toBeHidden();
  });
});

const ERROR_CLASSES = ['Inaccuracy', 'Mistake', 'Blunder', 'Miss'];

/** https://lichess.org/Bjl39T9x: GEU3 (1374) – Lobo017 (1397), my game as Black. */
const MY_LICHESS_PGN = (
  JSON.parse(fs.readFileSync(path.join('tests', 'fixtures', 'review', 'lichess-Bjl39T9x.json'), 'utf8')) as {
    pgn: string;
  }
).pgn;

type SnapshotMove = ReviewSnapshot['moves'][number];

async function reviewMyLichessGame(page: Page): Promise<ReviewSnapshot> {
  await openAnalysis(page);
  await page.evaluate((pgn) => window.__wizardChessAnalysis!.controller.importPgn(pgn), MY_LICHESS_PGN);
  await page.getByTestId('btn-review-start').click();
  await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 90_000 });
  // Keep the finished review so the tests can check that switching never re-runs it
  await page.evaluate(() => {
    const w = window as unknown as { __reviewAtEnd: unknown; __runAtEnd: unknown };
    w.__reviewAtEnd = window.__wizardChessReview!.panel.getReview();
    w.__runAtEnd = window.__wizardChessReview!.panel.getRunResult();
  });
  return readReview(page);
}

/** What the perspective changes on screen. */
async function perspectiveView(page: Page) {
  return page.evaluate(() => {
    const panel = window.__wizardChessReview!.panel;
    const w = window as unknown as { __reviewAtEnd: unknown; __runAtEnd: unknown };
    const line = document.querySelector('.wc-review-chart-line')!.getAttribute('d') ?? '';
    const first = /^M([\d.]+),([\d.]+)/.exec(line);
    return {
      perspective: panel.getPerspective(),
      flipped: window.__wizardChessAnalysis!.controller.getBoard().isFlipped(),
      sameReview: panel.getReview() === w.__reviewAtEnd && panel.getRunResult() === w.__runAtEnd,
      state: panel.getState(),
      chartStartY: first ? Number(first[2]) : null,
      markerPlies: [...document.querySelectorAll('.wc-review-chart-marker')].map((el) =>
        Number(el.getAttribute('data-ply')),
      ),
      moments: [...document.querySelectorAll<HTMLElement>('[data-testid="review-key-moments"] [data-node-id]')].map(
        (el) => ({
          nodeId: el.getAttribute('data-node-id')!,
          color: el.getAttribute('data-color')!,
          move: el.querySelector('.wc-review-moment-move')?.textContent ?? '',
          text: el.querySelector('.wc-review-moment-text')?.textContent ?? '',
          badge: el.querySelector('.wc-class-badge')?.getAttribute('aria-label') ?? '',
        }),
      ),
    };
  });
}

/** Clicks Next (or Prev) `times` times and returns the node ids it landed on. */
async function stepErrors(page: Page, dir: 'next' | 'prev', times: number): Promise<string[]> {
  const visited: string[] = [];
  for (let i = 0; i < times; i++) {
    await page.getByTestId(`btn-review-${dir}-mistake`).click();
    visited.push((await currentNode(page)).id);
  }
  return visited;
}

function errorsOf(review: ReviewSnapshot, color: 'w' | 'b' | 'both'): SnapshotMove[] {
  return review.moves.filter(
    (m) => (color === 'both' || m.color === color) && ERROR_CLASSES.includes(m.classification),
  );
}

function retryTitle(move: SnapshotMove): RegExp {
  const san = move.san.replace(/[+]/g, '\\+');
  return new RegExp(`^Retry: \\d+${move.color === 'w' ? '\\.' : '\\.\\.\\.'} ${san}$`);
}

async function screenshotPanel(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.getByTestId('review-panel').screenshot({ path: path.join(SCREENSHOT_DIR, `${name}-panel.png`) });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}-page.png`), fullPage: true });
}

test.describe('Phase 5 — Review perspective', () => {
  test('Black: my Lichess game opens from my side; only my errors, my chart, my retries', async ({ page }) => {
    test.setTimeout(150_000);
    const review = await reviewMyLichessGame(page);
    const view = await perspectiveView(page);

    // Lobo017 is Black: the default is Black, the board is flipped, the chart is Black's
    expect(view.perspective).toBe('b');
    expect(view.flipped).toBe(true);
    await expect(page.getByTestId('review-perspective-b')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('review-chart-label')).toHaveText('Black ↑');
    // Black's win% at the start, measured from the bottom: y = 100 − (100 − White's win%)
    expect(view.chartStartY).toBeCloseTo(review.series[0]!, 1);

    // Player headers and table columns from the PGN headers; my side emphasized
    await expect(page.getByTestId('review-player-b')).toHaveText('Lobo017 · 1397 · Black');
    await expect(page.getByTestId('review-player-w')).toHaveText('GEU3 · 1374 · White');
    await expect(page.getByTestId('review-counts-head-b')).toHaveText('Lobo017');
    await expect(page.getByTestId('review-counts-head-w')).toHaveText('GEU3');
    await expect(page.getByTestId('review-side-b')).toHaveAttribute('data-emphasis', 'primary');
    await expect(page.getByTestId('review-side-w')).toHaveAttribute('data-emphasis', 'secondary');
    await expect(page.getByTestId('review-counts')).toHaveAttribute('data-perspective', 'b');
    await expect(page.getByTestId('review-accuracy-b')).toHaveText(review.black.accuracy!.toFixed(1));
    await expect(page.getByTestId('review-acpl-b')).toHaveText(String(Math.round(review.black.acpl!)));
    // Bot level lives in the info tooltip
    await page.getByTestId('btn-review-formulas').hover();
    await expect(page.getByTestId('review-formulas-tooltip')).toContainText('Bot level (approx.): GEU3');
    await expect(page.getByTestId('review-bot-level-b')).toHaveText(/^(≈\d+|≤\d+|≥\d+|—)$/);
    await page.mouse.move(5, 450);

    // Key moments: Black's moves only, each with its icon and its sentence
    expect(view.moments.length).toBeGreaterThanOrEqual(1);
    expect(view.moments.length).toBeLessThanOrEqual(5);
    for (const m of view.moments) {
      const move = review.moves.find((x) => x.nodeId === m.nodeId)!;
      expect(m.color).toBe('b');
      expect(m.badge).toBe(move.classification);
      expect(m.move).toMatch(/^\d+\.\.\. \S+$/);
      expect(m.text.length).toBeGreaterThan(5);
      if (move.explanation) expect(m.text).toBe(move.explanation);
    }
    // Chart markers: Black's moves only
    expect(view.markerPlies.length).toBeGreaterThan(0);
    expect(view.markerPlies.every((p) => p % 2 === 0)).toBe(true);

    // Next / previous error: Black's errors (Misses included), in order, wrapping around
    const blackErrors = errorsOf(review, 'b');
    expect(blackErrors.length).toBeGreaterThanOrEqual(2);
    await page.evaluate(() => window.__wizardChessAnalysis!.controller.goToStart());
    const forward = await stepErrors(page, 'next', blackErrors.length + 1);
    expect(forward).toEqual([...blackErrors.map((m) => m.nodeId), blackErrors[0]!.nodeId]);
    await expect(page.getByTestId('review-mistake-position')).toHaveText(`Black errors · 1 / ${blackErrors.length}`);
    expect(await stepErrors(page, 'prev', 1)).toEqual([blackErrors[blackErrors.length - 1]!.nodeId]);

    // Retry covers only Black's mistakes
    await goToNode(page, errorsOf(review, 'w')[0]!.nodeId);
    await expect(page.getByTestId('btn-review-refutation')).toBeEnabled();
    await expect(page.getByTestId('btn-review-retry')).toBeDisabled();
    const first = blackErrors[0]!;
    const second = blackErrors[1]!;
    await goToNode(page, first.nodeId);
    await page.getByTestId('btn-review-retry').click();
    await expect(page.getByTestId('review-card-title')).toHaveText(retryTitle(first));
    // While retrying, Next moves the retry on to Black's next error
    await page.getByTestId('btn-review-next-mistake').click();
    await expect(page.getByTestId('review-card-title')).toHaveText(retryTitle(second));
    const secondParent = await page.evaluate(
      (id) => window.__wizardChessAnalysis!.controller.getGameTree().getNode(id)!.parentId,
      second.nodeId,
    );
    expect((await currentNode(page)).id).toBe(secondParent);
    await page.getByTestId('btn-review-retry').click();
    await expect(page.getByTestId('btn-review-retry')).toHaveText('Retry This Mistake');

    // A count jumps through those moves, wrapping around; zero counts are dimmed and inert
    const cls = ERROR_CLASSES.find((c) => blackErrors.some((m) => m.classification === c))!;
    const ofClass = blackErrors.filter((m) => m.classification === cls);
    const slug = cls.toLowerCase();
    await expect(page.getByTestId(`review-count-${slug}-b`)).toHaveText(String(ofClass.length));
    await page.evaluate(() => window.__wizardChessAnalysis!.controller.goToStart());
    for (const expected of [...ofClass, ofClass[0]!]) {
      await page.getByTestId(`review-count-${slug}-b`).click();
      expect((await currentNode(page)).id).toBe(expected.nodeId);
    }
    const zeroClass = ['Brilliant', 'Great', 'Book', 'Blunder', 'Miss', 'Mistake'].find(
      (c) => !review.moves.some((m) => m.color === 'b' && m.classification === c),
    )!;
    const zero = page.getByTestId(`review-count-${zeroClass.toLowerCase()}-b`);
    await expect(zero).toHaveText('0');
    await expect(zero).toBeDisabled();
    await expect(zero).toHaveAttribute('data-zero', 'true');

    expect((await perspectiveView(page)).sameReview).toBe(true);
    await goToNode(page, first.nodeId);
    await screenshotPanel(page, 'perspective-black-desktop');
  });

  test('White: switching shows the opponent side without re-running the engine', async ({ page }) => {
    test.setTimeout(150_000);
    const review = await reviewMyLichessGame(page);
    await page.getByTestId('review-perspective-w').click();
    const view = await perspectiveView(page);

    expect(view.perspective).toBe('w');
    expect(view.flipped).toBe(false);
    expect(view.state).toBe('done');
    expect(view.sameReview).toBe(true);
    await expect(page.getByTestId('review-chart-label')).toHaveText('White ↑');
    expect(view.chartStartY).toBeCloseTo(100 - review.series[0]!, 1);
    await expect(page.getByTestId('review-side-w')).toHaveAttribute('data-emphasis', 'primary');
    await expect(page.getByTestId('review-side-b')).toHaveAttribute('data-emphasis', 'secondary');
    await expect(page.getByTestId('review-counts')).toHaveAttribute('data-perspective', 'w');

    expect(view.moments.length).toBeGreaterThanOrEqual(1);
    for (const m of view.moments) {
      expect(m.color).toBe('w');
      expect(m.move).toMatch(/^\d+\. \S+$/);
      expect(m.text.length).toBeGreaterThan(5);
    }
    expect(view.markerPlies.every((p) => p % 2 === 1)).toBe(true);
    const whiteErrors = errorsOf(review, 'w');
    await page.evaluate(() => window.__wizardChessAnalysis!.controller.goToStart());
    expect(await stepErrors(page, 'next', whiteErrors.length)).toEqual(whiteErrors.map((m) => m.nodeId));
    await expect(page.getByTestId('review-mistake-position')).toHaveText(
      `White errors · ${whiteErrors.length} / ${whiteErrors.length}`,
    );
    await expect(page.getByTestId('btn-review-retry')).toBeEnabled();
    await goToNode(page, errorsOf(review, 'b')[0]!.nodeId);
    await expect(page.getByTestId('btn-review-retry')).toBeDisabled();
    await goToNode(page, whiteErrors[0]!.nodeId);
    await screenshotPanel(page, 'perspective-white-desktop');
  });

  test('Both: two-sided view; switching perspective shifts nothing, desktop and phone', async ({ page }) => {
    test.setTimeout(150_000);
    const review = await reviewMyLichessGame(page);
    await page.getByTestId('review-perspective-both').click();
    const view = await perspectiveView(page);

    expect(view.perspective).toBe('both');
    // Both leaves the board where it was (Black, from the default)
    expect(view.flipped).toBe(true);
    expect(view.sameReview).toBe(true);
    await expect(page.getByTestId('review-chart-label')).toHaveText('White ↑');
    expect(view.chartStartY).toBeCloseTo(100 - review.series[0]!, 1);
    await expect(page.getByTestId('review-side-w')).toHaveAttribute('data-emphasis', 'none');
    await expect(page.getByTestId('review-side-b')).toHaveAttribute('data-emphasis', 'none');
    expect(view.moments.map((m) => m.nodeId)).toEqual(review.keyMoments.map((k) => k.nodeId));
    expect(new Set(view.markerPlies.map((p) => p % 2)).size).toBe(2);
    const allErrors = errorsOf(review, 'both');
    await page.evaluate(() => window.__wizardChessAnalysis!.controller.goToStart());
    expect(await stepErrors(page, 'next', allErrors.length)).toEqual(allErrors.map((m) => m.nodeId));
    await expect(page.getByTestId('review-mistake-position')).toHaveText(
      `All errors · ${allErrors.length} / ${allErrors.length}`,
    );
    await goToNode(page, errorsOf(review, 'w')[0]!.nodeId);
    await expect(page.getByTestId('btn-review-retry')).toBeEnabled();
    await goToNode(page, errorsOf(review, 'b')[0]!.nodeId);
    await expect(page.getByTestId('btn-review-retry')).toBeEnabled();
    await screenshotPanel(page, 'perspective-both-desktop');

    const switchAround = async () => {
      const scrollBefore = await page.evaluate(() => window.scrollY);
      await startLayoutShiftRecorder(page);
      for (const p of ['w', 'b', 'both', 'w', 'both', 'b']) {
        await page.getByTestId(`review-perspective-${p}`).click();
        await page.waitForTimeout(120);
      }
      const shifts = await stopLayoutShiftRecorder(page);
      const summary = summarizeShiftSources(shifts);
      for (const s of summary) {
        console.log(
          `[layout-shift] ${s.count}× ${s.node} prev=${JSON.stringify(s.example.previousRect)} curr=${JSON.stringify(s.example.currentRect)}`,
        );
      }
      expect(summary).toEqual([]);
      expect(shifts.length).toBe(0);
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    };
    // Desktop
    await switchAround();

    // Phone width: one column, no horizontal scroll, still no shift
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.getByTestId('review-perspective').scrollIntoViewIfNeeded();
    await switchAround();
    expect((await perspectiveView(page)).perspective).toBe('b');
    await screenshotPanel(page, 'perspective-black-phone');
    await page.getByTestId('review-perspective-both').click();
    await screenshotPanel(page, 'perspective-both-phone');
  });
});

test.describe('Phase 5 — Review panel on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('tooltips open on tap and close on an outside tap or Escape; the header fits', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await page.getByTestId('mode-tab-analysis').tap();
    await expect(page.getByTestId('review-panel')).toBeVisible();
    // A touch screen: nothing can hover, so taps are the only way in
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false);

    // The header's buttons all fit inside the panel, none clipped or covered
    const panelBox = (await page.getByTestId('review-panel').boundingBox())!;
    for (const id of ['select-review-preset', 'btn-review-start', 'btn-review-cancel', 'btn-review-sample']) {
      const el = page.getByTestId(id);
      await el.scrollIntoViewIfNeeded();
      const box = (await el.boundingBox())!;
      expect(box.x, id).toBeGreaterThanOrEqual(panelBox.x);
      expect(box.x + box.width, id).toBeLessThanOrEqual(panelBox.x + panelBox.width);
      expect(await el.evaluate((n) => n.scrollWidth <= n.clientWidth), `${id} text fits`).toBe(true);
      expect(
        await el.evaluate((n) => {
          const r = n.getBoundingClientRect();
          return n.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
        }),
        `${id} is not covered`,
      ).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await page.evaluate((pgn) => window.__wizardChessAnalysis!.controller.importPgn(pgn), QUEEN_BLUNDER_PGN);
    await page.getByTestId('btn-review-start').tap();
    await expect(page.getByTestId('review-panel')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });

    const status = page.getByTestId('review-progress');
    const statusTip = page.getByTestId('review-status-tooltip');
    const info = page.getByTestId('btn-review-formulas');
    const formulas = page.getByTestId('review-formulas-tooltip');
    // Outside both tooltips: the panel title (each tooltip opens below its trigger)
    const outside = page.locator('[data-testid="review-panel"] > .wc-panel-section-title > span');
    await status.scrollIntoViewIfNeeded();

    // Status details: tap opens, an outside tap closes, tap again opens, Escape closes
    await expect(statusTip).toBeHidden();
    await status.tap();
    await expect(statusTip).toBeVisible();
    // (Live analysis stores its eval on the current move, which the review then replaces)
    await expect(statusTip).toHaveText(
      /^7 positions in \d+\.\d s · mean depth \d+\.\d · 0\.2 s per position( · replaced 1 earlier engine annotation| · replaced \d+ earlier engine annotations)?$/,
    );
    const statusBox = (await statusTip.boundingBox())!;
    expect(statusBox.x).toBeGreaterThanOrEqual(0);
    expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(390);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.getByTestId('review-panel').screenshot({ path: path.join(SCREENSHOT_DIR, 'phone-status-tooltip.png') });
    await outside.tap();
    await expect(statusTip).toBeHidden();
    await status.tap();
    await expect(statusTip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(statusTip).toBeHidden();
    // Tapping the status line again toggles it closed
    await status.tap();
    await status.tap();
    await expect(statusTip).toBeHidden();

    // Formulas: the same, and a second tap on the button closes it even though it has focus
    await info.tap();
    await expect(formulas).toBeVisible();
    await expect(info).toHaveAttribute('aria-expanded', 'true');
    await expect(formulas).toContainText('Bot level (approx.)');
    {
      const tip = formulas;
      const box = (await tip.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    await page.getByTestId('review-panel').screenshot({ path: path.join(SCREENSHOT_DIR, 'phone-formulas-tooltip.png') });
    await info.tap();
    await expect(formulas).toBeHidden();
    await expect(info).toHaveAttribute('aria-expanded', 'false');
    await info.tap();
    await expect(formulas).toBeVisible();
    await outside.tap();
    await expect(formulas).toBeHidden();
    await info.tap();
    await page.keyboard.press('Escape');
    await expect(formulas).toBeHidden();
    // Only one open at a time
    await info.tap();
    await status.tap();
    await expect(statusTip).toBeVisible();
    await expect(formulas).toBeHidden();
    await outside.tap();

    // Opening a tooltip never moves the layout or scrolls sideways
    await startLayoutShiftRecorder(page);
    await status.tap();
    await info.tap();
    await outside.tap();
    const shifts = await stopLayoutShiftRecorder(page);
    expect(summarizeShiftSources(shifts)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await page.getByTestId('review-panel').screenshot({ path: path.join(SCREENSHOT_DIR, 'phone-panel.png') });
  });
});
