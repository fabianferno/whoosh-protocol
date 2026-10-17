import './styles.css';
import { Receiver, type ReceiverEvent } from '../app/receiver.ts';
import { prepareSend, SEND_RATE, type PreparedSend } from '../app/sender.ts';
import { CaptureError, startCapture, type Capture } from '../audio/capture.ts';
import { playSamples, type Playback } from '../audio/player.ts';
import { MessageError } from '../message/message.ts';
import { TONE_COUNT, GROUPS } from '../modem/params.ts';

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

let prepared: PreparedSend | null = null;
let preparedFor = '';
let playback: Playback | null = null;
let sending = false;

function prepare(): PreparedSend | null {
  if (prepared && preparedFor === text.value) return prepared;
  try {
    prepared = prepareSend(text.value);
    preparedFor = text.value;
    return prepared;
  } catch (error) {
    prepared = null;
    if (!(error instanceof MessageError)) throw error;
    hint.textContent = error.code === 'empty' ? 'Type a message. Up to 512 bytes.' : error.message;
    return null;
  }
}

let timer = 0;
text.addEventListener('input', () => {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    const p = prepare();
    if (p) {
      const kind = p.mode === 'dict' ? 'dictionary mode' : 'text';
      hint.textContent = `${kind}, ${p.chunks} ${p.chunks === 1 ? 'burst' : 'bursts'}, about ${p.seconds.toFixed(1)} s`;
    }
  }, 150);
});

async function runSend(): Promise<void> {
  const p = prepare();
  if (!p) return;
  sending = true;
  sendBtn.textContent = 'Stop';
  sendStatus.textContent = 'Playing. Hold the speaker near the other device and turn the volume up.';
  try {
    do {
      playback = playSamples(p.samples, SEND_RATE);
      await playback.done;
      if (sending && loop.checked) await new Promise((r) => setTimeout(r, 500));
    } while (sending && loop.checked);
  } finally {
    sending = false;
    playback = null;
    sendBtn.textContent = 'Send as sound';
    sendStatus.textContent = '';
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

// ---- receive ----
const listenBtn = $<HTMLButtonElement>('listenBtn');
const level = $('level');
const recvStatus = $('recvStatus');
const inbox = $<HTMLUListElement>('inbox');

let capture: Capture | null = null;
let receiver: Receiver | null = null;

function handle(events: ReceiverEvent[]): void {
  for (const event of events) {
    if (event.kind === 'progress' && event.progress.received < event.progress.total) {
      recvStatus.textContent = `Receiving: ${event.progress.received} of ${event.progress.total} bursts`;
    } else if (event.kind === 'message') {
      recvStatus.textContent = 'Listening.';
      const li = document.createElement('li');
      const body = document.createElement('p');
      body.textContent = event.text;
      const meta = document.createElement('small');
      meta.textContent = `${new Date().toLocaleTimeString()} · ${event.dictionary ? 'dictionary' : 'text'}`;
      li.append(body, meta);
      inbox.prepend(li);
    }
  }
}

function onSamples(samples: Float32Array): void {
  let sum = 0;
  for (const v of samples) sum += v * v;
  level.style.width = `${Math.min(100, Math.sqrt(sum / samples.length) * 400)}%`;
  if (receiver) handle(receiver.push(samples));
}

function stopListening(): void {
  capture?.stop();
  capture = null;
  receiver = null;
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
    receiver = new Receiver(started.rate);
    listenBtn.textContent = 'Stop listening';
    recvStatus.textContent = 'Listening.';
  } catch (error) {
    recvStatus.textContent = error instanceof CaptureError ? error.message : `Could not start: ${String(error)}`;
  } finally {
    listenBtn.disabled = false;
  }
});

// ---- diagnostics ----
const stats = $('stats');
const tones = $('tones');
tones.append(
  ...Array.from({ length: TONE_COUNT * GROUPS }, () => {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.append(document.createElement('i'));
    return bar;
  }),
);

function renderDiagnostics(): void {
  if (!$('diag').hidden) {
    const s = receiver?.getStats();
    const rows: [string, string][] = [
      ['Listening', capture ? `yes, ${capture.rate} Hz` : 'no'],
      ['Last preamble score', s ? s.lastPreambleScore.toFixed(2) : '-'],
      ['Messages decoded', s ? String(s.framesDecoded) : '-'],
      ['Bursts rejected', s ? String(s.framesRejected) : '-'],
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
    const levels = s?.toneLevels ?? [];
    const peak = Math.max(1e-12, ...levels);
    tones.querySelectorAll<HTMLElement>('.bar i').forEach((bar, i) => {
      bar.style.height = `${Math.round(((levels[i] ?? 0) / peak) * 100)}%`;
    });
  }
  requestAnimationFrame(renderDiagnostics);
}
requestAnimationFrame(renderDiagnostics);
