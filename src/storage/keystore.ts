import type { GroupKeys } from '../packet/keys.ts';
import { idbDelete, idbGet, idbPut } from './idb.ts';

// Non-extractable CryptoKeys are stored as-is (structured clone), so the key bytes never reach JavaScript.
const KEY = 'keys';

/** Null when nothing is stored or IndexedDB is unavailable. */
export async function loadKeys(): Promise<GroupKeys | null> {
  try {
    const value = await idbGet<GroupKeys>('group', KEY);
    return value?.enc && value?.tag ? value : null;
  } catch {
    return null;
  }
}

/** Resolves false if the keys could not be stored; they still work for this session. */
export async function saveKeys(keys: GroupKeys): Promise<boolean> {
  try {
    await idbPut('group', KEY, { enc: keys.enc, tag: keys.tag });
    return true;
  } catch {
    return false;
  }
}

export async function clearKeys(): Promise<void> {
  try {
    await idbDelete('group', KEY);
  } catch {
    /* nothing to clear */
  }
}
