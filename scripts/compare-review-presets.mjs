// Compares review classifications at the Quick preset with the depth-18 fixture settings.
//
//   npm run review:compare
//
// Reviews each game with the single-threaded Stockfish build (the spec's review-speed
// baseline is one thread), MultiPV 2, 32 MB hash, `ucinewgame` before each review:
//   - reference: fixed depth 18 (the settings behind tests/fixtures/review), run once;
//     a fixed depth on one thread is reproducible
//   - Quick: 0.2 s per position, run REVIEW_COMPARE_QUICK_RUNS times (default 3), since
//     a time limit makes every run a little different
// and reports, per class, how often the Quick label matches the reference label. Writes
// the full per-move data to test-results/review-compare/<time>.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createNodeStockfishTransport } from './lib/node-stockfish.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUICK_RUNS = Number(process.env.REVIEW_COMPARE_QUICK_RUNS ?? 3);
const REFERENCE_DEPTH = 18;
const HASH_MB = 32;

// Fischer–Spassky, Reykjavik 1972, game 6: a second, longer game (81 plies) so the
// per-class numbers rest on more than the sample game's 33 moves.
const FISCHER_SPASSKY_1972_G6 = `[Event "World Championship"]
[White "Fischer, Robert James"]
[Black "Spassky, Boris V"]
[Result "1-0"]

1. c4 e6 2. Nf3 d5 3. d4 Nf6 4. Nc3 Be7 5. Bg5 O-O 6. e3 h6 7. Bh4 b6 8. cxd5
Nxd5 9. Bxe7 Qxe7 10. Nxd5 exd5 11. Rc1 Be6 12. Qa4 c5 13. Qa3 Rc8 14. Bb5 a6
15. dxc5 bxc5 16. O-O Ra7 17. Be2 Nd7 18. Nd4 Qf8 19. Nxe6 fxe6 20. e4 d4 21. f4
Qe7 22. e5 Rb8 23. Bc4 Kh8 24. Qh3 Nf8 25. b3 a5 26. f5 exf5 27. Rxf5 Nh7 28.
Rcf1 Qd8 29. Qg3 Re7 30. h4 Rbb7 31. e6 Rbc7 32. Qe5 Qe8 33. a4 Qd8 34. R1f2
Qe8 35. R2f3 Qd8 36. Bd3 Qe8 37. Qe4 Nf6 38. Rxf6 gxf6 39. Rxf6 Kg8 40. Bc4 Kh8
41. Qf4 1-0`;

