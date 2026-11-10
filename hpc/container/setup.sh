# shellcheck shell=bash
# Setup, inside the container: npm ci (only when package-lock.json, Node or the Playwright version changed), then the
# smoke test. Only /work/repo (the repo), /cache/npm, /results and /tmp are mounted.
source /work/repo/hpc/container/common.sh
wc_info

lock_hash="$(sha256sum package-lock.json | cut -d' ' -f1)"
stamp="$(printf '%s %s %s' "$lock_hash" "$(node -v)" "${WC_PW_VERSION:-}")"
if [ -d node_modules ] && [ "$(cat node_modules/.wc-stamp 2>/dev/null)" = "$stamp" ]; then
  echo "node_modules is current (same lockfile, Node and Playwright): skipping npm ci"
else
  wc_step npm-ci 25 npm ci --no-audit --no-fund || exit 1
  printf '%s' "$stamp" >node_modules/.wc-stamp
fi

# The npm package and the browsers in the image must be the same Playwright version
installed="$(node -p "require('@playwright/test/package.json').version")"
if [ "$installed" != "${WC_PW_VERSION:-}" ]; then
  echo "FATAL: npm installed Playwright $installed but the image is for ${WC_PW_VERSION:-?}" >&2
  exit 1
fi

wc_step smoke 10 node hpc/smoke.mjs
smoke_rc=$?
if [ "$smoke_rc" != 0 ] && command -v xvfb-run >/dev/null 2>&1; then
  # Diagnostic: does the extension load in a real window? (decides whether the e2e job needs --headed)
  wc_step smoke-headed 5 xvfb-run -a node hpc/smoke.mjs --extension-headed
fi
exit "$smoke_rc"
