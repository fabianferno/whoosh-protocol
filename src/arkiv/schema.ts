import { DEFAULT_TTL, messageIdHex, type Header } from '../packet/format.ts';

export const APP = 'whoosh';
export const ENTITY_DAYS = 7;
/** Arkiv returns at most 200 entities per page. */
export const PAGE_LIMIT = 200;
/** Catch-up re-reads this much before the newest timestamp it has seen, so sender clock skew loses nothing. */
export const SKEW_OVERLAP_SECONDS = 600;

/** The queryable attributes of a `whoosh.msg` entity. See arkiv/schema.md. */
export interface MsgAttrs {
  /** 4 hex characters. */
  chan: string;
  /** 12 hex characters: sender + seq. */
  mid: string;
  /** Unix seconds. */
  ts: number;
  hops: number;
}

export const chanHex = (chan: number): string => chan.toString(16).padStart(4, '0');

export function attrsOf(header: Header): MsgAttrs {
  return {
    chan: chanHex(header.chan),
    mid: messageIdHex(header),
    ts: header.ts,
    hops: Math.max(0, DEFAULT_TTL - header.ttl),
  };
}

/** A packet read back from Arkiv. */
export interface SettledMessage {
  key: string;
  packet: Uint8Array;
  /** The wallet that paid to write it. */
  creator: string;
}

/** What the gateway needs from Arkiv. The SDK-backed store and an in-memory one both implement it. */
export interface ArkivStore {
  /** Is a `whoosh.msg` with this channel and message id already stored? */
  exists(chan: string, mid: string): Promise<boolean>;
  create(packet: Uint8Array, attrs: MsgAttrs): Promise<{ key: string; txHash: string }>;
  /** Every `whoosh.msg` on `chan` with `ts >= sinceTs`, across all pages, in no particular order. */
  query(chan: string, sinceTs: number): Promise<SettledMessage[]>;
  /** Calls `onCreated` whenever any entity is created. Returns a function that stops watching. */
  watch(onCreated: () => void, onError: (error: Error) => void): () => void;
}
