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
#   sbatch ... hpc/jobs/history-engine.sbatch <commit> [<folder name> [<games per chunk> [<stop minutes>]]]
#     <commit>          the full 40-character commit hash, required
#     <folder name>     the history folder under ~/scratch/wizard-chess-hpc/ (letters, digits, dash, underscore; not all
#                       digits, because a job's own scratch folder is a number); default: history. A pilot runs in its own
#                       folder (restore.json copied there by hand), so the real folder is never touched.
#     <games per chunk> stop each worker after this many games (review-games.mjs --limit); 0 or empty: no limit (the
#                       default). A limited run ends with exit 0 although its chunks are not done: the step log says how
#                       many are left.
#     <stop minutes>    a whole number from 1 to 105: each worker stops itself after this long; default 105.
# Mail flags go on the sbatch command line only (hpc/README.md), never in this file. The job refuses to start unless the
# checkout is at exactly <commit>, and unless array size x CPUs per task equals HISTORY_CHUNKS; it never runs git pull
# or git fetch.
# Reads <folder>/restore.json (never written) and appends to <folder>/engine/part-<k>-of-<n>.jsonl, <folder> being
# ~/scratch/wizard-chess-hpc/<folder name>: ids and numbers stay there. results/ gets counts and
# timings. Every worker stops itself after <stop minutes> (105 by default), so the Slurm limit of 2 hours is never what
# ends it.
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

commit="${1:-}"
folder="${2:-history}"
limit="${3:-}"
stop_minutes="${4:-105}"
usage="usage: history-engine.sbatch <the full 40-character commit hash> [<folder name> [<games per chunk> [<stop minutes>]]]"
if [ "$#" -gt 4 ] || ! printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "$usage" >&2
  exit 2
fi
# A folder name is letters, digits, dash and underscore (no slash, no dot), at most 40 long, and not all digits: a job's
# own scratch folder is $WC_SCRATCH_ROOT/<job id>, which the job removes when it ends
if [ "${#folder}" -gt 40 ] || ! printf '%s' "$folder" | grep -Eq '^[A-Za-z0-9_-]+$' ||
  printf '%s' "$folder" | grep -Eq '^[0-9]+$'; then
  echo "$usage (the folder name: letters, digits, dash, underscore; not all digits)" >&2
  exit 2
fi
# Games per chunk: a whole number; 0 means no limit, and only 1 or more is passed on
if [ -n "$limit" ]; then
  case "$limit" in *[!0-9]*)
    echo "$usage (games per chunk: a whole number)" >&2
    exit 2
    ;;
  esac
  if [ "${#limit}" -gt 9 ]; then
    echo "$usage (games per chunk: too large)" >&2
    exit 2
  fi
  if [ "$limit" -eq 0 ]; then limit=""; fi
fi
case "$stop_minutes" in '' | *[!0-9]*)
  echo "$usage (stop minutes: a whole number from 1 to 105)" >&2
  exit 2
  ;;
esac
if [ "${#stop_minutes}" -gt 9 ] || [ "$stop_minutes" -lt 1 ] || [ "$stop_minutes" -gt 105 ]; then
  echo "$usage (stop minutes: a whole number from 1 to 105)" >&2
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
hist="$WC_SCRATCH_ROOT/$folder"
if [ ! -d "$hist" ] || [ -L "$hist" ] || [ ! -s "$hist/restore.json" ]; then
  wc_log "no restore.json in the scratch folder '$folder': for 'history' build it first (history.sbatch restore), for a pilot copy it there"
  exit 2
fi
wc_mkdir "$hist/engine" || exit 2
WC_EXTRA_BINDS=(--bind "$hist:/history")
rc=0
wc_container bash /work/repo/hpc/container/history-engine.sh "$task" "$tasks" "$workers" "$commit" "$stop_minutes" "$limit" || rc=$?
case "$rc" in
  0) wc_log "task $task of $tasks is done" ;;
  3) wc_log "task $task of $tasks stopped at the time limit: submit the same line again to continue" ;;
  *) wc_log "task $task of $tasks stopped with exit code $rc: look at the step logs before resubmitting" ;;
esac
exit "$rc"
