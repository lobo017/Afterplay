#!/bin/bash
#SBATCH --job-name=wc-unit
#SBATCH --partition=dev
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=8G
#SBATCH --time=00:55:00
#SBATCH --export=NONE
#
# Type check, lint, format check, build and the unit tests (vitest), each as its own step. Arguments go to vitest:
#   sbatch ... hpc/jobs/unit.sbatch tests/unit/rules.test.ts
# Submit with --chdir and --output inside ~/work/wizard-chess-hpc (hpc/README.md).
set -euo pipefail
_home="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
# shellcheck source=../lib/paths.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/paths.sh"
wc_scrub_env "$@"
# shellcheck source=../lib/job.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/job.sh"

wc_job_begin unit
rc=0
wc_container bash /work/repo/hpc/container/unit.sh "$@" || rc=$?
exit "$rc"
