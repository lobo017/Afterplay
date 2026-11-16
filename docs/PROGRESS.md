# Afterplay — Progress

The app was called Wizard's Chess before the rename stage of 2026-11-10; the archives in `docs/progress/` keep that name.

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
| 11 | Hosting, iPhone, presets | In progress (stages 1–4, 6 and the Afterplay rename done; the first-run link fix and the empty default account passed their Juno gate on `5f3274e`, 2026-11-13) | Cloudflare Pages (classic) with `_headers`, preview-first deploy scripts, automatic updates; WebKit e2e projects, phone engine profile, persistent storage, Add to Home Screen guide; preset files and first-run links, profile, green board, Classic pieces | [phase-11](progress/phase-11.md) |
| HPC | Automated checks on Juno | Done (2026-11-10) | `hpc/`: Apptainer + pinned Playwright image, jobs wc-unit / e2e / e2e-repeat / perf / calibrate / puzzles / summarize, per-job build, port and scratch folder, safe-delete helper, reports; `wc-calibrate` and `wc-puzzles` not yet run | [phase-9](progress/phase-9.md) |

## Current phase and next step

**Phase 11 is in progress (done: hosting and updates, iPhone support, presets and the first-run link, the rename, the history jobs of stage 4; stage 6, the in-app Chess.com sync; the first-run link fix and the empty default account, Juno gate passed on `5f3274e`, 2026-11-13; see the Phase 11 section below). Production gets one deploy at the end of Phase 11, after testing on the real iPhone (decided 2026-11-10); until then only previews are deployed.** Phases 0–9 are done. **Phase 9 was closed on 2026-11-10: its closing gate ran on Juno (Linux, headless)**: typecheck, lint, format check, build,
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

