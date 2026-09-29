// EMB-14: reserve before opening an engine, settle before releasing the hold.
// The pool belongs to the server's shared factory, never to an individual socket.
export interface SttAllowance {
  userId: string;
  keyId?: string;
  ms: number;
}

export class SttAllowancePool {
  private readonly active = new Set<SttAllowance>();

  available(userId: string, payerMs: number, keyId?: string, keyMs = Infinity, own?: SttAllowance): number {
    let payerHeld = 0;
    let keyHeld = 0;
    for (const hold of this.active) {
      if (hold === own) continue;
      if (hold.userId === userId) payerHeld += hold.ms;
      if (keyId !== undefined && hold.keyId === keyId) keyHeld += hold.ms;
    }
    return Math.max(0, Math.min(payerMs === Infinity ? Infinity : payerMs - payerHeld,
      keyMs === Infinity ? Infinity : keyMs - keyHeld));
  }

  reserve(userId: string, payerMs: number, capMs: number, keyId?: string, keyMs = Infinity): SttAllowance {
    const hold = { userId, keyId, ms: Math.min(capMs, this.available(userId, payerMs, keyId, keyMs)) };
    this.active.add(hold);
    return hold;
  }

  release(hold: SttAllowance): void { this.active.delete(hold); }
}
