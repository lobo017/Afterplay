export interface PreviewRecord {
  commit: string;
  fingerprint: string;
  buildId: string;
  url: string;
  deployedAt: string;
}

export function listFiles(dir: string): string[];
export function fingerprintDir(dir: string): string;
export function buildIdOf(fingerprint: string): string;
export function deploymentUrlOf(
  outputFileText: string | null | undefined,
  consoleText: string | null | undefined,
): string | null;
export function productionRefusal(
  record: PreviewRecord | null,
  current: { commit: string; fingerprint: string },
  checked: string | null | undefined,
): string | null;
