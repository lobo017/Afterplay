# Phase 8 — Library, insights, settings, offline (archive)

Detailed log, moved out of PROGRESS.md when the phase was done. Started 2026-10-26.

## Plan (as written before any code)

Findings that shaped it
- **Offline did not work.** `vite-plugin-pwa` generated a Workbox `sw.js`, but `main.ts` never registered it
  (`injectRegister: false`); it only registered the COI shim `coi-serviceworker.js`, and only when the page was not
  cross-origin isolated (so never under `npm run serve`). No test covered offline. So: one service worker that
  precaches the build *and* adds the COOP/COEP headers to what it serves, registered always in production.
- Games played against the bot were never stored; the Games list only had captured and imported games.
- Puzzle rating history already existed (`puzzles.rating` setting, with `puzzleId` per point).

Stages: 1 offline PWA (the gate), 2 library, 3 insights, 4 accessibility, 5 leftovers + Settings, 6 docs and full checks.

## What was built

**1. Offline PWA** (`23cc01e`)
- `src/sw.ts`, built by `vite-plugin-pwa` `injectManifest` (`rollupFormat: 'iife'`), no new dependency and no Workbox
  imports. Install: caches every file of the build (30 entries, ~20.9 MB; un-hashed files keyed by revision). Fetch:
  precached file from the cache, any extension-less same-origin navigation gets `index.html`, every same-origin
  response gets COOP/COEP/CORP (so offline pages stay cross-origin isolated and the multi-threaded engine keeps its
  threads). A first install takes over at once; an update waits (`SKIP_WAITING` from the page) so a game is never
  reloaded under its player; old files are dropped on activate, not on install (the old build may still be running).
- `src/pwa.ts` registers `/sw.js` in every production load, reports `OfflineState` (Settings › About, "Offline use":
  `Ready: all N files are cached`), shows `ui/update-banner.ts` ("A new version is ready · Reload · Later"), and
  reloads once to gain isolation on a host that sends no headers. `coi-serviceworker.js` is gone.
- Manifest: `id`, `start_url`, `scope`, PNG icons 192 / 512 / maskable 512 (`npm run build:icons` renders
  `public/favicon.svg` with Playwright's Chrome). Chrome's own installability check (CDP) reports nothing except
  `in-incognito`, which a test profile always has.
- Test infrastructure: Playwright's default is now `serviceWorkers: 'block'` (registration is refused, so every
  existing test is unchanged); the perf scripts block it too. `scripts/serve.mjs` takes `WC_DIST_DIR`.
- `phase8-offline.spec.ts` (3): own server on a free port, load, wait for "Ready", **stop the server and switch the
  browser offline**, check a fetch really fails, reload, `crossOriginIsolated === true`, then Play (a move and the bot's
  answer), live analysis (mate found, depth ≥ 8), a review, all four trainers (including the exact endgame defender in
  its worker), the Games list (paste, opening found), a second offline reload keeps the library; no failed request and
  no response that did not come from the service worker. Plus installability and the update flow (a changed build waits
  behind the banner; Later hides it; a reload keeps the old build; Reload takes the new one).

**2. Library**
- Finished Play games are saved (`play:<start ms>` ids, `source: 'play'`, my side from `playerColor`; headers Event, Site,
  Date, UTC date/time, players, bot Elo, TimeControl). A game with no move is not kept; finishing a game again after a
  takeback replaces it and drops its (now stale) review. They feed my puzzles and guess-the-move like any game of mine.
- `library/game-rows.ts`: row model, `GameFilter` (source, result, colour, analysis, opening text, from/to day, minimum
  accuracy), sorting; the Games list uses it. New controls: Colour, Opening (with suggestions from the games), From, To,
  Accuracy ≥, Clear filters (count shown). "Played here" is a source.
- Delete: selection bar › Delete › "Delete N games and their reviews?" Delete / Keep. (Personal puzzles made from a deleted
  game stay.)
- Bulk import: `pgn-import-core.ts` (pure generator, 25 games per step, numbered errors, duplicate keys), run by
  `pgn-import.worker.ts` through `PgnImportClient` (inline where there is no Worker); the page saves each batch in one
  IndexedDB transaction (`saveNewGames`) and shows "Importing… N of M games". Limit 96 MB per text. 400 games: ~1.2 s,
  no long task on the page.
- Settings › Your games: Lichess and Chess.com usernames (so "my side" works without the extension; changes refresh the
  list, backups and the extension keep them in step) and Auto-analyze.
