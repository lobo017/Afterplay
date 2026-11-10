/**
 * Persistent storage. Without it a browser may clear a site's data when space runs low, and Safari clears the
 * script-written data (IndexedDB, Cache Storage, localStorage) of a website that has not been opened for seven days
 * of use. A Home Screen web app is exempt from that, and `navigator.storage.persist()` asks for the same protection
 * elsewhere (Chrome grants it to installed or often-used sites without a prompt; Safari decides by its own rules).
 */
export type PersistenceState = 'persistent' | 'best-effort' | 'unsupported';

export interface StorageManagerLike {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

function defaultStorage(): StorageManagerLike | undefined {
  return typeof navigator !== 'undefined' ? (navigator.storage as StorageManagerLike | undefined) : undefined;
}

/** Asks for persistent storage unless it is already granted. Never throws. */
export async function requestPersistentStorage(
  storage: StorageManagerLike | undefined = defaultStorage(),
): Promise<PersistenceState> {
  if (!storage || typeof storage.persist !== 'function') return 'unsupported';
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return 'persistent';
    return (await storage.persist()) ? 'persistent' : 'best-effort';
  } catch {
    return 'best-effort';
  }
}

export function describePersistence(state: PersistenceState, installed: boolean): string {
  switch (state) {
    case 'persistent':
      return 'Kept: the browser will not clear it on its own';
    case 'best-effort':
      return installed
        ? 'Best effort: the browser may clear it only if the device runs out of space'
        : 'Best effort: the browser may clear it (add the app to your Home Screen to keep it)';
    case 'unsupported':
      return 'This browser cannot promise to keep it: export a backup now and then';
  }
}
