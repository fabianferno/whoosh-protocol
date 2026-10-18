import type { Outbox } from '../arkiv/gateway.ts';
import { idbAll, idbDelete, idbPut } from './idb.ts';

/** Packets waiting for a connection, kept in IndexedDB so they survive closing the app. */
export class IdbOutbox implements Outbox {
  async add(mid: string, packet: Uint8Array): Promise<void> {
    try {
      await idbPut('outbox', mid, packet);
    } catch {
      /* storage blocked: the packet stays queued only for this session */
    }
  }

  async all(): Promise<{ mid: string; packet: Uint8Array }[]> {
    try {
      return (await idbAll<Uint8Array>('outbox')).map(({ key, value }) => ({ mid: key, packet: value }));
    } catch {
      return [];
    }
  }

  async remove(mid: string): Promise<void> {
    try {
      await idbDelete('outbox', mid);
    } catch {
      /* nothing to remove */
    }
  }
}
