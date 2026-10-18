import { acceptedChannelTags, channelTag, dayOf } from './channel.ts';
import {
  aadOf, DEFAULT_TTL, FLAG_RELAYABLE, HEADER_BYTES, MAX_PLAINTEXT_BYTES, MAX_TTL, MIN_PACKET_BYTES, nonceOf,
  packHeader, PacketType, parseHeader, TAG_BYTES, type Header, type PacketTypeValue,
} from './format.ts';
import type { GroupKeys } from './keys.ts';
import type { SenderIdentity } from './session.ts';

export interface SealParams {
  type: PacketTypeValue;
  sender: number;
  seq: number;
  /** Unix seconds. */
  ts: number;
  ttl?: number;
  flags?: number;
  fragIndex?: number;
  fragCount?: number;
}

/** Nonces already used for sealing, per key, for this session. Reusing one under AES-GCM is catastrophic. */
const used = new WeakMap<CryptoKey, Set<string>>();

function claimNonce(key: CryptoKey, nonce: Uint8Array): void {
  const id = Array.from(nonce, (b) => b.toString(16).padStart(2, '0')).join('');
  let seen = used.get(key);
  if (!seen) used.set(key, (seen = new Set()));
  if (seen.has(id)) throw new Error('Refusing to reuse a nonce: take a new seq from SenderIdentity');
  seen.add(id);
}

export interface Opened {
  header: Header;
  plaintext: Uint8Array;
}

/**
 * header (15) | AES-256-GCM ciphertext | tag (12). The header is the associated data (ttl zeroed) and
 * supplies the nonce.
 *
 * The nonce includes the fragment byte, so fragments of one message may share sender, seq and ts. Sealing
 * twice with the same nonce under one key throws.
 */
export async function seal(keys: GroupKeys, p: SealParams, plaintext: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error(`Message is ${plaintext.length} bytes; the limit is ${MAX_PLAINTEXT_BYTES}`);
  const fragCount = p.fragCount ?? 1;
  const fragIndex = p.fragIndex ?? 0;
  if (fragCount < 1 || fragCount > 16 || fragIndex >= fragCount) throw new Error('Bad fragment numbering');
  const ttl = p.ttl ?? DEFAULT_TTL;
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > MAX_TTL) throw new Error('ttl must be 0 to 7');

  const header = packHeader({
    type: p.type, ttl, flags: p.flags ?? FLAG_RELAYABLE, chan: await channelTag(keys, dayOf(p.ts)),
    sender: p.sender, seq: p.seq, fragIndex, fragCount, ts: p.ts,
  });
  const nonce = nonceOf(header);
  claimNonce(keys.enc, nonce);
  const body = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aadOf(header), tagLength: TAG_BYTES * 8 }, keys.enc, plaintext),
  );
  const packet = new Uint8Array(HEADER_BYTES + body.length);
  packet.set(header);
  packet.set(body, HEADER_BYTES);
  return packet;
}

/** Decrypts and authenticates. Null for anything that is not a valid packet for this key; never throws. */
export async function open(keys: GroupKeys, packet: Uint8Array): Promise<Opened | null> {
  if (packet.length < MIN_PACKET_BYTES) return null;
  const header = parseHeader(packet);
  if (!header) return null;
  try {
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonceOf(packet), additionalData: aadOf(packet), tagLength: TAG_BYTES * 8 },
        keys.enc,
        packet.slice(HEADER_BYTES),
      ),
    );
    return { header, plaintext };
  } catch {
    return null;
  }
}

/** Reads the header without decrypting, for dedup and cheap channel filtering. Not authenticated. */
export function peek(packet: Uint8Array): Header | null {
  return packet.length < MIN_PACKET_BYTES ? null : parseHeader(packet);
}

/** True if the packet's channel tag is one of this group's tags for around `nowSeconds`. */
export async function isForChannel(keys: GroupKeys, packet: Uint8Array, nowSeconds: number): Promise<boolean> {
  const header = peek(packet);
  return header !== null && (await acceptedChannelTags(keys, nowSeconds)).has(header.chan);
}

/** A copy of `packet` with the live ttl replaced; it still authenticates. Relays pass ttl - 1. */
export function withTtl(packet: Uint8Array, ttl: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > MAX_TTL) throw new Error('ttl must be 0 to 7');
  const out = new Uint8Array(packet);
  out[1] = (ttl << 5) | (out[1] & 0x1f);
  return out;
}

export function sealText(keys: GroupKeys, identity: SenderIdentity, text: string, nowSeconds: number, ttl = DEFAULT_TTL) {
  const { sender, seq } = identity.next();
  return seal(keys, { type: PacketType.MSG, sender, seq, ts: nowSeconds, ttl }, new TextEncoder().encode(text));
}

/** The message text, or null if the packet is not an authentic MSG for this key. */
export async function openText(keys: GroupKeys, packet: Uint8Array): Promise<{ header: Header; text: string } | null> {
  const opened = await open(keys, packet);
  if (!opened || opened.header.type !== PacketType.MSG) return null;
  return { header: opened.header, text: new TextDecoder().decode(opened.plaintext) };
}

/** Header-only presence announcement: 27 bytes. */
export function sealBeacon(keys: GroupKeys, identity: SenderIdentity, nowSeconds: number) {
  const { sender, seq } = identity.next();
  return seal(keys, { type: PacketType.BEACON, sender, seq, ts: nowSeconds, ttl: 0 }, new Uint8Array(0));
}
