# Whoosh: hackathon submission answers

Answers for the Devfolio form, Arkiv Global Tour Stop. Fields marked **TODO** need a team member to fill them in.

Repo: https://github.com/fabianferno/whoosh-protocol

---

## Project name

Whoosh

## Tagline

Offline, encrypted group messages that travel between phones as sound, settled to Arkiv when anyone gets online.

## Builders

Fabian Ferno, Silas, Ashar

## The problem it solves

When the internet is shut down, people at a protest, a market or a camp can still talk face to face, but they cannot coordinate
beyond earshot. Any record of what happened that lives on one server can be seized or deleted.

Whoosh is a web app that sends short encrypted texts (up to 100 bytes) between phones as near-ultrasonic sound (15 to 19.5 kHz).
Every phone already has a speaker and a microphone, and a browser can drive both. You don't pair over Bluetooth, install from
an app store or create an account.

What people can use it for:

- **Coordinating without a network.** Marshals and medics pass "need water at gate 3" across a crowd. A group shares a six-word
  passphrase in person, and only its members can read the messages.
- **Reaching beyond one room.** Phones that have *Relay* turned on rebroadcast new messages, hop by hop, after the room goes
  quiet, so a message gets further than one speaker can carry it.
- **Keeping a record that is hard to delete.** When any phone in the mesh gets internet, it acts as a gateway and settles every
  message it heard to Arkiv as ciphertext. A second group of phones in another place pulls those messages from Arkiv and plays
  them over its own speakers. A journalist's group gets a timestamped log that no single operator can quietly remove.
- **Working after the network is gone.** It installs as a PWA and runs offline once installed.

What it does not do, stated plainly: it is pager-scale (short texts, a few metres per hop), not covert (a spectrum analyser can
see the near-ultrasound), and has no forward secrecy or sender authentication. A phone relays only while the app is open.

## Challenges I ran into

