# Afterplay on Juno (UT Dallas SLURM cluster)

Automated checks (unit, e2e, perf) and batch studies (bot calibration, puzzle verification) run here, not on the laptop.
Everything runs inside the official Playwright container (Apptainer), pinned to the Playwright version in
`package-lock.json`. Nothing outside two folders is ever touched:

```
~/work/wizard-chess-hpc/      repo/  results/  cache/ (apptainer, npm)  image/
~/scratch/wizard-chess-hpc/   <job-id>/   (a job's temporary files, removed when it ends)
```

The safety rules are in `AGENTS.md` ("Juno"). The ones the scripts enforce: `#SBATCH --export=NONE` plus a restart under
`env -i` (no conda or dotfile can leak in); `apptainer exec --cleanenv --containall` (the container sees only the repo, the
npm cache, the job's scratch folder as `/tmp` and the job's results); every delete goes through `wc_rm_tree` in
`hpc/lib/paths.sh`, which refuses empty paths, symlinks, `..` tricks and anything outside the two folders
(`bash hpc/test/paths-test.sh` checks that; the setup job runs it first).

## How a job is wired

| In the container | Comes from |
|---|---|
| `/work/repo` | `~/work/wizard-chess-hpc/repo` (the only writes are `node_modules/` tool caches, which are redirected too) |
| `/work/repo/dist`, `dist-ext` | the job's scratch folder: each job builds the app itself, so parallel jobs never share a build |
| `/work/repo/test-results` | `results/<job-id>/artifacts/` (screenshots, traces, perf logs) |
| `/tmp` | the job's scratch folder (browser profiles, temp files) |
| `/results` | `results/<job-id>/` (reports, logs, `summary.md`) |

Each job also picks its own app-server port (20000–39999, free on that node) and passes it as `WC_PORT`; the Playwright
config, the extension build (default site URL) and the perf scripts use it, so two jobs on one node never talk to each other's
server. The container has its own PID namespace, so the leftover-process checks (`scripts/lib/process-guard.mjs`,
`tests/e2e/global-setup.ts`) only see the job's own processes. At the end of every job a script lists any change in the repo
(`repo-changes.txt`): there should be none.

For an array job the results go to `results/<array-job-id>/task-<n>/`.

## Submit commands

Every `sbatch` needs `--chdir` and `--output` inside the project folder, otherwise Slurm writes its log in your home folder.
Run commands over ssh with a timeout and in single quotes, so `$HOME` is expanded on Juno (the campus VPN must be on):

```bash
timeout 60 ssh -o ConnectTimeout=15 -o BatchMode=yes juno '<command>'
```

Below, `<command>` is written with two shorthands:

- `SB` = `sbatch --mail-type=END,FAIL --mail-user=<your-email> --chdir="$HOME/work/wizard-chess-hpc" --output="$HOME/work/wizard-chess-hpc/results/slurm/%x-%j.out"`
- `JOBS` = `"$HOME/work/wizard-chess-hpc/repo/hpc/jobs`

Slurm mails you when a job ends or fails. Put your own address where `<your-email>` stands, on the command line only: it is
never written into a file of this (public) repo.

Create the log folder once: `mkdir -p "$HOME/work/wizard-chess-hpc/results/slurm"`.

### One-time setup (and after `package-lock.json` or the Playwright version changes)

The first time, the repo does not exist yet, so a one-line job clones it and hands over to the setup script. The clone runs
under `env -i` with a system-only PATH (so no conda or other non-system git can be picked up); the setup script then scrubs
its own environment the same way:

```bash
cd "$HOME/work/wizard-chess-hpc" && sbatch --job-name=wc-setup --partition=dev --nodes=1 --ntasks=1 --cpus-per-task=4 --mem=8G --time=00:45:00 --export=NONE --mail-type=END,FAIL --mail-user=<your-email> --chdir="$HOME/work/wizard-chess-hpc" --output="$HOME/work/wizard-chess-hpc/results/slurm/%x-%j.out" --wrap="[ -d repo/.git ] || /usr/bin/env -i HOME=\"$HOME\" PATH=/usr/bin:/bin GIT_TERMINAL_PROMPT=0 git clone --branch main https://github.com/lobo017/afterplay.git repo; exec /bin/bash repo/hpc/setup.sbatch"
```

Later runs (it fast-forwards the repo, pulls a new image only if the Playwright version changed, and runs `npm ci` only if the
lockfile changed):

```bash
SB "$HOME/work/wizard-chess-hpc/repo/hpc/setup.sbatch"
```

Setup ends with a smoke test (`hpc/smoke.mjs`): headless Chromium, the blank-page frame rate, a cross-origin-isolated page
from `serve.mjs`, and loading the capture extension. Read `results/<id>/smoke.json` and `usage.txt`.

### Jobs

Commit and **push** first: Juno pulls from GitHub (`cd "$HOME/work/wizard-chess-hpc/repo" && git pull --ff-only`; never while
a job is running, the jobs read the repo while they run). Then:

