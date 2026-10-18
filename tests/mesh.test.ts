import { describe, expect, it } from 'vitest';
import { Mesh, MAX_SEEN } from '../src/mesh/mesh.ts';
import { FLAG_RELAYABLE, HEADER_BYTES, messageIdHex, packHeader, PacketType, parseHeader, TAG_BYTES, type Header } from '../src/packet/format.ts';
import { rng } from './helpers/channel.ts';

const AIRTIME_MS = 4000;

function packet(over: Partial<Header> = {}): Uint8Array {
  const header: Header = {
    type: PacketType.MSG, ttl: 3, flags: FLAG_RELAYABLE, chan: 1, sender: 0xaaaa0001, seq: 1,
    fragIndex: 0, fragCount: 1, ts: 1_790_000_000, ...over,
  };
  const out = new Uint8Array(HEADER_BYTES + 5 + TAG_BYTES);
  out.set(packHeader(header));
  return out;
}

/** A tiny radio world with virtual time: nodes hear only neighbours, overlapping transmissions collide. */
class Sim {
  time = 0;
  private seq = 0;
  private events: { t: number; n: number; fn: () => void; live: boolean }[] = [];
  nodes = new Map<string, SimNode>();
  private links = new Map<string, Set<string>>();
  transmissions: { from: string; at: number; ttl: number; mid: string }[] = [];

  constructor(readonly seed = 1) {}

  after(ms: number, fn: () => void): () => void {
    const ev = { t: this.time + ms, n: this.seq++, fn, live: true };
    this.events.push(ev);
    return () => { ev.live = false; };
  }

  /** Runs events in time order, letting promise continuations (transmit() resolving) run between them. */
  async run(untilMs: number): Promise<void> {
    for (;;) {
      const next = this.events.filter((e) => e.live).sort((a, b) => a.t - b.t || a.n - b.n)[0];
      if (!next || next.t > untilMs) break;
      this.events = this.events.filter((e) => e !== next);
      this.time = next.t;
      next.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    this.time = untilMs;
  }

  add(id: string, sender: number): SimNode {
    const node = new SimNode(this, id, sender, rng(this.seed * 1000 + this.nodes.size));
    this.nodes.set(id, node);
    this.links.set(id, new Set());
    return node;
  }

  link(a: string, b: string): void {
    this.links.get(a)!.add(b);
    this.links.get(b)!.add(a);
  }

  neighbours(id: string): SimNode[] {
    return [...this.links.get(id)!].map((n) => this.nodes.get(n)!);
  }
}

class SimNode {
  readonly mesh: Mesh;
  readonly delivered = new Set<string>(); // distinct messages the "app" accepted
  readonly copies: Header[] = [];
  txUntil = 0;
  private windows: { from: number; to: number; sender: string; packet: Uint8Array }[] = [];
  lastBusyEnd = -Infinity;
  collisions = 0;

  constructor(private readonly sim: Sim, readonly id: string, sender: number, random: () => number) {
    this.mesh = new Mesh({
      selfSender: sender,
      now: () => sim.time,
      random,
      setTimer: (fn, ms) => sim.after(ms, fn),
      quietFor: (ms) => this.quietFor(ms),
      transmit: (p) => this.transmit(p),
    });
  }

  quietFor(ms: number): boolean {
    if (this.sim.time < this.txUntil) return false;
    if (this.windows.some((w) => w.from <= this.sim.time && this.sim.time < w.to)) return false;
    return this.sim.time - this.lastBusyEnd >= ms;
  }

  /** The user's own send: not subject to relay logic. */
  originate(p: Uint8Array): Promise<void> {
    this.delivered.add(messageIdHex(parseHeader(p)!));
    return this.transmit(p);
  }

