import { beforeAll, describe, expect, it } from 'vitest';
import { Gateway, MemoryOutbox, type GatewayEvent } from '../src/arkiv/gateway.ts';
import { MemoryStore } from '../src/arkiv/memoryStore.ts';
import { APP, attrsOf, chanHex } from '../src/arkiv/schema.ts';
import { open, peek, seal, sealBeacon } from '../src/packet/codec.ts';
import { DEFAULT_TTL, PacketType } from '../src/packet/format.ts';
import { deriveGroupKeys, type GroupKeys } from '../src/packet/keys.ts';
import { SenderIdentity } from '../src/packet/session.ts';

const NOW = 1_790_000_000;
let keys: GroupKeys;
let other: GroupKeys;
beforeAll(async () => {
  keys = await deriveGroupKeys('lunar fossil quick river zoo abandon', 1000);
  other = await deriveGroupKeys('lunar fossil quick river zoo ability', 1000);
});

const identity = new SenderIdentity();
const msg = (k: GroupKeys, text: string, over: { ts?: number; ttl?: number } = {}) => {
  const { sender, seq } = identity.next();
  return seal(k, { type: PacketType.MSG, sender, seq, ts: over.ts ?? NOW, ttl: over.ttl }, new TextEncoder().encode(text));
};
const gateway = (store: MemoryStore, extra: Partial<ConstructorParameters<typeof Gateway>[0]> = {}) => {
  const events: GatewayEvent[] = [];
  const g = new Gateway({ store, keys, now: () => NOW, onEvent: (e) => events.push(e), ...extra });
  return { g, events };
};
const text = (p: Uint8Array) => open(keys, p).then((o) => new TextDecoder().decode(o!.plaintext));

describe('attributes', () => {
  it('uses 4-hex chan, 12-hex mid, numeric ts and hops from the ttl', async () => {
    const header = peek(await msg(keys, 'x', { ttl: 1 }))!;
    const a = attrsOf(header);
    expect(a.chan).toMatch(/^[0-9a-f]{4}$/);
    expect(a.mid).toMatch(/^[0-9a-f]{12}$/);
    expect(a.ts).toBe(NOW);
    expect(a.hops).toBe(DEFAULT_TTL - 1);
    expect(chanHex(0x0a)).toBe('000a');
  });
});

describe('Gateway.settle', () => {
  it('writes an authentic message byte-for-byte, with the schema attributes', async () => {
    const store = new MemoryStore();
    const { g, events } = gateway(store);
    const packet = await msg(keys, 'meet at noon', { ttl: 2 });
    expect(await g.settle(packet)).toBe('written');
    expect(store.rows).toHaveLength(1);
    const row = store.rows[0];
    expect(row.app).toBe(APP);
    expect([...row.packet]).toEqual([...packet]);
    expect(row.attrs).toEqual(attrsOf(peek(packet)!));
    expect(row.attrs.hops).toBe(1);
    expect(events[0]).toMatchObject({ kind: 'written', hops: 1 });
  });

  it('writes a message once, however many times and however concurrently it is heard', async () => {
    const store = new MemoryStore();
    store.latencyMs = 5;
    const { g } = gateway(store);
    const packet = await msg(keys, 'heard three times');
    const results = await Promise.all([g.settle(packet), g.settle(packet), g.settle(packet)]);
    expect(results.filter((r) => r === 'written')).toHaveLength(1);
    expect(await g.settle(packet)).toBe('duplicate');
    expect(store.rows).toHaveLength(1);
  });

  it('skips a message another gateway already wrote', async () => {
    const store = new MemoryStore();
    const packet = await msg(keys, 'already there');
    expect(await gateway(store).g.settle(packet)).toBe('written');
    expect(await gateway(store).g.settle(packet)).toBe('duplicate');
    expect(store.rows).toHaveLength(1);
  });

  it('ignores, and never pays to write, anything that is not an authentic MSG for this group', async () => {
    const store = new MemoryStore();
    const { g } = gateway(store);
    const good = await msg(keys, 'real');
    const tampered = Uint8Array.from(good);
    tampered[20] ^= 1;
    const cases: Uint8Array[] = [
      await msg(other, 'someone else'),
      tampered,
      good.slice(0, 20),
      new Uint8Array(0),
      await sealBeacon(keys, identity, NOW),
      await msg(keys, 'old news', { ts: NOW - 10 * 86400 }),
    ];
    for (const p of cases) expect(await g.settle(p)).toBe('ignored');
    expect(store.rows).toHaveLength(0);
  });

  it('queues a write that fails and retries it once the connection is back', async () => {
    const store = new MemoryStore();
    const outbox = new MemoryOutbox();
    const { g, events } = gateway(store, { outbox });
    store.online = false;
    const a = await msg(keys, 'first while offline');
    const b = await msg(keys, 'second while offline');
    expect(await g.settle(a)).toBe('queued');
    expect(await g.settle(b)).toBe('queued');
    expect(await g.settle(a)).toBe('queued');
    expect(await outbox.all()).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'queued')).toHaveLength(3);

    store.online = true;
    expect(await g.flush()).toBe(2);
    expect(store.rows).toHaveLength(2);
    expect(await outbox.all()).toHaveLength(0);
    expect(await g.flush()).toBe(0);
  });

  it('lets two gateways that raced both write, and readers still see the message once', async () => {
    const store = new MemoryStore();
    store.latencyMs = 5;
    const packet = await msg(keys, 'raced');
    const [a, b] = [gateway(store).g, gateway(store).g];
    await Promise.all([a.settle(packet), b.settle(packet)]);
    expect(store.rows.length).toBeGreaterThanOrEqual(1);
    store.latencyMs = 0;
    expect((await gateway(store).g.pull())).toHaveLength(1);
  });
});

