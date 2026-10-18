import './styles.css';
import { estimateSeconds, PacketInbox, prepareSecureSend } from '../app/secure.ts';
import { CaptureError, startCapture, type Capture } from '../audio/capture.ts';
import { CarrierGate } from '../audio/gate.ts';
import { ready, TX_RATE, WaveDecoder, type Band } from '../audio/ggwave.ts';
import { playSamples, type Playback } from '../audio/player.ts';
import { BAR_HZ, barLevels } from '../audio/spectrum.ts';
import { MAX_PLAINTEXT_BYTES } from '../packet/format.ts';
import {
  deriveGroupKeys, generatePassphrase, PassphraseError, type GroupKeys,
} from '../packet/keys.ts';
import { SenderIdentity } from '../packet/session.ts';
import { clearKeys, loadKeys, saveKeys } from '../storage/keystore.ts';
import { mountKeys } from './design/keys.ts';

mountKeys();

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const radio = (name: string): Band => document.querySelector<HTMLInputElement>(`input[name=${name}]:checked`)!.value as Band;
const byteLength = (s: string) => new TextEncoder().encode(s).length;

// ---- tabs ----
const SCREENS = ['send', 'receive', 'group', 'diag'];
const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')];
function showTab(name: string): void {
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const id of SCREENS) $(id).hidden = id !== name;
}
tabs.forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab!)));

// ---- group key ----
interface Group {
  keys: GroupKeys;
  /** A new identity per app start: sender ids are per-session (PRD). */
  identity: SenderIdentity;
}
let group: Group | null = null;

const groupStatus = $('groupStatus');
const newKey = $('newKey');
const keyWords = $('keyWords');
const createBtn = $<HTMLButtonElement>('createBtn');
const joinBtn = $<HTMLButtonElement>('joinBtn');
const joinInput = $<HTMLTextAreaElement>('joinInput');

function renderGroup(note = ''): void {
  groupStatus.textContent = group ? `Group key active on this device.${note}` : 'No group key on this device.';
}

async function activate(passphrase: string): Promise<void> {
  groupStatus.textContent = 'Deriving key (this takes a moment on purpose)...';
  const keys = await deriveGroupKeys(passphrase);
  const stored = await saveKeys(keys);
  group = { keys, identity: new SenderIdentity() };
  renderGroup(stored ? '' : ' It could not be saved, so it will be forgotten when you close the app.');
}

async function withBusy(button: HTMLButtonElement, work: () => Promise<void>): Promise<void> {
  createBtn.disabled = joinBtn.disabled = true;
  try {
    await work();
  } catch (error) {
    groupStatus.textContent = error instanceof PassphraseError ? error.message : `Could not set the key: ${String(error)}`;
  } finally {
    createBtn.disabled = joinBtn.disabled = false;
  }
}

createBtn.addEventListener('click', () =>
  withBusy(createBtn, async () => {
    const passphrase = generatePassphrase();
    await activate(passphrase);
    keyWords.textContent = passphrase;
    newKey.hidden = false;
  }),
);
joinBtn.addEventListener('click', () =>
  withBusy(joinBtn, async () => {
    await activate(joinInput.value);
    joinInput.value = '';
    newKey.hidden = true;
    keyWords.textContent = '';
  }),
);
$('leaveBtn').addEventListener('click', async () => {
  await clearKeys();
  group = null;
  newKey.hidden = true;
  keyWords.textContent = '';
  stopListening();
  renderGroup();
});

void loadKeys().then((keys) => {
  if (keys) group = { keys, identity: new SenderIdentity() };
  renderGroup();
});

// ---- send ----
const text = $<HTMLTextAreaElement>('text');
const hint = $('hint');
const sendBtn = $<HTMLButtonElement>('sendBtn');
const sendStatus = $('sendStatus');
const loop = $<HTMLInputElement>('loop');

let playback: Playback | null = null;
let sending = false;

