import { describe, expect, it } from 'vitest';
import { encodeText, MAX_BYTES, TextDecoderStream, TooLongError, TX_RATE, type Band } from '../src/audio/ggwave.ts';
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
