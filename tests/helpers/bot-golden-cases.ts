import { RulesAdapter } from '../../src/core/rules';
import type { EngineLine } from '../../src/engine/cache';
import type { BotStyleId } from '../../src/engine/bot';

/** Deterministic 32-bit PRNG (same one scripts/calibrate-bots.mjs uses). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BotGoldenCase {
  fen: string;
  lines: EngineLine[];
  rating: number;
  style: BotStyleId;
  /** Seed for this case's own random stream. */
  seed: number;
}

const RATINGS = [400, 600, 1000, 1400, 1800, 2200, 2400];
const STYLES: BotStyleId[] = ['solid', 'aggressive', 'gambiteer'];

/** Seed of the single random stream shared by every case in the "shared stream" pass. */
export const SHARED_STREAM_SEED = 424242;

/**
 * 860 bot-selection inputs: positions from seeded random games, each with up to eight
 * synthetic MultiPV lines (descending evals, an occasional forced mate), cycling through
 * every rating band and style. Fully deterministic.
 */
export function buildBotGoldenCases(): BotGoldenCase[] {
  const rnd = mulberry32(20261017);
  const cases: BotGoldenCase[] = [];
  while (cases.length < 860) {
    const adapter = new RulesAdapter();
    for (let ply = 0; ply < 80 && cases.length < 860; ply++) {
      if (adapter.isGameOver()) break;
      const legal = adapter.verboseMoves();
      if (ply % 4 === 3) {
        const turnSign = adapter.turn() === 'w' ? 1 : -1;
        const shuffled = [...legal];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        const lineCount = Math.min(shuffled.length, 2 + Math.floor(rnd() * 7));
        let evalCp = Math.round((rnd() - 0.5) * 600);
        const lines: EngineLine[] = [];
        for (let k = 0; k < lineCount; k++) {
          const isMate = k === 0 && rnd() < 0.04;
          const score = isMate
            ? { type: 'mate' as const, value: 1 + Math.floor(rnd() * 5) }
            : { type: 'cp' as const, value: evalCp };
          lines.push({
            multipv: k + 1,
            depth: 12,
            seldepth: 16,
            score,
            scoreWhite: { type: score.type, value: score.value * turnSign },
            evalCp: isMate ? 10000 - score.value : evalCp,
            nodes: 1000,
            nps: 100000,
            timeMs: 10,
            pv: [shuffled[k]!.uci],
          });
          evalCp -= Math.round(rnd() * 90);
        }
        cases.push({
          fen: adapter.fen(),
          lines,
          rating: RATINGS[cases.length % RATINGS.length]!,
          style: STYLES[Math.floor(cases.length / RATINGS.length) % STYLES.length]!,
          seed: 1000 + cases.length,
        });
      }
      adapter.move(legal[Math.floor(rnd() * legal.length)]!.uci);
    }
  }
  return cases;
}

/** Short stable hash, so the golden file notices if the case generator ever changes. */
export function hashCases(cases: BotGoldenCase[]): string {
  const text = JSON.stringify(cases);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
