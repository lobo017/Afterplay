import { describe, expect, it } from 'vitest';
import type { EndgamePositionEntry } from '../../src/core/datasets';
import {
  DECISIVE_CP,
  DRAW_AGREE_CP,
  EndgameSession,
  HOLD_MIN_MOVES,
  WARN_BELOW_CP,
  WARN_HOLD_CP,
} from '../../src/trainers/endgame-session';
import { ENDGAMES, GOOD_EXTRA_MOVES, endgameGoal, endgamePlayer, getEndgame, gradeEndgame, goalText } from '../../src/trainers/endgames';

function entry(partial: Partial<EndgamePositionEntry> & Pick<EndgamePositionEntry, 'fen'>): EndgamePositionEntry {
  return {
    id: 'test',
    title: 'Test',
    category: 'test',
    sideToMove: partial.fen.split(' ')[1] === 'b' ? 'b' : 'w',
    targetResult: '1-0',
    optimalMoves: null,
    description: '',
    ...partial,
  };
}

const move = (uci: string) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci.length > 4 ? { promotion: uci[4]! } : {}) });

describe('Phase 7 — the endgame drills', () => {
  it('the six positions: how each one ends, and who plays', () => {
    expect(ENDGAMES.map((e) => [e.id, endgameGoal(e), endgamePlayer(e)])).toEqual([
      ['kq-vs-k', 'mate', 'w'],
      ['kr-vs-k', 'mate', 'w'],
      ['kp-opposition', 'mate', 'w'],
      ['lucena-position', 'convert', 'w'],
      ['philidor-position', 'hold', 'b'],
      ['rp-vs-r', 'convert', 'w'],
    ]);
    expect(getEndgame('kq-vs-k')?.optimalMoves).toBe(7);
    expect(getEndgame('nope')).toBeUndefined();
    expect(goalText(getEndgame('kq-vs-k')!)).toContain('7 moves');
    expect(goalText(getEndgame('philidor-position')!)).toContain('draw');
  });

  it('grades a drill: a miss is Again, a hint is at most Hard, and a mate is Easy at the best count', () => {
    const mate = { targetResult: '1-0' as const, optimalMoves: 7 };
    const open = { targetResult: '1-0' as const, optimalMoves: null };
    expect(gradeEndgame(mate, { reached: false, moves: 30, hintsUsed: 0 })).toBe(1);
    expect(gradeEndgame(mate, { reached: true, moves: 7, hintsUsed: 1 })).toBe(2);
    expect(gradeEndgame(mate, { reached: true, moves: 7, hintsUsed: 0 })).toBe(4);
    expect(gradeEndgame(mate, { reached: true, moves: 5, hintsUsed: 0 })).toBe(4); // a weak defence can be faster
    expect(gradeEndgame(mate, { reached: true, moves: 7 + GOOD_EXTRA_MOVES, hintsUsed: 0 })).toBe(3);
    expect(gradeEndgame(mate, { reached: true, moves: 7 + GOOD_EXTRA_MOVES + 1, hintsUsed: 0 })).toBe(2);
    // No move count to compare with: Good when the result was reached
    expect(gradeEndgame(open, { reached: true, moves: 40, hintsUsed: 0 })).toBe(3);
    expect(gradeEndgame({ targetResult: '1/2-1/2', optimalMoves: null }, { reached: true, moves: 25, hintsUsed: 0 })).toBe(3);
  });
});

