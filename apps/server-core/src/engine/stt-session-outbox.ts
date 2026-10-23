// Card SEG-1 — the ordered exit for the session's transcript frames.
//
// WHY THIS EXISTS. Since SEG-1 a soft-segment final is polished before it
// leaves (stt-session.ts, the 'final' handler), so it can no longer be emitted
// at the moment it arrives. The frames that come AFTER it (the next segment's
// interims, its final, an `stt:error`, the terminal final) must still reach the
// phone AFTER it: the phone assembles a segment's row from every slot at or
// above its watermark (`apps/mobile/lib/src/stt/segment_buffer.dart`
// `joinedFrom`, which has no upper bound), so an interim for segment N+1 that
// overtook the final for segment N would be folded into N's row AND later into
// N+1's — the same words on two rows.
//
// THE RULE. While no slot is reserved, `emit` runs the frame synchronously —
// byte-for-byte today's timing for every session that never polishes a segment
// (polish off, continuous recordings, the detached mode). Once a slot is
// reserved, every later frame queues behind it and the queue releases in
// arrival order as each slot is filled.
//
// 🔴 A RESERVED SLOT MUST BE FILLED, or the session goes silent. The one caller
// fills in a `finally` (stt-session.ts `polishSegmentFinal`), with a no-op when
// the polish path emitted nothing (session torn down mid-polish).

import { log } from '../log';

export class OrderedOutbox {
  private tail: Promise<void> | null = null;

  /** `live()` false ⇒ a QUEUED frame is dropped when its turn comes (the session
   *  was torn down while it waited — same rule as the polished emit's `disposed`
   *  check). A frame run synchronously is never gated: that is today's path. */
  constructor(private readonly live: () => boolean = () => true) {}

  /** Run `frame` now, or after every reserved slot ahead of it. */
  emit(frame: () => void): void {
    if (this.tail === null) { frame(); return; }
    this.link(this.tail.then(() => { if (this.live()) runSafely(frame); }));
  }

  /** Hold a place in the order; frames emitted after this wait until the
   *  returned function is called with the frame for this place. */
  reserve(): (frame: () => void) => void {
    let fill!: (frame: () => void) => void;
    const filled = new Promise<() => void>((resolve) => { fill = resolve; });
    const prev = this.tail ?? Promise.resolve();
    this.link(Promise.all([prev, filled]).then(([, frame]) => { if (this.live()) runSafely(frame); }));
    return fill;
  }

  /** Resolves once everything queued so far (and anything queued while
   *  waiting) has gone out. */
  async drained(): Promise<void> {
    while (this.tail !== null) await this.tail;
  }

  private link(next: Promise<void>): void {
    this.tail = next;
    void next.then(() => { if (this.tail === next) this.tail = null; });
  }
}

function runSafely(frame: () => void): void {
  try {
    frame();
  } catch (err) {
    // A throwing frame must not wedge every frame behind it.
    log.error('stt outbox frame threw', { error: err instanceof Error ? err.message : String(err) });
  }
}
