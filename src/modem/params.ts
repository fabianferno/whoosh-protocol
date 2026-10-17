/** Tone groups sent at once. Each carries one nibble per symbol. Must be 1 or 2 (every block has an even nibble count). */
export const GROUPS = 2;
export const TONE_COUNT = 16;
export const BASE_HZ = 1800;
export const SYMBOL_SEC = 0.045;
/** 3 FFT bins at the symbol length, so neighbouring tones stay orthogonal. */
export const SPACING_HZ = 3 / SYMBOL_SEC;
export const RAMP_SEC = 0.005;
export const CHIRP_SEC = 0.15;
export const CHIRP_F0 = 1600;
export const CHIRP_F1 = 4000;
export const GUARD_SEC = 0.01;
export const LEAD_SEC = 0.15;
export const TAIL_SEC = 0.15;
export const AMPLITUDE = 0.9;

export const HEADER_BYTES = 4;
export const HEADER_PARITY = 4;
export const BODY_PARITY = 8;
export const MAX_PAYLOAD = 32;

/** Frequency of tone `index` (0-15) in group `group`. */
export const toneHz = (index: number, group = 0): number =>
  BASE_HZ + (group * TONE_COUNT + index) * SPACING_HZ;
