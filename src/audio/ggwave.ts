import factory from 'ggwave';

export type Band = 'ultrasound' | 'audible';

/** The PRD caps messages at about 100 bytes (airtime); ggwave itself allows 140. */
export const MAX_BYTES = 100;
/** Sample rate of generated waveforms. */
export const TX_RATE = 48000;

const PROTOCOL: Record<Band, string> = {
  ultrasound: 'GGWAVE_PROTOCOL_ULTRASOUND_FAST',
  audible: 'GGWAVE_PROTOCOL_AUDIBLE_FAST',
};

type Ggwave = Awaited<ReturnType<typeof factory>>;
let loading: Promise<Ggwave> | null = null;

function load(): Promise<Ggwave> {
  loading ??= factory().then((g) => {
    g.disableLog();
    return g;
  });
  return loading;
}

function parameters(g: Ggwave, inputRate: number) {
  const p = g.getDefaultParameters();
  p.sampleRateInp = inputRate;
  p.sampleRateOut = TX_RATE;
  p.sampleRate = TX_RATE;
  p.sampleFormatInp = g.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  p.sampleFormatOut = g.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  return p;
}

export class TooLongError extends Error {}

/** Waveform (mono, TX_RATE) for `text`. Throws TooLongError or Error('Nothing to send'). */
export async function encodeText(text: string, band: Band, volume = 50): Promise<Float32Array> {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes === 0) throw new Error('Nothing to send');
  if (bytes > MAX_BYTES) throw new TooLongError(`${bytes} bytes; the limit is ${MAX_BYTES}`);
  const g = await load();
  const instance = g.init(parameters(g, TX_RATE));
  try {
    const raw = g.encode(instance, text, g.ProtocolId[PROTOCOL[band]], volume);
    if (raw.byteLength === 0) throw new Error('ggwave could not encode this message');
    // Copy out of ggwave's reused buffer into a properly aligned Float32Array.
    return new Float32Array(raw.slice().buffer);
  } finally {
    g.free(instance);
  }
}

/** Feeds microphone samples to ggwave; any protocol (audible or ultrasound) is accepted. */
export class TextDecoderStream {
  private constructor(private readonly g: Ggwave, private readonly instance: number) {}

  static async create(inputRate: number): Promise<TextDecoderStream> {
    const g = await load();
    return new TextDecoderStream(g, g.init(parameters(g, inputRate)));
  }

  /** Returns the text of a message completed by this chunk, if any. */
  push(samples: Float32Array): string | null {
    const bytes = new Int8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    const out = this.g.decode(this.instance, bytes);
    return out.length > 0 ? new TextDecoder().decode(out.slice()) : null;
  }

  free(): void {
    this.g.free(this.instance);
  }
}
