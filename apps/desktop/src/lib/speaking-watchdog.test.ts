import { describe, expect, it } from 'vitest';
import { LATCH_WATCHDOG_MS, SpeakingWatchdog } from './speaking-watchdog';

describe('SpeakingWatchdog — capsule latch backstop (07 §3, WP-R2-3)', () => {
  it('a normal final→inject closure never trips the watchdog', () => {
    const w = new SpeakingWatchdog();
    w.start(0);
    w.signal(200); // interim
    w.signal(900); // final arrives well within the window
    // inject:result resolves → latch closes normally.
    w.stop();
    // Even long after, a poll must not fire (it was disarmed by the normal close).
    expect(w.check(0 + LATCH_WATCHDOG_MS + 5000)).toBe(false);
    expect(w.isArmed()).toBe(false);
  });

  it('signal starvation for 6 s force-clears the latch (once)', () => {
    const w = new SpeakingWatchdog();
    w.start(0);
    w.signal(500); // last real signal at t=500
    // Just before 6 s from the last signal — still armed.
    expect(w.check(500 + LATCH_WATCHDOG_MS - 1)).toBe(false);
    expect(w.isArmed()).toBe(true);
    // At exactly 6 s of silence — fires and disarms.
    expect(w.check(500 + LATCH_WATCHDOG_MS)).toBe(true);
    expect(w.isArmed()).toBe(false);
    // A second poll does not re-fire.
    expect(w.check(500 + LATCH_WATCHDOG_MS + 10000)).toBe(false);
  });

  it('a level heartbeat sustains the latch past 6 s from start', () => {
    const w = new SpeakingWatchdog();
    w.start(0);
    // stt:level ticks every 2 s keep refreshing the deadline.
    for (let t = 2000; t <= 20000; t += 2000) {
      w.signal(t);
      expect(w.check(t + 1)).toBe(false); // never starved while level flows
      expect(w.isArmed()).toBe(true);
    }
    // Then the signals stop; 6 s after the LAST level (t=20000) it finally trips.
    expect(w.check(20000 + LATCH_WATCHDOG_MS - 1)).toBe(false);
    expect(w.check(20000 + LATCH_WATCHDOG_MS)).toBe(true);
  });

  it('signals after a normal stop() do not re-arm the latch', () => {
    const w = new SpeakingWatchdog();
    w.start(0);
    w.stop();
    w.signal(100); // a trailing late event
    expect(w.isArmed()).toBe(false);
    expect(w.check(100 + LATCH_WATCHDOG_MS)).toBe(false);
  });
});
