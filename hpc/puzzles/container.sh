# shellcheck shell=bash
# Inside the container: the mistake-puzzle search (one shard) or its merge. /puzzles is the work folder
# ~/scratch/wizard-chess-hpc/<folder>/ (restore-phased.json in, parts/ and puzzles.json out: the only place ids and puzzle
# data are written); /results gets the step logs, which hold counts and timings only.
#   container.sh mine <task> <tasks> <commit> <stop minutes>   one shard: task k of PUZZLE_SHARDS
#   container.sh merge [--allow-partial]                       the shards into puzzles.json and puzzles.counts.json
# Exit code of `mine`: 0 the shard is done; 3 stopped at the time limit with games left (run the same line again); 1 a
# failure; 2 a refusal before it started.
source /work/repo/hpc/container/common.sh
wc_info

shards="$(node --input-type=module -e "import('./hpc/puzzles/lib/positions.mjs').then((m) => console.log(m.PUZZLE_SHARDS))")" || shards=""
case "$shards" in '' | *[!0-9]*)
  echo "could not read PUZZLE_SHARDS from hpc/puzzles/lib/positions.mjs" >&2
  exit 2
  ;;
esac

mode="${1:?usage: container.sh mine|merge}"
rc=0
case "$mode" in
  mine)
    task="${2:?usage: container.sh mine <task> <tasks> <commit> <stop minutes>}"
    tasks="${3:?}"
    commit="${4:?}"
    stop="${5:?}"
    if [ "$tasks" -ne "$shards" ]; then
      echo "$tasks array tasks do not make $shards shards (hpc/puzzles/lib/positions.mjs): change the array size or PUZZLE_SHARDS" >&2
      exit 2
    fi
    # The step limit is the stop time plus 10 minutes for a game in flight
    wc_step "puzzles-mine-$task" "$((stop + 10))" node hpc/puzzles/mine-positions.mjs \
      --input /puzzles/restore-phased.json --dir /puzzles --shard "$task" --shards "$shards" \
      --commit "$commit" --stop-after-minutes "$stop" || rc=$?
    ;;
  merge)
    extra=()
    case "${2:-}" in
      '') ;;
      --allow-partial) extra=(--allow-partial) ;;
      *)
        echo "usage: container.sh merge [--allow-partial]" >&2
        exit 2
        ;;
    esac
    wc_step puzzles-merge 10 node hpc/puzzles/merge-positions.mjs \
      --input /puzzles/restore-phased.json --dir /puzzles --shards "$shards" --out /puzzles/puzzles.json \
      ${extra[@]+"${extra[@]}"} || rc=1
    # The hash and size of the result, so the copy on the laptop can be checked against it
    if [ "$rc" = 0 ] && [ -s /puzzles/puzzles.json ]; then
      echo "puzzles.json: $(stat -c %s /puzzles/puzzles.json) bytes, sha256 $(sha256sum /puzzles/puzzles.json | cut -d' ' -f1)" |
        tee -a /results/puzzles-merge.log
    fi
    ;;
  *)
    echo "usage: container.sh mine|merge" >&2
    rc=2
    ;;
esac
exit "$rc"
