# Whoosh Protocol

Offline, encrypted group messaging between phones as near-ultrasonic sound, with an Arkiv settlement layer.
Short texts (up to 100 bytes), a few metres per hop, one speaker at a time: pager-scale, not a chat app.
Live: [whoosh-protocol.vercel.app](https://whoosh-protocol.vercel.app) (landing page; the app is at [`/app/`](https://whoosh-protocol.vercel.app/app/)).
Design and scope: [prd.md](prd.md). Primary track: Censorship Resistance. Secondary: Privacy.

- **Acoustic layer:** [ggwave](https://github.com/ggerganov/ggwave) (WebAssembly, MIT) in its ultrasound mode, with an audible fallback.
- **Packets:** 15-byte header + AES-256-GCM ciphertext + 12-byte tag; the header is authenticated, the ttl is not (relays lower it).
- **Keys:** a 6-word passphrase (or a 256-bit key) → PBKDF2 → HKDF; stored non-extractable in IndexedDB.
- **Detector gate:** high-pass, band-vs-guard energy, adaptive noise floor, hysteresis. It wakes the decoder only when a carrier is present.
- **Arkiv:** a gateway phone writes each verified packet to Tiramisu as a `whoosh.msg` entity and replays messages pulled from Arkiv over sound. Schema: [arkiv/schema.md](arkiv/schema.md). Friction report: [arkiv/friction.md](arkiv/friction.md).
- **Relay mesh:** an opt-in switch on the Receive screen. A phone rebroadcasts a new message after a random delay with the ttl lowered, only when the channel has been quiet for 300 ms, and cancels if it hears the message from 2 other phones. Logic in `src/mesh/`, tested in a simulated radio network.
- **PWA:** installable, precaches the app and the WebAssembly, works offline once installed.

## Status

Working and tested: ultrasound and audible send/receive between two devices, encryption and channel filtering, the detector gate,
the Arkiv gateway logic (against an in-memory store), the burner wallet and offline outbox, the loopback self-test.
Not built: HAVE/WANT catch-up sync between neighbours, QR key sharing, a demo recording.
Exercised on the real chain: a message heard by a phone was settled to Tiramisu and read back and decrypted by a separate client (see [arkiv/evidence.md](arkiv/evidence.md)). The testnet faucet was empty when this was built (see the friction report), so funding came from a person.
Our own test results are in [tests/](tests/); nothing here has been tested on an iPhone.

## Run it

Needs Node 22+ and pnpm 12 (`npm i -g pnpm@12.3.4`).

```
pnpm install
pnpm test          # unit tests, including real ggwave encode/decode through simulated noise
pnpm dev           # https dev server, also reachable from a phone on the same Wi-Fi
pnpm build         # type-check and production build into dist/
```

### Try it with no second device

Open the app (`/app/`), go to **Debug**, tap **Run loopback self-test**. It encrypts a message, plays it as sound through noise into the
same detector, decoder and decryption the app uses when listening, and reports PASS or FAIL for ultrasound and audible, clean
and at 0 dB signal-to-noise. No microphone or speaker is needed.

### Two devices

1. Run `pnpm dev`. On the laptop open `https://localhost:5173/app/`; on the phone open the `Network:` URL it prints, plus `/app/`
   (same Wi-Fi). Accept the self-signed certificate warning: the microphone needs https.
2. **Group** tab: on one device tap *Create new group* and read the six words aloud; on the other, type them under *Join with a passphrase*.
3. **Receive** tab on one device: *Start listening*. **Send** tab on the other: type a message, *Send as sound*.
   Hold the speaker near the other device's microphone with the volume up. **Debug** shows the live spectrum and detector gate.

If the high band does not work on a device (some microphones cut it), switch both to *Audible* (the PRD's fallback).

### Arkiv gateway

1. **Arkiv** tab: the app creates a random burner wallet on the device. Fund its address with GLM from the
   [Tiramisu faucet](https://hub.arkiv.network/faucet). A write cost about 0.0001 GLM when measured (1 gwei gas price).
2. Turn on *Save heard messages to Arkiv* to settle what the device hears, and *Watch Arkiv and replay over sound* to bring a
   group's messages down and play them over the speaker.
3. Live test against the real chain (skipped by default):

   ```
   ARKIV_PRIVATE_KEY=0x... pnpm test tests/arkiv.live.test.ts
   ```

   Use a throwaway key funded for testing. Never commit a key. Use synthetic messages only: everything on Arkiv is public.

## Limits, stated plainly

- No forward secrecy: a leaked key decrypts every past message, including any on Arkiv.
- No sender authentication: any key holder can forge a message as any other.
- No revocation: removing someone means everyone moves to a new passphrase.
- Not covert: near-ultrasound is visible to any spectrum analyser, and the channel tag, timing and size are visible on Arkiv.
- ggwave's ultrasound mode spans about 15-19.5 kHz, wider than the PRD's 17.5-19 kHz; the npm build cannot move it.
- The app relays and settles only while open on screen; browsers do not allow background audio.

## Code map

```
src/audio/    ggwave wrapper, capture (AudioWorklet), playback, carrier gate, spectrum
src/packet/   packet format, AES-GCM codec, key derivation, channel tag, sender identity
src/app/      secure send/receive, loopback self-test
src/mesh/     relay: listen-before-talk, backoff, ttl, suppression
src/arkiv/    schema types, gateway, SDK store, in-memory store, burner wallet
src/storage/  IndexedDB: group keys, wallet, outbox
src/ui/       screens and the Arkiv panel (app/index.html)
src/landing/  landing page (index.html)
tests/        unit tests with a seeded noisy-channel simulator
```

`src/modem/`, `src/message/` and `src/fec/` are an earlier from-scratch modem and message layer, kept with their tests but not used
by the app now that the PRD calls for ggwave.

## Licence

MIT, see [LICENSE](LICENSE). ggwave is MIT-licensed (Georgi Gerganov). The BIP39 English word list in `src/message/english.txt` is
from the [bitcoin/bips](https://github.com/bitcoin/bips/blob/master/bip-0039/bip-0039-wordlists.md) repository (MIT).
