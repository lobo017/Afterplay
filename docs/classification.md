# Move classification

How the game review labels and explains each move, with every rule and number and the
reason for it. The code is `src/review/classification.ts` (classes), `formulas.ts`
(win%, accuracy, ACPL), `explain.ts` (sentences), `motifs.ts` (motif detectors),
`annotations.ts` (imported annotations) and `review-runner.ts` (engine budget and
verification). The fixtures are `tests/fixtures/review/classification-fixtures.json`,
`motif-fixtures.json` and `lichess-Bjl39T9x.json`.

**Reference tool: Lichess.** Users compare reviews against Lichess's analysis, so the
thresholds, win% conversion, accuracy and ACPL follow Lichess's open-source
implementation (lila `Advice.scala`, `WinPercent.scala`, `AccuracyPercent.scala`,
`Accuracy.scala`). Given Lichess's own evaluations, the app reproduces Lichess's numbers
on a real game (below). Where the app goes further (Great, Brilliant, Book, Miss, the
5-move mate horizon, motif sentences), that is stated.

## Inputs

- Every position of the game's main line is searched with **MultiPV 2**, on the preset's
  time per position (Quick 0.2 s, Standard 0.6 s, Deep 1.5 s), with the game's moves sent
  as history so the engine sees repetitions.
