import factory from 'ggwave';

export type Band = 'ultrasound' | 'audible';

/** The PRD caps messages at about 100 bytes (airtime); ggwave itself allows 140. */
export const MAX_BYTES = 100;
/** Largest payload ggwave accepts in variable-length mode. */
export const MAX_PACKET_BYTES = 140;
/** Sample rate of generated waveforms. */
export const TX_RATE = 48000;

const PROTOCOL: Record<Band, string> = {
  ultrasound: 'GGWAVE_PROTOCOL_ULTRASOUND_FAST',
  audible: 'GGWAVE_PROTOCOL_AUDIBLE_FAST',
};

type Ggwave = Awaited<ReturnType<typeof factory>>;
let loading: Promise<Ggwave> | null = null;
let loaded: Ggwave | null = null;

/** Resolves once the WebAssembly module is loaded, so WaveDecoder.createLoaded can be used synchronously. */
export const ready = (): Promise<unknown> => load();

function load(): Promise<Ggwave> {
  loading ??= factory().then((g) => {
    g.disableLog();
    loaded = g;
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

async function encode(data: string | Uint8Array, band: Band, volume: number): Promise<Float32Array> {
  const g = await load();
  const instance = g.init(parameters(g, TX_RATE));
  try {
    const raw = g.encode(instance, data, g.ProtocolId[PROTOCOL[band]], volume);
    if (raw.byteLength === 0) throw new Error('ggwave could not encode this message');
    // Copy out of ggwave's reused buffer into a properly aligned Float32Array.
    return new Float32Array(raw.slice().buffer);
  } finally {
    g.free(instance);
  }
}

/** Waveform (mono, TX_RATE) for `text`. Throws TooLongError or Error('Nothing to send'). */
export async function encodeText(text: string, band: Band, volume = 50): Promise<Float32Array> {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes === 0) throw new Error('Nothing to send');
  if (bytes > MAX_BYTES) throw new TooLongError(`${bytes} bytes; the limit is ${MAX_BYTES}`);
  return encode(text, band, volume);
}

/** Waveform for arbitrary bytes (a packet), up to MAX_PACKET_BYTES. */
export async function encodeBytes(bytes: Uint8Array, band: Band, volume = 50): Promise<Float32Array> {
  if (bytes.length === 0) throw new Error('Nothing to send');
  if (bytes.length > MAX_PACKET_BYTES) throw new TooLongError(`${bytes.length} bytes; the limit is ${MAX_PACKET_BYTES}`);
  return encode(bytes, band, volume);
}

/** Feeds microphone samples to ggwave; any protocol (audible or ultrasound) is accepted. */
export class WaveDecoder {
  private constructor(private readonly g: Ggwave, private readonly instance: number) {}

  static async create(inputRate: number): Promise<WaveDecoder> {
    const g = await load();
    return new WaveDecoder(g, g.init(parameters(g, inputRate)));
  }

  /** Synchronous create for after `await ready()`: lets a gate start a fresh decoder the moment it opens. */
  static createLoaded(inputRate: number): WaveDecoder {
    if (!loaded) throw new Error('ggwave is not loaded yet; await ready() first');
    return new WaveDecoder(loaded, loaded.init(parameters(loaded, inputRate)));
  }

  /** Returns the payload bytes of a message completed by this chunk, if any. */
  pushBytes(samples: Float32Array): Uint8Array | null {
    const bytes = new Int8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    const out = this.g.decode(this.instance, bytes);
    return out.length > 0 ? Uint8Array.from(out) : null;
  }

  /** Like pushBytes, decoded as UTF-8 text. */
  push(samples: Float32Array): string | null {
    const out = this.pushBytes(samples);
    return out ? new TextDecoder().decode(out) : null;
  }

  free(): void {
    this.g.free(this.instance);
  }
}
