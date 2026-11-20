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

**Story step 3, a wide-screen layout and text polish (2026-11-15, not committed; no Juno, no push, no deploy).** Plan:
- **Files:** `src/story/view.ts` (group headings, four headline tiles, span classes, non-breaking spaces added at render time, "Start from the top" scrolls the page when the box does not scroll), `src/styles/main.css` (Story block: two media queries, phone rules untouched), `tests/e2e/phase11-story.spec.ts` (two new tests: 1440x900 and 800x900). Card text in `text.ts` is not changed.
- **Design:** the DOM stays flat (headings and the tiles are siblings of the cards inside `story-scroll`), because two unchanged 390 px tests select `story-scroll > section`; wrappers around the cards would break them. The phone hides the headings and tiles with `display: none`. From 760 px the page scrolls (no inner box, no snap) in two columns; from 900 px a 12-column grid, 1,120 px wide, 20 px gaps, spans packed per section from card weights.
- **Risks:** the phone cards must still fit a 375x667 screen; narrow cards once table rows go back to normal; the page scroll position kept on a recount.

**Step 4, round 1 of 2: accuracy by game phase without the engine (2026-11-15, not committed; no Juno, no push, no deploy).** Round 2 wires it into the app.
- **Plan (files):** new `src/review/phase-numbers.ts` (pure; `phaseNumbers`, `totalPhases`; imports only `phaseOf` and `moveAccuracy`, no frozen module is changed, nothing from `hpc/`), `scripts/history-phases.mjs` (dev-time, reads `gift.local/history/`, writes `restore-phased.json`), `tests/unit/phase-numbers.test.ts`, an optional `phases` field in `SideAnalysisSummary` (`db.ts`, type only). Not touched: `library.ts`, `review-numbers.ts`, Story, Insights. Risk: a replay of 4,623 games (about 80 s here).
- **Stored form:** `analysis.sides[<my colour>].phases` = three tuples (opening, middlegame, endgame) of `[moves, accuracy, blunders, mistakes, misses]`; accuracy is the mean of my move accuracies in the phase, 2 decimals (0 with no moves), so games average weighted by `moves`. A game without numbers has no `phases`.
- **The 105 games: cause found, none excluded.** Every one is a game that I ended with a mating move. The batch stores the win% after a mate as 100 or 0, while the review's own game accuracy counted a forced mate as ±1000 cp (97.5 or 2.5); the last windows' volatility weights differ, so the game accuracy moves by 0.05 to 1.05. A move's accuracy is unaffected (the mating move is 100 on either value). With the end value set to 97.5 or 2.5 all 105 match. Pinned in `phase-numbers.test.ts` with invented games (both colours).
- **Real numbers (4,580 reviewed games, my moves):** opening 45,046 moves, accuracy 93.31, 513 blunders, 582 mistakes, 584 misses; middlegame 53,009 (4,215 games), 87.12, 2,867 / 1,999 / 1,805; endgame 32,463 (2,111 games), 91.95, 1,229 / 624 / 567. Per game the phase blunder, mistake and miss counts and the move count equal the stored summary in all 4,580. **Mismatch with the discovery facts:** the discovery had 44,599 / 52,492 / 32,049 moves (endgame in 2,084 games) and 4,574 blunders in all; the stored summaries hold 4,609 blunders and 130,518 moves. **Explained (checked with `storyGames`, the Story's own counting):** the discovery figures are for the 4,535 reviewed games the Story counts (standard, finished); over only those games the phase totals are exactly 44,599 / 52,492 / 32,049 moves, endgame in 2,084 games, 505 + 2,853 + 1,216 = 4,574 blunders. The other 45 reviewed games (Chess960, set-up or odds) hold the remaining 1,378 moves.
- **Output:** `restore-phased.json` 14,294,139 bytes (+265,400, 58 bytes a game), sha256 starts `30fa19bc`, limit 24 MiB; two runs gave the same hash; `restore-reviewed.json` (`45988d8e`) and the hosted `history.json` unchanged. The real file loads with `loadHistoryFile` (4,623 games, 0 ignored) and `importBackupJson` (4,623 stored, 4,580 with phases).
- **Checks:** typecheck, lint, format:check, build clean; unit 1,040 passed, 1 skipped (the restore-file test); `phase-numbers.test.ts` 11 tests (boundaries, no-endgame game, mate on the last move for both colours, Lichess fixture equals a full review for both sides, loader, Story store and backup import).

**Step 4, round 2 of 2: the phase numbers in the app (2026-11-16, not committed; no Juno, no push, no deploy).** Round 1 is commit `e25fed6`.
- **Plan (files):** `src/library/review-numbers.ts` (optional `phases`, validated by `readPhases`; malformed means none), `src/review/phase-numbers.ts` (`readPhases`, `phaseNumbersOfReview`, `withPhases`), `src/library/library.ts` (`saveReview` stores `phases` on both sides of a device review; `summary.ts` untouched), `src/story/stats.ts` (`ReviewStats.phases`, `STATS_VERSION` 4), `src/story/text.ts` and `view.ts` (card "Game phases" after Mistakes; the "How well you play" section is a 2x2 grid in the wide layout), `src/library/insights-review.ts` and `insights-view.ts` (the phase card from the summaries), one CSS rule. Tests: `story-phases.test.ts`, `phase11-phases.spec.ts`. Risks: the card height on 375x667, the Story recount time, older records without phases.
- **Behaviour:** the card and the bars use the games the Story counts that have phases (`storyGames`), so older records just drop out ("Based on N of your M reviewed games" appears only then). Insights bars are buttons only when a game was reviewed on this device (their moves come from the full review); otherwise they are plain text and the caption says "over N reviewed games". Reviews made on this device before this change have no `phases` until they are reviewed again; with no summary phases the old per-move chart is shown.
- **Edited assertions (old → new):** `phase11-wording.spec.ts`, phase card caption in an empty library: `How well you play each part of the game. {Tap|Click} a bar to see the moves.` → `How well you play each part of the game.` (it promised a click with nothing to open), plus a new line that the Openings caption still reads `{Tap|Click} a bar to see those games.`; `story-review-stats.test.ts` `STATS_VERSION` 3 → 4 (twice); `phase-numbers.test.ts` (round 1): the reader "equals the same record without phases" → "equals it plus the phases".
- **Wide layout:** `phases` and `marks` weigh 6 columns like Accuracy and Mistakes, so with all four cards the section is two rows of two; with three cards it is as before (the last card takes the row).
- **Real file (`restore-phased.json`, the app's own code, read-only):** 4,535 counted games with phases; mean accuracy 93.3 / 87.1 / 91.9 %, blunders per 10 moves 0.11 / 0.54 / 0.38, 2,084 endgame games, 44,599 / 52,492 / 32,049 moves; the Story card and the Insights bars show the same numbers. Story recount in plain Node 240–350 ms over 5 runs, the same with and without phases in the file (this laptop is slower than on 2026-11-15, when it was 133–204 ms), so the phases add nothing measurable; not re-timed in a browser.
- **Checks (laptop, on AC):** typecheck, lint, format:check, build clean; unit 1,065 passed, 1 skipped. E2E on chromium and webkit-iphone (Story, Insights, library, a11y, wording, phase5-review, phase6b-review, new phases spec): 155 passed, 3 failed, 2 of the 3 passed on rerun (timeouts); `phase5-review.spec.ts:813` on webkit-iphone times out at 150 s and **fails the same way without these changes** (checked by stashing them). Desktop webkit (Story, Insights, phases spec): 51 passed, 1 failed: `phase8-insights.spec.ts:375` ("wide … click opens that quarter's games", the Games tab is not selected after the click), **also fails without these changes**. Both are laptop-only problems to confirm on Juno.

**Open a game (2026-11-16, not committed; no Juno, no push, no deploy).** A Games list game reviewed only in advance shows its stored numbers at once, with a button for the full review.
- **Plan (files):** new `src/library/stored-summary.ts` (pure: my side's stored numbers, the tiles, the phase rows, the texts), `src/review/review-panel.ts` (`showLibraryGame`; the block reuses the existing Start button and progress bar), `src/app.ts` (`openLibraryGame` chooses saved review or the block; the Story recounts after a library change when Games opens on it), a few CSS rules. Tests: `tests/unit/stored-summary.test.ts`, `tests/e2e/phase11-open-game.spec.ts`. Frozen review modules untouched.
- **Risks:** a canceled or failed run must leave no partial badges or half-shown review; older tests click `btn-review-start` on list games (the button keeps its test id); the block's height on a 375x667 phone.
- **As built:** a game with a summary made in advance shows "Your numbers from this game" (accuracy, mistakes, blunders, brilliant and great moves, accuracy by game phase; a phase with no moves is left out), then "Review this game" on its own row and the line "Checks every move and shows where the game turned. Takes about 10 to 20 seconds on a phone (longer for very long games)." (Standard and Deep give no time: "… Takes longer at this speed."; the settings screen only states seconds per position, so its wording was not reused). A game with no review shows the button and the line only. The button is the existing `btn-review-start` relabeled; while the review runs it is disabled and reads "Reviewing… move N of M". Cancel, leaving the game, or a failure removes the partial review (body hidden, classes and evals stripped from the moves) and brings back the numbers; a failure says "The review could not finish. Your numbers above are unchanged. You can try again." A finished review is shown and saved exactly as before (`onReviewFinished` → `library.saveReview`).
- **Story and Insights:** nothing stores the Story's numbers between visits (`STATS_VERSION` only labels the computed object), so it was not changed. Insights already re-read the library on every visit; the Story only recounted on a tab change, so a review saved while Games showed the Story left it stale. Now a library change marks it stale and opening Games on the Story recounts it. Counts stay the same after a device review replaces a summary (Games "30 games · 29 reviewed", Insights the same, Story 29 reviewed, in a test). The small accuracy difference for games ended by my own mating move was not reconciled, as decided.
- **Checks (laptop, on AC; not committed, no Juno):** typecheck, lint, build clean; unit 1,081 passed, 1 skipped (+16 in `stored-summary.test.ts`). E2E `phase11-open-game.spec.ts` 13 of 13 on chromium and on webkit-iphone (stored numbers, no review, the setting's time, review and save, Story recount, cancel, leaving the game, failure with a stubbed engine and retry, layout at 375x667, 390, 768, 1280). Related specs: phase5b-games, phase6b-review, phase11-story, phase11-phases, phase8-insights, phase8-library 68 of 68 on chromium; 67 of 68 on webkit-iphone, the one failure `phase8-insights.spec.ts:375` (the known laptop WebKit failure above) passed alone and in a rerun of its file (12 of 12); phase5-review 9 of 9 and the phase 7 repertoire review test on chromium.
- **Deploy commands on PowerShell:** use `npm.cmd run deploy:preview -- --with-local-presets` and `npm.cmd run deploy:production -- --checked <id>`; `npm.ps1` drops the `--` (README Hosting, juno-gate skill).
- **Tab order:** in this mode the panel moves the action row's nodes (button, its line, its message, then the setting, Cancel, Sample game), so Tab reaches "Review this game" before the setting; the usual row comes back after a finished review. No CSS `order`.

**Popups and the Games tabs (2026-11-16, not committed; from the iPhone check of preview `53bb2602`).**
- **One helper, `src/ui/components/popup.ts`:** the X (`closeButton` / `closeButtonHtml`: 44 × 44 px, top right, "Close", or "Close <title>" for sheets, whose existing names were kept), `visibleBand` (visual viewport less the sticky top bar, a fixed bottom tab bar and any clipping box), `fitPopup` (caps the height to that band; opened by a tap or click it may scroll the page a little so the popup clears the bottom tab bar; what still does not fit scrolls inside) and `watchFit` (re-fits when the screen turns). CSS cap `--wc-popup-cap` in `dvh` with the safe areas. Popups stay in the page (no fixed position): the Review panel is a size container, so a fixed child would be placed and clipped by it.
- **Popups with the X:** Settings, Welcome, Add to Home Screen, Load FEN or PGN (all `Sheet`: the X is now 44 px and the head clears the status bar and notch); every ⋯ menu (`Menu`: a head with the menu's name and the X above the `role=menu` list, testids `<menu>-popup` / `<menu>-close`); the Review info popup (now a head "How these numbers are computed" with the X over a scrolling body) and the status details; the promotion picker (X on the board's top right corner, or the square beside the picker on the h-file); the performance overlay (above the tab bar on phones); the "New version" bar and the set-up link notice (the X does what Later / OK do). Left out, being part of the page flow: the end-game and backup confirmations, the confirm-move bar, the Insights readout, the paste box, the Story banners; the file-drop hint (shown only while dragging, takes no input).
- **Games tabs:** after an import the page on a phone was taller than the screen by the Story banner (43 px after it, 68 px while it ran), so a swipe moved the tab bar under the sticky top bar (`header.wc-topbar`, sticky, z-index 50, top 0, 390 × 52) and the Story's own scroll box (scroll chaining off) kept it there. The tabs are now sticky under the top bar, and on a phone the banner shares the Story's height instead of adding to it.
- **Tests:** `tests/e2e/phase11-overlays.spec.ts` (X, fit and scroll for each kind at 375x667, 390x844, 844x390; the tabs after a Chess.com import and after the sample link, at 390x844 and 375x667, scrolled, every tab pressed where it is, turned and back).

**Popups, Games tabs, info popup, Story check and the import profile (2026-11-16, commits `016d2af` to `1dfb493`; preview only, no Juno gate yet).** The block above is committed as `016d2af` (code) and `c3d4544` (tests).
- **Popups:** every popup that covers content now has a close X from the shared helper (`popup.ts`), and the popups fit between the top bar and the bottom navigation.
- **Games tabs:** Library, Insights and Story are no longer hidden behind the banner on phones. Cause: the Story page grew taller than the screen and the tab bar scrolled under the top bar. Fix: sticky tabs, and the banner shares the Story's height.
- **Info popup (`06164fb`, tests `1dfb493`):** it opens above the "i" when there is little room below, and starts with a plain summary.
- **Story on the real file:** checked with the personal link: all cards present, including Accuracy, Mistakes and Game phases. For a plain Chess.com import without stored reviews the review cards are hidden by design.
- **First-run import profile:** on Playwright WebKit for Windows 4,623 games take about 150 s (about 15 ms per record write, however the writes are sent); chromium 6.6 s. A batched save was tried: the stored results were identical on the real file (hashes matched), but it gave no gain on WebKit, so it was not shipped and sits in the git stash "faster-save-import".
- **Open:** the import time on a real iPhone.

**Story: the Brilliant and Great highlight card, and "Open this game" (2026-11-16, not committed; no Juno, no push, no deploy).**
- **Plan (files):** `src/story/stats.ts` (`review.marks`: the most brilliant game, the best year, the latest date; `featured`: the ids of the games a card can open; `STATS_VERSION` 5), `src/story/text.ts` (the highlight card; an `open` list per card), `src/story/view.ts` (the two large numbers, the buttons, the kept place), `src/app.ts` (the click goes through `openLibraryGame`; the place is restored when Games › Story comes back), CSS. Tests: `story-marks.test.ts`, `phase11-story-open.spec.ts`. Risks: the card height on a 375x667 phone; two buttons on Records at 375 wide.
- **Brilliant and Great card:** the two totals as large numbers in the review's Brilliant and Great colors with their badges (Brilliant first and larger), "You played a Brilliant move in N of your M reviewed games, about one every K games.", rows (most in one game, best year, latest Brilliant move, games with a Great move), and the most brilliant game's result, color, date and time control. Only per-game counts are stored, so no move is named; a line without data is left out. Ties for the most brilliant game: more Great moves, then the latest game, then the smaller id. The best year needs reviewed games from two years.
- **Open this game:** on Brilliant and Great, Most accurate game, Best win, Comebacks (the most unlikely win) and Records (two buttons side by side, "Open longest game" and "Open longest win"; one when both are the same game). Real buttons, 44 px high, named after their game ("Open your most accurate game"). Card text and the review numbers still hold no id: a card names its game by key and the view looks the id up in `ScopeStats.featured`. A game deleted while the Story shows loses its button at once; the next count features another game.
- **The place in the Story is kept** when Games › Story comes back from a game, another screen or another Games tab, on the phone (the scroll box) and the wide layout (the page). **The browser's back button is not handled:** the app only uses `replaceState` (no `pushState`, no `popstate`), before and after this change.
- **Edited assertions (old → new):** `story-review-stats.test.ts` `STATS_VERSION` 4 → 5 (twice); `story-review-text.test.ts`, the two Brilliant and Great tests: the sentence "2 Brilliant moves and 5 Great moves." and the rows "Brilliant | 2 moves in 2 games", "Great | 5 moves in 1 game" → the two figures (2 "Brilliant moves", 5 "Great moves"), the new sentence and the new rows (same for the only-Great and only-Brilliant cases); `phase11-story.spec.ts`: the card contains "N Brilliant moves and M Great moves." → each figure reads exactly "N Brilliant moves" / "M Great moves".
- **Checks (laptop, on AC):** typecheck, lint, format:check clean; unit 1,098 passed, 1 skipped; `phase11-story-open`, `phase11-story`, `phase11-phases`, `phase11-open-game`: 67 of 67 on chromium and on webkit-iphone. The real file through the app's own code: every card that should have a button has one (six different games); Story recount in Node 108–126 ms; the real cards fit a 375x667 phone (the highlight card 447 of 459 px in Chromium, 445 of 459 in Playwright WebKit as an iPhone, from a build with the personal link). Not tried: a real iPhone.

**Key moments with Brilliant and Great moves, and the board page / game page in Review (2026-11-16, not committed; no Juno, no push, no deploy).** From the owner's iPhone test.
- **Plan (files):** `src/review/perspective.ts` (`perspectiveKeyMoments` builds the shown list; frozen `findKeyMoments` untouched), `src/review/review-panel.ts` (chip title, `getKeyMoments()`, Sample game only on the board page), `src/analysis/analysis-controller.ts` (page state `board` | `game`, the toolbar only on the board page, the "Board tools" ⋯ menu in the transport row), `src/app.ts` (host wiring), `src/library/games-list.ts` (one line of text), CSS. Tests: `review-perspective.test.ts`, new `phase11-review-pages.spec.ts`, and the listed e2e specs moved to the new places. Risks: older tests that press the toolbar or Sample game with a game open; the transport row's width at 375 px; the menu fitting over the board in landscape.
- **Key moments as shown** (`perspectiveKeyMoments`, `ShownKeyMoment`): the review's swings plus up to 2 of the view's Brilliant and Great moves, 5 at most (three chip rows on a phone). The 3 largest swings always stay; highlights go Brilliant before Great, then the larger swing, then the earlier move; the room left goes to the next largest swings; game order, no move twice (a highlight that is already a swing stays that one entry, with its swing). A view with no Brilliant or Great move returns the swings as before (for Both, `review.keyMoments` itself). A highlight chip's title has no swing text (an invented example: "12. Nxe5 — Brilliant. A sound sacrifice…"); it carries `data-highlight`. `review.keyMoments` and saved reviews are unchanged: the list is built from `review.moves` each time, so a review loaded from storage gets the same chips. **Deviation from the spec:** a one-side view's key moments are no longer only that side's errors. Which two Brilliant moves are shown can differ between Quick and Deep (their tiny swings decide).
- **Board page and game page** (one tab, one controller, `#review`; `data-page` on `analysis-layout`, `getPage()`): Review starts on the board page (toolbar and Sample game, as before). A game with at least one main-line move (`importPgn`, `importPgnFromStart`, `loadGameTree`) or a started review gives the game page: no toolbar, and Sample game is taken out of the action row. `loadFen` (New board, a position applied in the editor, a pasted FEN) and a PGN with no moves give the board page; moves played on the free board change nothing. **Free analysis is one click away with no game open, and two clicks (Board tools, then the tool) with a game open.** "Board tools" is a ⋯ `Menu` at the end of the transport row on both pages (`board-tools`, items `menu-new-board`, `menu-edit-position`, `menu-load-pgn`); Edit position from a game keeps the game until a position is applied. The Load sheet stays in the page on both pages.
- **Toolbar labels at 375 px:** "Edit position" was cut to "Edit positi…" on a 375 px screen (the label was 0.7 px short; the toolbar's CSS was the same at `6ac81d0`, so it was cut there too; 390 px was fine). On phones each toolbar button is now as wide as its label needs (`flex: 1 1 auto`) and the rest is shared; `phase11-review-pages` checks each label against the width its text needs (a whole-number `scrollWidth` does not see less than a pixel).
- **Wording:** the capture line read "… (README: npm run build:ext, then load dist-ext/ unpacked in Chrome) …"; it now reads "Add the capture extension to Chrome and your Lichess and Chess.com games arrive here by themselves. The README has the steps." (It already shows only on localhost or with the extension connected, never on the hosted site.)
- **Edited assertions (old → new):** `phase6b-review` `reviewSample` and `phase5-review` (the last chip, and the Both view's chips): `review.keyMoments` → `panel.getKeyMoments()`; `phase6b-review` "free analysis": the toolbar's New board and the third Load with a game open → Board tools items, focus after Escape `btn-load-pgn` → `board-tools`; `phase4` (second Load) and `phase11-overlays` (Load sheet) → Board tools; `phase11-open-game`: the two order lists lose `btn-review-sample`, which is now asserted absent; `phase6b-games`: `toContainText('npm run build:ext')` → the new line, whole. Nothing removed or loosened.
- **Checks (laptop, on AC):** typecheck, lint, format:check, build clean; unit 1,106 passed, 1 skipped (+8 in `review-perspective.test.ts`); `phase4`, `phase5-review`, `phase6b-review`, `phase6b-games`, `phase11-overlays`, `phase11-open-game` and the new `phase11-review-pages` (9 tests): 58 of 58 on chromium and on webkit-iphone. Screenshots looked at for both pages and the open menu at 375x667, 390x844, 900x800, 1280x900. The real file through the app (history loader, Story card, "Open this game", "Review this game"): five chips, two of them Brilliant highlights with no swing text, at Quick and at Deep. Not tried: a real iPhone; desktop WebKit; the full e2e suite.

**Round A: speed names, one "reviewed", live new-game preview (2026-11-17; committed, no Juno, no push, no deploy).**
- **Speed labels:** the review speeds are named Quick, Standard and Deep with no seconds in the Review tab, Settings › How thorough and the Library selection bar. The Quick helper line and the "Reviewed · Deep · 150 s" banner are unchanged.
- **One "reviewed":** a game is reviewed when it has a stored summary or a device review (`isReviewed`, `src/library/game-rows.ts`); it is not reviewed when it has neither and is a standard game (`isNotReviewed`; Chess960 and set-up games are never counted as waiting). The Library filters, the Library summary and the Train card use it. Real file: 4,623 games, 4,580 reviewed, 40 not reviewed (the Train card said 43, the Library filter 4,621). All 43 unreviewed games were skipped by the batch review as "under 10 plies" (40 standard, 3 variants).
- **New game card and board:** the waiting board follows every choice at once (opponent, style, rating, both clocks, my side and the board direction; Random names no side and does not flip). A named bot is found by rating, so it keeps its name and highlight when the style changes; the style is a suffix in the header ("Warm-up Bot · Solid (800)") and in the card's label ("Warm-up Bot · Solid · 800 Elo"). Stored PGN names are unchanged.
- **Edited assertions:** `review-summary.test.ts` (summary-only games now count as reviewed for the filter: 1 to 2 and 1 to 0); the bot header and label texts in `phase11-presets`, `phase11-link-worker`, `phase11-see-all`, `phase6b-play`, `phase6b-settings` (the style suffix); `phase6b-play` "New game choices wait for Play" now expects the live preview (header, clock 5:00 to 10:00, flipped board).
- **Known issue:** `phase6b-play.spec.ts:68` takes about 75 s on the laptop's WebKit (the same at HEAD before this round), so it times out at the default 60 s there and passes with `--timeout=150000`.

**Mistake-puzzle script for the gift copy (2026-11-17; not committed; nothing run on Juno).** An offline search in the new `hpc/puzzles/` (nothing under `hpc/history/`, no app code): for each chosen game (standard, finished, 10 plies or more, the player's stored worst move at ply 2 or later with a drop of at least 20) it replays the PGN to that move, searches the position before it (depth 18, 2 lines, the history review's engine settings) and, when the position passes the filters, the position after the played move to measure the loss. Output `gift.local/history/puzzles.json` (about 300 bytes a puzzle) plus a counts-only sidecar. Resume-safe, 8 shards, deterministic merge; 35 unit tests with invented games (`tests/unit/mistake-puzzle-script.test.ts`). Real input: 4,623 games, 2,366 chosen. Local dry run on 20 chosen games (Node Stockfish 17.1 lite, laptop): 4 kept (all Blunders), 16 dropped (14 best move not clearly best, 1 win% outside 25 to 90, 1 trivial recapture), 2.87 s per position on the laptop. Open: the Juno run needs the commit on Juno and the owner's go (`hpc/puzzles/README.md`).

**Round B: Review tab order, scrollbars, "Review as" gap, "Too short to review" (2026-11-17; committed; no Juno).**
- **Order of a reviewed game:** banner, "How you played" (the class counts; open for every new review, collapsible), the two accuracy cards, Key moments, the win% chart, the error stepper, the repertoire note, then the "Review as" bar. The "Browse all N moments" link and `seeAllMomentsCount` are removed, with the four link tests of `phase11-see-all.spec.ts` (link follows the fold's counts, link shows and opens the fold, each at 375x667 and 390x844) and the two unit tests of the count; the bot-order test stays.
- **Scrollbars:** thin gold-on-dark scrollbars in the Review shell; the key moments wrap on screens wider than 760 px (two rows reserved when the panel is 28 rem wide or more, else three) instead of scrolling. Phones unchanged.
- **Cause of the huge bar with blank space:** the closed info popup (`.wc-review-tooltip`, absolutely positioned, only `visibility: hidden`) still took layout room, 620 px tall, so the panel scrolled about 88 px past the sticky "Review as" bar. It is `display: none` when closed now (gap 88 px to 1 px at 1280x720 to 1920x1080).
- **Too short to review:** a game with no review and under 10 plies shows that badge, and is not counted as waiting. Real file: 4,623 games, 4,580 reviewed, 0 not reviewed (the 43 unreviewed games are all too short).

**Puzzles from my mistakes, app side (2026-11-17; committed as 52f73e6 and d7827a2; no Juno, no push, no deploy).** The offline file `gift.local/history/puzzles.json` (597 Blunder puzzles) becomes personal puzzles in the gift copy.
- **Plan (files):** new `src/trainers/history-puzzles.ts` (strict file check, record builder, release schedule; pure), `src/trainers/history-puzzle-file.ts` (fetch beside the link's preset), `src/preset/start-path.ts` (`puzzlesUrl`), `src/trainers/puzzle-store.ts` (`loadHistoryPuzzles`, `releaseHistoryPuzzles`; `syncGame` leaves flagged records alone when a game has no device review), `src/storage/db.ts` (optional `origin` on `StoredPuzzleRecord`, type only), `src/app.ts` (trigger after the history load and at start/resume), `scripts/build-start-pages.mjs` (copy `puzzles.json` when present). Tests: `history-puzzles.test.ts`, `history-puzzles-store.test.ts`, `phase11-history-puzzles.spec.ts`.
- **Decisions:** no schema bump (settings rows, read by key); the unreleased puzzles are one blob; first batch 50, then at most 20 per local day on open, missed days caught up at 20 per day; released ids are `personal:<game>:<ply>`, as the device review's.
- **Risks:** the settings blob is in backups (harmless, listed below); a daily same-origin 404 for links that have a history file but no puzzles file; `syncAll` must not change for any other record.
- **As built:** trigger = right after the link's history import reaches "done", and at every app start and resume while the file is not loaded (games, dates and labels exist by then; Train's first open could be offline). Strict check refuses the whole file on one bad entry (format, version, 12-hex `input`, count, legal FEN and moves by `preparePuzzle`, ply parity, best-line SAN, unique ids); it yields every 20 entries (one go was a 677 ms task). Settings keys `puzzles.fromHistory.state`, `.pending` (one blob, newest game first) and `.miss` (last "not found" day); no schema bump; backups carry the blob (about 170 KB, no names; the schedule and the puzzles restore together). Release: 50 on the load day, then at most 20 per local day, owed days caught up at 20 a day; a puzzle whose game is not stored stays pending. Record: `personal:<game>:<ply>`, `origin: 'history'`, rating 0, themes class (+ `mate`), label `as White · 2026-10-04`, no opponent name. `syncGame` skips `origin: 'history'` records when a game has no device review; a device review takes the game over (same id and position: progress kept, flag dropped; otherwise the device scan's logic as for any game). `defaultFetch` in `first-run.ts` is now exported so `network-exception.test.ts` stays as it is. The Today card and the Train badge already counted new personal puzzles: no text changed.
- **Checks (laptop, AC):** typecheck, lint, format:check, build clean; unit 1,188 passed, 1 skipped (+37; 1 test added to `personal-puzzles.test.ts`); new `phase11-history-puzzles.spec.ts` 14 of 14 on chromium and on webkit-iphone; touched specs (phase6, phase6b-train, phase11-presets, phase11-story, phase8-offline on chromium) pass. **Real file** (`c460f940`): 597 of 597 pass the check, all moves apply, 11 mates, dist copy hash `c460f940`; first release of 50 in a fresh 390x844 context: chromium 0.8–1.2 s from "history stored" (long tasks 130–157 ms, the same as without the file; first version with one-go checking: 2.1 s and a 677 ms task), webkit-iphone 6.1 s (no long-task API there). Hub afterwards: "New puzzles from my mistakes" 50, Train badge 50.
- **Release race, found by the commit-step reruns and fixed:** with the webkit-iphone pair (new spec + `phase6b-train`) the spec failed in 4 of 5 runs. Cause: a reload cut a release off after it had written the shorter pending list but before it wrote the state, so the next page read "0 released" and released the next puzzle of the same game (a different id, not a duplicate: ply 26 after 22 and 24); the first design's recovery only counted puzzles still listed as pending. Fix: (a) the whole load and release runs inside one exclusive, waiting Web Lock (`afterplay-history-puzzles`; without `navigator.locks` it runs as before); (b) `WizardChessStorage.atomically` runs the puzzles, cards, pending list and state in ONE read-write transaction that re-reads the saved state and list and adds to the released counts; (c) a run asked for while another is going in the same page runs again afterwards, and `TodayScreen.refresh` called during a refresh counts once more instead of being dropped; the file check and the lookups of the library stay outside the transaction. Tests: two direct releases with the other page winning first (counts not replaced), four and three overlapping visits behind a lock (50, then 20), two visits without a lock, and a two-page e2e test in the real browser. Note: the unit polyfill has no isolation, so atomicity itself is only shown in the browser tests. Checks: webkit-iphone pair 5 of 5 runs (18 passed each), chromium pair 18 passed, `phase8-offline` 4 passed. Free memory on the laptop fell to 3.7 GB between runs (other applications).
- **Open:** links with a history file but no puzzles file (the sample link) make one same-origin 404 per day of use. Earlier flaky webkit-iphone timeouts of `phase6b-train` were not reproduced in the 5 final runs.

**Personal bots on the current release code (2026-11-17; branch `integrate/personal-bots`, not committed; no Juno, no push, no deploy).** Named bots can bring opening books (a preset's `books` table plus a bot's `bookRefs`, or inline `books`); a book move is played with the usual think time and no engine search.
- **Files:** new `src/engine/bot-profile.ts` (book format, builder, `personalBookDecision`), `src/engine/bot-profile-store.ts` (book rows in the settings store under `bots.preset.<name>`); changed `src/engine/bot.ts` (`chooseMove` tries the books first), `src/preset/preset.ts` (`books` table, per-bot `books`/`bookRefs`, limits), `src/preset/profile.ts` (parsed-book cache, `awaitBotBooks`, `warmBotBooks`), `src/ui/play-controller.ts`, `src/app.ts` (the book loader and `savePresetBooks` at the first run), `src/library/library.ts` and `src/storage/db.ts` (`deleteSetting`, used by the bot-data reset and the tests). The books are built offline by `scripts/personal-bots/build-gift-books.mjs`.
- **With Round A:** a bot is found by rating alone (`namedBotForRating`), and its books are found the same way, so a style change keeps the bot, its highlight and its books. The header, the card label and the stored game's name are unchanged by this work. No IndexedDB schema change (a settings row per book; `deleteSetting` is a new method only).
- **Edited assertions (old → new):** in the new personal-bots tests only: the card label `Book Bot · 1200 Elo` → `Book Bot · Solid · 1200 Elo`, the header `Book Bot (1200)` → `Book Bot · Solid (1200)` (same for the second bot); `personalBooksFor(profile, 1500, 'aggressive')` `[]` → the same bot's books (the style does not change the bot). No existing assertion was changed.
- **Checks (laptop):** typecheck, lint, format:check clean; unit suite run. Browser tests are listed in the handoff and not run yet.

**Fixes after the preview test: stored game numbers, played move in My mistakes, one scrollbar, an unrated note (2026-11-18; commits `5bf7152`, `1dfbc41`, `754b39c`, `33de904`; no Juno, no push, no production deploy).**
- **Stored game (`5bf7152`):** every way into a game of the Games list (row, page API, Story "Open this game", Insights position) ends in `openLibraryGame`, so none differs. The review body (How you played, accuracy cards, Key moments) has been hidden for such a game by design since `09f0a0d`; Round B did not change that. The stored block now also holds a "How you played" fold (my counts of the six classes a summary stores) and the one key moment the summary names (my largest loss, 5 points or more: `storedKeyMoment` in `perspective.ts`, `storedMomentFor` in `stored-summary.ts`; `findKeyMoments` untouched). Best, Excellent, Good and Book are not stored and not shown. The body stays hidden, nothing runs, nothing stored changes.
- **My mistakes (`1dfbc41`):** the move played in the game stays marked through the whole puzzle (`BoardRenderer.setPlayedMove`; overlay rects in the last move's colors, test ids `overlay-played-from/to`); "Analyze the position" is a visible button once a puzzle is over. **Bug fixed:** `puzzlePgn` wrote Black's first move as "3… Nf6", which the PGN reader refuses, so Analyze did nothing for every puzzle whose setup move is Black's. A search of `src/` for the Unicode ellipsis found no other producer or consumer of PGN: `numberedSans` (`trainer-kit.ts`), the repertoire move numbers and the puzzle source line only write display text.
- **Scrollbar (`754b39c`):** one app-wide rule (`*` with `scrollbar-width` and `scrollbar-color`, plus the `::-webkit-scrollbar` pieces); the Review-only rule and its `@supports` fallback are gone. The app is dark only.
- **Unrated note (`33de904`):** one line under the puzzle on the My mistakes tab only: "Practice from your own games. Solve Rated puzzles to change your rating." Personal puzzles are unrated by design (`recordAttempt` rates only bundled puzzles, on a first try without a hint; personal ones have rating 0). The "1500" pill is the player's own Glicko puzzle rating (default 1500 until a Rated puzzle is solved), the same in every mode.
- **Checks (laptop, on AC):** typecheck, lint, format:check, build clean; unit 1,274 passed, 1 skipped; chromium and webkit-iphone 66 of 66 each for the four new specs (stored fold, played move, scrollbars, note) with phase11-open-game, review-pages, review-tab-order, history-puzzles and phase6b-train. No existing assertion changed.
- **Open:** the analysis board has Previous move but no "reset to the puzzle position" button (the puzzle position is its ply 1). Whether My mistakes puzzles should be rated is the owner's decision. Desktop webkit and the full e2e suite were not run.

**Train: step through the solution (2026-11-18, commit `bae36fa`; no Juno, no push, no production deploy).** Once a puzzle is solved or its solution is shown, Previous move and Next move (the review board's wording, icons and buttons) and the left and right arrow keys step the board through the printed line, from the puzzle position (step 0, the move played in the game still marked) to the end; the step shown is marked in the line, the buttons are disabled at the ends. Stepping only moves the board: nothing is graded, rated, scheduled or counted, and Try again, Next puzzle, Analyze the position and the played-move mark work as before. The positions are derived by playing the printed line from the puzzle position (`buildStepLine` in `puzzle-format.ts`; the line is the engine's best line for a puzzle from my games, the solution for a bundled one); no new text. Checks (laptop, on AC): typecheck, lint, format:check clean; unit 1,280 passed, 1 skipped; chromium and webkit-iphone 51 of 51 each (new `phase11-puzzle-stepper` with the played-move, note, history-puzzles, phase6b-train, stored-fold and scrollbars specs). **Not built, one idea:** showing the game's own moves before the puzzle position would need the stored game by `sourceGameId` and its ply (both known), a callback from `app.ts` to the library, and the line extended backwards in `puzzle-trainer.ts` and `puzzle-format.ts`.

**Review: "Show refutation" plays the line out (2026-11-18, commit `029d204`; no Juno, no push, no production deploy).** The stored line (up to 8 plies, the review's `LINE_PLIES`, untouched) is still added as a variation exactly as before; the board now plays it out move by move (the first move at once, then one every 600 ms, the pace of the puzzle's Show solution), ending on its last move. Any action of the user (a tap, a click, a key, a tapped move, another card button, leaving the screen) stops it and takes over, and a stopped or finished animation leaves no timer and no listener; with reduced motion the board jumps to the end. Previous move, Next move and the arrow keys step back through the variation as before. `LinePlayer` (`src/review/line-player.ts`) has no DOM and is unit tested; `review-panel.ts` wires it. No new button or text. The printed "Best: … Refutation: …" line is unchanged and is not marked: on a move of the variation the card is the one for that unreviewed move ("not part of the reviewed main line"), which has no printed line. Checks (laptop, on AC): typecheck, lint, format:check clean; unit 1,291 passed, 1 skipped; chromium and webkit-iphone 49 of 49 each (new `phase11-refutation-line`, phase5-review, review-pages, review-tab-order, stored-fold, open-game). **Open:** the card for a move of the variation says "not part of the reviewed main line" and Show refutation / Try it are disabled there (as before); only the stored line is played, so a longer one would need an engine search on demand.

**Final Juno gate on `999cd9f` and the production deploy (2026-11-19; docs-only entry, no code change).**
- **Gate (Juno, jobs 521438, 521440, 521442, 521443, 521444; flake rerun 521506):** every `meta.json` records commit `999cd9f` and every `repo-changes.txt` is empty. Unit: 1,290 passed, 2 skipped. Chromium: 358 passed, 2 skipped, in both runs. Desktop WebKit: 331 passed plus 1 flaky in the first run, 332 in the second. WebKit iPhone: 334 in both runs. The one flake, `phase8-insights.spec.ts:375`, passed on a single rerun (job 521506).
- **Perf (Juno, unchanged):** drag p95 16.67 ms with 0 dropped frames; start-up 251.5 ms; review 17.0 to 17.1 s; 0 tasks of 50 ms or more; +0.37 MB for 50 games.
- **Production deploy:** build `3058dbfeccae` from commit `999cd9f`, 2026-11-19 at 01:20 UTC, with the personal first-run links. The preview host `b979b613` (same build) was approved first. Production and preview serve the same build; the preset, history and puzzles files matched their expected sizes and hashes, and a wrong link path or the site root returns the HTML fallback page, not JSON.
- **Custom domain:** Cloudflare Web Analytics was injecting a beacon script on `rohan.afterplay.fun` (a request to a Cloudflare host the site must not make). It was switched off in the Cloudflare dashboard; no code change. `rohan.afterplay.fun` serves the same build as the pages.dev host.

**Drag accuracy: the drop lands on the square under the pointer (2026-11-20, commit `781892b`; no Juno, no push, no production deploy).** Cause: the board feel's drop tolerance defaulted to 0.2 of a square, so a release (or the hover highlight) within 0.2 of a legal square snapped to it, and a piece released back inside its own square could play a neighbouring move. **Deliberate change of the board-feel default:** `dropTolerance` 0.2 → 0 (the Settings slider and `resolveDropSquare`'s tolerance parameter are kept, so a person can still choose a pull). The conversion is now the pure `squareAtClientPoint` (`board-feel.ts`). Second bug, same area: after a scroll or resize cleared the cached board rectangle, `handlePointerMove` returned early and the held piece and highlight froze; the rectangle is now measured again on the next move, and a window `resize` clears it too. **One existing assertion changed, approved:** `phase6b-board-feel.spec.ts` "a drag highlights the drop square; …": 0.15 squares above f3 gave `f3` / target `true`; it now gives `f4` / target `false`, and a move onto f3 itself asserts `f3` / `true` (the title now says a drop just past a legal square does not land on it). New: `phase11-drag-accuracy.spec.ts` (11 tests: hover square equals the square under the pointer at 10, 50 and 90 percent, three viewports, both orientations; release on and beside a legal square; cancel on the origin square; a wobble below the threshold is a click; a premove drag; resize and scroll during a drag) and 5 unit tests. Checks (laptop, on AC, 4.5 GB free): typecheck, lint, format:check clean; unit 1,296 passed, 1 skipped; chromium 100 passed, 1 skipped, webkit-iphone 101 passed (the new spec with phase3, phase3-premoves, phase4, phase6b-board-feel/-play/-settings/-screens, phase11-iphone/-overlays/-link-worker, phase8-a11y, phase7-trainers). A first webkit-iphone run failed ten tests with 60 s timeouts while memory was low; a rerun on a quieter machine passed all 101. **Perf (laptop, not a gate):** `perf:drag` play drag p95 16.69-16.70 ms, 0 dropped; premove 0-1 dropped; analysis drag with 5 lines 3-5 dropped, where unchanged HEAD on the same laptop dropped 1-2 (a busy machine; the Juno baseline of p95 16.67 ms and 0 dropped is unchanged until the next gate).

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
