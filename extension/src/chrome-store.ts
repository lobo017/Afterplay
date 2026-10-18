import type { ExtRequest } from './messages';
import type { KeyValueStore } from './queue';

/** chrome.storage.local as the queue's KeyValueStore. */
export const chromeLocalStore: KeyValueStore = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};

/** Sends a message to the background service worker and returns its reply. */
export function sendToBackground<T>(message: ExtRequest): Promise<T> {
  return chrome.runtime.sendMessage<T>(message);
}
