#!/bin/bash
#SBATCH --job-name=wc-summarize
#SBATCH --partition=dev
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=1
#SBATCH --mem=1G
#SBATCH --time=00:05:00
#SBATCH --export=NONE
#
# Writes the report (summary.md) for the results of an earlier job or array: sbatch ... hpc/jobs/summarize.sbatch <id>
# <id> is the job id, or the array job id. The report lands in this job's own results folder and its Slurm output.
set -euo pipefail
_home="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
# shellcheck source=../lib/paths.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/paths.sh"
wc_scrub_env "$@"
# shellcheck source=../lib/job.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/job.sh"

id="${1:-}"
case "$id" in '' | *[!0-9]*) echo "usage: summarize.sbatch <job id or array job id>" >&2; exit 2 ;; esac
wc_job_begin summarize
if [ ! -d "$WC_RESULTS/$id" ]; then
  wc_log "no results folder $WC_RESULTS/$id"
  exit 2
fi
WC_EXTRA_BINDS=(--bind "$WC_RESULTS/$id:/inspect:ro")
rc=0
wc_container bash -c 'node hpc/summarize.mjs /inspect | tee "/results/summary-of-'"$id"'.md"' || rc=$?
exit "$rc"
