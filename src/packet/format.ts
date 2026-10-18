export const VERSION = 1;

export const PacketType = { MSG: 0, HAVE: 1, WANT: 2, BEACON: 3 } as const;
export type PacketTypeValue = (typeof PacketType)[keyof typeof PacketType];

export const HEADER_BYTES = 15;
export const TAG_BYTES = 12;
/** A header plus an empty ciphertext plus the tag: what a BEACON is. */
export const MIN_PACKET_BYTES = HEADER_BYTES + TAG_BYTES;
/** Longest plaintext (PRD: about 100 bytes), so a packet is at most 127 bytes. */
export const MAX_PLAINTEXT_BYTES = 100;
export const MAX_TTL = 7;
export const DEFAULT_TTL = 3;

/** Flag bits (low 5 bits of byte 1). Authenticated, so relays must not change them. */
export const FLAG_RELAYABLE = 0b00001;
export const FLAG_FRAGMENTED = 0b00010;

export interface Header {
  type: PacketTypeValue;
  /** Live hop count. Not authenticated: relays decrement it. */
  ttl: number;
  flags: number;
  /** 16-bit truncated HMAC(group key, day). */
  chan: number;
  /** Random per-session id, uint32. */
  sender: number;
  /** Per-sender counter, uint16. sender + seq is the message id. */
  seq: number;
  fragIndex: number;
  /** 1 to 16. */
  fragCount: number;
  /** Unix seconds, uint32. */
  ts: number;
}

/**
 * byte 0      version (high 4 bits) | type (low 4 bits)
 * byte 1      ttl (high 3 bits) | flags (low 5 bits)
 * bytes 2-3   chan
 * bytes 4-7   sender
 * bytes 8-9   seq
 * byte 10     fragIndex (high 4 bits) | fragCount - 1 (low 4 bits)
 * bytes 11-14 ts
 */
export function packHeader(h: Header): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(HEADER_BYTES);
  const view = new DataView(out.buffer);
  out[0] = (VERSION << 4) | h.type;
  out[1] = ((h.ttl & 0x7) << 5) | (h.flags & 0x1f);
  view.setUint16(2, h.chan);
  view.setUint32(4, h.sender);
  view.setUint16(8, h.seq);
  out[10] = ((h.fragIndex & 0xf) << 4) | ((h.fragCount - 1) & 0xf);
  view.setUint32(11, h.ts);
  return out;
}

/** Null if the bytes are too short, the version is unknown, or the type is unknown. */
export function parseHeader(bytes: Uint8Array): Header | null {
  if (bytes.length < HEADER_BYTES || bytes[0] >> 4 !== VERSION || (bytes[0] & 0xf) > PacketType.BEACON) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    type: (bytes[0] & 0xf) as PacketTypeValue,
    ttl: bytes[1] >> 5,
    flags: bytes[1] & 0x1f,
    chan: view.getUint16(2),
    sender: view.getUint32(4),
    seq: view.getUint16(8),
    fragIndex: bytes[10] >> 4,
    fragCount: (bytes[10] & 0xf) + 1,
    ts: view.getUint32(11),
  };
}

/**
 * sender (4) | seq (2) | ts (4) | frag byte | 0x00. No bytes of it go over the air.
 *
 * The PRD's nonce ends in 0x0000. The first of those bytes carries the fragment byte instead, so the
 * fragments of one message (same sender, seq and ts) never share a nonce. With a shared nonce, GCM
 * would reuse a keystream and leak the XOR of two plaintexts.
 */
export function nonceOf(header: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12);
  out.set(header.subarray(4, 8), 0);
  out.set(header.subarray(8, 10), 4);
  out.set(header.subarray(11, 15), 6);
  out[10] = header[10];
  return out;
}

/** The authenticated header: the live header with the ttl bits zeroed, so a relay can lower the ttl. */
export function aadOf(header: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(header.subarray(0, HEADER_BYTES));
  out[1] &= 0x1f;
  return out;
}

/** Hex sender + seq (12 characters): the message id used for dedup on the mesh and on Arkiv. */
export const messageIdHex = (h: Pick<Header, 'sender' | 'seq'>): string =>
  h.sender.toString(16).padStart(8, '0') + h.seq.toString(16).padStart(4, '0');
