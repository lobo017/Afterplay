# shellcheck shell=bash
# One full e2e run: build the app into the job's own dist/, then `playwright test` against a server on the job's own
# port. Arguments: --headed (run the extension tests in a real window under xvfb-run, if the headless mode cannot
# load the extension), then anything after `--` goes to Playwright (e.g. `-- tests/e2e/phase9.spec.ts`).
source /work/repo/hpc/container/common.sh
wc_info

headed=0
extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --headed) headed=1 ;;
    --) shift; extra=("$@"); break ;;
    *) echo "e2e.sh: unknown argument $1" >&2; exit 64 ;;
  esac
  shift
done

# The report hpc/summarize.mjs reads (playwright.config.ts adds the json reporter when this is set)
export PLAYWRIGHT_JSON_OUTPUT_NAME=/results/playwright-report.json
# Screenshots and traces land in /results/artifacts (test-results/ is mounted there)

wc_step build 15 npm run build || exit 1

prefix=()
if [ "$headed" = 1 ]; then
  export WC_HEADED=1
  prefix=(xvfb-run -a --server-args="-screen 0 1920x1080x24")
fi

rc=0
# 80 minutes is the hard limit of the test run; the Slurm limit is a little above it so the report is still written
wc_step e2e "${WC_E2E_MINUTES:-80}" "${prefix[@]}" npm run test:e2e -- "${extra[@]}" || rc=1
exit "$rc"
