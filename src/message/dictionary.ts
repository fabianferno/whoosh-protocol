import raw from './english.txt?raw';

export const WORDS: readonly string[] = raw.trim().split('\n');
const INDEX = new Map(WORDS.map((word, i) => [word, i]));

const BITS = 11;
/** A 32-byte payload holds 23 words. */
export const MAX_DICT_WORDS = 23;

/** Packs words into 11-bit indices, MSB first. Null if the list is empty, too long, or any word is unknown. */
export function packWords(words: string[]): Uint8Array | null {
  if (words.length === 0 || words.length > MAX_DICT_WORDS) return null;
  const out = new Uint8Array(Math.ceil((words.length * BITS) / 8));
  let bit = 0;
  for (const word of words) {
    const index = INDEX.get(word);
    if (index === undefined) return null;
    for (let b = BITS - 1; b >= 0; b--, bit++) {
      if ((index >> b) & 1) out[bit >> 3] |= 0x80 >> (bit & 7);
    }
  }
  return out;
}

/** Inverse of packWords. Trailing padding bits (always under 8) are ignored. */
export function unpackWords(bytes: Uint8Array): string[] {
  const count = Math.floor((bytes.length * 8) / BITS);
  const words: string[] = [];
  let bit = 0;
  for (let w = 0; w < count; w++) {
    let index = 0;
    for (let b = 0; b < BITS; b++, bit++) index = (index << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
    words.push(WORDS[index]);
  }
  return words;
}
