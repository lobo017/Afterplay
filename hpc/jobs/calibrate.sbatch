#!/bin/bash
#SBATCH --job-name=wc-calibrate
#SBATCH --partition=normal
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=3
#SBATCH --mem=3G
#SBATCH --time=00:50:00
#SBATCH --export=NONE
#SBATCH --array=0-6%4
#
# npm run calibrate:bots, one strength level per array task (0..6 = 400, 600, 1000, 1400, 1800, 2200, 2400).
# The time limit is an estimate: check results/<id>/task-*/ after the first run and tighten it.
set -euo pipefail
_home="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
# shellcheck source=../lib/paths.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/paths.sh"
wc_scrub_env "$@"
# shellcheck source=../lib/job.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/job.sh"

LEVELS=(400 600 1000 1400 1800 2200 2400)
task="${SLURM_ARRAY_TASK_ID:-}"
if [ -z "$task" ] || [ "$task" -ge "${#LEVELS[@]}" ]; then
  echo "wc: array task '$task' has no level (use --array=0-6)" >&2
  exit 2
fi
wc_job_begin calibrate
rc=0
wc_container bash /work/repo/hpc/container/calibrate.sh "${LEVELS[$task]}" || rc=$?
exit "$rc"
