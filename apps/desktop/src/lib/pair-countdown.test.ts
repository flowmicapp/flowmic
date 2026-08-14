// GA-18 — the pairing-code countdown + expiry auto-refresh.
//
// Before this, the modal showed a static 「配对码 5 分钟内有效」 ("pairing code valid
// for 5 minutes") and kept showing a dead code until someone pressed 刷新
// ("refresh") — the phone then got PAIR_INVALID_CODE while the screen still said
// 有效 ("valid"). The countdown closes that, and the two ways to get it wrong are
// pinned here: freezing it (storing the duration instead of a deadline) and
// inventing it (counting down when the server sent no TTL).

import { describe, it, expect } from 'vitest';
import {
  deadlineFrom,
  deriveCountdown,
  formatCountdown,
  remainingMs,
  shouldAutoRefresh,
  shouldMintAbsent,
} from './pair-countdown';

const T0 = 1_700_000_000_000;

describe('deadlineFrom — a duration becomes an absolute deadline once', () => {
  it('anchors the server duration to the moment it was read', () => {
    expect(deadlineFrom(300_000, T0)).toBe(T0 + 300_000);
    // Read 10 s later, the SAME remaining value must land 10 s further out —
    // that is what keeps the countdown moving with the real code.
    expect(deadlineFrom(300_000, T0 + 10_000)).toBe(T0 + 310_000);
  });

  it('returns null when the server sent no TTL (never a fabricated 5 min)', () => {
    expect(deadlineFrom(undefined, T0)).toBeNull();
    expect(deadlineFrom(null, T0)).toBeNull();
    expect(deadlineFrom(Number.NaN, T0)).toBeNull();
  });

  it('keeps an already-expired code as a real deadline, not a missing one', () => {
    expect(deadlineFrom(0, T0)).toBe(T0);
    expect(deriveCountdown(deadlineFrom(0, T0), T0).expired).toBe(true);
  });
});

describe('remainingMs / formatCountdown', () => {
  it('tracks the clock and floors at zero', () => {
    const d = T0 + 300_000;
    expect(remainingMs(d, T0)).toBe(300_000);
    expect(remainingMs(d, T0 + 299_000)).toBe(1_000);
    expect(remainingMs(d, T0 + 400_000)).toBe(0); // never negative
    expect(remainingMs(null, T0)).toBeNull();
  });

  it('formats M:SS, rounding UP so the last shown second is real', () => {
    expect(formatCountdown(300_000)).toBe('5:00');
    expect(formatCountdown(299_001)).toBe('5:00');
    expect(formatCountdown(61_000)).toBe('1:01');
    expect(formatCountdown(7_400)).toBe('0:08');
    expect(formatCountdown(1)).toBe('0:01');
    expect(formatCountdown(0)).toBe('0:00');
  });
});

describe('deriveCountdown — the label the modal renders', () => {
  it('follows the true remaining time', () => {
    const d = deadlineFrom(300_000, T0);
    expect(deriveCountdown(d, T0)).toEqual({ label: '5:00', expired: false });
    expect(deriveCountdown(d, T0 + 240_000)).toEqual({ label: '1:00', expired: false });
    expect(deriveCountdown(d, T0 + 300_000)).toEqual({ label: '0:00', expired: true });
  });

  it('an unknown expiry is NOT an expiry (no label, not expired)', () => {
    // Reporting「expired」here would fire an endless refresh against a server
    // that simply never sends the field.
    expect(deriveCountdown(null, T0)).toEqual({ label: null, expired: false });
  });
});

describe('shouldAutoRefresh — when the tick mints a new code', () => {
  const base = { open: true, deadline: T0 + 300_000, now: T0, refreshing: false, failed: false };

  it('fires exactly at zero, not before', () => {
    expect(shouldAutoRefresh({ ...base, now: T0 + 299_999 })).toBe(false);
    expect(shouldAutoRefresh({ ...base, now: T0 + 300_000 })).toBe(true);
    expect(shouldAutoRefresh({ ...base, now: T0 + 999_999 })).toBe(true);
  });

  it('never fires with the modal closed (关弹层停轮询)', () => {
    expect(shouldAutoRefresh({ ...base, open: false, now: T0 + 300_000 })).toBe(false);
  });

  it('respects the in-flight guard and stops after a loud failure', () => {
    const expired = { ...base, now: T0 + 300_000 };
    expect(shouldAutoRefresh({ ...expired, refreshing: true })).toBe(false);
    // Without this a down socket would retry every second and bury the notice.
    expect(shouldAutoRefresh({ ...expired, failed: true })).toBe(false);
  });

  it('never fires when the server gave no deadline', () => {
    expect(shouldAutoRefresh({ ...base, deadline: null, now: T0 + 999_999 })).toBe(false);
  });
});

// REQ-13-21 (owner 2026-08-13) — mint on ARRIVAL at a code-less channel. GA-18's
// expiry refresh keys off a deadline; an absent code has none, so switching to a
// channel with no live code used to strand the user on 「尚无有效配对码」("no valid
// pairing code yet") until a
// manual click. Reverse control seen red (2026-08-13, this machine): flipping the
// reason check to `'ok'` turns the first case false and the 'ok' row true —
// `expected false to be true` / `expected true to be false` — i.e. it would mint
// exactly when a perfectly good code is already on screen.
describe('shouldMintAbsent — one shot at a settled, code-less, refreshable channel', () => {
  const armed = {
    open: true,
    reason: 'no-code',
    canRefresh: true,
    refreshing: false,
    failed: false,
    alreadyTried: false,
  };

  it('fires exactly on the armed state', () => {
    expect(shouldMintAbsent(armed)).toBe(true);
  });

  it('every other reason declines — pending is another channel, ok/loopback HAVE a code, disconnected has no server', () => {
    for (const reason of ['ok', 'pending', 'disconnected', 'loopback']) {
      expect(shouldMintAbsent({ ...armed, reason }), reason).toBe(false);
    }
  });

  it('each guard alone vetoes: closed modal / blocked-or-pending tab / in-flight / failed / already tried', () => {
    expect(shouldMintAbsent({ ...armed, open: false })).toBe(false);
    expect(shouldMintAbsent({ ...armed, canRefresh: false })).toBe(false);
    expect(shouldMintAbsent({ ...armed, refreshing: true })).toBe(false);
    // The poison pill: a down socket gets ONE loud failure, not a mint per second.
    expect(shouldMintAbsent({ ...armed, failed: true })).toBe(false);
    // The latch: a server that mints-but-returns-no-code is not hammered either.
    expect(shouldMintAbsent({ ...armed, alreadyTried: true })).toBe(false);
  });
});
