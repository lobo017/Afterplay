// Single-threaded Stockfish 17.1 lite in a Node child process, as an EngineTransport
// for src/engine/engine-client.ts. Used by the dev-time review scripts.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stockfishJsPath = path.join(rootDir, 'node_modules/stockfish/src/stockfish-17.1-lite-single-03e3232.js');

export function createNodeStockfishTransport() {
  const proc = spawn(process.execPath, [stockfishJsPath], { stdio: 'pipe', windowsHide: true });
  const messageHandlers = [];
  const errorHandlers = [];
  let stdoutBuffer = '';
  const flushLines = (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    let newlineIdx = stdoutBuffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = stdoutBuffer.slice(0, newlineIdx).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      if (line) for (const h of messageHandlers) h(line);
      newlineIdx = stdoutBuffer.indexOf('\n');
    }
  };
  proc.stdout.on('data', flushLines);
  proc.stderr.on('data', flushLines);
  proc.on('error', (err) => {
    for (const h of errorHandlers) h(err);
  });
  return {
    send: (command) => proc.stdin.write(`${command}\n`),
    onMessage: (handler) => messageHandlers.push(handler),
    onError: (handler) => errorHandlers.push(handler),
    terminate: () => proc.kill(),
  };
}
