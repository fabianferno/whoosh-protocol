# whoosh-protocol
audio based communication protocol against censorship powered by arkiv network

## Run it

```
pnpm install
pnpm test         # modem, message and app tests (simulated noisy channel)
pnpm dev          # https dev server, reachable from a phone on the same Wi-Fi
```

Open the `Network:` URL on the phone (accept the self-signed certificate warning; the microphone needs https). On one device open **Receive** and tap *Start listening*; on the other type a message on **Send** and tap *Send as sound*. The **Diagnostics** tab shows preamble score and per-tone levels.

Design: `docs/superpowers/specs/2026-10-17-whoosh-audio-design.md`.

## Design system

The UI uses a skeuomorphic graphite-and-orange design system in `src/ui/design/`:

- `tokens.css` holds the palette, gradients, bevel/shadow recipes, type scale and spacing.
- `components.css` holds the components (buttons, icon buttons, inputs, select/menu, checkbox, radio, switch, slider, dial, tabs, badges, progress, alerts, cards, nav, top bar, pagination, avatar, tooltip, modal).
- `icons.ts` holds the stroke icon sprite (`mountIcons()`, then `<svg class="icon"><use href="#i-plus"/></svg>`).

Open `/design-system.html` in the dev server for the live reference page.
