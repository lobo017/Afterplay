/**
 * Lightweight, deterministic in-memory IndexedDB (IDBFactory / IDBDatabase / IDBTransaction /
 * IDBObjectStore / IDBIndex / IDBCursor / IDBRequest) implementation for Node.js unit tests
 * so `idb` v8 runs in Vitest with zero external dependencies.
 */

type Listener = (event: unknown) => void;

class SimpleEventTarget {
  private listeners = new Map<string, Set<Listener>>();

  public addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  public removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  public dispatchEvent(type: string, eventObj: Record<string, unknown> = {}): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of Array.from(set)) {
      fn({ type, target: this, ...eventObj });
    }
  }
}

export class FakeDOMStringList extends Array<string> {
  public contains(str: string): boolean {
    return this.includes(str);
  }

  public item(index: number): string | null {
    return this[index] ?? null;
  }
}

export class FakeIDBRequest<T = unknown> extends SimpleEventTarget {
  public result!: T;
  public error: Error | null = null;
  public transaction: FakeIDBTransaction | null = null;
  public readyState: 'pending' | 'done' = 'pending';

  public succeed(value: T): void {
    this.result = value;
    this.readyState = 'done';
    this.dispatchEvent('success', { target: this });
  }

  public fail(err: Error): void {
    this.error = err;
    this.readyState = 'done';
    this.dispatchEvent('error', { target: this });
  }
}

export class FakeIDBCursor extends SimpleEventTarget {
  public request = new FakeIDBRequest<FakeIDBCursor | null>();
  public key: unknown;
  public primaryKey: unknown;
  public value: unknown;

  public advance(_count: number): void {
    queueMicrotask(() => this.request.succeed(null));
  }

  public continue(_key?: unknown): void {
    queueMicrotask(() => this.request.succeed(null));
  }

  public continuePrimaryKey(_key: unknown, _primaryKey: unknown): void {
    queueMicrotask(() => this.request.succeed(null));
  }
}

interface IndexMeta {
  name: string;
  keyPath: string | string[];
  unique: boolean;
}

interface StoreData {
  name: string;
  keyPath: string | null;
  records: Map<unknown, unknown>;
  indexes: Map<string, IndexMeta>;
}

interface DatabaseRecord {
  name: string;
  version: number;
  stores: Map<string, StoreData>;
}

function extractKeyByPath(obj: unknown, keyPath: string | string[]): unknown {
  if (typeof obj !== 'object' || obj === null) return undefined;
  if (Array.isArray(keyPath)) {
    return keyPath.map((k) => (obj as Record<string, unknown>)[k]);
  }
  return (obj as Record<string, unknown>)[keyPath];
}

export class FakeIDBIndex {
  private storeData: StoreData;
  private meta: IndexMeta;
  private tx: FakeIDBTransaction;

  public constructor(
    storeData: StoreData,
    meta: IndexMeta,
    tx: FakeIDBTransaction,
  ) {
    this.storeData = storeData;
    this.meta = meta;
    this.tx = tx;
  }

  public get name(): string {
    return this.meta.name;
  }

  public get keyPath(): string | string[] {
    return this.meta.keyPath;
  }

  public get(query: unknown): FakeIDBRequest {
    return this.tx.scheduleRequest(() => {
      for (const val of this.storeData.records.values()) {
        if (extractKeyByPath(val, this.meta.keyPath) === query) {
          return structuredClone(val);
        }
      }
      return undefined;
    });
  }

  public getKey(query: unknown): FakeIDBRequest {
    return this.tx.scheduleRequest(() => {
      for (const [pk, val] of this.storeData.records.entries()) {
        if (extractKeyByPath(val, this.meta.keyPath) === query) {
          return pk;
        }
      }
      return undefined;
    });
  }

  public getAll(query?: unknown, count?: number): FakeIDBRequest {
    return this.tx.scheduleRequest(() => {
      const results: unknown[] = [];
      for (const val of this.storeData.records.values()) {
        if (
          query === undefined ||
          extractKeyByPath(val, this.meta.keyPath) === query
        ) {
          results.push(structuredClone(val));
          if (count !== undefined && results.length >= count) break;
        }
      }
      return results;
    });
  }

