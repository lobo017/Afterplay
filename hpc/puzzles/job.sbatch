#!/bin/bash
#SBATCH --job-name=wc-mistake-puzzles
#SBATCH --partition=normal
#SBATCH --qos=juno
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=1
#SBATCH --mem=4G
#SBATCH --time=01:00:00
#SBATCH --export=NONE
#SBATCH --array=0-7%4
#
# The mistake-puzzle search (hpc/puzzles/mine-positions.mjs): for each chosen game of the player, the engine's best move at
# the stored worst move. 8 array tasks, one shard each (PUZZLE_SHARDS in hpc/puzzles/lib/positions.mjs), at most 4 at
# once, one single-thread engine per task:
#   sbatch ... hpc/puzzles/job.sbatch <commit> [<folder name> [<stop minutes>]]
#     <commit>        the full 40-character commit hash, required
#     <folder name>   the work folder under ~/scratch/wizard-chess-hpc/ (letters, digits, dash, underscore; not all digits,
#                     because a job's own scratch folder is a number); default: mistake-puzzles. It is NOT the history
#                     folder: nothing of hpc/history is read or written.
#     <stop minutes>  a whole number from 1 to 50: each task stops itself after this long; default 45.
# Mail flags go on the sbatch command line only (hpc/README.md), never in this file. The job refuses to start unless the
# checkout is at exactly <commit>; it never runs git pull or git fetch.
# Reads <folder>/restore-phased.json (never written) and appends to <folder>/parts/part-<k>-of-8.jsonl. results/ gets
# counts and timings only.
# Exit code of a task: 0 its shard is done; 3 it stopped at the time limit with games left (submit the same line again: it
# continues from its part file); 1 a failure; 2 a refusal before the search started.
set -euo pipefail
_home="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
# shellcheck source=../lib/paths.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/paths.sh"
wc_scrub_env "$@"
# shellcheck source=../lib/job.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/job.sh"

commit="${1:-}"
folder="${2:-mistake-puzzles}"
stop_minutes="${3:-45}"
usage="usage: job.sbatch <the full 40-character commit hash> [<folder name> [<stop minutes>]]"
if [ "$#" -gt 3 ] || ! printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "$usage" >&2
  exit 2
fi
if [ "${#folder}" -gt 40 ] || ! printf '%s' "$folder" | grep -Eq '^[A-Za-z0-9_-]+$' ||
  printf '%s' "$folder" | grep -Eq '^[0-9]+$' || [ "$folder" = "history" ]; then
  echo "$usage (the folder name: letters, digits, dash, underscore; not all digits; not 'history')" >&2
  exit 2
fi
case "$stop_minutes" in '' | *[!0-9]*)
  echo "$usage (stop minutes: a whole number from 1 to 50)" >&2
  exit 2
  ;;
esac
if [ "${#stop_minutes}" -gt 9 ] || [ "$stop_minutes" -lt 1 ] || [ "$stop_minutes" -gt 50 ]; then
  echo "$usage (stop minutes: a whole number from 1 to 50)" >&2
  exit 2
fi
task="${SLURM_ARRAY_TASK_ID:-}"
tasks="${SLURM_ARRAY_TASK_COUNT:-}"
for v in "$task" "$tasks"; do
  case "$v" in '' | *[!0-9]*)
    echo "wc: this job needs an array (--array=0-7)" >&2
    exit 2
    ;;
  esac
done
if [ "$task" -ge "$tasks" ]; then
  echo "wc: array task $task of $tasks is not valid" >&2
  exit 2
fi

wc_job_begin mistake-puzzles
head="$(git -C "$WC_REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ "$head" != "$commit" ]; then
  wc_log "the checkout is at ${head:0:12}, not at the requested commit ${commit:0:12}: not running (no pull is done here)"
  exit 2
fi
dir="$WC_SCRATCH_ROOT/$folder"
if [ ! -d "$dir" ] || [ -L "$dir" ] || [ ! -s "$dir/restore-phased.json" ]; then
  wc_log "no restore-phased.json in the scratch folder '$folder': copy it there first (hpc/puzzles/README.md)"
  exit 2
fi
wc_mkdir "$dir/parts" || exit 2
WC_EXTRA_BINDS=(--bind "$dir:/puzzles")
rc=0
wc_container bash /work/repo/hpc/puzzles/container.sh mine "$task" "$tasks" "$commit" "$stop_minutes" || rc=$?
case "$rc" in
  0) wc_log "task $task of $tasks is done" ;;
  3) wc_log "task $task of $tasks stopped at the time limit: submit the same line again to continue" ;;
  *) wc_log "task $task of $tasks stopped with exit code $rc: look at the step log before resubmitting" ;;
esac
exit "$rc"
