import path from 'node:path';
import { expect, test } from '@playwright/test';

test.describe('Phase 2 — Stockfish 17.1 WASM (Multi-Threaded & Single-Threaded), Mate-in-2, Hanging Piece & Bot E2E', () => {
  test('loads both multi-threaded and single-threaded Stockfish under npm run serve, finds mate-in-2, wins a hanging piece, and runs human-like bot with zero external network requests', async ({
    page,
  }) => {
    test.setTimeout(60000);

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

    const response = await page.goto('/');
    expect(response?.status()).toBe(200);

    await expect(page.getByTestId('engine-badge')).toContainText(
      'Stockfish 17.1 WASM · Bot 400–2400',
    );
    await expect(page.getByTestId('stat-engine')).toContainText(
      'Stockfish 17.1 Lite NNUE (MultiPV 1–5)',
    );
    await expect(page.getByTestId('stat-bot')).toContainText(
      '400–2400 Elo · Aggressive / Solid / Gambiteer',
    );

    // Open Dev Overlay so live engine telemetry updates are rendered on screen
    await page.keyboard.press('`');
    const devOverlay = page.getByTestId('dev-overlay');
    await expect(devOverlay).toBeVisible();

    const results = await page.evaluate(async () => {
      const engineApi = window.__wizardChessEngine;
      if (!engineApi) {
        throw new Error('window.__wizardChessEngine not initialized');
      }

      const caps = engineApi.detectEngineCapabilities();

      // 1. Default ('auto') EngineClient under npm run serve (COOP/COEP isolated -> multi-threaded)
      const mtClient = engineApi.createConnectedEngine({
        variant: 'auto',
      });
      await mtClient.init();
      const mtVariant = mtClient.getVariant();
      const mtName = mtClient.getEngineName();
      const mtThreads = mtClient.getThreads();

      // Benchmark multi-threaded engine on standard starting position (depth 12, MultiPV 2)
      const mtBench = await mtClient.analyze({
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        depth: 12,
        multipv: 2,
      });

      // Verify cache hit on repeat query
      const mtCached = await mtClient.analyze({
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        depth: 12,
        multipv: 2,
      });

      // 2. Mate-in-2 test:
      // White to move: 1. Nf6+ gxf6 2. Bxf7# (Opera/Legal-style mate in 2)
      const mateIn2Fen =
        'r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w KQkq - 1 1';
      const mateResult = await mtClient.analyze({
        fen: mateIn2Fen,
        depth: 10,
        multipv: 1,
      });

      // 3. Winning a hanging piece test:
      // Black has an undefended Queen hanging on d4 (White Nxd4 wins the Queen cleanly)
      const hangingPieceFen =
        'r1b1kbnr/pppp1ppp/2n5/4p3/3qP3/5N2/PPP2PPP/RNBQKB1R w KQkq - 0 4';
      const hangingResult = await mtClient.analyze({
        fen: hangingPieceFen,
        depth: 10,
        multipv: 2,
      });

      // 4. Test ChessBot (Master tier on hanging piece position)
      const bot = new engineApi.ChessBot(mtClient, {
        rating: 'Master',
        style: 'aggressive',
      });
      const botDecision = await bot.chooseMove(hangingPieceFen, { depth: 8 });

      mtClient.terminate();

      // 5. Explicitly load and benchmark single-threaded Stockfish under npm run serve
      const stClient = new engineApi.EngineClient({
        variant: 'single-threaded',
      });
      await stClient.init();
      const stVariant = stClient.getVariant();
      const stName = stClient.getEngineName();
      const stThreads = stClient.getThreads();

      const stBench = await stClient.analyze({
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        depth: 12,
        multipv: 1,
      });

      stClient.terminate();

      return {
        caps,
        activeDefaultVariant: mtVariant,
        mt: {
          variant: mtVariant,
          name: mtName,
          threads: mtThreads,
          nps: mtBench.nps,
          nodes: mtBench.nodes,
          timeMs: mtBench.timeMs,
          linesCount: mtBench.lines.length,
          cachedHit: mtCached.cached,
        },
        st: {
          variant: stVariant,
          name: stName,
          threads: stThreads,
          nps: stBench.nps,
          nodes: stBench.nodes,
          timeMs: stBench.timeMs,
        },
        mateIn2: {
          bestMove: mateResult.bestMove,
          score: mateResult.lines[0]?.score,
          pv: mateResult.lines[0]?.pv,
        },
        hangingPiece: {
          bestMove: hangingResult.bestMove,
          score: hangingResult.lines[0]?.score,
          evalCp: hangingResult.lines[0]?.evalCp,
        },
        botDecision: {
          san: botDecision.san,
          uci: botDecision.uci,
          tier: botDecision.params.tier,
        },
      };
    });

    console.log('E2E Stockfish Telemetry:', JSON.stringify(results, null, 2));

    // Verify both multi-threaded and single-threaded loaded and ran
    expect(results.caps.crossOriginIsolated).toBe(true);
    expect(results.activeDefaultVariant).toBe('multi-threaded');
    expect(results.mt.variant).toBe('multi-threaded');
    expect(results.mt.name).toContain('Stockfish 17.1 Lite WASM Multithreaded');
    expect(results.mt.threads).toBeGreaterThanOrEqual(1);
    expect(results.mt.nps).toBeGreaterThan(10000);
    expect(results.mt.linesCount).toBe(2);
    expect(results.mt.cachedHit).toBe(true);

    expect(results.st.variant).toBe('single-threaded');
    expect(results.st.name).toBe('Stockfish 17.1 Lite WASM');
    expect(results.st.threads).toBe(1);
    expect(results.st.nps).toBeGreaterThan(10000);

    // Verify mate-in-2 (1. Nf6+ gxf6 2. Bxf7#)
    expect(results.mateIn2.bestMove).toBe('d5f6');
    expect(results.mateIn2.score).toEqual({ type: 'mate', value: 2 });

    // Verify winning the hanging Queen on d4 (1. Nxd4)
    expect(results.hangingPiece.bestMove).toBe('f3d4');
    expect(results.hangingPiece.evalCp).toBeGreaterThan(500);

    // Verify Master bot captures the hanging Queen
    expect(results.botDecision.uci).toBe('f3d4');
    expect(results.botDecision.san).toBe('Nxd4');

    // Verify DevOverlay displays updated engine depth/NPS and cache hit rate (1 hit / 4 cached lookups = 25.0%)
    await expect(devOverlay.locator('[data-metric="engine"]')).not.toHaveText(
      'd0 / 0 kN/s',
    );
    await expect(devOverlay.locator('[data-metric="cache"]')).toHaveText('25.0%');

    if (process.env.SCREENSHOT_DIR) {
      await page.screenshot({
        path: path.join(process.env.SCREENSHOT_DIR, 'phase2-engine.png'),
        fullPage: true,
      });
    }

    expect(externalRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
