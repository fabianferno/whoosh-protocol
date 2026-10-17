# Whoosh Audio Protocol: Design

Date: 2026-10-17

## Purpose

Two nearby devices (first target: a laptop and a phone) exchange short text over sound. A sender encodes a message as a burst of audible tones; a receiver decodes it from the microphone. The aim is robustness on cheap speakers and on iOS Safari and Android Chrome. ggwave is a design reference only; all modem, FEC and crypto code is written in this repo.

Delivered as a PWA (installable, works offline, served over HTTPS).

## Scope

In scope:
- Audible-range MFSK modem with Reed-Solomon error correction.
- Free-text messages of up to 4 words (about 32 bytes UTF-8) per burst.
- Multi-burst messages with chunk assembly.
- Dictionary mode (4 words as 11-bit indices into a 2048-word list).
- Pairing handshake: ECDH over audio, 3-word confirmation code, AES-GCM session encryption.
- Send, Receive and Pair screens plus a diagnostics screen.

Out of scope for now:
- Anything involving the Arkiv network mentioned in the README. It is not designed here and needs its own spec.
- Persistent keys or identities, group messaging, file transfer.
- A native app.

## Stack

Vite, TypeScript, Vitest, `vite-plugin-pwa`, no UI framework. Dev server uses a local HTTPS certificate so a phone can open it over the LAN. The modem and crypto layers have no DOM dependency so they run under Node tests.

## Signal design

| Parameter | Value |
|---|---|
| Modulation | 16-tone MFSK, 4 bits per symbol |
| Band | about 1.8 kHz to 3.9 kHz, 140 Hz spacing |
| Symbol length | 45 ms, raised-cosine envelope |
| Sync | linear chirp preamble, about 150 ms, found by cross-correlation |
| Demodulation | Goertzel per tone per symbol window, strongest tone wins |
| Sample rate | any; the decoder resamples to an internal rate |

The decoder compares tone energies within a window, so it does not depend on absolute loudness. Starting time is unknown to the receiver, which is why the chirp is used instead of a fixed start.

## Frame

```
preamble | header (4 B) | payload (0..32 B) | CRC-8 | RS parity (8 B)
```

Header bytes: `type|flags`, `msgId`, `index<<4 | total`, `payloadLength`.

Types: `TEXT` (free UTF-8), `DICT` (dictionary indices), `KEY` (pairing key chunk), `ENC` (encrypted chunk), `ACK` is not used (see Multi-burst).

Reed-Solomon over GF(256) with 8 parity bytes corrects up to 4 corrupted bytes per frame. The CRC-8 over header and payload rejects false positives where the decoder locks onto noise. Short frames use a shortened code.

Approximate burst durations: a full 32-byte text frame is 44 bytes, 88 symbols, about 4.1 s with the preamble. A dictionary frame is 18 bytes, 36 symbols, about 1.8 s.

## Multi-burst messages

A message longer than one frame is split into chunks. Each chunk is a normal frame carrying `msgId`, `index` and `total` (up to 16 chunks).

The receiver stores chunks by `index`, ignores duplicates, and shows "n of total". When all indices are present it reassembles and delivers the message. There is no back channel: the sender can repeat the full set of chunks until the user stops it, which covers missed bursts.

## Dictionary mode

The word list is the public BIP39 English list (2048 words, 11 bits each). Four words encode to 44 bits, packed into 6 bytes. The sender checks every word against the list; if any word is missing it falls back to `TEXT`. The frame type tells the receiver which interpretation applies.

## Pairing and encryption

Roles: the device that taps "Start" is A, the other taps "Listen" and is B. Transmission is half-duplex.

1. A generates an ephemeral P-256 key pair and sends its raw public key (65 bytes) as 3 `KEY` chunks.
2. B receives it, generates its own key pair and sends its public key back the same way.
3. Both compute the ECDH shared secret, then HKDF-SHA-256 (info string includes both public keys in a fixed order) into a 256-bit session key and a confirmation value.
4. The confirmation value is mapped to 3 dictionary words shown on both screens. Users compare them and tap "Match" or "Mismatch". On mismatch, or on any timeout, the session is discarded.
5. After "Match", messages are `ENC` frames: AES-GCM, 4-byte counter sent in clear and expanded into the nonce, 16-byte tag. Overhead is 20 bytes, so a 32-byte message becomes 52 bytes and two chunks. The receiver rejects counters it has already seen.

Properties and limits:
- Keys are ephemeral and never stored; each pairing is a new session.
- The confirmation words defend against an active interceptor only if users really compare them.
- A device mutes its decoder while it is transmitting so it does not decode itself.
- Sound reaches everyone in earshot. Unencrypted `TEXT` and `DICT` frames are readable by anyone nearby.

## Platform handling

- **Playback:** the encoded burst is rendered to a WAV blob and played through an `<audio>` element, started from a user tap. This stays audible on iOS when the ringer switch is silent, which plain Web Audio does not.
- **Capture:** `getUserMedia` with `echoCancellation`, `noiseSuppression` and `autoGainControl` all false. AudioWorklet capture, with a ScriptProcessor fallback.
- **Secure context:** the mic requires HTTPS (or localhost on the same device).
- **Diagnostics screen:** live tone levels, detected preamble, and decode error counts, to help tune volume and distance on real hardware.

## Module layout

```
src/
  fec/       reed-solomon, crc
  modem/     encode (bytes to samples), decode (samples to bytes), frame, chirp
  message/   chunking and assembly, dictionary mode, wordlist
  crypto/    ECDH, HKDF, AES-GCM, confirmation words
  audio/     playback, capture
  session/   pairing state machine, half-duplex control
  ui/        Send, Receive, Pair, Diagnostics
tests/
```

Each module exposes a small typed interface and can be tested alone. The pairing state machine takes the modem and clock as dependencies so it can be tested without audio.

## Testing

- Unit tests: Reed-Solomon (corrects up to 4 byte errors, fails cleanly beyond), CRC, frame pack/unpack, chunk assembly (out of order, duplicates, missing chunk), dictionary round trip, crypto (shared secret match, tamper rejection, replay rejection).
- Channel simulation: encode, then apply additive noise, gain changes, clipping, resampling (44.1 and 48 kHz) and random start offsets, then decode. Report the measured success rate at several signal-to-noise ratios.
- Pairing state machine: two simulated peers over the simulated channel, including a tampered key to confirm the words differ.
- Real hardware (manual, done by the user): speaker-to-mic tests on the laptop and phone, tuned using the diagnostics screen. This cannot be tested from the development environment, and the simulated results do not guarantee real-world reliability.

## Open items

- Arkiv network integration (from the README) is undefined and out of scope here.
- Tone count, symbol length and band are starting values. They will likely need tuning against real speakers and microphones.
