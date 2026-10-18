import { CarrierGate } from '../audio/gate.ts';
import { ready, TX_RATE, WaveDecoder, type Band } from '../audio/ggwave.ts';
import { deriveGroupKeys, generateGroupKey } from '../packet/keys.ts';
import { SenderIdentity } from '../packet/session.ts';
import { PacketInbox, prepareSecureSend } from './secure.ts';

export interface LoopbackResult {
  band: Band;
  snrDb: number | null;
  ok: boolean;
  received: string | null;
  packetBytes: number;
  seconds: number;
  gateOpened: boolean;
  packetsHeard: number;
  /** Why it failed, when it did. */
  failure?: string;
}

function gaussian(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/**
 * Runs the whole receive path without a speaker or microphone: encrypt, encode to sound, add noise,
 * then the same carrier gate, decoder and packet inbox the app uses when listening. For judges and
 * developers without two devices. Uses a throwaway group, not the user's.
 */
export async function runLoopback(
  text: string, band: Band, snrDb: number | null, rand: () => number = Math.random,
): Promise<LoopbackResult> {
  const result: LoopbackResult = { band, snrDb, ok: false, received: null, packetBytes: 0, seconds: 0, gateOpened: false, packetsHeard: 0 };
  try {
    await ready();
    const keys = await deriveGroupKeys(generateGroupKey());
    const send = await prepareSecureSend(keys, new SenderIdentity(), text, band);
    result.packetBytes = send.packetBytes;
    result.seconds = send.seconds;

    const lead = TX_RATE * 2;
    const x = new Float32Array(lead + send.samples.length + TX_RATE);
    x.set(send.samples, lead);
    if (snrDb !== null) {
      const power = send.samples.reduce((a, v) => a + v * v, 0) / send.samples.length;
      const sigma = Math.sqrt(power / 10 ** (snrDb / 10));
      for (let i = 0; i < x.length; i++) x[i] += sigma * gaussian(rand);
    }

    const gate = new CarrierGate(TX_RATE, band);
    const inbox = new PacketInbox(keys);
    let decoder: WaveDecoder | null = null;
    for (let i = 0; i < x.length; i += 4096) {
      const r = gate.push(x.subarray(i, Math.min(x.length, i + 4096)));
      if (r.opened) {
        result.gateOpened = true;
        decoder?.free();
        decoder = WaveDecoder.createLoaded(TX_RATE);
      }
      const packet = r.audio && decoder ? decoder.pushBytes(r.audio) : null;
      if (packet) {
        result.packetsHeard++;
        const got = await inbox.accept(packet);
        if (got) result.received = got.text;
      }
    }
    decoder?.free();
    result.ok = result.received === text;
    if (!result.ok) {
      result.failure = !result.gateOpened ? 'the detector gate never opened' : result.packetsHeard === 0 ? 'ggwave could not decode the signal' : 'the packet failed authentication';
    }
  } catch (error) {
    result.failure = (error as Error).message;
  }
  return result;
}
