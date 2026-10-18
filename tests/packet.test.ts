import { beforeAll, describe, expect, it } from 'vitest';
import { acceptedChannelTags, channelTag, dayOf } from '../src/packet/channel.ts';
import { isForChannel, open, openText, peek, seal, sealBeacon, sealText, withTtl } from '../src/packet/codec.ts';
import {
  aadOf, FLAG_RELAYABLE, HEADER_BYTES, MAX_PLAINTEXT_BYTES, messageIdHex, MIN_PACKET_BYTES, nonceOf, packHeader,
  PacketType, parseHeader, TAG_BYTES,
} from '../src/packet/format.ts';
import {
  deriveGroupKeys, generateGroupKey, generatePassphrase, normalizePassphrase, passphraseBits, PassphraseError,
  PBKDF2_ITERATIONS, type GroupKeys,
} from '../src/packet/keys.ts';
import { decodeHave, decodeWant, encodeHave, encodeWant } from '../src/packet/payloads.ts';
import { SenderIdentity } from '../src/packet/session.ts';
import { WORDS } from '../src/message/dictionary.ts';

const FAST = 1000; // PBKDF2 iterations; the real count is slow on purpose
const NOW = 1_790_000_000;
const text = (s: string) => new TextEncoder().encode(s);

let keys: GroupKeys;
let other: GroupKeys;
beforeAll(async () => {
  keys = await deriveGroupKeys('lunar fossil quick river zoo abandon', FAST);
  other = await deriveGroupKeys('lunar fossil quick river zoo ability', FAST);
});

let freshSeq = 1000;
const msg = (k: GroupKeys, body: string, over: { seq?: number; ttl?: number; sender?: number } = {}) =>
  seal(k, { type: PacketType.MSG, sender: over.sender ?? 0xdeadbeef, seq: over.seq ?? freshSeq++, ts: NOW, ttl: over.ttl }, text(body));

describe('header layout', () => {
  it('packs every field at its documented offset and parses it back', () => {
    const h = {
      type: PacketType.WANT, ttl: 5, flags: 0b10101, chan: 0xabcd, sender: 0x01020304, seq: 0xfffe,
      fragIndex: 9, fragCount: 16, ts: 0xfedcba98,
    };
    const bytes = packHeader(h);
    expect(bytes).toHaveLength(HEADER_BYTES);
    expect([...bytes]).toEqual([0x12, 0xb5, 0xab, 0xcd, 1, 2, 3, 4, 0xff, 0xfe, 0x9f, 0xfe, 0xdc, 0xba, 0x98]);
    expect(parseHeader(bytes)).toEqual(h);
  });

  it('builds the nonce as sender | seq | ts | 0x0000 and leaves ttl out of the authenticated header', () => {
    const bytes = packHeader({ type: 0, ttl: 7, flags: 3, chan: 1, sender: 0x11223344, seq: 0x5566, fragIndex: 0, fragCount: 1, ts: 0x778899aa });
    expect([...nonceOf(bytes)]).toEqual([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0, 0]);
    expect(aadOf(bytes)[1]).toBe(3);
    expect(aadOf(bytes).slice(2)).toEqual(bytes.slice(2));
  });

  it('rejects short input, unknown versions and unknown types', () => {
    const good = packHeader({ type: 0, ttl: 0, flags: 0, chan: 0, sender: 0, seq: 0, fragIndex: 0, fragCount: 1, ts: 0 });
    expect(parseHeader(good.slice(0, 14))).toBeNull();
    expect(parseHeader(Uint8Array.of(0x20, ...good.slice(1)))).toBeNull();
    expect(parseHeader(Uint8Array.of(0x1f, ...good.slice(1)))).toBeNull();
  });

  it('formats the message id as 12 hex characters', () => {
    expect(messageIdHex({ sender: 0xab, seq: 0x1 })).toBe('000000ab0001');
  });
});

