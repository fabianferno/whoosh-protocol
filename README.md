# whoosh-protocol
audio based communication protocol against censorship powered by arkiv network

## Run it

```
npm install
npm test          # modem, message and app tests (simulated noisy channel)
npm run dev       # https dev server, reachable from a phone on the same Wi-Fi
```

Open the `Network:` URL on the phone (accept the self-signed certificate warning; the microphone needs https). On one device open **Receive** and tap *Start listening*; on the other type a message on **Send** and tap *Send as sound*. The **Diagnostics** tab shows preamble score and per-tone levels.

Design: `docs/superpowers/specs/2026-10-17-whoosh-audio-design.md`.
