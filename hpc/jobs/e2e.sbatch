#!/bin/bash
#SBATCH --job-name=wc-e2e
#SBATCH --partition=normal
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=6
#SBATCH --mem=12G
#SBATCH --time=01:40:00
#SBATCH --export=NONE
#
# One full e2e run (build, then `playwright test`). Add `--headed` to run the extension tests in a real window under
# xvfb-run; anything after `--` goes to Playwright:  sbatch ... hpc/jobs/e2e.sbatch -- tests/e2e/phase9.spec.ts
# The test run itself is limited to 80 minutes inside, so the report is still written when it is cut short.
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