describe('seal and open', () => {
  it('round-trips text, including multi-byte characters', async () => {
    const packet = await sealText(keys, new SenderIdentity(), 'meet at the bridge ✓ မြန်မာ', NOW);
    const got = await openText(keys, packet);
    expect(got?.text).toBe('meet at the bridge ✓ မြန်မာ');
    expect(got?.header.ts).toBe(NOW);
    expect(got!.header.flags & FLAG_RELAYABLE).toBe(FLAG_RELAYABLE);
  });

  it('is header + ciphertext + 12-byte tag, so a 100-byte message is a 127-byte packet', async () => {
    const packet = await msg(keys, 'x'.repeat(MAX_PLAINTEXT_BYTES));
    expect(packet).toHaveLength(HEADER_BYTES + MAX_PLAINTEXT_BYTES + TAG_BYTES);
    expect(packet).toHaveLength(127);
  });

  it('refuses a message over the limit', async () => {
    await expect(msg(keys, 'x'.repeat(MAX_PLAINTEXT_BYTES + 1))).rejects.toThrow(/limit/);
  });

  it('makes a BEACON of exactly 27 bytes that opens with no plaintext', async () => {
    const beacon = await sealBeacon(keys, new SenderIdentity(), NOW);
    expect(beacon).toHaveLength(MIN_PACKET_BYTES);
    expect(MIN_PACKET_BYTES).toBe(27);
    const opened = await open(keys, beacon);
    expect(opened?.header.type).toBe(PacketType.BEACON);
    expect(opened?.plaintext).toHaveLength(0);
  });

  it('produces different ciphertext for the same text under different seq values', async () => {
    const a = await msg(keys, 'same words');
    const b = await msg(keys, 'same words');
    expect(a.slice(HEADER_BYTES, -TAG_BYTES)).not.toEqual(b.slice(HEADER_BYTES, -TAG_BYTES));
  });

  it('only opens MSG packets with openText', async () => {
    const beacon = await sealBeacon(keys, new SenderIdentity(), NOW);
    expect(await openText(keys, beacon)).toBeNull();
  });
});

describe('rejects anything that is not authentic', () => {
  it('fails if any single bit of any byte is flipped, except the ttl bits', async () => {
    const packet = await msg(keys, 'do not tamper', { ttl: 4 });
    for (let i = 0; i < packet.length; i++) {
      for (const bit of [0x01, 0x80]) {
        const bad = Uint8Array.from(packet);
        bad[i] ^= bit;
        const ttlBit = i === 1 && bit === 0x80;
        expect(await open(keys, bad) !== null, `byte ${i} bit ${bit}`).toBe(ttlBit);
      }
    }
  });

  it('rejects the wrong key and the near-miss passphrase', async () => {
    const packet = await msg(keys, 'secret');
    expect(await open(other, packet)).toBeNull();
  });

  it('rejects truncated, extended and random input without throwing', async () => {
    const packet = await msg(keys, 'hello there');
    for (let n = 0; n < packet.length; n++) expect(await open(keys, packet.slice(0, n))).toBeNull();
    expect(await open(keys, Uint8Array.of(...packet, 0))).toBeNull();
    expect(await open(keys, new Uint8Array(0))).toBeNull();
    const rnd = new Uint8Array(60);
    for (let i = 0; i < 100; i++) {
      crypto.getRandomValues(rnd);
      expect(await open(keys, rnd)).toBeNull();
    }
  });

  it('rejects a packet with an unknown version even if the rest is valid', async () => {
    const packet = await msg(keys, 'hi');
    packet[0] = (packet[0] & 0x0f) | 0x20;
    expect(await open(keys, packet)).toBeNull();
  });
});

describe('nonce safety', () => {
  const base = { type: PacketType.MSG, sender: 0x0badf00d, ts: NOW, fragCount: 2 } as const;

  it('gives each fragment of a message its own keystream', async () => {
    const p0 = text('A'.repeat(40));
    const p1 = text('B'.repeat(40));
    const f0 = await seal(keys, { ...base, seq: 500, fragIndex: 0 }, p0);
    const f1 = await seal(keys, { ...base, seq: 500, fragIndex: 1 }, p1);
    const c0 = f0.slice(HEADER_BYTES, HEADER_BYTES + 40);
    const c1 = f1.slice(HEADER_BYTES, HEADER_BYTES + 40);
    // A shared nonce means a shared keystream, so c0 xor c1 would equal p0 xor p1 and leak both texts.
    expect(c0.every((v, i) => (v ^ c1[i]) === (p0[i] ^ p1[i]))).toBe(false);
    expect(nonceOf(f0)).not.toEqual(nonceOf(f1));
  });

  it('opens every fragment of a message that shares sender, seq and timestamp', async () => {
    for (let i = 0; i < 4; i++) {
      const packet = await seal(keys, { ...base, seq: 501, fragIndex: i, fragCount: 4 }, text(`part ${i}`));
      const opened = await open(keys, packet);
      expect(new TextDecoder().decode(opened!.plaintext)).toBe(`part ${i}`);
      expect(opened!.header.fragIndex).toBe(i);
    }
  });

  it('refuses to seal twice under the same nonce with one key', async () => {
    await seal(keys, { ...base, seq: 502, fragIndex: 0 }, text('first'));
    await expect(seal(keys, { ...base, seq: 502, fragIndex: 0 }, text('second'))).rejects.toThrow(/nonce/i);
    // a different key has its own history
    await expect(seal(other, { ...base, seq: 502, fragIndex: 0 }, text('second'))).resolves.toBeDefined();
  });

  it('does not burn a nonce when sealing fails validation', async () => {
    await expect(seal(keys, { ...base, seq: 503, fragIndex: 0 }, text('x'.repeat(200)))).rejects.toThrow(/limit/);
    await expect(seal(keys, { ...base, seq: 503, fragIndex: 0 }, text('ok'))).resolves.toBeDefined();
  });
});