- Engine scores come from the side to move. The classifier works from the **mover's**
  view: the score before the move is the best line of the position it was played from;
  the score after it is the negated best line of the position that follows (the
  opponent's best reply).
- **Win%** = 50 + 50·(2/(1+e^(−0.00368208·cp)) − 1), with **cp clamped to ±1000**, and a
  **forced mate counted as ±1000 cp** (97.5% / 2.5%), as on Lichess (`Eval.Cp.ceiled`,
  `WinPercent.fromMate`). A checkmated side counts as −1000 too; stalemate and
  insufficient material are 50.
- **Win% drop** = max(0, win% before − win% after), for the mover.

Reference points on the curve: +1 pawn = 59.1%, +3 = 75.1%, +5 = 86.3%, **+8 = 95.0%**,
+10 and beyond (and any forced mate) = 97.5%.

Until 2026-10-18 a forced mate counted as 100%. With Lichess's ceiling, a mate and a
+10 position are the same 97.5%; losing a short mate is handled by the mate rules below.

## The classes, in the order they are decided

### Book

The position after the move is in the openings dataset (`data/openings.json`, matched by
EPD, with the en-passant field ignored when needed), **and every earlier move of the game
was Book as well**. A later transposition into a named position is a normal move: it was
found over the board, not from memory. Book overrides everything else, including the
engine's opinion, because a dataset line is a known opening, not an error of the player.
(Lichess has no Book class; it doesn't flag opening moves either way.)

### Best: the engine's top move

A move is the top move when it is MultiPV line 1, or line 2 with exactly the same score
as line 1 (two equal moves, e.g. two mates in one), or when it delivers checkmate. A top
move is never an error, whatever the before/after numbers say (a deeper search after
the move can change the evaluation). Top moves are Best unless they are Great or
Brilliant.

### Great: the only move that keeps the result

A top move where the second-best move would have been a Blunder: win% of the best line −
win% of the second line ≥ **15** (the Blunder threshold). Reason: "only move" in practice
means every alternative throws the result away, and a drop of 15 or more is exactly what
the review calls throwing the result away. Not Great, because the move is obvious rather
than a find:
- **recaptures** (capturing on the square where the opponent just captured)
  (`best-recapture-is-not-great`);
- **taking material that was simply en prise** (a capture that wins on the static
  exchange): punishing a hung knight is necessary but not outstanding
  (`best-punishes-hanging-knight`; added 2026-10-18, when the lower Blunder band made the
  gap after Nd4?? exd4 qualify);
- **forced moves** (only one legal move, so no second line).

Examples: the king-and-pawn opposition move ...Ke7 (`great-kpk-opposition`), and in the
sample game 17.Rd8#: after 16...Nxb8 every other move loses, so the mate is the only move
that keeps the result.

### Brilliant: a sound sacrifice

A top move that gives up material, in a position that isn't already trivially won:
- **material given up ≥ 2 pawns** (a minor piece for a pawn, or the exchange, or more).
  Measured with a static exchange evaluation (x-ray aware SEE): the opponent's best
  capture after the move, minus what the move itself captured, minus material that was
  already en prise before the move (saving the queen from a fork and losing the rook is
  not a sacrifice of the rook);
- **the alternative was below 95%**: when the second-best move already wins trivially,
  a sacrifice is a nice touch, not a brilliant find;
- **the mover is not worse afterwards** (win% after ≥ 50).

Brilliant is checked before Great, so a sound sacrifice that is also the only move is
Brilliant (Legal's mate pattern `brilliant-legal-queen-sacrifice`; 16.Qb8+ in the sample
game). A sacrifice that is not the top move is just lost material
(`blunder-unsound-sacrifice-bxf7`).

### Excellent, Good, Inaccuracy, Mistake, Blunder: the win% drop

| Class | Win% drop | Move accuracy at the bound |
|-------|-----------|----------------------------|
| Excellent | ≤ 2 | 92.4 |
| Good | more than 2, less than 5 | — |
| Inaccuracy | ≥ 5 | 80.8 |
| Mistake | ≥ 10 | 64.6 |
| Blunder | ≥ 15 | 51.5 |

**Why these numbers (2026-10-18):** Inaccuracy / Mistake / Blunder are Lichess's
(`Advice.scala`: a drop in winning chances of 0.1 / 0.2 / 0.3 on the −1…1 scale, which
is 5 / 10 / 15 win% points, inclusive). Users compare the app's review with Lichess's on
the same game; with different bands the same evaluation gave different labels (a 16-point
drop was a Blunder on Lichess and a Mistake here), which read as the app being wrong.
Matching the bands removes that. Excellent ≤ 2 is kept: Lichess has no such class, and a
drop of up to 2 points (about 0.1–0.2 pawn in a balanced position) is within what two
strong moves differ by. Before, the bands were the spec's starting values ≤ 5 / ≤ 10 /
≤ 20 for Good / Inaccuracy / Mistake.

What the change means over the board: losing a clean pawn from a level position is about
9–14 points (Inaccuracy or Mistake, `mistake-g3-drops-e4-pawn`), a pawn plus the
initiative or a piece for nothing is a Blunder (`blunder-nh4-drops-e4-pawn`,
`blunder-nd4-hangs-knight`).

### Forced mates (the 5-move mate horizon)

A drop can be small while something important happened with a forced mate, so two rules
raise a quiet class (Excellent / Good) to **Inaccuracy**:
- **mate lost**: the mover had a forced mate in ≤ 5 moves and after the move has none
  within 5 (`decided-misses-smothered-mate`: Nf7# missed, White still mates but only in
  16; `decided-misses-mate-in-one-mate-far-away`);
- **mate allowed**: the opponent now has a forced mate in ≤ 5 moves that they didn't have
  before (`decided-lost-side-allows-quick-mate`).

Why 5: mates up to five moves are found reliably at review depth and are what a player
can be expected to see; longer mates come and go between searches, so counting them
would make labels flicker.

When the mate is thrown away completely and the result changes, the drop does the work:
mate in 1 → a level rook ending is 97.5 → 45, a **Blunder**
(`blunder-throws-away-mate-entirely`); so is mate → stalemate
(`decided-winning-stalemates`).

Lichess handles mates with its own rules (`MateAdvice`: a newly allowed mate is an
Inaccuracy / Mistake / Blunder by how bad the position already was, a lost mate by how
good it still is, and a longer mate is no error). The app's horizon rule agrees with
Lichess's labels on the reference game (45.Rxa4, "Checkmate is now unavoidable": both
Inaccuracy), but can differ elsewhere: Lichess doesn't flag a mate that only got longer.

### Decided positions (beyond ±95%)

Already-decided positions must not produce false blunders. With Lichess's bands this
follows from the win% curve and the rules above:
- The curve is flat beyond ±8 pawns and stops at ±10: +10 → +8 is a drop of 2.5, so a
  winning side that wastes material while staying winning gets Excellent or Good
  (`decided-winning-mate-delayed`).
- The losing side's win% is already near the floor: hanging a rook at −8 (4.8% → 2.5%)
  is Good (`decided-lost-side-hangs-rook`), and allowing a short mate is the Inaccuracy
  floor (`decided-lost-side-allows-quick-mate`), not a Blunder.
- Only moves that change the result move win% a lot: a won position allowing a
  back-rank mate (`decided-winning-allows-back-rank-mate`) or stalemate is a Blunder, as
  it should be.

The unit test "decided positions never produce a Mistake or Blunder unless the result
changes" checks every `decided-*` fixture against this.

### Miss: the opponent's error went unpunished

Checked last, on top of the drop class (Lichess has no Miss; it calls these moves by
their drop):
- the opponent's previous move handed over **at least 10** win% (it was a Mistake or a
  Blunder by the same bands), measured as the mover's win% now minus the mover's win%
  before that move;
