# shellcheck shell=bash
# hpc/lib/paths.sh: sourced by every Juno script (the setup job and all jobs).
#
# It defines the ONE place this project may live on Juno and the ONLY way these scripts delete anything:
#
#   ~/work/wizard-chess-hpc/      repo/  results/  cache/  image/
#   ~/scratch/wizard-chess-hpc/   <job-id>/   (temporary files of one job; removed when the job ends)
#
# Nothing here touches anything else in the home folder: no dotfiles, no ssh keys, no conda, no other projects.

# --- A clean environment ------------------------------------------------------------------------
# `#SBATCH --export=NONE` stops the submit shell's environment from reaching the job, but Slurm may still
# build the job's environment like a login shell (which could activate conda from a dotfile). So every
# script calls `wc_scrub_env "$@"` as its first command: it restarts the script once under `env -i`, keeping only
# the SLURM_* variables, HOME and USER, and a fixed PATH. Nothing from any dotfile survives.
wc_scrub_env() {
  [ "${WC_ENV_SCRUBBED:-}" = 1 ] && return 0
  local home="${HOME:-}" user v
  local -a keep=()
  user="$(id -un)"
  if [ -z "$home" ]; then home="$(getent passwd "$user" | cut -d: -f6)"; fi
  if [ -z "$home" ] || [ ! -d "$home" ]; then
    echo "wc: cannot find the home folder" >&2
    exit 2
  fi
  for v in $(compgen -e); do
    case "$v" in SLURM_*) keep+=("$v=${!v}") ;; esac
  done
  exec /usr/bin/env -i "${keep[@]}" HOME="$home" USER="$user" LOGNAME="$user" LC_ALL=C \
    PATH=/usr/local/bin:/usr/bin:/bin WC_ENV_SCRUBBED=1 /bin/bash "$0" "$@"
}

# --- Folders ------------------------------------------------------------------------------------
wc_init_paths() {
  if [ -z "${HOME:-}" ] || [ ! -d "$HOME/work" ] || [ ! -d "$HOME/scratch" ]; then
    echo "wc: expected ~/work and ~/scratch to exist" >&2
    return 2
  fi
  # Resolved (symlinks followed), so the checks below compare real locations
  WC_ROOT="$(realpath -m -- "$HOME/work/wizard-chess-hpc")"
  WC_SCRATCH_ROOT="$(realpath -m -- "$HOME/scratch/wizard-chess-hpc")"
  WC_REPO="$WC_ROOT/repo"
  WC_RESULTS="$WC_ROOT/results"
  WC_CACHE="$WC_ROOT/cache"
  WC_IMAGE_DIR="$WC_ROOT/image"
  export WC_ROOT WC_SCRATCH_ROOT WC_REPO WC_RESULTS WC_CACHE WC_IMAGE_DIR
}

# True if $1 (after resolving symlinks and "..") lies strictly inside one of the two project roots.
wc_inside_project() {
  local p root
  [ -n "${1:-}" ] || return 1
  [ -n "${WC_ROOT:-}" ] && [ -n "${WC_SCRATCH_ROOT:-}" ] || return 1
  p="$(realpath -m -- "$1")" || return 1
  for root in "$WC_ROOT" "$WC_SCRATCH_ROOT"; do
    case "$p" in "$root"/?*) return 0 ;; esac
  done
  return 1
}

# mkdir -p, but only inside the project folders.
wc_mkdir() {
  local d
  for d in "$@"; do
    if ! wc_inside_project "$d" && [ "$(realpath -m -- "$d")" != "$WC_ROOT" ] && [ "$(realpath -m -- "$d")" != "$WC_SCRATCH_ROOT" ]; then
      echo "wc_mkdir: refusing '$d' (outside the project folders)" >&2
      return 1
    fi
    mkdir -p -- "$d"
  done
}