  transmit(p: Uint8Array): Promise<void> {
    const t0 = this.sim.time;
    const header = parseHeader(p)!;
    this.txUntil = t0 + AIRTIME_MS;
    this.sim.transmissions.push({ from: this.id, at: t0, ttl: header.ttl, mid: messageIdHex(header) });
    for (const n of this.sim.neighbours(this.id)) n.windows.push({ from: t0, to: t0 + AIRTIME_MS, sender: this.id, packet: p });
    return new Promise((resolve) => {
      this.sim.after(AIRTIME_MS, () => {
        for (const n of this.sim.neighbours(this.id)) n.finish(t0, this.id);
        resolve();
      });
    });
  }

  private finish(from: number, sender: string): void {
    const mine = this.windows.find((w) => w.from === from && w.sender === sender)!;
    this.lastBusyEnd = Math.max(this.lastBusyEnd, mine.to);
    const overlapping = this.windows.filter((w) => w !== mine && w.from < mine.to && w.to > mine.from);
    const iWasTalking = this.txUntil > mine.from && this.txUntil <= mine.to + AIRTIME_MS && this.txStart() < mine.to && this.txUntil > mine.from;
    this.windows = this.windows.filter((w) => w.to > this.sim.time);
    if (overlapping.length > 0) {
      this.collisions++;
      this.mesh.collision();
      return;
    }
    if (iWasTalking) return;
    const header = parseHeader(mine.packet)!;
    this.copies.push(header);
    this.delivered.add(messageIdHex(header));
    this.mesh.heard(mine.packet, header);
  }