  public getAllKeys(query?: unknown, count?: number): FakeIDBRequest {
    return this.tx.scheduleRequest(() => {
      const keys: unknown[] = [];
      for (const [pk, val] of this.storeData.records.entries()) {
        if (
          query === undefined ||
          extractKeyByPath(val, this.meta.keyPath) === query
        ) {
          keys.push(pk);
          if (count !== undefined && keys.length >= count) break;
        }
      }
      return keys;
    });
  }

  public count(query?: unknown): FakeIDBRequest {
    return this.tx.scheduleRequest(() => {
      let c = 0;
      for (const val of this.storeData.records.values()) {
        if (
          query === undefined ||
          extractKeyByPath(val, this.meta.keyPath) === query
        ) {
          c++;
        }
      }
      return c;
    });
  }

  public openCursor(): FakeIDBRequest {
    return this.tx.scheduleRequest(() => null);
  }
}

export class FakeIDBObjectStore {
  private storeData: StoreData;
  private tx: FakeIDBTransaction;

  public constructor(storeData: StoreData, tx: FakeIDBTransaction) {
    this.storeData = storeData;
    this.tx = tx;
  }

  public get name(): string {
    return this.storeData.name;
  }

  public get keyPath(): string | null {
    return this.storeData.keyPath;
  }

  public get indexNames(): FakeDOMStringList {
    return new FakeDOMStringList(...Array.from(this.storeData.indexes.keys()));
  }

  public createIndex(
    name: string,
    keyPath: string | string[],
    options?: { unique?: boolean },
  ): FakeIDBIndex {
    const meta: IndexMeta = {
      name,
      keyPath,
      unique: Boolean(options?.unique),
    };
    this.storeData.indexes.set(name, meta);
    return new FakeIDBIndex(this.storeData, meta, this.tx);
  }

  public deleteIndex(name: string): void {
    this.storeData.indexes.delete(name);
  }

  public index(name: string): FakeIDBIndex {
    const meta = this.storeData.indexes.get(name);
    if (!meta) {
      throw new Error(`Index not found: ${name}`);
    }
    return new FakeIDBIndex(this.storeData, meta, this.tx);
  }

  public get(key: unknown): FakeIDBRequest {
    return this.tx.scheduleRequest(() => {
      const val = this.storeData.records.get(key);
      return val !== undefined ? structuredClone(val) : undefined;
    });
  }

  public getKey(key: unknown): FakeIDBRequest {
    return this.tx.scheduleRequest(() =>
      this.storeData.records.has(key) ? key : undefined,
    );
  }

  public getAll(query?: unknown, count?: number): FakeIDBRequest {
    return this.tx.scheduleRequest(() => {
      const out: unknown[] = [];
      for (const [k, v] of this.storeData.records.entries()) {
        if (query === undefined || k === query) {
          out.push(structuredClone(v));
          if (count !== undefined && out.length >= count) break;
        }
      }
      return out;
    });
  }

  public getAllKeys(query?: unknown, count?: number): FakeIDBRequest {
    return this.tx.scheduleRequest(() => {
      const out: unknown[] = [];
      for (const k of this.storeData.records.keys()) {
        if (query === undefined || k === query) {
          out.push(k);
          if (count !== undefined && out.length >= count) break;
        }
      }
      return out;
    });
  }

  public count(query?: unknown): FakeIDBRequest {
    return this.tx.scheduleRequest(() => {
      if (query === undefined) return this.storeData.records.size;
      return this.storeData.records.has(query) ? 1 : 0;
    });
  }

  public put(value: unknown, key?: unknown): FakeIDBRequest {
    return this.tx.scheduleRequest(() => {
      const resolvedKey =
        key ??
        (this.storeData.keyPath
          ? extractKeyByPath(value, this.storeData.keyPath)
          : undefined);
      if (resolvedKey === undefined) {
        throw new Error(`Missing key for object store ${this.storeData.name}`);
      }
      this.storeData.records.set(resolvedKey, structuredClone(value));
      return resolvedKey;
    });
  }

