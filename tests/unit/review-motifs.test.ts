import { describe, expect, it } from 'vitest';
import motifFixturesJson from '../fixtures/review/motif-fixtures.json';
import type { UciScore } from '../../src/engine/uci-parser';
import {
  detectBackRank,
  detectDiscoveredAttack,
  detectFork,
  detectHangingPiece,
  detectMissedMate,
  detectPinOrSkewer,
  detectPromotionThreat,
  detectTrappedPiece,
} from '../../src/review/motifs';
import type { Motif, MotifKind } from '../../src/review/types';

interface MotifFixture {
  id: string;
  motif: MotifKind;
  fen: string;
  move: string;
  expect: boolean;
  square?: string;
  piece?: string;
  targets?: string[];
  behind?: string;
  bestMove?: string;
  bestScore?: UciScore;
  afterScore?: UciScore;
  mateIn?: number;
}

const fixtures = (motifFixturesJson as unknown as { fixtures: MotifFixture[] }).fixtures;

function detect(f: MotifFixture): Motif | null {
  switch (f.motif) {
    case 'hanging-piece':
      return detectHangingPiece(f.fen, f.move);
    case 'fork':
      return detectFork(f.fen, f.move);
    case 'pin':
    case 'skewer': {
      const m = detectPinOrSkewer(f.fen, f.move);
      return m && m.kind === f.motif ? m : null;
    }
    case 'discovered-attack':
      return detectDiscoveredAttack(f.fen, f.move);
    case 'back-rank':
      return detectBackRank(f.fen, f.move);
    case 'missed-mate':
      return detectMissedMate({
        fenBefore: f.fen,
        uci: f.move,
        bestMoveUci: f.bestMove ?? null,
        bestScore: f.bestScore ?? null,
        afterScore: f.afterScore ?? null,
      });
    case 'trapped-piece':
      return detectTrappedPiece(f.fen, f.move);
    case 'promotion-threat':
      return detectPromotionThreat(f.fen, f.move);
  }
}

const MOTIFS: MotifKind[] = [
  'hanging-piece',
  'fork',
  'pin',
  'skewer',
  'discovered-attack',
  'back-rank',
  'missed-mate',
  'trapped-piece',
  'promotion-threat',
];

describe('Phase 5 — motif detector fixtures', () => {
  it('covers every motif with positive and negative cases', () => {
    for (const kind of MOTIFS) {
      const cases = fixtures.filter((f) => f.motif === kind);
      expect(cases.some((f) => f.expect), `${kind} positive`).toBe(true);
      expect(cases.some((f) => !f.expect), `${kind} negative`).toBe(true);
    }
  });

  for (const f of fixtures) {
    it(`${f.id} (${f.motif}: ${f.expect ? 'yes' : 'no'})`, () => {
      const motif = detect(f);
      if (!f.expect) {
        expect(motif, f.id).toBeNull();
        return;
      }
      expect(motif, f.id).not.toBeNull();
      expect(motif!.kind).toBe(f.motif);
      if (f.square) expect(motif!.square, `${f.id} square`).toBe(f.square);
      if (f.piece) expect(motif!.piece, `${f.id} piece`).toBe(f.piece);
      if (f.targets) expect([...(motif!.targets ?? [])].sort()).toEqual([...f.targets].sort());
      if (f.behind) expect(motif!.targets?.[1], `${f.id} piece behind`).toBe(f.behind);
      if (f.mateIn) expect(motif!.mateIn).toBe(f.mateIn);
    });
  }

  it('reports a piece that was already en prise as preexisting', () => {
    // The rook on d3 is attacked by the bishop and undefended; Kf1 ignores it.
    const motif = detectHangingPiece('4k3/8/8/1b6/8/3R4/8/4K3 w - - 0 1', 'e1f1');
    expect(motif?.square).toBe('d3');
    expect(motif?.preexisting).toBe(true);
    const fresh = detectHangingPiece(
      'r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2PP1N2/PP3PPP/RNBQ1RK1 w - - 0 7',
      'f3d4',
    );
    expect(fresh?.preexisting).toBe(false);
  });
});
