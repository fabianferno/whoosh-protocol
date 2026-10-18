// Tiny IndexedDB wrapper: one database, a few key-value stores. Every function rejects if IndexedDB is
// unavailable (private mode, blocked storage); callers decide whether that matters.
const DB = 'whoosh';
const VERSION = 2;
const STORES = ['group', 'wallet', 'outbox'] as const;
export type StoreName = (typeof STORES)[number];

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, VERSION);
    request.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = fn(db.transaction(store, mode).objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export const idbGet = <T>(store: StoreName, key: string): Promise<T | undefined> =>
  run(store, 'readonly', (s) => s.get(key)) as Promise<T | undefined>;
export const idbPut = (store: StoreName, key: string, value: unknown): Promise<IDBValidKey> =>
  run(store, 'readwrite', (s) => s.put(value, key));
export const idbDelete = (store: StoreName, key: string): Promise<undefined> =>
  run(store, 'readwrite', (s) => s.delete(key));

export async function idbAll<T>(store: StoreName): Promise<{ key: string; value: T }[]> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const out: { key: string; value: T }[] = [];
      const request = db.transaction(store, 'readonly').objectStore(store).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(out);
        out.push({ key: String(cursor.key), value: cursor.value as T });
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
