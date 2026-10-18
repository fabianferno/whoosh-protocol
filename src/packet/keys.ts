import { WORDS } from '../message/dictionary.ts';

export interface GroupKeys {
  /** AES-256-GCM key. */
  enc: CryptoKey;
  /** HMAC-SHA-256 key for the channel tag. */
  tag: CryptoKey;
}

export const PBKDF2_ITERATIONS = 600_000;
export const PASSPHRASE_WORDS = 6;

const APP_SALT = new TextEncoder().encode('whoosh-protocol/v1/group-key');
const utf8 = (s: string) => new TextEncoder().encode(s);

/** Case, surrounding space, and repeated spaces never change which group a passphrase names. */
export function normalizePassphrase(passphrase: string): string {
  return passphrase.normalize('NFKC').trim().toLowerCase().split(/\s+/).join(' ');
}

/** Six random dictionary words (66 bits). Uniform: 2048 divides 65536, so there is no modulo bias. */
export function generatePassphrase(count = PASSPHRASE_WORDS): string {
  const draw = crypto.getRandomValues(new Uint16Array(count));
  return Array.from(draw, (n) => WORDS[n % WORDS.length]).join(' ');
}

/**
 * passphrase -> PBKDF2-SHA256 -> root -> HKDF -> `enc` (AES-GCM) and `tag` (HMAC).
 * Both keys are non-extractable. `iterations` exists so tests can run quickly.
 */
export async function deriveGroupKeys(passphrase: string, iterations = PBKDF2_ITERATIONS): Promise<GroupKeys> {
  const normalized = normalizePassphrase(passphrase);
  if (normalized === '') throw new Error('Passphrase is empty');
  const base = await crypto.subtle.importKey('raw', utf8(normalized), 'PBKDF2', false, ['deriveBits']);
  const root = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: APP_SALT, iterations }, base, 256);
  const hkdf = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveKey']);
  const derive = (info: string, algorithm: AesKeyGenParams | HmacKeyGenParams, usages: KeyUsage[]) =>
    crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: utf8(info) }, hkdf, algorithm, false, usages);
  const [enc, tag] = await Promise.all([
    derive('whoosh enc', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    derive('whoosh tag', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
  ]);
  return { enc, tag };
}
