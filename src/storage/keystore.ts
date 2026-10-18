import type { GroupKeys } from '../packet/keys.ts';

// Non-extractable CryptoKeys are stored as-is (structured clone), so the key bytes never reach JavaScript.
const DB = 'whoosh';
const STORE = 'group';
const KEY = 'keys';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = fn(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Null when nothing is stored or IndexedDB is unavailable (private mode, blocked storage). */
export async function loadKeys(): Promise<GroupKeys | null> {
  try {
    const value = (await run('readonly', (s) => s.get(KEY))) as GroupKeys | undefined;
    return value?.enc && value?.tag ? value : null;
  } catch {
    return null;
  }
}

/** Resolves false if the keys could not be stored; they still work for this session. */
export async function saveKeys(keys: GroupKeys): Promise<boolean> {
  try {
    await run('readwrite', (s) => s.put({ enc: keys.enc, tag: keys.tag }, KEY));
    return true;
  } catch {
    return false;
  }
}

export async function clearKeys(): Promise<void> {
  try {
    await run('readwrite', (s) => s.delete(KEY));
  } catch {
    /* nothing to clear */
  }
}
