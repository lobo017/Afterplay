#!/bin/bash
#SBATCH --job-name=wc-puzzles
#SBATCH --partition=normal
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=2
#SBATCH --mem=2G
#SBATCH --time=00:30:00
#SBATCH --export=NONE
#SBATCH --array=0-19%4
#
# Deep verification of all 20,000 bundled puzzles in chunks (task k checks puzzles k, k+N, k+2N, ...; N = the array
# size, which must be 0..N-1). Resize at submit time: sbatch --array=0-9%4 ... (then give the job a longer --time).
set -euo pipefail
_home="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
# shellcheck source=../lib/paths.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/paths.sh"
wc_scrub_env "$@"
# shellcheck source=../lib/job.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/job.sh"

task="${SLURM_ARRAY_TASK_ID:-}"
count="${SLURM_ARRAY_TASK_COUNT:-}"
if [ -z "$task" ] || [ -z "$count" ] || [ "${SLURM_ARRAY_TASK_MIN:-}" != 0 ] || [ "${SLURM_ARRAY_TASK_MAX:-}" != "$((count - 1))" ]; then
  echo "wc: the array must be 0..N-1 (got min ${SLURM_ARRAY_TASK_MIN:-?}, max ${SLURM_ARRAY_TASK_MAX:-?}, count ${count:-?})" >&2
  exit 2
fi
wc_job_begin puzzles
rc=0
wc_container bash /work/repo/hpc/container/puzzles.sh "$task" "$count" || rc=$?
exit "$rc"
