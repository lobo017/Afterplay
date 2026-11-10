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
