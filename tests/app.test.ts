import { describe, expect, it } from 'vitest';
import { prepareSend, SEND_RATE } from '../src/app/sender.ts';
import { Receiver, type ReceiverEvent } from '../src/app/receiver.ts';
import { encodeWav } from '../src/audio/wav.ts';
import { MessageError } from '../src/message/message.ts';
import * as ch from './helpers/channel.ts';

const messages = (events: ReceiverEvent[]) =>
  events.flatMap((e) => (e.kind === 'message' ? [e.text] : []));

describe('send then receive', () => {
  it('delivers a dictionary sentence in one short burst', () => {
    const send = prepareSend('river quick zoo abandon', 1);
    expect(send.mode).toBe('dict');
    expect(send.seconds).toBeLessThan(2);
    const rx = new Receiver(SEND_RATE);
    expect(messages(ch.feed((c) => rx.push(c), ch.offset(send.samples, 7777)))).toEqual(['river quick zoo abandon']);
  });

  it('delivers a free-text sentence through noise', () => {
    const send = prepareSend('Blue rivers sing quietly!', 2);
    const rx = new Receiver(SEND_RATE);
    const x = ch.addNoise(ch.offset(send.samples, 12345), 0, ch.rng(3));
    expect(messages(ch.feed((c) => rx.push(c), x))).toEqual(['Blue rivers sing quietly!']);
  });

  it('delivers a multi-burst message and reports progress', () => {
    const text = 'The quick brown fox jumps over the lazy dog, then naps in the warm afternoon sun. 😀';
    const send = prepareSend(text, 3);
    expect(send.chunks).toBeGreaterThan(2);
    const rx = new Receiver(SEND_RATE);
    const events = ch.feed((c) => rx.push(c), ch.addNoise(ch.offset(send.samples, 999), 3, ch.rng(4)));
    const received = events.flatMap((e) => (e.kind === 'progress' ? [e.progress.received] : []));
    expect(received).toEqual(Array.from({ length: send.chunks }, (_, i) => i + 1));
    expect(messages(events)).toEqual([text]);
  });

  it('delivers once when the sender loops the message', () => {
    const send = prepareSend('Loop me please, friend', 4);
    const looped = new Float32Array(send.samples.length * 3);
    for (let i = 0; i < 3; i++) looped.set(send.samples, i * send.samples.length);
    const rx = new Receiver(SEND_RATE);
    expect(messages(ch.feed((c) => rx.push(c), looped))).toEqual(['Loop me please, friend']);
  });

  it('rejects empty input', () => {
    expect(() => prepareSend('  ')).toThrow(MessageError);
  });
});

describe('wav', () => {
  it('writes a valid 16-bit mono header and clamps samples', () => {
    const wav = encodeWav(Float32Array.of(0, 1, -1, 2, -2), 48000);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(40, true)).toBe(10);
    expect(wav.length).toBe(54);
    expect([44, 46, 48, 50, 52].map((o) => view.getInt16(o, true))).toEqual([0, 32767, -32767, 32767, -32767]);
  });
});
