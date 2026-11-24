export interface DiagTask {
  start: number;
  dur: number;
}
export interface DiagWindow {
  label: string;
  kind?: string;
  start: number;
  end: number;
  eventAt?: number;
}
export interface DiagFrameScript {
  url?: string;
  fn?: string;
  invoker?: string;
  type?: string;
  pos?: number;
  dur?: number;
  start?: number;
}
export interface DiagFrame {
  start: number;
  dur: number;
  scripts?: DiagFrameScript[];
}
export interface DiagScript {
  url: string;
  fn: string;
  invoker: string;
  type: string;
  pos: number;
  ms: number;
  at: number;
}
export interface LongTask {
  window: string;
  kind: string;
  startMs: number;
  offsetMs: number | null;
  offsetFrom: 'start event' | 'window start';
  durMs: number;
  scripts: DiagScript[];
}
export interface RestoreStamps {
  pickStart?: number;
  pickDone?: number;
  inspectedAt?: number;
  confirmStart?: number;
  reportAt?: number;
}
export function windowOf(task: DiagTask, windows: DiagWindow[]): DiagWindow | null;
export function scriptsOf(task: DiagTask, frames: DiagFrame[]): DiagScript[];
export function diagnoseTasks(input: {
  tasks: DiagTask[];
  windows: DiagWindow[];
  frames?: DiagFrame[];
  limitMs?: number;
}): LongTask[];
export function restoreTimes(
  stamps: RestoreStamps | null | undefined,
): { chosenToWorkerReplyMs: number | null; chosenToDialogMs: number | null; pressedToReportMs: number | null } | null;
