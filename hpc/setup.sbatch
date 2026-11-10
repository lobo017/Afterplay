#!/bin/bash
#SBATCH --job-name=wc-setup
#SBATCH --partition=dev
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=8G
#SBATCH --time=00:45:00
#SBATCH --export=NONE
#
# Setup of the Wizard's Chess checks on Juno. Run from the project folder (see hpc/README.md for the exact command;
# --chdir and --output must point into ~/work/wizard-chess-hpc). It:
#   1. updates (or on the first run clones) the repo in ~/work/wizard-chess-hpc/repo from GitHub
#   2. tests the safe-delete helper
#   3. pulls the Playwright image pinned to package-lock.json's Playwright version, once
#   4. runs `npm ci` inside the container (only when the lockfile, Node or Playwright changed)
#   5. smoke-tests headless Chromium, the blank-page frame rate and loading the extension
#   6. reports how much space and how many files the project folder uses
#
# The whole script is one function that is parsed before it runs, because step 1 may rewrite this very file.
set -euo pipefail
WC_REPO_URL="https://github.com/lobo017/Wizard-Chess.git"
_home="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
# shellcheck source=lib/paths.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/paths.sh"
wc_scrub_env "$@"
# shellcheck source=lib/job.sh
. "$_home/work/wizard-chess-hpc/repo/hpc/lib/job.sh"

main() {
  wc_job_begin setup --setup
  local rc=0

  # 1. The repo
  export GIT_TERMINAL_PROMPT=0
  if [ ! -d "$WC_REPO/.git" ]; then
    wc_log "cloning $WC_REPO_URL"
    git clone --branch main "$WC_REPO_URL" "$WC_REPO" || { wc_log "clone failed (is the GitHub repo private?)"; return 1; }
  else
    local changes
    changes="$(git -C "$WC_REPO" status --porcelain)"
    if [ -n "$changes" ]; then
      wc_log "the repo on Juno has local changes; not touching it:"
      echo "$changes"
      return 1
    fi
    git -C "$WC_REPO" fetch origin main
    git -C "$WC_REPO" merge --ff-only origin/main || { wc_log "cannot fast-forward the repo to origin/main"; return 1; }
  fi
  wc_log "repo at $(git -C "$WC_REPO" rev-parse --short HEAD): $(git -C "$WC_REPO" log -1 --format=%s)"

  # 2. The safe-delete helper must refuse what it should refuse
  bash "$WC_REPO/hpc/test/paths-test.sh" || return 1

  # 3. The image
  wc_image_vars || return 1
  if [ -f "$WC_IMAGE" ]; then
    wc_log "image present: $WC_IMAGE"
  else
    wc_log "pulling $WC_IMAGE_REF"
    wc_rm_tree "$WC_IMAGE.part"
    apptainer pull --force "$WC_IMAGE.part" "$WC_IMAGE_REF" || { wc_log "image pull failed"; return 1; }
    mv -- "$WC_IMAGE.part" "$WC_IMAGE"
  fi
  ls -la "$WC_IMAGE_DIR"

  # 4 and 5. npm ci and the smoke test, inside the container
  wc_container --setup bash /work/repo/hpc/container/setup.sh || rc=$?

  # 6. Space and files (only inside the project folder)
  {
    echo "project folder: $WC_ROOT"
    du -sh "$WC_REPO" "$WC_REPO/node_modules" "$WC_CACHE" "$WC_IMAGE_DIR" 2>/dev/null || true
    echo "files in the project folder: $(find "$WC_ROOT" -type f 2>/dev/null | wc -l)"
    command -v mfsgetquota >/dev/null 2>&1 && mfsgetquota -h "$WC_ROOT" 2>&1 || true
  } | tee "$WC_RESULT_DIR/usage.txt"
  return "$rc"
}

main "$@"; exit $?
