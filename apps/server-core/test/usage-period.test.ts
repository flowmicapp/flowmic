// The metering cycle: which bucket a minute belongs to (owner 2026-09-05, option 乙).
//
// SPEC-REF: src/billing/usage-period.ts
//
// What is pinned, in order of what it would cost to get wrong:
//   ① the anchor moves at exactly the three moments the ruling names —
//      registration, a subscription starting, a subscription ending — and at
//      no other (a FUTURE period end must not restart anybody's cycle early);
//   ② the two defects that motivated the ruling cannot come back: a downgrade
//      starts a fresh bucket, and a mid-month subscription does not get a
//      second allowance on the 1st;
//   ③ anniversaries on the 29th–31st clamp per month and do not drift.

import { describe, expect, it } from 'vitest';
import { anniversary, effectiveAnchorMs, isCycleKey, parseUtcStamp, usagePeriodAt, utcDate } from '../src/billing/usage-period';

const D = (iso: string): number => Date.parse(iso);

describe('usagePeriodAt — the cycle containing an instant', () => {
  it('registered on the 4th ⇒ cycles run 4th → 4th, and the key is the cycle start', () => {
    const anchor = D('2026-09-04T13:37:00.000Z');
    expect(usagePeriodAt(anchor, D('2026-09-04T14:00:00.000Z'))).toMatchObject({ key: '2026-09-04', start: '2026-09-04', end: '2026-10-04' });
    expect(usagePeriodAt(anchor, D('2026-10-03T23:59:59.999Z')).key).toBe('2026-09-04');
    // 🔴 The owner's example verbatim: opened 2026-09-04 ⇒ resets 2026-10-04.
    expect(usagePeriodAt(anchor, D('2026-10-04T00:00:00.000Z')).key).toBe('2026-10-04');
    expect(usagePeriodAt(anchor, D('2027-03-10T00:00:00.000Z'))).toMatchObject({ key: '2027-03-04', end: '2027-04-04' });
  });

  it('the anchor day counts from UTC midnight, whatever the time of day it was created', () => {
    const late = D('2026-09-04T23:59:59.000Z');
    expect(usagePeriodAt(late, D('2026-09-04T00:00:00.000Z')).key).toBe('2026-09-04');
  });

  it('an instant before the anchor is clamped to the first cycle, never extrapolated backwards', () => {
    const anchor = D('2026-09-04T00:00:00.000Z');
    expect(usagePeriodAt(anchor, D('2026-08-01T00:00:00.000Z')).key).toBe('2026-09-04');
  });

  it('③ a 31st anchor clamps in short months and comes back to the 31st — no drift', () => {
    const anchor = D('2026-01-31T10:00:00.000Z');
    expect(usagePeriodAt(anchor, D('2026-02-15T00:00:00.000Z'))).toMatchObject({ key: '2026-01-31', end: '2026-02-28' });
    expect(usagePeriodAt(anchor, D('2026-02-28T00:00:00.000Z'))).toMatchObject({ key: '2026-02-28', end: '2026-03-31' });
    expect(usagePeriodAt(anchor, D('2026-03-31T12:00:00.000Z'))).toMatchObject({ key: '2026-03-31', end: '2026-04-30' });
    expect(usagePeriodAt(anchor, D('2026-05-01T00:00:00.000Z'))).toMatchObject({ key: '2026-04-30', end: '2026-05-31' });
    // Leap year: Feb 29.
    expect(anniversary(D('2027-12-31T00:00:00.000Z'), 2)).toBe(D('2028-02-29T00:00:00.000Z'));
  });

  it('a day boundary is a UTC day boundary — the same UTC day always maps to one key', () => {
    const anchor = D('2026-09-04T00:00:00.000Z');
    expect(usagePeriodAt(anchor, D('2026-10-04T00:00:00.000Z')).key).toBe(usagePeriodAt(anchor, D('2026-10-04T23:59:59.999Z')).key);
  });

  it('keys never collide with the legacy calendar-month keys', () => {
    expect(isCycleKey('2026-09-04')).toBe(true);
    expect(isCycleKey('2026-09')).toBe(false);
    expect(utcDate(D('2026-09-04T23:59:59.000Z'))).toBe('2026-09-04');
  });
});

