# Arkiv friction log

Written while building. Each entry says how it was observed. Newest first.

## 2026-10-18

1. **`@arkiv-network/sdk@0.8.1` README points at files the package does not ship.** It says "Sample code can also be found in the
   `sample` directory" and links `BUILD.md` and `CONTRIBUTING.md`. The published tarball contains only `LICENSE.md`, `README.md`,
   `dist/`, `src/` and `package.json` (`npm pack`, then `ls`). The samples are the fastest way to learn the API, so a builder
   working from the npm package alone cannot find them.
2. **The README's install snippet shows `"@arkiv-network/sdk": "^0.6.0"`** while the version is 0.8.1 (`npm view`). Harmless, but
   it suggests the page was not regenerated after the API changed.
3. **The README publishes a shared "example key"** and warns "funds may not always be available for this key". Anyone using it
   shares a wallet with every other reader, and every entity written with it is linked to that one address. A first-run
   experience that does not need a pasted key (for example a script that creates and funds a throwaway wallet) would be safer.
4. **No scriptable way to fund a test wallet.** The Tiramisu faucet (`hub.arkiv.network/faucet`) is a web app; there is no
   documented HTTP API, so a CI job or an automated test cannot create and fund a wallet. Our live test is skipped unless a
   pre-funded key is supplied through an environment variable.
5. **Bare numbers become `i32` and bare bigints become `u256`** (`toValue` in `src/attr/values.ts`). A Unix timestamp of
   1.79 billion fits `i32` today but stops fitting in 2038, and a range filter such as `gte("ts", 1790000000)` compares as
   `i32` against whatever type the attribute was written with. We pass `u64(ts)` on both write and query. The README example
   shows bare values without warning that the type is chosen for you.
6. **`watchEntityEvents` cannot be filtered by attribute, and its events carry the entity key but not its attributes**
   (`src/actions/public/watchEntityEvents.ts`). A gateway that only cares about one group's channel still wakes on every
   entity created by anyone, then has to run a query to find out whether it matters. We trigger a catch-up query per
   event and deduplicate by message id. An attribute-filtered subscription would remove that load.
7. **No unique constraint**, so two gateways that hear the same packet can both write it. We check `select(app, chan, mid)`
   before writing, which narrows but cannot close the race; readers deduplicate by `mid`. (Expected from the PRD; confirmed
   by reading the API, which has no conditional create.)
8. **The payload size limit is only discoverable in source.** `MAX_PAYLOAD_BYTES` is 128 KiB and `MAX_ATTRIBUTES` is 32
   (`src/attr/attributes.ts`); string attributes are limited to 128 bytes (`MAX_STRING_BYTES`). The docs pages the PRD
   author tried had redirected, so this was an open question until we read the package.
