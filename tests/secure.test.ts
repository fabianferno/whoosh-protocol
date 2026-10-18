import { beforeAll, describe, expect, it } from 'vitest';
import { estimateSeconds, PacketInbox, prepareSecureSend } from '../src/app/secure.ts';
import { WaveDecoder, TX_RATE } from '../src/audio/ggwave.ts';
import { seal } from '../src/packet/codec.ts';
import { PacketType } from '../src/packet/format.ts';
import { deriveGroupKeys, type GroupKeys } from '../src/packet/keys.ts';
import { SenderIdentity } from '../src/packet/session.ts';
import * as ch from './helpers/channel.ts';

const NOW = 1_790_000_000;
let keys: GroupKeys;
let other: GroupKeys;
beforeAll(async () => {
  keys = await deriveGroupKeys('lunar fossil quick river zoo abandon', 1000);
  other = await deriveGroupKeys('lunar fossil quick river zoo ability', 1000);
});

async function overTheAir(samples: Float32Array, snr: number, seed: number): Promise<Uint8Array[]> {
  const rx = await WaveDecoder.create(TX_RATE);
  try {
    return ch.feed((c) => { const b = rx.pushBytes(c); return b ? [b] : []; }, ch.addNoise(ch.offset(samples, 6000), snr, ch.rng(seed)));
  } finally {
    rx.free();
  }
}

describe('secure send and receive', () => {
  it('delivers an encrypted message through sound and noise, and the audio carries no plaintext', async () => {
    const send = await prepareSecureSend(keys, new SenderIdentity(), 'meet at the old bridge', 'ultrasound', NOW);
    expect(send.packetBytes).toBe(27 + 'meet at the old bridge'.length);
    const [packet] = await overTheAir(send.samples, 6, 1);
    expect(new TextDecoder('latin1').decode(packet)).not.toContain('bridge');
    const got = await new PacketInbox(keys).accept(packet, NOW);
    expect(got?.text).toBe('meet at the old bridge');
  });

  it('drops a message from another group without reporting anything', async () => {
    const send = await prepareSecureSend(other, new SenderIdentity(), 'not for you', 'audible', NOW);
    const [packet] = await overTheAir(send.samples, 10, 2);
    expect(await new PacketInbox(keys).accept(packet, NOW)).toBeNull();
  });

  it('shows a repeated message once, so a looping sender does not spam', async () => {
    const send = await prepareSecureSend(keys, new SenderIdentity(), 'say it once', 'audible', NOW);
    const looped = new Float32Array(send.samples.length * 3);
    for (let i = 0; i < 3; i++) looped.set(send.samples, i * send.samples.length);
    const packets = await overTheAir(looped, 12, 3);
    expect(packets).toHaveLength(3);
    const inbox = new PacketInbox(keys);
    const shown = (await Promise.all(packets.map((p) => inbox.accept(p, NOW)))).filter(Boolean);
    expect(shown).toHaveLength(1);
  });

  it('drops tampered and truncated packets', async () => {
    const send = await prepareSecureSend(keys, new SenderIdentity(), 'integrity', 'audible', NOW);
    const [packet] = await overTheAir(send.samples, 12, 4);
    const bad = Uint8Array.from(packet);
    bad[20] ^= 0x04;
    const inbox = new PacketInbox(keys);
    expect(await inbox.accept(bad, NOW)).toBeNull();
    expect(await inbox.accept(packet.slice(0, 20), NOW)).toBeNull();
    expect((await inbox.accept(packet, NOW))?.text).toBe('integrity');
  });

  it('accepts a packet whose sender clock is a day off, and rejects one a week off', async () => {
    const identity = new SenderIdentity();
    const mk = (ts: number) => { const { sender, seq } = identity.next(); return seal(keys, { type: PacketType.MSG, sender, seq, ts }, new TextEncoder().encode('clock')); };
    expect(await new PacketInbox(keys).accept(await mk(NOW - 86400), NOW)).not.toBeNull();
    expect(await new PacketInbox(keys).accept(await mk(NOW - 7 * 86400), NOW)).toBeNull();
  });

  it('bounds the seen-set and rejects an over-long message with a clear error', async () => {
    const inbox = new PacketInbox(keys, 2);
    const id = new SenderIdentity();
    for (let i = 0; i < 5; i++) {
      const { sender, seq } = id.next();
      expect(await inbox.accept(await seal(keys, { type: PacketType.MSG, sender, seq, ts: NOW }, new Uint8Array([i])), NOW)).not.toBeNull();
    }
    await expect(prepareSecureSend(keys, id, 'x'.repeat(101), 'audible', NOW)).rejects.toThrow(/limit/);
  });

  it('estimates airtime close to the real thing without using a seq', async () => {
    const real = await prepareSecureSend(keys, new SenderIdentity(), 'a'.repeat(40), 'ultrasound', NOW);
    expect(Math.abs((await estimateSeconds(40, 'ultrasound')) - real.seconds)).toBeLessThan(0.3);
  });
});
