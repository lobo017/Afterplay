# shellcheck shell=bash
# hpc/lib/job.sh: the shared start and end of every job (after paths.sh). It
#   - creates the job's folders: results/<job-id>/ and ~/scratch/wizard-chess-hpc/<job-id>/
#   - picks the job's own port for the app server (no two jobs on a node share one)
#   - runs commands in the pinned Playwright image with `apptainer exec --cleanenv --containall`, binding ONLY
#     the repo, the npm cache, the job's scratch folder as /tmp, and the job's results
#   - on every way out (success, failure, scancel, time limit) writes the report, checks the repo for stray
#     changes, and removes the scratch folder through wc_rm_tree

WC_CPID=""
WC_TERMINATED=0
WC_EXTRA_BINDS=()
WC_STARTED_AT=""

wc_log() {
  local line
  line="[wc $(date +%H:%M:%S)] $*"
  echo "$line"
  [ -n "${WC_RESULT_DIR:-}" ] && [ -d "${WC_RESULT_DIR:-}" ] && echo "$line" >>"$WC_RESULT_DIR/job.log"
  return 0
}

# --- Port: one of 20000-39999, free on this node, different for every job ----------------------
wc_port_in_use() {
  # A successful connect to loopback means something listens there.
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

wc_pick_port() {
  local p=$((20000 + SLURM_JOB_ID % 20000)) i
  for i in $(seq 1 300); do
    if ! wc_port_in_use "$p"; then
      WC_PORT="$p"
      export WC_PORT
      return 0
    fi
    p=$((p + 1))
    [ "$p" -gt 39999 ] && p=20000
  done
  echo "wc: no free port found" >&2
  return 1
}

# --- Signals ------------------------------------------------------------------------------------
wc_on_signal() {
  WC_TERMINATED=1
  wc_log "signal received (cancelled or time limit): stopping the container"
  [ -n "$WC_CPID" ] && kill -TERM "$WC_CPID" 2>/dev/null
  return 0
}

# --- Start --------------------------------------------------------------------------------------
# wc_job_begin <type> [--setup]
# --setup: the repo and the image may not exist yet (the setup job creates them).
wc_job_begin() {
  WC_JOB_TYPE="$1"
  local setup=0
  [ "${2:-}" = "--setup" ] && setup=1
  case "${SLURM_JOB_ID:-}" in '' | *[!0-9]*)
    echo "wc: this script must run as a Slurm job (SLURM_JOB_ID is missing)" >&2
    exit 2
    ;;
  esac
  WC_JOB_ID="$SLURM_JOB_ID"
  wc_init_paths || exit 2
  wc_mkdir "$WC_ROOT" "$WC_RESULTS" "$WC_RESULTS/slurm" "$WC_CACHE" "$WC_CACHE/npm" "$WC_CACHE/apptainer" \
    "$WC_IMAGE_DIR" "$WC_SCRATCH_ROOT" || exit 2

  if [ -n "${SLURM_ARRAY_JOB_ID:-}" ]; then
    WC_RESULT_DIR="$WC_RESULTS/$SLURM_ARRAY_JOB_ID/task-${SLURM_ARRAY_TASK_ID:-0}"
  else
    WC_RESULT_DIR="$WC_RESULTS/$WC_JOB_ID"
  fi
  WC_JOB_SCRATCH="$WC_SCRATCH_ROOT/$WC_JOB_ID"
  export WC_RESULT_DIR WC_JOB_SCRATCH
  wc_mkdir "$WC_RESULT_DIR" "$WC_RESULT_DIR/artifacts" "$WC_JOB_SCRATCH" "$WC_JOB_SCRATCH/tmp" \
    "$WC_JOB_SCRATCH/dist" "$WC_JOB_SCRATCH/dist-ext" "$WC_JOB_SCRATCH/vite-cache" "$WC_JOB_SCRATCH/vite-temp" || exit 2
  WC_STARTED_AT="$(date -Is)"
  trap wc_job_end EXIT
  trap wc_on_signal TERM INT HUP

  wc_log "job $WC_JOB_ID ($WC_JOB_TYPE) on $(hostname), results in $WC_RESULT_DIR, scratch $WC_JOB_SCRATCH"
  wc_pick_port || exit 2
  wc_log "app-server port $WC_PORT"

  if [ "$setup" = 0 ]; then
    if [ ! -d "$WC_REPO/.git" ]; then
      wc_log "no repo at $WC_REPO: run the setup job first"
      exit 2
    fi
    wc_image_vars || exit 2
    if [ ! -f "$WC_IMAGE" ]; then
      wc_log "image $WC_IMAGE is missing: run the setup job first"
      exit 2
    fi
    # The repo's mount points: gitignored folders the per-job folders are mounted over
    wc_mkdir "$WC_REPO/dist" "$WC_REPO/dist-ext" "$WC_REPO/test-results" \
      "$WC_REPO/node_modules/.vite" "$WC_REPO/node_modules/.vite-temp" || exit 2
  fi
  wc_load_apptainer || exit 2
  export APPTAINER_CACHEDIR="$WC_CACHE/apptainer"
  export APPTAINER_TMPDIR="$WC_JOB_SCRATCH/tmp"

  local commit="unknown" subject=""
  if [ -d "$WC_REPO/.git" ]; then
    commit="$(git -C "$WC_REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
    subject="$(git -C "$WC_REPO" log -1 --format=%s 2>/dev/null | tr -d '"\\' || true)"
  fi
  cat >"$WC_RESULT_DIR/meta.json" <<EOF
{
  "jobId": "$WC_JOB_ID",
  "arrayJobId": "${SLURM_ARRAY_JOB_ID:-}",
  "arrayTaskId": "${SLURM_ARRAY_TASK_ID:-}",
  "type": "$WC_JOB_TYPE",
  "jobName": "${SLURM_JOB_NAME:-}",
  "node": "$(hostname)",
  "partition": "${SLURM_JOB_PARTITION:-}",
  "cpus": "${SLURM_CPUS_ON_NODE:-}",
  "port": $WC_PORT,
  "startedAt": "$WC_STARTED_AT",
  "commit": "$commit",
  "commitSubject": "$subject",
  "playwright": "${WC_PW_VERSION:-}",
  "image": "$(basename "${WC_IMAGE:-none}")"
}
EOF
  wc_log "repo commit $commit"
}