- this move drops **at least 5** (an Inaccuracy or worse);
- it gives back **at least half** of what the opponent's error handed over;
- the mover ends **less than 10 points worse** than before the opponent's error.

The last bound separates a Miss from a Blunder: ignoring a hanging knight and then
hanging a bishop leaves Black worse than before White's mistake, which is Black's own
Blunder (`blunder-after-opponent-blunder-is-not-miss`), while ignoring it and drifting
back to equality is a Miss (`miss-ignores-hanging-knight`). In the Lichess reference game
11.Na3, which leaves Black's hung queen on d6 alone, is Lichess's Blunder and the app's
Miss.

## Verification searches

A 0.2 s search sometimes sees a mate on one side of a move and misses it on the other.
That shows up as a large false drop. It happened in the sample game:
15.Bxd7+ (part of Morphy's forced mate) was a Blunder in one of three Quick runs before
this rule existed. So:
- when a move's first-pass class is **Mistake, Blunder or Miss**, or a short forced mate
  appears or disappears across it (the two mate rules above), the positions before and
  after the move are searched again for longer: **Quick 1 s, Standard 2 s, Deep 3 s**;
- each position is verified at most once, and the deeper of the two results is kept;
- if the position before the move holds a short forced mate for the mover (≤ 5 moves),
  the played move itself is searched from there (UCI `searchmoves`, to depth 2n + 6, deep
  enough to find a mate in n reliably). If it still mates and the search after the move
  missed that (or saw it longer), the position after the move takes it (a mate in n for
  the mover becomes a mate in n − 1 against the opponent), keeping only the other lines
  that agree. It is used for mates only: elsewhere two estimates from different roots
  differ by noise, and mixing them (tried first) made Brilliant less consistent;
- then the move is classified from the verified positions.

Why the same-root search (added 2026-10-18): with Lichess's lower Blunder line (15), the
1 s search after 15.Bxd7+ (still +3.9 instead of mate) was again enough for a false
Blunder in one of three Quick runs. A time-limited same-root search fixed it in some runs
but not all (one run still gave a Mistake); searching Bxd7+ from the position before it to
the mate's depth finds the same mate the best line found there.

This doesn't move any threshold; it makes sure the numbers that reach them come from
searches that agree. Fixed-depth reviews (the fixture settings) skip it.

## Imported annotations

A review owns the evaluation annotations of the line it reviews. When a review starts,
the main line is cleaned of earlier engine annotations, and the export does the same on
its copy, so exporting is idempotent:
- every `[%eval]` (the review writes its own);
- move-quality NAGs $1–$6 (`!`, `?`, `!!`, `??`, `!?`, `?!`), so each move's NAG is the
  app's classification NAG and nothing else;
- Lichess's analysis comments, recognised by lila's `Advice.makeComment` format:
  `(0.20 → 1.10) Mistake. Nc3 was best.`, `Checkmate is now unavoidable.`,
  `Lost forced checkmate sequence.`, `Not the best checkmate sequence.`;
- the app's own earlier review text: everything after the `Review:` marker;
- the engine's variation after an annotated move: a variation of that move whose first
  move is the one the removed comment named as best.

Kept: plain human comments, clock tags (`[%clk]`), other NAGs and other variations. In the
export the review text follows the human comment behind a fixed marker:
`{ [%eval -8.00,16] [%clk 0:04:50] My first blitz game! — Review: Blunder. … Best: Bc4. }`.
Tests: `review-annotations.test.ts` (a Lichess-style PGN with a human note), the Lichess
reference game round trip (`review-lichess.test.ts`) and an e2e test that imports the
Lichess game, reviews it with the app's engine and checks the move list and the export.

## Explanations (one sentence per Inaccuracy, Mistake, Blunder or Miss)

**A motif or a material claim is only used when the engine's line realizes it.** Following
the move and the engine's best line from the position *before* the move:
- the material must really change hands, measured where it settles (after the line's
  first capture, at the first two quiet plies in a row with no profitable capture
  pending), so an even exchange or a recapture counts as nothing;
- the claimed material must be backed by the evaluation: it must have moved by at least
  half of it (a short line can stop before a recapture, ...Nxc4 Qa4 with dxc4 still to
  come, but then the evaluation hasn't moved by a knight either);
- a named piece ("hangs the knight") needs at least 2 pawns of real gain (1 for a pawn);
  an attack motif (fork, pin, …) needs any real gain;
- a trapped piece must actually be captured along the line.

Otherwise the sentence falls back to what happened to the evaluation. Rules, tried in
order:

1. **Stalemate from a won position**: "Stalemates the opponent; Qc8# was mate."
2. **The opponent can now force mate**: mate in one → "Allows Re1#, a back-rank mate."
   (or "…, an immediate mate."); longer → "Allows mate in 2, starting with Qd8+."
3. **A short mate was missed**: "Misses mate in 1 with Nf7#." / "Misses mate in 3,
   starting with …".
4. **Miss**: what the best move would have done, if realized: "Misses exd4, which wins
   the knight on d4.", or the motif it creates; otherwise the Miss line of rule 7.
5. **Material left en prise and taken by the engine's line**: "Hangs the knight on d4 to
   exd4."; a sacrifice that doesn't work: "Gives up the bishop on f7 for a pawn; Rxf7
   takes it."; a piece that was already attacked and was ignored: "Leaves the pawn on e4
   hanging to Nxe4."
6. **The opponent's best reply is a realized tactic**: "Allows Nxe4, a discovered attack
   on the knight on h4.", "Allows Nc2+, forking the king and queen.", pins, skewers,
   trapped pieces, promotion threats, or a plain winning capture.
7. **No realized tactic**: what happened to the mover's standing, the evaluation change
   (White's side, one decimal, as on the eval bar) and the move that kept it, joined with
   a semicolon so it stays one sentence: "Throws away Black's winning advantage
   (−2.0 → 0.0); Bf5 kept it." Standing comes from the mover's win% (`standingFromWin`):

   | Standing | Win% | About |
   |---|---|---|
   | winning | ≥ 67 | ≥ +1.9 |
   | better | 56–67 | +0.65 to +1.9 |
   | equal | 44–56 | ±0.65 |
   | worse | 33–44 | −0.65 to −1.9 |
   | losing | < 33 | ≤ −1.9 |

   One sentence per (before → after) pair (`fallbackSentence`), e.g. winning → equal
   "Throws away …'s winning advantage", winning → losing "Turns …'s winning position into
   a losing one", equal → worse "Hands the opponent the advantage in a level position",
   worse → losing "Turns …'s difficult position into a losing one". The class sets the
   severity: inside one band "Gives back some of / much of / a large part of …"
   (Inaccuracy / Mistake / Blunder), and a Blunder "throws away" an advantage another class
   "lets slip". A Miss says what was missed by the standing before it: "Misses the win
   for White (+3.0 → +0.5); a4 was winning.", "Lets the opponent off the hook …", "Leaves
   the opponent's mistake unpunished …". Every pair has a unit test
   (`review-explain.test.ts`); 6...Be6 of the reference game has a regression test.

The best move is named once: in the move card's line, and in the export as "Best: X."
only when the sentence doesn't already name it. Fallback sentences name it, so their
export carries no separate "Best:".

**The three sentences reported from https://lichess.org/Bjl39T9x**, now fixtures:
- 17.Nc4 "Hangs the knight on c4": the knight is defended by d3; ...Nxc4 dxc4 is an even
  trade (the static exchange also counted ...Qxc4 winning a pawn, which is not a hung
  knight). Now (Inaccuracy, depth 18) "Gives back some of White's winning advantage
  (+3.8 → +2.4); Qa4 was stronger."
- 20.cxd4 "…, trapping the queen on d1": after ...Rxd4 the queen has no safe square of its
  own but Bd2 blocks the attack. Now (Blunder) "Throws away White's winning advantage
  (+2.0 → −0.4); Bf4+ kept it."
- 15...axb5 "Allows axb5, winning the pawn on b5": axb5 is a recapture; the problem is
  the opened a-file, which no motif describes. Now (Mistake) "Turns Black's difficult
  position into a losing one (+1.3 → +2.8); Na5 held on."

## Motif detectors

Each detector looks at one move and the position before it (`src/review/motifs.ts`):

| Motif | Rule |
|-------|------|
| Hanging piece | After the move the opponent has a legal capture that wins material after the full exchange (SEE), more than the move itself captured, and at least the piece's worth (2 pawns for a piece, 1 for a pawn). Flagged as pre-existing if the piece was already en prise and the move ignored it. |
| Fork | The moved piece (not the king) attacks two or more enemy pieces, each the king, worth more than the forker, or loose. Pawns are not targets; the forker must not simply be lost on its square. |
| Pin / skewer | Along a line of the moved bishop, rook or queen, the first two pieces are enemy pieces. Pin: front piece is not a king or pawn and the back one is the king or worth more. Skewer: front is the king or worth more, back is not a pawn and can be won. The line must be new. |
| Discovered attack | The moved piece unmasks one of the mover's sliders onto the enemy king, a piece worth more than the slider, or a loose piece. |
| Back-rank | A rook or queen checks along the king's back rank, the king's three squares in front are blocked by its own pieces, and the king has no move. |
| Missed mate | The mover had a forced mate within the 5-move horizon, and the move neither mates nor keeps a mate within it. |
| Trapped piece | After the move an enemy knight, bishop, rook or queen is attacked and lost where it stands, and **no legal reply keeps it**: not a move of the piece, nor a block, a defence or a capture of the attacker. It must be newly trapped. A side in check is never reported. |
| Promotion threat | A pawn reaches its seventh rank with the promotion square empty, can't be won at once, and promoting would keep the new queen after the exchange on that square. |

Every motif has positive and negative fixtures (`motif-fixtures.json`, 35 cases, three of
them from the reference game). A negative case with a square only rules the motif out on
that square.

## Accuracy, ACPL and the bot level

All as on Lichess, so that Lichess's evaluations give Lichess's numbers:
- **Move accuracy** = 103.1668·e^(−0.04354·drop) − 3.1669 **+ 1**, clamped to 0–100
  (lila `AccuracyPercent.fromWinPercents`; the +1 is its "uncertainty bonus" for
  imprecise evaluations, and the code uses lila's full-precision constants).
- **Game accuracy** (lila `AccuracyPercent.gameAccuracy`): each move's accuracy is
  weighted by the standard deviation of White's win% over a sliding window (window =
  moves/10, clamped to 2–8; weight clamped to 0.5–12), and the side's result is the mean
  of that weighted average and the harmonic mean of its move accuracies.
- **ACPL** (lila `Accuracy.diffsList`): per side, the mean over **every** move of
  max(0, eval before − eval after) for the mover, evaluations clamped to ±1000 cp and a
  mate counted as ±1000, rounded. Lichess starts the game at 15 cp (`Cp.initial`); the
  app uses its engine's evaluation of the start position.
- **Bot level (approx.)**: the in-app bot level whose calibrated ACPL matches the side's
  ACPL on the bot calibration's own scale (`calibrationCentipawnLoss`: positions within
  ±650 cp, losses capped at 420), interpolated in log(ACPL); ≤400 / 2400+ outside the
  range, hidden under 8 counted moves.

**Why the performance rating became an approximate bot level (2026-10-18).** On the
reference game, players rated 1374 and 1397 got 794 and 1050 from the app's own review;
from Lichess's evaluations the same mapping gives ≈768 and ≈708 (on Lichess's ACPL scale
it would be ≤400 and ≈609). Two reasons it can't be fixed by retuning:
1. The anchors are the in-app bots (`npm run calibrate:bots`): limited Stockfish, which
   loses far less per move than a person of the same nominal rating (the "1400" bot plays
   at ACPL 37; these 1400 players played at 149 and 104 in a 2+1 bullet game).
2. One game's ACPL is dominated by a few large losses: White's two moves of 952 and
   941 cp are 55% of White's total.
Turning ACPL into a human rating needs (ACPL, rating, time control) data from human
games, which an offline app doesn't have, and invented anchors would be guesswork. So the
number now says what it measures, "played like the ≈700 bot", labelled "Bot level
(approx.)" with a tooltip that says it is not a rating estimate.

## The Lichess reference game

https://lichess.org/Bjl39T9x (2+1 bullet, White GEU3 1374, Black Lobo017 1397, 0-1 by
mate), fetched with `scripts/fetch-lichess-game.mjs` (needs a Lichess API token) into
`tests/fixtures/review/lichess-Bjl39T9x.json`. Fed Lichess's own evaluations
(`review-lichess.test.ts`):

