---
name: juno-gate
description: Run the Juno gate for the current commit - push, submit unit, e2e (Chromium, desktop WebKit, WebKit iPhone, 2 runs each) and perf on the SLURM cluster, verify and report the results, then deploy a preview. Use when asked to "run the Juno gate" or to gate a stage or phase.
---

# Juno gate

The gate for a commit: unit + three e2e suites × 2 + perf on Juno, then a preview deploy. Details live in
`hpc/README.md` (job wiring, the `SB` / `JOBS` shorthands, result files) and `AGENTS.md` ("Juno": the safety rules, which
override everything here). Read both before the first ssh command of a session.

## Rules that always apply

- **One folder:** only `~/work/wizard-chess-hpc/` and `~/scratch/wizard-chess-hpc/<job-id>/` on Juno. Nothing else of the
  user's is read or touched. **No conda**, no change to the account setup.
- **ssh allow-list:** `sbatch`, `squeue`, `sacct`, `scancel` (wc- jobs only), `mfsgetquota`, `mkdir -p` / `ls` / `cat` inside
  the project folders, `git pull` inside `~/work/wizard-chess-hpc/repo`. Anything else: stop and ask.
- **Every ssh command has a timeout:** `timeout 60 ssh -o ConnectTimeout=15 -o BatchMode=yes juno '<command>'` (single
  quotes, so `$HOME` expands on Juno).
- Jobs are named `wc-…`; only those are ever cancelled. At most 4 running at once, no GPUs, no raised resources.
- **Mail address:** every `sbatch` gets `--mail-type=END,FAIL --mail-user=<address>`. `<address>` comes from the user's
  prompt and goes on the command line only: never into a file, PROGRESS.md, a commit message or memory. If the prompt
  gives none, ask.
- **Stop rules:** never raise a limit or timeout, weaken or skip a test, or rerun until green to get a pass. A failure is
  fixed in the code (or the test, if the test is wrong, with the reason written down) and the gate is run again on the new
  commit. If a needed command is not on the allow-list, ask.

## 1. Push

Juno pulls from GitHub. Pushing to `origin main` for a gate is allowed only when nothing personal goes with it:

1. `git status --short` is clean (or holds only files that are meant to stay uncommitted).
2. `git diff --stat origin/main..HEAD` and `git log origin/main..HEAD`: no path under `gift.local/`, no `*.local.json`, no
   real name, username, email address or message in a diff or a commit message. When unsure, grep the diff for the strings in
   `gift.local/` without printing them.
3. `git push origin main`. If either check fails, do not push: tell the user.

Note the commit under test: `git rev-parse HEAD`.

## 2. Pull on Juno

`squeue --me` first. Pull only when **no wc- job is running or pending** (jobs read the repo while they run, and a
pending job tests whatever the repo holds when it starts). If one is there, wait for it or ask the user.

```
cd "$HOME/work/wizard-chess-hpc/repo" && git pull --ff-only
```

If `package-lock.json` or the Playwright version changed, run the setup job first (hpc/README.md) and report
`mfsgetquota` before and after.

## 3. Submit

With `SB` and `JOBS` as in hpc/README.md (mail flags included). Two waves keep it at 4 running jobs, and perf waits for
all three e2e groups: it must never run beside an e2e job.

```
SB --array=1-2%2 $JOBS/e2e-repeat.sbatch" -- --project=chromium          # → A
SB --array=1-2%2 $JOBS/e2e-repeat.sbatch" -- --project=webkit            # → B
SB --dependency=afterany:A:B --array=1-2%2 $JOBS/e2e-repeat.sbatch" -- --project=webkit-iphone   # → C
SB --dependency=afterany:A:B $JOBS/unit.sbatch"
SB --dependency=afterany:A:B:C $JOBS/perf.sbatch"
```

Record the five job IDs.

## 4. Wait

Do not poll continuously. Check `squeue --me` / `sacct -X -S today` every few minutes at most (an e2e run takes 12–16
min; perf waits for an exclusive node, sometimes for hours), or stop and let the user report the Slurm emails.

## 5. Trust checks

For every job (`results/<id>/`, or `results/<array-id>/task-<n>/`), before believing its result:

- `meta.json`: the commit equals the commit under test.
- `repo-changes.txt`: empty.

Otherwise discard that result and say so; do not count it as a pass or a fail.

## 6. Report

From each `summary.md` (and the step logs when it is not enough), per job: job ID, pass / fail / skipped / flaky counts and
duration; for every failure the test name and its first error line; for perf the table (drag p95 per window, dropped
frames, long tasks, start-up, review time, task flows, 50-game memory). Juno perf numbers are regression baselines, not
user experience. Write the result in docs/PROGRESS.md (job IDs, counts, numbers; never the mail address).

The gate passes only if every job passed its trust checks, 0 tests failed in all six e2e runs, unit passed every step,
and perf passed all four scripts.

## 7. Preview (only after a passing gate)

```
npm run deploy:preview
npm run check:hosted -- <preview url>
npm run check:hosted -- <preview url> --browser webkit-iphone
```

Report the preview URL, the build id and both check results, then stop for the user's check. **Never run
`deploy:production` without the user's explicit approval of that build.**