**Stage 2 (2026-11-10, done, preview only): iPhone support.** Commit `96da4fd`; Juno gate passed (unit 605/605); preview build
`f32cb599143d`. **Open:** a real iPhone has not been tried. Full block: [phase-11](progress/phase-11.md#stage-2-moved-2026-11-14).

**Stage 3 (2026-11-10, done, preview only): presets and the first-run link.** Commit `3022fd6`; Juno gate passed (unit 631 + 1 skipped);
preview build `ac2ddadcf5ce`. Personal presets live only in `gift.local/start/`; putting one on the host is the user's decision, not taken yet.
**Open:** the real-iPhone checks. Full block: [phase-11](progress/phase-11.md#stage-3-moved-2026-11-14).

**Rename stage (2026-11-10, done, preview only): the app is now "Afterplay".** Juno gate on `5f60eb8` passed; production still serves the old
build under the old name until the final deploy. Full block: [phase-11](progress/phase-11.md#rename-stage-moved-2026-11-14).

**Stage 4 (2026-11-11, done on Juno): a player's Chess.com history (download, report, restore file).** Commit `fdf6323`; jobs 508107, 508123,
508129. The numbers, report and shortlist are personal and live in `gift.local/history/`. Full block: [phase-11](progress/phase-11.md#stage-4-moved-2026-11-14).

**Stage 6 (2026-11-11, done; Juno gate passed 2026-11-12, preview only): "Sync my Chess.com games" in the app.** Gate on `16f9236`; preview
build `c05c931e365e`. The site's only runtime network request, made only on that button. Full block: [phase-11](progress/phase-11.md#stage-6-moved-2026-11-14).

**Link fix and no built-in account (2026-11-13, done; Juno gate passed on `5f3274e`; preview with it: next).** Full log: [phase-11](progress/phase-11.md).
- **Link fix (`1af20a8`):** a real iPhone showed a Home Screen app, added on a second visit, starting as the plain app: the service worker
  answered `/start/<slug>/` with the precached plain page, whose manifest starts at `/`. It now answers a link with that link's own page on
  every visit (`src/sw-links.ts`). No link is listed in `sw.js`: one is learned when it is opened and kept in the cache
  `wizards-chess-links-v1`, then written from the cached build, so it opens offline. Tests first (`phase11-link-worker.spec.ts`, 9 of 9
  failing before); `check:hosted` gained the second visit, the offline visit and "sw.js names no link".
- **No built-in account (`5f3274e`):** `DEFAULT_USER_ACCOUNTS` is empty, so nobody is "me" until a username is saved (a deviation from the
  spec's interim Phase 5 rule). Tests that relied on the default save the account themselves; no assertion loosened.
- **Juno gate on `5f3274e`, 2026-11-13, passed** (every `meta.json` commit matched, every `repo-changes.txt` empty): e2e chromium ×2 512032
  (180 + 2 skipped), webkit ×2 512035 (154 + 2), webkit-iphone ×2 512037 (156), 0 failed, 0 flaky; unit 512038 (706 passed, 2 skipped);
  perf 512039 all four (drag p95 16.67 ms, 0 dropped, start-up 250 ms; review 17.0–17.1 s; tasks 0 of 50 ms or more; +0.18 MB).
- **Open:** a device still on the old worker gets the old answer until the new one took over; the tests model Add to Home Screen, not iOS.

**Chess Story, build session 1 (2026-11-13, not committed; no UI, no network).** `src/story/stats.ts` (`computeStoryStats`: three scopes, duplicates, exclusions, streaks, openings, best win, 12-month trend per site), `src/story/text.ts` (`storyCards`: fixed templates from `StoryStats`), `library.moreAccounts` + `getMoreAccounts`/`setMoreAccounts` in `library.ts`, `getUserAccounts()` returns both. Tests: `story-stats` 46, `story-text` 15, `story-accounts` 6; unit suite 775 passed, 1 skipped; typecheck, lint, format:check clean. Files are named `stats.ts`/`text.ts` as the session brief says (the spec says `story-stats.ts`/`story-text.ts`).
- **Choices where the spec was silent:** a game with no time control the code can read counts in totals but in no class (`unclassified`); "rated win" = the opponent has a stored rating (the rated flag is not stored); the trend's "rated games" are those in the 12-month window; unpaired duplicates are matched one to one, the Lichess side dropping out of the total; the Lichess card is made only when Lichess games are stored (spec section 11), so spec section 5's "one line for a site with no games" applies to Chess.com only.

**Chess Story, build sessions 2 and 3 (2026-11-13/14, not committed):** the history loader, Story tab, landing value (Session 2) and the shared sync runner, "Start import" / "Continue", add-another accounts, preset `story` text, AGENTS.md sentence and network test (Session 3). Unit 807 passed; `phase11-story.spec.ts` 21 of 21 on chromium and webkit-iphone. Plans, choices, deviations and checks: [phase-11](progress/phase-11.md#chess-story-build-sessions-2-and-3).

**Juno gate for Chess Story Sessions 2 and 3, commit `2f41ddcdb77597517aa20582fd95f006514232f4`, passed:**
- e2e chromium ×2 513476: 201 passed, 2 skipped, both runs. e2e webkit 513478: 175 passed, 2 skipped. e2e webkit-iphone 513481: 177 passed.
- unit 513482: 806 passed, 2 skipped. perf 513483: all four scripts passed.
- All eight result folders passed the trust checks. The three failures seen on the laptop passed on Juno.

**Engine review on Juno (revision 2026-11-14).** A compact engine summary per game of the personal history file (depth 18, the
player's side only), so the Story can show accuracy and mistakes. The plan is "Spec: engine review data in a history file".
- **Commits:** `ff5faaa` summary type, `summarizeReview`, `hasSavedReview` guard (a summary-only game is not a saved review; the Today count
  leaves it out; the Games list shows "Reviewed in advance"; **one existing assertion changed, approved 2026-11-14:** `library.test.ts` "saves a
  finished review apart from the game…" `toEqual` became `toMatchObject` with the same four fields, because `saveReview` also writes `plies` and
  `sides`; the step-2 plan and risks: [phase-11](progress/phase-11.md#engine-review-step-2-plan-moved-2026-11-14)); `863d5b1` batch files
  (`hpc/history/lib/reviews.mjs` with types and `history-reviews.test.ts`, `review-games.mjs`, `merge-reviews.mjs`, `lib/settings.mjs`,
  `history-engine.sbatch` and `.sh`, `engine-merge` in `history.sbatch`/`.sh`); `3c588c3` pilot-folder, games-per-chunk and stop-minutes
  arguments for the job.
- **Design as built:** 64 chunks (`HISTORY_CHUNKS`; game i of the sorted ids is in chunk i mod 64), array `0-7%4`, 8 workers per task (8 CPUs, 16 GB,
  2 h limit, workers stop themselves at 105 min); depth 18, MultiPV 2, 1 thread, 32 MB hash, Stockfish 17.1 lite single. One part file per chunk
  (first line: input hash, settings, engine, commit); exit 0 done, 3 time limit, 1 error, 2 refusal. Ids and numbers stay in the scratch history
  folder; `results/` gets counts. **Deviation:** the spec said 8 chunks; one engine per task would have taken about 14 h, so it is 64 (decided
  2026-11-14). **The review code is frozen at `3c588c3`: any change to it (batch scripts, settings, or the app modules they load) needs a full rerun.**
- **Pilots:** 513657 and 513678 (5 games per chunk, 8 of 8 exit 0): 64 of 64 part files byte-identical; 513700 and 513713 (1-minute stop): every task
  exit 3 (Slurm `FAILED 3:0`), then the same line resumed all workers with no refusal. MaxRSS about 3.1 GB per task, about 0.39 s per position.
- **Full run, job 513726:** 8 of 8 tasks exit 0 (28–34 min each, about an hour in two waves); 4,687 part-file lines (64 headers + 4,623); 4,580
  reviewed, 43 skipped (all "under 10 plies"); 265,488 positions, 0.37–0.49 s per position (median 0.40); leak scan clean; `restore.json` unchanged.
- **Merge, job 513905** (no `--allow-partial`): 4,580 games from 64 parts, none missing; `restore-reviewed.json` 14,028,739 bytes (13.38 MiB of 24),
  sha256 starts `45988d8e`, the laptop copy identical; every analysis `summaryOnly`, depth 18, the player's side only; every game otherwise equal to
  `restore.json`; the app's backup import test passes (4,623 games).
- **Where the files are:** Juno scratch is purged after 45 days untouched and is never backed up, so the part files and `restore-reviewed.json` there
  are not a permanent copy; the merged file is also on the owner's laptop under the git-ignored `gift.local/`.
- **Not done yet:** loader behaviour for devices that already hold the old history (stored games
  are never overwritten); swapping the hosted `history.json` for the reviewed file; preview; real iPhone check; cleanup of the three pilot folders on
  Juno (through `wc_rm_tree`, never `rm -rf`). Production stays one deploy at the end.

**Story review cards, Insights quarters and the Games summary (2026-11-14 to 2026-11-15, commits `c8b0efd` to `43d0730`).**
- **Story:** four cards after the site cards (accuracy, mistakes, biggest swing, most accurate game) from the engine-review summaries and from reviews made on
  the device (`STATS_VERSION` 2). Fewer than 20 reviewed games gives one "not enough" card, none gives no card; the Mistakes card lists the newest three years.
- **Insights:** accuracy and mistakes per quarter in two charts. Up to 760 px a tap selects a quarter and shows a readout with a 44 px "Show these games"
  button (wide screens open the Games list on click); the mistakes line is dashed with hollow dots, so the two lines differ by shape, not colour alone.
- **Games:** the summary reads "N games · M analyzed · K reviewed in advance", always library-wide (the count under the list follows the filter).
- **Juno gate on `43d07304e95c05e156e6e8e4ab0e874cb4102915`, passed (jobs 514152, 514154, 514155, 514156, 514157, all COMPLETED 0:0; every `meta.json` commit
  matched, every `repo-changes.txt` empty):** e2e chromium ×2 218 passed (+2 skipped), webkit ×2 192 (+2), webkit-iphone ×2 194, 0 failed, 0 flaky, 0 retries
  in all six runs; unit 972 passed, 2 skipped (typecheck, lint, format:check, build, vitest all exit 0; the skips are the restore-file test and the
  personal-preset test, which needs `gift.local/`, so a laptop run skips one); perf all four passed (drag p95 16.67 ms, 0 dropped frames, start-up 264 ms;
  review 17.0–17.2 s; tasks 18 of 18, none over 50 ms; memory heap slope 7.1 KB per game, +0.3 MB).
- **Note:** the Games footer counts 4,580 reviewed games, the Story 4,535: it skips 45 Chess960 or set-up starts.
- **Open:** `phase8-a11y.spec.ts:125` failed once on webkit-iphone earlier and did not recur on Juno (still to confirm on a real iPhone).
- **Open:** the Story's recount costs about 36–63 ms for one site and 150–290 ms for two on large histories.
- **Open:** the real iPhone check and the first Library open time with the reviewed history file are still to do.

**Wording pass, step 1 of the gift round (2026-11-15, not committed; no Juno, no push).** Plan: friendlier, less technical text on Games, Insights, Story, Review, Play, Analysis, Train and Settings.
- **Files:** new `src/ui/pointer-words.ts` (`tapWord()`: "Tap" if `(pointer: coarse)` matches, else "Click"); `game-rows.ts`, `games-list.ts`, `insights-review.ts`, `insights-view.ts`, `story/text.ts`, `story/view.ts`, `review-panel.ts`, `play-controller.ts`, `analysis-controller.ts`, `engine-lines-panel.ts`, `visualization-trainer.ts`, `puzzle-trainer.ts`, `settings-panel.ts` (+ CSS), `settings-data-section.ts`, `pwa.ts`, `app.ts`; tests and `scripts/check-hosted.mjs` in step.
- **Decisions:** the Games line and the row cell use one word, "reviewed" (device or in advance; they never overlap). The capture status (dot, text) shows only when the extension is connected or on localhost/127.0.0.1; the Auto-analyze switch stays. The "Technical details" fold is a plain `<details>`. The offline status reads "Ready to use offline"; the file count moved to `data-files` on `stat-offline` (the offline test and `check-hosted` read it there). The Insights game-by-game blunders card and the "What goes wrong most" card are hidden until a game is reviewed on the device. Quarter labels read "Apr-Jun 2023".
- **Deviation:** `phase6b-games.spec.ts:55` (same test as the banner lines) changed with the summary wording; the banner assertions are untouched.

**Story step 2, a richer Story (2026-11-15, not committed; no Juno, no push, no deploy).** Plan: the story of his chess career from data already on the device.
- **Files:** `src/story/stats.ts` (`STATS_VERSION` 3; new stats inside `scopeStats`, so all three scopes get them), `src/story/text.ts`, `src/story/view.ts`, a few card rules in `main.css` (bars, only what a new card needs); tests `story-stats`, `story-text`, `story-review-*`, `phase11-story.spec.ts`.
- **New stats:** endings of wins, losses and draws in a fixed set (checkmate, resignation, time, left, repetition, insufficient, agreement, stalemate, other), read from the `Termination` header by its ending words (never by the player's name; Lichess words too) with a mate check on the last move as the fallback; the exact time control beside the class; rating journey per site and class (replaces the 12-month trend); longest game and longest win (stored plies); streaks (wins, losses, unbeaten); time at the board (live-game hours from UTCTime to EndTime, days played, longest run of days, busiest day, month, year); comebacks (wins from under 5%, replaces the swing); best win and biggest upset; top variation per opening.
- **Cards (15 on one site):** intro, totals, time controls, how games end, openings, accuracy, mistakes, Brilliant and Great, most accurate game, comebacks, best win, records (streaks and longest game), time at the board, rating journey, closing. The Chess.com card shows only when both sites have games.
- **Result (laptop, plugged in; not committed, no Juno gate yet):** typecheck, lint, format:check clean; unit 1,025 passed, 1 skipped; Story e2e 31 of 31 on chromium and on webkit-iphone. Every measured fact of the real file matched (cross-check script outside the repo). Recount of the real file (4,575 games): 65–94 ms in Chrome, 80–144 ms in WebKit, 133–204 ms in plain Node (the old code was 133–176 ms there); the cost is `readPgnHeaders`, not the new stats. With one site `all` reuses that site's numbers.
- **Deviations:** 15 cards, not 14 (streaks and the longest game share the Records card). The Accuracy card lists the 3 most reviewed classes (the Time controls card lists all) and the Mistakes card lost its "average moves" sentence, because both were taller than the 375x667 scroll box with the real data (498 and 458 px against 459). `computeStoryStats` lost its `now` argument (the trend was its only use). `SHOWN_CARDS` is gone: every card `storyCards` makes is shown. Replaced tests: the 12-month trend and the swing cases became journey and comebacks cases.
- **Review round (2026-11-15):** card order is now intro, total, time at the board, rating journey, time controls, how games end, openings, accuracy, mistakes, Brilliant and Great, most accurate game, best win, comebacks, records, closing. The comebacks tie at the floor goes to the highest opponent rating, then the latest game. Ending labels read from the player's side ("You checkmated them", "They ran out of time", "You resigned or left"). American spelling in visible text (favorite, labeled, Color, defense, Canceled, Practice); identifiers, CSS classes and data attributes are unchanged. **Not changed because frozen:** "toughest defence" in `src/review/explain.ts` (loaded by the frozen review code; `review-explain.test.ts` still asserts it) and "Engine task was cancelled" in `src/engine/engine-client.ts`. Known layout oddities left as they are: the Rapid row on Time controls wraps, the Rating journey lines leave a lone month on a second line, the Total sentence leaves "119 D." alone.
- **Risks (as planned):** card height on a 375x667 phone (each card measured against the scroller); the recount time (36–63 ms today, must stay under about 150 ms); the replaced trend and swing tests are rewritten for their replacements, not removed.

## Open items from earlier phases

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
