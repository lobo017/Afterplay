# Move classification

How the game review labels each move, with every rule and number and the reason for it.
The code is `src/review/classification.ts` (classes), `src/review/explain.ts`
(sentences), `src/review/motifs.ts` (motif detectors) and `src/review/review-runner.ts`
(engine budget and verification). The fixtures are
`tests/fixtures/review/classification-fixtures.json` and `motif-fixtures.json`.

## Inputs

- Every position of the game's main line is searched with **MultiPV 2**, on the preset's
  time per position (Quick 0.2 s, Standard 0.6 s, Deep 1.5 s), with the game's moves sent
  as history so the engine sees repetitions.
- Engine scores come from the side to move. The classifier works from the **mover's**
  view: the score before the move is the best line of the position it was played from;
  the score after it is the negated best line of the position that follows (the
  opponent's best reply).
- **Win%** = 50 + 50·(2/(1+e^(−0.00368208·cp)) − 1). A forced mate counts as 100 (the
  mover mates) or 0. Checkmate on the board is 100 for the side that gave it; stalemate
  and insufficient material are 50.
- **Win% drop** = max(0, win% before − win% after), for the mover.

Reference points on the curve: +1 pawn = 59.1%, +3 = 75.1%, +5 = 86.3%, **+8 = 95.0%**,
+10 = 97.5%, +15 = 99.6%.

## The classes, in the order they are decided

### Book

The position after the move is in the openings dataset (`data/openings.json`, matched by
EPD, with the en-passant field ignored when needed), **and every earlier move of the game
was Book as well**. A later transposition into a named position is a normal move: it was
found over the board, not from memory. Book overrides everything else, including the
engine's opinion, because a dataset line is a known opening, not an error of the player.

### Best: the engine's top move

A move is the top move when it is MultiPV line 1, or line 2 with exactly the same score
as line 1 (two equal moves, e.g. two mates in one), or when it delivers checkmate. A top
move is never an error, whatever the before/after numbers say (a deeper search after
the move can change the evaluation). Top moves are Best unless they are Great or
Brilliant.

### Great: the only move that keeps the result

A top move where the second-best move would have been a Blunder: win% of the best line −
win% of the second line > **20** (the Blunder threshold). Reason: "only move" in practice
means every alternative throws the result away, and a drop above 20 is exactly what the
review calls throwing the result away. Not Great:
- **recaptures** (capturing on the square where the opponent just captured): taking back
  a piece is the obvious only move, not a find (fixture `best-recapture-is-not-great`);
- **forced moves** (only one legal move, so no second line).

Example: the king-and-pawn opposition move ...Ke7 (`great-kpk-opposition`), and in the
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

The spec's starting thresholds, **unchanged**:

| Class | Win% drop | Move accuracy at the bound |
|-------|-----------|----------------------------|
| Excellent | ≤ 2 | 91.4 |
| Good | ≤ 5 | 79.8 |
| Inaccuracy | ≤ 10 | 63.6 |
| Mistake | ≤ 20 | 40.0 |
| Blunder | > 20 | — |

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
would make labels flicker. A mate past the horizon still counts as 100% win, so
mate-in-3 → mate-in-11 is a drop of 0 plus this Inaccuracy floor, never a Blunder.

When the mate is thrown away completely and the result changes, the drop does the work:
mate in 1 → a level rook ending is 100 → 45, a **Blunder**
(`blunder-throws-away-mate-entirely`); so is mate → stalemate
(`decided-winning-stalemates`).

### Decided positions (beyond ±95%)

The spec asks that already-decided positions don't produce false blunders. With the
thresholds unchanged, this follows from the win% curve and the rules above:
- The curve is flat beyond ±8 pawns: +10 → +8 is a drop of 2.5, so a winning side that
  wastes material while staying winning gets Excellent or Good
  (`decided-winning-mate-delayed`).
- The losing side's win% is already near 0: hanging a rook at −8 (4.9% → 0) is Good
  (`decided-lost-side-hangs-rook`), and allowing a short mate is the Inaccuracy floor
  (`decided-lost-side-allows-quick-mate`), not a Blunder.
- Only moves that change the result move win% a lot: a won position allowing a back-rank
  mate (`decided-winning-allows-back-rank-mate`) or stalemate is a Blunder, as it should
  be.

The unit test "decided positions never produce a Mistake or Blunder unless the result
changes" checks every `decided-*` fixture against this.

### Miss: the opponent's error went unpunished

Checked last, on top of the drop class:
- the opponent's previous move handed over **more than 10** win% (it was a Mistake or a
  Blunder by the same thresholds), measured as the mover's win% now minus the mover's
  win% before that move;
