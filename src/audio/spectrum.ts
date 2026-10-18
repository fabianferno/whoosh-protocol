/** Centre frequencies of the meter bars: 0.5 kHz to 22 kHz in 0.5 kHz steps. */
export const BAR_HZ: readonly number[] = Array.from({ length: 44 }, (_, i) => 500 * (i + 1));

/** Amplitude (dBFS) of a sine at `hz` within `samples`, by Goertzel. */
function levelDb(samples: Float32Array, rate: number, hz: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / rate);
  let s1 = 0;
  let s2 = 0;
  for (const v of samples) {
    const s = v + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  const power = Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2);
  const amplitude = (2 * Math.sqrt(power)) / samples.length;
  return 20 * Math.log10(amplitude + 1e-9);
}

/** One 0-1 height per BAR_HZ entry; bars above the Nyquist frequency are 0. -90 dBFS maps to 0, -20 dBFS to 1. */
export function barLevels(samples: Float32Array, rate: number): number[] {
  return BAR_HZ.map((hz) => (hz >= rate / 2 ? 0 : Math.min(1, Math.max(0, (levelDb(samples, rate, hz) + 90) / 70))));
}
