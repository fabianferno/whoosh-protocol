import { Assembler, type Progress } from '../message/assembler.ts';
import { decodeText } from '../message/message.ts';
import { Decoder, type DecoderStats } from '../modem/decode.ts';
import { FrameType } from '../modem/frame.ts';

export type ReceiverEvent =
  | { kind: 'progress'; progress: Progress }
  | { kind: 'message'; msgId: number; text: string; dictionary: boolean }
  /** Completed KEY/ENC messages. Not used by the audio-only build. */
  | { kind: 'raw'; msgId: number; type: number; bytes: Uint8Array };

/** Microphone samples in, whole messages out. */
export class Receiver {
  private readonly decoder: Decoder;
  private readonly assembler = new Assembler();

  constructor(rate: number) {
    this.decoder = new Decoder(rate);
  }

  push(samples: Float32Array): ReceiverEvent[] {
    const events: ReceiverEvent[] = [];
    for (const frame of this.decoder.push(samples)) {
      const { progress, completed } = this.assembler.add(frame);
      events.push({ kind: 'progress', progress });
      if (!completed) continue;
      if (completed.type === FrameType.TEXT || completed.type === FrameType.DICT) {
        events.push({
          kind: 'message',
          msgId: completed.msgId,
          text: decodeText(completed.type, completed.bytes),
          dictionary: completed.type === FrameType.DICT,
        });
      } else {
        events.push({ kind: 'raw', msgId: completed.msgId, type: completed.type, bytes: completed.bytes });
      }
    }
    return events;
  }

  getStats(): DecoderStats {
    return this.decoder.getStats();
  }
}
