import { encodeWav } from './wav.ts';

export interface Playback {
  /** Resolves when playback ends or is stopped; rejects if the browser refused to play. */
  done: Promise<void>;
  stop(): void;
}

/**
 * Plays samples through an <audio> element. Unlike Web Audio, this stays audible on iOS when the
 * ringer switch is on silent. Must be called from a user gesture (a tap).
 */
export function playSamples(samples: Float32Array, rate: number, volume = 1): Playback {
  const blob = new Blob([encodeWav(samples, rate)], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.volume = Math.max(0, Math.min(1, volume));

  let finish!: () => void;
  let fail!: (reason: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const cleanup = () => {
    URL.revokeObjectURL(url);
    finish();
  };
  audio.addEventListener('ended', cleanup, { once: true });
  audio.addEventListener('error', () => {
    URL.revokeObjectURL(url);
    fail(new Error('The browser could not play the audio.'));
  }, { once: true });
  audio.play().catch((error: Error) => {
    URL.revokeObjectURL(url);
    fail(new Error(`Playback was blocked: ${error.message}`));
  });

  return {
    done,
    stop: () => {
      audio.pause();
      cleanup();
    },
  };
}
