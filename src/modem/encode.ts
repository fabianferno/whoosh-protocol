import { packFrame, type Frame } from './frame.ts';
import {
  AMPLITUDE, GROUPS, CHIRP_F0, CHIRP_F1, CHIRP_SEC, GUARD_SEC, LEAD_SEC, RAMP_SEC, SYMBOL_SEC, TAIL_SEC, toneHz,
} from './params.ts';

/** Linear chirp. quadrature=true gives the 90-degree-shifted copy used for phase-insensitive detection. */
export function chirpTemplate(rate: number, quadrature = false): Float32Array {
  const n = Math.round(CHIRP_SEC * rate);
  const out = new Float32Array(n);
  const k = (CHIRP_F1 - CHIRP_F0) / CHIRP_SEC;
  const taper = Math.round(n * 0.1);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let env = 1;
    if (i < taper) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / taper);
    else if (i >= n - taper) env = 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / taper);
    out[i] = env * Math.sin(2 * Math.PI * (CHIRP_F0 * t + 0.5 * k * t * t) + (quadrature ? Math.PI / 2 : 0));
  }
  return out;
}

export function bytesToNibbles(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (const b of bytes) out.push(b >> 4, b & 0xf);
  return out;
}

export function encodeBytes(bytes: Uint8Array, rate: number): Float32Array {
  const nibbles = bytesToNibbles(bytes);
  const nSym = nibbles.length / GROUPS;
  const symLen = SYMBOL_SEC * rate;
  const chirp = chirpTemplate(rate);
  const lead = Math.round(LEAD_SEC * rate);
  const guard = Math.round(GUARD_SEC * rate);
  const tail = Math.round(TAIL_SEC * rate);
  const total = lead + chirp.length + guard + Math.ceil(nSym * symLen) + tail;
  const out = new Float32Array(total);
  for (let i = 0; i < chirp.length; i++) out[lead + i] = AMPLITUDE * chirp[i];
  const symStart = lead + chirp.length + guard;
  const ramp = Math.round(RAMP_SEC * rate);
  for (let k = 0; k < nSym; k++) {
    const s0 = Math.round(symStart + k * symLen);
    const s1 = Math.round(symStart + (k + 1) * symLen);
    const ws: number[] = [];
    for (let g = 0; g < GROUPS; g++) ws.push(2 * Math.PI * toneHz(nibbles[k * GROUPS + g], g));
    for (let i = s0; i < s1; i++) {
      const j = i - s0;
      let env = 1;
      if (j < ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * j) / ramp);
      else if (s1 - 1 - i < ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * (s1 - 1 - i)) / ramp);
      let sum = 0;
      for (const w of ws) sum += Math.sin((w * j) / rate);
      out[i] = (AMPLITUDE / GROUPS) * env * sum;
    }
  }
  return out;
}

export function encodeFrame(frame: Frame, rate: number): Float32Array {
  return encodeBytes(packFrame(frame), rate);
}
