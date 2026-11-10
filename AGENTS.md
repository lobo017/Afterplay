# Working rules for this repo

- docs/SPEC.md is the source of truth. Read it at the start of every task.
- Read docs/PROGRESS.md at the start of every session; it is kept short (under about 300
  lines). Open an archive file in docs/progress/phase-N.md only when the work needs that
  history; never read them all.
- Track progress in docs/PROGRESS.md: phase status, decisions, deviations from the spec
  (with reasons), known issues, and measured performance numbers. When a phase is done, move
  its detailed log verbatim to docs/progress/phase-N.md and keep only a summary, its open
  items, and key measurements in PROGRESS.md.
- Work one phase at a time. Before writing code, add a short plan to PROGRESS.md (files to
  add or change, risks).
- A phase is done only when all of these pass, run by you (on Juno, see below):
  - `npm run typecheck`
  - `npm run lint`
  - `npm test`
  - `npm run build`
  - the phase's end-to-end tests

  Fix failures yourself. Never report done otherwise.
- Commit at the end of every phase as "Phase N: <summary>". Smaller commits within a phase
  are fine.
- No placeholder code, no TODO-stubbed features, and no buttons that do nothing. If
  something can't be done, write that in PROGRESS.md.
- Never break earlier phases. All earlier end-to-end tests must keep passing.
- The website makes zero runtime network requests. The only exception is the capture
  extension in extension/ (Phase 5b), which may access lichess.org, www.chess.com, and
  api.chess.com. Network access is also allowed in dev-time scripts under scripts/
  (e.g. dataset downloads). If your sandbox blocks a download, write the script and tell
  me the command to run.
- Ask me before: adding a dependency not named in the spec, deleting or weakening tests,
  changing the license, or doing anything destructive outside this repo.
- legacy/index.html is the old 3D app. Use it as reference only (port the audio synth and
  visual theme ideas); don't import it.
- After a UI change, take Playwright screenshots and look at them yourself before calling
  the work done.
- Run every command non-interactively and with a timeout. Never use npx for a package that isn't in package.json, since it can stall on an install prompt; ask me to add the dependency instead.
- Only kill processes you started: ones you hold a handle to, or descendants of your own process found by parent PID. Re-check each process's parent PID and command line immediately before killing it. Never find processes by name or command-line text matching. For anything else, list it and ask me to stop it.
- Never send personal information (email, name, tokens, file paths) to any external service without asking me first.
- Never link node_modules (junction or symlink) into a git worktree, and never use git worktree remove --force. If a comparison needs an older commit, give its worktree its own npm ci, or ask me.
- Before any perf run or full e2e run on the laptop (rare now; see Juno below), check whether the laptop is on battery. If it is, tell me and wait for me to plug in, since battery throttling invalidates the results.

## Juno (the university's SLURM cluster)

Automated checks (unit, e2e, perf) and batch studies (bot calibration, puzzle verification) run on Juno, not on this laptop.
The setup and every job script are in hpc/ (hpc/README.md). Perf numbers from Juno are regression baselines for the code on a
headless Linux node, not user-experience measurements; the Key measurements in PROGRESS.md say which machine each number is from.

Juno safety rules (these override anything else):

- One folder only. Everything created on Juno lives under ~/work/wizard-chess-hpc/ (subfolders: repo/, results/, cache/ for
  Apptainer and npm caches, image/). Temporary job files go only in ~/scratch/wizard-chess-hpc/<job-id>/. Never write, move, or
  delete anything outside those two folders. Read-only access to system locations (/etc, /usr, /opt, the module system's own
  paths) is fine, since those are not the user's files. Never read or touch anything else of the user's: other files in the home
  folder (dotfiles, ~/.ssh, ~/.conda), other projects in ~/work, or anything else in ~/scratch.
- No conda. Don't use, create, modify, or activate any conda environment; Node comes from the Playwright container. Every job
  script starts with #SBATCH --export=NONE and runs the container with apptainer exec --cleanenv, so an active conda environment
  can't leak in.
- Don't modify the account setup: ~/.bashrc, ~/.bash_profile, ~/.ssh, ~/.conda, ~/.condarc, module defaults, or anything else in
  the home folder.
- Every script sources the shared hpc/lib/paths.sh, which defines the root folder and the safe delete helper (wc_rm_tree). The
  helper refuses any path that isn't inside ~/work/wizard-chess-hpc/ or ~/scratch/wizard-chess-hpc/, and refuses empty or unset
  variables. Never use rm -rf directly.
- Jobs are named with the prefix wc- . Only cancel jobs submitted in this project (wc- jobs); never touch other jobs.
- Over ssh, run only: sbatch, squeue, sacct, scancel (wc- jobs only), mfsgetquota, mkdir -p / ls / cat inside the project folders,
  and git pull inside ~/work/wizard-chess-hpc/repo. Anything else, ask first. Use a timeout on every ssh command.
- Keep total usage under 50 GB and 300k files. Check mfsgetquota before setup and after the first npm ci, and report both numbers.
- Request only the resources a job needs (fairshare charges what is requested), never GPUs, at most 4 running jobs.