import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const stockfishJsPath = path.resolve(
  rootDir,
  'node_modules',
  'stockfish',
  'src',
  'stockfish-17.1-lite-single-03e3232.js',
);

function createNodeStockfishTransport() {
  const proc = spawn(process.execPath, [stockfishJsPath], { stdio: 'pipe' });
  const messageHandlers = [];
  const errorHandlers = [];
  let stdoutBuffer = '';

  const flushLines = (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    let newlineIdx = stdoutBuffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = stdoutBuffer.slice(0, newlineIdx).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      if (line) {
        for (const h of messageHandlers) {
          h(line);
        }
      }
      newlineIdx = stdoutBuffer.indexOf('\n');
    }
  };

  proc.stdout.on('data', flushLines);
  proc.stderr.on('data', flushLines);
  proc.on('error', (err) => {
    for (const h of errorHandlers) {
      h(err);
    }
  });

  return {
    send(command) {
      proc.stdin.write(`${command}\n`);
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onError(handler) {
      errorHandlers.push(handler);
    },
    terminate() {
      proc.kill();
    },
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Diverse opening / early-middlegame starting positions for self-play calibration
 * so every level is tested across open tactical, semi-open, and closed positional structures.
 */
const CALIBRATION_START_POSITIONS = [
  {
    name: 'Italian Giuoco Piano',
    fen: 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
  },
  {
    name: 'Sicilian Open (Najdorf/Scheveningen setup)',
    fen: 'r1bqkb1r/1p2pppp/p1np1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6',
  },
  {
    name: 'Queens Gambit Declined',
    fen: 'rnbqkb1r/ppp2ppp/4pn2/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 2 4',
  },
  {
    name: 'Ruy Lopez Morphy Defense',
    fen: 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4',
  },
  {
    name: 'French Advance / Tactical Center',
    fen: 'r1bqkbnr/pp3ppp/2n1p3/2ppP3/3P4/2P2N2/PP3PPP/RNBQKB1R w KQkq - 1 5',
  },
  {
    name: 'Kings Indian Classical',
    fen: 'rnbq1rk1/ppp1ppbp/3p1np1/8/2PPP3/2N2N2/PP2BPPP/R1BQK2R b KQ - 3 5',
  },
];

/**
 * Target ACPL and Blunder Rate (moves losing >= 100 cp) per level across 400–2400 Elo.
 */
const CALIBRATION_LEVELS = [
  {
    rating: 400,
    label: '400 (Novice Min)',
    refRating: 1000,
    targetAcplMin: 118,
    targetAcplMax: 165,
    targetBlunderMin: 36,
    targetBlunderMax: 48,
  },
  {
    rating: 600,
    label: '600 (Novice)',
    refRating: 1000,
    targetAcplMin: 88,
    targetAcplMax: 122,
    targetBlunderMin: 26,
    targetBlunderMax: 36,
  },
  {
    rating: 1000,
    label: '1000 (Casual)',
    refRating: 1400,
    targetAcplMin: 55,
    targetAcplMax: 85,
    targetBlunderMin: 18,
    targetBlunderMax: 30,
  },
  {
    rating: 1400,
    label: '1400 (Club)',
    refRating: 1400,
    targetAcplMin: 26,
    targetAcplMax: 48,
    targetBlunderMin: 7,
    targetBlunderMax: 15,
  },
  {
    rating: 1800,
    label: '1800 (Expert)',
    refRating: 1800,
    targetAcplMin: 15,
    targetAcplMax: 26,
    targetBlunderMin: 2.5,
    targetBlunderMax: 8,
  },
  {
    rating: 2200,
    label: '2200 (Master)',
    refRating: 1800,
    targetAcplMin: 9,
    targetAcplMax: 16,
    targetBlunderMin: 0,
    targetBlunderMax: 3.5,
  },
  {
    rating: 2400,
    label: '2400 (Master Max)',
    refRating: 2200,
    targetAcplMin: 0,
    targetAcplMax: 10,
    targetBlunderMin: 0,
    targetBlunderMax: 2.0,
  },
];

async function runCalibration() {
  const startedAt = performance.now();
  const vite = await createServer({
    root: rootDir,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });

  const { RulesAdapter } = await vite.ssrLoadModule('/src/core/rules.ts');
  const { EngineClient } = await vite.ssrLoadModule('/src/engine/engine-client.ts');
  const { ChessBot, computeBotEngineParams } = await vite.ssrLoadModule('/src/engine/bot.ts');

  // Three isolated Stockfish worker processes:
  // 1. Tested Bot Engine (isolated)
  // 2. Reference Opponent Bot Engine (isolated)
  // 3. Full-Strength Reference Oracle Engine (Skill 20, UCI_LimitStrength false)
  const testedEngine = new EngineClient({
    variant: 'single-threaded',
    hashMb: 16,
    transportFactory: () => createNodeStockfishTransport(),
  });
  const refBotEngine = new EngineClient({
    variant: 'single-threaded',
    hashMb: 16,
    transportFactory: () => createNodeStockfishTransport(),
  });
  const oracleEngine = new EngineClient({
    variant: 'single-threaded',
    hashMb: 32,
    transportFactory: () => createNodeStockfishTransport(),
  });

  await Promise.all([testedEngine.init(), refBotEngine.init(), oracleEngine.init()]);

  const oracleCache = new Map();
  async function evaluatePositionOracle(fen) {
    const key = fen.split(/\s+/).slice(0, 4).join(' ');
    if (oracleCache.has(key)) {
      return oracleCache.get(key);
    }
    const res = await oracleEngine.analyze({
      fen,
      nodes: 12000,
      depth: 10,
      multipv: 1,
      skillLevel: 20,
      uciLimitStrength: false,
      useCache: true,
    });
    const bestEvalCp = res.lines[0]?.evalCp ?? 0;
    const bestMove = res.bestMove ?? res.lines[0]?.pv[0] ?? null;
    const entry = { bestEvalCp, bestMove };
    oracleCache.set(key, entry);
    return entry;
  }

  console.log('\n========================================================================================');
  console.log(' Wizard Chess — Bot Strength Self-Play Calibration (400–2400 Elo vs Reference Levels)');
  console.log('========================================================================================\n');

  const summaryRows = [];
  let allPassed = true;

  try {
    for (const cfg of CALIBRATION_LEVELS) {
      const rng = mulberry32(104729 + cfg.rating * 31);
      const refRng = mulberry32(209951 + cfg.rating * 17);

      const testedBot = new ChessBot(testedEngine, {
        rating: cfg.rating,
        style: 'solid',
        rng,
      });
      const refBot = new ChessBot(refBotEngine, {
        rating: cfg.refRating,
        style: 'solid',
        rng: refRng,
      });

      const params = computeBotEngineParams(cfg.rating, 'solid');
      const cpLosses = [];
      let blunderCount = 0; // cpLoss >= 100 cp
      let mistakeOrBlunderCount = 0; // cpLoss >= 60 cp
      let humanBlunderChosenCount = 0;
      let gamesPlayed = 0;
      let matchScore = 0;

      // Play 6 self-play games per level (alternating White and Black across the 6 positions, 18 plies per game)
      for (let g = 0; g < CALIBRATION_START_POSITIONS.length; g++) {
        const startPos = CALIBRATION_START_POSITIONS[g];
        const testedColor = g % 2 === 0 ? 'w' : 'b';
        const adapter = new RulesAdapter(startPos.fen);
        gamesPlayed++;

        const maxPlies = 18;
        for (let ply = 0; ply < maxPlies; ply++) {
          if (adapter.isGameOver()) break;
          const turn = adapter.turn();
          const currentFen = adapter.fen();

          if (turn === testedColor) {
            const legalCount = adapter.verboseMoves().length;
            const beforeOracle = await evaluatePositionOracle(currentFen);

            const decision = await testedBot.chooseMove(currentFen, { rng });
            const chosenCand = decision.candidates.find((c) => c.uci === decision.uci);
            if (chosenCand?.isHumanBlunder) {
              humanBlunderChosenCount++;
            }

            const moved = adapter.move(decision.uci);

            // Measure centipawn loss in undecided positions with >= 2 legal moves
            if (legalCount >= 2 && Math.abs(beforeOracle.bestEvalCp) <= 650) {
              let cpLoss = 0;
              if (beforeOracle.bestMove && moved.uci === beforeOracle.bestMove) {
                cpLoss = 0;
              } else if (adapter.isCheckmate()) {
                cpLoss = 0;
              } else {
                const afterOracle = await evaluatePositionOracle(adapter.fen());
                const playedEvalCp = -afterOracle.bestEvalCp;
                cpLoss = Math.min(420, Math.max(0, beforeOracle.bestEvalCp - playedEvalCp));
              }

              cpLosses.push(cpLoss);
              if (cpLoss >= 100) blunderCount++;
              if (cpLoss >= 60) mistakeOrBlunderCount++;
            }
          } else {
            const refDecision = await refBot.chooseMove(currentFen, {
              rng: refRng,
            });
            adapter.move(refDecision.uci);
          }
        }

        // Estimate game outcome from final position eval
        const finalOracle = await evaluatePositionOracle(adapter.fen());
        const finalTestedCp = adapter.turn() === testedColor ? finalOracle.bestEvalCp : -finalOracle.bestEvalCp;
        if (finalTestedCp > 120) matchScore += 1;
        else if (finalTestedCp < -120) matchScore += 0;
        else matchScore += 0.5;
      }

      const movesEvaluated = cpLosses.length || 1;
      const acpl = cpLosses.reduce((sum, x) => sum + x, 0) / movesEvaluated;
      const blunderRatePct = (blunderCount / movesEvaluated) * 100;
      const mistakePlusBlunderPct = (mistakeOrBlunderCount / movesEvaluated) * 100;

      const acplOk = acpl >= cfg.targetAcplMin && acpl <= cfg.targetAcplMax;
      const blunderOk = blunderRatePct >= cfg.targetBlunderMin && blunderRatePct <= cfg.targetBlunderMax;
      const levelPassed = acplOk && blunderOk;
      if (!levelPassed) allPassed = false;

      const row = {
        rating: cfg.rating,
        label: cfg.label,
        refRating: cfg.refRating,
        nodes: params.nodes,
        multipv: params.multipv,
        skillLevel: params.skillLevel,
        uciLimitStrength: params.uciLimitStrength,
        temperatureCp: params.temperatureCp,
        blunderChancePct: Number((params.blunderChance * 100).toFixed(1)),
        movesEvaluated,
        acpl: Number(acpl.toFixed(1)),
        targetAcpl: `${cfg.targetAcplMin}–${cfg.targetAcplMax}`,
        blunderRatePct: Number(blunderRatePct.toFixed(1)),
        targetBlunderPct: `${cfg.targetBlunderMin}%–${cfg.targetBlunderMax}%`,
        mistakePlusBlunderPct: Number(mistakePlusBlunderPct.toFixed(1)),
        humanBlunderChosenCount,
        matchScore: `${matchScore.toFixed(1)}/${gamesPlayed}`,
        status: levelPassed ? 'PASS' : 'TUNE',
      };
      summaryRows.push(row);

      console.log(
        `[${row.status}] ${row.label.padEnd(18)} | ACPL: ${String(row.acpl).padStart(5)} cp (target ${row.targetAcpl.padEnd(7)}) | Blunders (>=100cp): ${String(row.blunderRatePct + '%').padStart(5)} (target ${row.targetBlunderPct.padEnd(9)}) | Score vs ${row.refRating}: ${row.matchScore} | Moves: ${row.movesEvaluated}`,
      );
    }

    // Verify strict monotonic decrease in ACPL and Blunder Rate from 400 to 2400
    let monotonic = true;
    for (let i = 1; i < summaryRows.length; i++) {
      const prev = summaryRows[i - 1];
      const curr = summaryRows[i];
      if (curr.acpl >= prev.acpl) {
        console.error(
          `Monotonicity check failed: ${curr.label} ACPL (${curr.acpl}) >= ${prev.label} ACPL (${prev.acpl})`,
        );
        monotonic = false;
      }
      if (curr.blunderRatePct > prev.blunderRatePct) {
        console.error(
          `Monotonicity check failed: ${curr.label} Blunder% (${curr.blunderRatePct}%) > ${prev.label} Blunder% (${prev.blunderRatePct}%)`,
        );
        monotonic = false;
      }
    }

    const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `\nCalibration finished in ${elapsedSec}s. Monotonic progression: ${monotonic ? 'PASS' : 'FAIL'}. Overall: ${allPassed && monotonic ? 'PASS' : 'NEEDS TUNING'}\n`,
    );
    console.log(JSON.stringify(summaryRows, null, 2));

    if (!allPassed || !monotonic) {
      process.exitCode = 1;
    }
  } finally {
    testedEngine.terminate();
    refBotEngine.terminate();
    oracleEngine.terminate();
    await vite.close();
  }
}

runCalibration().catch((err) => {
  console.error('Bot calibration failed:', err);
  process.exit(1);
});
