/// <reference lib="webworker" />
import { EndgameTables } from './endgame-tables';
import type { TablesRequestMessage, TablesResponseMessage } from './endgame-tables-client';

/**
 * Solves K+Q v K, K+R v K and K+P v K (about a second and a half) off the main thread and answers
 * with the exact defence. Tables are built the first time a kind is needed and kept.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;
const tables = new EndgameTables();

scope.addEventListener('message', (e: MessageEvent<TablesRequestMessage>) => {
  const msg = e.data;
  let response: TablesResponseMessage;
  try {
    if (msg.kind === 'warm') {
      tables.ensure('p');
      response = { id: msg.id, kind: 'warm' };
    } else {
      response = { id: msg.id, kind: 'defence', defence: tables.defend(msg.fen) };
    }
  } catch (err) {
    response = { id: msg.id, kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  scope.postMessage(response);
});
