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
| 9 | Performance pass & final audit | Code and audit done; final full e2e run owed | Every budget measured (frame time, input latency, idle, startup, 50-game memory, review speed) and a 16-flow long-task audit; start-up split into tasks, lazy Review screen, Play bot-move task 16–27 → 7–9 ms; hints reach the review; full spec audit (all Done except two Partial and the optional Phase 10); Prettier enforced; measuring scripts guard against a locked screen | [phase-9](progress/phase-9.md) |


## Current phase and next step

Phases 0–8 are done. **Phase 9 is complete except for its closing gate**: a full e2e run that passes, uninterrupted, on the final
commit (and one clean scenario-2 `perf:drag` run). The code, the measurements and the requirement audit are done and committed;
detail is in [phase-9](progress/phase-9.md). The "Phase 9: …" closing commit has not been made for that reason. Phase 10 (native
engine mode) is optional and not started.

**State of the e2e gate (2026-10-27).** Unit 588/588, typecheck, lint, format check and build pass on the final commit. Full e2e:
(1) first full run after the start-up split, 155 passed / 3 failed, the 3 fixed (see phase-9); (2) a run that froze while the laptop
sat idle and locked (11 h, invalid); (3) a run on the final commit that the machine killed under memory pressure: 137 of its 138
failures are `worker process exited unexpectedly (code 3221225794)` = Windows `0xC0000142` (process start failing), the 138th is
a real one: `phase5-review` "reviews the built-in sample game" saw a 57 ms task in the review window (98 ms in run 1). It passes
alone (7 of 7, also 3 of 3 under heavy CPU load), and CPU load does not reproduce it, so the cause is not found; memory pressure
(paging) is suspected, not shown. **Next step: free memory (the user's Chrome holds 3.7+ GB), keep the screen on, run
`npx playwright test` once; if that test fails again on a quiet machine it is a real finding to chase (a ≥ 50 ms task in the review
window), not a flake to loosen.**

### HPC: automated checks on Juno (started 2026-11-09)

Plan (Part A, then the Phase 9 closing gate on Juno as Part B). Checks, perf and batch studies move to the university's SLURM
cluster (Juno); the laptop no longer runs them.

- **Files added:** `hpc/` (`lib/paths.sh` with the folder constants and the safe delete helper, `lib/job.sh` for the shared job
  prologue/epilogue, `setup.sbatch`, `jobs/{unit,e2e,e2e-repeat,perf,calibrate,puzzles}.sbatch`, `summarize.mjs`, `smoke.mjs`,
  `README.md`); `scripts/verify-puzzles.mjs` (deep puzzle check, did not exist); `tests/e2e/helpers/site.ts` (one place for the port).
- **Files changed:** `playwright.config.ts`, `tests/e2e/helpers/extension.ts` + two specs (browser channel and port by platform/env,
  Windows behaviour unchanged), `scripts/lib/process-guard.mjs` (read `/proc` on Linux), `scripts/perf-*.mjs` (channel, headless
  display-rate wording), `scripts/calibrate-bots.mjs` (`--level`), `scripts/build-extension.mjs` + `extension/src/settings.ts`
  (build-time default port), `AGENTS.md`.
- **Design:** every job runs `apptainer exec --cleanenv --containall` from the Playwright image (pinned to the lockfile's
  Playwright version) with only these binds: the repo, the npm cache, a per-job scratch folder as `/tmp`, and per-job folders over
  the repo's `dist/`, `dist-ext/` and `test-results/`. So parallel jobs on one node never share a build or a port, nothing is
  written into the repo outside `node_modules`, and the container's own PID namespace limits "leftover process" checks to the job.
- **Risks:** nothing could be run on Linux from the laptop, so the first Juno job is the first Linux run of this harness (the setup
  job ends with a smoke test of headless Chromium, the frame floor and loading the extension). New headless Chromium and
  `Extensions.loadUnpacked` are expected to work; `xvfb-run` is the fallback (`WC_HEADED=1`). Whether the GitHub repo is public
  is unknown (a private repo cannot be cloned by the setup job).

**Part A (the `hpc/` setup) is committed and running on Juno; Part B (close Phase 9) is in progress.** `preact` is removed.
Differences from the brief, and why:
- `wc-unit` also runs typecheck, lint, format check and build (separate steps, same job): AGENTS.md's gate needs them and they
  must run on Juno too. `wc-summarize` and `hpc/smoke.mjs` were added (arrays need a combined report; the setup needs a check
  that Chromium and the extension work on Linux).
- `scripts/verify-puzzles.mjs` is new (no "deep puzzle verification" existed): fixed-depth Stockfish over every player move of
  all 20k puzzles, accepting the stored move by the app's own alternative-move rule. Tried locally on 20 puzzles (55 moves, all
  engine-best, 0.25 s per puzzle); the failure path tried at depth 1.
- Checked on the laptop before the commit (Juno did not exist yet): `typecheck`, `lint`, `format:check`, `bash -n` on every script,
  `hpc/test/paths-test.sh` (symlink cases are skipped on Windows), `hpc/smoke.mjs`, `summarize.mjs` on made-up results, a
  `build:ext` with and without `WC_PORT`. The unit and e2e suites were not run (they are what Juno is for).
- Not checked anywhere yet: apptainer flags (`--containall --no-home`, nested binds over `dist/` and `node_modules/.vite`), the
  `module` init in a job, `git clone` of the GitHub repo (is it public?), new headless Chromium loading the extension, and
  whether `/dev/shm` inside the container is big enough for Chromium.

