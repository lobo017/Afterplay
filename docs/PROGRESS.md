# Wizard's Chess — Progress

This is the short, always-read file. The full per-phase logs (plans, results, test counts, probes)
are archived verbatim in `docs/progress/`; open one only when the work needs that history.
Procedure for a new phase: add a short plan here first, and when the phase is done move its detailed
log to `docs/progress/phase-N.md` and keep only a summary here.

## Phase status

| Phase | Name | Status | Summary | Archive |
|-------|------|--------|---------|---------|
| 0 | Audit and scaffold | Done | Legacy audit, Vite + TS strict scaffold, GPL-3.0, dataset scripts and generated data (openings, puzzles, endgames) | [phase-0](progress/phase-0.md) |
| 1 | Core | Done | Rules adapter (chess.js, Chess960, perft), game tree, adversarial PGN parser/writer (`[%eval]`, `[%cal]`, `[%csl]`), IndexedDB v1→v3 migrations | [phase-1](progress/phase-1.md) |
| 2 | Engine | Done | Stockfish 17.1 WASM worker client (MT + ST), MultiPV 1–5, priority queue, LRU cache, human-like bot (400–2400), `go perft` cross-check | [phase-2](progress/phase-2.md) |
| 3 | 2D board and play mode | Done | Imperative SVG board, canvas particle pool, Web Audio synth, clocks, vs-bot play, premoves, drag cancel, bot strength scaling | [phase-3](progress/phase-3.md) |
| 4 | Analysis board | Done | Mate-aware eval bar, MultiPV lines + ghost preview, arrows, variation tree, FEN editor, ECO lookup | [phase-4](progress/phase-4.md) |
| 3–4 fixes | Handover baseline, bot worker, perf/e2e harness hardening (2026-10-16/17) | Done | Layout-shift fixes, drags survive updates, bot move selection in a worker, hardened `perf:drag`, process-safety, engine thread changes restart the worker | [phase-3-4-fixes](progress/phase-3-4-fixes.md) |
| 5 | Game review | Done | MultiPV 2 review pipeline on its own 1-thread engine, Lichess-matched formulas, 10 move classes, 8 motif detectors, explanations in a worker, review panel, perspective + summary | [phase-5](progress/phase-5.md) |
| 5b | Capture extension + Games list | Done | Chrome MV3 extension (Lichess, Chess.com), localhost bridge, Games list with background review queue, IndexedDB v4, live capture fixes, delivery outcomes; `npm run serve` redirects to one origin | [phase-5b](progress/phase-5b.md) |
| 6 | Puzzles & spaced repetition | Done | Personal mistake puzzles, bundled 20k Lichess puzzles, Glicko-2, FSRS, Today screen | [phase-6](progress/phase-6.md) |
| 6b | UX redesign | Done | Board feel + badges; app frame (Play / Train / Review / Games + Settings sheet); all six stages committed (last `23f5d47`) | [phase-6b](progress/phase-6b.md) |
| 7 | Repertoire, endgame & visualization | Done | White/Black repertoire trees (build, import, drill, review flag), 6 engine-verified endgame drills, coordinate/blindfold/guess-the-move; all feed Today with the puzzles | [phase-7](progress/phase-7.md) |
| 8 | Library, insights, settings, offline | Pending | Auto-save library, worker bulk PGN import, insights charts, a11y, full offline PWA | — |
| 9 | Performance pass & final audit | Pending | Frame-time/memory/startup profiling against budgets and full spec verification | — |

## Current phase and next step

Phase 7 is done (committed as "Phase 7: …"). Next: Phase 8 (library, insights, settings, offline). Write its plan here before any code.

## Open decisions

- **`PERF_ENGINE_THREADS` matrix** (4/3/2 threads × ghosts off) was never run; the setting is
  re-enabled via `EngineClient.configure()` (6b18a4c). Run only if Phase 9 profiling suggests
  scenario 2 is thread-bound. Whether to drop analysis threads while a background review runs is
  also unmeasured ([phase-3-4-fixes](progress/phase-3-4-fixes.md)).
- **Review engine threads:** decided 1 thread (`REVIEW_ENGINE_THREADS` in `app.ts`); more threads
  bought no depth and cost live analysis speed ([phase-5](progress/phase-5.md)).
