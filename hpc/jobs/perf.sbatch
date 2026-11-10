#!/bin/bash
#SBATCH --job-name=wc-perf
#SBATCH --partition=normal
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=16G
#SBATCH --time=01:30:00
#SBATCH --export=NONE
#SBATCH --exclusive
#
# perf:drag, perf:review, perf:tasks and perf:memory, one after the other, on a node of its own (--exclusive, so
# nothing else disturbs the frame timings; the cost is the whole node for the time it runs). `--only drag,tasks`
# runs a subset. Numbers from Juno are regression baselines, not user-experience measurements.
set -euo pipefail
_home="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
# shellcheck source=../lib/paths.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/paths.sh"
wc_scrub_env "$@"
# shellcheck source=../lib/job.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/job.sh"

wc_job_begin perf
rc=0
wc_container bash /work/repo/hpc/container/perf.sh "$@" || rc=$?
exit "$rc"
