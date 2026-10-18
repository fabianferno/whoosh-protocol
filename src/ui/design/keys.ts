// Keycap feel: every press travels the full distance and makes a mechanical click;
// toggle switches snap with a higher-pitched click.
// Call once per page with mountKeys().

const KEYS = '.btn, .icon-btn, .page-btn';
const MIN_DOWN_MS = 90; // a quick tap still shows the key bottoming out

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

/** A short synthesized key click: a bright plastic tick over a low thock. `pitch` > 1 is snappier. */
function click(pitch = 1): void {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  if (!noise) {
    noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.03), ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const t = ctx.currentTime;
  const vary = pitch * (0.94 + Math.random() * 0.12);

  const tick = ctx.createBufferSource();
  tick.buffer = noise;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 3400 * vary;
  band.Q.value = 0.9;
  const tickGain = ctx.createGain();
  tickGain.gain.setValueAtTime(0.0001, t);
  tickGain.gain.exponentialRampToValueAtTime(0.5, t + 0.001);
  tickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
  tick.connect(band).connect(tickGain).connect(ctx.destination);
  tick.start(t);

  const thock = ctx.createOscillator();
  thock.type = 'sine';
  thock.frequency.setValueAtTime(190 * vary, t);
  thock.frequency.exponentialRampToValueAtTime(85 * pitch, t + 0.045);
  const thockGain = ctx.createGain();
  thockGain.gain.setValueAtTime(0.0001, t);
  thockGain.gain.exponentialRampToValueAtTime(0.35, t + 0.003);
  thockGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
  thock.connect(thockGain).connect(ctx.destination);
  thock.start(t);
  thock.stop(t + 0.07);
}

function press(key: HTMLElement): void {
  if ((key as HTMLButtonElement).disabled || key.classList.contains('is-down')) return;
  key.classList.add('is-down');
  key.dataset.downAt = String(performance.now());
  click();
}

function release(key: HTMLElement): void {
  if (!key.classList.contains('is-down')) return;
  const held = performance.now() - Number(key.dataset.downAt ?? 0);
  setTimeout(() => key.classList.remove('is-down'), Math.max(0, MIN_DOWN_MS - held));
}

export function mountKeys(): void {
  const keyAt = (target: EventTarget | null) => (target as Element | null)?.closest<HTMLElement>(KEYS) ?? null;

  document.addEventListener('pointerdown', (e) => {
    const key = keyAt(e.target);
    if (key && e.button === 0) press(key);
  });
  const up = () => document.querySelectorAll<HTMLElement>(`:is(${KEYS}).is-down`).forEach(release);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);

  document.addEventListener('keydown', (e) => {
    const key = keyAt(e.target);
    if (key && !e.repeat && (e.key === ' ' || e.key === 'Enter')) press(key);
  });
  // Toggles click when they flip, whether by pointer or keyboard.
  document.addEventListener('change', (e) => {
    if ((e.target as Element).matches('.switch input')) click(1.3);
  });

  document.addEventListener('keyup', (e) => {
    const key = keyAt(e.target);
    if (key && (e.key === ' ' || e.key === 'Enter')) release(key);
  });
}
