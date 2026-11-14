# shellcheck shell=bash
# One array task of the engine review, inside the container: one review-games.mjs process per chunk of the task, all at
# once. Arguments: <task> <tasks> <workers> <commit> <stop minutes> [<games per chunk>]. Task k runs chunks k * workers .. k * workers +
# workers - 1 of HISTORY_CHUNKS (hpc/history/lib/settings.mjs); the numbers must multiply to it or nothing starts.
# /history is ~/scratch/wizard-chess-hpc/history (the only place game ids and numbers are written); each worker has its
# own step log in /results (history-engine-<chunk>.log) with counts, timings and, on an engine failure, a position
# within its chunk, never an id, a PGN or a name.
# Exit code: the worst of the workers: 1 if any failed (any code but 0 and 3), else 3 if any stopped at the time limit,
# else 0 (and 2 for a refusal before anything started).
source /work/repo/hpc/container/common.sh
wc_info

task="${1:?usage: history-engine.sh <task> <tasks> <workers> <commit> <stop minutes>}"
tasks="${2:?}"
workers="${3:?}"
commit="${4:?}"
stop="${5:?}"
limit="${6:-}"
limit_args=()
if [ -n "$limit" ]; then
  case "$limit" in *[!0-9]*)
    echo "games per chunk must be a whole number" >&2
    exit 2
    ;;
  esac
  limit_args=(--limit "$limit")
fi

chunks="$(node --input-type=module -e "import('./hpc/history/lib/settings.mjs').then((m) => console.log(m.HISTORY_CHUNKS))")" || chunks=""
case "$chunks" in '' | *[!0-9]*)
  echo "could not read HISTORY_CHUNKS from hpc/history/lib/settings.mjs" >&2
  exit 2
  ;;
esac
if [ "$((tasks * workers))" -ne "$chunks" ]; then
  echo "$tasks tasks of $workers workers do not make $chunks chunks (settings.mjs): change the array size, the CPUs or HISTORY_CHUNKS" >&2
  exit 2
fi
first=$((task * workers))
echo "task $task of $tasks: chunks $first to $((first + workers - 1)) of $chunks, $workers workers, stop after $stop min"
[ -n "$limit" ] && echo "limit: $limit games per chunk"

# All workers start together with the same stop time; the step limit is the stop time plus 10 minutes for a game in flight
pids=()
ids=()
for ((w = 0; w < workers; w++)); do
  chunk=$((first + w))
  wc_step "history-engine-$chunk" "$((stop + 10))" node hpc/history/review-games.mjs --dir /history \
    --chunk "$chunk" --chunks "$chunks" --commit "$commit" --stop-after-minutes "$stop" \
    ${limit_args[@]+"${limit_args[@]}"} &
  pids+=("$!")
  ids+=("$chunk")
done

# Wait for every worker (one that failed does not stop the others: their part files are checkpoints)
rc=0
for i in "${!pids[@]}"; do
  wrc=0
  wait "${pids[$i]}" || wrc=$?
  echo "chunk ${ids[$i]} exit $wrc"
  case "$wrc" in
    0) ;;
    3) [ "$rc" = 1 ] || rc=3 ;;
    *) rc=1 ;;
  esac
done
echo "task $task: exit $rc"
exit "$rc"
