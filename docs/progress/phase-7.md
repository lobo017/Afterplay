# Phase 7 — Repertoire, endgame & visualization trainers (archive)

Detailed log, moved out of PROGRESS.md when the phase was done. Started and finished 2026-10-26.

## Plan (as written before any code)

The plan below is verbatim. Two numbers in it were superseded once an exact solver was added
(K+Q v K ended at 7, not 8; K+P at 11, not 12): see "What the data check found".

Status: in progress (started 2026-10-26). The SPEC section was updated first, as asked.

Findings that shape the plan (engine probes, Stockfish 17.1 lite, single thread):
- `data/endgames.json` is wrong in four places: K+Q v K is mate in **8** (file: 10), K+R v K **14**
  (file: 16, the worst case over all positions), K+P opposition **12** (file: 11), and the R+P v R
  position is a **draw** (engine 0.00 at depth 40), so its 1-0 target is unreachable. Mate distances
  only settle deep: KPK reads 14 at depth 40, 13 at 44, 12 at 50–80; KRK 16 at depth 36, 15 at 44, 14 at
  52–70. The data test therefore searches to depth 60 and checks the score again 10 plies deeper.
- Lucena (+6.6 at depth 24, mate 26 at depth 40) and Philidor (0.00) check out. The engine also finds long
  forced mates for Lucena and the replacement R+P v R, so "no forced mate" is not literally true for
  them; their goal is promotion, not mate, so move counts stay untracked as the spec says.

Files to add
- `src/trainers/repertoire.ts` (pure: position keys, tree merge, PGN import, drill walk, departure
  finder), `repertoire-store.ts` (IndexedDB record + FSRS cards, deck `repertoire`),
  `repertoire-trainer.ts` (UI, lazy chunk).
- `src/trainers/endgames.ts` + `endgame-session.ts` (pure rules of a drill), `endgame-store.ts`,
  `endgame-trainer.ts` (UI, lazy chunk).
- `src/trainers/visualization.ts` (pure: coordinate rounds, blindfold questions, guess-the-move
  positions, grading), `visualization-store.ts`, `visualization-trainer.ts` (UI, lazy chunk).
- `src/trainers/drill-store.ts`: due counts of the three new decks for Today and the Train tab.
- Tests: `tests/unit/endgame-data.test.ts` (engine check), `repertoire.test.ts`,
  `endgame-session.test.ts`, `visualization.test.ts`, `drill-store.test.ts`;
  `tests/e2e/phase7-trainers.spec.ts` (one drill per trainer, review flag, screenshots).

Files to change
- `scripts/build-endgames.mjs` + `data/endgames.json` (corrected), `core/datasets.ts`
  (`optimalMoves: number | null`), `storage/db.ts` (card deck `visualization`, optional progress fields;
  no schema bump: the new fields are optional and decks are not indexed values).
- `app.ts` (Train hub: trainer tiles, session switch, lazy loading, Start training picks across
  decks), `trainers/today-screen.ts` (cards for the three decks), `review/review-panel.ts` (repertoire
  note), `styles/main.css`.

Risks
- Endgame drills against the engine need an end: wins end at mate, or at promotion once the engine
  rates the position decisive (Lucena, R+P v R); the draw ends by rule or an accepted draw offer.
- Fresh profiles must look unchanged (no due badge, `Rated puzzles near 1500`): only cards that exist
  count, and endgame and visualization cards are created by the first attempt.
- The review must not shift when switching perspective: the repertoire note does not depend on it.

## What the data check found

`tests/unit/endgame-data.test.ts` asks Stockfish 17.1 (the app's single-threaded lite build, in
Node) about every position. The first draft of `data/endgames.json` was wrong in four places.
The 10 and 16 for K+Q v K and K+R v K are the longest mates over *all* positions of those endings,
not the distance from these positions.

| Position | File had | Engine, depth 30–44 | Engine, deep | Exact (retrograde) | Now |
|----------|----------|---------------------|--------------|--------------------|-----|
| K+Q v K | mate 10 | 8 | 7 from depth 50 | 7 | **7** |
| K+R v K | mate 16 | 16 at 36, 15 at 44 | 14 from depth 52 | 14 | **14** |
| K+P opposition | mate 11 | 14 at 40, 13 at 44 | 12 at 50–80, 11 from 100 | 11 | **11** (the file was right) |
| Lucena | win, 14 | +6.6 at depth 24 | mate 26 at depth 40 | – | win, result only |
| Philidor | draw, 15 | 0.00 | 0.00 (and 1...Ra6 holds it, −0.04) | – | draw, result only |
| R+P v R | win, 16 | **0.00 at depth 40: a draw** | – | – | position replaced |

