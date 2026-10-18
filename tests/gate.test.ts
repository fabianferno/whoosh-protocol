import { describe, expect, it } from 'vitest';
import { CarrierGate } from '../src/audio/gate.ts';
import { encodeBytes, ready, WaveDecoder, TX_RATE, type Band } from '../src/audio/ggwave.ts';
import * as ch from './helpers/channel.ts';

const RATE = TX_RATE;
const payload = new TextEncoder().encode('hello gate, this is a test packet');

function noise(seconds: number, sigma: number, rand: () => number, rate = RATE): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * rate) }, () => sigma * ch.gauss(rand));
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const mix = (a: Float32Array, b: Float32Array): Float32Array => a.map((v, i) => v + (b[i] ?? 0));

interface Run {
  opens: number[];
  closes: number[];
  audio: Float32Array;
}

/** Streams `x` through a gate in `chunk`-sized pieces; times are seconds into the stream. */
function run(x: Float32Array, band: Band, rate = RATE, chunk = 4096): Run {
  const gate = new CarrierGate(rate, band);
  const opens: number[] = [];
  const closes: number[] = [];
  const parts: Float32Array[] = [];
  for (let i = 0; i < x.length; i += chunk) {
    const end = Math.min(x.length, i + chunk);
    const r = gate.push(x.subarray(i, end));
    if (r.opened) opens.push(end / rate);
    if (r.closed) closes.push(end / rate);
    if (r.audio) parts.push(r.audio);
  }
  return { opens, closes, audio: concat(...parts) };
}

async function decode(audio: Float32Array, rate = RATE): Promise<Uint8Array[]> {
  const rx = await WaveDecoder.create(rate);
  try {
    return ch.feed((c) => { const b = rx.pushBytes(c); return b ? [b] : []; }, audio);
  } finally {
    rx.free();
  }
}

/** Silence-padded signal: `lead` seconds of noise, the burst, then `tail` seconds of noise. */
async function scene(band: Band, lead: number, tail: number, sigma: number, seed: number) {
  const rand = ch.rng(seed);
  const burst = await encodeBytes(payload, band);
  const x = concat(noise(lead, sigma, rand), mix(burst, noise(burst.length / RATE, sigma, rand)), noise(tail, sigma, rand));
  return { x, burstStart: lead, burstEnd: lead + burst.length / RATE };
}

describe.each<Band>(['ultrasound', 'audible'])('CarrierGate %s', (band) => {
  it('opens once at the start of a burst, closes once after it, and the gated audio decodes', async () => {
    const { x, burstStart, burstEnd } = await scene(band, 4, 3, 0.003, 1);
    const r = run(x, band);
    expect(r.opens).toHaveLength(1);
    expect(r.closes).toHaveLength(1);
    expect(r.opens[0]).toBeGreaterThanOrEqual(burstStart);
    expect(r.opens[0]).toBeLessThan(burstStart + 0.5);
    expect(r.closes[0]).toBeGreaterThan(burstEnd);
    expect(r.closes[0]).toBeLessThan(burstEnd + 1.2);
    const got = await decode(r.audio);
    expect(got).toHaveLength(1);
    expect([...got[0]]).toEqual([...payload]);
  });

  it('feeds the decoder far less than the whole stream', async () => {
    const { x } = await scene(band, 8, 8, 0.003, 2);
    const r = run(x, band);
    expect(r.audio.length).toBeLessThan(x.length * 0.55);
  });

  it('gives the same result for 128-sample and 50,000-sample chunks', async () => {
    const { x } = await scene(band, 3, 2, 0.003, 3);
    const a = run(x, band, RATE, 128);
    const b = run(x, band, RATE, 50000);
    expect(a.opens.length).toBe(b.opens.length);
    expect(a.closes.length).toBe(b.closes.length);
    expect(a.audio.length).toBe(b.audio.length);
  });
});

