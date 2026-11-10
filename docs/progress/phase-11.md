# Phase 11 — Hosting, iPhone support, presets: detailed log

Moved here verbatim from PROGRESS.md as each stage is reported (the phase is still in progress; PROGRESS.md keeps a summary).

## Stage 1 — hosting on Cloudflare Pages + updates

**Stage 1 plan: hosting on Cloudflare Pages + updates**
- `public/_headers` (copied into `dist/`): COOP / COEP / CORP on every path, `no-cache` for `index.html`, `sw.js` and the manifest,
  `immutable` for hashed `assets/*` and `stockfish/*`. A unit test checks it sends the same isolation headers as `serve.mjs` / Vite.
- `scripts/deploy.mjs` with `deploy:preview` and `deploy:production` (Wrangler as a dev dependency, asked first):
  - preview: clean git tree required, builds, hashes `dist/`, uploads to the Pages project's `preview` branch, prints the preview
    URL and a short build id, records `{commit, dist hash, url}` in the git-ignored `.deploy/preview.json`.
  - production: never builds; refuses unless `dist/` and HEAD still match the recorded preview and `--checked <build id>` names it,
    so production only ever gets the exact files that were checked on the preview URL.
- Updates (`src/pwa.ts`, `src/ui/update-banner.ts`, new `src/ui/activity.ts`): screens report whether something is in progress
  (a game, a puzzle or drill, a review or queued background review, an open sheet). When a new build is waiting at launch or on
  resume (the app checks for one when it becomes visible again, since an iPhone home-screen app resumes rather than relaunches),
  it is applied at once if nothing is in progress and the user has not touched the page for 2 s; otherwise the banner shows.
- The phase-8 update e2e test splits in two: idle → applied by itself (saved data still there afterwards); a game in
  progress → the banner, then Reload.
