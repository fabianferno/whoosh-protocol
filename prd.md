# Whoosh Protocol — PRD

Oct 18, 2026 · @Tenori Labs

## TL;DR

Whoosh is an offline, encrypted group messenger that moves short text between phones as near-ultrasonic sound, relays it hop by hop, and settles it to Arkiv as public, tamper-evident ciphertext whenever any phone in the mesh gets internet.

- **Problem:** in an internet shutdown, people at a protest, market or camp can still talk face to face but cannot coordinate beyond earshot, and any server-based log of what happened can be seized or deleted.
- **Bet:** every phone already has a speaker and a microphone, and a browser can drive both. No Bluetooth pairing, no app store, no account.
- **What Arkiv adds:** an islanded mesh can push its encrypted log to Arkiv through any one gateway phone, and a second island can pull it back down and replay it over audio. No single operator can quietly delete that record.
- **Honest scale:** acoustic links carry roughly 8 to 16 bytes per second with today's open-source modems, so Whoosh is pager-scale: short texts, a few metres per hop, one speaker at a time. It is not a chat app replacement.

Primary track: **Censorship Resistance**. Secondary: **Privacy**. Assumption: "mantar" in the brief means Myanmar; correct this if not.

## Hackathon and Arkiv

The build targets the [Arkiv: Global Tour Stop](https://arkiv.devfolio.co/overview) on Devfolio, scored 25 points each on the pillar, Why Arkiv, How you use Arkiv, and a friction report; 50/100 is the floor to win.

| Item | Detail |
| --- | --- |
| Submission close | 18 Oct 2026, 23:59 London time (19 Oct, 04:29 IST) |
| Theme | CROPS: censorship resistant, open source, private, secure |
| Prize per CROPS track | Devcon 8 ticket + 750 USDC; one prize per team |
| Network | Tiramisu testnet, chain ID 7738577 |
| RPC | https://rpc.tiramisu.db-chain.testnet.arkiv.network (HTTP and wss) |
| SDK | `@arkiv-network/sdk` 0.8.x |
| Canonical rules | [global-tour-stop-pre-devcon repo](https://github.com/Arkiv-Network/global-tour-stop-pre-devcon) |

**Arkiv facts that shape the design** (from the challenge's [AGENTS.md](https://github.com/Arkiv-Network/global-tour-stop-pre-devcon/blob/main/AGENTS.md)):

- All entities are publicly readable. Privacy means encrypting the payload; there is no private toggle.
- The payload is not queryable. Anything Whoosh filters on (channel, time, message id) must be an attribute.
- Range filters work only on numeric attributes, so timestamps are stored as numbers.
- No server-side ordering; sort on the client. Max 200 results per page; use `cursor()`.
- Every entity expires (Entity Expiration). Lifetime Extension sets a new, later expiry.
- `$creator` is immutable and is the trust anchor; `$owner` is mutable.
- `watchEntityEvents` opens a real socket only over a WebSocket transport with no `fromBlock`; over HTTP it silently polls.

**Gates that disqualify if missed:**

- [ ] Public deployment judges can open without asking
- [ ] Public MIT-licensed repo with reproducible steps
- [ ] `/arkiv/schema.md` and `/arkiv/friction.md`
- [ ] Wallet addresses that created entities on Tiramisu
- [ ] Demo video of 3 minutes or less
- [ ] Work built 9 to 18 Oct; disclose any earlier code with its baseline commit SHA
- [ ] No keys, secrets or real personal data in Arkiv, plaintext or hashed; demo with synthetic messages only

## Users, threat model, goals

Whoosh serves small trusted groups who share a key in person and need to pass short messages during a shutdown; it protects message content, not the fact that Whoosh is being used.

**Primary users**

- Protest marshals and medics coordinating across a crowd when mobile data is cut.
- Journalists who need a timestamped, undeletable record of what their group reported, settled later.
- Communities in a blackout passing notices hop by hop through a market or camp.

**Threat model**

| Adversary can | Whoosh response | Residual risk |
| --- | --- | --- |
| Record all audio nearby | Payload is AES-GCM ciphertext | None for content if the key holds |
| Detect that Whoosh is in use | Nothing; near-ultrasound is visible to any spectrum analyser | **Not covert.** Users must know this |
| Seize one phone | Messages are lost with the key | Full group history and key exposed |
| Shut down a server | No server in the loop; Arkiv log is multi-node | A gateway's wallet links it to uploads |
| Inject or replay packets | GCM tag rejects forgeries without the key; dedup by message id | Any key holder can impersonate any other |
| Read Arkiv | Sees ciphertext, channel tag, time, gateway address | Timing and volume metadata leak |

**Goals for the hackathon build**

1. Two phones exchange an encrypted text over near-ultrasound in a noisy room.
2. A third phone relays it out of the sender's earshot.
3. A gateway settles the packet to Tiramisu; a second device pulls it from Arkiv and replays it over audio.
4. The app installs as a PWA and works with the network off.

**Non-goals**

- Covertness, anonymity against a state adversary, or forward secrecy.
- Voice, images or files.
- Background operation; the app relays only while open on screen.

## Acoustic physical layer

Use [ggwave](https://github.com/ggerganov/ggwave) (WebAssembly build) in its ultrasound mode for the MVP instead of writing a modem; it already does FSK with Reed-Solomon error correction at 8 to 16 bytes per second.

**Band choice: 17.5 to 19 kHz**

- Phones sample at 44.1 or 48 kHz, so usable audio tops out near 22 to 24 kHz.
- Crowd noise and speech sit mostly well below this band, so a high-pass filter removes most of the ambience before decoding.
- Stay at or below 19 kHz: one developer [reports Safari failing to detect tones above 19 kHz](https://community.latenode.com/t/safari-web-audio-api-frequency-analysis-fails-for-ultrasonic-range-above-19khz/27602). This is a single forum report; test it on real iPhones first.
- **Not truly inaudible.** Children and young adults often hear up to about 20 kHz, and abrupt tone starts produce audible clicks. Ramp every tone in and out (raised-cosine fade) and keep volume moderate.

**What the rate means in practice**

| Payload | Airtime at 16 B/s | Airtime at 8 B/s |
| --- | --- | --- |
| 27-byte overhead only | 1.7 s | 3.4 s |
| 40-char text (67 B total) | 4.2 s | 8.4 s |
| 100-char text (127 B total) | 7.9 s | 15.9 s |

Totals use the 27-byte header and tag defined under Packet format. Cap messages at about 100 bytes and show a byte counter, not a character counter: Burmese and Devanagari characters take 3 bytes each in UTF-8, so 100 Burmese characters cost 300 bytes. Compress text (for example with a small static dictionary) before encryption if budget allows.

**Unknowns to measure first**

- Real range between two phones in a loud room. ggwave's own coverage cites about one metre for microcontrollers; phone-to-phone range is not documented and must be measured.
- Whether iOS Safari delivers the high band at all with processing off.
- ggwave's maximum payload per transmission (check `ggwave.h`; I believe it is about 140 bytes for variable-length mode but have not verified it).

## Signal processing: detection and noise

The right analogue of a VAD here is a carrier detector on the Whoosh band, and the right noise cancellation is band-limiting: the signal lives where crowd noise mostly does not, so filtering beats any speech-oriented denoiser.

**Capture settings**

- Call `getUserMedia` with `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`. Browser voice processing is tuned for speech and can strip or distort high tones ([constraint support notes](https://blog.addpipe.com/getusermedia-audio-constraints/)).
- Read back `track.getSettings()` and `AudioContext.sampleRate`; do not trust what was requested. Refuse to run below 44.1 kHz.
- Do all processing in an `AudioWorklet`, off the main thread.

**Pipeline**

1. High-pass biquad at about 16 kHz to drop speech, music and traffic rumble.
2. Band energy detector: Goertzel filters on the FSK tone set every 10 ms frame, compared with energy in a guard band just outside it.
3. Adaptive noise floor: a slow moving minimum of band energy, so the threshold rises in a loud venue and falls in a quiet one.
4. Hysteresis gate: open after 3 consecutive frames above floor + margin, close after 10 below. This is the "VAD" and is what wakes the decoder, saving battery and avoiding false decodes.
5. Hand the gated buffer to ggwave for demodulation and Reed-Solomon decoding.
6. AES-GCM verify; a failed tag is dropped silently.

**Practical issues and fixes**

| Issue | Fix |
| --- | --- |
| Phone hears its own transmission | Half-duplex: gate the detector while transmitting, and drop packets carrying your own sender id |
| Two phones talk at once | Listen-before-talk using the same detector (see Mesh) |
| Echo and multipath indoors | Longer symbols in ggwave's slower protocol; Reed-Solomon absorbs some loss |
| Speaker distortion at high volume | Cap output gain; a calibration screen tests each phone pair |
| User cannot tell if it works | Live spectrum and band-level meter on screen, which also makes a strong demo |

## Packet format

Every packet is a 15-byte cleartext header, the ciphertext, and a 12-byte GCM tag; the header is authenticated as associated data and also supplies the nonce, so no nonce bytes go over the air.

| Field | Bytes | Purpose |
| --- | --- | --- |
| ver + type | 1 | 4-bit version, 4-bit type: MSG, HAVE, WANT, BEACON |
| ttl + flags | 1 | 3-bit hop count (max 7), relay and fragment flags |
| chan | 2 | Truncated HMAC(key, day) so devices skip other groups' packets cheaply |
| sender | 4 | Random per-session id, not tied to a person |
| seq | 2 | Per-sender counter; sender + seq is the message id |
| frag | 1 | 4-bit index, 4-bit count (up to 16 fragments) |
| ts | 4 | Unix seconds from the sender's clock |
| ciphertext | N | AES-256-GCM of the text |
| tag | 12 | 96-bit GCM tag |

**Rules**

- Nonce = sender (4) ‖ seq (2) ‖ ts (4) ‖ 0x0000. Unique as long as a sender id never reuses a seq value under the same key; reset `sender` to a fresh random value whenever seq wraps or the app restarts.
- Relays decrement ttl. Because ttl sits in the authenticated header, a relay cannot change it without breaking the tag: authenticate the header with ttl zeroed, and carry the live ttl outside the check. Note this lets an attacker raise ttl; cap relaying at 7 hops regardless.
- Message id (sender + seq) drives dedup on the mesh and on Arkiv.
- HAVE packets carry a short list of (sender, highest seq) pairs for sync; WANT asks for a specific missing id. Both are encrypted like MSG.
- BEACON is header-only plus tag (27 bytes), announcing presence and channel.

Open question: whether 16-bit seq and 32-bit sender ids collide too often in large meshes. For groups under a few hundred devices the birthday odds on 32 bits are small.

## Mesh coordination

Sound in a room is one shared channel, so coordination is mostly about taking turns and relaying sparingly: airtime, not bandwidth or CPU, is the scarce resource.

**Taking turns (medium access)**

- Listen before talk: transmit only after the carrier detector has been quiet for 300 ms.
- Random backoff of 0.5 to 3 s before each send; double the window after hearing a collision (a gate that opened but failed to decode).
- One transmission at a time per phone; queue the rest.

**Relaying (flooding with suppression)**

1. On a new, valid MSG with ttl > 0, schedule a rebroadcast after a random delay.
2. If you hear the same message id from 2 other phones before your timer fires, cancel. Neighbours already covered the area.
3. Otherwise rebroadcast with ttl − 1.
4. Keep a seen-set of message ids (an LRU of about 1,000 ids, or a Bloom filter as bitchat does) so loops die out.

**Catching up (sync)**

- Every 30 to 60 s of quiet, a phone may send one HAVE packet listing its highest seq per sender.
- A neighbour that has a newer message replies with that MSG; one that is missing a message sends WANT.
- Order messages on screen by (ts, sender, seq). Clocks may disagree; show "approx" times and do not depend on them for correctness.

**Bridging islands through Arkiv**

- Any phone with internet becomes a gateway: it writes each new MSG to Arkiv and watches Arkiv for its channel.
- When it sees a message on Arkiv that its local mesh lacks, it rebroadcasts it over audio. Two shutdown zones with one connected phone each can exchange messages.

Stretch: split the band into 2 or 3 sub-channels so nearby groups or simultaneous senders do not collide.

&#91;embedded content: Whoosh architecture · 2 audio islands bridged by Arkiv\]

Inside an island, packets hop phone to phone over sound. A gateway with any connection writes them to Arkiv, and a gateway in another zone watches Arkiv and replays them over audio.

## Encryption and key sharing

Keep the Enigma idea (everyone in the group holds the same setting) but not the Enigma cipher: it was broken in the 1940s. Use AES-256-GCM from the browser's built-in WebCrypto with a group key derived from a shared passphrase.

**Key derivation**

1. Group creator generates a random passphrase of 6 words (or a random 256-bit key).
2. Each device runs PBKDF2-SHA256 over the passphrase with a fixed app salt and a high iteration count, giving a root key.
3. HKDF from the root key derives two keys: `enc` for AES-GCM and `tag` for the channel HMAC.
4. Keys live only in the device's IndexedDB as non-extractable WebCrypto keys.

**Sharing the key offline**

- Show a QR code of the passphrase; others scan it with the in-app camera.
- Or read the 6 words aloud. Never send the key over Whoosh or write it to Arkiv.

**What this does not give you (state it in the app)**

- No forward secrecy: a leaked key decrypts every past message, including those on Arkiv.
- No sender authentication: any group member can forge a message as any other.
- No revocation: removing someone means everyone moves to a new passphrase.

Stretch: per-device signing keys to fix sender authentication. A 64-byte signature adds 4 to 8 s of airtime per message, so it is a real trade-off, not a free upgrade. Check WebCrypto Ed25519 support on target browsers before committing.

## Arkiv settlement layer

Arkiv is the durable, shared memory of the mesh: gateways write each packet exactly as it was heard (ciphertext and all), and anyone with the group key can later prove what was said, when, and that no operator deleted it.

**Why Arkiv (the rubric question)**

- Postgres or our own API: one operator, one subpoena or shutdown order, and the log is gone or quietly edited.
- IPFS: content survives only if someone pins it, and there is no query by channel or time, so a second island cannot find new messages.
- Arkiv: queryable attributes let a gateway ask "new messages on channel X since T", Entity Expiration matches ephemeral chat, and `$creator` records which gateway posted.
- Kept off Arkiv on purpose: keys, plaintext, audio, real identities, and anything about who typed a message.

**Entity: `whoosh.msg`**

| Part | Value | Why |
| --- | --- | --- |
| payload | Raw packet bytes (header + ciphertext + tag) | Byte-identical to what was heard, so any key holder can verify it |
| attr `app` (string) | `whoosh` | Scope queries to this app |
| attr `chan` (string) | Hex channel tag for the day | Fetch only your group's traffic |
| attr `mid` (string) | Hex sender + seq | Dedup before writing |
| attr `ts` (number) | Unix seconds | Range queries for catch-up |
| attr `hops` (number) | Hops before reaching the gateway | Shows the mesh at work in the demo |
| Entity Expiration | 7 days (configurable) | Messages are ephemeral by design |

**Flows**

1. Write: gateway checks `select().where(chan, mid)`; if absent, creates the entity. Two gateways may race and both write; readers dedup by `mid`. Note this in `/arkiv/friction.md` if no unique constraint exists.
2. Catch-up: `select().where(chan = X, ts > lastSeen).limit(200)`, paging with `cursor()` and sorting on the client.
3. Live: `watchEntityEvents` over a WebSocket transport, so new messages arrive without polling; then rebroadcast over audio.
4. Pin: Lifetime Extension on a message a user marks "keep" (for example, evidence).

**Wallet**: the PWA generates a burner key in the browser and funds it from the [Tiramisu faucet](https://hub.arkiv.network/faucet). The key stays on the device. Every gateway write is linked to that address, which is a metadata trade-off to state plainly.

**Check with organisers**: `chan` is an HMAC derived from the group key. It is not the key or a hash of it, but the rules ban "hashed" secrets, so confirm on the Arkiv Discord that it is acceptable.

## PWA, offline and sharing the app

The PWA works fully offline once installed from an HTTPS URL; the hard part is the first install during a shutdown, and AirDropping the app does not give you a working PWA.

**Offline after install (solid)**

- Service worker precaches the HTML, JS, ggwave WASM and fonts at install; cache-first for all app assets.
- Messages and keys in IndexedDB; outbound Arkiv writes queue there until a connection appears.
- Screen Wake Lock keeps the phone awake while relaying.

**Sharing the app phone to phone (constrained)**

| Route | Works offline? | Verdict |
| --- | --- | --- |
| Install from URL or QR while online, before a shutdown | Yes, after first load | **Primary path.** Pitch it as "install before you need it" |
| AirDrop or Nearby Share a single self-contained HTML file | Partly | Service workers refuse `file://` origins ([Chromium error reports](https://forum.ionicframework.com/t/service-workers-on-android-devices/66105)), so it is not a PWA. A one-file build with everything inlined needs no service worker, but whether the mic works from a local file is untested; on iPhone the file likely opens in a preview that will not run it. Test on day one |
| Android APK sideloaded via Nearby Share or Bluetooth | Yes, if assets are bundled | A wrapper like Capacitor that ships assets inside the APK works with no network. A Trusted Web Activity alone still loads the URL on first run. Stretch goal |
| iPhone without network | No | iOS has no general sideloading, so a new iPhone user needs a network or a prior install. State this |

**Platform limits to state up front**

- Relaying stops when the app is backgrounded or the screen locks. Bitchat, as a native app, can use background Bluetooth; Whoosh cannot.
- Audio must start from a user tap (browser autoplay rules), so the app opens on a "Start listening" button.
- iOS home-screen apps have had microphone-permission and wake-lock quirks across versions; test on the exact devices used in the demo.

## Risks, open questions, build order

The single biggest risk is the physics, not the code: prove phone-to-phone ultrasound decoding on the real demo devices before building anything else.

**Risks**

| Risk | Impact | Mitigation |
| --- | --- | --- |
| iPhone Safari does not capture 17.5 to 19 kHz cleanly | No iOS receivers | Test first; fall back to ggwave's audible-fast protocol with a UI toggle |
| Range under 1 m in a loud room | Mesh looks weak in the demo | Measure; demo indoors with phones at 1 to 2 m; show the relay hop |
| Collisions as more phones join | Messages lost | Listen-before-talk, backoff, relay suppression |
| Judges cannot reproduce audio without two phones | Fails the reproducibility gate | Ship a two-tab desktop mode and a "loopback" test page |
| Shared-key weakness challenged in judging | Lower Privacy score | State limits in the README; that honesty scores better than overclaiming |

**Open questions**

- Confirm "mantar" means Myanmar, or name the actual target region.
- Arkiv payload size limit per entity (not found in the pages I could open; docs pages redirected).
- ggwave licence and max payload; confirm before vendoring.
- Whether the `chan` HMAC attribute is acceptable under the no-hashed-secrets rule.

**Build order (demo-critical first)**

1. Spike: ggwave WASM in an AudioWorklet, one phone sends "hello" at 18 kHz, another decodes. iPhone and Android both.
2. Packet codec + AES-GCM with the header as associated data; unit tests for encode, decode and tamper rejection.
3. Detector gate, high-pass filter and live spectrum meter.
4. Mesh: listen-before-talk, relay with ttl and suppression, seen-set dedup.
5. Arkiv gateway: burner wallet, `whoosh.msg` writes, catch-up query, WebSocket watch, rebroadcast from Arkiv.
6. PWA shell: manifest, service worker precache, IndexedDB, QR key sharing.
7. Repo hygiene: MIT licence, `/arkiv/schema.md`, `/arkiv/friction.md` (log friction as you go), README with setup steps.
8. Demo video, under 3 minutes: phone A to B to C with C out of A's range, then gateway to Arkiv explorer, then Arkiv back to a fourth phone.

## Sources

- [Arkiv: Global Tour Stop, Devfolio](https://arkiv.devfolio.co/overview)
- [Challenge repo README](https://github.com/Arkiv-Network/global-tour-stop-pre-devcon) and [AGENTS.md](https://github.com/Arkiv-Network/global-tour-stop-pre-devcon/blob/main/AGENTS.md)
- [Arkiv docs home](https://docs.arkiv.network)
- [ggwave on npm](https://npmjs.com/package/ggwave)
- [getUserMedia audio constraints, addpipe](https://blog.addpipe.com/getusermedia-audio-constraints/)
- [Safari above 19 kHz, forum report](https://community.latenode.com/t/safari-web-audio-api-frequency-analysis-fails-for-ultrasonic-range-above-19khz/27602)
- [Service worker file:// error, Ionic forum](https://forum.ionicframework.com/t/service-workers-on-android-devices/66105)
- [BitChat, Wikipedia](https://en.wikipedia.org/wiki/BitChat)
