import { describe, expect, it } from 'vitest';
import { BAR_HZ, barLevels } from '../src/audio/spectrum.ts';

const sine = (hz: number, rate: number, amp = 0.1, n = 4096) =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

describe('barLevels', () => {
  it('lights the bar nearest an 18 kHz tone and leaves far bars dark', () => {
    const levels = barLevels(sine(18000, 48000), 48000);
    const peak = levels.indexOf(Math.max(...levels));
    expect(BAR_HZ[peak]).toBe(18000);
    expect(levels[peak]).toBeGreaterThan(0.9);
    expect(levels[BAR_HZ.indexOf(3000)]).toBeLessThan(0.3);
  });

  it('is silent for silence and zeroes bars above Nyquist', () => {
    expect(Math.max(...barLevels(new Float32Array(4096), 44100))).toBe(0);
    const levels = barLevels(sine(1000, 16000), 16000);
    expect(levels[BAR_HZ.indexOf(9000)]).toBe(0);
  });
});
