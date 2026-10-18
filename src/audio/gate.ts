import type { Band } from './ggwave.ts';

/** Probe frequencies are 200 Hz apart; a frame of 10 ms resolves about 100 Hz. */
const STEP_HZ = 200;
const FRAME_SEC = 0.01;
/** PRD: open after 3 consecutive frames above floor + margin, close after 10 below. */
const OPEN_FRAMES = 3;
const CLOSE_FRAMES = 10;
/** Band energy must beat the noise floor by this much (dB)... */
const MARGIN_DB = 6;
/** ...and beat the guard bands just outside it by this much, which rejects broadband noise and clicks. */
const RATIO_DB = 6;
/** The floor follows downward moves at once and creeps upward at 2 dB per second. */
const FLOOR_RISE_DB_PER_FRAME = 0.02;
/** Audio kept from before the gate opened (ggwave needs its start marker), and after it closes. */
const PREROLL_FRAMES = 50;
const HANGOVER_FRAMES = 30;
/** A carrier that never ends (a steady tone) is released after this long so the floor can re-learn. */
const MAX_OPEN_FRAMES = 1500;

interface Region {
  signal: [number, number];
  guards: [number, number][];
  /** Detector high-pass corner. */
  highpassHz: number;
}

// ggwave ultrasound tones span about 15.2-19.3 kHz, so the corner sits below that, not at the PRD's 16 kHz.
const REGIONS: Record<Band, Region> = {
  ultrasound: { signal: [15000, 19600], guards: [[12000, 14600], [19900, 22000]], highpassHz: 11000 },
  audible: { signal: [1800, 6500], guards: [[400, 1500], [6800, 9000]], highpassHz: 300 },
};

export interface GateResult {
  /** Audio to hand to the decoder (pre-roll, then every frame while open, then a short tail), or null. */
  audio: Float32Array | null;
  /** The gate opened during this call: start a fresh decoder. */
  opened: boolean;
  closed: boolean;
}

export interface GateStats {
  open: boolean;
  bandDb: number;
  guardDb: number;
  floorDb: number;
}

const db = (power: number) => 10 * Math.log10(power + 1e-14);

/**
 * Carrier detector: wakes the decoder only while the Whoosh band carries a narrowband signal.
 * High-pass biquad, Goertzel energy in the band versus guard bands, adaptive noise floor, hysteresis.
 */
export class CarrierGate {
  private readonly frameSize: number;
  private readonly signalProbes: number[];
  private readonly guardProbes: number[];
  private readonly window: Float32Array;
  private readonly windowEnergy: number;
  // high-pass biquad coefficients and state
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  private pending = new Float32Array(0);
  private ring: Float32Array[] = [];
  private floorDb = Number.NaN;
  private above = 0;
  private below = 0;
  private hangover = 0;
  private openFrames = 0;
  private isOpen = false;
  private last = { bandDb: -140, guardDb: -140 };

  constructor(private readonly rate: number, band: Band) {
    const region = REGIONS[band];
    this.frameSize = Math.round(rate * FRAME_SEC);
    const limit = rate / 2 - 300;
    const probes = ([lo, hi]: [number, number]) => {
      const out: number[] = [];
      for (let f = lo; f <= hi && f < limit; f += STEP_HZ) out.push(f);
      return out;
    };
    this.signalProbes = probes(region.signal);
    this.guardProbes = region.guards.flatMap(probes);
    this.window = Float32Array.from({ length: this.frameSize }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.frameSize - 1)));
    this.windowEnergy = this.window.reduce((a, w) => a + w * w, 0);

    // RBJ high-pass, Q = 1/sqrt(2)
    const w0 = (2 * Math.PI * Math.min(region.highpassHz, limit)) / rate;
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    this.b0 = (1 + Math.cos(w0)) / 2 / a0;
    this.b1 = -(1 + Math.cos(w0)) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * Math.cos(w0)) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  get stats(): GateStats {
    return { open: this.isOpen, bandDb: this.last.bandDb, guardDb: this.last.guardDb, floorDb: Number.isNaN(this.floorDb) ? -140 : this.floorDb };
  }

  push(samples: Float32Array): GateResult {
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending);
    joined.set(samples, this.pending.length);

    const out: Float32Array[] = [];
    const result: GateResult = { audio: null, opened: false, closed: false };
    let at = 0;
    for (; at + this.frameSize <= joined.length; at += this.frameSize) {
      this.frame(joined.slice(at, at + this.frameSize), out, result);
    }
    this.pending = joined.slice(at);

    if (out.length > 0) {
      const audio = new Float32Array(out.length * this.frameSize);
      out.forEach((f, i) => audio.set(f, i * this.frameSize));
      result.audio = audio;
    }
    return result;
  }

  private measure(frame: Float32Array): { bandDb: number; guardDb: number } {
    const n = frame.length;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const y = this.b0 * frame[i] + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1;
      this.x1 = frame[i];
      this.y2 = this.y1;
      this.y1 = y;
      x[i] = y * this.window[i];
    }
    const meanPower = (freqs: number[]) => {
      if (freqs.length === 0) return 0;
      let total = 0;
      for (const hz of freqs) {
        const coeff = 2 * Math.cos((2 * Math.PI * hz) / this.rate);
        let s1 = 0;
        let s2 = 0;
        for (let i = 0; i < n; i++) {
          const s = x[i] + coeff * s1 - s2;
          s2 = s1;
          s1 = s;
        }
        total += (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (this.windowEnergy * n);
      }
      return total / freqs.length;
    };
    return { bandDb: db(meanPower(this.signalProbes)), guardDb: db(meanPower(this.guardProbes)) };
  }

  private frame(frame: Float32Array, out: Float32Array[], result: GateResult): void {
    this.ring.push(frame);
    if (this.ring.length > PREROLL_FRAMES) this.ring.shift();

    const { bandDb, guardDb } = this.measure(frame);
    this.last = { bandDb, guardDb };
    if (Number.isNaN(this.floorDb)) this.floorDb = bandDb;
    const hot = bandDb > this.floorDb + MARGIN_DB && bandDb - guardDb > RATIO_DB;

    if (!this.isOpen) {
      this.floorDb = Math.min(this.floorDb + FLOOR_RISE_DB_PER_FRAME, bandDb);
      this.above = hot ? this.above + 1 : 0;
      if (this.above >= OPEN_FRAMES) {
        this.isOpen = true;
        this.below = 0;
        this.hangover = 0;
        this.openFrames = 0;
        result.opened = true;
        out.push(...this.ring);
      }
      return;
    }

    out.push(frame);
    this.openFrames++;
    if (this.hangover > 0) {
      if (hot) {
        this.hangover = 0;
        this.below = 0;
      } else if (--this.hangover === 0) this.close(result, bandDb);
      return;
    }
    this.below = hot ? 0 : this.below + 1;
    if (this.below >= CLOSE_FRAMES) this.hangover = HANGOVER_FRAMES;
    else if (this.openFrames >= MAX_OPEN_FRAMES) this.close(result, bandDb);
  }

  private close(result: GateResult, bandDb: number): void {
    this.isOpen = false;
    this.above = 0;
    this.below = 0;
    // Re-learn the floor from here: whatever held the gate open is now background.
    this.floorDb = bandDb;
    result.closed = true;
  }
}