describe('effectiveAnchorMs — the three moments, and only those', () => {
  const REG = D('2026-09-04T00:00:00.000Z');

  it('a fresh account is anchored to registration', () => {
    expect(effectiveAnchorMs(REG, [], D('2026-09-20T00:00:00.000Z'))).toBe(REG);
  });

  it('a live subscription moves the anchor to its start — the cycle follows the provider', () => {
    const start = D('2026-09-25T09:00:00.000Z');
    const at = D('2026-10-02T00:00:00.000Z');
    const anchor = effectiveAnchorMs(REG, [{ startedAtMs: start, endedAtMs: null, grants: true }], at);
    expect(anchor).toBe(start);
    // ② the defect that motivated this: no fresh allowance on the 1st.
    expect(usagePeriodAt(anchor, D('2026-09-28T00:00:00.000Z')).key).toBe('2026-09-25');
    expect(usagePeriodAt(anchor, at).key).toBe('2026-09-25');
    expect(usagePeriodAt(anchor, D('2026-10-25T00:00:00.000Z')).key).toBe('2026-10-25');
  });

  it('🔴 a subscription that has ENDED anchors the Free cycle that follows it to the day it ended', () => {
    const start = D('2026-09-20T00:00:00.000Z');
    const end = D('2026-10-20T00:00:00.000Z');
    const at = D('2026-10-22T00:00:00.000Z');
    const anchor = effectiveAnchorMs(REG, [{ startedAtMs: start, endedAtMs: end, grants: false }], at);
    expect(anchor).toBe(end);
    // ② the other motivating defect: the paid month's spend does not follow the
    // person into Free — the bucket is a new one.
    expect(usagePeriodAt(anchor, at)).toMatchObject({ key: '2026-10-20', end: '2026-11-20' });
  });

  it('🔴 a period end still in the FUTURE is not an anchor yet — a scheduled cancellation restarts nothing early', () => {
    const start = D('2026-09-20T00:00:00.000Z');
    const end = D('2026-10-20T00:00:00.000Z');
    const at = D('2026-10-10T00:00:00.000Z');
    // Still granting until the 20th: the anchor is the start, not the end.
    expect(effectiveAnchorMs(REG, [{ startedAtMs: start, endedAtMs: end, grants: true }], at)).toBe(start);
    // Even a row already marked non-granting cannot pull the anchor forward
    // past `now`.
    expect(effectiveAnchorMs(REG, [{ startedAtMs: start, endedAtMs: end, grants: false }], at)).toBe(start <= at ? REG : REG);
  });

  it('a re-subscription after an ended one takes the newer start', () => {
    const rows = [
      { startedAtMs: D('2026-06-01T00:00:00.000Z'), endedAtMs: D('2026-07-01T00:00:00.000Z'), grants: false },
      { startedAtMs: D('2026-09-10T00:00:00.000Z'), endedAtMs: null, grants: true },
    ];
    expect(effectiveAnchorMs(REG, rows, D('2026-09-15T00:00:00.000Z'))).toBe(D('2026-09-10T00:00:00.000Z'));
  });

  it('the anchor never precedes registration and never exceeds now', () => {
    const at = D('2026-09-30T00:00:00.000Z');
    expect(effectiveAnchorMs(REG, [{ startedAtMs: D('2020-01-01T00:00:00.000Z'), endedAtMs: null, grants: true }], at)).toBe(REG);
    expect(effectiveAnchorMs(REG, [{ startedAtMs: D('2026-12-01T00:00:00.000Z'), endedAtMs: null, grants: true }], at)).toBe(REG);
  });
});

describe("parseUtcStamp — the database's stamps are UTC, whatever the machine thinks", () => {
  it('🔴 a SQLite "YYYY-MM-DD HH:MM:SS" stamp is UTC, not local time', () => {
    // Measured 2026-09-05 on a UTC+8 machine: Date.parse read the space-separated
    // form as local time and the cycle key came out a day early. Production
    // (UTC) was right by coincidence.
    expect(parseUtcStamp('2026-09-05 01:54:12')).toBe(Date.UTC(2026, 8, 5, 1, 54, 12));
    expect(utcDate(parseUtcStamp('2026-09-05 01:54:12'))).toBe('2026-09-05');
  });
  it('an ISO stamp with a zone passes through unchanged', () => {
    expect(parseUtcStamp('2026-09-05T01:54:12.000Z')).toBe(Date.UTC(2026, 8, 5, 1, 54, 12));
    expect(parseUtcStamp('2026-09-05T09:54:12+08:00')).toBe(Date.UTC(2026, 8, 5, 1, 54, 12));
  });
});