describe('Phase 7 — playing a mate drill', () => {
  const MATE_IN_ONE = entry({ fen: '7k/5K2/8/8/8/8/6Q1/8 w - - 0 1', optimalMoves: 1 });

  it('counts the player’s moves and ends on checkmate with the target reached', () => {
    const s = new EndgameSession(MATE_IN_ONE);
    expect(s.goal).toBe('mate');
    expect(s.player).toBe('w');
    expect(s.playerMove(move('g2g7'))).toMatchObject({ kind: 'ended', end: { reached: true, result: '1-0', how: 'checkmate' } });
    expect(s.over).toBe(true);
    expect(s.moves).toBe(1);
    expect(s.outcome).toEqual({ reached: true, moves: 1, hintsUsed: 0 });
    // Nothing more is played once it is over
    expect(s.playerMove(move('f7f8'))).toEqual({ kind: 'not-playing' });
  });

  it('refuses an illegal move without counting it, and a move out of turn', () => {
    const s = new EndgameSession(MATE_IN_ONE);
    expect(s.playerMove(move('g2h8'))).toEqual({ kind: 'illegal' });
    expect(s.moves).toBe(0);
    const reply = s.playerMove(move('g2g3'));
    expect(reply.kind).toBe('continue');
    expect(s.turn).toBe('b');
    expect(s.playerMove(move('f7f8'))).toEqual({ kind: 'not-playing' });
    expect(s.opponentMove('h8h7')).toMatchObject({ kind: 'continue' });
    expect(s.opponentMove('h7h8')).toEqual({ kind: 'illegal' }); // it is White's turn
    expect(s.opponentMove('zz')).toEqual({ kind: 'illegal' });
  });

  it('winning the last piece into insufficient material throws the win away', () => {
    // Nxc3 takes the bishop that checks the king, and K+N v K cannot win
    const s = new EndgameSession(entry({ fen: 'k7/8/8/8/8/2b5/8/1N2K3 w - - 0 1' }));
    expect(s.playerMove(move('b1c3'))).toMatchObject({ kind: 'ended', end: { reached: false, result: '1/2-1/2', how: 'insufficient' } });
  });

  it('a stalemate throws the win away; for a drawn target it is the result', () => {
    const win = new EndgameSession(MATE_IN_ONE);
    const r = win.playerMove(move('g2g6'));
    expect(r).toMatchObject({ kind: 'ended', end: { reached: false, result: '1/2-1/2', how: 'stalemate' } });
    expect(win.outcome.reached).toBe(false);

    const hold = new EndgameSession(entry({ fen: MATE_IN_ONE.fen, targetResult: '1/2-1/2' }));
    expect(hold.goal).toBe('hold');
    expect(hold.playerMove(move('g2g6'))).toMatchObject({ kind: 'ended', end: { reached: true, how: 'stalemate' } });
  });

  it('a player mated by the engine is a miss', () => {
    // Black's only move is …Kg8; then Qa7-g7# mates: the player (Black) was mated
    const s = new EndgameSession(entry({ fen: '7k/Q7/5K2/8/8/8/8/8 b - - 0 1', targetResult: '0-1' }));
    expect(s.player).toBe('b');
    expect(s.playerMove(move('h8g8'))).toMatchObject({ kind: 'continue' });
    expect(s.opponentMove('a7g7')).toMatchObject({ kind: 'ended', end: { reached: false, result: '1-0', how: 'mated' } });
    expect(s.outcome.reached).toBe(false);
  });

  it('counts hints, and giving up ends it as a miss', () => {
    const s = new EndgameSession(MATE_IN_ONE);
    s.useHint();
    s.useHint();
    expect(s.hintsUsed).toBe(2);
    expect(s.giveUp()).toMatchObject({ reached: false, result: '*', how: 'given-up' });
    expect(s.outcome).toEqual({ reached: false, moves: 0, hintsUsed: 2 });
    // Giving up again keeps the first end
    expect(s.giveUp().how).toBe('given-up');
  });
});

describe('Phase 7 — converting a won position', () => {
  const PROMOTION = entry({ fen: '8/4P1k1/8/8/8/8/8/4K3 w - - 0 1', optimalMoves: null });

  it('promoting asks for the engine’s verdict; a decisive score wins the drill', () => {
    const s = new EndgameSession(PROMOTION);
    expect(s.goal).toBe('convert');
    const first = s.playerMove(move('e7e8q'));
    expect(first).toMatchObject({ kind: 'continue', check: true });
    expect(s.judgeConversion({ type: 'cp', value: DECISIVE_CP - 1 })).toBeNull();
    expect(s.over).toBe(false);
    expect(s.judgeConversion(null)).toBeNull();
    const end = s.judgeConversion({ type: 'cp', value: DECISIVE_CP })!;
    expect(end).toMatchObject({ reached: true, result: '1-0', how: 'converted' });
    expect(s.outcome).toEqual({ reached: true, moves: 1, hintsUsed: 0 });
  });

  it('a mate score is decisive, and a quiet move asks nothing', () => {
    const s = new EndgameSession(entry({ fen: '8/4P1k1/8/8/8/8/8/4K3 w - - 0 1' }));
    expect(s.playerMove(move('e1e2'))).toMatchObject({ kind: 'continue', check: false });
    expect(s.judgeConversion({ type: 'mate', value: 5 })).toMatchObject({ how: 'converted' });
  });

  it('winning the opponent’s last piece asks too', () => {
    const s = new EndgameSession(entry({ fen: 'k7/8/8/8/8/8/r7/R6K w - - 0 1' }));
    expect(s.playerMove(move('a1a2'))).toMatchObject({ kind: 'continue', check: true });
  });

  it('a mate drill never converts, whatever the engine says', () => {
    const s = new EndgameSession(entry({ fen: '8/4P1k1/8/8/8/8/8/4K3 w - - 0 1', optimalMoves: 12 }));
    expect(s.playerMove(move('e7e8q'))).toMatchObject({ kind: 'continue', check: false });
    expect(s.judgeConversion({ type: 'mate', value: 3 })).toBeNull();
  });

  it('for Black the win is 0-1', () => {
    const s = new EndgameSession(entry({ fen: '4k3/8/8/8/8/8/4p1K1/8 b - - 0 1', targetResult: '0-1' }));
    expect(s.player).toBe('b');
    s.playerMove(move('e2e1q'));
    expect(s.judgeConversion({ type: 'cp', value: 900 })).toMatchObject({ result: '0-1', reached: true });
  });
});

