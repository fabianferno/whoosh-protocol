const randomUint32 = (): number => crypto.getRandomValues(new Uint32Array(1))[0];

/**
 * Hands out (sender, seq) pairs. The nonce is built from them, so a pair must never repeat under one
 * key: seq counts up, and when it would wrap the sender id is replaced with a fresh random one.
 * Create a new identity on every app start.
 */
export class SenderIdentity {
  private sender: number;
  private seq = -1;

  /** The current sender id, so a device can recognise (and not relay) its own packets. It changes if seq wraps. */
  get senderId(): number {
    return this.sender;
  }

  constructor(private readonly random: () => number = randomUint32) {
    this.sender = this.random();
  }

  next(): { sender: number; seq: number } {
    if (this.seq >= 0xffff) {
      this.sender = this.random();
      this.seq = -1;
    }
    this.seq++;
    return { sender: this.sender, seq: this.seq };
  }
}
