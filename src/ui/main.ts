import './styles.css';
import { CaptureError, startCapture, type Capture } from '../audio/capture.ts';
import { playSamples, type Playback } from '../audio/player.ts';
import { encodeText, MAX_BYTES, TextDecoderStream, TooLongError, TX_RATE, type Band } from '../audio/ggwave.ts';
import { BAR_HZ, barLevels } from '../audio/spectrum.ts';
import { mountKeys } from './design/keys.ts';

mountKeys();

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---- tabs ----
const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')];
function showTab(name: string): void {
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const id of ['send', 'receive', 'diag']) $(id).hidden = id !== name;
}
tabs.forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab!)));

// ---- send ----
const text = $<HTMLTextAreaElement>('text');
const hint = $('hint');
const sendBtn = $<HTMLButtonElement>('sendBtn');
const sendStatus = $('sendStatus');
const loop = $<HTMLInputElement>('loop');

const band = (): Band => document.querySelector<HTMLInputElement>('input[name=band]:checked')!.value as Band;
const byteLength = (s: string) => new TextEncoder().encode(s).length;

let prepared: { key: string; samples: Float32Array } | null = null;
let playback: Playback | null = null;
let sending = false;

/** Encodes the current text; resolves null (and explains why in the hint) if it cannot be sent. */
async function prepare(): Promise<Float32Array | null> {
  const key = `${band()}|${text.value}`;
  if (prepared?.key === key) return prepared.samples;
  prepared = null;
  const bytes = byteLength(text.value);
  if (text.value.trim() === '') {
    hint.textContent = `Type a message. Up to ${MAX_BYTES} bytes.`;
    return null;
  }
  try {
    const samples = await encodeText(text.value, band());
    prepared = { key, samples };
    hint.textContent = `${bytes} / ${MAX_BYTES} bytes · about ${(samples.length / TX_RATE).toFixed(1)} s`;
    return samples;
  } catch (error) {
    hint.textContent = error instanceof TooLongError ? `Too long: ${error.message}` : (error as Error).message;
    return null;
  }
}

let timer = 0;
const schedulePrepare = () => {
  clearTimeout(timer);
  timer = window.setTimeout(() => void prepare(), 150);
};
text.addEventListener('input', schedulePrepare);
document.querySelectorAll('input[name=band]').forEach((r) => r.addEventListener('change', schedulePrepare));

async function runSend(): Promise<void> {
  const samples = await prepare();
  if (!samples) {
    sendStatus.textContent = text.value.trim() === '' ? 'Type a message first.' : hint.textContent;
    return;
  }
  sending = true;
  sendBtn.textContent = 'Stop';
  sendStatus.textContent = 'Playing. Hold the speaker near the other device and turn the volume up.';
  try {
    do {
      playback = playSamples(samples, TX_RATE);
      await playback.done;
      if (sending && loop.checked) await new Promise((r) => setTimeout(r, 500));
    } while (sending && loop.checked);
    sendStatus.textContent = 'Sent.';
  } catch (error) {
    sendStatus.textContent = (error as Error).message;
  } finally {
    sending = false;
    playback = null;
    sendBtn.textContent = 'Send as sound';
  }
}

sendBtn.addEventListener('click', () => {
  if (sending) {
    sending = false;
    playback?.stop();
    return;
  }
  void runSend();
});

$('beepBtn').addEventListener('click', () => {
  const hz = band() === 'ultrasound' ? 18000 : 2500;
  const beep = new Float32Array(TX_RATE);
  for (let i = 0; i < beep.length; i++) beep[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / TX_RATE);
  sendStatus.textContent = `Playing a 1 second beep at ${hz / 1000} kHz.`;
  playSamples(beep, TX_RATE).done.catch((error: Error) => (sendStatus.textContent = error.message));
});

// ---- receive ----
const listenBtn = $<HTMLButtonElement>('listenBtn');
const level = $('level');
const recvStatus = $('recvStatus');
const inbox = $<HTMLUListElement>('inbox');

let capture: Capture | null = null;
let decoder: TextDecoderStream | null = null;
let bars: number[] = new Array(BAR_HZ.length).fill(0);
let decoded = 0;

function show(message: string): void {
  decoded++;
  const li = document.createElement('li');
  const body = document.createElement('p');
  body.textContent = message;
  const meta = document.createElement('small');
  meta.textContent = new Date().toLocaleTimeString();
  li.append(body, meta);
  inbox.prepend(li);
  // One message per listen: stop the microphone as soon as it has arrived.
  stopListening();
  recvStatus.textContent = 'Message received. Tap Start listening for another.';
}

function onSamples(samples: Float32Array): void {
  let sum = 0;
  for (const v of samples) sum += v * v;
  level.style.width = `${Math.min(100, Math.sqrt(sum / samples.length) * 400)}%`;
  if (capture) bars = barLevels(samples, capture.rate);
  const message = decoder?.push(samples);
  if (message) show(message);
}

function stopListening(): void {
  capture?.stop();
  capture = null;
  decoder?.free();
  decoder = null;
  bars = bars.map(() => 0);
  level.style.width = '0%';
  listenBtn.textContent = 'Start listening';
  recvStatus.textContent = 'Not listening.';
}

listenBtn.addEventListener('click', async () => {
  if (capture) {
    stopListening();
    return;
  }
  listenBtn.disabled = true;
  try {
    const started = await startCapture(onSamples);
    capture = started;
    decoder = await TextDecoderStream.create(started.rate);
    listenBtn.textContent = 'Stop listening';
    recvStatus.textContent = 'Listening.';
  } catch (error) {
    capture?.stop();
    capture = null;
    recvStatus.textContent = error instanceof CaptureError ? error.message : `Could not start: ${String(error)}`;
  } finally {
    listenBtn.disabled = false;
  }
});

// ---- diagnostics ----
const stats = $('stats');
const tones = $('tones');
tones.append(
  ...BAR_HZ.map((hz) => {
    const bar = document.createElement('div');
    bar.className = hz >= 15000 && hz <= 19500 ? 'bar us' : 'bar';
    bar.append(document.createElement('i'));
    return bar;
  }),
);

function renderDiagnostics(): void {
  if (!$('diag').hidden) {
    const ultra = Math.max(0, ...bars.filter((_, i) => BAR_HZ[i] >= 15000 && BAR_HZ[i] <= 19500));
    const rows: [string, string][] = [
      ['Listening', capture ? `yes, ${capture.rate} Hz` : 'no'],
      ['Ultrasound band level', capture ? `${Math.round(ultra * 100)}%` : '-'],
      ['Messages received', String(decoded)],
    ];
    stats.replaceChildren(
      ...rows.flatMap(([k, v]) => {
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = k;
        dd.textContent = v;
        return [dt, dd];
      }),
    );
    tones.querySelectorAll<HTMLElement>('.bar i').forEach((bar, i) => {
      bar.style.height = `${Math.round((bars[i] ?? 0) * 100)}%`;
    });
  }
  requestAnimationFrame(renderDiagnostics);
}
requestAnimationFrame(renderDiagnostics);
