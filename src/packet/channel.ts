import type { GroupKeys } from './keys.ts';

const DAY_SECONDS = 86400;

export const dayOf = (unixSeconds: number): number => Math.floor(unixSeconds / DAY_SECONDS);

/** Truncated HMAC(group key, day), 16 bits. Lets a device skip other groups' packets without decrypting. */
export async function channelTag(keys: GroupKeys, day: number): Promise<number> {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, day);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', keys.tag, data));
  return (mac[0] << 8) | mac[1];
}

/** Yesterday, today and tomorrow, so clocks that disagree by a few hours still match. */
export async function acceptedChannelTags(keys: GroupKeys, nowSeconds: number): Promise<Set<number>> {
  const today = dayOf(nowSeconds);
  return new Set(await Promise.all([today - 1, today, today + 1].map((d) => channelTag(keys, d))));
}