describe('ttl for relays', () => {
  it('still authenticates after a relay lowers the ttl, and reports the live value', async () => {
    const packet = await msg(keys, 'relay me', { ttl: 5 });
    const relayed = withTtl(packet, 4);
    const opened = await open(keys, relayed);
    expect(opened?.header.ttl).toBe(4);
    expect(new TextDecoder().decode(opened!.plaintext)).toBe('relay me');
    expect(packet[1] >> 5).toBe(5);
  });

  it('lets a forger raise the ttl (documented), but relaying is capped at 7 by the field width', async () => {
    const opened = await open(keys, withTtl(await msg(keys, 'x', { ttl: 0 }), 7));
    expect(opened?.header.ttl).toBe(7);
    expect(() => withTtl(new Uint8Array(30), 8)).toThrow();
    await expect(msg(keys, 'x', { ttl: 8 })).rejects.toThrow();
  });
});

describe('channel tag', () => {
  it('is stable per key and day, and differs between keys and days', async () => {
    const day = dayOf(NOW);
    expect(await channelTag(keys, day)).toBe(await channelTag(keys, day));
    expect(await channelTag(keys, day)).not.toBe(await channelTag(keys, day + 1));
    expect(await channelTag(keys, day)).not.toBe(await channelTag(other, day));
  });

  it('matches only this group around the current day', async () => {
    const mine = await msg(keys, 'mine');
    const theirs = await msg(other, 'theirs');
    expect(await isForChannel(keys, mine, NOW)).toBe(true);
    expect(await isForChannel(keys, mine, NOW + 86400)).toBe(true);
    expect(await isForChannel(keys, mine, NOW + 5 * 86400)).toBe(false);
    expect(await isForChannel(keys, theirs, NOW)).toBe(false);
    expect((await acceptedChannelTags(keys, NOW)).size).toBeGreaterThan(0);
  });

  it('peeks at a header without decrypting', async () => {
    const h = peek(await msg(keys, 'peek', { seq: 99, sender: 5 }));
    expect(h).toMatchObject({ seq: 99, sender: 5, type: PacketType.MSG });
    expect(peek(new Uint8Array(10))).toBeNull();
  });
});

describe('keys', () => {
  it('derives interoperable keys from the same passphrase, however it is typed', async () => {
    const a = await deriveGroupKeys('Lunar  Fossil quick river ZOO  abandon ', FAST);
    const packet = await msg(a, 'typed differently');
    expect((await openText(keys, packet))?.text).toBe('typed differently');
    expect(normalizePassphrase('  A  b\tC ')).toBe('a b c');
  });

  it('keeps both keys non-extractable and uses 600k PBKDF2 iterations by default', async () => {
    expect(keys.enc.extractable).toBe(false);
    expect(keys.tag.extractable).toBe(false);
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    await expect(crypto.subtle.exportKey('raw', keys.enc)).rejects.toThrow();
  });

  it('rejects an empty passphrase', async () => {
    await expect(deriveGroupKeys('   ', FAST)).rejects.toMatchObject({ code: 'empty' });
  });

  it('generates six words from the dictionary', () => {
    const words = generatePassphrase().split(' ');
    expect(words).toHaveLength(6);
    for (const w of words) expect(WORDS).toContain(w);
    expect(generatePassphrase()).not.toBe(generatePassphrase());
  });
});

