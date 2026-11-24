import { describe, expect, it } from 'vitest';
import { diagnoseTasks, restoreTimes, windowOf } from '../../scripts/lib/task-diagnostics.mjs';

const windows = [
  { label: 'pick', kind: 'hard', start: 1000, end: 1500, eventAt: 1010 },
  { label: 'play', start: 2000, end: 2600 },
];

describe('the diagnostics of the perf:tasks audit', () => {
  it('says nothing when no task is long', () => {
    expect(diagnoseTasks({ tasks: [{ start: 1100, dur: 49.9 }], windows, frames: [] })).toEqual([]);
  });

  it('measures a long task from the start event of its window, or from the window when it has none', () => {
    const out = diagnoseTasks({
      tasks: [
        { start: 1222, dur: 52.4 },
        { start: 2100, dur: 60 },
      ],
      windows,
    });
    expect(out.map((t) => [t.window, t.offsetMs, t.offsetFrom, t.durMs])).toEqual([
      ['pick', 212, 'start event', 52],
      ['play', 100, 'window start', 60],
    ]);
  });

  it('puts a task outside every window between flows', () => {
    const [t] = diagnoseTasks({ tasks: [{ start: 1700, dur: 200 }], windows });
    expect(t).toMatchObject({ window: '(between flows)', kind: 'none', offsetMs: null, durMs: 200 });
    expect(windowOf({ start: 1700, dur: 200 }, windows)).toBeNull();
  });

  it('names the scripts of the frames that overlap the task, and only those', () => {
    const frames = [
      {
        start: 1210,
        dur: 70,
        scripts: [
          {
            url: 'http://127.0.0.1:4183/assets/index-x.js',
            fn: 'handler',
            invoker: 'FileInput.onchange',
            type: 'event-listener',
            pos: 1234,
            dur: 41.6,
            start: 1215,
          },
        ],
      },
      { start: 1600, dur: 80, scripts: [{ url: 'http://x/other.js', dur: 5 }] },
    ];
    const [t] = diagnoseTasks({ tasks: [{ start: 1212, dur: 55 }], windows, frames });
    expect(t.scripts).toEqual([
      {
        url: '/assets/index-x.js',
        fn: 'handler',
        invoker: 'FileInput.onchange',
        type: 'event-listener',
        pos: 1234,
        ms: 42,
        at: 3,
      },
    ]);
  });

  it('reports the steps of the pick flow, with null for a stamp that is missing', () => {
    expect(
      restoreTimes({ pickStart: 100, inspectedAt: 160.4, pickDone: 178, confirmStart: 900, reportAt: 1500 }),
    ).toEqual({
      chosenToWorkerReplyMs: 60,
      chosenToDialogMs: 78,
      pressedToReportMs: 600,
    });
    expect(restoreTimes({ pickStart: 100 })).toEqual({
      chosenToWorkerReplyMs: null,
      chosenToDialogMs: null,
      pressedToReportMs: null,
    });
    expect(restoreTimes(null)).toBeNull();
    expect(restoreTimes({ pickStart: 0 })).toBeNull();
  });
});
