// Pure helpers for scripts/perf-tasks.mjs: what to say about a task of 50 ms or more, with no browser involved.
// Measurement only: nothing here decides a pass or a fail.

const round = (n) => Math.round(n);

/** The window a task starts in, by the same rule as the audit (one millisecond of slack at both ends). */
export function windowOf(task, windows) {
  return windows.find((w) => task.start >= w.start - 1 && task.start <= w.end + 1) ?? null;
}

/** The scripts of every long-animation-frame entry that overlaps the task, as short plain records. */
export function scriptsOf(task, frames) {
  const end = task.start + task.dur;
  const out = [];
  for (const frame of frames) {
    if (!(frame.start < end && frame.start + frame.dur > task.start)) continue;
    for (const s of frame.scripts ?? []) {
      out.push({
        url: String(s.url ?? '').replace(/^https?:\/\/[^/]+/, ''),
        fn: s.fn ?? '',
        invoker: s.invoker ?? '',
        type: s.type ?? '',
        pos: s.pos ?? -1,
        ms: round(s.dur ?? 0),
        at: round((s.start ?? frame.start) - task.start),
      });
    }
  }
  return out;
}

/**
 * Every task of `limitMs` or more: its window, its offset from the window's start event (a window may carry `eventAt`:
 * the choosing of the file, the press of Restore; otherwise the window's own start), its duration, and the scripts of the
 * frames it ran in when the browser said (long-animation-frame). Empty when no task is long.
 */
export function diagnoseTasks({ tasks, windows, frames = [], limitMs = 50 }) {
  const out = [];
  for (const task of tasks) {
    if (task.dur < limitMs) continue;
    const w = windowOf(task, windows);
    const origin = w ? (w.eventAt ?? w.start) : null;
    out.push({
      window: w ? w.label : '(between flows)',
      kind: w ? (w.kind ?? 'flow') : 'none',
      startMs: round(task.start),
      offsetMs: origin === null ? null : round(task.start - origin),
      offsetFrom: w && w.eventAt !== undefined ? 'start event' : 'window start',
      durMs: round(task.dur),
      scripts: scriptsOf(task, frames),
    });
  }
  return out;
}

/** How long the pick flow took at each step, from the page's stamps (null where a stamp is missing). */
export function restoreTimes(stamps) {
  if (!stamps || !stamps.pickStart) return null;
  const between = (from, to) => (from && to && to >= from ? round(to - from) : null);
  return {
    chosenToWorkerReplyMs: between(stamps.pickStart, stamps.inspectedAt),
    chosenToDialogMs: between(stamps.pickStart, stamps.pickDone),
    pressedToReportMs: between(stamps.confirmStart, stamps.reportAt),
  };
}
