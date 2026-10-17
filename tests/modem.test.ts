import { describe, expect, it } from 'vitest';
import { Decoder } from '../src/modem/decode.ts';
import { encodeFrame } from '../src/modem/encode.ts';
import { FrameType, type Frame } from '../src/modem/frame.ts';
import * as ch from './helpers/channel.ts';

const RATE = 48000;
const payload = new TextEncoder().encode('blue river sings quietly');
const full = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);

const frame = (p: Uint8Array, index = 0, total = 1): Frame => ({
  type: FrameType.TEXT, msgId: 7, index, total, length: p.length, payload: p,
});

/** Runs `trials` seeded transmissions through `channel`; returns how many decoded exactly once and correctly. */
function successes(
  channel: (clean: Float32Array, rand: () => number) => { x: Float32Array; rate: number },
  trials = 4,
  p = payload,
): number {
  let ok = 0;
  for (let t = 0; t < trials; t++) {
    const rand = ch.rng(100 + t);
    const { x, rate } = channel(encodeFrame(frame(p), RATE), rand);
    const decoder = new Decoder(rate);
    const frames = ch.feed((c) => decoder.push(c), x);
    if (frames.length === 1 && frames[0].payload.every((v, i) => v === p[i]) && frames[0].payload.length === p.length) ok++;
  }
  return ok;
}

describe('modem round trip', () => {
  it('a 24-byte burst is under 3 seconds', () => {
    expect(encodeFrame(frame(payload), RATE).length / RATE).toBeLessThan(3);
  });

  it('decodes a clean signal', () => {
    expect(successes((c) => ({ x: c, rate: RATE }))).toBe(4);
  });

  it('finds the burst at any start offset (including ones that straddle the detector step)', () => {
    for (const off of [0, 3, 8000, 20001, 62403]) {
      expect(successes((c) => ({ x: ch.offset(c, off), rate: RATE }), 2)).toBe(2);
    }
  });

  it('decodes at 0 dB and -3 dB SNR', () => {
    expect(successes((c, r) => ({ x: ch.addNoise(ch.offset(c, 20000), 0, r), rate: RATE }))).toBe(4);
    expect(successes((c, r) => ({ x: ch.addNoise(ch.offset(c, 20000), -3, r), rate: RATE }))).toBe(4);
  });

  it('decodes a full 32-byte payload in noise', () => {
    expect(successes((c, r) => ({ x: ch.addNoise(ch.offset(c, 9000), 3, r), rate: RATE }), 4, full)).toBe(4);
  });

  it('decodes when the receiver runs at 44.1 kHz', () => {
    expect(
      successes((c, r) => ({ x: ch.addNoise(ch.resample(ch.offset(c, 9000), RATE, 44100), 5, r), rate: 44100 })),
    ).toBe(4);
  });

  it('is insensitive to very quiet and hard-clipped signals', () => {
    expect(successes((c, r) => ({ x: ch.addNoise(ch.gain(ch.offset(c, 9000), 0.05), 5, r), rate: RATE }))).toBe(4);
    expect(successes((c, r) => ({ x: ch.addNoise(ch.clip(ch.gain(ch.offset(c, 9000), 3), 0.3), 8, r), rate: RATE }))).toBe(4);
  });

  it('survives a cheap-speaker band limit (400 Hz to 5 kHz)', () => {
    expect(
      successes((c, r) => ({ x: ch.addNoise(ch.bandLimit(ch.offset(c, 9000), RATE, 400, 5000), 5, r), rate: RATE })),
    ).toBe(4);
  });

  it('decodes two bursts in one stream, in order', () => {
    const rand = ch.rng(5);
    const a = encodeFrame(frame(new TextEncoder().encode('first chunk here'), 0, 2), RATE);
    const b = encodeFrame(frame(new TextEncoder().encode('second chunk'), 1, 2), RATE);
    const x = new Float32Array(a.length + b.length + 5000);
    x.set(a);
    x.set(b, a.length + 5000);
    const decoder = new Decoder(RATE);
    const got = ch.feed((c) => decoder.push(c), ch.addNoise(x, 3, rand), 2048).map((f) => new TextDecoder().decode(f.payload));
    expect(got).toEqual(['first chunk here', 'second chunk']);
  });

  it('decodes regardless of microphone chunk size', () => {
    const x = ch.offset(encodeFrame(frame(payload), RATE), 5000);
    for (const size of [128, 1000, 4096, 50000]) {
      const decoder = new Decoder(RATE);
      expect(ch.feed((c) => decoder.push(c), x, size)).toHaveLength(1);
    }
  });

  it('produces no frames from noise or silence', () => {
    const rand = ch.rng(9);
    const noise = Float32Array.from({ length: RATE * 8 }, () => 0.1 * ch.gauss(rand));
    const decoder = new Decoder(RATE);
    expect(ch.feed((c) => decoder.push(c), noise)).toHaveLength(0);
    expect(ch.feed((c) => decoder.push(c), new Float32Array(RATE * 2))).toHaveLength(0);
  });
});