- Risks: Pages' 25 MiB file limit (largest file 4 MB: fine); the preview origin is a different origin from production (separate
  data and install, expected); Wrangler adds a large dev dependency (also to Juno's `npm ci`, counted against its quota).

**Stage 1 result (2026-11-10): done, preview deployed, production waits for the user's check**
- Commits `36b5bed` (hosting, deploy scripts, updates), `b69e87d` (README), `610a4d3` (`npm run check:hosted`, a stricter offline test).
- **Decision: classic Cloudflare Pages.** Wrangler 4.160 hands `pages project create` to Workers static assets ("Pages, now part
  of Workers"); that hand-off failed, and the user chose classic Pages with `--force` (the SPEC's host; a `*.pages.dev` URL carries
  no account name). Only the create needed `--force`. Project `wizards-chess`, production URL `https://wizards-chess-4tu.pages.dev`
  (the plain name was taken). Wrangler `^4.160.0` added (approved); npm 11 left the `esbuild` / `workerd` install scripts
  unapproved, which a static upload does not need. Wrangler's usage metrics are off in the deploy script.
- **Preview** `https://acc34cf1.wizards-chess-4tu.pages.dev` (alias `preview.wizards-chess-4tu.pages.dev`), build `aeedca6f9bb6`,
  commit `b69e87d`. `check:hosted` in Chrome: 15/15 (COOP/COEP on the page, isolated, `sw.js` and `index.html` `no-cache`, all 30
  files cached, mate found at depth 15 with 4 threads, the bot answers, offline reload still isolated and the bot still answers,
  installable with no errors, no request outside the origin). `curl`: every path has the three isolation headers; hashed
  `assets/*` and `stockfish/*` are `immutable`. `/_headers` itself is not served (Pages answers with the app page).
- **Production (2026-11-10, approved by the user after checking the preview):** build `aeedca6f9bb6` at commit `8c453ad`
  (re-previewed at that commit first: same build id, so byte-identical) went to `https://wizards-chess-4tu.pages.dev`
  (deployment `15595ec1`). Pages uploaded 0 new files (all 41 already there from the preview). `check:hosted` on production:
  15/15 (mate at depth 16, offline reload isolated, installable, no request outside the origin).
- A brand-new `pages.dev` subdomain failed TLS for the first minutes (certificate being issued); it then answered normally.
- **Juno gate on `36b5bed`, all passed:** setup 505777 (lockfile changed: `npm ci`; quota 21,345 → 23,359 files, 5.2 → 5.8 GB,
  realsize 10.5 → 11.6 GB), wc-unit 505778 (typecheck, lint, format, build, 599/599 unit), wc-e2e-repeat 505779 (4 of 4 runs,
  160/160 each, 11.4–11.7 min), wc-perf 505780 (all four passed: drag p95 16.67 ms in all four windows, 0 dropped, 0 long tasks;
  start-up 240 ms; review 81 plies 17.0–17.1 s; 16 task flows clean; 50 games +0.39 MB heap, 8.3 KB per game, listeners +0).
  `repo-changes.txt` empty in every job. (`610a4d3` only adds the hosted checker and makes one assertion stricter; it ran on the
  laptop, 1/1, and joins the next gate.)
- Fixed on the way: the offline e2e test's `data-mate` check matched `"false"` too (the depth check after it was the real one).

## Stage 2 — iPhone support

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

## Stage 3 — presets and the first-run link

**Stage 3 plan: presets and the first-run link (written before code, 2026-11-10)**
- **Preset file** (`preset.json`, version 1; new `src/preset/preset.ts` parses and checks it): `appName` (Home Screen name),
  `profile` (display name, title), `welcome` (title, message, from), `settings` (any app setting: theme, piece set, sound, the
  new-game choices including the bot level), `usernames` (Lichess, Chess.com), `bots` (custom-named bots: name, rating, style).
  Unknown fields are reported by the checker and ignored by the app (later stages add more).
- **First-run link** = a path, `/start/<slug>/`. The build writes, next to each `start/<slug>/preset.json`, an `index.html` (the
  app page with that preset's title, Home Screen name and manifest link) and a `manifest.webmanifest` (name and `start_url:
  /start/<slug>/`), new `scripts/build-start-pages.mjs`. Why a path and static files: **a Home Screen app on iOS has its own
  storage, separate from Safari's**, so whatever the link set up in Safari is gone in the installed app; with the manifest's
  start URL pointing back at the link, the installed app applies the preset again on its first launch. Nothing depends on
  changing the manifest from script (the app also does that, for when the service worker serves the plain page).
  - On start the app reads the slug from the path; if that preset was not applied on this device yet it fetches
    `/start/<slug>/preset.json` (same origin; once), applies it, and remembers the slug. Later launches fetch nothing and
    never overwrite what the user changed since. A link that cannot be loaded shows a notice and the app works as usual.
  - `start/**` is not precached (a preset is needed online, once). The service worker already answers any page path with the
    app page offline. `serve.mjs` serves a folder's own `index.html` (as Pages does). `_headers`: `/start/*` is `no-cache` and
    `noindex`.
  - A committed sample (`public/start/sample/`, invented names) is what the tests and `check:hosted` use.
  - **Personal presets** live in `gift.local/start/<slug>/preset.json` with an unguessable slug. `npm run build:local` (and
    `deploy:preview -- --with-local-presets`) copies them into `dist/`; a plain build never does. Uploading one puts personal
    text on Cloudflare at a secret URL: **not done without the user's say-so**.
- **Profile** (new `src/preset/profile.ts`: display name, title, app name, custom bots, welcome; `localStorage` + mirrored into the
  preferences record, so the JSON backup carries it): Play shows the display name instead of "You", a title badge, and the
  custom bots as opponent chips (a bot is "that bot" when rating and style match); the PGN of a played game gets the names.
  Settings › Profile edits name and title and can show the welcome message again.
- **Welcome message:** a sheet shown once after the preset is applied; on an iPhone the Add to Home Screen guide follows it.
  The guide and the page title use the app name.
- **Green theme** (`green`: flat cream and green squares, own colour values) and the **Classic piece set** (`classic`: Colin M.L.
  Burnett's pieces, the Wikipedia / Lichess default, GPL-2.0-or-later; fetched once by new `scripts/build-piece-set.mjs` from
  lichess-org/lila at a pinned commit into a generated module; listed in LICENSES/).
- **Tests:** unit (preset parsing, the first-run decision, profile store and backup, start-page generation, `_headers`, themes
  and pieces; `phase3-board` expects 4 themes and 4 sets now); new e2e `phase11-presets.spec.ts` in all three projects (the
  sample link: theme, pieces, names, bots, welcome once, then the guide on the iPhone, manifest and title, nothing re-applied
  after a reload, a bad link, a played game's PGN names, the link opening offline); `check:hosted` checks the sample link.
- Files: `src/preset/*` (new), `src/ui/welcome-sheet.ts`, `src/ui/settings-profile-section.ts` (new), `src/app.ts`,
  `src/ui/play-controller.ts`, `src/ui/install-guide.ts`, `src/ui/settings-persistence.ts`, `src/render/themes.ts`,
  `src/render/piece-sets.ts`, `src/render/classic-pieces.ts` (generated), `src/styles/main.css`, `scripts/serve.mjs`,
  `scripts/deploy.mjs`, `scripts/check-hosted.mjs`, `vite.config.ts`, `public/_headers`, README, LICENSES.
- Risks: iOS behaviour that Playwright's WebKit cannot show (does the Home Screen app really start at the manifest's
  `start_url`, is its storage really empty, does the welcome show twice: once in Safari, once in the app); the first launch of
  the installed app needs the network; a per-preset manifest shares the app's `id`; a secret URL is only as private as the link.