  public add(value: unknown, key?: unknown): FakeIDBRequest {
    return this.tx.scheduleRequest(() => {
      const resolvedKey =
        key ??
        (this.storeData.keyPath
          ? extractKeyByPath(value, this.storeData.keyPath)
          : undefined);
      if (resolvedKey === undefined) {
        throw new Error(`Missing key for object store ${this.storeData.name}`);
      }
      if (this.storeData.records.has(resolvedKey)) {
        throw new Error(`ConstraintError: key ${String(resolvedKey)} already exists`);
      }
      this.storeData.records.set(resolvedKey, structuredClone(value));
      return resolvedKey;
    });
  }

  public delete(key: unknown): FakeIDBRequest {
    return this.tx.scheduleRequest(() => {
      this.storeData.records.delete(key);
      return undefined;
    });
  }

  public clear(): FakeIDBRequest {
    return this.tx.scheduleRequest(() => {
      this.storeData.records.clear();
      return undefined;
    });
  }

  public openCursor(): FakeIDBRequest {
    return this.tx.scheduleRequest(() => null);
  }
}

export class FakeIDBTransaction extends SimpleEventTarget {
  public readonly objectStoreNames: FakeDOMStringList;
  public readonly mode: 'readonly' | 'readwrite' | 'versionchange';
  public error: Error | null = null;
  private dbRecord: DatabaseRecord;
  private pendingCount = 0;
  private completed = false;
  private autoCompleteEnabled: boolean;

  public constructor(
    dbRecord: DatabaseRecord,
    storeNames: string[],
    mode: 'readonly' | 'readwrite' | 'versionchange',
    autoComplete = true,
  ) {
    super();
    this.dbRecord = dbRecord;
    this.objectStoreNames = new FakeDOMStringList(...storeNames);
    this.mode = mode;
    this.autoCompleteEnabled = autoComplete;

    if (this.autoCompleteEnabled) {
      queueMicrotask(() => this.maybeComplete());
    }
  }

  public objectStore(name: string): FakeIDBObjectStore {
    const storeData = this.dbRecord.stores.get(name);
    if (!storeData) {
      throw new Error(`Object store not found: ${name}`);
    }
    return new FakeIDBObjectStore(storeData, this);
  }

  public scheduleRequest<T>(work: () => T): FakeIDBRequest<T> {
    const req = new FakeIDBRequest<T>();
    req.transaction = this;
    this.pendingCount++;

    queueMicrotask(() => {
      try {
        const res = work();
        req.succeed(res);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.error = error;
        req.fail(error);
        this.dispatchEvent('error', { error });
      } finally {
        this.pendingCount--;
        if (this.autoCompleteEnabled) {
          queueMicrotask(() => this.maybeComplete());
        }
      }
    });

    return req;
  }

  public waitForPendingRequests(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.pendingCount === 0) {
          resolve();
        } else {
          queueMicrotask(check);
        }
      };
      queueMicrotask(check);
    });
  }

  public finishManualTransaction(): void {
    this.autoCompleteEnabled = true;
    this.maybeComplete();
  }

  private maybeComplete(): void {
    if (this.completed || !this.autoCompleteEnabled) return;
    if (this.pendingCount > 0) return;
    this.completed = true;
    this.dispatchEvent('complete');
  }
}

export class FakeIDBDatabase extends SimpleEventTarget {
  private dbRecord: DatabaseRecord;
  public activeVersionChangeTx: FakeIDBTransaction | null = null;

  public constructor(dbRecord: DatabaseRecord) {
    super();
    this.dbRecord = dbRecord;
  }

  public get name(): string {
    return this.dbRecord.name;
  }

  public get version(): number {
    return this.dbRecord.version;
  }