- **Bot level calibration** is approximate by design; no human data offline.
- **Prettier:** `npm run format:check` fails on most files (code uses longer lines than
  `.prettierrc.json`'s 100). Not a required check; left alone.

## Known issues

Phase 7 (details in [phase-7](progress/phase-7.md))
- `data/endgames.json` was wrong (K+Q v K 10 → 7, K+R v K 16 → 14, R+P v R was a draw: position replaced);
  `tests/unit/endgame-data.test.ts` now checks every position with the engine (~90 s) and mate counts also
  against an exact solver. Re-run it after any change to the positions.
- Follow-ups done ("Phase 7: exact endgame defender, practise anyway"): K+Q / K+R / K+P v K are now defended
  from exact tables (`endgame-tables.ts`, solved in a worker in ~1.4 s), so the opponent always prolongs the
  mate and "moves vs best" is honest; every other position (and Hint, and the Lucena / R+P v R / Philidor
  drills) still uses the engine at 200 ms. The repertoire drill has "Practise anyway" when nothing is due
  (every position asked, nothing graded). Details in [phase-7](progress/phase-7.md).
- The repertoire builder shows no PGN comments and has no clear-all (delete branch by branch). Blindfold lines
  over ~16 plies come only from the sample game and my games. Hint in a mate drill is still the engine's move
  (300 ms), not always the shortest mate, which is why a hinted drill is graded Hard at best.
- Fixed on the way: a reload right after tuning the board feel could bring back the older mirrored record
  (`Preferences.attach`); this made the 6b board-feel e2e test flaky (failed 2 of 3 alone).

Everything marked **[P9]** is deferred to the Phase 9 profiling pass.

Performance
- **[P9] `perf:drag` scenario 2 drag (analysis board, MultiPV 5, ghost hovers, `go infinite`, 4
  threads) is sensitive to machine state.** Failed 8 of 11 runs on 2026-10-17 under load (p95 33.3 ms,
  3–7% dropped frames, 0 long tasks), then passed 3/3 on a clean machine (6b18a4c). See the
  2026-10-19/25 entry below. Drops are single frames with no long task: probably render/composite
  (ghost layer + overlay + dragged piece) competing with 4 engine threads; needs a trace-level
  profile.
- **perf:drag scenario 2, 2026-10-19 session (recorded 2026-10-26 from the user, who saw the
  output; that session hit its usage limit before logging it).** In full runs scenario 2's drag
  failed with p95 up to ~50 ms and ~15% dropped frames; run alone it passed (p95 16.73 ms). The
  same failure appeared on the commit before Phase 6b and on 6b18a4c (which passed 3/3 on
  2026-10-17), so it points to machine state, not to 6b. Re-measured 2026-10-26: see below. (Earlier that day the
  script's 3 GB free-memory guard aborted attempts at 2.4–3.3 GB free.) A temporary worktree
  left by that session (`wt-pre6b`, at 6b18a4c, clean) was removed.
- **[P9]** Premove burst still shows 0–2 isolated dropped frames per ~70-frame window (p99 up to 50
  ms) around bot moves; p95 unaffected.
- **[P9]** Occasional unattributed 50–76 ms long tasks with live MultiPV 5 plus a review under
  load (probably CPU contention: 4 + 1 engine threads on 8 logical cores).
- **[P9]** The second (review) engine's memory cost is not measured (noise from other apps).
- `importPgn` of the 33-move sample game is 27–33 ms on the main thread (largest single task the
  review flow causes). Parsing a big pasted/imported PGN is main-thread, one game per task; Phase 8
  moves bulk import to a worker.
- `perf:drag` needs ≥ 3 GB free memory (its own guard aborts below that).

Review and analysis
- Quick preset grades small drops loosely (Excellent/Good/Inaccuracy agree with depth 18 about half
  the time; see `docs/classification.md`). Standard/Deep for fine grading.
- App engine and Lichess disagree on some drops, so a few moves can be one band apart from
  Lichess; Lichess `MateAdvice` and the app's 5-move horizon differ on mates that only got longer.
- Live analysis stores its eval on the current move, so reviewing a plain PGN after the engine
  looked reports "replaced N earlier engine annotation(s)".
- No Chess960 game in the review tests.
- Some explanation sentences are weak for their class (fallback in `explain.ts`). Status details
  are in a `title` tooltip, which touch screens don't show.
- The Games list's background reviews and a review started on the board share one review engine
  (interleaved, each slower).
- Mistake puzzles need a review saved with the game; a review of a game not in the list (e.g. the
  sample game) makes none. The engine check of an alternative move takes ~0.5–1 s.
- A promotion picker opened for a premove closes when the opponent moves; nothing is queued.

Capture extension and storage
- Unofficial methods can break silently when the sites change (Lichess `page-init-data`,
  `.result-wrap`; Chess.com callback endpoint, game-over and Share dialog selectors). The last two
  could not be recorded live (mocked pages). Failure ends in the notification → popup paste path.
- Unverified on the live sites: Chess.com play-page URL/requests during a game; Lichess session
  export for a logged-in user (verified with a simulated cookie only); whether Chess.com's page
  makes a request when a game ends.
- Lichess correspondence games in progress do not hold the sync cursor back; Chess.com sync reads at
  most 3 archive months per run (older: Import my history). Lichess streams a running game a few
  seconds late (3–60 s).
- Popup shows the 40 newest entries; delivered entries keep a ~150-byte index row (never pruned).
- `localhost` and `127.0.0.1` are separate libraries (IndexedDB is per origin); `npm run serve`
  now redirects `localhost` → `127.0.0.1`, but an already-installed copy on `localhost` keeps its data.

Test and tooling notes
- A stale `serve.mjs` holding port 4173 makes Playwright reuse the old server (seen once); stop it
  before a full e2e run.
- Long full-suite runs on a busy machine can hit per-test timeouts (the Phase 3 bot-worker test
  hit 120 s once, passed alone in 33 s).
- Agent mistake (2026-10-17): a process lookup by command-line text matched its own command and a
  `taskkill` may have hit an unrelated reused PID. Rule since: kill only own descendants, re-check
  PID + command line at kill time (AGENTS.md).

## Key measurements

Headless Chrome, 60 Hz, `npm run perf:drag`, MT Stockfish ×4 (budget: p95 ≤ 17.2 ms, no dropped
frame, 0 long tasks). Last clean baseline, 6b18a4c (2026-10-17):

| Window | p95 | Dropped | Long tasks |
|--------|-----|---------|------------|
| 1 · Play drag + `go infinite` | 16.70–16.76 ms | 0–0.4% | 0 |
| 1 · 3-premove burst | 16.76–16.85 ms | 0–5.2% (bot-move frames) | 0 |
| 2 · Analysis drag, MultiPV 5, ghost every 3rd frame | 16.69 ms (3/3 clean runs) | 0.36–0.71% | 0 |
| 2 · Navigation sweep (81 plies) | 16.81–16.92 ms | 1.7–4.5% | 0 |

- Input latency 0.8–1.2 ms; idle rAF 0; startup 260–314 ms; engine 2.1–2.8 MN/s at depth 22–25;
  engine-line DOM updates ≤ 1 per frame; premove execution 5–7 ms.
- Phase 4 baseline before fixes: scenario 2 drag p95 33.36 ms with a 281 ms long task; sweep p95 83 ms.
- Review (`perf:review`): 81-ply game on Quick, 1 thread, 17.9–19.4 s (budget ~30 s); 46-move
  Lichess game 29–31 s earlier on Quick. p95 frame 16.7–16.8 ms during reviews.
- Phase 1: perft start depth 4 (197,281 nodes) ≈ 737 ms in Vitest; Kiwipete depth 3 ≈ 303 ms.
- Bot move selection (worker): Node average 15.9 ms, max 112 ms over 560 positions; was main-thread
  15–40 ms in the browser.
- Bundle: main 1,449.47 kB (269.71 kB gzip) at Phase 7 (+29 kB); trainer chunks 19.1 / 14.1 / 22.4 kB (repertoire / endgames / visualization), loaded on first use; extension background 247 kB.
- Tests at last full run (Phase 7): 555 unit (46 files, 89 s, the engine data check is ~88 s of it), 134/134 e2e (11.2 min, one worker). `perf:drag` not re-run in Phase 7 (no board, engine or input code changed).


### Phase 6b close-out: `perf:drag` on 23f5d47+docs (2026-10-26)

3 full runs (both scenarios), machine plugged in, best performance, 5.4–6.3 GB free, all exit 0:

| Run | S1 drag p95 | S1 burst p95 | S2 drag p95 | S2 sweep p95 | Dropped (S1 drag / burst / S2 drag / sweep) | Long tasks |
|-----|-------------|--------------|-------------|--------------|----------------------------------------------|------------|
| 1 | 16.73 | 16.77 | 16.69 | 16.80 | 0 / 1 / 0 / 8 | 0 |
| 2 | 16.70 | 16.77 | 16.73 | 16.90 | 0 / 1 / 3 / 10 | 0 |
| 3 | 16.70 | 16.82 | 16.71 | 16.83 | 0 / 2 / 7 / 11 | 0 |

(Window order per run as printed by the script; limit 17.2 ms.) Result: pass 3/3 on the current
commit, so the Oct 19 scenario 2 failures were machine state (consistent with Oct 17's finding), not
a 6b regression; the 6b18a4c comparison was not needed. Earlier attempts the same day were aborted by
the 3 GB free-memory guard (2.4–3.3 GB free, other apps open) and measured nothing.
