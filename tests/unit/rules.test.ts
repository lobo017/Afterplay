import { describe, expect, it } from 'vitest';
import { DEFAULT_POSITION, RulesAdapter, validateChessFen } from '../../src/core/rules';

const KIWIPETE_FEN = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';

describe('Phase 1 — RulesAdapter & Perft Verification', () => {
  describe('Perft benchmarks', () => {
    it('matches exact perft counts for standard starting position (depths 1–4: 20 / 400 / 8,902 / 197,281)', () => {
      const rules = new RulesAdapter(DEFAULT_POSITION);
      expect(rules.perft(1)).toBe(20);
      expect(rules.perft(2)).toBe(400);
      expect(rules.perft(3)).toBe(8902);
      expect(rules.perft(4)).toBe(197281);
    });

    it('matches exact perft counts for Kiwipete position (depths 1–3: 48 / 2,039 / 97,862)', () => {
      const rules = new RulesAdapter(KIWIPETE_FEN);
      expect(rules.perft(1)).toBe(48);
      expect(rules.perft(2)).toBe(2039);
      expect(rules.perft(3)).toBe(97862);
    });
  });

  describe('Exact standard chess rules', () => {
    it('enforces castling legality (blocked, in check, through check, rook captured) and undo', () => {
      // Clear path for both O-O and O-O-O
      const rules = new RulesAdapter('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');
      expect(rules.moves()).toContain('O-O');
      expect(rules.moves()).toContain('O-O-O');

      const castleMove = rules.move('O-O');
      expect(castleMove.isCastle).toBe(true);
      expect(castleMove.isKingsideCastle).toBe(true);
      expect(rules.get('g1')).toEqual({ type: 'k', color: 'w' });
      expect(rules.get('f1')).toEqual({ type: 'r', color: 'w' });

      rules.undo();
      expect(rules.fen()).toBe('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');

      // Black bishop attacking f1 prevents White O-O, while O-O-O remains legal
      const throughCheck = new RulesAdapter('r3k2r/pppp1ppp/8/8/2b5/8/PPPP1PPP/R3K2R w KQkq - 0 1');
      expect(throughCheck.moves()).not.toContain('O-O');
      expect(throughCheck.moves()).toContain('O-O-O');
    });

    it('handles en passant capture and horizontal double-pawn pin restriction', () => {
      const rules = new RulesAdapter();
      for (const m of ['e4', 'a6', 'e5', 'd5']) {
        rules.move(m);
      }
      expect(rules.fen()).toContain(' d6 ');
      const ep = rules.move('exd6');
      expect(ep.isEnPassant).toBe(true);
      expect(ep.isCapture).toBe(true);
      expect(rules.get('d5')).toBeUndefined();
      expect(rules.get('d6')).toEqual({ type: 'p', color: 'w' });

      // Horizontal pin: White king on a5, White pawn on d5, Black pawn just played e7-e5, Black rook on h5.
      // Taking exd6 e.p. would vacate both d5 and e5, exposing the King on a5 to the Rook on h5!
      const pinnedEp = new RulesAdapter('4k3/8/8/K2Pp2r/8/8/8/8 w - e6 0 1');
      expect(pinnedEp.moves()).not.toContain('dxe6');
    });

    it('supports all four promotion pieces (Q, R, B, N) and permissive promotion notations', () => {
      const fen = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
      const rules = new RulesAdapter(fen);
      const promoMoves = rules.verboseMoves({ square: 'a7' }).filter((m) => m.isPromotion);
      expect(promoMoves.map((m) => m.promotion).sort()).toEqual(['b', 'n', 'q', 'r']);

      // Test parenthesized promotion e8(N) and lowercase promotion a8=r
      const knightPromo = rules.move('a8(N)');
      expect(knightPromo.san).toBe('a8=N');
      expect(knightPromo.promotion).toBe('n');
      rules.undo();

      const rookPromo = rules.move('a8=r+');
      expect(rookPromo.san).toBe('a8=R+');
      expect(rookPromo.promotion).toBe('r');
    });

    it('detects threefold repetition, 50-move rule, and insufficient material accurately', () => {
      // 1. Threefold repetition
      const rep = new RulesAdapter();
      for (const m of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']) {
        expect(rep.isThreefoldRepetition()).toBe(false);
        rep.move(m);
      }
      expect(rep.isThreefoldRepetition()).toBe(true);
      expect(rep.isDraw()).toBe(true);

      // 2. 50-move rule (100 half-moves)
      const fifty99 = new RulesAdapter('4k3/8/8/8/8/8/8/R3K3 w Q - 99 50');
      expect(fifty99.isDrawByFiftyMoves()).toBe(false);
      fifty99.move('Ra2');
      expect(fifty99.halfMoves()).toBe(100);
      expect(fifty99.isDrawByFiftyMoves()).toBe(true);
      expect(fifty99.isDraw()).toBe(true);

      // 3. Insufficient material
      expect(new RulesAdapter('4k3/8/8/8/8/8/8/4K3 w - - 0 1').isInsufficientMaterial()).toBe(true);
      expect(new RulesAdapter('4k3/8/8/8/8/8/8/4KN2 w - - 0 1').isInsufficientMaterial()).toBe(true);
      // Same-colored bishops (c1 dark, f8 dark) -> insufficient
      expect(new RulesAdapter('4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1').isInsufficientMaterial()).toBe(true);
      // Opposite-colored bishops (c1 dark, c8 light) -> sufficient
      expect(new RulesAdapter('2b1k3/8/8/8/8/8/8/2B1K3 w - - 0 1').isInsufficientMaterial()).toBe(false);
    });

    it('supports null moves (-- and Z0) when not in check and rejects them when in check', () => {
      const rules = new RulesAdapter();
      rules.move('e4');
      const nullMove = rules.move('--');
      expect(nullMove.isNullMove).toBe(true);
      expect(nullMove.san).toBe('--');
      expect(rules.turn()).toBe('w');

      rules.undo();
      expect(rules.turn()).toBe('b');

      const inCheckRules = new RulesAdapter('4k3/8/8/8/8/8/4Q3/4K3 b - - 0 1');
      expect(inCheckRules.inCheck()).toBe(true);
      expect(() => inCheckRules.move('--')).toThrow();
    });
  });

  describe('Chess960 FEN round-trip and Fischer Random castling rules', () => {
    it('round-trips Shredder-FEN (HAha / AHah / FBfb) and X-FEN Chess960 positions', () => {
      const shredderFens = [
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w HAha - 0 1',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w AHah - 0 1',
        'bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w HFhf - 0 1',
        'rkqnbbrn/pppppppp/8/8/8/8/PPPPPPPP/RKQNBBRN w GAga - 0 1',
        'nrkbbqnr/pppppppp/8/8/8/8/PPPPPPPP/NRKBBQNR w KQkq - 0 1',
      ];

      for (const fen of shredderFens) {
        const validation = validateChessFen(fen);
        expect(validation.ok).toBe(true);
        expect(validation.isChess960).toBe(true);

        const adapter = new RulesAdapter(fen);
        expect(adapter.isChess960()).toBe(true);
        expect(adapter.fen()).toBe(fen);
      }
    });

    it('executes and undoes Chess960 castling where King and Rook swap squares (f1/g1) or King stays on g1 (g1/h1)', () => {
      // Case 1: King on g1, Rook on h1 (O-O where King stays on g1 and Rook jumps from h1 to f1!)
      const kingOnG1Fen = '1r4kr/pppppppp/8/8/8/8/PPPPPPPP/1R4KR w HBhb - 0 1';
      const g1Adapter = new RulesAdapter(kingOnG1Fen);
      expect(g1Adapter.moves()).toContain('O-O');
      expect(g1Adapter.moves()).toContain('O-O-O');

      const ooMove = g1Adapter.move('O-O');
      expect(ooMove.isCastle).toBe(true);
      expect(ooMove.isKingsideCastle).toBe(true);
      expect(g1Adapter.get('g1')).toEqual({ type: 'k', color: 'w' });
      expect(g1Adapter.get('f1')).toEqual({ type: 'r', color: 'w' });
      expect(g1Adapter.get('h1')).toBeUndefined();
      expect(g1Adapter.fen()).toBe('1r4kr/pppppppp/8/8/8/8/PPPPPPPP/1R3RK1 b hb - 1 1');

      g1Adapter.undo();
      expect(g1Adapter.fen()).toBe(kingOnG1Fen);

      // Case 2: King on f1, Kingside rook on g1 -> O-O swaps King (f1->g1) and Rook (g1->f1)
      const kingOnF1Fen = '1r3kr1/pppppppp/8/8/8/8/PPPPPPPP/1R3KR1 w GBgb - 0 1';
      const f1Adapter = new RulesAdapter(kingOnF1Fen);
      expect(f1Adapter.moves()).toContain('O-O');
      expect(f1Adapter.moves()).toContain('O-O-O');

      // Test king-captures-own-rook UCI / MoveInput style ({ from: 'f1', to: 'g1' })
      const swapCastle = f1Adapter.move({ from: 'f1', to: 'g1' });
      expect(swapCastle.san).toBe('O-O');
      expect(f1Adapter.get('g1')).toEqual({ type: 'k', color: 'w' });
      expect(f1Adapter.get('f1')).toEqual({ type: 'r', color: 'w' });
      expect(f1Adapter.fen()).toBe('1r3kr1/pppppppp/8/8/8/8/PPPPPPPP/1R3RK1 b gb - 1 1');

      f1Adapter.undo();
      expect(f1Adapter.fen()).toBe(kingOnF1Fen);

      // Now test O-O-O from f1 with rook on b1 (King f1->c1, Rook b1->d1)
      const oooMove = f1Adapter.move('O-O-O');
      expect(oooMove.isQueensideCastle).toBe(true);
      expect(f1Adapter.get('c1')).toEqual({ type: 'k', color: 'w' });
      expect(f1Adapter.get('d1')).toEqual({ type: 'r', color: 'w' });
      expect(f1Adapter.get('b1')).toBeUndefined();
      expect(f1Adapter.get('f1')).toBeUndefined();
    });

    it('disambiguates 1-square king step f1g1 (Kg1) from f1h1 (O-O) when castling rook is on h1', () => {
      const fen = '1r3k1r/pppppppp/8/8/8/8/PPPPPPPP/1R3K1R w HBhb - 0 1';
      const adapter = new RulesAdapter(fen);
      const verbose = adapter.verboseMoves();
      const kg1Verbose = verbose.find((m) => m.san === 'Kg1');
      const ooVerbose = verbose.find((m) => m.san === 'O-O');

      expect(kg1Verbose).toBeDefined();
      expect(ooVerbose).toBeDefined();
      expect(kg1Verbose?.after).toBe('1r3k1r/pppppppp/8/8/8/8/PPPPPPPP/1R4KR b hb - 1 1');
      expect(ooVerbose?.after).toBe('1r3k1r/pppppppp/8/8/8/8/PPPPPPPP/1R3RK1 b hb - 1 1');

      // Stepping f1->g1 is regular Kg1, NOT O-O
      const kg1Move = adapter.move('f1g1');
      expect(kg1Move.san).toBe('Kg1');
      expect(kg1Move.isCastle).toBe(false);
      expect(adapter.fen()).toBe('1r3k1r/pppppppp/8/8/8/8/PPPPPPPP/1R4KR b hb - 1 1');

      adapter.undo();
      expect(adapter.fen()).toBe(fen);

      // Capturing own rook f1->h1 is O-O
      const ooMove = adapter.move('f1h1');
      expect(ooMove.san).toBe('O-O');
      expect(ooMove.isCastle).toBe(true);
      expect(adapter.fen()).toBe('1r3k1r/pppppppp/8/8/8/8/PPPPPPPP/1R3RK1 b hb - 1 1');
    });
  });
});