| | Lichess | App, from Lichess's evals |
|---|---|---|
| Accuracy White / Black | 56 / 63 | 55.63 / 63.38 → **56 / 63** |
| ACPL White / Black | 149 / 104 | 149.00 / 103.52 → **149 / 104** |
| White inaccuracies / mistakes / blunders | 4 / 3 / 3 | **4 / 3 / 2 + 1 Miss** |
| Black inaccuracies / mistakes / blunders | 3 / 1 / 4 | **3 / 1 / 4** |

Every move gets the same label as on Lichess except 11.Na3 (Lichess: Blunder; app:
Miss, the app's name for an unpunished blunder by the opponent).

Differences from lila found on the way, and fixed:
- move accuracy lacked the +1 bonus (without it: 53.8 / 61.7);
- win% didn't clamp evaluations at ±1000 cp and counted mates as 100 / 0;
- ACPL skipped positions beyond ±650 cp, capped losses at 420 and used mates as
  ±(10000 − 10·n); Lichess counts every move with ±1000 clamping (that gave 88.5 / 94.2
  instead of 149 / 104 here);
- ACPL is rounded, not truncated (Black: 103.52 → 104).

Left as is, on purpose: Lichess starts from 15 cp, the app from its own evaluation of the
start position (only the first move is affected); the Miss, Great, Brilliant and Book
classes and the mate horizon (above).

With the app's own engine instead of Lichess's evaluations the numbers differ by however
much the engines differ. At depth 18 the lite Stockfish rates 15...axb5 a 12.2-point drop
(Mistake; Lichess's evaluations: 19.0, Blunder) and 17.Nc4 9.2 (Inaccuracy; Lichess
11.3, Mistake); 20.cxd4 is a Blunder in both.

## Quick preset vs. the depth-18 fixture settings

`npm run review:compare` reviews each game once at the fixture settings (depth 18) and
three times at Quick (0.2 s per position), all on **one thread** (the spec's review-speed
baseline, and the in-app review engine's thread count) with MultiPV 2, 32 MB hash and a
fresh `ucinewgame`. Depth 18 is reproducible; Quick isn't (a time limit stops at a
slightly different point each run), hence three runs. "Agree" counts Quick labels equal
to the depth-18 label for the same move, over all three runs. Re-measured 2026-10-18 with
Lichess's bands, the ±1000 cp ceiling and the same-root mate check (this machine, 8
cores; Stockfish 17.1 lite WASM in Node).