**Juno runs, 2026-11-09 evening** (all on repo commit `35b58d1`; project folder 4.1 GiB, 18Ki inodes; `~/work` was at 888Ki inodes /
613 GiB before and 906Ki / 617 GiB after setup):
- Setup attempt 1 (504970) failed in 9 s: `module` was undefined in the scrubbed job (`/etc/profile.d/lmod.sh` did not define it). Fixed
  by sourcing Lmod's own init (`/opt/ohpc/admin/lmod/lmod/init/bash`) with a fallback to Juno's login MODULEPATH. Attempt 2 (**504976**)
  passed: Apptainer mounts, own PID namespace (7 processes visible), headless Chromium 156, blank page p50 16.7 / p95 16.8 ms,
  cross-origin isolated, extension loads in new headless (no `--headed` needed). Node in the image is v26.13.0.
- **wc-unit 504982: passed** (typecheck, lint, format, build, 588/588 unit tests, 1 min 45 s; `repo-changes.txt` empty).
- **wc-perf 504989: passed** (6 min 19 s, exclusive node c-02-04): drag p95 16.67 ms in all four windows, 0 dropped, 0 long tasks, main thread
  0.6–1.5 ms per frame; memory +0.26 MB over 50 games (6.8 KB/game); review of 81 plies 17.0–17.1 s at 1, 2 and 4 threads, 0 long tasks;
  16 flows, 0 tasks ≥ 50 ms; blank page 16.7 ms. Baselines for a headless Linux node, not a screen.
- **wc-e2e-repeat 504985, first round (commit `35b58d1`): all 4 runs failed, 2–3 tests each of 159 (11.5–12 min per run);** `meta.json` commit
  and an empty `repo-changes.txt` checked for every task. `phase5-review` "reviews the built-in sample game" passed in all 4 runs. Failures:
  - `phase7-trainers` "giving up, restarting and offering a draw too early": 4 of 4. The test read the saved progress the moment the
    result showed; the app saves it a moment later (by design, `EndgameTrainer.finish`). Linux/timing (the profile folder is on a
    network disk). Test fix: wait for the record. The same read without a wait in the rp-vs-r and lucena tests got the same fix.
  - `phase6b-review` "Analyze this position (from Play)": 3 of 4, and `phase2-engine-restart` "threads set to 4 right after the engine
    starts": 1 of 4 (its "2" twin has the same code). Both used `window.__wizardChessPlay` right after `goto`; since the start-up split
    it exists only after the app mounts. Test fix: wait for it first.
  - `phase8-leftovers` "phone: a key moment's sentence is complete": 1 of 4. **Real layout bug:** on phones the key-moment chips wrap into
    two reserved rows; five chips with long labels (`4... Bxf3`, `10... cxb5`, …; which moments Quick finds varies per run) need a third
    row, which was cut off. Fix: three rows reserved on phones (`7.3rem`); checked with five worst-case chips at 390 and 360 px.
- **Second round, wc-e2e-repeat 505518 (commit `14119ff`): 4 of 4 runs passed, 159/159 each** (11.2–11.7 min); `meta.json` commit matches and
  `repo-changes.txt` is empty for all four. Round 1 and 2 together: `phase5-review` "reviews the built-in sample game" passed in all 8 Juno runs.
- **Follow-up (commit `8cb6894`): results are saved before they are shown** (a phone app closed as a result appears must have stored it).
  `saveBeforeShow` (400 ms cap) in the endgame trainer and the coordinate / blindfold / guess drills; the puzzle trainer, played games
  (resign, draw, flag, rules) and the stored game's review now request their save before showing anything; the repertoire drill already
  did. IndexedDB still commits asynchronously, so "before" means waited for (drills) or requested first (the rest). It changes app code,
  so the closing gate (unit, e2e ×4, perf) runs again on the final commit.

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

## Open decisions

- **Final scenario-2 `perf:drag` run.** Scenario 2 (analysis board, MultiPV 5, ghosts, navigation sweep) was last measured clean
  before the final small changes; on the final commit the machine was too busy (the pre-Phase-9 build failed it the same
  way minutes apart). Run `npm run perf:drag` with other apps closed, plugged in and the screen on.
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
- **Open: `phase5-review` sample-game long-task assertion failed in both full runs on the final code (98 ms, 57 ms), never alone.**
  See "Current phase" above.
- **Frame-time numbers are only valid with the display awake.** A locked session or a screen that is off makes headless Chrome
  lose vsync (blank page ~56 Hz); battery throttles too. `perf:drag` aborts (exit 4) on a slow blank page; `perf:review` prints the
  floor per run. A busy machine (a user's Chrome at ~22% CPU) also fails scenario 2 on any build.
- **Long runs freeze when the laptop is idle and locked** (see follow-up 3): keep the screen on and do not walk away mid-run, or
  hold the display awake while it runs. A frozen run looks like a hang and fails its own time limits on resume.
- `perf:drag`, `perf:review` need ≥ 3 GB free memory (`perf:tasks` 2.5, `perf:memory` 2); with a user's Chrome open at 5+ GB the
  guards stop full runs. Scenario 2 on the final commit is still to be run clean.
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

Headless Chrome, 60 Hz, AC power, display awake (blank page 16.7 ms). Budgets: frame p95 ≤ 17.2 ms with 0 long tasks; the details,
the runs and the older tables are in [phase-9](progress/phase-9.md).

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

Tests: 588 unit (51 files, 116 s); e2e 158 (155 passed on the first full run after the start-up split, the 3 failures fixed as described
in phase-9; final full run below).
