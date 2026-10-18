import { withTtl } from '../packet/codec.ts';
import { FLAG_RELAYABLE, messageIdHex, PacketType, type Header } from '../packet/format.ts';

/** PRD: transmit only after the carrier has been quiet this long. */
export const QUIET_MS = 300;
/** PRD: random delay of 0.5 to 3 s before each rebroadcast, and between listen-before-talk retries. */
export const MIN_DELAY_MS = 500;
export const MAX_DELAY_MS = 3000;
/** PRD: cancel a pending rebroadcast once the same message id has been heard from this many other phones. */
export const SUPPRESS_AFTER = 2;
/** PRD: an LRU of about 1,000 message ids so loops die out. */
export const MAX_SEEN = 1000;
/** The backoff window doubles after each collision, up to this many times the base window. */
const MAX_WINDOW_FACTOR = 8;

export type MeshEvent =
  | { kind: 'scheduled'; mid: string; delayMs: number }
  | { kind: 'suppressed'; mid: string }
  | { kind: 'deferred'; mid: string; reason: 'carrier busy' | 'transmitting' }
  | { kind: 'relayed'; mid: string; ttl: number }
  | { kind: 'failed'; mid: string; error: Error };

export interface MeshOptions {
  /** This device's sender id: its own packets are never relayed. */
  selfSender: number;
  now?: () => number;
  random?: () => number;
  /** Schedules `fn` after `ms`; returns a function that cancels it. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** True if no carrier has been heard for at least `ms` and none is playing now. */
  quietFor: (ms: number) => boolean;
  /** Plays a packet over sound; resolves when it has finished. */
  transmit: (packet: Uint8Array) => Promise<void>;
  onEvent?: (event: MeshEvent) => void;
}

interface Pending {
  packet: Uint8Array;
  header: Header;
  /** Other phones heard repeating this message while we waited. */
  repeats: number;
  cancel: (() => void) | null;
  done: boolean;
}

const realTimer = (fn: () => void, ms: number) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

/**
 * Flooding with suppression. Feed it every authentic packet heard (new or repeated); it decides which to
 * rebroadcast, waits a random time, and only talks when the channel is quiet and nothing else is queued.
 */
export class Mesh {
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly queue: Pending[] = [];
  private busy = false;
  private windowFactor = 1;
  readonly stats = { relayed: 0, suppressed: 0, deferred: 0 };

  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;

  constructor(private readonly options: MeshOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? realTimer;
  }

  private emit(event: MeshEvent): void {
    this.options.onEvent?.(event);
  }

  private delay(): number {
    return (MIN_DELAY_MS + this.random() * (MAX_DELAY_MS - MIN_DELAY_MS)) * this.windowFactor;
  }

  private remember(mid: string): void {
    this.seen.add(mid);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value!);
  }

  /** Call for every authentic packet of this group that was heard, including repeats. */
  heard(packet: Uint8Array, header: Header): void {
    const mid = messageIdHex(header);

    const waiting = this.pending.get(mid);
    if (waiting) {
      if (!waiting.done && ++waiting.repeats >= SUPPRESS_AFTER) this.suppress(mid, waiting);
      return;
    }
    if (this.seen.has(mid)) return;
    this.remember(mid);

    if (header.sender === this.options.selfSender) return;
    if (header.type !== PacketType.MSG || header.ttl <= 0 || !(header.flags & FLAG_RELAYABLE)) return;

    const entry: Pending = { packet, header, repeats: 0, cancel: null, done: false };
    this.pending.set(mid, entry);
    const delayMs = this.delay();
    this.emit({ kind: 'scheduled', mid, delayMs });
    entry.cancel = this.setTimer(() => this.ready(mid, entry), delayMs);
  }

  /** A carrier appeared but no packet could be decoded: someone collided. Back off harder. */
  collision(): void {
    this.windowFactor = Math.min(MAX_WINDOW_FACTOR, this.windowFactor * 2);
  }

  /** Drop everything waiting, for example when listening stops. */
  stop(): void {
    for (const entry of this.pending.values()) entry.cancel?.();
    this.pending.clear();
    this.queue.length = 0;
  }

  private suppress(mid: string, entry: Pending): void {
    entry.cancel?.();
    entry.done = true;
    this.pending.delete(mid);
    this.stats.suppressed++;
    this.emit({ kind: 'suppressed', mid });
  }

  private ready(mid: string, entry: Pending): void {
    if (entry.done) return;
    entry.cancel = null;
    this.queue.push(entry);
    void this.drain();
  }

  /** One transmission at a time; each one re-checks that the channel is quiet. */
  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const entry = this.queue.shift()!;
        if (entry.done) continue;
        const mid = messageIdHex(entry.header);
        if (!this.options.quietFor(QUIET_MS)) {
          this.stats.deferred++;
          this.emit({ kind: 'deferred', mid, reason: 'carrier busy' });
          entry.cancel = this.setTimer(() => this.ready(mid, entry), this.delay());
          continue;
        }
        entry.done = true;
        this.pending.delete(mid);
        const ttl = entry.header.ttl - 1;
        try {
          await this.options.transmit(withTtl(entry.packet, ttl));
          this.stats.relayed++;
          this.windowFactor = 1;
          this.emit({ kind: 'relayed', mid, ttl });
        } catch (error) {
          this.emit({ kind: 'failed', mid, error: error as Error });
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
