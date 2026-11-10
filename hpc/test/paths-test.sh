#!/bin/bash
# Checks the safe-delete helper (hpc/lib/paths.sh) in a fake home folder: it must refuse everything outside
# ~/work/wizard-chess-hpc/ and ~/scratch/wizard-chess-hpc/, empty and unset arguments, symlinks, ".." tricks, the roots
# and the top-level project folders, and it must delete what is inside. The setup job runs this first; it also runs in
# Git Bash on Windows:  bash hpc/test/paths-test.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../lib/paths.sh
. "$here/../lib/paths.sh"

# On Juno (inside a Slurm job) the temporary fake home must be inside the project's own folders, never the node's
# /tmp: the caller sets TMPDIR to the job's scratch folder, and this fails if it is not inside a wizard-chess-hpc folder.
if [ -n "${SLURM_JOB_ID:-}" ]; then
  wc_init_paths || exit 2
  if ! wc_inside_project "${TMPDIR:-}"; then
    echo "FAIL TMPDIR='${TMPDIR:-}' is not inside ~/work/wizard-chess-hpc or ~/scratch/wizard-chess-hpc" >&2
    exit 2
  fi
fi
outer="$(mktemp -d "${TMPDIR:-/tmp}/wc-paths-test.XXXXXX")"
fake="$outer/home"
mkdir -p "$fake/work" "$fake/scratch" "$fake/other"
HOME="$fake"
wc_init_paths || exit 2
wc_mkdir "$WC_REPO" "$WC_RESULTS" "$WC_CACHE" "$WC_IMAGE_DIR" "$WC_SCRATCH_ROOT" || exit 2

fails=0
ok() { echo "ok   $1"; }
bad() {
  echo "FAIL $1"
  fails=$((fails + 1))
}
# refuses <what> <path>: wc_rm_tree must fail and leave the path alone
refuses() {
  if wc_rm_tree "$2" 2>/dev/null; then
    bad "$1 was NOT refused"
  elif [ -z "$2" ] || [ -e "$2" ] || [ -L "$2" ]; then
    ok "$1 refused"
  else
    bad "$1: refused, but the path is gone (the test path is wrong)"
  fi
}
# removes <what> <path>
removes() {
  if wc_rm_tree "$2" 2>/dev/null && [ ! -e "$2" ]; then ok "$1 removed"; else bad "$1 was not removed"; fi
}

mkdir -p "$fake/other/precious"
touch "$fake/other/precious/file" "$fake/.bashrc" "$fake/work/neighbour-project-file"

refuses "empty argument" ""
unset NOT_SET_ANYWHERE
refuses "unset variable" "${NOT_SET_ANYWHERE:-}"
refuses "another folder in home" "$fake/other/precious"
refuses "home itself" "$fake"
refuses "a dotfile" "$fake/.bashrc"
refuses "a neighbour in ~/work" "$fake/work/neighbour-project-file"
refuses "the root" "$WC_ROOT"
refuses "the scratch root" "$WC_SCRATCH_ROOT"
refuses "repo/" "$WC_REPO"
refuses "results/" "$WC_RESULTS"
refuses "cache/" "$WC_CACHE"
refuses "image/" "$WC_IMAGE_DIR"
mkdir -p "$WC_ROOT/results/1" "$WC_SCRATCH_ROOT/2"
refuses ".. out of the root" "$WC_ROOT/results/1/../../../../other/precious"
refuses ".. to the root" "$WC_ROOT/results/1/../.."
mkdir -p "$WC_ROOT-evil/x"
refuses "a sibling that only shares the prefix" "$WC_ROOT-evil/x"
refuses "/" "/"

if ln -s "$fake/other/precious" "$WC_ROOT/results/link" 2>/dev/null && [ -L "$WC_ROOT/results/link" ]; then
  refuses "a symlink" "$WC_ROOT/results/link"
  refuses "a path through a symlink" "$WC_ROOT/results/link/file"
else
  echo "skip symlink checks (this system cannot create symlinks)"
fi

mkdir -p "$WC_RESULTS/3/artifacts" "$WC_SCRATCH_ROOT/4/tmp"
touch "$WC_RESULTS/3/artifacts/a.png" "$WC_SCRATCH_ROOT/4/tmp/x"
removes "a results folder" "$WC_RESULTS/3"
removes "a scratch folder" "$WC_SCRATCH_ROOT/4"
[ -e "$fake/other/precious/file" ] && [ -e "$fake/.bashrc" ] && ok "files outside are untouched" || bad "files outside were touched"

# Clean up the fake home with the same helper (its roots now point at the temporary folder)
WC_ROOT="$outer/none"
WC_SCRATCH_ROOT="$outer"
wc_rm_tree "$fake"
wc_rm_tree "$WC_ROOT-evil"
rmdir "$outer" 2>/dev/null || echo "note: $outer was not empty"

if [ "$fails" -gt 0 ]; then
  echo "$fails check(s) FAILED"
  exit 1
fi
echo "all safe-delete checks passed"
