// Types for process-guard.mjs, so TypeScript callers (tests/e2e/global-setup.ts) can use it.

export interface GuardProcess {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
}

export function listProcesses(): GuardProcess[];
export function findLeftoverTestProcesses(options?: { ports?: number[] }): GuardProcess[];
export function findOtherRepoServers(options?: { ports?: number[] }): GuardProcess[];
export function formatProcesses(procs: GuardProcess[]): string;
export function killCommandHint(procs: GuardProcess[]): string;
export function killProcessTree(pid: number): void;
export function killAllChildTrees(): GuardProcess[];
export function isProcessAlive(pid: number): boolean;
export function freeMemoryBytes(): number;
export function formatGb(bytes: number): string;
export function installCleanup(options: {
  cleanup: (reason: string) => void;
  log?: (message: string) => void;
  parentWatchMs?: number;
  maxRunMs?: number;
  handleSignalsAndErrors?: boolean;
}): { runCleanup: (reason: string) => void };
export function exitWithParent(pid: number, intervalMs?: number): void;
