import { FrameType, type Frame } from '../modem/frame.ts';
import { MAX_PAYLOAD } from '../modem/params.ts';
import { MAX_DICT_WORDS, packWords, unpackWords } from './dictionary.ts';

export type Mode = 'dict' | 'text';

export const MAX_CHUNKS = 16;
export const MAX_TEXT_BYTES = MAX_PAYLOAD * MAX_CHUNKS;

export class MessageError extends Error {
  constructor(readonly code: 'empty' | 'too-long', message: string) {
    super(message);
  }
}

export interface Outgoing {
  mode: Mode;
  frames: Frame[];
}

/**
 * Turns text into frames. Text made only of lowercase dictionary words separated by single spaces
 * (up to 23 of them) goes out as one short DICT frame; anything else is sent as UTF-8 TEXT chunks.
 */
export function planMessage(text: string, msgId: number): Outgoing {
  if (text.trim() === '') throw new MessageError('empty', 'Nothing to send');

  const words = text.split(' ');
  const packed = words.length <= MAX_DICT_WORDS ? packWords(words) : null;
  if (packed) {
    return { mode: 'dict', frames: [{ type: FrameType.DICT, msgId, index: 0, total: 1, length: packed.length, payload: packed }] };
  }

  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_TEXT_BYTES) {
    throw new MessageError('too-long', `Message is ${bytes.length} bytes; the limit is ${MAX_TEXT_BYTES}`);
  }
  const total = Math.ceil(bytes.length / MAX_PAYLOAD);
  const frames: Frame[] = [];
  for (let index = 0; index < total; index++) {
    const payload = bytes.slice(index * MAX_PAYLOAD, (index + 1) * MAX_PAYLOAD);
    frames.push({ type: FrameType.TEXT, msgId, index, total, length: payload.length, payload });
  }
  return { mode: 'text', frames };
}

/** Text for a completed TEXT or DICT message. */
export function decodeText(type: Frame['type'], bytes: Uint8Array): string {
  return type === FrameType.DICT ? unpackWords(bytes).join(' ') : new TextDecoder().decode(bytes);
}