**Sample game** (Morphy vs. Duke Karl / Count Isouard, Paris 1858, 33 moves): **79 of 99
Quick labels agree (80%)**.

| Class at depth 18 | Moves | Quick labels that agree | Quick labels of this class | …that depth 18 agrees with |
|---|---|---|---|---|
| Brilliant | 1 | 3/3 (100%) | 3 | 100% |
| Great | 3 | 8/9 (89%) | 8 | 100% |
| Best | 12 | 34/36 (94%) | 38 | 89% |
| Excellent | 4 | 7/12 (58%) | 11 | 64% |
| Good | 2 | 1/6 (17%) | 11 | 9% |
| Book | 5 | 15/15 (100%) | 15 | 100% |
| Inaccuracy | 6 | 11/18 (61%) | 13 | 85% |
| Mistake | 0 | — | 0 | — |
| Blunder | 0 | — | 0 | — |
| Miss | 0 | — | 0 | — |

With Fischer vs. Spassky, Reykjavik 1972, game 6 (81 moves; 162 of 243 agree, 67%) for
more data, both games together:

| Class at depth 18 | Moves | Quick labels that agree | Quick labels of this class | …that depth 18 agrees with |
|---|---|---|---|---|
| Brilliant | 2 | 6/6 (100%) | 6 | 100% |
| Great | 3 | 8/9 (89%) | 8 | 100% |
| Best | 53 | 120/159 (75%) | 148 | 81% |
| Excellent | 22 | 35/66 (53%) | 80 | 44% |
| Good | 17 | 31/51 (61%) | 54 | 57% |
| Book | 9 | 27/27 (100%) | 27 | 100% |
| Inaccuracy | 8 | 14/24 (58%) | 19 | 74% |
| Mistake | 0 | — | 0 | — |
| Blunder | 0 | — | 0 | — |
| Miss | 0 | — | 0 | — |

