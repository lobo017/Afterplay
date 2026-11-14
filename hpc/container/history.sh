# shellcheck shell=bash
# One player's Chess.com history, inside the container. Argument: download | review | restore | engine-merge [--allow-partial].
# /history is ~/scratch/wizard-chess-hpc/history (the only place the personal data lives); the step logs in /results
# get counts only.
source /work/repo/hpc/container/common.sh
wc_info

mode="${1:?usage: history.sh download|review|restore}"
rc=0
case "$mode" in
  download)
    wc_step history-download 25 node hpc/history/download.mjs --dir /history || rc=1
    ;;
  review)
    wc_step history-review 5 node hpc/history/report.mjs --dir /history || rc=1
    ;;
  restore)
    wc_step history-restore 12 node hpc/history/build-restore.mjs --dir /history || rc=1
    # The app's own import, run against the file in the unit test harness (the test is skipped without the variable)
    if [ "$rc" = 0 ]; then
      wc_step history-validate 14 env WC_RESTORE_FILE=/history/restore.json \
        npm test -- tests/unit/history-import.test.ts || rc=1
    fi
    ;;
  engine-merge)
    # The chunk count is HISTORY_CHUNKS (hpc/history/lib/settings.mjs), the same number the engine job checks
    chunks="$(node --input-type=module -e "import('./hpc/history/lib/settings.mjs').then((m) => console.log(m.HISTORY_CHUNKS))")" || chunks=""
    case "$chunks" in '' | *[!0-9]*)
      echo "could not read HISTORY_CHUNKS from hpc/history/lib/settings.mjs" >&2
      exit 2
      ;;
    esac
    extra=()
    case "${2:-}" in
      '') ;;
      --allow-partial) extra=(--allow-partial) ;;
      *)
        echo "usage: history.sh engine-merge [--allow-partial]" >&2
        exit 2
        ;;
    esac
    wc_step history-engine-merge 10 node hpc/history/merge-reviews.mjs --dir /history --chunks "$chunks" \
      ${extra[@]+"${extra[@]}"} || rc=1
    ;;
  *)
    echo "usage: history.sh download|review|restore" >&2
    rc=2
    ;;
esac
exit "$rc"
