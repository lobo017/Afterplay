/// <reference lib="webworker" />
import puzzles from '../../data/puzzles.json';
import type { PuzzleEntry } from '../core/datasets';
import { PuzzleDataset } from './puzzle-dataset';
import type { DatasetRequestMessage, DatasetResponseMessage } from './puzzle-dataset-client';

/**
 * The bundled Lichess puzzles live only here: this worker's chunk carries data/puzzles.json,
 * so the main bundle never does, and the 20,000 puzzles are parsed and searched off the main
 * thread. It answers with one puzzle at a time.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;
const dataset = new PuzzleDataset(puzzles as PuzzleEntry[]);

scope.addEventListener('message', (e: MessageEvent<DatasetRequestMessage>) => {
  const msg = e.data;
  let response: DatasetResponseMessage;
  try {
    switch (msg.kind) {
      case 'info':
        response = { id: msg.id, kind: 'info', size: dataset.size, themes: dataset.themes() };
        break;
      case 'pick':
        response = {
          id: msg.id,
          kind: 'puzzle',
          puzzle: dataset.pick({ theme: msg.theme, targetRating: msg.targetRating, exclude: msg.exclude }) ?? null,
        };
        break;
      case 'get':
        response = { id: msg.id, kind: 'puzzle', puzzle: dataset.get(msg.puzzleId) ?? null };
        break;
    }
  } catch (err) {
    response = { id: msg.id, kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  scope.postMessage(response);
});
