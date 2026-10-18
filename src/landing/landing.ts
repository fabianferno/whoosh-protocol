import './landing.css';
import { mountKeys } from '../ui/design/keys.ts';

mountKeys();

// ---- decorative spectrum: a carrier bursts in the ultrasound band, then the room goes quiet ----
const BARS = 44; // 0.5 to 22 kHz, as on the app's Debug screen
const HZ_PER_BAR = 22_000 / BARS;
const inBand = (i: number) => i * HZ_PER_BAR >= 15_000 && i * HZ_PER_BAR <= 19_500;

const scope = document.getElementById('scope')!;
const badge = document.getElementById('scopeBadge')!;
const hex = document.getElementById('scopeHex')!;
const fills: HTMLElement[] = [];
for (let i = 0; i < BARS; i++) {
  const bar = document.createElement('div');
  bar.className = inBand(i) ? 'bar us' : 'bar';
  const fill = document.createElement('i');
  bar.append(fill);
  scope.append(bar);
  fills.push(fill);
}

const randomHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join(' ') + ' ...';

/** Room noise falling off with frequency, plus a carrier when `on`. */
function frame(on: boolean, t: number): void {
  for (let i = 0; i < BARS; i++) {
    const noise = 0.32 * Math.exp(-i / 9) + Math.random() * 0.08;
    const tone = on && inBand(i) ? 0.55 + 0.35 * Math.abs(Math.sin(t / 90 + i * 1.7)) : 0;
    fills[i].style.height = `${Math.min(1, noise + tone) * 100}%`;
  }
  badge.classList.toggle('off', !on);
}

if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
  frame(true, 0);
} else {
  const BURST_MS = 2400;
  const QUIET_MS = 1600;
  const start = performance.now();
  let wasOn = false;
  const tick = (now: number) => {
    const phase = (now - start) % (BURST_MS + QUIET_MS);
    const on = phase < BURST_MS;
    if (on && !wasOn) hex.textContent = randomHex();
    wasOn = on;
    frame(on, now);
    setTimeout(() => requestAnimationFrame(tick), 70);
  };
  requestAnimationFrame(tick);
}