| Job | Partition · resources · limit | What it does | Command |
|---|---|---|---|
| `wc-unit` | dev · 4 CPUs · 8 GB · 55 min | `typecheck`, `lint`, `format:check`, `build`, `npm test` (each its own step) | `SB $JOBS/unit.sbatch"` (extra arguments go to vitest) |
| `wc-e2e` | normal · 6 CPUs · 12 GB · 100 min | build, then one full `playwright test`: the `chromium`, `webkit` and `webkit-iphone` projects (80 min inside) | `SB $JOBS/e2e.sbatch"` (`--headed`: extension tests in a real window under xvfb-run; `-- <playwright args>`, e.g. `-- --project=webkit-iphone`) |
| `wc-e2e-repeat` | normal · 6 CPUs · 12 GB · 100 min per task | N complete e2e runs, to expose flaky tests | `SB --array=1-4%4 $JOBS/e2e-repeat.sbatch"` (N runs: `--array=1-N%4`) |
| `wc-perf` | normal · `--exclusive` · 16 GB · 90 min | `perf:drag`, `perf:review`, `perf:tasks`, `perf:memory`, one after the other | `SB $JOBS/perf.sbatch"` (`--only drag,tasks` for a subset) |
| `wc-calibrate` | normal · 3 CPUs · 3 GB · 50 min per task | `calibrate:bots`, one level per task (400 … 2400) | `SB $JOBS/calibrate.sbatch"` (array 0-6%4 is built in) |
| `wc-puzzles` | normal · 2 CPUs · 2 GB · 30 min per task | deep engine check of all 20k bundled puzzles in 20 chunks | `SB $JOBS/puzzles.sbatch"` (chunks = array size; it must be `0..N-1`) |
| `wc-summarize` | dev · 1 CPU · 1 GB · 5 min | `summary.md` for an earlier job or array | `SB $JOBS/summarize.sbatch" <job or array job id>` |

At most 4 of your jobs run at once (an array's `%4` counts against that). Job names start with `wc-`; only those are ever
cancelled: `scancel <job id>`. Time limits are hard (Slurm kills the job); inside, every step has its own shorter limit so
the report is still written. The calibrate limit is an estimate: tighten it after the first run.

## History import (one player's Chess.com games)

`wc-history` downloads a player's monthly archives from Chess.com's public API, reports on them and builds a restore file
in the app's backup format. Everything personal stays in one scratch folder, which is kept between jobs (unlike a job's own
`<job-id>/` folder); nothing personal is in the repo, on an sbatch line or in a log under `results/`:

```
~/scratch/wizard-chess-hpc/history/
  player.txt                the username, one line (you write it, see below)
  raw/YYYY-MM.json          the monthly archives as served
  download-summary.txt      months, files, sizes, failed months
  report.txt  summary.txt  shortlist.txt
  restore.json  restore-summary.txt  restore-validation.txt
```

Write the username once, by hand, into a folder only you can read (it is deliberately not a job argument, since Slurm
keeps a job's submit line):

```bash
umask 077 && mkdir -p "$HOME/scratch/wizard-chess-hpc/history" && printf "%s\n" "<username>" > "$HOME/scratch/wizard-chess-hpc/history/player.txt"
```

Then, one after the other (dev · 2 CPUs · 4 GB · 40 min each; in practice a few minutes):

| Command | What it does |
|---|---|
| `SB $JOBS/history.sbatch" download` | The archive list, then each month with 1 second between requests; a failed month is tried once more, then listed. Stops if the list itself is not served (no other route is tried). |
| `SB $JOBS/history.sbatch" review` | `report.txt` (totals, years, colours, results, time controls, openings, ratings, every opponent), `summary.txt` (no names), `shortlist.txt` (the opponents played most often). No file holds a game's moves. |
| `SB $JOBS/history.sbatch" restore` | `restore.json`: every game through the app's own PGN check and record builder (games only), then the app's backup import run against the file in the unit test harness (`restore-validation.txt`). |

Copy the results to the laptop's git-ignored folder:

```powershell
scp juno:scratch/wizard-chess-hpc/history/restore.json juno:scratch/wizard-chess-hpc/history/report.txt C:\dev\wizard-chess\gift.local\history\
```

The scripts are in `hpc/history/` and run anywhere with `--dir <folder>`; `tests/unit/history-import.test.ts` covers them
with invented games.

## Monitoring

```bash
ssh juno 'squeue --me --format="%.10i %.18j %.9P %.8T %.10M %.10l %R"'    # my jobs
ssh juno 'sacct -X --format=JobID,JobName%20,State,Elapsed,MaxRSS,ExitCode -S today'
ssh juno 'jobstats <job id>'                                              # CPU and memory use of a finished job, if installed
ssh juno 'ls "$HOME/work/wizard-chess-hpc/results/<job id>"'
ssh juno 'cat "$HOME/work/wizard-chess-hpc/results/<job id>/summary.md"'
```

`results/<id>/` holds: `summary.md` (the report), `meta.json` (job, node, commit), `steps.tsv` (each step's exit code and
seconds), one `<step>.log` per step, `playwright-report.json`, `vitest-report.json`, `perf-*.log`, `calibrate-*.json`,
`puzzles-chunk-*.json[l]`, `artifacts/` (screenshots, traces, perf logs), `job.log`, `repo-changes.txt`, `exit-code.txt`.

## Copy results to Windows

```powershell
scp -r juno:work/wizard-chess-hpc/results/<job id> C:\dev\wizard-chess-results\
node hpc/summarize.mjs C:\dev\wizard-chess-results\<job id>          # the same report, locally (no dependencies)
```

(Keep the copy outside the repo, or in the git-ignored `test-results/`.)

## Notes

- **Perf numbers are regression baselines.** Juno has no display: headless Chromium paces frames with its own 60 Hz timer, so
  the "blank page" check measures the node's load, not a screen. They say whether the code got slower, not what a user sees.
- **Extensions need new headless mode.** On Linux the extension tests use `channel: 'chromium'` (new headless). If the setup
  smoke test says the extension did not load, run the e2e job with `--headed` (xvfb-run). `WC_BROWSER_CHANNEL` overrides the
  browser channel everywhere.
- **Windows is unchanged:** without `WC_PORT`/`WC_BROWSER_CHANNEL`, everything uses branded Chrome and port 4173 as before.
- **Cleaning up:** old images (`image/*.sif`, ~2 GB each) stay after a Playwright upgrade; the cache folders can be emptied by
  hand when the quota gets tight. Nothing here deletes them.