- **A from-scratch acoustic modem was not reliable enough.** We first wrote our own FSK modem with Reed-Solomon error correction
  (`src/modem/`, `src/fec/`). It decoded in tests but was fragile on real speakers. We switched to
  [ggwave](https://github.com/ggerganov/ggwave)'s ultrasound mode (WebAssembly) and kept our own packet, crypto and relay layers
  on top. The old modem is still in the repo with its tests.
- **Gated audio would not decode.** We added a carrier detector that wakes the decoder only when there is energy in the band, so
  the phone does not burn CPU decoding silence. After that, nothing decoded. ggwave needs whole 1024-sample frames, and our gate
  was passing it partial buffers. Feeding it fixed-size frames fixed it (commit `704fdbc`).
- **Nonce reuse across fragments.** An early version reused an AES-GCM nonce across fragments of one message, which breaks GCM's
  security. We moved to the PRD nonce (`sender | seq | ts | 0x0000`) and added a guard that refuses to reuse one
  (`7a96b92`, `eafedd7`).
- **Browsers clean up the microphone signal.** Echo cancellation, noise suppression and auto-gain are tuned for speech and strip
  high tones. We turn all three off in `getUserMedia`. Some phone microphones still cut the band, so there is an audible
  fallback and a live spectrum on the Debug screen to check.
- **Relays talking over each other.** With several relays, two phones would rebroadcast at once and garble both packets. The mesh
  now waits until the channel has been quiet for 300 ms, backs off for a random delay, lowers the ttl, and cancels if it hears
  the same message from 2 other phones. This is tested in a simulated radio network (`tests/mesh.test.ts`).
- **The Tiramisu faucet ran dry on the last day.** Claims failed with a raw viem `insufficient funds` error because the faucet
  wallet held less than one 10 GLM claim. Without GLM we could not create entities. We confirmed this on chain, logged it in
  the friction report and got test GLM from a person.
- **No second device for judges.** We built a loopback self-test (Debug tab). It encrypts a message, plays it as sound through
  added noise, and runs it through the same detector, decoder and decryption the app uses when listening.

---

## Private answers (organizers and judges)

### Live app URL

https://whoosh-protocol.vercel.app (the app itself is at https://whoosh-protocol.vercel.app/app/)

### Does any team member hold Indian nationality?

**TODO**

### Why Arkiv? (25% of judging)

Whoosh is for people whose network has been cut, and the thing they most need from the internet is a record that nobody can
quietly take down. The settlement layer has to:

1. accept writes from **any** phone that happens to get online, with no account, invite or API key;
2. let a second, unrelated group of phones **query** for "my group's messages since time T";
3. keep the record out of any one operator's hands; and
4. let messages **expire** on their own, because they are meant to be short-lived.

What would break with each alternative:

- **Postgres or our own API.** One operator holds the log. It can be subpoenaed, blocked by DNS or IP, or deleted, which is
  the exact failure Whoosh exists to avoid. It also needs accounts or API keys for writes, and someone has to keep paying for
  and running the server while a shutdown is on. A gateway phone in a blackout cannot rely on our server being reachable or alive.
- **IPFS.** Content-addressed storage answers "give me this hash", not "give me everything on channel `659c` with `ts >= T`".
  A second group of phones does not know the CIDs of messages it has never heard, so it would need a separate index, which
  is back to a server. Pinning also depends on someone choosing to keep the data.
- **A subgraph.** We would have to deploy a contract, pay to store calldata, and run or rent an indexer. The query side is then
  a hosted service that can go away. Expiry would have to be built by hand.

What we get only from Arkiv:

- **Permissionless writes with attribute queries in one place.** A burner wallet created in the browser can `createEntity`
  straight away (once funded). Any reader can then `select().where(eq('chan', ...), gte('ts', ...))` without an indexer.
  That pairing of "anyone can write" and "anyone can query by attribute" is the whole bridge between groups of phones.
- **Built-in expiry.** `ExpirationTime.fromDays(7)` makes messages ephemeral at the storage layer, with no cleanup job.
- **`$creator` as provenance.** Every entity records the wallet that paid to write it. We show it as "which gateway settled
  this". We do not treat it as the author, since any key holder can write.
- **Live subscriptions.** `watchEntityEvents` over WebSocket lets a gateway replay new messages over sound within seconds of
  another group settling them.
- **Public by design, which fits our trust model.** The payload is AES-256-GCM ciphertext, byte-identical to what was heard over
  the air. Anyone can read the entity, and only key holders can open it. Readers verify the GCM tag and drop forgeries, so we
  do not need to trust whoever wrote the entity.

### How do you use Arkiv? (25% of judging)

All Arkiv access goes through one class, `SdkStore`
([src/arkiv/sdkStore.ts](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/sdkStore.ts)), behind an
`ArkivStore` interface ([src/arkiv/schema.ts](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/schema.ts)).
The gateway logic ([src/arkiv/gateway.ts](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/gateway.ts)) is tested
against an in-memory store and live against Tiramisu.

| Arkiv feature | How and why we use it | Code |
| --- | --- | --- |
| **Entities with a binary payload** | Each heard message becomes one `whoosh.msg` entity. The payload is the raw packet (`application/octet-stream`, at most 127 bytes): header, AES-GCM ciphertext and tag, byte-identical to the audio, so any key holder can verify it. | [sdkStore.ts#L36-L44](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/sdkStore.ts#L36-L44) |
| **Typed attributes** (`u64`, `i32`, string) | `app`, `chan` (daily-rotating 16-bit channel tag), `mid` (message id), `ts` as `u64` so range queries work after 2038, `hops` as `i32` to show the mesh at work. | [sdkStore.ts#L40](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/sdkStore.ts#L40), [schema.ts](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/schema.ts) |
| **Entity Expiration** | `ExpirationTime.fromDays(7)`: messages are ephemeral by design. | [sdkStore.ts#L41](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/sdkStore.ts#L41) |
| **Query builder: equality filters** | `exists(chan, mid)` checks before writing, so a gateway does not pay to store a message another gateway already settled. | [sdkStore.ts#L27-L34](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/sdkStore.ts#L27-L34), [gateway.ts#L87](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/gateway.ts#L87) |
| **Query builder: numeric range filter** | Catch-up: `where(eq('app'), eq('chan'), gte('ts', u64(since)))` for yesterday's, today's and tomorrow's channel tags, with a 10-minute overlap for clock skew. | [sdkStore.ts#L46-L58](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/sdkStore.ts#L46-L58), [gateway.ts#L119](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/gateway.ts#L119) |
| **Pagination** | `limit(200)`, then `hasNextPage()` / `next()` until done; results are sorted on the client by `(ts, mid)` because there is no server-side ordering. | [sdkStore.ts#L52-L57](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/sdkStore.ts#L52-L57) |
| **`$creator`** | Selected on read and recorded as the settling gateway (provenance, not authorship). | [sdkStore.ts#L49](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/sdkStore.ts#L49) |
| **`watchEntityEvents` over WebSocket** | A gateway subscribes and runs a catch-up query on each created event, then replays new messages over sound. WebSocket transport so it is a real subscription, not silent polling. | [sdkStore.ts#L60-L64](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/sdkStore.ts#L60-L64), [gateway.ts#L146](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/gateway.ts#L146) |
| **Wallet client on Tiramisu + balance** | A burner key generated in the browser and kept in IndexedDB signs writes. The Arkiv tab shows its balance and links to the faucet. | [wallet.ts](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/wallet.ts), [arkivPanel.ts](https://github.com/fabianferno/whoosh-protocol/blob/main/src/ui/arkivPanel.ts) |

Safety rules in the gateway: it never writes a packet it has not verified (channel tag, then GCM tag), and never trusts an entity
it reads until the GCM tag checks out
([gateway.ts#L76-L104](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/gateway.ts#L76-L104),
[gateway.ts#L128](https://github.com/fabianferno/whoosh-protocol/blob/main/src/arkiv/gateway.ts#L128)). Failed writes wait in
an IndexedDB outbox and retry when the connection returns.

### Friction report

https://github.com/fabianferno/whoosh-protocol/blob/main/arkiv/friction.md

### Wallet addresses that create your Arkiv entities

| Address | Role |
| --- | --- |
| `0x6DF2784A950B2eF938bacA56cc1d3f7211788227` | Phone gateway burner wallet, generated in the browser on a Samsung Galaxy A71 (Chrome). It settled the first end-to-end message to Tiramisu (entity `0x72b2780eb56344fafe16025bf1b65672d7967bfcd152fc63ac02a8f4d95be655`). |

Each gateway phone generates its own burner wallet, so any judge who runs the gateway adds a new address. Details:
[arkiv/evidence.md](https://github.com/fabianferno/whoosh-protocol/blob/main/arkiv/evidence.md).

### Link to /arkiv/schema.md

https://github.com/fabianferno/whoosh-protocol/blob/main/arkiv/schema.md

### How can judges reproduce your Arkiv usage?

**A. Read what is already on chain (no wallet needed)**

1. Look up entity `0x72b2780eb56344fafe16025bf1b65672d7967bfcd152fc63ac02a8f4d95be655` on Tiramisu (chain ID 7738577), or query
   `app = "whoosh"`, `chan = "659c"`. You will see a 64-byte ciphertext payload, `$creator`
   `0x6DF2784A950B2eF938bacA56cc1d3f7211788227`, and the attributes `mid`, `ts`, `hops`.

**B. Settle a message from the browser (two devices)**

1. Open https://whoosh-protocol.vercel.app/app/ on two devices, ideally a laptop and a phone.
2. **Group** tab: on one device tap *Create new group*; on the other, type the six words under *Join with a passphrase*.
3. On the gateway device, open the **Arkiv** tab. It creates a burner wallet; fund the address from the
   [Tiramisu faucet](https://hub.arkiv.network/faucet) (one write costs about 0.0001 GLM). Turn on *Save heard messages to Arkiv*.
4. Gateway device: **Receive**, *Start listening*. Other device: **Send**, type a synthetic message, *Send as sound* with the
   volume up and the speaker near the microphone. (If the high band fails, switch both to *Audible*.)
5. The Arkiv tab logs the write with its entity key and transaction hash.
6. On a third browser (or the sender), join the same group, open **Arkiv** and turn on *Watch Arkiv and replay over sound*. It
   pulls the message from Arkiv and plays it over the speaker.

**C. From the command line**

```
git clone https://github.com/fabianferno/whoosh-protocol && cd whoosh-protocol
pnpm install
pnpm test                                               # gateway logic against an in-memory Arkiv store
ARKIV_PRIVATE_KEY=0x... pnpm test tests/arkiv.live.test.ts   # funded throwaway key: settle, query back, replay to a 2nd gateway
```

### Pre-existing work you reused

None of our own: the repository starts on 17 October (`9949833`) and all code was written during the hackathon. Third-party work:

- [ggwave](https://github.com/ggerganov/ggwave) by Georgi Gerganov (MIT), used from npm as the acoustic modem.
- The BIP39 English word list (`src/message/english.txt`) from [bitcoin/bips](https://github.com/bitcoin/bips) (MIT), for passphrases.
- npm libraries: `@arkiv-network/sdk`, `viem`, `@fontsource-variable/inter`, Vite, vite-plugin-pwa, Vitest.
- The skeuomorphic design tokens were measured from a UI kit. **TODO: name the kit and its licence, or delete this line if it was our own.**

### Arkiv surfaces you used

- `@arkiv-network/sdk` 0.8.1 (TypeScript SDK: public client, wallet client, query builder, `attr`, `utils`, `chains`)
- Tiramisu testnet RPC, over HTTP and WebSocket
- Tiramisu faucet (hub.arkiv.network/faucet)
- The challenge repo docs (`AGENTS.md` in global-tour-stop-pre-devcon) and the SDK README and source

### How long after you started did you write your first Arkiv entity?

More than a day. The repo starts at 17 Oct, 20:26 IST. The Arkiv layer was written on 18 Oct, and the first entity landed
on Tiramisu at 19 Oct, 00:02 IST (about 27.5 hours). The faucet being empty delayed it.

### Which LLMs did you use?

Claude Opus 5.5, Claude Sonnet 5.5

### What is the one thing Arkiv should improve first?

A reliable way to get test GLM. Without it you cannot create an entity, so the faucet is the gate to everything else, and on our
last day it was empty. Each claim sends 10 GLM, and the funding wallet held 9.9954, so no claim could succeed. The error was a
raw viem message that labelled the amount "10 ETH" and did not say the faucet was empty. A whole demo needs about a dozen writes
at about 0.0001 GLM each. Smaller claims, a visible faucet balance, a clear "faucet empty" message and a documented HTTP API for
CI would fix most of it. Details are in items 0 and 4 of the friction report.

### Open to a 20-minute feedback call with the Arkiv team?

**TODO** (Yes / No)

### Declarations

- [ ] This is our team's work, built between 9 and 18 October. Any pre-existing or third-party work is disclosed. *(Last commits
  are 19 Oct 00:43 IST, before the 19 Oct 04:29 IST close.)*
- [ ] Our repo is public under the MIT licence, and every link is accessible to judges.
- [ ] We plan to attend Devcon 8 in Mumbai. **TODO**

### Twitter post

**TODO**

### Tracks applied

Censorship Resistance (primary), Privacy (secondary)

### Technologies used

TypeScript, Vite, Web Audio API (AudioWorklet), ggwave (WebAssembly), Web Crypto (AES-256-GCM, PBKDF2, HKDF, HMAC),
IndexedDB, PWA (vite-plugin-pwa / Workbox), viem, `@arkiv-network/sdk`, Vitest, Vercel

### Platforms

Web (mobile and desktop browsers), installable PWA. Tested on Android Chrome and desktop; not yet tested on iPhone.
