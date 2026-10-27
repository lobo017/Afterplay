/// <reference lib="webworker" />
import { analyzeMove } from './review-game';
import type { ReviewAnalysisRequestMessage, ReviewAnalysisResponseMessage } from './review-analysis-client';

/** Review worker: classifies, explains and scores one move per message. */
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener('message', (e: MessageEvent<ReviewAnalysisRequestMessage>) => {
  const { id, input } = e.data;
  let response: ReviewAnalysisResponseMessage;
  try {
    response = { id, kind: 'ok', result: analyzeMove(input) };
  } catch (err) {
    response = { id, kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  scope.postMessage(response);
});