# The only delete in these scripts. Removes a file or folder tree, and refuses:
#   - an empty or unset argument (callers pass "${VAR:-}" so an unset variable arrives empty)
#   - a symlink, or anything that resolves outside ~/work/wizard-chess-hpc/ and ~/scratch/wizard-chess-hpc/
#   - the two roots themselves, and the top-level project folders (repo, results, cache, image)
wc_rm_tree() {
  local target="${1:-}" p rel
  if [ -z "$target" ]; then
    echo "wc_rm_tree: refusing an empty path" >&2
    return 1
  fi
  if [ -z "${WC_ROOT:-}" ] || [ -z "${WC_SCRATCH_ROOT:-}" ]; then
    echo "wc_rm_tree: project roots are not set" >&2
    return 1
  fi
  if [ -L "$target" ]; then
    echo "wc_rm_tree: refusing a symlink: $target" >&2
    return 1
  fi
  p="$(realpath -m -- "$target")" || return 1
  if [ -z "$p" ] || [ "$p" = "/" ]; then
    echo "wc_rm_tree: refusing '$target'" >&2
    return 1
  fi
  if ! wc_inside_project "$p"; then
    echo "wc_rm_tree: refusing '$target' (resolves to '$p', outside the project folders)" >&2
    return 1
  fi
  case "$p" in
    "$WC_ROOT"/*)
      rel="${p#"$WC_ROOT"/}"
      case "$rel" in repo | results | cache | image)
        echo "wc_rm_tree: refusing the project folder '$rel'" >&2
        return 1
        ;;
      esac
      ;;
  esac
  [ -e "$p" ] || return 0
  rm -rf -- "$p"
}

# --- The pinned image ---------------------------------------------------------------------------
# The Playwright version npm will install, read from package-lock.json (the pin that matters).
wc_playwright_version() {
  awk '
    /"node_modules\/@playwright\/test": \{/ { found = 1; next }
    found && /"version":/ { gsub(/[",]/, "", $2); print $2; exit }
  ' "$WC_REPO/package-lock.json"
}

# Sets WC_PW_VERSION, WC_IMAGE_REF (registry reference) and WC_IMAGE (the .sif file) from the lockfile.
wc_image_vars() {
  WC_PW_VERSION="$(wc_playwright_version)"
  if ! printf '%s' "$WC_PW_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "wc: could not read the Playwright version from $WC_REPO/package-lock.json (got '$WC_PW_VERSION')" >&2
    return 1
  fi
  WC_IMAGE_REF="docker://mcr.microsoft.com/playwright:v${WC_PW_VERSION}-noble"
  WC_IMAGE="$WC_IMAGE_DIR/playwright-v${WC_PW_VERSION}-noble.sif"
  export WC_PW_VERSION WC_IMAGE_REF WC_IMAGE
}

# --- Modules ------------------------------------------------------------------------------------
# Loads apptainer/1.3.4 with the site's own module init (never a user dotfile).
wc_load_apptainer() {
  # Module init scripts are not written for `set -u` or `set -e`
  local had_u=0 had_e=0 rc=0
  case "$-" in *u*) had_u=1 ;; esac
  case "$-" in *e*) had_e=1 ;; esac
  set +u +e
  wc_load_apptainer_inner || rc=$?
  [ "$had_u" = 1 ] && set -u
  [ "$had_e" = 1 ] && set -e
  return "$rc"
}

# Gets the `module` command from Juno's own Lmod init, never from a user dotfile. On Juno (OpenHPC) the site script
# /etc/profile.d/lmod.sh did not define `module` in a scrubbed job, but Lmod's own init does:
# MODULESHOME=/opt/ohpc/admin/lmod/lmod, so /opt/ohpc/admin/lmod/lmod/init/bash.
wc_load_apptainer_inner() {
  local f
  if ! command -v module >/dev/null 2>&1; then
    for f in /etc/profile.d/lmod.sh /opt/ohpc/admin/lmod/lmod/init/bash; do
      if [ -r "$f" ]; then
        echo "wc: sourcing $f"
        # shellcheck disable=SC1090
        . "$f"
        command -v module >/dev/null 2>&1 && break
      fi
    done
  fi
  if ! command -v module >/dev/null 2>&1; then
    echo "wc: the 'module' command is still not defined after sourcing the Lmod init files" >&2
    return 1
  fi
  echo "wc: module found; MODULESHOME='${MODULESHOME:-}' LMOD_CMD='${LMOD_CMD:-}' MODULEPATH='${MODULEPATH:-}'"
  # Juno's login MODULEPATH, used only if the init left it empty or the module is not found with the one it set
  local login_modulepath=/opt/ohpc/pub/unpackaged/modulefiles:/opt/ohpc/pub/registry/views/default:/opt/ohpc/pub/moduledeps/gnu14-openmpi5:/opt/ohpc/pub/moduledeps/gnu14:/opt/ohpc/pub/moduledeps/spack:/opt/ohpc/pub/modulefiles
  if [ -z "${MODULEPATH:-}" ]; then
    export MODULEPATH="$login_modulepath"
    echo "wc: MODULEPATH was empty after the init; set it to Juno's login value"
  elif ! module load apptainer/1.3.4 2>/dev/null; then
    export MODULEPATH="$login_modulepath"
    echo "wc: apptainer/1.3.4 not found with the init's MODULEPATH; retrying with Juno's login value"
  else
    echo "wc: loaded apptainer/1.3.4 with the init's MODULEPATH"
  fi
  if ! command -v apptainer >/dev/null 2>&1; then
    # The load reported success (or was retried above) but apptainer is not on PATH: one more try with the login path
    if [ "${MODULEPATH:-}" != "$login_modulepath" ]; then
      export MODULEPATH="$login_modulepath"
      echo "wc: apptainer not on PATH; retrying with Juno's login MODULEPATH"
    fi
    module load apptainer/1.3.4 || {
      echo "wc: 'module load apptainer/1.3.4' failed (MODULEPATH='${MODULEPATH:-}')" >&2
      return 1
    }
  fi
  command -v apptainer >/dev/null 2>&1 || {
    echo "wc: apptainer is not on PATH after 'module load apptainer/1.3.4'" >&2
    return 1
  }
}