describe('CarrierGate stays closed for things that are not Whoosh', () => {
  it('ignores 30 s of quiet and of loud broadband noise', () => {
    for (const sigma of [0.0005, 0.01, 0.1, 0.3]) {
      const r = run(noise(30, sigma, ch.rng(10)), 'ultrasound');
      expect(r.opens, `sigma ${sigma}`).toHaveLength(0);
    }
  });

  it('ignores loud speech-like low-frequency sound', () => {
    const t = (i: number) => i / RATE;
    const speech = Float32Array.from({ length: RATE * 15 }, (_, i) =>
      [150, 300, 450, 900, 1800, 2700].reduce((s, f, k) => s + (0.3 / (k + 1)) * Math.sin(2 * Math.PI * f * t(i)), 0) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t(i))));
    expect(run(speech, 'ultrasound').opens).toHaveLength(0);
  });

  it('adapts when the room suddenly gets 30 dB louder, without opening', () => {
    const rand = ch.rng(11);
    const x = concat(noise(6, 0.003, rand), noise(10, 0.1, rand), noise(6, 0.003, rand));
    expect(run(x, 'ultrasound').opens).toHaveLength(0);
  });

  it('does not open an ultrasound gate for an audible message, nor an audible gate for ultrasound', async () => {
    const audible = (await scene('audible', 3, 2, 0.003, 4)).x;
    const ultra = (await scene('ultrasound', 3, 2, 0.003, 5)).x;
    expect(run(audible, 'ultrasound').opens).toHaveLength(0);
    expect(run(ultra, 'audible').opens).toHaveLength(0);
  });

  it('releases a carrier that never ends, then re-learns it as background', () => {
    const rand = ch.rng(12);
    const tone = Float32Array.from({ length: RATE * 40 }, (_, i) => 0.05 * Math.sin((2 * Math.PI * 17000 * i) / RATE));
    const x = concat(noise(3, 0.003, rand), mix(tone, noise(40, 0.003, rand)));
    const r = run(x, 'ultrasound');
    expect(r.opens.length).toBeGreaterThanOrEqual(1);
    expect(r.closes.length).toBeGreaterThanOrEqual(1);
    expect(r.opens.length).toBeLessThanOrEqual(3);
  });

  it('is already running when a steady tone is present from the start: stays closed', () => {
    const rand = ch.rng(13);
    const tone = Float32Array.from({ length: RATE * 20 }, (_, i) => 0.05 * Math.sin((2 * Math.PI * 17000 * i) / RATE));
    expect(run(mix(tone, noise(20, 0.003, rand)), 'ultrasound').opens).toHaveLength(0);
  });
});

describe('CarrierGate at 44.1 kHz', () => {
  it('opens and the gated audio decodes through a 44.1 kHz microphone', async () => {
    const { x } = await scene('ultrasound', 3, 2, 0.003, 6);
    const x44 = ch.resample(x, RATE, 44100);
    const r = run(x44, 'ultrasound', 44100);
    expect(r.opens).toHaveLength(1);
    const got = await decode(r.audio, 44100);
    expect(got).toHaveLength(1);
    expect([...got[0]]).toEqual([...payload]);
  });
});

describe('gate feeding a decoder exactly as the app does', () => {
  /** Mic chunk -> gate -> fresh decoder on open -> push each gated piece at once. */
  async function live(x: Float32Array, band: Band, rate = RATE, chunk = 4096): Promise<Uint8Array[]> {
    await ready();
    const gate = new CarrierGate(rate, band);
    let decoder: WaveDecoder | null = null;
    const packets: Uint8Array[] = [];
    for (let i = 0; i < x.length; i += chunk) {
      const r = gate.push(x.subarray(i, Math.min(x.length, i + chunk)));
      if (r.opened) {
        decoder?.free();
        decoder = WaveDecoder.createLoaded(rate);
      }
      if (r.audio && decoder) {
        const p = decoder.pushBytes(r.audio);
        if (p) packets.push(p);
      }
    }
    decoder?.free();
    return packets;
  }

  it.each<Band>(['ultrasound', 'audible'])('decodes a full-length %s packet', async (band) => {
    const rand = ch.rng(40);
    const packet = Uint8Array.from({ length: 52 }, (_, i) => (i * 37 + 5) & 0xff);
    const burst = await encodeBytes(packet, band);
    const x = concat(noise(3, 0.0005, rand), burst, noise(2, 0.0005, rand));
    const got = await live(x, band);
    expect(got).toHaveLength(1);
    expect([...got[0]]).toEqual([...packet]);
  });

  it('decodes with an almost silent room (digital-silence-like noise floor)', async () => {
    const packet = Uint8Array.from({ length: 52 }, (_, i) => (i * 11 + 1) & 0xff);
    const burst = await encodeBytes(packet, 'ultrasound');
    const x = concat(new Float32Array(RATE * 3), burst, new Float32Array(RATE * 2));
    const got = await live(x, 'ultrasound');
    expect(got).toHaveLength(1);
  });
});
