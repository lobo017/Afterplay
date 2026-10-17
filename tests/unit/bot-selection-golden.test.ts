import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { selectHumanLikeMove } from '../../src/engine/bot';
import { BotSelectionClient } from '../../src/engine/bot-selection-client';
import {
  SHARED_STREAM_SEED,
  buildBotGoldenCases,
  hashCases,
  mulberry32,
} from '../helpers/bot-golden-cases';

const golden = JSON.parse(
  fs.readFileSync('tests/fixtures/bot-selection-golden.json', 'utf8'),
) as {
  generatedFrom: string;
  caseCount: number;
  casesHash: string;
  independent: string[];
  sharedStream: string[];
};

const cases = buildBotGoldenCases();
const request = (c: (typeof cases)[number]) => ({
  fen: c.fen,
  lines: c.lines,
  ratingOrTier: c.rating,
  style: c.style,
});

describe('Phase 3 — bot move selection matches the original implementation', () => {
  it('uses the same 860 cases the golden moves were generated from', () => {
    expect(cases).toHaveLength(golden.caseCount);
    expect(hashCases(cases)).toBe(golden.casesHash);
    expect(golden.generatedFrom).toBe('02865aa');
  });

  it('selectHumanLikeMove gives the golden move for every case and seed', () => {
    const independent = cases.map(
      (c) => selectHumanLikeMove({ ...request(c), rng: mulberry32(c.seed) }).uci,
    );
    expect(independent).toEqual(golden.independent);
    const shared = mulberry32(SHARED_STREAM_SEED);
    const sharedStream = cases.map(
      (c) => selectHumanLikeMove({ ...request(c), rng: shared }).uci,
    );
    expect(sharedStream).toEqual(golden.sharedStream);
  }, 120_000);

  it('BotSelectionClient (inline fallback, as in Node) consumes a shared rng stream exactly the same', async () => {
    const client = new BotSelectionClient({ useWorker: false });
    const shared = mulberry32(SHARED_STREAM_SEED);
    const sharedStream: string[] = [];
    for (const c of cases) {
      sharedStream.push((await client.select(request(c), shared)).uci);
    }
    expect(sharedStream).toEqual(golden.sharedStream);
    expect(client.getStats()).toEqual({ worker: 0, inline: 860, workerActive: false });
  }, 120_000);
});
