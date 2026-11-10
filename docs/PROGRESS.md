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
| 8 | Library, insights, settings, offline | Done | Own service worker (precache + COOP/COEP, update banner) and an offline e2e gate; played games kept, colour/opening/date/accuracy filters, delete, worker bulk import; Insights tab; live-region announcements and keyboard play on every board; Settings for usernames, analysis lines, review depth | [phase-8](progress/phase-8.md) |
| 9 | Performance pass & final audit | Done (closing gate on Juno, 2026-11-10) | Every budget measured (frame time, input latency, idle, startup, 50-game memory, review speed) and a 16-flow long-task audit; start-up split into tasks, lazy Review screen, Play bot-move task 16–27 → 7–9 ms; hints reach the review; full spec audit (all Done except two Partial and the optional Phase 10); Prettier enforced; measuring scripts guard against a locked screen; closing gate on Juno (unit 592, e2e 4 × 159, perf), results saved before they are shown, review tests hardened | [phase-9](progress/phase-9.md) |
| 11 | Hosting, iPhone, presets | In progress (stages 1–2 of 7 done, 2026-11-10) | Cloudflare Pages (classic) with `_headers`, preview-first deploy scripts, automatic updates; WebKit e2e projects, phone engine profile, persistent storage, Add to Home Screen guide | [phase-11](progress/phase-11.md) |
| HPC | Automated checks on Juno | Done (2026-11-10) | `hpc/`: Apptainer + pinned Playwright image, jobs wc-unit / e2e / e2e-repeat / perf / calibrate / puzzles / summarize, per-job build, port and scratch folder, safe-delete helper, reports; `wc-calibrate` and `wc-puzzles` not yet run | [phase-9](progress/phase-9.md) |


## Current phase and next step

**Phase 11 is in progress (stages 1–2 of 7 done: hosting and updates, iPhone support; stage 3 is next; see the Phase 11 section below). Production gets one deploy at the end of Phase 11, after testing on the real iPhone (decided 2026-11-10); until then only previews are deployed.** Phases 0–9 are done. **Phase 9 was closed on 2026-11-10: its closing gate ran on Juno (Linux, headless)**: typecheck, lint, format check, build,
592/592 unit tests, 4 of 4 full e2e runs (159/159 each) and all four perf scripts passed on commit `cefe783` (details below and in
[phase-9](progress/phase-9.md)). **The Key measurements table at the bottom comes from earlier laptop runs; the Juno numbers are in the table
under it** (regression baselines for a headless Linux node, not a user's screen). Phase 10 (native engine mode) is optional and not started.

### Automated checks on Juno (2026-11-09 → 10)

Unit, e2e and perf runs and batch studies run on the university's SLURM cluster (Juno), in the pinned Playwright container: `hpc/` (see
[hpc/README.md](../hpc/README.md)), rules in AGENTS.md, the full log (plan, setup attempts, every gate attempt with job IDs) in
[phase-9](progress/phase-9.md). Jobs: `wc-unit` (typecheck, lint, format, build, unit), `wc-e2e`, `wc-e2e-repeat`, `wc-perf`, `wc-calibrate`,
`wc-puzzles` (new `scripts/verify-puzzles.mjs`), `wc-summarize`; each has its own build, port and scratch folder and writes to
`results/<job-id>/` outside the repo. **`wc-calibrate` and `wc-puzzles` are built but have not been run yet.**
- **Closing gate, final (all on `cefe783`; each result's `meta.json` commit checked, `repo-changes.txt` empty):** wc-unit 505665 (592/592),
  wc-e2e-repeat 505669 (4 of 4 runs 159/159, 12 min each), wc-perf 505673 (all four scripts passed). The `phase5-review` sample-game long-task check
  never failed in any of the 20 Juno e2e runs: the earlier laptop failures were most likely the laptop.
- The gate took five rounds and found real things: tests that raced the start-up hooks and the asynchronous save of a drill's result; a **phone
  layout bug** (five key-moment chips need three rows, only two were reserved); a bug in my own save-before-show change (the endgame drill read
  `playing` while its result waited for the save; now a `saving` state); and three tests that assumed what a time-limited Quick review finds (a
  bot reply without a check, a Good move among the key moments, classes of a side). All fixed in the code or the test, no limit raised, nothing skipped.
- **Results are saved before they are shown** (a phone app closed as a result appears must have stored it): the endgame trainer and the coordinate,
  blindfold and guess drills wait for the save (at most 400 ms, `saveBeforeShow`); the puzzle trainer, played games (resign, draw, flag, rules) and
  the stored game's review request the save first (IndexedDB still commits asynchronously). Not tried on a real phone.
- `preact` removed (unused).

### Phase 8 follow-ups and the Phase 9 result, in short

1. **Bulk-import limit back to 50 ms.** The 75 ms task was the browser's first `AudioContext`, not the import (400 games:
   biggest page step ~20 ms; 3000 games also clean).