What the numbers say:
- **Classes decided by a wide margin agree**: Book, Brilliant, Great (one Quick run
  called 12.O-O-O Best instead of Great).
- **Best** agrees 75–94%; most disagreements are Best ↔ Excellent (another equal-looking
  move on top at 0.2 s).
- **Excellent / Good / Inaccuracy disagree about half the time.** These are drops of 1–7
  points, and a 0.2 s search moves a drop by 1–3 points from run to run, enough to cross
  the 2 and 5 lines (e.g. 4...Bxf3: depth 18 drop 4.6, Quick 4.6–7.2; 3...Bg4: depth 18
  5.1, Quick 3.1–3.5). Lichess's lower Inaccuracy line (5 instead of 10) puts more moves
  near a line than before. Quick finds the errors and the critical moments; Standard or
  Deep grade small drops more steadily.
- **No false errors.** No Quick run labels a move Mistake, Blunder or Miss that depth 18
  doesn't. 15.Bxd7+ (part of Morphy's forced mate) was a false Blunder in one of three
  Quick runs before verification searches existed (2026-10-17), and again after the band
  change until the same-root mate check was added; it is Best in every run now.
- Accuracy (sample game): depth 18 gives White 98.3 / Black 84.2; the Quick runs gave
  97.9 / 88.1, 97.4 / 85.8 and 98.5 / 86.8.