  private txStart(): number {
    return this.sim.transmissions.filter((t) => t.from === this.id).reduce((a, t) => Math.max(a, t.at), -Infinity);
  }
}

const relaysOf = (sim: Sim, mid: string) => sim.transmissions.filter((t) => t.mid === mid).slice(1);

describe('Mesh relay', () => {
  it('carries a message from A to C through B when C is out of A\'s range, once, with the ttl lowered', async () => {
    const sim = new Sim(1);
    const a = sim.add('A', 0xa);
    sim.add('B', 0xb);
    const c = sim.add('C', 0xc);
    sim.link('A', 'B');
    sim.link('B', 'C');
    const p = packet({ sender: 0xa, ttl: 3 });
    void a.originate(p);
    await sim.run(60_000);
    expect(c.delivered.size).toBe(1);
    expect(c.copies.map((h) => h.ttl)).toEqual([2]);
    const mid = messageIdHex(parseHeader(p)!);
    // flooding: each hop relays once, with the ttl one lower; A never repeats its own message
    expect(sim.transmissions.filter((t) => t.mid === mid).map((t) => `${t.from}:${t.ttl}`)).toEqual(['A:3', 'B:2', 'C:1']);
  });

  it('does not relay a packet whose ttl is 0, nor a message from itself, nor an unrelayable or non-MSG packet', async () => {
    const sim = new Sim(2);
    const a = sim.add('A', 0xa);
    const b = sim.add('B', 0xb);
    sim.link('A', 'B');
    for (const over of [{ ttl: 0 }, { flags: 0 }, { type: PacketType.BEACON }, { type: PacketType.HAVE }]) {
      void a.originate(packet({ sender: 0xa, seq: Math.floor(Math.random() * 60000), ...over }));
      await sim.run(sim.time + 30_000);
    }
    expect(sim.transmissions.every((t) => t.from === 'A')).toBe(true);
    expect(b.mesh.stats.relayed).toBe(0);
    // B hears its own message come back from A's relay path: never relayed
    const own = packet({ sender: 0xb, seq: 9, ttl: 3 });
    void a.originate(own);
    await sim.run(sim.time + 30_000);
    expect(sim.transmissions.filter((t) => t.from === 'B')).toHaveLength(0);
  });

  it('relays a given message at most once however often it is heard', async () => {
    const sim = new Sim(3);
    const a = sim.add('A', 0xa);
    const b = sim.add('B', 0xb);
    sim.link('A', 'B');
    const p = packet({ sender: 0xa, ttl: 3 });
    for (let i = 0; i < 4; i++) {
      void a.originate(p);
      await sim.run(sim.time + 20_000);
    }
    expect(b.mesh.stats.relayed).toBe(1);
  });

  it('suppresses redundant relays when several neighbours cover the same area', async () => {
    let totalRelays = 0;
    let runs = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const sim = new Sim(seed);
      const a = sim.add('A', 0xa);
      const relays = ['B1', 'B2', 'B3', 'B4'].map((id, i) => sim.add(id, 0xb0 + i));
      const c = sim.add('C', 0xc);
      for (const r of relays) {
        sim.link('A', r.id);
        sim.link(r.id, 'C');
        for (const o of relays) if (o !== r) sim.link(r.id, o.id);
      }
      const p = packet({ sender: 0xa, ttl: 3 });
      void a.originate(p);
      await sim.run(90_000);
      const n = relaysOf(sim, messageIdHex(parseHeader(p)!)).filter((t) => t.from.startsWith('B')).length;
      totalRelays += n;
      runs++;
      expect(c.delivered.size).toBe(1);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThan(4);
    }
    expect(totalRelays / runs).toBeLessThan(3);
  });

  it('never talks over another transmission it can hear (listen-before-talk)', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const sim = new Sim(seed);
      const a = sim.add('A', 0xa);
      sim.add('B1', 0xb1);
      sim.add('B2', 0xb2);
      sim.link('A', 'B1');
      sim.link('A', 'B2');
      sim.link('B1', 'B2');
      void a.originate(packet({ sender: 0xa, ttl: 3 }));
      await sim.run(90_000);
      for (const n of sim.nodes.values()) expect(n.collisions, `seed ${seed} node ${n.id}`).toBe(0);
    }
  });

  it('backs off for longer after a collision, and returns to the normal window after a success', () => {
    const delays: number[] = [];
    const mesh = new Mesh({
      selfSender: 1, random: () => 0, setTimer: () => () => undefined, quietFor: () => true,
      transmit: async () => undefined, onEvent: (e) => { if (e.kind === 'scheduled') delays.push(e.delayMs); },
    });
    const hear = (seq: number) => mesh.heard(packet({ seq, sender: 9 }), parseHeader(packet({ seq, sender: 9 }))!);
    hear(1);
    mesh.collision();
    hear(2);
    mesh.collision();
    hear(3);
    expect(delays).toEqual([500, 1000, 2000]);
  });

  it('bounds its seen-set', () => {
    const mesh = new Mesh({ selfSender: 1, quietFor: () => true, transmit: async () => undefined, setTimer: () => () => undefined });
    for (let i = 0; i < MAX_SEEN + 50; i++) {
      const p = packet({ seq: i % 65535, sender: 1000 + Math.floor(i / 65535), ttl: 0 });
      mesh.heard(p, parseHeader(p)!);
    }
    // the oldest ids were forgotten: hearing the first one again is "new" (it is scheduled again if relayable)
    const events: string[] = [];
    const m2 = new Mesh({ selfSender: 1, quietFor: () => true, transmit: async () => undefined, setTimer: () => () => undefined, onEvent: (e) => events.push(e.kind) });
    for (let i = 0; i < MAX_SEEN + 5; i++) {
      const p = packet({ seq: i, sender: 7 });
      m2.heard(p, parseHeader(p)!);
    }
    const first = packet({ seq: 0, sender: 7 });
    const before = events.length;
    m2.heard(first, parseHeader(first)!);
    expect(events.length).toBe(before); // still pending, so not re-scheduled
  });

  it('stop() cancels everything waiting', async () => {
    const sim = new Sim(5);
    const a = sim.add('A', 0xa);
    const b = sim.add('B', 0xb);
    sim.link('A', 'B');
    void a.originate(packet({ sender: 0xa, ttl: 3 }));
    await sim.run(AIRTIME_MS + 100);
    b.mesh.stop();
    await sim.run(60_000);
    expect(b.mesh.stats.relayed).toBe(0);
  });
});
