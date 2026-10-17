import { describe, expect, it } from 'vitest';
import { crc8 } from '../src/fec/crc.ts';
import { rsDecode, rsEncode } from '../src/fec/rs.ts';
import { rng } from './helpers/channel.ts';

const bytes = (n: number, rand: () => number) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));

function corrupt(word: Uint8Array, count: number, rand: () => number): Uint8Array {
  const out = Uint8Array.from(word);
  const hit = new Set<number>();
  while (hit.size < count) hit.add(Math.floor(rand() * out.length));
  for (const p of hit) out[p] ^= 1 + Math.floor(rand() * 255);
  return out;
}

describe('crc8', () => {
  it('matches the standard check value for "123456789"', () => {
    expect(crc8(new TextEncoder().encode('123456789'))).toBe(0xf4);
  });
});

describe('reed-solomon', () => {
  it('round-trips an undamaged word', () => {
    const msg = Uint8Array.of(1, 2, 3, 4, 5);
    expect(rsDecode(rsEncode(msg, 8), 8)).toEqual(msg);
  });

  it('corrects up to nsym/2 byte errors anywhere in the word', () => {
    const rand = rng(1);
    for (let trial = 0; trial < 500; trial++) {
      const nsym = trial % 2 ? 8 : 4;
      const msg = bytes(1 + Math.floor(rand() * 40), rand);
      const damaged = corrupt(rsEncode(msg, nsym), Math.floor(rand() * (nsym / 2 + 1)), rand);
      expect(rsDecode(damaged, nsym)).toEqual(msg);
    }
  });

  it('never returns the original when damage exceeds capacity', () => {
    const rand = rng(2);
    for (let trial = 0; trial < 200; trial++) {
      const msg = bytes(20, rand);
      const damaged = corrupt(rsEncode(msg, 8), 5 + Math.floor(rand() * 4), rand);
      const out = rsDecode(damaged, 8);
      expect(out === null || out.some((v, i) => v !== msg[i])).toBe(true);
    }
  });
});