let timer = 0;
async function updateHint(): Promise<void> {
  const bytes = byteLength(text.value);
  if (bytes === 0) {
    hint.textContent = `Type a message. Up to ${MAX_PLAINTEXT_BYTES} bytes.`;
  } else if (bytes > MAX_PLAINTEXT_BYTES) {
    hint.textContent = `Too long: ${bytes} / ${MAX_PLAINTEXT_BYTES} bytes.`;
  } else {
    const seconds = await estimateSeconds(bytes, radio('band'));
    hint.textContent = `${bytes} / ${MAX_PLAINTEXT_BYTES} bytes · about ${seconds.toFixed(1)} s`;
  }
}
const scheduleHint = () => {
  clearTimeout(timer);
  timer = window.setTimeout(() => void updateHint(), 150);
};
text.addEventListener('input', scheduleHint);
document.querySelectorAll('input[name=band]').forEach((r) => r.addEventListener('change', scheduleHint));

async function runSend(): Promise<void> {
  if (!group) {
    sendStatus.textContent = 'Set up a group key on the Group tab first.';
    showTab('group');
    return;
  }
  if (text.value.trim() === '') {
    sendStatus.textContent = 'Type a message first.';
    return;
  }
  sending = true;
  sendBtn.textContent = 'Stop';
  try {
    const send = await prepareSecureSend(group.keys, group.identity, text.value, radio('band'));
    sendStatus.textContent = 'Playing. Hold the speaker near the other device and turn the volume up.';
    do {
      playback = playSamples(send.samples, TX_RATE);
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
  const hz = radio('band') === 'ultrasound' ? 18000 : 2500;
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
let gate: CarrierGate | null = null;
let decoder: WaveDecoder | null = null;
let packets: PacketInbox | null = null;
let bars: number[] = new Array(BAR_HZ.length).fill(0);
let decoded = 0;
let heard = 0;

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

async function onPacket(packet: Uint8Array): Promise<void> {
  heard++;
  const got = await packets?.accept(packet);
  if (got) show(got.text);
}

function onSamples(samples: Float32Array): void {
  let sum = 0;
  for (const v of samples) sum += v * v;
  level.style.width = `${Math.min(100, Math.sqrt(sum / samples.length) * 400)}%`;
  if (!capture || !gate) return;
  bars = barLevels(samples, capture.rate);
  const result = gate.push(samples);
  // A fresh decoder each time the gate opens, so state from earlier noise never leaks into a message.
  if (result.opened) {
    decoder?.free();
    decoder = WaveDecoder.createLoaded(capture.rate);
    recvStatus.textContent = 'Signal detected...';
  }
  if (result.audio && decoder) {
    const packet = decoder.pushBytes(result.audio);
    if (packet) void onPacket(packet);
  }
  if (result.closed && recvStatus.textContent === 'Signal detected...') recvStatus.textContent = 'Listening.';
}

function stopListening(): void {
  capture?.stop();
  capture = null;
  gate = null;
  decoder?.free();
  decoder = null;
  packets = null;
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
  if (!group) {
    recvStatus.textContent = 'Set up a group key on the Group tab first.';
    showTab('group');
    return;
  }
  listenBtn.disabled = true;
  try {
    await ready();
    packets = new PacketInbox(group.keys);
    const started = await startCapture(onSamples);
    capture = started;
    gate = new CarrierGate(started.rate, radio('rxband'));
    listenBtn.textContent = 'Stop listening';
    recvStatus.textContent = started.voiceProcessing
      ? 'Listening, but the browser kept voice processing on, which can distort the signal.'
      : 'Listening.';
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
    const g = gate?.stats;
    const rows: [string, string][] = [
      ['Listening', capture ? `yes, ${capture.rate} Hz` : 'no'],
      ['Voice processing', capture ? (capture.voiceProcessing ? 'ON (bad)' : 'off') : '-'],
      ['Detector gate', g ? (g.open ? 'open' : 'closed') : '-'],
      ['Band / floor / guard', g ? `${g.bandDb.toFixed(0)} / ${g.floorDb.toFixed(0)} / ${g.guardDb.toFixed(0)} dB` : '-'],
      ['Packets heard', String(heard)],
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

