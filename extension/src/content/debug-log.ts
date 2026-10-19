import type { DebugEvent } from '../messages';

/** The detection events of one page, newest last, for "Debug this tab". */
export class DebugLog {
  public static readonly MAX_EVENTS = 30;
  private readonly events: DebugEvent[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  public add(text: string): void {
    this.events.push({ at: this.now(), text });
    if (this.events.length > DebugLog.MAX_EVENTS) this.events.splice(0, this.events.length - DebugLog.MAX_EVENTS);
  }

  public list(): DebugEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  public last(): DebugEvent | null {
    const e = this.events[this.events.length - 1];
    return e ? { ...e } : null;
  }
}
