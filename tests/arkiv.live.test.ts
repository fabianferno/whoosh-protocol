import { describe, expect, it } from 'vitest';
import { Gateway, type GatewayEvent } from '../src/arkiv/gateway.ts';
import { SdkStore } from '../src/arkiv/sdkStore.ts';
import { attrsOf } from '../src/arkiv/schema.ts';
import { open, peek, seal } from '../src/packet/codec.ts';
import { PacketType } from '../src/packet/format.ts';
import { deriveGroupKeys } from '../src/packet/keys.ts';
import { SenderIdentity } from '../src/packet/session.ts';

declare const process: { env: Record<string, string | undefined> };

// Runs against the real Tiramisu testnet. Skipped unless ARKIV_PRIVATE_KEY (a funded test key) is set:
//   ARKIV_PRIVATE_KEY=0x... pnpm test tests/arkiv.live.test.ts
const KEY = process.env.ARKIV_PRIVATE_KEY as `0x${string}` | undefined;

async function eventually<T>(fn: () => Promise<T | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() > end) throw new Error('timed out waiting for Arkiv');
    await new Promise((r) => setTimeout(r, 1500));
  }
}

describe.skipIf(!KEY)('Tiramisu (live)', () => {
  it('settles a synthetic message, reads it back by attributes, and replays it to a second gateway', async () => {
    const store = new SdkStore(KEY!);
    expect(await store.balance()).toBeGreaterThan(0n);

    // a fresh group per run, so earlier runs cannot satisfy the assertions
    const keys = await deriveGroupKeys(`lunar fossil quick river zoo ${['abandon', 'ability', 'able', 'about', 'above'][Date.now() % 5]}`, 1000);
    const now = Math.floor(Date.now() / 1000);
    const id = new SenderIdentity();
    const { sender, seq } = id.next();
    const packet = await seal(keys, { type: PacketType.MSG, sender, seq, ts: now, ttl: 1 }, new TextEncoder().encode(`synthetic whoosh test ${now}`));
    const attrs = attrsOf(peek(packet)!);

    const events: GatewayEvent[] = [];
    const island1 = new Gateway({ store, keys, onEvent: (e) => events.push(e) });
    expect(await island1.settle(packet)).toBe('written');
    const written = events.find((e) => e.kind === 'written');
    expect(written).toMatchObject({ kind: 'written', hops: 2 });

    // exists() and query() see it, with the payload byte-identical and this wallet as creator
    expect(await eventually(async () => (await store.exists(attrs.chan, attrs.mid)) || false)).toBe(true);
    const rows = await eventually(async () => {
      const r = await store.query(attrs.chan, now - 5);
      return r.length ? r : false;
    });
    const row = rows.find((r) => [...r.packet].join() === [...packet].join())!;
    expect(row).toBeDefined();
    expect(row.creator.toLowerCase()).toBe(store.address.toLowerCase());
    expect((await open(keys, row.packet))?.header.seq).toBe(seq);

    // a second island pulls it down and could replay it over audio
    const island2 = new Gateway({ store: new SdkStore(KEY!), keys });
    const pulled = await eventually(async () => {
      const p = await island2.pull();
      return p.length ? p : false;
    });
    expect(pulled).toHaveLength(1);
    expect(peek(pulled[0])!.seq).toBe(seq);

    // writing it again is a no-op
    expect(await island1.settle(packet)).toBe('duplicate');
  }, 180_000);

  it('reports a newly created entity over the WebSocket', async () => {
    const store = new SdkStore(KEY!);
    const keys = await deriveGroupKeys('lunar fossil quick river zoo abandon', 1000);
    const now = Math.floor(Date.now() / 1000);
    const { sender, seq } = new SenderIdentity().next();
    const packet = await seal(keys, { type: PacketType.MSG, sender, seq, ts: now }, new TextEncoder().encode('synthetic ws test'));

    let created = 0;
    const stop = store.watch(() => created++, (e) => { throw e; });
    try {
      await new Gateway({ store, keys }).settle(packet);
      await eventually(async () => created > 0);
    } finally {
      stop();
    }
    expect(created).toBeGreaterThan(0);
  }, 120_000);
});
