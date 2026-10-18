export interface MessageId {
  sender: number;
  seq: number;
}

const ID_BYTES = 6;
/** 16 pairs is 96 bytes, inside the 100-byte plaintext limit. */
export const MAX_HAVE_ENTRIES = 16;

function writeId(view: DataView, at: number, id: MessageId): void {
  view.setUint32(at, id.sender);
  view.setUint16(at + 4, id.seq);
}

const readId = (view: DataView, at: number): MessageId => ({ sender: view.getUint32(at), seq: view.getUint16(at + 4) });

/** HAVE: for each sender, the highest seq this device holds. */
export function encodeHave(entries: MessageId[]): Uint8Array<ArrayBuffer> {
  if (entries.length > MAX_HAVE_ENTRIES) throw new Error(`HAVE holds at most ${MAX_HAVE_ENTRIES} entries`);
  const out = new Uint8Array(entries.length * ID_BYTES);
  const view = new DataView(out.buffer);
  entries.forEach((e, i) => writeId(view, i * ID_BYTES, e));
  return out;
}

/** Null if the length is not a whole number of entries. */
export function decodeHave(bytes: Uint8Array): MessageId[] | null {
  if (bytes.length % ID_BYTES !== 0 || bytes.length / ID_BYTES > MAX_HAVE_ENTRIES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length / ID_BYTES }, (_, i) => readId(view, i * ID_BYTES));
}

/** WANT: one specific missing message. */
export function encodeWant(id: MessageId): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(ID_BYTES);
  writeId(new DataView(out.buffer), 0, id);
  return out;
}

export function decodeWant(bytes: Uint8Array): MessageId | null {
  return bytes.length === ID_BYTES ? readId(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0) : null;
}
