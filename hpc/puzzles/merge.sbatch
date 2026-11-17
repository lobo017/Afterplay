#!/bin/bash
#SBATCH --job-name=wc-mistake-puzzles-merge
#SBATCH --partition=dev
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=1
#SBATCH --mem=4G
#SBATCH --time=00:20:00
#SBATCH --export=NONE
#
# Merges the shards of the mistake-puzzle search (hpc/puzzles/merge-positions.mjs) into
# <folder>/puzzles.json and <folder>/puzzles.counts.json:
#   sbatch ... hpc/puzzles/merge.sbatch <commit> [<folder name> [--allow-partial]]
# Without --allow-partial a missing shard or a game with no line is an error and nothing is written. The log (results/) has
# counts, the file's size and its sha-256, never an id or a move. Same refusals as job.sbatch (the exact commit, the folder
# name rules, restore-phased.json in the folder).
set -euo pipefail
_home="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
# shellcheck source=../lib/paths.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/paths.sh"
wc_scrub_env "$@"
# shellcheck source=../lib/job.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/job.sh"

commit="${1:-}"
folder="${2:-mistake-puzzles}"
flag="${3:-}"
usage="usage: merge.sbatch <the full 40-character commit hash> [<folder name> [--allow-partial]]"
if [ "$#" -gt 3 ] || ! printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "$usage" >&2
  exit 2
fi
if [ "${#folder}" -gt 40 ] || ! printf '%s' "$folder" | grep -Eq '^[A-Za-z0-9_-]+$' ||
  printf '%s' "$folder" | grep -Eq '^[0-9]+$' || [ "$folder" = "history" ]; then
  echo "$usage (the folder name: letters, digits, dash, underscore; not all digits; not 'history')" >&2
  exit 2
fi
case "$flag" in '' | --allow-partial) ;; *)
  echo "$usage" >&2
  exit 2
  ;;
esac

wc_job_begin mistake-puzzles-merge
head="$(git -C "$WC_REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ "$head" != "$commit" ]; then
  wc_log "the checkout is at ${head:0:12}, not at the requested commit ${commit:0:12}: not running (no pull is done here)"
  exit 2
fi
dir="$WC_SCRATCH_ROOT/$folder"
if [ ! -d "$dir" ] || [ -L "$dir" ] || [ ! -s "$dir/restore-phased.json" ] || [ ! -d "$dir/parts" ]; then
  wc_log "the scratch folder '$folder' has no restore-phased.json or no parts/: run job.sbatch first"
  exit 2
fi
WC_EXTRA_BINDS=(--bind "$dir:/puzzles")
rc=0
wc_container bash /work/repo/hpc/puzzles/container.sh merge ${flag:+"$flag"} || rc=$?
exit "$rc"
