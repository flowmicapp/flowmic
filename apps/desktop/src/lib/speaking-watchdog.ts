// WP-R2-3 capsule LATCH watchdog (07 §3 `useSpeakingWatchdog`, frontend-ized).
// Pure + time-injected so it is unit-testable with no timers.
//
// The capsule "speaking" latch is closed by a REMOTE event: the normal path is
// audio:start → interim*/level* → final → inject:result closes it. But a dropped
// link or a lost terminal final can leave the latch WEDGED in "speaking" forever
// (07 §3: "SPEAKING never wedges"). The CLAUDE.md red line requires every remote-event-
// closed latch to carry a LOCAL watchdog: 6 s with NO stt:interim / stt:final /
// stt:level signal → force-clear the latch back to idle (morph reset) + a
// forensic point. It is a BACKSTOP only — the normal path still closes the latch
// via inject:result; this just prevents a wedge.
//
// audio:stop is deliberately NOT a heartbeat: after the user stops speaking we
// are waiting for the final/inject, and if that never arrives the 6 s silence
// from the LAST real signal is exactly what must trip the watchdog.

export const LATCH_WATCHDOG_MS = 6000;

export class SpeakingWatchdog {
  private armed = false;
  private lastSignal = 0;

  constructor(private readonly timeoutMs: number = LATCH_WATCHDOG_MS) {}

  /** audio:start → arm the latch; audio:start itself counts as the first signal. */
  start(now: number): void {
    this.armed = true;
    this.lastSignal = now;
  }

  /** A sustaining signal (stt:interim / stt:final / stt:level) — refresh the
   *  deadline while the latch is armed. A level heartbeat keeps the latch alive
   *  well past 6 s from start, exactly as long as audio keeps flowing. */
  signal(now: number): void {
    if (this.armed) this.lastSignal = now;
  }

  /** The latch closed normally (inject:result resolved / morph left speaking) —
   *  disarm so a late tick never force-clears an already-settled utterance. */
  stop(): void {
    this.armed = false;
  }

  /** Poll at `now`: returns true (and DISARMS) exactly when the latch has been
   *  starved of signals for `timeoutMs`. Idempotent — a second poll returns
   *  false until the latch is re-armed. */
  check(now: number): boolean {
    if (this.armed && now - this.lastSignal >= this.timeoutMs) {
      this.armed = false;
      return true;
    }
    return false;
  }

  isArmed(): boolean {
    return this.armed;
  }
}
