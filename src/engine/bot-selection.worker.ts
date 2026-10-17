/// <reference lib="webworker" />
import { selectHumanLikeMove } from './bot';
import type {
  BotSelectionRequestMessage,
  BotSelectionResponseMessage,
} from './bot-selection-client';

/**
 * Bot move selection worker: runs selectHumanLikeMove() with the random values the main
 * thread pre-drew for it, and reports how many it used.
 */
class RandomBufferExhausted extends Error {}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener('message', (e: MessageEvent<BotSelectionRequestMessage>) => {
  const { id, request, randoms } = e.data;
  let used = 0;
  const rng = () => {
    if (used >= randoms.length) throw new RandomBufferExhausted();
    return randoms[used++]!;
  };

  let response: BotSelectionResponseMessage;
  try {
    const decision = selectHumanLikeMove({ ...request, rng });
    response = { id, kind: 'ok', decision, consumed: used };
  } catch (err) {
    response =
      err instanceof RandomBufferExhausted
        ? { id, kind: 'more' }
        : { id, kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  scope.postMessage(response);
});
