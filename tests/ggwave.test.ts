import { describe, expect, it } from 'vitest';
import { encodeBytes, encodeText, MAX_BYTES, MAX_PACKET_BYTES, TextDecoderStream, TooLongError, TX_RATE, type Band } from '../src/audio/ggwave.ts';
import { openText, sealText } from '../src/packet/codec.ts';
import { deriveGroupKeys } from '../src/packet/keys.ts';
import { SenderIdentity } from '../src/packet/session.ts';
import * as ch from './helpers/channel.ts';

async function receive(x: Float32Array, rate: number, chunk = 4096): Promise<string[]> {
  const rx = await TextDecoderStream.create(rate);
  try {
    return ch.feed((c) => {
      const text = rx.push(c);
      return text === null ? [] : [text];
    }, x, chunk);
  } finally {
    rx.free();
  }
}

describe.each<Band>(['ultrasound', 'audible'])('ggwave %s', (band) => {
  it('round-trips text, including multi-byte characters', async () => {
    const wave = await encodeText('hello, wörld ✓', band);
    expect(await receive(ch.offset(wave, 7000), TX_RATE)).toEqual(['hello, wörld ✓']);
  });

  it('decodes through noise', async () => {
    const wave = await encodeText('meet at the bridge', band);
    const noisy = ch.addNoise(ch.offset(wave, 5000), 6, ch.rng(11));
    expect(await receive(noisy, TX_RATE)).toEqual(['meet at the bridge']);
  });

  it('decodes when the microphone runs at 44.1 kHz', async () => {
    const wave = await encodeText('hello 44k', band);
    const x = ch.resample(ch.offset(wave, 9000), TX_RATE, 44100);
    expect(await receive(x, 44100)).toEqual(['hello 44k']);
  });
});

describe('encodeText', () => {
  it('uses the 15-19.5 kHz band for ultrasound', async () => {
    const wave = await encodeText('band check', 'ultrasound');
    const energyAt = (hz: number) => {
      const c = 2 * Math.cos((2 * Math.PI * hz) / TX_RATE);
      let s1 = 0, s2 = 0;
      for (const v of wave) { const s = v + c * s1 - s2; s2 = s1; s1 = s; }
      return s1 * s1 + s2 * s2 - c * s1 * s2;
    };
    const low = Math.max(...[1000, 2000, 4000, 8000].map(energyAt));
    const high = Math.max(...[15250, 16500, 17750, 19000].map(energyAt));
    expect(high).toBeGreaterThan(low * 20);
  });

  it('rejects empty and over-limit messages', async () => {
    await expect(encodeText('', 'audible')).rejects.toThrow('Nothing to send');
    await expect(encodeText('x'.repeat(MAX_BYTES + 1), 'audible')).rejects.toBeInstanceOf(TooLongError);
    expect((await encodeText('x'.repeat(MAX_BYTES), 'audible')).length).toBeGreaterThan(0);
  });

  it('gives no message for silence or noise', async () => {
    const rand = ch.rng(2);
    const noise = Float32Array.from({ length: TX_RATE * 4 }, () => 0.05 * ch.gauss(rand));
    expect(await receive(noise, TX_RATE)).toEqual([]);
  });
});

describe('ggwave carries packets', () => {
  it('round-trips binary data with zero and high bytes in both bands', async () => {
    const payload = Uint8Array.from({ length: 127 }, (_, i) => (i * 29 + 3) & 0xff);
    payload[5] = 0;
    payload[6] = 0xff;
    for (const band of ['ultrasound', 'audible'] as const) {
      const wave = await encodeBytes(payload, band);
      const rx = await TextDecoderStream.create(TX_RATE);
      const got = ch.feed((c) => { const b = rx.pushBytes(c); return b ? [b] : []; }, ch.offset(wave, 6000));
      rx.free();
      expect(got).toHaveLength(1);
      expect([...got[0]]).toEqual([...payload]);
    }
  });

  it('delivers an encrypted packet end to end through noise', async () => {
    const keys = await deriveGroupKeys('lunar fossil quick river zoo abandon', 1000);
    const packet = await sealText(keys, new SenderIdentity(), 'meet at the old bridge at noon', 1_790_000_000);
    const wave = ch.addNoise(ch.offset(await encodeBytes(packet, 'ultrasound'), 6000), 6, ch.rng(21));
    const rx = await TextDecoderStream.create(TX_RATE);
    const got = ch.feed((c) => { const b = rx.pushBytes(c); return b ? [b] : []; }, wave);
    rx.free();
    expect(got).toHaveLength(1);
    expect((await openText(keys, got[0]))?.text).toBe('meet at the old bridge at noon');
  });

  it('rejects empty and over-size packets', async () => {
    await expect(encodeBytes(new Uint8Array(0), 'audible')).rejects.toThrow('Nothing to send');
    await expect(encodeBytes(new Uint8Array(MAX_PACKET_BYTES + 1), 'audible')).rejects.toBeInstanceOf(TooLongError);
  });
});
