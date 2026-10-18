import { encodeBytes, TX_RATE, type Band } from '../audio/ggwave.ts';
import { isForChannel, openText, sealText } from '../packet/codec.ts';
import { messageIdHex, MIN_PACKET_BYTES, type Header } from '../packet/format.ts';
import type { GroupKeys } from '../packet/keys.ts';
import type { SenderIdentity } from '../packet/session.ts';

export interface SecureSend {
  samples: Float32Array;
  seconds: number;
  packetBytes: number;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Seals `text` for the group and renders the packet as sound. Takes a new seq each call. */
export async function prepareSecureSend(
  keys: GroupKeys, identity: SenderIdentity, text: string, band: Band, now = nowSeconds(),
): Promise<SecureSend> {
  const packet = await sealText(keys, identity, text, now);
  const samples = await encodeBytes(packet, band);
  return { samples, seconds: samples.length / TX_RATE, packetBytes: packet.length };
}

/** Airtime for a message of `plainBytes` bytes, without sealing (so it does not use up a seq). */
export async function estimateSeconds(plainBytes: number, band: Band): Promise<number> {
  const samples = await encodeBytes(new Uint8Array(MIN_PACKET_BYTES + plainBytes), band);
  return samples.length / TX_RATE;
}

export interface Received {
  text: string;
  header: Header;
  /** Hex sender + seq. */
  mid: string;
}

/**
 * Turns packet bytes heard over the air into messages: drops other groups' packets by channel tag,
 * forgeries and damage by the GCM tag, and repeats by message id. Nothing is reported for a drop.
 */
export class PacketInbox {
  private readonly seen = new Set<string>();

  constructor(private readonly keys: GroupKeys, private readonly maxSeen = 1000) {}

  /** True if this message id has already been accepted. */
  has(mid: string): boolean {
    return this.seen.has(mid);
  }

  async accept(packet: Uint8Array, now = nowSeconds()): Promise<Received | null> {
    return (await this.inspect(packet, now))?.received ?? null;
  }

  /**
   * Like accept, but also reports authentic repeats, which the mesh needs to count: `received` is set only
   * the first time a message id is seen. Null for anything not authentic for this group.
   */
  async inspect(packet: Uint8Array, now = nowSeconds()): Promise<{ header: Header; mid: string; received: Received | null } | null> {
    if (!(await isForChannel(this.keys, packet, now))) return null;
    const opened = await openText(this.keys, packet);
    if (!opened) return null;
    const mid = messageIdHex(opened.header);
    if (this.seen.has(mid)) return { header: opened.header, mid, received: null };
    this.seen.add(mid);
    if (this.seen.size > this.maxSeen) this.seen.delete(this.seen.values().next().value!);
    return { header: opened.header, mid, received: { text: opened.text, header: opened.header, mid } };
  }
}
