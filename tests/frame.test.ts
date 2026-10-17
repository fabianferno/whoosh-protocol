import { describe, expect, it } from 'vitest';
import {
  bodyBlockBytes, FrameType, HEADER_BLOCK_BYTES, packFrame, parseBodyBlock, parseHeaderBlock, type Frame,
} from '../src/modem/frame.ts';

const frame = (payload: Uint8Array, over: Partial<Frame> = {}): Frame => ({
  type: FrameType.TEXT, msgId: 42, index: 1, total: 3, length: payload.length, payload, ...over,
});

function split(packed: Uint8Array) {
  return { head: packed.slice(0, HEADER_BLOCK_BYTES), body: packed.slice(HEADER_BLOCK_BYTES) };
}

describe('frame', () => {
  it('round-trips header and body', () => {
    const f = frame(new TextEncoder().encode('hello there'));
    const { head, body } = split(packFrame(f));
    const header = parseHeaderBlock(head)!;
    expect(header).toMatchObject({ type: FrameType.TEXT, msgId: 42, index: 1, total: 3, length: 11 });
    expect(body.length).toBe(bodyBlockBytes(11));
    expect(parseBodyBlock(header, body)).toEqual(f);
  });

  it('survives 2 corrupted header bytes and 4 corrupted body bytes', () => {
    const f = frame(Uint8Array.from({ length: 32 }, (_, i) => i));
    const { head, body } = split(packFrame(f));
    head[0] ^= 0xff;
    head[5] ^= 0x31;
    [0, 9, 20, 33].forEach((p) => (body[p] ^= 0x5a));
    const header = parseHeaderBlock(head)!;
    expect(parseBodyBlock(header, body)).toEqual(f);
  });

  it('rejects a body that is damaged beyond repair', () => {
    const f = frame(Uint8Array.from({ length: 16 }, (_, i) => i * 3));
    const { head, body } = split(packFrame(f));
    for (let p = 0; p < 12; p++) body[p] ^= 0xa5;
    expect(parseBodyBlock(parseHeaderBlock(head)!, body)).toBeNull();
  });

  it('rejects headers with an unknown type or oversized length', () => {
    const { head } = split(packFrame(frame(new Uint8Array(4))));
    expect(parseHeaderBlock(head.map(() => 0xff))).toBeNull();
  });

  it('refuses to pack oversized payloads and bad chunk indexes', () => {
    expect(() => packFrame(frame(new Uint8Array(33)))).toThrow();
    expect(() => packFrame(frame(new Uint8Array(1), { index: 3, total: 3 }))).toThrow();
    expect(() => packFrame(frame(new Uint8Array(1), { total: 17 }))).toThrow();
  });
});
