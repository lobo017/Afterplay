# shellcheck shell=bash
# Bot calibration for ONE strength level (the array task's). Argument: the rating, e.g. 1400.
source /work/repo/hpc/container/common.sh
wc_info

level="${1:?usage: calibrate.sh <rating>}"
export CALIBRATE_OUT="/results/calibrate-$level.json"
wc_step "calibrate-$level" 40 npm run calibrate:bots -- --level "$level"
