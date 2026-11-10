# shellcheck shell=bash
# Deep check of one chunk of the bundled puzzles. Arguments: <chunk> <chunks>, e.g. 3 20.
source /work/repo/hpc/container/common.sh
wc_info

chunk="${1:?usage: puzzles.sh <chunk> <chunks>}"
chunks="${2:?usage: puzzles.sh <chunk> <chunks>}"
# The script stops itself after 22 minutes and still writes its totals; the step limit is a little above
wc_step "puzzles-$chunk" 25 node scripts/verify-puzzles.mjs --chunk "$chunk" --chunks "$chunks" --max-minutes 22 --out /results
