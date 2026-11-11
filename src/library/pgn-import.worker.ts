/// <reference lib="webworker" />
import { checkSingleGame, readPgnBatches } from './pgn-import-core';
import type { PgnImportRequest, PgnImportResponse } from './pgn-import-client';

/**
 * Reads a bulk PGN import: the parsing, move checking and opening lookup of every game happen
 * here, so a thousand games never become one long task on the page. Batches go back as they
 * are ready, and the page stores them. A single game (the Chess.com sync sends its new games one
 * by one) is checked the same way and answered with its record.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener('message', (e: MessageEvent<PgnImportRequest>) => {
  const msg = e.data;
  try {
    if (msg.kind === 'single') {
      const result = checkSingleGame(msg.pgn, msg.method);
      scope.postMessage({ id: msg.id, kind: 'single', result } satisfies PgnImportResponse);
      return;
    }
    const known = new Set(msg.known);
    for (const batch of readPgnBatches(msg.text, known)) {
      const response: PgnImportResponse = { id: msg.id, kind: 'batch', batch };
      scope.postMessage(response);
    }
    scope.postMessage({ id: msg.id, kind: 'done' } satisfies PgnImportResponse);
  } catch (err) {
    scope.postMessage({
      id: msg.id,
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies PgnImportResponse);
  }
});
