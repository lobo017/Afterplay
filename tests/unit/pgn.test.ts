import { describe, expect, it } from 'vitest';
import { parseCommentAnnotations, parsePgn, parsePgnGames, writePgn } from '../../src/core/pgn';

/**
 * Helper that verifies a PGN fixture parses cleanly, serializes via `writePgn`,
 * and re-parses to an identical `GameTree` structure and identical canonical PGN output.
 */
function assertCanonicalRoundTrip(inputPgn: string): {
  firstTree: ReturnType<typeof parsePgn>;
  canonicalPgn: string;
  secondTree: ReturnType<typeof parsePgn>;
} {
  const firstTree = parsePgn(inputPgn);
  const canonicalPgn = writePgn(firstTree);
  const secondTree = parsePgn(canonicalPgn);
  const secondCanonicalPgn = writePgn(secondTree);

  expect(secondCanonicalPgn).toBe(canonicalPgn);
  expect(secondTree.toJSON()).toEqual(firstTree.toJSON());

  return { firstTree, canonicalPgn, secondTree };
}

describe('Phase 1 — Adversarial PGN Parser, Writer & Round-Trip Suite', () => {
  it('Fixture 1: deeply nested variations (3+ levels), sibling variations, pre-move comments, and variation results', () => {
    const pgn = `
[Event "Adversarial Nested RAV Study"]
[Site "Offline Lab"]
[Date "2026.10.16"]
[Round "1"]
[White "Morphy, Paul"]
[Black "Anderssen, Adolf"]
[Result "1-0"]

{ Root game introduction before move 1. }
1. { White opens with the King's Pawn } e4 $1 { Best by test }
( { Queen's Pawn alternative } 1. d4 d5 ( 1... Nf6 2. c4 e6 ( 2... g6 3. Nc3 Bg7 * ) ) 2. c4 )
1... e5
( { Sicilian Defense } 1... c5 2. Nf3 d6 ( 2... Nc6 3. d4 cxd4 4. Nxd4 ( 4. Qxd4?! e5 $15 ) ) )
( { Caro-Kann Defense } 1... c6 2. d4 d5 1/2-1/2 )
2. { Developing the kingside knight } Nf3 Nc6 3. Bb5 a6 1-0
`;

    const { firstTree, secondTree } = assertCanonicalRoundTrip(pgn);

    expect(firstTree.root.comment).toBe('Root game introduction before move 1.');
    const mainLine = firstTree.getMainLine();
    expect(mainLine.map((n) => n.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);

    const e4Node = mainLine[0]!;
    expect(e4Node.preComment).toBe("White opens with the King's Pawn");
    expect(e4Node.comment).toBe('Best by test');
    expect(e4Node.nags).toEqual([1]);

    // Check 1. d4 variation on root
    expect(firstTree.root.children.length).toBe(2);
    const d4Var = firstTree.root.children[1]!;
    expect(d4Var.san).toBe('d4');
    expect(d4Var.preComment).toBe("Queen's Pawn alternative");

    // Check 3-level nested variation 1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 *
    const nf6Var = d4Var.children[1]!;
    expect(nf6Var.san).toBe('Nf6');
    const c4Node = nf6Var.children[0]!;
    const g6Var = c4Node.children[1]!;
    expect(g6Var.san).toBe('g6');
    const bg7Node = g6Var.children[0]!.children[0]!;
    expect(bg7Node.san).toBe('Bg7');
    expect(bg7Node.variationResult).toBe('*');

    // Check sibling variations on 1. e4 (e5, c5, c6)
    expect(e4Node.children.map((c) => c.san)).toEqual(['e5', 'c5', 'c6']);
    expect(e4Node.children[1]!.preComment).toBe('Sicilian Defense');
    expect(e4Node.children[2]!.preComment).toBe('Caro-Kann Defense');

    // Check pre-comment on 2. Nf3
    const nf3Node = mainLine[2]!;
    expect(nf3Node.preComment).toBe('Developing the kingside knight');
    expect(secondTree.result).toBe('1-0');
  });

  it('Fixture 2: comments containing PGN syntax characters, consecutive brace comments, semicolon comments, and % escape lines', () => {
    const pgn = `%ChessBase 17 export header escape line that must be ignored
[Event "Comment Torture Test"]
[Site "TWIC"]
[Date "2026.10.16"]
[Round "2"]
[White "Alpha"]
[Black "Beta"]
[Result "0-1"]
%Another column-0 escape line with fake moves 1. a4 a5 1-0

1. e4 { This comment contains (1. d4 d5 (2. c4) 1-0) and [Event "Fake"] and [sic] and ; semicolon and $14! }
{ Second consecutive comment on 1. e4 }
1... e5 ; Rest-of-line semicolon comment after 1... e5
2. Nf3 Nc6 ( 2... Nf6 ; Petrov Defense semicolon comment
3. Nxe5 d6 )
3. Bc4 Bc5 0-1
`;

    const { firstTree } = assertCanonicalRoundTrip(pgn);
    const mainLine = firstTree.getMainLine();
    expect(mainLine.map((n) => n.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']);
    expect(mainLine[0]!.comment).toBe(
      'This comment contains (1. d4 d5 (2. c4) 1-0) and [Event "Fake"] and [sic] and ; semicolon and $14! Second consecutive comment on 1. e4',
    );
    expect(mainLine[1]!.comment).toBe('Rest-of-line semicolon comment after 1... e5');
    const petrovVar = mainLine[2]!.children[1]!;
    expect(petrovVar.san).toBe('Nf6');
    expect(petrovVar.comment).toBe('Petrov Defense semicolon comment');
    expect(firstTree.result).toBe('0-1');
  });

  it('Fixture 3: [%eval], [%cal], and [%csl] tags (including mate scores, depth suffixes, and mixed human prose)', () => {
    const pgn = `
[Event "Annotated Study"]
[Site "Lichess"]
[Date "2026.10.16"]
[Round "1"]
[White "StudyWhite"]
[Black "StudyBlack"]
[Result "*"]

1. e4 { [%eval +0.35,24] [%cal Ge2e4,Gd2d4] [%csl Ge4,Yd5] Classical central control }
1... e5 { [%eval 0.00] }
2. Bc4 { [%cal Rc4f7,Ge1g1] [%csl Rf7] Targeting f7 }
2... Nc6 { [%eval #3,18] }
3. Qh5 { [%eval #-2]Forced mate sequence } *
`;

    const { firstTree } = assertCanonicalRoundTrip(pgn);
    const main = firstTree.getMainLine();

    expect(main[0]!.eval).toEqual({ cp: 35, depth: 24 });
    expect(main[0]!.arrows).toEqual([
      { color: 'G', from: 'e2', to: 'e4' },
      { color: 'G', from: 'd2', to: 'd4' },
    ]);
    expect(main[0]!.highlights).toEqual([
      { color: 'G', square: 'e4' },
      { color: 'Y', square: 'd5' },
    ]);
    expect(main[0]!.comment).toBe('Classical central control');

    expect(main[1]!.eval).toEqual({ cp: 0 });
    expect(main[1]!.comment).toBe('');

    expect(main[2]!.arrows).toEqual([
      { color: 'R', from: 'c4', to: 'f7' },
      { color: 'G', from: 'e1', to: 'g1' },
    ]);
    expect(main[2]!.highlights).toEqual([{ color: 'R', square: 'f7' }]);
    expect(main[2]!.comment).toBe('Targeting f7');

    expect(main[3]!.eval).toEqual({ mate: 3, depth: 18 });
    expect(main[4]!.eval).toEqual({ mate: -2 });
    expect(main[4]!.comment).toBe('Forced mate sequence');

    // Direct unit check on parseCommentAnnotations
    const direct = parseCommentAnnotations('{ [%eval -1.25,20] [%cal Bb1c3,Yf3g5] [%csl Bc3] Knight outpost }');
    expect(direct.eval).toEqual({ cp: -125, depth: 20 });
    expect(direct.arrows).toHaveLength(2);
    expect(direct.highlights).toEqual([{ color: 'B', square: 'c3' }]);
  });

  it('Fixture 4: real-world SAN quirks (glued move numbers, over-disambiguated pinned knight Nge7, 0-0 castling, e.p., promotions, null moves)', () => {
    // In this position after 1.e4 e6 2.Nf3 Nc6 3.Bb5 d5 4.e5, the c6 knight is pinned by Bb5.
    // Real-world PGNs frequently write "4...Nge7" even though Ne7 is strictly unambiguous because Nc6 is pinned!
    const quirkyPgn = `
[Event "Real-World Quirks"]
[Site "Archive"]
[Date "2026.10.16"]
[Round "1"]
[White "PlayerA"]
[Black "PlayerB"]
[Result "1-0"]

1.e4 e6 2.Ng1f3!! Nc6 3.Bb5 d5 4.e5! 4...Nge7?! ( 4...d4 5.0-0! Qd5 6.Z0 Bd7 7.Re1 0-0-0+ ) 5.d4 Bd7 6.0-0 Ng6 7.Re1 Be7 1-0
`;

    const { firstTree } = assertCanonicalRoundTrip(quirkyPgn);
    const main = firstTree.getMainLine();
    expect(main.map((n) => n.san)).toEqual([
      'e4',
      'e6',
      'Nf3',
      'Nc6',
      'Bb5',
      'd5',
      'e5',
      'Ne7',
      'd4',
      'Bd7',
      'O-O',
      'Ng6',
      'Re1',
      'Be7',
    ]);
    expect(main[2]!.nags).toEqual([3]); // !! -> $3
    expect(main[6]!.nags).toEqual([1]); // ! -> $1
    expect(main[7]!.nags).toEqual([6]); // ?! -> $6

    // Check variation with 0-0, null move Z0 -> '--', and 0-0-0+
    const d4Var = main[6]!.children[1]!;
    expect(d4Var.san).toBe('d4');
    const varMoves: string[] = [];
    let curr: typeof d4Var | undefined = d4Var;
    while (curr) {
      varMoves.push(curr.san);
      curr = curr.children[0];
    }
    expect(varMoves).toEqual(['d4', 'O-O', 'Qd5', '--', 'Bd7', 'Re1', 'O-O-O']);
  });

  it('Fixture 5: promotions in all wild notations (=Q+, (N)#, no-equals R, lowercase =b) and en passant e.p. suffix', () => {
    const promoPgn = `
[Event "Promotion & En Passant Torture"]
[Site "Lab"]
[Date "2026.10.16"]
[Round "1"]
[White "WhitePromo"]
[Black "BlackPromo"]
[SetUp "1"]
[FEN "r3k2r/pP2ppP1/8/3pP3/8/8/p1p1PPP1/R3K2R w KQkq d6 0 1"]
[Result "*"]

1. exd6 e.p. exd6
2. bxa8(Q)+ ( 2. bxa8R+ Ke7 3. gxh8=b ) ( 2. g8=n Rxg8 )
2... Ke7 3. gxh8=Q *
`;

    const { firstTree } = assertCanonicalRoundTrip(promoPgn);
    const main = firstTree.getMainLine();
    expect(main.map((n) => n.san)).toEqual(['exd6', 'exd6', 'bxa8=Q+', 'Ke7', 'gxh8=Q']);

    const afterExd6 = main[1]!;
    expect(afterExd6.children.map((c) => c.san)).toEqual(['bxa8=Q+', 'bxa8=R+', 'g8=N']);
    const underPromoBranch = afterExd6.children[1]!;
    expect(underPromoBranch.children[0]!.children[0]!.san).toBe('gxh8=B');
  });

  it('Fixture 6: escaped quotes/backslashes in headers and Black-to-move initial FEN with variations on move 1', () => {
    const blackStartPgn = `
[Event "World \\"Championship\\" \\\\ Finals"]
[Site "St. John's \\"Grand Hall\\""]
[Date "2026.10.16"]
[Round "14"]
[White "Challenger"]
[Black "Champion"]
[SetUp "1"]
[FEN "r1bqk2r/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R b KQkq - 4 6"]
[Result "1/2-1/2"]

{ Black to move in the Italian Four Knights }
6... { Preparing castling } O-O $1 ( { Aggressive pin } 6... Bg4 7. h3 Bxf3 8. Qxf3 ) 7. Bg5 h6 1/2-1/2
`;

    const { firstTree, canonicalPgn } = assertCanonicalRoundTrip(blackStartPgn);
    const headers = firstTree.getHeaders();
    expect(headers.Event).toBe('World "Championship" \\ Finals');
    expect(headers.Site).toBe('St. John\'s "Grand Hall"');
    expect(canonicalPgn).toContain('[Event "World \\"Championship\\" \\\\ Finals"]');

    const main = firstTree.getMainLine();
    expect(main[0]!.san).toBe('O-O');
    expect(main[0]!.moveColor).toBe('b');
    expect(main[0]!.moveNumber).toBe(6);
    expect(main[0]!.preComment).toBe('Preparing castling');
    expect(firstTree.root.children[1]!.san).toBe('Bg4');
    expect(firstTree.root.children[1]!.preComment).toBe('Aggressive pin');
  });

  it('Fixture 7: Chess960 (Fischer Random) PGN round-trip with Shredder-FEN, O-O / O-O-O castling, and annotations', () => {
    const chess960Pgn = `
[Event "Freestyle Chess960 Grand Slam"]
[Site "Weissenhaus"]
[Date "2026.10.16"]
[Round "1"]
[White "Carlsen, Magnus"]
[Black "Caruana, Fabiano"]
[Variant "Chess960"]
[SetUp "1"]
[FEN "1r3kr1/pppppppp/8/8/8/8/PPPPPPPP/1R3KR1 w GBgb - 0 1"]
[Result "1-0"]

{ Starting position has Kings on f1/f8 and Rooks on b1/g1 and b8/g8 }
1. O-O $1 { [%eval +0.40] [%cal Gf1g1,Gg1f1] King and rook swap squares on f1/g1! }
( { Queenside castling in Chess960 } 1. O-O-O O-O-O 2. d4 )
1... O-O 2. d4 d5 1-0
`;

    const { firstTree } = assertCanonicalRoundTrip(chess960Pgn);
    expect(firstTree.isChess960()).toBe(true);
    const main = firstTree.getMainLine();
    expect(main.map((n) => n.san)).toEqual(['O-O', 'O-O', 'd4', 'd5']);
    expect(main[0]!.fen).toBe('1r3kr1/pppppppp/8/8/8/8/PPPPPPPP/1R3RK1 b gb - 1 1');
    expect(firstTree.root.children[1]!.san).toBe('O-O-O');
    expect(firstTree.root.children[1]!.fen).toBe('1r3kr1/pppppppp/8/8/8/8/PPPPPPPP/2KR2R1 b gb - 1 1');
  });

  it('Fixture 8: multi-game PGN stream with bracketed text inside comments', () => {
    const multiPgn = `
[Event "Game One"]
[Site "Local"]
[Date "2026.10.16"]
[Round "1"]
[White "W1"]
[Black "B1"]
[Result "1-0"]

1. e4 { Note with [Event "Not a new game"] inside comment } e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0

[Event "Game Two"]
[Site "Local"]
[Date "2026.10.16"]
[Round "2"]
[White "W2"]
[Black "B2"]
[Result "0-1"]

1. f3 e5 2. g4 Qh4# 0-1
`;

    const games = parsePgnGames(multiPgn);
    expect(games).toHaveLength(2);
    expect(games[0]!.getHeaders().Event).toBe('Game One');
    expect(games[0]!.getMainLine().map((n) => n.san)).toEqual(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']);
    expect(games[1]!.getHeaders().Event).toBe('Game Two');
    expect(games[1]!.getMainLine().map((n) => n.san)).toEqual(['f3', 'e5', 'g4', 'Qh4#']);
  });

  it('Fixture 9: three-queen double disambiguation (Qh4e1), multiple NAGs ($1 $14 $146), and symbolicMoveSuffixes round-trip', () => {
    // White has three queens on e4, h4, and h1; all three can reach e1, so Qh4e1 requires both file and rank!
    const doubleDisambigPgn = `
[Event "Three Queens Double Disambiguation"]
[Site "Endgame Lab"]
[Date "2026.10.16"]
[Round "1"]
[White "TriQueen"]
[Black "Defender"]
[SetUp "1"]
[FEN "8/2k5/8/8/4Q2Q/8/8/1K5Q w - - 0 1"]
[Result "1-0"]

1. Qh4e1 $1 $18 $146 ( 1. Qhe1 Kb6 ) ( 1. Q4e1 Kb6 ) 1... Kb6 2. Qe6+ 1-0
`;

    const { firstTree } = assertCanonicalRoundTrip(doubleDisambigPgn);
    const main = firstTree.getMainLine();
    expect(main[0]!.san).toBe('Qh4e1');
    expect(main[0]!.from).toBe('h4');
    expect(main[0]!.to).toBe('e1');
    expect(main[0]!.nags).toEqual([1, 18, 146]);

    // Verify symbolicMoveSuffixes option also round-trips cleanly
    const withSymbols = writePgn(firstTree, { symbolicMoveSuffixes: true });
    expect(withSymbols).toContain('Qh4e1! $18 $146');
    const reparsed = parsePgn(withSymbols);
    expect(reparsed.toJSON()).toEqual(firstTree.toJSON());
  });

  it('Fixture 10: Chess960 castling with immediate checkmate (O-O#) and discovered rank check prevention', () => {
    // White King on f1, Rook on h1; Black King on f8 boxed in by rooks on e8/g8 and pawns on e7/g7.
    // 1. O-O# moves White's rook to f1, delivering immediate corridor checkmate along the f-file!
    const c960MatePgn = `
[Event "Chess960 Castling Checkmate"]
[Site "Lab"]
[Date "2026.10.16"]
[Round "1"]
[White "Attacker"]
[Black "Victim"]
[Variant "Chess960"]
[SetUp "1"]
[FEN "4rkr1/4p1p1/8/8/8/8/8/5K1R w H - 0 1"]
[Result "1-0"]

1. O-O# 1-0
`;

    const { firstTree } = assertCanonicalRoundTrip(c960MatePgn);
    const main = firstTree.getMainLine();
    expect(main[0]!.san).toBe('O-O#');
    expect(main[0]!.from).toBe('f1');
    expect(main[0]!.to).toBe('g1');
    expect(main[0]!.uci).toBe('f1h1');
  });

  it('Fixture 11: CRLF line endings, no blank line after headers, padded header brackets, and missing result token at EOF', () => {
    const rawCrlfPgn =
      '[  Event   "Clipboard Paste"  ]\r\n' + '[Site "Forum"]\r\n' + '1. e4 e5 2. Nf3 Nc6 (2... Nf6 3. Nxe5)';

    const { firstTree } = assertCanonicalRoundTrip(rawCrlfPgn);
    expect(firstTree.getHeaders().Event).toBe('Clipboard Paste');
    expect(firstTree.result).toBe('*');
    expect(firstTree.getMainLine().map((n) => n.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(firstTree.getMainLine()[2]!.children[1]!.san).toBe('Nf6');
  });
});