describe('Phase 7 — holding a draw', () => {
  /** Black walks its king around while White shuffles: no repetition, no capture. */
  function shuffle(session: EndgameSession, moves: number): void {
    const blackPath = ['e8d8', 'd8c8', 'c8b8', 'b8a8', 'a8a7', 'a7a6', 'a6a5', 'a5a4', 'a4a3', 'a3a2', 'a2b2'];
    for (let i = 0; i < moves; i++) {
      expect(session.playerMove(move(blackPath[i]!)).kind, `black move ${i + 1}`).toBe('continue');
      expect(session.opponentMove(i % 2 === 0 ? 'e1e2' : 'e2e1').kind, `white reply ${i + 1}`).toBe('continue');
    }
  }
  const HOLD = entry({ fen: '4k3/8/8/8/8/8/8/4K2R b - - 0 1', targetResult: '1/2-1/2' });

  it('a draw can be offered after enough moves, and the engine agrees when it sees nothing for itself', () => {
    const s = new EndgameSession(HOLD);
    expect(s.goal).toBe('hold');
    expect(s.player).toBe('b');
    expect(s.offerDraw({ type: 'cp', value: 0 })).toEqual({ kind: 'too-early', movesLeft: HOLD_MIN_MOVES });
    shuffle(s, HOLD_MIN_MOVES - 1);
    expect(s.offerDraw({ type: 'cp', value: 0 })).toEqual({ kind: 'too-early', movesLeft: 1 });
    // One more move
    s.playerMove(move('a3a2'));
    s.opponentMove('e2e1');
    expect(s.moves).toBe(HOLD_MIN_MOVES);
    expect(s.offerDraw({ type: 'cp', value: -(DRAW_AGREE_CP + 1) })).toEqual({ kind: 'declined' });
    expect(s.offerDraw(null)).toEqual({ kind: 'declined' });
    expect(s.over).toBe(false);
    const agreed = s.offerDraw({ type: 'cp', value: -DRAW_AGREE_CP });
    expect(agreed).toMatchObject({ kind: 'agreed', end: { reached: true, result: '1/2-1/2', how: 'draw-agreed' } });
    expect(s.outcome.reached).toBe(true);
  });

  it('is not offered in a win drill', () => {
    expect(new EndgameSession(entry({ fen: '8/4P1k1/8/8/8/8/8/4K3 w - - 0 1' })).offerDraw({ type: 'cp', value: 0 })).toEqual({ kind: 'not-a-draw' });
  });

  it('a draw by repetition is the result', () => {
    const s = new EndgameSession(entry({ fen: '4k3/8/8/8/8/8/8/R3K3 b - - 0 1', targetResult: '1/2-1/2' }));
    const cycle = [['e8d8', 'e1e2'], ['d8e8', 'e2e1'], ['e8d8', 'e1e2'], ['d8e8', 'e2e1'], ['e8d8', 'e1e2'], ['d8e8', 'e2e1']];
    let ended = null;
    for (const [mine, theirs] of cycle) {
      const r = s.playerMove(move(mine!));
      if (r.kind === 'ended') {
        ended = r.end;
        break;
      }
      const o = s.opponentMove(theirs!);
      if (o.kind === 'ended') {
        ended = o.end;
        break;
      }
    }
    expect(ended).toMatchObject({ reached: true, how: 'repetition' });
  });

});

describe('Phase 7 — warning when the target slips', () => {
  it('a win warns below +0.50, a hold when the opponent is ahead by 2 pawns', () => {
    const win = new EndgameSession(entry({ fen: '8/4P1k1/8/8/8/8/8/4K3 w - - 0 1' }));
    expect(win.slipping({ type: 'cp', value: WARN_BELOW_CP })).toBe(false);
    expect(win.slipping({ type: 'cp', value: WARN_BELOW_CP - 1 })).toBe(true);
    expect(win.slipping({ type: 'mate', value: 4 })).toBe(false);
    expect(win.slipping({ type: 'mate', value: -4 })).toBe(true);
    expect(win.slipping(null)).toBe(false);
    const hold = new EndgameSession(entry({ fen: '4k3/8/8/8/8/8/8/4K2R b - - 0 1', targetResult: '1/2-1/2' }));
    expect(hold.slipping({ type: 'cp', value: -WARN_HOLD_CP })).toBe(false);
    expect(hold.slipping({ type: 'cp', value: -WARN_HOLD_CP - 1 })).toBe(true);
    // An even score is fine for a draw, and a warning for a win
    expect(hold.slipping({ type: 'cp', value: 0 })).toBe(false);
    expect(win.slipping({ type: 'cp', value: 0 })).toBe(true);
  });
});
