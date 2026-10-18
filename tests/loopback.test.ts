import { describe, expect, it } from 'vitest';
import { runLoopback } from '../src/app/loopback.ts';
import { rng } from './helpers/channel.ts';

describe('runLoopback', () => {
  it.each(['ultrasound', 'audible'] as const)('delivers a message end to end, %s, clean and noisy', async (band) => {
    for (const snr of [null, 6, 0]) {
      const r = await runLoopback('loopback check: meet at noon', band, snr, rng(7));
      expect(r.failure, `${band} ${snr}`).toBeUndefined();
      expect(r).toMatchObject({ ok: true, received: 'loopback check: meet at noon', gateOpened: true, packetsHeard: 1 });
      expect(r.packetBytes).toBe(27 + 'loopback check: meet at noon'.length);
    }
  });

  it('reports where it failed when the signal is buried in noise', async () => {
    const r = await runLoopback('too noisy', 'ultrasound', -25, rng(8));
    expect(r.ok).toBe(false);
    expect(r.failure).toBeTruthy();
  });

  it('reports a clear error for an over-long message instead of throwing', async () => {
    const r = await runLoopback('x'.repeat(101), 'audible', null);
    expect(r.ok).toBe(false);
    expect(r.failure).toMatch(/limit/);
  });
});
