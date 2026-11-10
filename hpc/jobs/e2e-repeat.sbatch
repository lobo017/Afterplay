#!/bin/bash
#SBATCH --job-name=wc-e2e-repeat
#SBATCH --partition=normal
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=6
#SBATCH --mem=12G
#SBATCH --time=01:40:00
#SBATCH --export=NONE
#SBATCH --array=1-4%4
#
# N full e2e runs (default 4, at most 4 at a time) to expose flaky tests. Change N at submit time:
#   sbatch --array=1-8%4 ... hpc/jobs/e2e-repeat.sbatch
# Every task is a complete run with its own build, port, temp folder and results/<array-job-id>/task-<n>/. Compare
# them with hpc/jobs/summarize.sbatch <array-job-id> (it lists the tests whose result differed between runs).
set -euo pipefail
_home="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
# shellcheck source=../lib/paths.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/paths.sh"
wc_scrub_env "$@"
# shellcheck source=../lib/job.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/job.sh"

wc_job_begin e2e
rc=0
wc_container bash /work/repo/hpc/container/e2e.sh "$@" || rc=$?
exit "$rc"