- Speed on one thread: the sample game took 8.9–9.0 s (2 positions verified per run),
  the 81-move game 17.4 s, inside the spec's "40-move game in about 30 s" budget.

Earlier measurements (2026-10-17, the old bands ≤ 5 / ≤ 10 / ≤ 20 and mates as 100%):
sample game 78/99 (79%); both games Best 78%, Excellent 52%, Good 57%, Inaccuracy 63%.

## Fixtures

Labels and rationales were written from what each move means over the board, before the
classifier existed. Engine results are recorded once (`npm run fixtures:review`: single
thread, depth 18, MultiPV 2, cleared hash; recordings are byte-identical run to run), so
the unit tests are deterministic.

| Class | Fixtures |
|-------|----------|
| Book | `book-e4`, `book-philidor` |
| Best | `best-quiet-a4`, `best-recapture-is-not-great`, `best-punishes-hanging-knight`, `best-second-mate-in-one` |
| Excellent | `excellent-bb3`, `decided-winning-mate-delayed` |
| Good | `good-bd2`, `decided-lost-side-hangs-rook` |
| Inaccuracy | `inaccuracy-d4`, `decided-lost-side-allows-quick-mate`, `decided-misses-smothered-mate`, `decided-misses-mate-in-one-mate-far-away`, `lichess-17-nc4-even-trade` |
| Mistake | `mistake-g3-drops-e4-pawn`, `lichess-15-axb5-opens-a-file` |
| Blunder | `blunder-nh4-drops-e4-pawn`, `blunder-nd4-hangs-knight`, `blunder-ba6-hangs-bishop`, `blunder-unsound-sacrifice-bxf7`, `blunder-after-opponent-blunder-is-not-miss`, `decided-winning-allows-back-rank-mate`, `decided-winning-stalemates`, `blunder-throws-away-mate-entirely`, `lichess-20-cxd4-queen-not-trapped` |
| Great | `great-kpk-opposition` |
| Brilliant | `brilliant-legal-queen-sacrifice` |
| Miss | `miss-ignores-hanging-knight` |

