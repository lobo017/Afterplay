#!/bin/bash
#SBATCH --job-name=wc-history-engine
#SBATCH --partition=normal
#SBATCH --qos=juno
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=16G
#SBATCH --time=02:00:00
#SBATCH --export=NONE
#SBATCH --array=0-7%4
#
# The engine review of the player's history file in HISTORY_CHUNKS chunks (hpc/history/lib/settings.mjs: 64). Each array
# task runs one worker per CPU, and worker w of task k reviews chunk k * (CPUs per task) + w, so 8 tasks of 8 workers cover
# the 64 chunks, at most 4 tasks (32 engines) at once:
#   sbatch ... hpc/jobs/history-engine.sbatch <commit>      (the full 40-character commit hash, required)
# Mail flags go on the sbatch command line only (hpc/README.md), never in this file. The job refuses to start unless the
# checkout is at exactly <commit>, and unless array size x CPUs per task equals HISTORY_CHUNKS; it never runs git pull
# or git fetch.
# Reads ~/scratch/wizard-chess-hpc/history/restore.json (never written) and appends to
# ~/scratch/wizard-chess-hpc/history/engine/part-<k>-of-<n>.jsonl: ids and numbers stay there. results/ gets counts and
# timings. Every worker stops itself after 105 minutes, so the Slurm limit of 2 hours is never what ends it.
# Exit code of a task: 0 all its chunks are done; 3 at least one worker stopped at the time limit with games left and none
# failed (submit the same line again: each worker continues from its part file); 1 at least one worker failed (an error or
# an engine failure: the others are allowed to finish, and nothing more is started); 2 a refusal before the review
# started (bad commit argument, wrong checkout, no input file, array size and CPUs do not match the chunk count).
set -euo pipefail
_home="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
# shellcheck source=../lib/paths.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/paths.sh"
wc_scrub_env "$@"
# shellcheck source=../lib/job.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/job.sh"

stop_minutes=105
commit="${1:-}"
if ! printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "usage: history-engine.sbatch <the full 40-character commit hash>" >&2
  exit 2
fi
task="${SLURM_ARRAY_TASK_ID:-}"
tasks="${SLURM_ARRAY_TASK_COUNT:-}"
workers="${SLURM_CPUS_PER_TASK:-}"
for v in "$task" "$tasks" "$workers"; do
  case "$v" in '' | *[!0-9]*)
    echo "wc: this job needs an array (--array=0-7) and --cpus-per-task" >&2
    exit 2
    ;;
  esac
done
if [ "$task" -ge "$tasks" ] || [ "$workers" -lt 1 ]; then
  echo "wc: array task $task of $tasks with $workers workers is not valid" >&2
  exit 2
fi

wc_job_begin history-engine
head="$(git -C "$WC_REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ "$head" != "$commit" ]; then
  wc_log "the checkout is at ${head:0:12}, not at the requested commit ${commit:0:12}: not running (no pull is done here)"
  exit 2
fi
hist="$WC_SCRATCH_ROOT/history"
if [ ! -s "$hist/restore.json" ]; then
  wc_log "no restore.json in the history folder: build it first (history.sbatch restore)"
  exit 2
fi
wc_mkdir "$hist/engine" || exit 2
WC_EXTRA_BINDS=(--bind "$hist:/history")
rc=0
wc_container bash /work/repo/hpc/container/history-engine.sh "$task" "$tasks" "$workers" "$commit" "$stop_minutes" || rc=$?
case "$rc" in
  0) wc_log "task $task of $tasks is done" ;;
  3) wc_log "task $task of $tasks stopped at the time limit: submit the same line again to continue" ;;
  *) wc_log "task $task of $tasks stopped with exit code $rc: look at the step logs before resubmitting" ;;
esac
exit "$rc"
