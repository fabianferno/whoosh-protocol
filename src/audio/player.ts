import { encodeWav } from './wav.ts';

export interface Playback {
  /** Resolves when playback ends or is stopped. */
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
  const done = new Promise<void>((resolve) => (finish = resolve));
  const cleanup = () => {
    URL.revokeObjectURL(url);
    finish();
  };
  audio.addEventListener('ended', cleanup, { once: true });
  audio.addEventListener('error', cleanup, { once: true });
  audio.play().catch(cleanup);

  return {
    done,
    stop: () => {
      audio.pause();
      cleanup();
    },
  };
}
