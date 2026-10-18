declare module 'ggwave' {
  interface Parameters {
    payloadLength: number;
    sampleRateInp: number;
    sampleRateOut: number;
    sampleRate: number;
    samplesPerFrame: number;
    soundMarkerThreshold: number;
    sampleFormatInp: unknown;
    sampleFormatOut: unknown;
    operatingMode: number;
  }
  interface Ggwave {
    getDefaultParameters(): Parameters;
    init(parameters: Parameters): number;
    free(instance: number): void;
    /** Float32 waveform as raw bytes. The view is reused by the next call, so copy it. */
    encode(instance: number, data: string | Uint8Array, protocol: unknown, volume: number): Int8Array;
    /** Decoded payload bytes (empty when no message has completed). */
    decode(instance: number, samples: Int8Array): Int8Array;
    disableLog(): void;
    ProtocolId: Record<string, unknown>;
    SampleFormat: Record<string, unknown>;
  }
  const factory: () => Promise<Ggwave>;
  export default factory;
}
