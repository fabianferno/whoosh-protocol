import { acceptedChannelTags } from '../packet/channel.ts';
import { isForChannel, open, peek, withTtl } from '../packet/codec.ts';
import { DEFAULT_TTL, PacketType } from '../packet/format.ts';
import type { GroupKeys } from '../packet/keys.ts';
import { attrsOf, chanHex, SKEW_OVERLAP_SECONDS, type ArkivStore } from './schema.ts';

export type SettleResult = 'written' | 'duplicate' | 'queued' | 'ignored';

export type GatewayEvent =
  | { kind: 'written'; mid: string; key: string; txHash: string; hops: number }
  | { kind: 'duplicate'; mid: string }
  | { kind: 'queued'; mid: string; reason: string }
  | { kind: 'pulled'; count: number }
  | { kind: 'error'; error: Error };

/** Packets that could not be written yet, kept until a connection appears. Keyed by message id. */
export interface Outbox {
  add(mid: string, packet: Uint8Array): Promise<void>;
  all(): Promise<{ mid: string; packet: Uint8Array }[]>;
  remove(mid: string): Promise<void>;
}

export class MemoryOutbox implements Outbox {
  private readonly items = new Map<string, Uint8Array>();
  async add(mid: string, packet: Uint8Array) {
    this.items.set(mid, packet);
  }
  async all() {
    return [...this.items].map(([mid, packet]) => ({ mid, packet }));
  }
  async remove(mid: string) {
    this.items.delete(mid);
  }
}

export interface GatewayOptions {
  store: ArkivStore;
  keys: GroupKeys;
  /** True if the local mesh already holds this message id, so it need not be replayed over audio. */
  hasLocally?: (mid: string) => boolean;
  outbox?: Outbox;
  now?: () => number;
  onEvent?: (event: GatewayEvent) => void;
}

/** First look back this far when nothing has been read yet. */
const FIRST_LOOKBACK_SECONDS = 3600;

/**
 * Settles heard packets to Arkiv and brings a group's packets back down. It never writes a packet
 * it has not verified (channel tag, then GCM tag), and never trusts an entity it reads until the
 * GCM tag checks out: anyone can write an entity with any attributes.
 */
export class Gateway {
  private readonly store: ArkivStore;
  private readonly keys: GroupKeys;
  private readonly hasLocally: (mid: string) => boolean;
  private readonly outbox: Outbox;
  private readonly now: () => number;
  private readonly emit: (event: GatewayEvent) => void;
  private readonly settled = new Set<string>();
  private readonly inflight = new Set<string>();
  private readonly pulled = new Set<string>();
  private newestTs: number | null = null;

  constructor(options: GatewayOptions) {
    this.store = options.store;
    this.keys = options.keys;
    this.hasLocally = options.hasLocally ?? (() => false);
    this.outbox = options.outbox ?? new MemoryOutbox();
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.emit = options.onEvent ?? (() => undefined);
  }

  /** Writes `packet` to Arkiv if it is an authentic, new MSG for this group. Never throws. */
  async settle(packet: Uint8Array): Promise<SettleResult> {
    const header = peek(packet);
    if (!header || header.type !== PacketType.MSG) return 'ignored';
    if (!(await isForChannel(this.keys, packet, this.now()))) return 'ignored';
    if (!(await open(this.keys, packet))) return 'ignored';

    const attrs = attrsOf(header);
    if (this.settled.has(attrs.mid)) return 'duplicate';
    if (this.inflight.has(attrs.mid)) return 'duplicate';
    this.inflight.add(attrs.mid);
    try {
      if (await this.store.exists(attrs.chan, attrs.mid)) {
        this.settled.add(attrs.mid);
        this.emit({ kind: 'duplicate', mid: attrs.mid });
        return 'duplicate';
      }
      const { key, txHash } = await this.store.create(packet, attrs);
      this.settled.add(attrs.mid);
      await this.outbox.remove(attrs.mid);
      this.emit({ kind: 'written', mid: attrs.mid, key, txHash, hops: attrs.hops });
      return 'written';
    } catch (error) {
      await this.outbox.add(attrs.mid, packet);
      this.emit({ kind: 'queued', mid: attrs.mid, reason: (error as Error).message });
      return 'queued';
    } finally {
      this.inflight.delete(attrs.mid);
    }
  }

  /** Retries everything in the outbox. Returns how many were written. */
  async flush(): Promise<number> {
    let written = 0;
    for (const { packet } of await this.outbox.all()) {
      if ((await this.settle(packet)) === 'written') written++;
    }
    return written;
  }

  /**
   * Packets on Arkiv for this group that the local mesh lacks, verified, oldest first. Each is
   * returned once, with its ttl reset so the mesh can relay it.
   */
  async pull(): Promise<Uint8Array[]> {
    const now = this.now();
    const since = (this.newestTs ?? now - FIRST_LOOKBACK_SECONDS) - SKEW_OVERLAP_SECONDS;
    const found: { ts: number; mid: string; packet: Uint8Array }[] = [];

    for (const tag of await acceptedChannelTags(this.keys, now)) {
      for (const { packet } of await this.store.query(chanHex(tag), since)) {
        const header = peek(packet);
        if (!header || header.type !== PacketType.MSG) continue;
        if (!(await open(this.keys, packet))) continue; // forged or damaged entity: ignore
        const mid = attrsOf(header).mid;
        this.newestTs = Math.max(this.newestTs ?? 0, header.ts);
        if (this.pulled.has(mid) || this.settled.has(mid) || this.hasLocally(mid)) continue;
        this.pulled.add(mid);
        found.push({ ts: header.ts, mid, packet });
      }
    }

    found.sort((a, b) => a.ts - b.ts || (a.mid < b.mid ? -1 : a.mid > b.mid ? 1 : 0));
    if (found.length) this.emit({ kind: 'pulled', count: found.length });
    return found.map((f) => withTtl(f.packet, DEFAULT_TTL));
  }

  /**
   * Flushes the outbox, catches up, and keeps doing both whenever Arkiv reports a new entity.
   * `onReplay` gets packets to rebroadcast over audio. Returns a function that stops it.
   */
  start(onReplay: (packets: Uint8Array[]) => void): () => void {
    let busy = false;
    let again = false;
    let stopped = false;

    const run = async (): Promise<void> => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          await this.flush();
          const packets = await this.pull();
          if (packets.length && !stopped) onReplay(packets);
        } while (again && !stopped);
      } catch (error) {
        this.emit({ kind: 'error', error: error as Error });
      } finally {
        busy = false;
      }
    };

    void run();
    const unwatch = this.store.watch(
      () => void run(),
      (error) => this.emit({ kind: 'error', error }),
    );
    return () => {
      stopped = true;
      unwatch();
    };
  }
}