- The engine's mate distance is not proven at any shallow depth: the score only settles once the
  search is far past twice the mate length (K+P v K needed depth ≥ 100). So the test searches to
  60 / 70 / 110 plies (K+Q / K+R / K+P) and again 10 plies deeper, and also compares with an exact
  distance from a retrograde solver (`tests/helpers/dtm-oracle.ts`, ~8 s, checks itself against the
  known longest mates 10, 16 and 28). Engine and solver agree.
- R+P v R: `3k4/8/3KP3/8/8/8/r7/4R3 w` is a theoretical draw, so its target (1-0) was unreachable.
  Replaced by `7k/8/4P3/3K4/8/8/r7/5R2 w` (rook cutting the Black king off on the f-file, pawn on e6
  supported by the king): +mate 20 at depth 28. Driving it with the engine's own moves, the drill
  ends after 3 moves (1.e7 Rf8… promotes, the engine rates it decided).
- The spec's "positions without a forced mate (Philidor, Lucena, R+P v R)" is not literally true for
  Lucena and R+P v R: the engine finds mates (26 and 20 moves). They are still result-only drills,
  as the instruction says, because their goal is the conversion, not the mate.
- Test cost: 88 s for the whole data test (solver 17 s, K+R v K 24 s, K+P v K 36 s).

## What was built

- **Train hub**: a Trainers row of four tiles (Puzzles, Repertoire, Endgames, Visualization, each
  with a line of progress) above Today; Today has three new cards (repertoire positions, endgame
  drills due, visualization drills due). "Start training" opens whatever has the most to do:
  due puzzle reviews, then repertoire positions (due or new), due endgames, due visualization,
  then new puzzles from my games, then rated puzzles. The count on the Train tab adds them all.
  Each trainer is its own lazy chunk (repertoire 19.1 kB, endgames 14.1 kB, visualization 22.4 kB,
  shared kit 1.8 kB); leaving Train (or the session) drops a drill that was under way.
- **Repertoire** (`repertoire.ts`, `repertoire-store.ts`, `repertoire-trainer.ts`):
  - One White and one Black repertoire (`repertoire-w`, `repertoire-b`), each a `GameTree`
    stored in the existing `repertoires` store. Build: play moves on the board (either side:
    mine are the moves I'll play, the opponent's the replies I expect), or import a PGN (every game
    and variation; games from a custom position or Chess960 are left out and said so; comments and
    NAGs are kept). The move list shows the main line and variations; moves are deletable.
  - A position is a card: key = EPD of the position (board, side, castling, en passant), so move
    orders that transpose share one card. Cards are made when the repertoire is saved (new ones for
    each position where I have a move, deleted ones removed), in deck `repertoire`.
  - Drill: a walk down the tree. The opponent's moves are played for me, and so are my moves in
    positions that aren't due; in a due position I must play any move the tree has there (the walk
    follows the one I play). Right first time = Good, right after a hint = Hard, a miss or "Show
    answer" = Again. The walk heads for the first due position and on towards more of them.
  - Review flag (`findDeparture`): for my own games (side from `defaultPerspective`, i.e. by my
    usernames) the review shows one line: `left` (I played a move the repertoire hasn't, with the
    moves it has), `opponent-left` (no reply prepared), `ended` (followed to the end of a line) or
    `followed` (the game ended inside it), with a button to the move. Positions are compared, not
    move orders, so transpositions stay inside. Nothing for games that aren't mine or when my side's
    repertoire is empty.
