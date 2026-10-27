import type { Page } from '@playwright/test';

/** Fischer–Spassky, Reykjavik 1972, game 6: 41 moves (81 plies). */
export const FORTY_MOVE_PGN = `[Event "World Championship"]
[Site "Reykjavik ISL"]
[Date "1972.07.23"]
[White "Fischer, Robert James"]
[Black "Spassky, Boris V"]
[Result "1-0"]

1. c4 e6 2. Nf3 d5 3. d4 Nf6 4. Nc3 Be7 5. Bg5 O-O 6. e3 h6 7. Bh4 b6 8. cxd5
Nxd5 9. Bxe7 Qxe7 10. Nxd5 exd5 11. Rc1 Be6 12. Qa4 c5 13. Qa3 Rc8 14. Bb5 a6
15. dxc5 bxc5 16. O-O Ra7 17. Be2 Nd7 18. Nd4 Qf8 19. Nxe6 fxe6 20. e4 d4 21. f4
Qe7 22. e5 Rb8 23. Bc4 Kh8 24. Qh3 Nf8 25. b3 a5 26. f5 exf5 27. Rxf5 Nh7 28.
Rcf1 Qd8 29. Qg3 Re7 30. h4 Rbb7 31. e6 Rbc7 32. Qe5 Qe8 33. a4 Qd8 34. R1f2
Qe8 35. R2f3 Qd8 36. Bd3 Qe8 37. Qe4 Nf6 38. Rxf6 gxf6 39. Rxf6 Kg8 40. Bc4 Kh8
41. Qf4 1-0`;

export interface LayoutShiftSourceRecord {
  node: string;
  previousRect: { x: number; y: number; width: number; height: number };
  currentRect: { x: number; y: number; width: number; height: number };
}

export interface LayoutShiftRecord {
  value: number;
  hadRecentInput: boolean;
  startTime: number;
  sources: LayoutShiftSourceRecord[];
}

/**
 * Starts a PerformanceObserver('layout-shift') in the page. Every entry is kept,
 * including ones flagged `hadRecentInput` (keyboard navigation is input, but the
 * target is zero shift of any kind).
 */
export async function startLayoutShiftRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const describe = (node: Node | null): string => {
      if (!node) return '(detached)';
      if (!(node instanceof Element)) return node.nodeName.toLowerCase();
      const testId = node.getAttribute('data-testid');
      const cls =
        typeof node.className === 'string' && node.className ? `.${node.className.trim().split(/\s+/).join('.')}` : '';
      return `${node.tagName.toLowerCase()}${testId ? `[data-testid="${testId}"]` : ''}${cls}`;
    };
    const toRect = (r: DOMRectReadOnly) => ({
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
    interface LayoutShiftEntry extends PerformanceEntry {
      value: number;
      hadRecentInput: boolean;
      sources?: Array<{
        node: Node | null;
        previousRect: DOMRectReadOnly;
        currentRect: DOMRectReadOnly;
      }>;
    }
    const w = window as unknown as {
      __layoutShifts: unknown[];
      __layoutShiftObserver?: PerformanceObserver;
    };
    w.__layoutShifts = [];
    const observer = new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const entry = raw as LayoutShiftEntry;
        w.__layoutShifts.push({
          value: entry.value,
          hadRecentInput: entry.hadRecentInput,
          startTime: Math.round(entry.startTime),
          sources: (entry.sources ?? []).map((s) => ({
            node: describe(s.node),
            previousRect: toRect(s.previousRect),
            currentRect: toRect(s.currentRect),
          })),
        });
      }
    });
    observer.observe({ type: 'layout-shift', buffered: false });
    w.__layoutShiftObserver = observer;
  });
}

export async function stopLayoutShiftRecorder(page: Page): Promise<LayoutShiftRecord[]> {
  return page.evaluate(async () => {
    // Let the last frame's entries flush before disconnecting.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)));
    const w = window as unknown as {
      __layoutShifts: LayoutShiftRecord[];
      __layoutShiftObserver?: PerformanceObserver;
    };
    const pending = w.__layoutShiftObserver?.takeRecords() ?? [];
    w.__layoutShiftObserver?.disconnect();
    if (pending.length > 0) {
      // takeRecords() entries were not delivered to the callback; count them.
      for (const p of pending) {
        const e = p as PerformanceEntry & { value: number; hadRecentInput: boolean };
        w.__layoutShifts.push({
          value: e.value,
          hadRecentInput: e.hadRecentInput,
          startTime: Math.round(e.startTime),
          sources: [],
        });
      }
    }
    return w.__layoutShifts;
  });
}

/** Groups shift sources by element so a failure message names what moved. */
export function summarizeShiftSources(
  shifts: LayoutShiftRecord[],
): Array<{ node: string; count: number; example: LayoutShiftSourceRecord }> {
  const byNode = new Map<string, { node: string; count: number; example: LayoutShiftSourceRecord }>();
  for (const shift of shifts) {
    for (const source of shift.sources) {
      const existing = byNode.get(source.node);
      if (existing) {
        existing.count++;
      } else {
        byNode.set(source.node, { node: source.node, count: 1, example: source });
      }
    }
  }
  return [...byNode.values()].sort((a, b) => b.count - a.count);
}
