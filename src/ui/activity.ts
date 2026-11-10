/**
 * What the user is in the middle of. Screens register a check ("a game is under way", "a drill is running"), and the update
 * flow asks before it reloads the page: a new build is applied by itself only when nothing is in progress.
 */

const sources = new Map<string, () => boolean>();

/** Registers a named check; returns a function that removes it. A later registration under the same name replaces it. */
export function registerActivity(name: string, inProgress: () => boolean): () => void {
  sources.set(name, inProgress);
  return () => {
    if (sources.get(name) === inProgress) sources.delete(name);
  };
}

/** The names of everything in progress now (empty when the page could be reloaded without losing anything). */
export function activitiesInProgress(): string[] {
  const busy: string[] = [];
  for (const [name, check] of sources) {
    try {
      if (check()) busy.push(name);
    } catch {
      // A check that fails counts as busy: never reload on a guess
      busy.push(name);
    }
  }
  return busy;
}