describe('passphrase strength', () => {
  const weak = [
    'hello', 'password123', 'correct horse battery staple',
    'lunar fossil quick river zoo',                 // five words
    'lunar fossil quick river zoo notaword',        // a word outside the list
    'zoo zoo zoo zoo zoo zoo',                      // repeated words
    'lunar fossil quick river zoo lunar',           // one repeat
    'a'.repeat(80),                                 // long but trivial
    'abcdef0123456789abcdef0123456789',             // hex, but only 128 bits
    '0'.repeat(64),                                 // right length, but an all-zero key
  ];

  it.each(weak)('rejects %j', async (secret) => {
    await expect(deriveGroupKeys(secret, FAST)).rejects.toBeInstanceOf(PassphraseError);
    await expect(deriveGroupKeys(secret, FAST)).rejects.toMatchObject({ code: 'weak' });
  });

  it('measures six distinct dictionary words as 66 bits and a raw key as 256', () => {
    expect(passphraseBits('lunar fossil quick river zoo abandon')).toBe(66);
    expect(passphraseBits('lunar fossil quick river zoo abandon ability')).toBe(77);
    expect(passphraseBits(generateGroupKey())).toBe(256);
    expect(passphraseBits('hello')).toBe(0);
  });

  it('accepts a generated passphrase and a generated 256-bit key, and they never collide', async () => {
    await expect(deriveGroupKeys(generatePassphrase(), FAST)).resolves.toBeDefined();
    const raw = generateGroupKey();
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    expect(raw).not.toBe(generateGroupKey());
    await expect(deriveGroupKeys(raw)).resolves.toBeDefined();
  });

  it('derives interoperable keys from a raw key, with no slow PBKDF2 step', async () => {
    const raw = generateGroupKey();
    const t0 = performance.now();
    const a = await deriveGroupKeys(raw);
    const b = await deriveGroupKeys(raw.toUpperCase());
    expect(performance.now() - t0).toBeLessThan(500);
    expect((await openText(b, await sealText(a, new SenderIdentity(), 'raw key works', NOW)))?.text).toBe('raw key works');
    expect(await open(keys, await sealText(a, new SenderIdentity(), 'x', NOW))).toBeNull();
  });

  it('generates at least six words and never fewer', () => {
    expect(generatePassphrase(8).split(' ')).toHaveLength(8);
    expect(() => generatePassphrase(5)).toThrow();
    expect(new Set(generatePassphrase().split(' ')).size).toBe(6);
  });
});

describe('sender identity', () => {
  it('counts up from zero under one sender id', () => {
    const id = new SenderIdentity(() => 42);
    expect([id.next(), id.next(), id.next()]).toEqual([
      { sender: 42, seq: 0 }, { sender: 42, seq: 1 }, { sender: 42, seq: 2 },
    ]);
  });

  it('takes a fresh sender id when seq wraps, so (sender, seq) never repeats', () => {
    let n = 0;
    const id = new SenderIdentity(() => ++n);
    const seen = new Set<string>();
    for (let i = 0; i < 70000; i++) {
      const { sender, seq } = id.next();
      const key = `${sender}:${seq}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(n).toBe(2);
  });

  it('gives every message a distinct nonce', async () => {
    const id = new SenderIdentity();
    const nonces = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const packet = await sealText(keys, id, 'x', NOW);
      nonces.add(nonceOf(packet).join(','));
    }
    expect(nonces.size).toBe(200);
  });
});

describe('HAVE and WANT payloads', () => {
  it('round-trips and rejects malformed lengths', () => {
    const entries = [{ sender: 1, seq: 2 }, { sender: 0xffffffff, seq: 0xffff }];
    expect(decodeHave(encodeHave(entries))).toEqual(entries);
    expect(decodeHave(new Uint8Array(7))).toBeNull();
    expect(() => encodeHave(Array(17).fill(entries[0]))).toThrow();
    expect(decodeWant(encodeWant(entries[1]))).toEqual(entries[1]);
    expect(decodeWant(new Uint8Array(5))).toBeNull();
  });

  it('travels as an encrypted HAVE packet', async () => {
    const id = new SenderIdentity();
    const { sender, seq } = id.next();
    const have = encodeHave([{ sender: 9, seq: 3 }]);
    const packet = await seal(keys, { type: PacketType.HAVE, sender, seq, ts: NOW, ttl: 0 }, have);
    const opened = await open(keys, packet);
    expect(opened?.header.type).toBe(PacketType.HAVE);
    expect(decodeHave(opened!.plaintext)).toEqual([{ sender: 9, seq: 3 }]);
  });
});
