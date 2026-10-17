import type { Frame } from '../modem/frame.ts';

export interface Progress {
  msgId: number;
  received: number;
  total: number;
}

export interface Completed {
  type: Frame['type'];
  msgId: number;
  bytes: Uint8Array;
}

interface Entry {
  type: Frame['type'];
  parts: (Uint8Array | undefined)[];
  count: number;
}

const MAX_PENDING = 4;
const MAX_DELIVERED = 8;

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Collects chunks (in any order, with repeats) into whole messages.
 * A sender may loop its chunks, so a finished message is remembered and repeats of it are ignored;
 * a chunk whose content differs is a new message that happens to reuse the id.
 */
export class Assembler {
  private pending = new Map<number, Entry>();
  private delivered = new Map<number, Entry>();

  add(frame: Frame): { progress: Progress; completed?: Completed } {
    const { msgId, index, total, payload, type } = frame;

    const done = this.delivered.get(msgId);
    if (done) {
      const prior = done.parts[index];
      if (done.type === type && done.parts.length === total && prior && same(prior, payload)) {
        return { progress: { msgId, received: total, total } };
      }
      this.delivered.delete(msgId);
    }

    let entry = this.pending.get(msgId);
    if (entry && (entry.type !== type || entry.parts.length !== total)) entry = undefined;
    if (!entry) {
      entry = { type, parts: new Array(total).fill(undefined), count: 0 };
      this.pending.delete(msgId);
      this.pending.set(msgId, entry);
      while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    }

    const existing = entry.parts[index];
    if (existing && !same(existing, payload)) {
      entry.parts = new Array(total).fill(undefined);
      entry.count = 0;
    }
    if (!entry.parts[index]) {
      entry.parts[index] = payload;
      entry.count++;
    }

    const progress = { msgId, received: entry.count, total };
    if (entry.count < total) return { progress };

    this.pending.delete(msgId);
    this.delivered.set(msgId, entry);
    while (this.delivered.size > MAX_DELIVERED) this.delivered.delete(this.delivered.keys().next().value!);
    const parts = entry.parts as Uint8Array[];
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.length;
    }
    return { progress, completed: { type, msgId, bytes } };
  }
}
