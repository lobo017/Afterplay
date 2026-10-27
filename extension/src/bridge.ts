import type { MessageWindow } from '../../src/capture/protocol';
import { ExtensionBridge } from './bridge-core';
import { sendToBackground } from './chrome-store';
import type { BridgeBatchReply, BridgeHelloReply, TabRequest } from './messages';

// Content script registered only on the configured site URL (background.ts): relays
// between the site's page and the extension's queue.
const bridge = new ExtensionBridge(window as unknown as MessageWindow, {
  hello: () => sendToBackground<BridgeHelloReply>({ kind: 'bridge-hello' }),
  takeBatch: (max, exclude) => sendToBackground<BridgeBatchReply>({ kind: 'bridge-batch', max, exclude: [...exclude] }),
  markDelivered: async (keys) =>
    (await sendToBackground<{ delivered: number }>({ kind: 'bridge-delivered', keys: [...keys] })).delivered,
  markRejected: async (items) =>
    (await sendToBackground<{ rejected: number }>({ kind: 'bridge-rejected', items: items.map((i) => ({ ...i })) }))
      .rejected,
});
bridge.start();

// The background says games are ready (captured just now): sync without waiting for focus
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if ((message as TabRequest | null)?.kind === 'bridge-nudge') bridge.nudge();
});
