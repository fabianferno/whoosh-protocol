import { WORDS } from '../message/dictionary.ts';

export interface GroupKeys {
  /** AES-256-GCM key. */
  enc: CryptoKey;
  /** HMAC-SHA-256 key for the channel tag. */
  tag: CryptoKey;
}

export const PBKDF2_ITERATIONS = 600_000;
/** Fewest distinct dictionary words accepted (11 bits each, so 66 bits). */
export const MIN_WORDS = 6;
export const PASSPHRASE_WORDS = MIN_WORDS;
const BITS_PER_WORD = 11;

export class PassphraseError extends Error {
  constructor(readonly code: 'empty' | 'weak', message: string) {
    super(message);
  }
}

const APP_SALT = new TextEncoder().encode('whoosh-protocol/v1/group-key');
const utf8 = (s: string) => new TextEncoder().encode(s);

/** Case, surrounding space, and repeated spaces never change which group a passphrase names. */
export function normalizePassphrase(passphrase: string): string {
  return passphrase.normalize('NFKC').trim().toLowerCase().split(/\s+/).join(' ');
}

const WORD_SET = new Set(WORDS);
const RAW_KEY = /^[0-9a-f]{64}$/;

type Secret = { kind: 'words'; text: string; bits: number } | { kind: 'raw'; bytes: Uint8Array<ArrayBuffer> };

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
}

/**
 * Only two secrets are accepted, so strength is guaranteed instead of estimated: at least six distinct
 * words from the dictionary, or a 256-bit key as 64 hex characters. Anything else (a chosen word, a short
 * phrase, a long run of one character) is null.
 */
function classify(secret: string): Secret | null {
  const text = normalizePassphrase(secret);
  if (RAW_KEY.test(text)) {
    const bytes = hexToBytes(text);
    return new Set(bytes).size >= 16 ? { kind: 'raw', bytes } : null;
  }
  const words = text.split(' ');
  if (words.length < MIN_WORDS || new Set(words).size !== words.length || !words.every((w) => WORD_SET.has(w))) return null;
  return { kind: 'words', text, bits: words.length * BITS_PER_WORD };
}

/** Bits of entropy in an acceptable secret, 0 for one that would be rejected. */
export function passphraseBits(secret: string): number {
  const s = classify(secret);
  return s === null ? 0 : s.kind === 'raw' ? 256 : s.bits;
}

/** Random distinct dictionary words (66 bits for six). Uniform: 2048 divides 65536, so no modulo bias. */
export function generatePassphrase(count = PASSPHRASE_WORDS): string {
  if (count < MIN_WORDS) throw new Error(`A passphrase needs at least ${MIN_WORDS} words`);
  const picked = new Set<string>();
  while (picked.size < count) picked.add(WORDS[crypto.getRandomValues(new Uint16Array(1))[0] % WORDS.length]);
  return [...picked].join(' ');
}

/** A random 256-bit key as 64 hex characters, for sharing as a QR code. */
export function generateGroupKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * words -> PBKDF2-SHA256 -> root, or a raw 256-bit key -> root; then HKDF -> `enc` (AES-GCM) and `tag` (HMAC).
 * Both keys are non-extractable. `iterations` exists so tests can run quickly. Throws PassphraseError.
 */
export async function deriveGroupKeys(passphrase: string, iterations = PBKDF2_ITERATIONS): Promise<GroupKeys> {
  if (normalizePassphrase(passphrase) === '') throw new PassphraseError('empty', 'Passphrase is empty');
  const secret = classify(passphrase);
  if (!secret) {
    throw new PassphraseError('weak', `Use a generated passphrase of at least ${MIN_WORDS} dictionary words, or a 256-bit key.`);
  }
  let root: BufferSource;
  if (secret.kind === 'raw') {
    root = secret.bytes;
  } else {
    const base = await crypto.subtle.importKey('raw', utf8(secret.text), 'PBKDF2', false, ['deriveBits']);
    root = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: APP_SALT, iterations }, base, 256);
  }
  const hkdf = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveKey']);
  const derive = (info: string, algorithm: AesKeyGenParams | HmacKeyGenParams, usages: KeyUsage[]) =>
    crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: utf8(info) }, hkdf, algorithm, false, usages);
  const [enc, tag] = await Promise.all([
    derive('whoosh enc', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    derive('whoosh tag', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
  ]);
  return { enc, tag };
}
