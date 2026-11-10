# shellcheck shell=bash
# The four perf scripts, one after the other, on the whole node (the job is --exclusive). Arguments: `--only
# drag,review,tasks,memory` runs a subset. Numbers from here are regression baselines for the code on a headless
# Linux node, not what a user's screen would show.
source /work/repo/hpc/container/common.sh
wc_info

only="drag,review,tasks,memory"
while [ $# -gt 0 ]; do
  case "$1" in
    --only) only="$2"; shift ;;
    *) echo "perf.sh: unknown argument $1" >&2; exit 64 ;;
  esac
  shift
done

# Every script serves the app on the job's own port; they run one at a time
export PERF_PORT="$WC_PORT"

wc_step build 15 npm run build || exit 1

rc=0
run() { # <name> <script> <step minutes>; the script's own run limit (PERF_MAX_RUN_MS) is a little below the step's
  case ",$only," in *",$1,"*) ;; *) return 0 ;; esac
  PERF_MAX_RUN_MS=$(($3 * 60 * 1000 - 120000)) wc_step "perf-$1" "$3" npm run "perf:$2" || rc=1
}
run drag drag 15
run review review 22
run tasks tasks 12
run memory memory 12
exit "$rc"
