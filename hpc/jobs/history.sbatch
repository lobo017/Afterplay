#!/bin/bash
#SBATCH --job-name=wc-history
#SBATCH --partition=dev
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=2
#SBATCH --mem=4G
#SBATCH --time=00:40:00
#SBATCH --export=NONE
#
# One player's Chess.com history: sbatch ... hpc/jobs/history.sbatch download | review | restore
#   download  the monthly archives from the public API into ~/scratch/wizard-chess-hpc/history/raw/
#   review    report.txt, summary.txt and shortlist.txt from the raw files
#   restore   restore.json (the app's backup format) from the raw files, then the app's own import run against it
# Everything personal stays in ~/scratch/wizard-chess-hpc/history/: the raw files, the reports, the restore file, and
# the player's name in player.txt (put there by hand, see hpc/README.md; never an argument of this job, so it is in no
# Slurm record). This folder is kept between jobs; the job's own scratch folder is removed as usual. The logs under
# results/ get counts, month labels and HTTP statuses only.
set -euo pipefail
_home="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
# shellcheck source=../lib/paths.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/paths.sh"
wc_scrub_env "$@"
# shellcheck source=../lib/job.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/job.sh"

mode="${1:-}"
case "$mode" in
  download | review | restore) ;;
  *)
    echo "usage: history.sbatch download|review|restore" >&2
    exit 2
    ;;
esac
wc_job_begin history
hist="$WC_SCRATCH_ROOT/history"
wc_mkdir "$hist" "$hist/raw" || exit 2
if [ ! -s "$hist/player.txt" ]; then
  wc_log "no player.txt in the history folder: write the username there first (hpc/README.md)"
  exit 2
fi
WC_EXTRA_BINDS=(--bind "$hist:/history")
rc=0
wc_container bash /work/repo/hpc/container/history.sh "$mode" || rc=$?
exit "$rc"