  public get objectStoreNames(): FakeDOMStringList {
    return new FakeDOMStringList(...Array.from(this.dbRecord.stores.keys()));
  }

  public createObjectStore(
    name: string,
    options?: { keyPath?: string | null },
  ): FakeIDBObjectStore {
    if (this.dbRecord.stores.has(name)) {
      throw new Error(`Object store ${name} already exists`);
    }
    const storeData: StoreData = {
      name,
      keyPath: options?.keyPath ?? null,
      records: new Map(),
      indexes: new Map(),
    };
    this.dbRecord.stores.set(name, storeData);
    const tx =
      this.activeVersionChangeTx ??
      new FakeIDBTransaction(this.dbRecord, [name], 'versionchange', false);
    if (!tx.objectStoreNames.contains(name)) {
      tx.objectStoreNames.push(name);
    }
    return new FakeIDBObjectStore(storeData, tx);
  }

  public deleteObjectStore(name: string): void {
    this.dbRecord.stores.delete(name);
  }

  public transaction(
    storeNames: string | string[],
    mode: 'readonly' | 'readwrite' = 'readonly',
  ): FakeIDBTransaction {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return new FakeIDBTransaction(this.dbRecord, names, mode, true);
  }

  public close(): void {
    this.dispatchEvent('close');
  }
}

const databases = new Map<string, DatabaseRecord>();

export const fakeIndexedDB = {
  open(name: string, version?: number): FakeIDBRequest<FakeIDBDatabase> {
    const req = new FakeIDBRequest<FakeIDBDatabase>();

    queueMicrotask(async () => {
      try {
        let record = databases.get(name);
        const oldVersion = record ? record.version : 0;
        const targetVersion = version ?? (oldVersion > 0 ? oldVersion : 1);

        if (targetVersion < oldVersion) {
          throw new Error(
            `VersionError: requested version (${targetVersion}) is lower than existing version (${oldVersion})`,
          );
        }

        if (!record) {
          record = {
            name,
            version: targetVersion,
            stores: new Map(),
          };
          databases.set(name, record);
        } else {
          record.version = targetVersion;
        }

        const dbInstance = new FakeIDBDatabase(record);

        if (targetVersion > oldVersion) {
          const upgradeTx = new FakeIDBTransaction(
            record,
            Array.from(record.stores.keys()),
            'versionchange',
            false,
          );
          dbInstance.activeVersionChangeTx = upgradeTx;
          req.result = dbInstance;
          req.transaction = upgradeTx;

          req.dispatchEvent('upgradeneeded', {
            oldVersion,
            newVersion: targetVersion,
            target: req,
          });

          // Wait for any async work queued on upgradeTx during upgradeneeded
          await upgradeTx.waitForPendingRequests();
          await new Promise<void>((r) => queueMicrotask(r));
          await upgradeTx.waitForPendingRequests();

          upgradeTx.finishManualTransaction();
          dbInstance.activeVersionChangeTx = null;
          req.transaction = null;
        }

        req.succeed(dbInstance);
      } catch (err) {
        req.fail(err instanceof Error ? err : new Error(String(err)));
      }
    });

    return req;
  },

  deleteDatabase(name: string): FakeIDBRequest<undefined> {
    const req = new FakeIDBRequest<undefined>();
    queueMicrotask(() => {
      databases.delete(name);
      req.succeed(undefined);
    });
    return req;
  },
};

/**
 * Install the in-memory IndexedDB globals onto `globalThis` if running in Node without native IndexedDB.
 */
export function installIndexedDBPolyfill(): void {
  const g = globalThis as Record<string, unknown>;
  if (!g.indexedDB) {
    g.indexedDB = fakeIndexedDB;
    g.IDBRequest = FakeIDBRequest;
    g.IDBDatabase = FakeIDBDatabase;
    g.IDBTransaction = FakeIDBTransaction;
    g.IDBObjectStore = FakeIDBObjectStore;
    g.IDBIndex = FakeIDBIndex;
    g.IDBCursor = FakeIDBCursor;
  }
}