- **Endgames** (`endgames.ts`, `endgame-session.ts`, `endgame-store.ts`, `endgame-trainer.ts`):
  - Goal derived from the data: `mate` (K+Q, K+R, K+P: has `optimalMoves`), `convert` (Lucena, R+P v R:
    promote or win the last piece and the engine's score for me is ≥ +5.00 or a mate), `hold`
    (Philidor: a draw by the rules, or an accepted draw offer after 10 moves of mine, accepted while
    the engine sees at most +0.30 for itself). Any end other than the target is a miss.
  - The opponent is the app's engine at 200 ms a move; Hint shows the engine's move (300 ms) and
    caps the grade at Hard; Restart, Give up and Flip are in a menu. A soft warning appears when
    the engine sees a win slipping (below +0.50) or a draw failing (the opponent above +2.00); it
    never ends the drill.
  - Progress per position (store `endgame_progress`): attempts, completions, fewest moves without a
    hint against the best possible (mate drills only), last result. Card (deck `endgame`) made by the
    first drill. Grade: miss Again; any hint Hard; mate drill Easy at the ideal count or better, Good
    within 4 moves of it, Hard beyond; convert/hold Good.
- **Visualization** (`visualization.ts`, `visualization-store.ts`, `visualization-trainer.ts`):
  - Coordinates: a 30 s round on an empty board without labels (from either side); a wrong click
    counts and moves on. Grade by squares found and accuracy (Again < 10 or 60%, Hard to 20 / 80%,
    Good to 35 / 90%, Easy above).
  - Blindfold: the first N plies of a line (opening lines from the openings dataset, the sample game,
    my games) are read out as text with the board empty ("Black: Knight to c6" and the SAN), then 5
    questions "Where is the black queen?" answered by clicking the square (any square holding that
    piece counts; pieces that moved are asked first). N starts at 8, +2 after a perfect drill, −2
    after two misses (4–60). Grade: all right Good, one miss Hard, more Again. The board then shows
    the real position.
  - Guess the move: through my own games (my side by usernames), up to 10 positions per game spread
    over it (not my first 3 moves, not forced moves): play the move I played; the review's best
    move also counts when the game was reviewed. Card per game (`guess:<game id>`); the game that is
    due, then one never guessed, then the one guessed longest ago.
  - Cards live in deck `visualization`: `coordinates`, `blindfold`, `guess:<id>`; stats in the
    settings store (`viz.coordinates`, `viz.blindfold`, `viz.guess`), so a backup carries them.
- **Storage**: no schema bump. `srs_cards.deck` gains `visualization`; `endgame_progress` gains
  optional `completions`, `lastAttemptAt`, `lastReached`, `lastMoves`, and `optimalMoves` may be null.
  Restoring a backup reloads the repertoire cache and every open trainer.

## Decisions

- Cards for the new decks only exist once there is something to learn (a saved repertoire, a first
  drill), so a fresh profile shows nothing due and `Rated puzzles near 1500` as before.
- Wins that take dozens of moves to mate (Lucena, R+P v R) end at the conversion. Playing on to mate
  would be real chess but the drill is about the technique.
- Draw by agreement needs 10 of my moves, so a draw can't be "claimed" at the start of a position
  that is equal from move 1 (the Philidor position is 0.00 at once).
- No "practise anyway" in the repertoire drill when nothing is due; Endgames and Visualization can
  always be played from their own screens.
- The player always plays the side to move (so Philidor is played as Black, with the board flipped).

## Tests

- Unit: 555 in 46 files (was 461 in 41): `endgame-data` (13: the engine and solver check),
  `repertoire` (29: tree building, PGN import, drill, departures, store), `endgame-session` (17),
  `visualization` (19), `drill-store` (15: progress, due counts, backup carries the new data).
- Full run on the final build: 555 unit and 134/134 e2e (11.2 min, one worker); typecheck, lint and build clean.
- E2E `phase7-trainers.spec.ts` (21 tests): the hub and its Today cards on a fresh profile, chunks not
  loaded until opened, a repertoire built by import and by playing, drilled line by line until nothing
  is due (with a refused wrong move), the Today card and Start training opening it, the review flag
  for left / opponent-left / ended / not-my-game, K+Q v K played to mate with hints and recorded,
  R+P v R and Lucena converted, Philidor held and a draw agreed, give up / restart / draw offered too early,
  a coordinate round and the 30 s clock, a blindfold drill (level up), a guess-the-move game with a
  wrong guess, no games of mine, the due order puzzles → repertoire → endgames → visualization, and
  phone width for each trainer (no sideways scroll, board ≥ 370 px).
- Screenshots (`test-results/phase7-screens/`, looked at): desktop hub, hub with things due, repertoire
  empty / build / drill / done, review note, endgame start / hint / done / Lucena, coordinates,
  blindfold reading and question, guess the move and its result, and phone hub, repertoire build and
  drill, endgame, coordinates and blindfold. Found and fixed from them: the endgame list took half
  the panel (now a 2 × 3 grid), the blindfold card showed a dash instead of the question (one stage
  line now), board labels were hidden in blindfold where the answer is a square (shown again),
  the hint message was cut off, and idle drill buttons were gold.

## Measurements

- Main bundle 1,449.47 kB (269.71 kB gzip), up 29 kB from 1,420.22 kB: the tiles, three Today cards,
  the pure repertoire module (also used by the review) and the review note. Everything else is in the
  lazy chunks above.
- `perf:drag` was not run again: no board, engine or input code changed, and the trainer boards only
  exist once a trainer has been opened.

## A bug found on the way (Phase 6b code)

The first full e2e run failed `phase6b-board-feel` ("remembers the values" after a reload: 1.12, not 1.25)
and it failed 2 of 3 alone. Cause: `Preferences.attach` only trusted this device's copy when the app
settings key existed in localStorage; a board feel (or board size) tuned just before a reload, with no app
setting ever changed, was replaced by the database record, which lags 300 ms behind. It now trusts any of the
three keys. Unit test added (fails without the fix).

## Known issues and open items

- Lucena played out with the engine's own hints ends "converted" after 8 moves (Rd1+, Rd4, the king walks
  to b5, b8=Q) with no false "slipping" warning on the way; R+P v R after 3.
