// IT-08 — RegisterRateLimiter IP-table bound (DiagUploadThrottle shape).
//
// Three things must stay true together:
//   1. ordinary per-IP limiting still fires (positive control — a broken bound
//      that silently disables the limiter would otherwise look like a pass);
//   2. REGISTER_IP_MAX_KEYS is enforced via oldest-first eviction;
//   3. a swept / evicted key comes back with a fresh budget.
// Reverse control for (2) is exercised manually in the IT-08 report: disable
// the eviction branch, watch this file go red, restore, watch it go green.

import { describe, expect, it } from 'vitest';
import {
  RegisterRateLimiter,
  REGISTER_MAX_ATTEMPTS,
  REGISTER_WINDOW_MS,
  REGISTER_IP_MAX_KEYS,
} from '../src/auth/register-rate-limit';

describe('RegisterRateLimiter (unit, injected clock)', () => {
  it('POSITIVE CONTROL: ordinary per-IP window still refuses after REGISTER_MAX_ATTEMPTS', () => {
    let t = 1_000;
    const lim = new RegisterRateLimiter({ now: () => t });
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) {
      expect(lim.check('1.2.3.4').allowed).toBe(true);
      lim.record('1.2.3.4');
      t += 10;
    }
    const denied = lim.check('1.2.3.4');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    // A different IP is unaffected — the limiter is still keyed per IP.
    expect(lim.check('9.9.9.9').allowed).toBe(true);
  });

  it('enforces the IP key cap via oldest-first eviction (REGISTER_IP_MAX_KEYS shape)', () => {
    // Small maxKeys so the test names the mechanism, not the default 512.
    const maxKeys = 4;
    const lim = new RegisterRateLimiter({
      now: () => 1_000,
      maxKeys,
      maxAttempts: 2,
    });
    lim.record('victim');
    lim.record('victim');
    expect(lim.check('victim').allowed).toBe(false);

    // Fill the table: victim + (maxKeys-1) others = full. Victim stays blocked.
    for (let i = 0; i < maxKeys - 1; i++) lim.record(`flood-${i}`);
    expect(lim.check('victim').allowed).toBe(false);

    // One more NEW key forces eviction of the oldest (victim). Fresh budget.
    lim.record(`flood-${maxKeys - 1}`);
    expect(lim.check('victim').allowed).toBe(true);
    // Production default is the same constant DiagUploadThrottle uses as its ceiling shape.
    expect(REGISTER_IP_MAX_KEYS).toBe(512);
  });

  it('a swept expired key behaves as a fresh IP (not a lingering denial)', () => {
    let t = 0;
    const lim = new RegisterRateLimiter({ now: () => t, maxAttempts: 2 });
    lim.record('stale');
    lim.record('stale');
    expect(lim.check('stale').allowed).toBe(false);
    t += REGISTER_WINDOW_MS + 1;
    expect(lim.check('stale').allowed).toBe(true);
    lim.record('stale');
    expect(lim.check('stale').allowed).toBe(true);
  });

  it('sweep clears a full table of stale keys so a live IP is not evicted by ghosts', () => {
    let t = 0;
    const maxKeys = 4;
    const lim = new RegisterRateLimiter({ now: () => t, maxKeys, maxAttempts: 2 });
    for (let i = 0; i < maxKeys; i++) lim.record(`stale-${i}`);
    lim.record('live');
    lim.record('live');
    // live was inserted after a full stale table ⇒ without sweep, recording
    // 'live' would have evicted one stale and 'live' would sit in a full map.
    // Advance past the window: sweep must drop every stale key.
    t += REGISTER_WINDOW_MS + 1;
    // Re-arm live inside the new window (prior stamps swept).
    lim.record('live');
    lim.record('live');
    expect(lim.check('live').allowed).toBe(false);
    // Insert maxKeys-1 other live IPs. If stale ghosts remained, these inserts
    // would eventually evict 'live'. With sweep, 'live' stays rate-limited.
    for (let i = 0; i < maxKeys - 1; i++) lim.record(`other-${i}`);
    expect(lim.check('live').allowed).toBe(false);
    expect(lim.check('stale-0').allowed).toBe(true);
  });
});
