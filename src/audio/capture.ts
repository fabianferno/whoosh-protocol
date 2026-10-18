export type CaptureErrorCode = 'unsupported' | 'denied' | 'no-device' | 'failed';

export class CaptureError extends Error {
  constructor(readonly code: CaptureErrorCode, message: string) {
    super(message);
  }
}

/** PRD: refuse to run below 44.1 kHz. */
const MIN_RATE = 44100;

export interface Capture {
  /** Sample rate the browser is actually delivering. */
  rate: number;
  /** What the browser actually applied (it may ignore what was requested). */
  settings: MediaTrackSettings;
  /** True if the browser kept echo cancellation, noise suppression or auto gain on, which distorts tones. */
  voiceProcessing: boolean;
  stop(): void;
}

/** Posts the input in blocks of 4096 samples, to keep the number of messages (and decoder pushes) low. */
const WORKLET_SOURCE = `
class WhooshCapture extends AudioWorkletProcessor {
  constructor() { super(); this.block = new Float32Array(4096); this.at = 0; }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.block[this.at++] = input[i];
        if (this.at === this.block.length) { this.port.postMessage(this.block); this.block = new Float32Array(4096); this.at = 0; }
      }
    }
    return true;
  }
}
registerProcessor('whoosh-capture', WhooshCapture);
`;

/**
 * Starts the microphone. Call from a tap: the AudioContext is created before any await so iOS
 * still treats it as user-initiated. Echo cancellation, noise suppression and auto gain are off
 * because they distort tones.
 */
export async function startCapture(onSamples: (samples: Float32Array) => void): Promise<Capture> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new CaptureError('unsupported', 'Microphone access needs a secure (https) page in a supported browser.');
  }
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  } catch (error) {
    void ctx.close();
    const name = (error as DOMException).name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new CaptureError('denied', 'Microphone permission was denied. Allow it in the browser settings and try again.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new CaptureError('no-device', 'No microphone was found.');
    }
    throw new CaptureError('failed', `Could not start the microphone: ${(error as Error).message}`);
  }

  await ctx.resume();
  const settings = stream.getAudioTracks()[0]?.getSettings() ?? {};
  if (ctx.sampleRate < MIN_RATE) {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    throw new CaptureError('unsupported', `This device captures audio at ${ctx.sampleRate} Hz; Whoosh needs at least ${MIN_RATE} Hz.`);
  }
  const source = ctx.createMediaStreamSource(stream);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);

  let teardown: () => void;
  if (ctx.audioWorklet) {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, 'whoosh-capture');
    node.port.onmessage = (e: MessageEvent<Float32Array>) => onSamples(e.data);
    source.connect(node).connect(mute);
    teardown = () => {
      node.port.onmessage = null;
      node.disconnect();
    };
  } else {
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => onSamples(e.inputBuffer.getChannelData(0).slice());
    source.connect(node);
    node.connect(mute);
    teardown = () => {
      node.onaudioprocess = null;
      node.disconnect();
    };
  }

  return {
    rate: ctx.sampleRate,
    settings,
    voiceProcessing: Boolean(settings.echoCancellation || settings.noiseSuppression || settings.autoGainControl),
    stop: () => {
      teardown();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
