/**
 * The chrome.* extension APIs this extension calls, typed by hand (the promise forms of
 * Manifest V3). Only what is used is declared.
 */
declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      id?: string;
      url?: string;
      origin?: string;
      tab?: tabs.Tab;
      frameId?: number;
    }
    interface Manifest {
      version: string;
      name: string;
    }
    interface InstalledDetails {
      reason: 'install' | 'update' | 'chrome_update' | 'shared_module_update';
    }
    /** Undefined in a content script whose extension was reloaded or removed. */
    const id: string | undefined;
    const lastError: { message?: string } | undefined;
    function getManifest(): Manifest;
    function getURL(path: string): string;
    function sendMessage<T = unknown>(message: unknown): Promise<T>;
    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
    };
    const onInstalled: { addListener(callback: (details: InstalledDetails) => void): void };
    const onStartup: { addListener(callback: () => void): void };
  }

  namespace storage {
    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      getBytesInUse?(keys?: string | string[] | null): Promise<number>;
    }
    const local: StorageArea;
    /** Kept in memory until the browser closes (survives the service worker stopping). */
    const session: StorageArea;
    const onChanged: {
      addListener(callback: (changes: Record<string, StorageChange>, areaName: string) => void): void;
    };
  }

  namespace action {
    function setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
    function getBadgeText(details: { tabId?: number }): Promise<string>;
    function setBadgeBackgroundColor(details: { color: string }): Promise<void>;
    function setTitle(details: { title: string }): Promise<void>;
    function openPopup(options?: { windowId?: number }): Promise<void>;
  }

  namespace contextMenus {
    interface OnClickData {
      menuItemId: string | number;
      linkUrl?: string;
      pageUrl?: string;
    }
    function create(properties: {
      id: string;
      title: string;
      contexts: Array<'link' | 'page' | 'all'>;
      targetUrlPatterns?: string[];
      documentUrlPatterns?: string[];
    }): void;
    function removeAll(): Promise<void>;
    const onClicked: { addListener(callback: (info: OnClickData, tab?: tabs.Tab) => void): void };
  }

  namespace notifications {
    function create(
      id: string,
      options: { type: 'basic'; iconUrl: string; title: string; message: string; priority?: number },
    ): Promise<string>;
    function clear(id: string): Promise<boolean>;
    const onClicked: { addListener(callback: (notificationId: string) => void): void };
  }

  namespace alarms {
    interface Alarm {
      name: string;
      scheduledTime: number;
      periodInMinutes?: number;
    }
    function create(
      name: string,
      info: { when?: number; delayInMinutes?: number; periodInMinutes?: number },
    ): Promise<void>;
    function get(name: string): Promise<Alarm | undefined>;
    function clear(name: string): Promise<boolean>;
    const onAlarm: { addListener(callback: (alarm: Alarm) => void): void };
  }

  namespace scripting {
    interface RegisteredContentScript {
      id: string;
      matches?: string[];
      js?: string[];
      runAt?: 'document_start' | 'document_end' | 'document_idle';
      allFrames?: boolean;
      persistAcrossSessions?: boolean;
    }
    function registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
    function updateContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
    function unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
    function getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<RegisteredContentScript[]>;
    function executeScript(injection: {
      target: { tabId: number; allFrames?: boolean };
      files: string[];
    }): Promise<unknown[]>;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      /** Only for pages the extension has host permissions for. */
      url?: string;
      windowId?: number;
      active?: boolean;
      status?: 'loading' | 'complete' | 'unloaded';
    }
    interface TabChangeInfo {
      url?: string;
      status?: 'loading' | 'complete' | 'unloaded';
    }
    function create(properties: { url: string; active?: boolean }): Promise<Tab>;
    function query(query: { url?: string | string[]; active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function update(tabId: number, properties: { active?: boolean }): Promise<Tab | undefined>;
    function sendMessage<T = unknown>(tabId: number, message: unknown): Promise<T>;
    const onUpdated: { addListener(callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void): void };
    const onRemoved: {
      addListener(callback: (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void): void;
    };
  }

  namespace windows {
    function update(windowId: number, properties: { focused?: boolean }): Promise<unknown>;
  }
}
