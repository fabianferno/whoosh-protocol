# Arkiv schema

Whoosh keeps one kind of Arkiv entity. The app's code is in `src/arkiv/`; this file is written first and the
code follows it.

## What the app must answer

1. **Catch-up:** "what messages has my group posted since time T?" (a second island pulling down what the first one settled)
2. **Already settled?** "is message `mid` on channel `chan` already stored?" (a gateway deduplicating before it pays to write)
3. **Who posted it?** "which gateway wrote this?" (`$creator`, the trust anchor for provenance; not trusted for authorship, see below)

## Entity `whoosh.msg`

| Part | Value | Type | Why |
| --- | --- | --- | --- |
| payload | Raw packet bytes: 15-byte header, AES-256-GCM ciphertext, 12-byte tag | bytes, `application/octet-stream` | Byte-identical to what was heard over the air, so any key holder can verify it. At most 127 bytes; Arkiv allows 128 KiB |
| `app` | `whoosh` | string | Scope queries to this app |
| `chan` | 4 hex characters: 16-bit truncated HMAC(group key, UTC day) | string | Fetch only one group's traffic. Rotates daily, so it cannot be followed across days without the key |
| `mid` | 12 hex characters: sender (8) + seq (4) | string | Dedup before writing and after reading |
| `ts` | Unix seconds from the sender's clock | `u64` | Range query for catch-up (`ts >= since`). Numeric because Arkiv range filters work only on numbers |
| `hops` | Hops the packet took before the gateway heard it: `3 - ttl` | `i32` | Shows the mesh at work. Approximate: assumes the sender used the default ttl of 3 |
| Entity Expiration | 7 days | - | Messages are ephemeral by design |

Queries use equality on `app`, `chan`, `mid` and a range on `ts`. There is no server-side ordering, so results are sorted on the client by `(ts, mid)`. Pages are at most 200 entities; the client follows `cursor()`.

## Kept off Arkiv on purpose

Keys and passphrases, plaintext, audio, real identities, and anything about who typed a message. `chan` is an HMAC of
the day under the group's tag key; it is not the key and cannot be reversed to it, but it is derived from the secret,
so it is worth confirming with the organisers that it is acceptable under the "no hashed secrets" rule (open item in `prd.md`).

## Trust

- The payload is ciphertext. A reader without the group key learns the channel tag, time, size and the posting wallet, nothing else.
- Anyone can write an entity with any `chan`. A reader therefore decrypts and checks the GCM tag of every payload before showing it; entities that fail are ignored. `$creator` records which wallet paid to write, not who wrote the message.
- Two gateways that hear the same packet may both write it (there is no unique constraint). Readers deduplicate by `mid`.

## Writes and reads

- **Write:** a gateway verifies the packet (its channel tag, then the GCM tag) before spending anything, checks `select(app, chan, mid)`, and creates the entity if absent. Failed writes wait in an outbox and retry.
- **Catch-up:** for each of yesterday's, today's and tomorrow's channel tags, `select(app, chan, ts >= since - 600s)`, all pages, then verify and deduplicate.
- **Live:** `watchEntityEvents` over a WebSocket transport (no `fromBlock`); each created event triggers a catch-up.
- **Wallet:** a burner key generated in the browser, kept on the device, funded from the Tiramisu faucet. Every write is linked to its address.
