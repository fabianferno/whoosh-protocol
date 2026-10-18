import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { idbDelete, idbGet, idbPut } from '../storage/idb.ts';

export interface BurnerWallet {
  privateKey: `0x${string}`;
  address: `0x${string}`;
  /** False if IndexedDB refused the write: the wallet works but is lost when the app closes. */
  persisted: boolean;
}

const KEY = 'burner';

/**
 * The gateway's wallet: a random key that never leaves the device, funded from the Tiramisu faucet.
 * Every gateway write is linked to this address.
 */
export async function loadOrCreateWallet(): Promise<BurnerWallet> {
  try {
    const stored = await idbGet<`0x${string}`>('wallet', KEY);
    if (stored) return { privateKey: stored, address: privateKeyToAccount(stored).address, persisted: true };
  } catch {
    /* fall through and make a session-only wallet */
  }
  const privateKey = generatePrivateKey();
  let persisted = true;
  try {
    await idbPut('wallet', KEY, privateKey);
  } catch {
    persisted = false;
  }
  return { privateKey, address: privateKeyToAccount(privateKey).address, persisted };
}

export async function forgetWallet(): Promise<void> {
  try {
    await idbDelete('wallet', KEY);
  } catch {
    /* nothing to forget */
  }
}
