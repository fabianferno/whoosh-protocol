import { APP, type ArkivStore, type MsgAttrs, type SettledMessage } from './schema.ts';

interface Row extends SettledMessage {
  app: string;
  attrs: MsgAttrs;
}

/** An in-memory ArkivStore, for tests and for the two-tab / loopback demo. Not a real chain. */
export class MemoryStore implements ArkivStore {
  readonly rows: Row[] = [];
  /** Set false to make every call fail, as if the phone were offline. */
  online = true;
  /** Extra async delay per call, to expose races. */
  latencyMs = 0;
  private listeners = new Set<() => void>();
  private nextKey = 1;

  constructor(private readonly creator = '0x00000000000000000000000000000000000000aa') {}

  private async gate(): Promise<void> {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    if (!this.online) throw new Error('offline');
  }

  async exists(chan: string, mid: string): Promise<boolean> {
    await this.gate();
    return this.rows.some((r) => r.app === APP && r.attrs.chan === chan && r.attrs.mid === mid);
  }

  async create(packet: Uint8Array, attrs: MsgAttrs): Promise<{ key: string; txHash: string }> {
    await this.gate();
    const key = `0x${(this.nextKey++).toString(16).padStart(64, '0')}`;
    this.rows.push({ key, packet: Uint8Array.from(packet), creator: this.creator, app: APP, attrs: { ...attrs } });
    queueMicrotask(() => this.listeners.forEach((l) => l()));
    return { key, txHash: `0x${key.slice(2)}` };
  }

  /** Writes an entity directly, as any other wallet could, bypassing the gateway's checks. */
  inject(packet: Uint8Array, attrs: MsgAttrs, creator = '0x00000000000000000000000000000000000000bb'): void {
    this.rows.push({ key: `0xinj${this.nextKey++}`, packet, creator, app: APP, attrs });
    queueMicrotask(() => this.listeners.forEach((l) => l()));
  }

  async query(chan: string, sinceTs: number): Promise<SettledMessage[]> {
    await this.gate();
    return this.rows
      .filter((r) => r.app === APP && r.attrs.chan === chan && r.attrs.ts >= sinceTs)
      .map(({ key, packet, creator }) => ({ key, packet, creator }));
  }

  watch(onCreated: () => void): () => void {
    this.listeners.add(onCreated);
    return () => this.listeners.delete(onCreated);
  }
}
