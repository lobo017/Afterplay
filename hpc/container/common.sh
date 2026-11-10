# shellcheck shell=bash
# hpc/container/common.sh: sourced by the scripts that run INSIDE the Playwright container.
# Inside: /work/repo is the repo, /results the job's results folder, /tmp the job's scratch folder.
# Not `set -e`: a failing step must not stop the next one; every step records its own exit code.
set -u
cd /work/repo || exit 70
export HOME=/tmp/home
mkdir -p "$HOME"
: >>/results/steps.tsv

# The container must have its own PID namespace: that is what limits the leftover-process checks (scripts/lib/
# process-guard.mjs, tests/e2e/global-setup.ts) to this job on a shared node.
if [ -n "${WC_HOST_PIDNS:-}" ] && [ "$(readlink /proc/self/ns/pid)" = "$WC_HOST_PIDNS" ]; then
  echo "FATAL: the container shares the host's PID namespace; refusing to run on a shared node" >&2
  exit 71
fi

# wc_step <name> <minutes> <command...>: runs the command with a hard time limit, logs to /results/<name>.log and
# appends "<name> <exit code> <seconds>" to /results/steps.tsv. Returns the command's exit code.
wc_step() {
  local name="$1" minutes="$2" start rc
  shift 2
  echo "=== [$name] $* (limit $minutes min)"
  start=$SECONDS
  timeout --kill-after=30 "${minutes}m" "$@" 2>&1 | tee "/results/$name.log"
  rc=${PIPESTATUS[0]}
  printf '%s\t%s\t%s\n' "$name" "$rc" "$((SECONDS - start))" >>/results/steps.tsv
  echo "=== [$name] exit $rc after $((SECONDS - start)) s"
  return "$rc"
}

wc_info() {
  {
    echo "node $(node -v), npm $(npm -v)"
    echo "playwright $(node -p "require('@playwright/test/package.json').version" 2>/dev/null || echo '?')"
    echo "kernel $(uname -sr), $(nproc) CPUs visible, DISPLAY='${DISPLAY:-}'"
    echo "processes visible in the container: $(find /proc -maxdepth 1 -name '[0-9]*' | wc -l)"
    free -m | sed -n 1,2p
  } 2>&1 | tee /results/environment.txt
}
