import { createPublicClient, createWalletClient } from '@arkiv-network/sdk';
import { i32, u64 } from '@arkiv-network/sdk/attr';
import { tiramisu } from '@arkiv-network/sdk/chains';
import { eq, gte } from '@arkiv-network/sdk/query';
import { ExpirationTime } from '@arkiv-network/sdk/utils';
import { http, webSocket } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { APP, ENTITY_DAYS, PAGE_LIMIT, type ArkivStore, type MsgAttrs, type SettledMessage } from './schema.ts';

/** ArkivStore on the Tiramisu testnet, through @arkiv-network/sdk. */
export class SdkStore implements ArkivStore {
  readonly address: `0x${string}`;
  private readonly reader = createPublicClient({ chain: tiramisu, transport: http() });
  private readonly writer;

  constructor(privateKey: `0x${string}`) {
    const account = privateKeyToAccount(privateKey);
    this.address = account.address;
    this.writer = createWalletClient({ chain: tiramisu, transport: http(), account });
  }

  /** Native balance in wei; creating an entity costs gas, so zero means "fund this address first". */
  balance(): Promise<bigint> {
    return this.reader.getBalance({ address: this.address });
  }

  async exists(chan: string, mid: string): Promise<boolean> {
    const result = await this.reader
      .select({ key: true })
      .where(eq('app', APP), eq('chan', chan), eq('mid', mid))
      .limit(1)
      .fetch();
    return result.entities.length > 0;
  }

  async create(packet: Uint8Array, attrs: MsgAttrs): Promise<{ key: string; txHash: string }> {
    const { entityKey, txHash } = await this.writer.createEntity({
      payload: packet,
      contentType: 'application/octet-stream',
      attributes: { app: APP, chan: attrs.chan, mid: attrs.mid, ts: u64(attrs.ts), hops: i32(attrs.hops) },
      expires: ExpirationTime.fromDays(ENTITY_DAYS),
    });
    return { key: entityKey, txHash };
  }

  async query(chan: string, sinceTs: number): Promise<SettledMessage[]> {
    const out: SettledMessage[] = [];
    let page = await this.reader
      .select({ key: true, creator: true, payload: true })
      .where(eq('app', APP), eq('chan', chan), gte('ts', u64(sinceTs)))
      .limit(PAGE_LIMIT)
      .fetch();
    for (;;) {
      for (const e of page.entities) out.push({ key: e.key, creator: e.creator, packet: e.payload });
      if (!page.hasNextPage()) return out;
      page = await page.next();
    }
  }

  /** Opens a WebSocket (a real subscription; over HTTP the SDK would silently poll). */
  watch(onCreated: () => void, onError: (error: Error) => void): () => void {
    const live = createPublicClient({ chain: tiramisu, transport: webSocket() });
    return live.watchEntityEvents({ onEntityCreated: () => onCreated(), onError });
  }
}
