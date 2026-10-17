import { encodeFrame } from '../modem/encode.ts';
import { planMessage, type Mode } from '../message/message.ts';

export const SEND_RATE = 48000;

export interface PreparedSend {
  mode: Mode;
  chunks: number;
  samples: Float32Array;
  seconds: number;
}

/** Encodes text into one continuous waveform: every chunk's burst, back to back. Throws MessageError. */
export function prepareSend(text: string, msgId = Math.floor(Math.random() * 256)): PreparedSend {
  const plan = planMessage(text, msgId);
  const bursts = plan.frames.map((frame) => encodeFrame(frame, SEND_RATE));
  const samples = new Float32Array(bursts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const burst of bursts) {
    samples.set(burst, at);
    at += burst.length;
  }
  return { mode: plan.mode, chunks: plan.frames.length, samples, seconds: samples.length / SEND_RATE };
}
