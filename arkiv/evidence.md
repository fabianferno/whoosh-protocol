# Evidence: entities created on Tiramisu

Wallet addresses that created `whoosh.msg` entities on Tiramisu (chain ID 7738577):

| Wallet | Role |
| --- | --- |
| `0x6DF2784A950B2eF938bacA56cc1d3f7211788227` | Phone gateway burner wallet, generated in the browser on a Samsung Galaxy A71 (Chrome) |

## 2026-10-19, first end-to-end settlement

The laptop played an encrypted ultrasound message through its speaker. The phone heard it, verified and decrypted it, and settled
it to Arkiv with its own wallet. Read back from the chain afterwards by a separate client:

| Field | Value |
| --- | --- |
| Entity key | `0x72b2780eb56344fafe16025bf1b65672d7967bfcd152fc63ac02a8f4d95be655` |
| `$creator` | `0x6DF2784A950B2eF938bacA56cc1d3f7211788227` (the phone wallet) |
| `app` / `chan` / `mid` | `whoosh` / `659c` / `cc84647e0000` |
| `ts` / `hops` | `1792348349` / `0` |
| Payload | 64 bytes of packet (15-byte header + 37-byte ciphertext + 12-byte tag), byte-identical to what was heard |
| Decrypts to | `synthetic whoosh settle test 18:32:29` (synthetic message, no real data) |
| Cost | the wallet went from 10 GLM to 9.999893592 GLM, so about 0.000106 GLM for one entity |
| Catch-up | a second gateway's `pull()` returned the message once, with the ttl reset to 3 |

The payload is ciphertext under a group key that is not on Arkiv. The channel tag `659c` is the truncated HMAC for that day.

## Reproduce the read

`SdkStore.query(chan, since)` in `src/arkiv/sdkStore.ts` runs
`select({ key, creator, payload }).where(eq('app','whoosh'), eq('chan', chan), gte('ts', u64(since))).limit(200)`.
Anyone can list entities for a channel tag; only a holder of the group key can read them.