2. **Navigation sweep:** no regression from Phase 8. The failure on 2026-10-26 was machine state (battery, then a locked
   session: with the display off a blank headless page runs at ~56 Hz). `perf:drag` passed every window in 4 of 4 full runs
   on a quiet machine; it now measures a blank page first and aborts (exit 4) if the display is not at 60 Hz.
3. **`endgame-data` stall:** not CPU slowness (80 s plugged in). The cause is now observed, not just suspected: a full e2e run
   started at 23:15 froze at ~23:21 (session idle and locked, on AC, with a system-required power request held) and resumed at
   10:08 the next morning, with even its own `timeout 2700` not firing. The whole process tree is frozen while the laptop sits
   idle and locked. A system-required request does not prevent it; a long run needs the display held on too (done for the final
   e2e run). The test also had real weak spots and now fails in seconds on a silent, dead or timed-out engine.
4. **Phase 9 budgets** (all in [phase-9](progress/phase-9.md)): frame time p95 16.71–16.97 ms; input latency 0.6–1.4 ms;
   idle 0 rAF; startup 95–490 ms (budget 1,500); 50 games: +0.2–0.3 MB (JIT code), DOM and listeners flat; review of an
   81-ply game 17.4–17.9 s (budget ~30); main-thread time 1.4–3.1 ms per frame (120 Hz has 8.3).
5. **Spec audit:** two **Partial**: *no task over 50 ms* (none in 16 flows; page load still has the browser's one-time audio
   start, 60–340 ms, and a cold first layout, 35–89 ms, neither movable off the main thread) and *120 fps on high-refresh
   screens* (no such display here; main-thread headroom measured). **Missing:** Phase 10 (optional). Everything else Done.

## Phase 11 — Hosting, iPhone support, presets (started 2026-11-10)

Deadline: working on the target iPhone by 2026-11-19 (11-20 is buffer). Seven stages, each ending with its checks, a commit and a
report. Personal data (the gift preset, its messages, downloaded games, the opponent shortlist) lives only in the git-ignored
`gift.local/` folder; nothing personal goes in the repo, this file or commit messages.

**Stage 1 (2026-11-10, done, in production):** Cloudflare Pages (classic) with `_headers`, preview-first deploy scripts
(`deploy:preview`, `deploy:production -- --checked <id>`), automatic updates when nothing is in progress, `check:hosted`.
Production `https://wizards-chess-4tu.pages.dev` = build `aeedca6f9bb6` (commit `8c453ad`). Juno gate on `36b5bed` passed (unit 599/599,
e2e 4 × 160/160, perf all four). Plan, results and job IDs: [phase-11](progress/phase-11.md).

**Stage 2 plan: iPhone support (written before code, 2026-11-10)**
- **WebKit e2e projects** (`playwright.config.ts`): `webkit` (Desktop Safari) and `webkit-iphone` (iPhone 13: 390 × 664, touch,
  iPhone user agent). The three capture-extension specs stay Chromium-only. Fix what fails in the app, not by skipping. Juno's e2e
  job runs all three projects (its 80-minute inner limit may need raising: measure first).
