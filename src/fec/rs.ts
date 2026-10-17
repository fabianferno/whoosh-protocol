const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a: number, b: number): number => (a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255]);
const pow = (a: number, p: number): number => (a === 0 ? 0 : EXP[(LOG[a] * p) % 255]);

function generator(nsym: number): number[] {
  let g = [1];
  for (let i = 0; i < nsym; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

/** Returns msg followed by nsym parity bytes. */
export function rsEncode(msg: Uint8Array, nsym: number): Uint8Array {
  const g = generator(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg);
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i];
    if (coef !== 0) for (let j = 1; j < g.length; j++) out[i + j] ^= mul(g[j], coef);
  }
  out.set(msg);
  return out;
}

/** Corrects up to nsym/2 byte errors. Returns the message (no parity) or null. */
export function rsDecode(word: Uint8Array, nsym: number): Uint8Array | null {
  const n = word.length;
  const w = Uint8Array.from(word);
  const synd = new Array<number>(nsym).fill(0);
  let clean = true;
  for (let j = 0; j < nsym; j++) {
    let y = 0;
    for (let i = 0; i < n; i++) y = mul(y, EXP[j]) ^ w[i];
    synd[j] = y;
    if (y !== 0) clean = false;
  }
  if (clean) return w.slice(0, n - nsym);

  // Berlekamp-Massey: C is the error locator, lowest degree first.
  let C = [1];
  let B = [1];
  let L = 0;
  let m = 1;
  let b = 1;
  for (let i = 0; i < nsym; i++) {
    let d = synd[i];
    for (let k = 1; k <= L; k++) d ^= mul(C[k] ?? 0, synd[i - k]);
    if (d === 0) {
      m++;
      continue;
    }
    const T = C.slice();
    const coef = div(d, b);
    while (C.length < B.length + m) C.push(0);
    for (let k = 0; k < B.length; k++) C[k + m] ^= mul(coef, B[k]);
    if (2 * L <= i) {
      L = i + 1 - L;
      B = T;
      b = d;
      m = 1;
    } else {
      m++;
    }
  }
  while (C.length > 1 && C[C.length - 1] === 0) C.pop();
  if (L === 0 || L * 2 > nsym) return null;

  // Chien search: position p holds power n-1-p.
  const positions: number[] = [];
  for (let pw = 0; pw < n; pw++) {
    const xinv = EXP[(255 - pw) % 255];
    let y = 0;
    for (let k = C.length - 1; k >= 0; k--) y = mul(y, xinv) ^ C[k];
    if (y === 0) positions.push(n - 1 - pw);
  }
  if (positions.length !== L) return null;

  // Omega = S(x) * C(x) mod x^nsym
  const omega = new Array<number>(nsym).fill(0);
  for (let i = 0; i < nsym; i++)
    for (let k = 0; k < C.length && k <= i; k++) omega[i] ^= mul(C[k], synd[i - k]);

  for (const p of positions) {
    const pw = n - 1 - p;
    const x = EXP[pw];
    const xinv = EXP[(255 - pw) % 255];
    let num = 0;
    for (let k = omega.length - 1; k >= 0; k--) num = mul(num, xinv) ^ omega[k];
    let den = 0;
    for (let k = 1; k < C.length; k += 2) den ^= mul(C[k], pow(xinv, k - 1));
    if (den === 0) return null;
    w[p] ^= mul(x, div(num, den));
  }
  // verify
  for (let j = 0; j < nsym; j++) {
    let y = 0;
    for (let i = 0; i < n; i++) y = mul(y, EXP[j]) ^ w[i];
    if (y !== 0) return null;
  }
  return w.slice(0, n - nsym);
}
