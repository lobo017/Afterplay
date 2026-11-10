# shellcheck shell=bash
# The checks that do not need a browser: type check, lint, format check, build, and the unit tests.
# Each is its own step with its own exit code; all of them run even if an earlier one fails.
# Extra arguments go to vitest, e.g. `-- tests/unit/rules.test.ts`.
source /work/repo/hpc/container/common.sh
wc_info

rc=0
wc_step typecheck 5 npm run typecheck || rc=1
wc_step lint 5 npm run lint || rc=1
wc_step format 3 npm run format:check || rc=1
wc_step build 8 npm run build || rc=1
wc_step unit 25 npm test -- --reporter=default --reporter=json --outputFile.json=/results/vitest-report.json "$@" || rc=1
exit "$rc"
