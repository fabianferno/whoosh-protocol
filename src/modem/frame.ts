import { crc8 } from '../fec/crc.ts';
import { rsDecode, rsEncode } from '../fec/rs.ts';
import { BODY_PARITY, HEADER_BYTES, HEADER_PARITY, MAX_PAYLOAD } from './params.ts';

export const FrameType = { TEXT: 0, DICT: 1, KEY: 2, ENC: 3 } as const;
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

export interface FrameHeader {
  type: FrameTypeValue;
  msgId: number;
  index: number;
  total: number;
  length: number;
}

export interface Frame extends FrameHeader {
  payload: Uint8Array;
}

function headerBytes(h: FrameHeader): Uint8Array {
  return Uint8Array.of(h.type, h.msgId & 0xff, ((h.index & 0xf) << 4) | ((h.total - 1) & 0xf), h.length);
}

/** Header block (8 B) followed by body block (length + 9 B). */
export function packFrame(frame: Frame): Uint8Array {
  if (frame.payload.length > MAX_PAYLOAD) throw new Error('payload too large');
  if (frame.total < 1 || frame.total > 16 || frame.index >= frame.total) throw new Error('bad chunk index');
  const header = headerBytes({ ...frame, length: frame.payload.length });
  const body = new Uint8Array(frame.payload.length + 1);
  body.set(frame.payload);
  body[frame.payload.length] = crc8(Uint8Array.of(...header, ...frame.payload));
  const h = rsEncode(header, HEADER_PARITY);
  const b = rsEncode(body, BODY_PARITY);
  const out = new Uint8Array(h.length + b.length);
  out.set(h);
  out.set(b, h.length);
  return out;
}

export const HEADER_BLOCK_BYTES = HEADER_BYTES + HEADER_PARITY;
export const bodyBlockBytes = (length: number): number => length + 1 + BODY_PARITY;

export function parseHeaderBlock(block: Uint8Array): FrameHeader | null {
  const raw = rsDecode(block, HEADER_PARITY);
  if (!raw || raw[0] > 3 || raw[3] > MAX_PAYLOAD) return null;
  return {
    type: raw[0] as FrameTypeValue,
    msgId: raw[1],
    index: raw[2] >> 4,
    total: (raw[2] & 0xf) + 1,
    length: raw[3],
  };
}

export function parseBodyBlock(header: FrameHeader, block: Uint8Array): Frame | null {
  const body = rsDecode(block, BODY_PARITY);
  if (!body) return null;
  const payload = body.slice(0, header.length);
  if (crc8(Uint8Array.of(...headerBytes(header), ...payload)) !== body[header.length]) return null;
  if (header.index >= header.total) return null;
  return { ...header, payload };
}