describe('Gateway.pull', () => {
  it('brings down only verified messages for this group, oldest first, with the ttl reset', async () => {
    const store = new MemoryStore();
    const writer = gateway(store).g;
    const later = await msg(keys, 'second', { ts: NOW - 100, ttl: 0 });
    const earlier = await msg(keys, 'first', { ts: NOW - 200, ttl: 0 });
    await writer.settle(later);
    await writer.settle(earlier);

    // junk written by another wallet straight to Arkiv
    const wrongKey = await msg(other, 'wrong group');
    store.inject(wrongKey, { ...attrsOf(peek(wrongKey)!), chan: attrsOf(peek(later)!).chan });
    store.inject(new Uint8Array(40).fill(7), { ...attrsOf(peek(later)!), mid: 'ffffffffffff' });
    const forged = Uint8Array.from(await msg(keys, 'forged'));
    forged[18] ^= 0xff;
    store.inject(forged, attrsOf(peek(forged)!));

    const island2 = gateway(store).g;
    const got = await island2.pull();
    expect(await Promise.all(got.map(text))).toEqual(['first', 'second']);
    for (const p of got) expect(peek(p)!.ttl).toBe(DEFAULT_TTL);
    expect(await island2.pull()).toEqual([]);
  });

  it('skips messages the local mesh already has and the ones this gateway wrote', async () => {
    const store = new MemoryStore();
    const heard = await msg(keys, 'heard locally');
    const mine = await msg(keys, 'i wrote this');
    const fresh = await msg(keys, 'new to us');
    const other1 = gateway(store).g;
    for (const p of [heard, mine, fresh]) await other1.settle(p);

    const known = new Set([attrsOf(peek(heard)!).mid]);
    const { g } = gateway(store, { hasLocally: (mid) => known.has(mid) });
    await g.settle(mine);
    expect(await Promise.all((await g.pull()).map(text))).toEqual(['new to us']);
  });

  it('still finds a message from a sender whose clock runs a few minutes behind', async () => {
    const store = new MemoryStore();
    const writer = gateway(store).g;
    const reader = gateway(store).g;
    await writer.settle(await msg(keys, 'on time', { ts: NOW }));
    expect(await reader.pull()).toHaveLength(1);
    await writer.settle(await msg(keys, 'slow clock', { ts: NOW - 300 }));
    expect(await Promise.all((await reader.pull()).map(text))).toEqual(['slow clock']);
  });
});

describe('Gateway.start', () => {
  it('replays existing messages, then each new one as Arkiv reports it, and stops when told', async () => {
    const store = new MemoryStore();
    const writer = gateway(store).g;
    await writer.settle(await msg(keys, 'already on arkiv'));

    const replayed: string[] = [];
    const reader = gateway(store).g;
    const stop = reader.start((packets) => void Promise.all(packets.map(text)).then((t) => replayed.push(...t)));
    await vi_waitFor(() => replayed.length === 1);
    await writer.settle(await msg(keys, 'arrives live'));
    await vi_waitFor(() => replayed.length === 2);
    expect(replayed).toEqual(['already on arkiv', 'arrives live']);

    stop();
    await writer.settle(await msg(keys, 'after stop'));
    await new Promise((r) => setTimeout(r, 30));
    expect(replayed).toHaveLength(2);
  });

  it('reports a failing store as an event instead of throwing', async () => {
    const store = new MemoryStore();
    store.online = false;
    const { g, events } = gateway(store);
    const stop = g.start(() => undefined);
    await vi_waitFor(() => events.some((e) => e.kind === 'error'));
    stop();
  });
});

async function vi_waitFor(check: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}