Corrections made after recording (the labels were re-examined; thresholds only changed
where stated):
- At depth 18 the top move in the Italian position is a4 (+25), not h3 (+24), so the
  Best fixture plays a4.
- Bg5 turned out to be only ~10 cp worse than the best move (Excellent); the Good fixture
  uses Bd2 instead.
- "Misses mate in one but still mates": after h3 the mate is about 11 moves away, not a
  few. Relabelled Inaccuracy (the mate moved past the horizon).
- The back-rank fixture was +696 cp (below 95%); a white knight was added (+863).
- The smothered-mate fixture's rationale said the mate was gone after Kf1; at depth 18
  White still mates in 16. The label (Inaccuracy) stands; `blunder-throws-away-mate-
  entirely` was added for a mate that really disappears.
- **2026-10-18, Lichess's bands:** `mistake-nh4` (a 16.2-point drop: a pawn and the
  initiative) is a Blunder now and was renamed `blunder-nh4-drops-e4-pawn`; the new
  Mistake fixture is `mistake-g3-drops-e4-pawn` (4.g3? in the Two Knights, 13.5 points).
  A first candidate, h4 in the Italian position, recorded at 9.7, too close to the line.
  `best-punishes-hanging-knight` would have become Great (gap 17.0); taking material
  left en prise is now excluded from Great instead (rule above).
- **2026-10-18, the reference game:** three positions added as classification fixtures
  (labels as this engine sees them, with Lichess's in the rationale) and as negative
  motif fixtures.
