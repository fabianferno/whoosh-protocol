/** Deterministic channel simulation so tests never flake. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Adds white noise at the given SNR, measured over the non-silent part of the signal. */
export function addNoise(x: Float32Array, snrDb: number, rand: () => number): Float32Array {
  let power = 0;
  let count = 0;
  for (const v of x) {
    if (Math.abs(v) > 1e-6) {
      power += v * v;
      count++;
    }
  }
  const sigma = Math.sqrt(power / Math.max(1, count) / 10 ** (snrDb / 10));
  return x.map((v) => v + sigma * gauss(rand));
}

export const gain = (x: Float32Array, g: number): Float32Array => x.map((v) => v * g);

export const clip = (x: Float32Array, limit: number): Float32Array =>
  x.map((v) => Math.max(-limit, Math.min(limit, v)));

/** Linear-interpolation resampler (stands in for a device running at another sample rate). */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  const n = Math.floor((x.length * to) / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = (i * from) / to;
    const i0 = Math.floor(pos);
    const f = pos - i0;
    out[i] = x[i0] * (1 - f) + x[Math.min(i0 + 1, x.length - 1)] * f;
  }
  return out;
}

/** Prepends `samples` of silence, so the burst starts at an arbitrary point in the stream. */
export function offset(x: Float32Array, samples: number): Float32Array {
  const out = new Float32Array(x.length + samples);
  out.set(x, samples);
  return out;
}

/** Crude cheap-speaker response: one-pole high-pass and low-pass. */
export function bandLimit(x: Float32Array, rate: number, highpassHz: number, lowpassHz: number): Float32Array {
  const out = new Float32Array(x.length);
  const aH = Math.exp((-2 * Math.PI * highpassHz) / rate);
  const aL = Math.exp((-2 * Math.PI * lowpassHz) / rate);
  let lp = 0;
  let hp = 0;
  let prev = 0;
  for (let i = 0; i < x.length; i++) {
    lp = (1 - aL) * x[i] + aL * lp;
    hp = aH * (hp + lp - prev);
    prev = lp;
    out[i] = hp;
  }
  return out;
}

/** Feeds a decoder in fixed-size chunks, as a microphone would. */
export function feed<T>(push: (chunk: Float32Array) => T[], x: Float32Array, chunk = 4096): T[] {
  const out: T[] = [];
  for (let i = 0; i < x.length; i += chunk) out.push(...push(x.subarray(i, Math.min(x.length, i + chunk))));
  return out;
}