# --- Run a command in the container -------------------------------------------------------------
# wc_container [--setup] <command...>
# --setup: fewer mounts (npm ci replaces node_modules, so nothing may be mounted inside it).
wc_container() {
  local setup=0
  [ "${1:-}" = "--setup" ] && {
    setup=1
    shift
  }
  if [ "$WC_TERMINATED" = 1 ]; then return 143; fi
  wc_mkdir "$WC_JOB_SCRATCH/tmp/home" || return 1
  local -a binds=(
    --bind "$WC_REPO:/work/repo"
    --bind "$WC_CACHE/npm:/cache/npm"
    --bind "$WC_JOB_SCRATCH/tmp:/tmp"
    --bind "$WC_RESULT_DIR:/results"
    # DNS inside the container (npm ci needs the registry); a read-only system file, nothing of the user's
    --bind /etc/resolv.conf:/etc/resolv.conf:ro
  )
  # A job may add read-only mounts, e.g. the summarize job: WC_EXTRA_BINDS=(--bind "<dir>:/inspect:ro")
  if [ "${#WC_EXTRA_BINDS[@]}" -gt 0 ]; then binds+=("${WC_EXTRA_BINDS[@]}"); fi
  if [ "$setup" = 0 ]; then
    binds+=(
      --bind "$WC_JOB_SCRATCH/dist:/work/repo/dist"
      --bind "$WC_JOB_SCRATCH/dist-ext:/work/repo/dist-ext"
      --bind "$WC_RESULT_DIR/artifacts:/work/repo/test-results"
      --bind "$WC_JOB_SCRATCH/vite-cache:/work/repo/node_modules/.vite"
      --bind "$WC_JOB_SCRATCH/vite-temp:/work/repo/node_modules/.vite-temp"
    )
  fi
  local -a envs=(
    --env "HOME=/tmp/home"
    --env "TMPDIR=/tmp"
    --env "npm_config_cache=/cache/npm"
    --env "npm_config_update_notifier=false"
    --env "npm_config_fund=false"
    --env "npm_config_audit=false"
    --env "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"
    --env "WC_PORT=$WC_PORT"
    --env "WC_JOB_ID=$WC_JOB_ID"
    --env "WC_JOB_TYPE=$WC_JOB_TYPE"
    --env "WC_PW_VERSION=${WC_PW_VERSION:-}"
    --env "WC_HOST_PIDNS=$(readlink /proc/self/ns/pid)"
    --env "WC_CPUS=${SLURM_CPUS_ON_NODE:-}"
  )
  wc_log "container: $*"
  # In the background and waited for, so a signal reaches this shell (and the container) at once
  apptainer exec --cleanenv --containall --no-home --pwd /work/repo "${binds[@]}" "${envs[@]}" "$WC_IMAGE" "$@" &
  WC_CPID=$!
  local rc=0
  wait "$WC_CPID" || rc=$?
  while kill -0 "$WC_CPID" 2>/dev/null; do
    wait "$WC_CPID" || rc=$?
  done
  WC_CPID=""
  [ "$WC_TERMINATED" = 1 ] && [ "$rc" = 0 ] && rc=143
  return "$rc"
}

# --- End (runs on every exit) -------------------------------------------------------------------
wc_job_end() {
  local rc=$?
  trap - EXIT
  set +e
  if [ -n "${WC_RESULT_DIR:-}" ] && [ -d "$WC_RESULT_DIR" ]; then
    wc_log "job ended with exit code $rc"
    echo "$rc" >"$WC_RESULT_DIR/exit-code.txt"
    date -Is >"$WC_RESULT_DIR/ended-at.txt"
    # Nothing but node_modules/ may change in the repo (the tool outputs are mounted over): list any change
    if [ -d "${WC_REPO:-}/.git" ]; then
      git -C "$WC_REPO" status --porcelain >"$WC_RESULT_DIR/repo-changes.txt" 2>&1
    fi
    # The report, written by the same script you can run on Windows: node hpc/summarize.mjs <folder>
    if [ -n "${WC_IMAGE:-}" ] && [ -f "$WC_IMAGE" ] && [ -f "${WC_REPO:-}/hpc/summarize.mjs" ] && [ "${WC_JOB_TYPE:-}" != "setup" ]; then
      WC_TERMINATED=0
      wc_container timeout 90 node hpc/summarize.mjs /results --write >/dev/null 2>&1
    fi
  fi
  # Everything temporary of this job goes, through the one safe delete
  if [ -n "${WC_JOB_SCRATCH:-}" ]; then
    wc_rm_tree "${WC_JOB_SCRATCH:-}" || echo "wc: could not remove ${WC_JOB_SCRATCH:-}" >&2
  fi
  exit "$rc"
}
