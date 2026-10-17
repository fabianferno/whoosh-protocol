import { chirpTemplate } from './encode.ts';
import {
  bodyBlockBytes, HEADER_BLOCK_BYTES, parseBodyBlock, parseHeaderBlock, type Frame, type FrameHeader,
} from './frame.ts';
import { GROUPS, GUARD_SEC, SYMBOL_SEC, TONE_COUNT, toneHz } from './params.ts';

const THRESHOLD = 0.4;
const MAX_BUFFER_SEC = 30;

export interface DecoderStats {
  lastPreambleScore: number;
  framesDecoded: number;
  framesRejected: number;
  toneLevels: number[];
}

export class Decoder {
  private readonly rate: number;
  private readonly chirp: Float32Array;
  private readonly chirpQ: Float32Array;
  private readonly chirpEnergy: number;
  private readonly coarseStep: number;
  private readonly refine: number;
  private readonly symLen: number;
  private readonly guard: number;
  private buf = new Float32Array(0);
  private scanPos = 0;
  private header: FrameHeader | null = null;
  private bodyStart = 0;
  private stats: DecoderStats = { lastPreambleScore: 0, framesDecoded: 0, framesRejected: 0, toneLevels: new Array(TONE_COUNT * GROUPS).fill(0) };

  constructor(rate: number) {
    this.rate = rate;
    this.chirp = chirpTemplate(rate);
    this.chirpQ = chirpTemplate(rate, true);
    this.coarseStep = Math.max(1, Math.round(rate / 6000));
    this.refine = this.coarseStep * 2;
    this.chirpEnergy = this.chirp.reduce((a, v, i) => (i % 2 === 0 ? a + v * v : a), 0);
    this.symLen = SYMBOL_SEC * rate;
    this.guard = Math.round(GUARD_SEC * rate);
  }

  getStats(): DecoderStats {
    return this.stats;
  }

  /** Feed microphone samples; returns any frames completed by this chunk. */
  push(samples: Float32Array): Frame[] {
    const joined = new Float32Array(this.buf.length + samples.length);
    joined.set(this.buf);
    joined.set(samples, this.buf.length);
    this.buf = joined;
    const frames: Frame[] = [];
    for (;;) {
      const frame = this.step();
      if (frame === undefined) break;
      if (frame) frames.push(frame);
    }
    this.trim();
    return frames;
  }

  /** One state-machine step. undefined = need more data. null = progress, no frame. */
  private step(): Frame | null | undefined {
    if (this.header === null) return this.searchAndHeader();
    return this.readBody();
  }

  private ncc(pos: number): number {
    // Stride 2 halves the cost; the chirp lives below 4 kHz so it is still well sampled.
    let dotI = 0;
    let dotQ = 0;
    let energy = 0;
    const c = this.chirp;
    const q = this.chirpQ;
    const b = this.buf;
    for (let i = 0; i < c.length; i += 2) {
      const v = b[pos + i];
      dotI += v * c[i];
      dotQ += v * q[i];
      energy += v * v;
    }
    if (energy < 1e-9) return 0;
    return Math.sqrt(dotI * dotI + dotQ * dotQ) / Math.sqrt(energy * this.chirpEnergy);
  }

  private searchAndHeader(): Frame | null | undefined {
    const n = this.chirp.length;
    for (let pos = this.scanPos; pos + n + this.refine <= this.buf.length; pos += this.coarseStep) {
      if (this.ncc(pos) < THRESHOLD) {
        this.scanPos = pos + this.coarseStep;
        continue;
      }
      let best = pos;
      let bestScore = -1;
      for (let p = Math.max(this.scanPos, pos - this.refine); p <= pos + this.refine && p + n <= this.buf.length; p++) {
        const s = this.ncc(p);
        if (s > bestScore) {
          bestScore = s;
          best = p;
        }
      }
      this.stats.lastPreambleScore = bestScore;
      const symStart = best + n + this.guard;
      const headerSymbols = Math.ceil((HEADER_BLOCK_BYTES * 2) / GROUPS);
      if (symStart + headerSymbols * this.symLen > this.buf.length) {
        this.scanPos = pos;
        return undefined;
      }
      const header = parseHeaderBlock(this.readBytes(symStart, HEADER_BLOCK_BYTES));
      if (!header) {
        this.stats.framesRejected++;
        this.scanPos = best + n;
        return null;
      }
      this.header = header;
      this.bodyStart = symStart + headerSymbols * this.symLen;
      return null;
    }
    return undefined;
  }

  private readBody(): Frame | null | undefined {
    const header = this.header!;
    const bytes = bodyBlockBytes(header.length);
    if (this.bodyStart + Math.ceil((bytes * 2) / GROUPS) * this.symLen > this.buf.length) return undefined;
    const frame = parseBodyBlock(header, this.readBytes(this.bodyStart, bytes));
    this.scanPos = Math.ceil(this.bodyStart + Math.ceil((bytes * 2) / GROUPS) * this.symLen);
    this.header = null;
    if (frame) this.stats.framesDecoded++;
    else this.stats.framesRejected++;
    return frame;
  }

  private readBytes(start: number, count: number): Uint8Array {
    const out = new Uint8Array(count);
    const nibbles: number[] = [];
    for (let k = 0; k < Math.ceil((count * 2) / GROUPS); k++) nibbles.push(...this.symbolAt(start, k));
    for (let i = 0; i < count; i++) out[i] = (nibbles[i * 2] << 4) | nibbles[i * 2 + 1];
    return out;
  }

  private symbolAt(start: number, k: number): number[] {
    const s0 = start + k * this.symLen;
    const from = Math.round(s0 + 0.1 * this.symLen);
    const to = Math.round(s0 + 0.9 * this.symLen);
    const out: number[] = [];
    for (let g = 0; g < GROUPS; g++) {
      let best = 0;
      let bestPower = -1;
      for (let t = 0; t < TONE_COUNT; t++) {
        const p = this.goertzel(from, to, toneHz(t, g));
        this.stats.toneLevels[g * TONE_COUNT + t] = p;
        if (p > bestPower) {
          bestPower = p;
          best = t;
        }
      }
      out.push(best);
    }
    return out;
  }

  private goertzel(from: number, to: number, hz: number): number {
    const coeff = 2 * Math.cos((2 * Math.PI * hz) / this.rate);
    let s1 = 0;
    let s2 = 0;
    for (let i = from; i < to; i++) {
      const s = this.buf[i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (to - from);
  }

  private trim(): void {
    const keepFrom = Math.max(0, this.header ? 0 : this.scanPos - this.chirp.length);
    const maxLen = MAX_BUFFER_SEC * this.rate;
    let cut = keepFrom;
    if (this.buf.length - cut > maxLen) cut = this.buf.length - maxLen;
    if (cut > 0 && !this.header) {
      this.buf = this.buf.slice(cut);
      this.scanPos = Math.max(0, this.scanPos - cut);
    }
  }
}