- The "slipping" warning uses a 200 ms search; early in a hard position (Lucena before the bridge) it
  can say the engine sees equality when a deeper search sees +6.6. It is only a warning.
- The opponent isn't a tablebase: against K+Q v K and K+R v K its defence at 200 ms is good but not
  perfect, so a drill can end in fewer moves than the ideal (graded Easy).
- Comments from an imported PGN are kept in the tree but not shown; the repertoire builder has no
  comment editor, and no "clear repertoire" (delete moves one branch at a time).
- Blindfold lines longer than about 16 plies come only from the sample game and my games.
- Today and the tiles refresh when a drill is recorded or the hub is shown; a puzzle solved while
  the hub is on screen updates them on the next visit (as before).

## Follow-ups (2026-10-26): exact endgame defender, practise anyway

Committed as "Phase 7: exact endgame defender, practise anyway".

- **Exact defender.** `src/trainers/endgame-tables.ts` is a retrograde solver for K+Q v K, K+R v K and K+P v K
  (White has the piece): the White-to-move and Black-to-move distance-to-mate tables as `Int8Array`s (64³ each),
  with attack tables precomputed and work lists that shrink every sweep. All three solve in ~1.4 s in Node
  (the slow independent oracle in `tests/helpers/dtm-oracle.ts` takes ~8 s). `EndgameTables.defend(fen)` returns
  Black's reply: take the piece when it is unprotected (a draw), else keep the position unwon, else put the mate
  as far away as possible; `stillWon` / `mateIn` come with it. The solver runs in `endgame-tables.worker.ts`
  behind `EndgameTablesClient` (inline where there is no `Worker`); the trainer warms it in the constructor.
  No data file: the tables are computed once per page, nothing is stored.
- **Where it applies.** Only mate drills (`kq-vs-k`, `kr-vs-k`, `kp-opposition`), and only while the position is
  exactly K + one of Q/R/P v K (so after a queen or rook promotion it carries on in K+Q / K+R tables; a knight
  or bishop promotion falls back to the engine and is a draw anyway). Everything else keeps the engine at 200 ms.
  The "slipping" warning in these drills is exact too: "the win is gone with best play".
- **Tests.** `tests/unit/endgame-tables.test.ts` (10): longest mates 10 / 16 / 28; the solver agrees with the
  independent oracle on 7,500 random positions; the three drill positions give 7 / 14 / 11; for 4,500 random
  Black-to-move positions the defender's move is legal (chess.js) and its mate distance (oracle) equals the
  best over all legal replies, capture and unwon counted as escapes; best attacker play (chess.js moves +
  oracle) against the defender mates in exactly 7 / 14 / 11 moves. E2E (`phase7-trainers.spec.ts`, 3 tests): the
  same attacker drives each drill through the UI, every reply the app plays is checked against the oracle, and
  the drill ends in exactly the stored count with `bestMoves` recorded.
- **Practise anyway.** In the repertoire Drill tab, when nothing is due (and the repertoire has positions of
  mine), "Start drill" gives way to a primary "Practise anyway": a drill over every position of mine, in the
  same line walk. Nothing is graded and no card changes (the e2e test compares every card's state, reps and due
  date before and after); the end says "Practice line complete" and offers "Practise another line".