- this move drops **more than 5** (an Inaccuracy or worse);
- it gives back **at least half** of what the opponent's error handed over;
- the mover ends **no more than 10 points worse** than before the opponent's error.

The last bound separates a Miss from a Blunder: ignoring a hanging knight and then
hanging a bishop leaves Black worse than before White's mistake, which is Black's own
Blunder (`blunder-after-opponent-blunder-is-not-miss`), while ignoring it and drifting
back to equality is a Miss (`miss-ignores-hanging-knight`).

## Verification searches

A 0.2 s search sometimes sees a mate on one side of a move and misses it on the other.
That shows up as a large false drop. It happened in the sample game:
15.Bxd7+ (part of Morphy's forced mate) was a Blunder in one of three Quick runs before
this rule existed. So:
- when a move's first-pass class is **Mistake, Blunder or Miss**, or a short forced mate
  appears or disappears across it (the two mate rules above), the positions before and
  after the move are searched again for longer: **Quick 1 s, Standard 2 s, Deep 3 s**;
- each position is verified at most once, and the deeper of the two results is kept;
- then the move is classified from the verified positions.

This doesn't move any threshold; it makes sure the numbers that reach them come from a
search deep enough to trust. Only a handful of positions per game qualify, so the review
stays well inside the speed budget. Fixed-depth reviews (the fixture settings) skip it.

## Explanations (one sentence per Inaccuracy, Mistake, Blunder or Miss)

Tried in order; the first rule that applies writes the sentence.

1. **Stalemate from a won position**: "Stalemates the opponent; Qc8# was mate."
2. **The opponent can now force mate**: mate in one → "Allows Re1#, a back-rank mate."
   (or "…, an immediate mate."); longer → "Allows mate in 2, starting with Qd8+."
3. **A short mate was missed**: "Misses mate in 1 with Nf7#." / "Misses mate in 3,
   starting with …".
4. **Miss**: what the best move would have done: "Misses exd4, which wins the knight on
   d4." (a winning capture), or the motif it creates ("…, forking the king and rook"),
   or "…, which keeps the advantage from the opponent's mistake."
5. **Material left en prise**, when the opponent's best reply takes it:
   "Hangs the knight on d4 to exd4."; a sacrifice that doesn't work: "Gives up the
   bishop on f7 for a pawn; Rxf7 takes it."; a piece that was already attacked and was
   ignored: "Leaves the rook on d3 hanging to Bxd3+."
6. **The opponent's best reply is a tactic**: "Allows Nxe4, a discovered attack on the
   knight on h4.", "Allows Nc2+, forking the king and queen.", pins, skewers, trapped
   pieces, promotion threats, or a plain winning capture.
7. **No concrete tactic**: what happened to the evaluation, with the better move:
   "Hands the opponent the advantage; a4 was better." / "Lets part of the advantage
   slip; …" / "Loses ground; …".

Every motif found on the way is stored with the move, tagged with whose move it belongs
to (`played`, `refutation`, `missed`), for the insights dashboard later.

## Motif detectors

Each detector looks at one move and the position before it (`src/review/motifs.ts`):

| Motif | Rule |
|-------|------|
| Hanging piece | After the move the opponent has a legal capture that wins material after the full exchange (SEE), more than the move itself captured. Flagged as pre-existing if the piece was already en prise and the move ignored it. |
| Fork | The moved piece (not the king) attacks two or more enemy pieces, each the king, worth more than the forker, or loose. Pawns are not targets; the forker must not simply be lost on its square. |
| Pin / skewer | Along a line of the moved bishop, rook or queen, the first two pieces are enemy pieces. Pin: front piece is not a king or pawn and the back one is the king or worth more. Skewer: front is the king or worth more, back is not a pawn and can be won. The line must be new. |
| Discovered attack | The moved piece unmasks one of the mover's sliders onto the enemy king, a piece worth more than the slider, or a loose piece. |
| Back-rank | A rook or queen checks along the king's back rank, the king's three squares in front are blocked by its own pieces, and the king has no move. |
| Missed mate | The mover had a forced mate within the 5-move horizon, and the move neither mates nor keeps a mate within it. |
| Trapped piece | After the move an enemy knight, bishop, rook or queen is attacked and lost where it stands, and every move it has also loses material; it must be newly trapped. A side in check is never reported (the check, not the piece's surroundings, limits its moves). |
| Promotion threat | A pawn reaches its seventh rank with the promotion square empty, can't be won at once, and promoting would keep the new queen after the exchange on that square. |

Every motif has positive and negative fixtures (`motif-fixtures.json`, 32 cases).

## Accuracy, ACPL and performance

- **Move accuracy** = 103.1668·e^(−0.04354·drop) − 3.1669, clamped to 0–100.
- **Game accuracy** (Lichess method): each move's accuracy is weighted by the standard
  deviation of White's win% over a sliding window around it (window = moves/10, clamped
  to 2–8; weight clamped to 0.5–12), and the side's result is the mean of that weighted
  average and the harmonic mean of its move accuracies.
- **ACPL**: average centipawn loss over moves played in positions within ±650 cp with at
  least two legal moves, each loss capped at 420 cp, mates as ±(10000 − 10·n). The same
  rules as `npm run calibrate:bots`, so the two scales match.
- **Performance rating**: the in-app bot level whose calibrated ACPL matches, interpolated
  in log(ACPL) between levels; shown as ≤400 or 2400+ outside the calibrated range, and
  only with 8 or more counted moves.

## Fixtures

Labels and rationales were written from what each move means over the board, before the
classifier existed. Engine results are recorded once (`npm run fixtures:review`: single
thread, depth 18, MultiPV 2, cleared hash; two recordings are identical), so the unit
tests are deterministic.

| Class | Fixtures |
|-------|----------|
| Book | `book-e4`, `book-philidor` |
| Best | `best-quiet-a4`, `best-recapture-is-not-great`, `best-punishes-hanging-knight`, `best-second-mate-in-one` |
| Excellent | `excellent-bb3`, `decided-winning-mate-delayed` |
| Good | `good-bd2`, `decided-lost-side-hangs-rook` |
| Inaccuracy | `inaccuracy-d4`, `decided-lost-side-allows-quick-mate`, `decided-misses-smothered-mate`, `decided-misses-mate-in-one-mate-far-away` |
| Mistake | `mistake-nh4` |
| Blunder | `blunder-nd4-hangs-knight`, `blunder-ba6-hangs-bishop`, `blunder-unsound-sacrifice-bxf7`, `blunder-after-opponent-blunder-is-not-miss`, `decided-winning-allows-back-rank-mate`, `decided-winning-stalemates`, `blunder-throws-away-mate-entirely` |
| Great | `great-kpk-opposition` |
| Brilliant | `brilliant-legal-queen-sacrifice` |
| Miss | `miss-ignores-hanging-knight` |

Corrections made after recording (the labels were re-examined; no threshold changed):
- At depth 18 the top move in the Italian position is a4 (+25), not h3 (+24), so the
  Best fixture plays a4.
- Bg5 turned out to be only ~10 cp worse than the best move (Excellent); the Good fixture
  uses Bd2 instead.
- "Misses mate in one but still mates": after h3 the mate is about 11 moves away, not a
  few. Relabelled Inaccuracy (the mate moved past the horizon).
- The back-rank fixture was +696 cp (below 95%); a white knight was added (+863).
- The smothered-mate fixture's rationale said the mate was gone after Kf1; at depth 18
  White still mates in 16. The label (Inaccuracy) stands; the rationale was corrected,
  and `blunder-throws-away-mate-entirely` was added for a mate that really disappears
  (mate in 1 → Black +0.50 in a level rook ending).

## Quick preset vs. the depth-18 fixture settings

`npm run review:compare` reviews each game once at the fixture settings (depth 18) and
three times at Quick (0.2 s per position), all on **one thread** (the spec's review-speed
baseline) with MultiPV 2, 32 MB hash and a fresh `ucinewgame`. Depth 18 is reproducible;
Quick isn't (a time limit stops at a slightly different point each run), hence three
runs. "Agree" counts Quick labels equal to the depth-18 label for the same move, over
all three runs. Measured 2026-10-17 on this machine (8 cores; Stockfish 17.1 lite WASM in
Node).

**Sample game** (Morphy vs. Duke Karl / Count Isouard, Paris 1858, 33 moves): **78 of 99
Quick labels agree (79%)**.

| Class at depth 18 | Moves | Quick labels that agree | Quick labels of this class | …that depth 18 agrees with |
|---|---|---|---|---|
| Brilliant | 1 | 3/3 (100%) | 3 | 100% |
| Great | 2 | 6/6 (100%) | 6 | 100% |
| Best | 13 | 36/39 (92%) | 39 | 92% |
| Excellent | 4 | 6/12 (50%) | 12 | 50% |
| Good | 2 | 1/6 (17%) | 9 | 11% |
| Book | 5 | 15/15 (100%) | 15 | 100% |
| Inaccuracy | 6 | 11/18 (61%) | 14 | 79% |
| Mistake | 0 | — | 1 | 0% |
| Blunder | 0 | — | 0 | — |
| Miss | 0 | — | 0 | — |

The sample game has few moves per class, so a second, longer game was run the same way
for more data: **Fischer vs. Spassky, Reykjavik 1972, game 6** (81 moves): 166 of 243
agree (68%). Both games together:

| Class at depth 18 | Moves | Quick labels that agree | Quick labels of this class | …that depth 18 agrees with |
|---|---|---|---|---|
| Brilliant | 2 | 6/6 (100%) | 6 | 100% |
| Great | 2 | 6/6 (100%) | 6 | 100% |
| Best | 54 | 127/162 (78%) | 153 | 83% |
| Excellent | 22 | 34/66 (52%) | 80 | 43% |
| Good | 17 | 29/51 (57%) | 46 | 63% |
| Book | 9 | 27/27 (100%) | 27 | 100% |
| Inaccuracy | 8 | 15/24 (63%) | 23 | 65% |
| Mistake | 0 | — | 1 | 0% |
| Blunder | 0 | — | 0 | — |
| Miss | 0 | — | 0 | — |

What the numbers say:
- **Classes decided by a wide margin agree completely**: Book, Brilliant and Great.
- **Best** agrees 78–92%. Most disagreements are Best ↔ Excellent: at 0.2 s a different,
  equal-looking move is sometimes on top.
- **Excellent / Good / Inaccuracy disagree about half the time.** These are drops of 1–6
  points, and a 0.2 s search moves a drop by 1–3 points from run to run, which is enough
  to cross the 2 and 5 thresholds (e.g. 8.Nc3 in the sample game: depth 18 drop 1.7,
  Quick 3.2–6.5). Quick runs also disagree with each other on these moves. Quick is good
  for finding the errors and the critical moments; for fine grading of small drops use
  Standard or Deep.
- **The one Quick Mistake** is 10...cxb5 (depth 18: Inaccuracy, drop 9.0; that Quick
  run: 10.6), a borderline case on the 10-point line.
- **No false Blunders.** Before the verification searches were added, one of three Quick
  runs called 15.Bxd7+ (part of Morphy's forced mate) a Blunder (drop 21.6): the search
  before the move saw the mate, the one after it didn't. With verification, 15.Bxd7+ is
  Best in every run, and no Quick run produces a Blunder that depth 18 doesn't. That
  first measurement (same settings, no verification) agreed on 79/99 labels in the
  sample game, so verification doesn't change overall agreement; it removes the
  harmful errors.
- Accuracy (sample game): depth 18 gives White 97.8 / Black 83.0; the three Quick runs
  gave 97.2 / 83.9, 96.8 / 86.0 and 97.9 / 82.4. (Before verification, the false
  Blunder had dropped one run's White accuracy to 86.3.)
- Quick on one thread: the sample game took 8.9–11.9 s (2–5 verified positions) and the
  81-move game 17.3–17.5 s, inside the spec's "40-move game in about 30 s" budget.

The in-app review engine also runs one thread (the measured default, PROGRESS.md
Phase 5), so these numbers describe what the app's Quick preset does; in the browser
the 81-move game reached a similar mean depth (14–16) in 18–19 s.
