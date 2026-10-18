import fixturesJson from '../fixtures/review/classification-fixtures.json';
import evalsJson from '../fixtures/review/classification-evals.json';
import { lookupOpeningByFen } from '../../src/analysis/opening-lookup';
import type { MoveClassification } from '../../src/core/game-tree';
import type { ClassifyInput } from '../../src/review/classification';
import type { PositionAnalysis, ReviewLine, TerminalKind } from '../../src/review/types';

export interface ClassificationFixture {
  id: string;
  startFen: string;
  moves: string[];
  expected: MoveClassification;
  rationale: string;
  explanation?: string;
  explanationPrefix?: string;
}

interface RecordedPosition {
  ply: number;
  fen: string;
  terminal?: TerminalKind;
  depth: number;
  lines: ReviewLine[];
}

interface RecordedLine {
  key: string;
  positions: RecordedPosition[];
}

const spec = fixturesJson as unknown as {
  positions: Record<string, string>;
  fixtures: ClassificationFixture[];
};
const evals = evalsJson as unknown as {
  depth: number;
  lines: Record<string, RecordedLine>;
};

export const classificationFixtures: ClassificationFixture[] = spec.fixtures;
export const recordedDepth = evals.depth;

export function resolveStartFen(fixture: ClassificationFixture): string {
  return spec.positions[fixture.startFen] ?? fixture.startFen;
}

export function recordedLine(fixture: ClassificationFixture): RecordedLine | undefined {
  return evals.lines[fixture.id];
}

function toAnalysis(p: RecordedPosition): PositionAnalysis {
  return {
    fen: p.fen,
    ...(p.terminal ? { terminal: p.terminal } : {}),
    lines: p.lines,
    depth: p.depth,
  };
}

export function isBookFen(fen: string): boolean {
  return lookupOpeningByFen(fen) !== null;
}

/** The classifier input for a fixture's last move, built from the recorded engine results. */
export function classifyInputFor(fixture: ClassificationFixture): ClassifyInput {
  const line = recordedLine(fixture);
  if (!line) throw new Error(`No recorded evals for ${fixture.id}; run npm run fixtures:review`);
  const n = fixture.moves.length;
  const at = (ply: number) => {
    const p = line.positions.find((x) => x.ply === ply);
    if (!p) throw new Error(`${fixture.id}: ply ${ply} not recorded`);
    return p;
  };
  const before = at(n - 1);
  const after = at(n);
  const previous =
    n >= 2
      ? {
          fenBefore: at(n - 2).fen,
          uci: fixture.moves[n - 2]!,
          before: toAnalysis(at(n - 2)),
        }
      : null;
  return {
    fenBefore: before.fen,
    uci: fixture.moves[n - 1]!,
    before: toAnalysis(before),
    after: toAnalysis(after),
    previous,
    isBook: isBookFen(after.fen),
  };
}