- **Phone engine profile** (new `src/engine/engine-profile.ts`): a phone is an iPhone/iPod/Android-mobile user agent, or a coarse
  pointer with a short screen side under 600 px. On a phone one `EngineClient` serves everything (live analysis, the bot, threats,
  puzzles, endgames, reviews, the Games list's background reviews): 2 threads at most, 16 MB hash, so one Stockfish worker instead
  of three (~150 MB instead of ~600). Desktop is unchanged.
  - `EngineClient`: a finite search pre-empted by a higher-priority request is put back in the queue and rerun, instead of
    failing (today only Play's infinite live eval is ever pre-empted on desktop, and that stays cancelled). This keeps a
    background review alive when the user steps through moves on a phone.
  - **A review started on the board pauses live analysis** (the lines panel says so; it resumes when the review ends or is
    cancelled). The Games list's background reviews do not pause it: they wait for live searches instead.
  - Settings › About shows the profile (threads, hash, engines).
- **Persistent storage** (new `src/storage/persistence.ts`): `navigator.storage.persist()` once after start-up (in an idle
  moment) and again when the app runs from the Home Screen; Settings › About shows whether storage is kept.
- **Add to Home Screen guide** (new `src/ui/install-guide.ts`): a sheet with four drawn pictures (Share / ⋯ menu, "Add to Home
  Screen", "Add" with "Open as Web App", the icon on the Home Screen; no Apple artwork). Opens once on first run in iPhone/iPad
  Safari when not installed; Settings has a row that reopens it anywhere. The iPhone e2e project marks it seen (storage state).
- **New e2e** `tests/e2e/phase11-iphone.spec.ts` (WebKit iPhone project; parts also on desktop): the phone profile (one engine,
  threads and hash), a review pausing and resuming live analysis, the guide on first run only, persistent storage requested,
  touch drag and a premove with touch pointers, the board fitting a 390 px screen. Unit tests for the profile, the re-queue, and
  the persistence helper.
- Risks: Playwright's WebKit is not Safari on an iPhone (no real memory limit, no home-screen mode); Windows WebKit differs from
  Linux WebKit (Juno is the gate); WebKit has no long-task observer, so tests that assert on long tasks need a Chromium guard;
  sharing one engine makes the bot wait for a review position (≤ one search, ~0.2–0.6 s) on a phone.

**Stage 2 result (2026-11-10): done; Juno gate passed (perf still queued, see below); preview deployed, no production deploy**
- Built as planned (profile, re-queue, review pause, persistence, guide, three projects). The persistence request runs once per
  start-up (a Home Screen launch is a fresh start, so no separate call was needed).
- **Found by WebKit and fixed in the app:**
  - Safari does not focus a button on click, so sheets could not return focus to their opener: `Sheet` now remembers the
    control pressed last (2 s) when nothing has focus.
  - A piece tapped while the bot thinks was dropped when the bot replied; on a phone that is a slow second tap doing nothing.
    `setPosition(…, { keepSelection })` keeps it for the bot's reply in Play (same piece still on its square).
  - Date filters listen to `input` too (a browser without a date picker shows a text field, which fires `change` only on blur).
  - Phones: the app's heading is visually hidden instead of `display: none` (screen readers kept it; the phone shell test now
    checks that); `viewport-fit=cover` so the existing safe-area CSS takes effect, plus side insets for landscape;
    `maximum-scale=1` on iOS only (Safari zooms in on any focused field under 16 px; pinching still zooms on iOS);
    Home Screen tags (`apple-touch-icon`, title, `apple-mobile-web-app-capable`).
  - A blocked service-worker registration (Playwright WebKit) resolves to nothing: a readable "Not available" instead of a
    TypeError in Settings.
  - **Every select was unreadable in WebKit**: Safari's own select paints a white box, with the app's white text on it (review
    depth, Games filters, Settings…). Selects are now drawn by the app (`appearance: none`, an inline SVG chevron), the same
    in every browser; this also ended a sub-pixel text overflow the phone review test caught.
  - The puzzle trainer set `data-recorded` before the new rating was on screen (it reads the rating from IndexedDB first);
    the attribute now follows the stats.
- **Tests changed, none weakened:** three timing-sensitive tests clicked through Playwright locators, which wait for stability
  (300–500 ms per click in WebKit) and outlast the bot's think time: phase3's premove and underpromotion steps now click
  measured square centres (as phase3-premoves already did), and phase3-premoves' queue test gives the bot 3 s instead of
  0.7 s (its seven inputs take up to ~2 s in WebKit's iPhone mode; assertions unchanged). The two WebKit projects have a 60 s
  default per test (Chromium keeps 30 s): WebKit's clicks are 1.5–3× slower, and two long tests hit 30 s there. Hover-only
  tooltip steps in two review tests tap instead on a touch screen (the phone tooltip test already covered taps). The offline
  tests serve the build on their own origins, which the iPhone project's "guide seen" storage state does not reach: they mark
  it seen with an init script. Chromium-only parts are guarded, not skipped: Chrome's CDP installability check (WebKit checks
  the Apple tags and icon instead), the audio wait before long-task windows (Windows WebKit has no Web Audio), and long-task
  windows are annotated "no long-task timing" in WebKit. The stored-review test counts only review searches (on a phone the
  review engine is also the live one).
- `check:hosted` has `--browser webkit-iphone` (iPhone 13 emulation: also the install guide and the phone profile).
- **Laptop runs (Windows WebKit, not the gate):** desktop `webkit` first run 125/134 in 19.4 min (9 failures, all fixed and
  rerun); `webkit-iphone` first run found 10 more (all fixed and rerun, 25/25 of the failed and unreached tests); unit
  605/605 (76 s). Windows WebKit has no Web Audio, no date input and no long-task timing; Linux WebKit on Juno is the gate.
- **Commit `96da4fd`, pushed** (the user allowed gate pushes for the rest of Phase 11 when nothing personal is in them).
  **Preview** `https://a14c0304.wizards-chess-4tu.pages.dev` (alias `preview.wizards-chess-4tu.pages.dev`), build
  `f32cb599143d`. `check:hosted`: Chrome 15/15; `--browser webkit-iphone` 16/16 (isolated, the guide on the first visit, "Phone:
  one engine, 2 threads, 16 MB hash", mate at depth 16, bot online and offline, all 30 files cached, no foreign request).
  **No stage 2 production deploy** (the user's decision): production is deployed once, at the end of Phase 11, after testing
  on the real iPhone. It still serves stage 1's build `aeedca6f9bb6`.
- **Juno gate on `96da4fd`, passed** (every `meta.json` commit `96da4fd667`, `repo-changes.txt` empty everywhere):
  wc-unit 505993 (typecheck, lint, format, build, 605/605 unit); wc-e2e-repeat chromium ×2 505994 (165/165 each, 1 skipped =
  the phone-only touch test, 12.0 and 12.2 min); webkit ×2 505995 (139/139 each, 1 skipped, 12.8 and 13.0 min); webkit-iphone ×2
  505996 (140/140 each, 15.2 and 15.9 min). 0 failed, 0 flaky in all six runs. Linux WebKit runs about as fast as Chromium.
- **wc-perf 505997: not finished when stage 2 closed** (queued for an exclusive node; Slurm's estimate was 17:16 Juno time on
  2026-11-10). The user chose not to wait: **the stage 3 session reads `results/505997/summary.md` on Juno and reports it here**
  (a failure there belongs to stage 2's code).
- **Open (later stages):** the Games screen on a phone still shows the Chrome capture-extension card (stage 3, Chess.com sync,
  replaces it there); a real iPhone has not been tried yet (memory limit, Home Screen mode, the guide's steps on iOS 26).
- Agent note: a stopped background `playwright test` left its runner orphaned (its shell's parent gone); not provably mine by
  parent PID, so it was not killed: it finished by itself. Stop a run with Ctrl+C-like means, not by stopping the shell task.


- **Scenario-2 `perf:drag`** (analysis board, MultiPV 5, ghosts, navigation sweep) passed clean on Juno on the final code (p95 16.67 ms, 0 dropped).
  Not re-measured on the laptop: the laptop failures were machine state, and Juno numbers are baselines, not a screen.
- **First runs of `wc-calibrate` and `wc-puzzles`** (built, not yet run): the calibrate time limit (50 min per task) is an estimate; tighten it after the first run.
- **`preact`:** removed on 2026-11-09 (nothing imported it; package.json, lockfile, LICENSES and the tsconfig JSX options).
- **`PERF_ENGINE_THREADS` matrix** (4/3/2 threads × ghosts off) was never run; only worth running if scenario 2 fails on a
  quiet machine. Whether to drop analysis threads while a background review runs is also unmeasured
  ([phase-3-4-fixes](progress/phase-3-4-fixes.md)).
- **Review engine threads:** decided 1 thread (`REVIEW_ENGINE_THREADS` in `app.ts`); more threads bought no depth and cost
  live analysis speed ([phase-5](progress/phase-5.md)). Memory per engine is now known (+149 MB review, +294 MB live).
- **Bot level calibration** is approximate by design; no human data offline.

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

Phase 8 (details in [phase-8](progress/phase-8.md))
- An update of the app waits until Reload on the banner (or until every tab is closed): by design, so a game is
  never reloaded. The update flow is covered with an edited copy of the build, not with two real builds.
- Keyboard mode on a board starts only after Tab (a click keeps the arrow keys for stepping through moves); a
  screen reader's own browse mode may handle arrows before the page sees them. Not tested with a real screen reader.
- Insights need reviewed games that are *mine* (usernames in Settings › Your games; games played here count). Phase
  boundaries are a simple rule (10 moves, 6 pieces). Deleting a game keeps puzzles already made from it.
- Offline: a rebuilt app on the same origin is served from the old cache until Reload; `localhost` and `127.0.0.1`
  have separate caches and libraries (as before). Installability could only be checked with Chrome's own CDP check.
- Unit tests on a laptop on battery are about 2–3× slower (full run 180 s instead of 90 s); `vitest.config.ts` now
  allows 30 s per test and 4 test processes, and the DTM oracle solves in slices so a test worker keeps reporting. One
  run of `endgame-data` alone took 45 min and failed 5 tests after the machine stalled; rerun it passed (160 s).

Phase 9 (details in [phase-9](progress/phase-9.md))
- **Resolved: `phase5-review` sample-game long-task assertion** (it had failed on the laptop at 98 ms and 57 ms, never alone) passed in all 20 full
  runs on Juno, so those failures were most likely the laptop; the limit was not changed.
- **Saving a result:** drills wait for their save (400 ms at most, then the result shows anyway and the save finishes in the background); puzzles, played
  games and stored-game reviews only request the save first. A real phone app-close mid-result was not tried.
- **A Quick review is time-limited, so the key moments and classes differ from run to run.** Tests must derive what they check from the review's own
  output (the three flakes of 2026-11-10 were tests that did not); a fixed node budget would need a new app code path.
- **Phone layout:** the key-moment chips reserve three rows (`7.3rem`) at 760 px and below; five long labels fit on three rows at 390 and 360 px.
- **Frame-time numbers are only valid with the display awake.** A locked session or a screen that is off makes headless Chrome
  lose vsync (blank page ~56 Hz); battery throttles too. `perf:drag` aborts (exit 4) on a slow blank page; `perf:review` prints the
  floor per run. A busy machine (a user's Chrome at ~22% CPU) also fails scenario 2 on any build.
- **Long runs freeze when the laptop is idle and locked** (see follow-up 3): keep the screen on and do not walk away mid-run, or
  hold the display awake while it runs. A frozen run looks like a hang and fails its own time limits on resume. (Moot for runs on Juno.)
- `perf:drag`, `perf:review` need ≥ 3 GB free memory (`perf:tasks` 2.5, `perf:memory` 2); with a user's Chrome open at 5+ GB the
  guards stop full runs. (On Juno: an exclusive node with 340+ GB free.)
- **No task over 50 ms** holds in 16 flows after page load. Page load has two browser-owned costs: the first `AudioContext` of a
  browser process (60–340 ms; built ~0.4 s after start-up in an idle moment, only with sound on; cannot be built off the main
  thread) and the renderer's first text layout in a cold process (35–89 ms, now in its own task). Both documented, neither fixable.
- The Games list shows 100 rows at most (then "Show more"), so a played game adds ~41 DOM nodes until then; `perf:memory` deletes
  each saved game so it measures leaks only. `importPgn` of the 33-move sample is 27–33 ms on the main thread (under the limit).
- `window.__wizardChess{Library,Puzzles,Drills}Ready` exist from module load; every other test hook (`__wizardChessPlay`, `…Analysis`,
  `…Review`) appears when the app mounts, one frame after load; tests wait for the board first. The Review screen is built lazily
  (first use or an idle moment), so its DOM does not exist until then.
- Hints: the comment `Hint used: …` goes on the move played after a hint; a hint asked for and then never followed by a move (game
  ends) leaves no comment.
- The review's long-task windows in tests start after the audio warm-up; `phase5-review` "Black-to-move" no longer asserts the sign
  of a runner-up line that is worth ~0.
- A temporary worktree's folder could not be deleted by `git worktree remove` right after use (Windows lock, my own shell was in
  it); deleted with `Remove-Item` once the shell had left it. Nothing outside the repo was touched.

Performance
- `importPgn` and the Games list: see above. `perf:drag` scenario 2 had failed under load before (2026-10-17/19/26); all of those
  were machine state (load, battery, a locked screen), as the A/B in phase-9 shows once more.
- The premove burst shows 1–3 dropped frames per ~70 (one is the harness's own click batch); p95 passes. The bot-move task is 7–9 ms
  (was 16–27).

Review and analysis
- Quick preset grades small drops loosely (Excellent/Good/Inaccuracy agree with depth 18 about half
  the time; see `docs/classification.md`). Standard/Deep for fine grading.
- App engine and Lichess disagree on some drops, so a few moves can be one band apart from
  Lichess; Lichess `MateAdvice` and the app's 5-move horizon differ on mates that only got longer.
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
- Agent mistake (2026-10-26): a temporary `git worktree` was given `node_modules` as a directory junction, and
  `git worktree remove --force` followed it and emptied the real `node_modules`. Restored with `npm ci` from the lockfile (same
  versions; nothing else touched). Rule since: temporary worktrees go inside the repo folder (module resolution finds the
  parent's `node_modules`), never with a junction to it.
- Playwright's `use.serviceWorkers: 'block'` also reaches `launchPersistentContext`, where it breaks the capture extension's own
  service worker (6 extension tests failed): `tests/e2e/helpers/extension.ts` sets `'allow'`.
- Agent mistake (2026-10-17): a process lookup by command-line text matched its own command and a
  `taskkill` may have hit an unrelated reused PID. Rule since: kill only own descendants, re-check
  PID + command line at kill time (AGENTS.md).

## Key measurements

**This first table is from earlier laptop runs** (headless Chrome, 60 Hz, AC power, display awake, blank page 16.7 ms), not from the closing gate.
Budgets: frame p95 ≤ 17.2 ms with 0 long tasks; the details, the runs and the older tables are in [phase-9](progress/phase-9.md).

| Budget | Result |
|---|---|
| Frame time, `perf:drag` (S1 drag · burst · S2 drag · S2 sweep p95) | 16.71–16.78 · 16.74–16.97 · 16.76–16.77 · 16.84–16.88 ms (4 full quiet runs; final commit: S1 only, S2 owed) |
| Input latency | 0.6–1.4 ms in the pointer handlers (+ the next frame) |
| Main thread per frame | 1.4–3.1 ms (S1 drag 1.4–2.6, burst 1.6–2.0, S2 3.1) against 8.3 ms at 120 Hz |
| Idle | 0 rAF in 500 ms |
| Startup to an interactive board | 95–490 ms (cache reload ≈ 95–136 ms quiet); budget 1,500 ms |
| 50 games (`perf:memory`) | +0.2–0.3 MB heap (5–7 KB per game, JIT code), DOM and listeners flat, workers 2 |
| Review, 81 plies, Quick, 1 thread (`perf:review`) | 17.4–17.9 s (budget ~30 s), 0 long tasks |
| Tasks over 50 ms (`perf:tasks`, 16 flows) | 0 after page load; page load: audio start 78–114 ms once, cold first layout 50–89 ms |
| Engine memory | live (4 threads, 128 MB hash) +294 MB; review (1 thread, 32 MB) +149 MB; single-threaded +153 MB |
| Bot-move + premove task | 7–9 ms (was 16–27) |
| Bundle | main 1,486.03 kB (Phase 8: 1,483.20); precache 30 files, ~20.9 MB |
| Earlier phases | engine 2.1–3.2 MN/s at depth 22–25; perft start depth 4 ≈ 737 ms; bot move selection (worker) 15.9 ms mean |

**Closing gate on Juno, 2026-11-10, commit `cefe783`** (headless Chromium 156 on Linux, exclusive node, no display: frames follow Chromium's own
60 Hz timer, blank page 16.7 ms; **regression baselines for the code, not what a user's screen shows**):

| Budget | Juno result |
|---|---|
| Frame time, `perf:drag` (S1 drag · burst · S2 drag · S2 sweep p95) | 16.67 · 16.67 · 16.67 · 16.67 ms, 0 dropped frames, 0 long tasks |
| Input latency / main thread per frame | 0.37 and 0.52 ms / 0.67–1.46 ms (120 Hz has 8.3) |
| Idle · start-up | 0 rAF in 500 ms · 248 ms |
| 50 games (`perf:memory`) | +0.2 MB heap (5.2 KB per game), listeners +0 |
| Review, 81 plies, Quick (`perf:review`) | 17.0–17.1 s at 1, 2 and 4 threads (a fixed time per position), 0 long tasks |
| Tasks over 50 ms (`perf:tasks`, 16 flows) | 0 |
| Tests | 592 unit (1½ min); e2e 159 per run, 4 of 4 runs passed (11.4–11.5 min each) |

Tests on the laptop before Phase 9 closed: 588 unit (51 files, 116 s); e2e 158.