async function main() {
  const vite = await createServer({
    root: rootDir,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  const { parsePgn } = await vite.ssrLoadModule('/src/core/pgn.ts');
  const { EngineClient } = await vite.ssrLoadModule('/src/engine/engine-client.ts');
  const { ReviewRunner } = await vite.ssrLoadModule('/src/review/review-runner.ts');
  const { ALL_CLASSIFICATIONS } = await vite.ssrLoadModule('/src/review/review-game.ts');
  const { SAMPLE_GAME_PGN } = await vite.ssrLoadModule('/src/review/sample-game.ts');
  const { lookupOpeningByFen } = await vite.ssrLoadModule('/src/analysis/opening-lookup.ts');

  const engine = new EngineClient({
    variant: 'single-threaded',
    hashMb: HASH_MB,
    transportFactory: () => createNodeStockfishTransport(),
  });
  await engine.init();
  const runner = new ReviewRunner(engine);
  const isBookPosition = (fen) => lookupOpeningByFen(fen) !== null;

  const games = [
    { id: 'sample', name: 'Morphy vs. Duke Karl / Count Isouard, Paris 1858 (sample game)', pgn: SAMPLE_GAME_PGN },
    { id: 'fischer-spassky-g6', name: 'Fischer vs. Spassky, Reykjavik 1972, game 6', pgn: FISCHER_SPASSKY_1972_G6 },
  ];

  const out = {
    engine: '',
    settings: { referenceDepth: REFERENCE_DEPTH, quickMovetimeMs: 200, quickRuns: QUICK_RUNS, multipv: 2, hashMb: HASH_MB, threads: 1 },
    games: [],
  };

  try {
    for (const game of games) {
      const run = async (label, options) => {
        const startedAt = performance.now();
        const result = await runner.run({ tree: parsePgn(game.pgn), isBookPosition, ...options });
        const s = result.stats;
        console.log(
          `${game.id.padEnd(20)} ${label.padEnd(10)} ${result.review.moves.length} moves in ${((performance.now() - startedAt) / 1000).toFixed(1)} s, depth mean ${s.meanDepth.toFixed(1)} min ${s.minDepth}, verified ${s.verifiedPositions}, accuracy W ${result.review.white.accuracy?.toFixed(1)} B ${result.review.black.accuracy?.toFixed(1)}`,
        );
        return result;
      };
      const reference = await run(`depth ${REFERENCE_DEPTH}`, { budget: { depth: REFERENCE_DEPTH } });
      const quick = [];
      for (let i = 0; i < QUICK_RUNS; i++) quick.push(await run(`quick #${i + 1}`, { preset: 'quick' }));

      const moves = reference.review.moves.map((m, i) => ({
        ply: m.ply,
        san: m.san,
        reference: m.classification,
        referenceWinDrop: Number(m.winDrop.toFixed(2)),
        quick: quick.map((q) => q.review.moves[i].classification),
        quickWinDrop: quick.map((q) => Number(q.review.moves[i].winDrop.toFixed(2))),
      }));

      const perClass = {};
      for (const c of ALL_CLASSIFICATIONS) {
        const refMoves = moves.filter((m) => m.reference === c);
        const refLabels = refMoves.length * QUICK_RUNS;
        const refAgree = refMoves.reduce((a, m) => a + m.quick.filter((q) => q === c).length, 0);
        const quickLabels = moves.reduce((a, m) => a + m.quick.filter((q) => q === c).length, 0);
        perClass[c] = { referenceMoves: refMoves.length, refLabels, refAgree, quickLabels };
      }
      const totalAgree = moves.reduce((a, m) => a + m.quick.filter((q) => q === m.reference).length, 0);
      out.games.push({
        id: game.id,
        name: game.name,
        plies: moves.length,
        reference: {
          accuracy: { w: reference.review.white.accuracy, b: reference.review.black.accuracy },
          stats: reference.stats,
        },
        quick: quick.map((q) => ({
          accuracy: { w: q.review.white.accuracy, b: q.review.black.accuracy },
          stats: q.stats,
        })),
        agreement: { agree: totalAgree, labels: moves.length * QUICK_RUNS },
        perClass,
        moves,
      });
    }
    out.engine = engine.getEngineName();
  } finally {
    engine.terminate();
    await vite.close();
  }

  // Report: per class over both games, then per game
  const classes = out.games[0] ? Object.keys(out.games[0].perClass) : [];
  const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(0)}%` : '—');
  const table = (rows) => {
    console.log('| Class (depth 18) | Moves | Quick labels that agree | Quick labels of this class | of which depth 18 agrees |');
    console.log('|---|---|---|---|---|');
    for (const c of classes) {
      const r = rows(c);
      console.log(
        `| ${c} | ${r.referenceMoves} | ${r.refAgree}/${r.refLabels} (${pct(r.refAgree, r.refLabels)}) | ${r.quickLabels} | ${pct(r.precisionAgree, r.quickLabels)} |`,
      );
    }
  };
  const precisionAgree = (g, c) =>
    g.moves.reduce((a, m) => a + m.quick.filter((q) => q === c && m.reference === c).length, 0);
  for (const g of out.games) {
    console.log(`\n### ${g.name}: overall ${g.agreement.agree}/${g.agreement.labels} (${pct(g.agreement.agree, g.agreement.labels)})`);
    table((c) => ({ ...g.perClass[c], precisionAgree: precisionAgree(g, c) }));
    console.log('\nMoves where any Quick run differs from depth 18:');
    for (const m of g.moves.filter((x) => x.quick.some((q) => q !== x.reference))) {
      console.log(`  ply ${m.ply} ${m.san}: depth 18 ${m.reference} (drop ${m.referenceWinDrop}) · Quick ${m.quick.join(' / ')} (drops ${m.quickWinDrop.join(' / ')})`);
    }
  }
  console.log('\n### Both games');
  table((c) => {
    const sum = { referenceMoves: 0, refLabels: 0, refAgree: 0, quickLabels: 0, precisionAgree: 0 };
    for (const g of out.games) {
      for (const k of ['referenceMoves', 'refLabels', 'refAgree', 'quickLabels']) sum[k] += g.perClass[c][k];
      sum.precisionAgree += precisionAgree(g, c);
    }
    return sum;
  });

  const dir = path.join(rootDir, 'test-results', 'review-compare');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`\nWrote ${path.relative(rootDir, file)}`);
}

main().catch((err) => {
  console.error('Review comparison failed:', err);
  process.exit(1);
});