- No schema bump (optional fields only); `StoredGameSource = GameSource | 'play'`.

**3. Insights** (a tab beside Library; four destinations stay four)
- `library/insights.ts` (pure, unit tested): accuracy by phase (opening = first 10 moves unless ≤ 6 pieces; endgame = 6
  or fewer queens/rooks/bishops/knights left; middlegame otherwise), blunders per 10 of my moves per game, motifs behind
  my Mistakes / Blunders / Misses, results by opening family, puzzle rating series. Every figure keeps the positions it was
  counted from.
- `library/insights-view.ts`: hand-written SVG and HTML (one gold hue for magnitude; win/draw/loss use letters and counts
  as well as colour). Every data point is a keyboard-reachable button: phase bars, blunder points and motif rows open a
  list of positions with a mini board, each opening the game on the Review board at that move; an opening segment shows
  those games in the Library (filtered); a rating point opens its puzzle. Empty states say what to do.

**4. Accessibility**
- `ui/announcer.ts`: one polite live region (`role=status`); moves in Play, Review stepping, the trainers' boards and
  results are announced.
- Every board has `tabindex=0`, `role=application` and an instruction label; after a Tab arrow keys move a cursor
  (follows the screen when flipped), Enter / Space picks up and puts down, Escape cancels, the piece letter chooses in the
  promotion picker, and the cursor's square and piece are announced. Arrow keys keep their old job (stepping through
  moves) after a click: keyboard mode is only on when the board was reached by keyboard. Click logic shared with the
  keyboard (`tryCompleteSelectedMove`).
- Classifications: every badge has an icon and an aria-label with its name (test checks all in a real review).

**5. Leftovers and Settings**
- "replaced N earlier engine annotations" counts only what an imported PGN brought: evals the app wrote (live analysis, a
  review) carry `app: true` and are counted as the app's own, as is `Review:` text; Lichess evals / NAGs / advice comments
  / best-line variations are counted. (`StripResult.own`.)
- Key moments on a phone: the chip row no longer scrolls the 4th and 5th chip out of sight; it wraps onto two rows
  (two rows always reserved, so nothing below moves).
- Settings: new "Analysis & review" (engine lines 1–5, review depth) mirrored with the panels' own selects both ways and
  remembered; "Your games" (above). Section order: Board, Board feel, Moves, Analysis & review, Sound & effects, Your
  games, Your data, About & diagnostics.

## Decisions

- One service worker, no Workbox runtime: the update policy (wait, never reload a game) and the COOP/COEP headers on
  cached responses are the parts Workbox's generated worker could not give.
- Insights are a tab in Games, not a fifth destination (Phase 6b decided four).
- Keyboard mode is entered by Tab, not by any focus: a click must not change what the arrow keys do.
- `vitest.config.ts`: `testTimeout` 30 s and at most 4 test processes (see Known issues); the DTM oracle in `tests/helpers`
  solves in slices (`ensureOracle()`), because a 60 s silence from a busy test worker fails the whole run.
- Playwright config blocks service workers for every test except the offline spec and the extension specs (the latter need
  the extension's own worker).

## Tests

- Unit: 581 in 49 files (was 565 in 47 at the follow-ups): `game-library-phase8` (8), `insights` (7), an annotation test.
- E2E added: `phase8-offline` (3), `phase8-library` (4), `phase8-insights` (3), `phase8-a11y` (5), `phase8-leftovers` (3);
  `phase6b-settings` section list updated for the two new sections.
- Screenshots (`test-results/phase8-screens/`, looked at): library desktop and phone, insights desktop (with a position
  list open) and phone, update banner, offline play / review / train / games, keyboard board cursor, key moments on a phone.
  Found from them: the rating chart stretched its text on a wide card (width capped), key chips scrolling out of sight
  (wrapped).

## Measurements

- Precache: 30 files, 20.9 MB. Bulk import of 400 games: 1.2–1.9 s end to end, worker reads them in ~0.6 s, no long task.
- Main bundle 1,483.20 kB (1,449.47 kB at Phase 7). `perf:drag` after Phase 8 (battery, one run): scenarios 1 and 2 drag pass,
  the navigation sweep fails (p95 33.4 ms); no A/B possible; details and the Phase 9 follow-up in PROGRESS.md.
- Full runs: 581 unit (179 s), 155 e2e (14.1 min, one worker; one threshold fixed and re-run).
