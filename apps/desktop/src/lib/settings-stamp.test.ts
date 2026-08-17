// Card C3 — the clock-skew correction that keeps a lagging machine from silently
// losing settings arbitrations it should win.
//
// The unit under test authors nothing by itself; what it guarantees is a
// PROPERTY of the stamps that get authored, so every assertion here is stated
// against the server's own rule rather than against a number:
//   · refusal  = stored stamp STRICTLY newer than the incoming one — the
//                `existingMs > incomingMs` guard in
//                apps/server-core/src/socket/handlers/settings.handler.ts;
//   · re-stamp = incoming stamp more than `SETTINGS_STAMP_MAX_SKEW_MS` (5 min)
//                ahead of server time — same file, the `storedAt` assignment.
// `serverRefuses` below is a MIRROR of the first rule, not a second definition
// of it — it exists so these cases read as "the server would refuse this"
// instead of as string comparisons. Its authority is the citation; the wire-level
// proof lives in the server's own suite, which this fence does not reach.
//
// ── REVERSE CONTROL (executed 2026-08-17) ────────────────────────────────────
// Break: make `SettingsStampClock.observe` stop updating `aheadMs`, i.e. author
// every stamp straight off the local clock.
// OBSERVED, over this file + settings-client.test.ts: `Tests 3 failed | 13
// passed (16)`, and the three reds are exactly the three cases that assert a
// corrected stamp:
//   · ACCEPTANCE (a) here — 'expected 1786964700000 to be greater than 1786968000000'
//   · 'keeps the LARGEST observation, not the latest one' here
//   · ACCEPTANCE (a, desktop half) in settings-client.test.ts
// CONTROL-ON-CONTROL: 'never rewinds a clock that is AHEAD', 'an unparseable or
// absent stamp is NOT evidence' and the clamp-boundary case stayed GREEN, and so
// did every edit-moment case in settings-client.test.ts — so the break is
// specific to the correction rather than to stamping in general. Had the whole
// file gone red, this control would have proved only that the module is
// imported.

import { describe, expect, it } from 'vitest';
import { SettingsStampClock, stampMs } from './settings-stamp';

/** The five-minute clamp — `SETTINGS_STAMP_MAX_SKEW_MS` in settings.handler.ts —
 *  mirrored for the boundary case below. Duplicated deliberately rather than imported: @flowmic/server-core
 *  is not a dependency of the desktop app, and a test that could only run inside
 *  the server package would not be run by anyone editing this file. */
const SERVER_CLAMP_MS = 5 * 60_000;

/** Mirror of the server's regress guard (`existingMs > incomingMs` in
 *  settings.handler.ts). */
function serverRefuses(storedIso: string | undefined, incomingIso: string | undefined): boolean {
  const stored = stampMs(storedIso);
  const incoming = stampMs(incomingIso);
  return stored !== null && incoming !== null && stored > incoming;
}

const HOUR = 3_600_000;

describe('SettingsStampClock — a lagging clock stops losing edits it should win', () => {
  it('ACCEPTANCE (a, desktop half): a machine ONE HOUR BEHIND still wins with a '
    + 'genuinely newer edit', () => {
    // The phone (correct clock) edited the card at 12:00. This machine's clock
    // reads 11:00 when it is really 12:00.
    const server = Date.parse('2026-08-17T12:00:00.000Z');
    let local = server - HOUR;
    const clock = new SettingsStampClock(() => local);

    // Uncorrected, this is the defect: an edit made five minutes AFTER the
    // phone's is stamped 11:05, the server refuses it, hands back the stored
    // card, and the user's terms revert with nothing said.
    local = server - HOUR + 5 * 60_000;
    const naive = clock.nowIso();
    expect(serverRefuses('2026-08-17T12:00:00.000Z', naive)).toBe(true);

    // Rewind to the admission edge: the snapshot pull carries the phone's stamp,
    // which is all the evidence this needs.
    local = server - HOUR;
    clock.observe('2026-08-17T12:00:00.000Z');
    expect(clock.correctionMs).toBe(HOUR);

    // Now the same edit, five minutes later by this machine's own reckoning.
    local = server - HOUR + 5 * 60_000;
    const corrected = clock.nowIso();

    expect(serverRefuses('2026-08-17T12:00:00.000Z', corrected)).toBe(false);
    expect(Date.parse(corrected)).toBeGreaterThan(server);
    expect(corrected).toBe('2026-08-17T12:05:00.000Z'); // i.e. when it really happened
  });

  it('a corrected stamp stays inside the server\'s +5min clamp, so it is stored '
    + 'as sent rather than re-stamped', () => {
    // The worst legitimate observation: a peer whose clock sits exactly at the
    // clamp boundary, so the row we read is 5 minutes ahead of true time.
    const serverNow = Date.parse('2026-08-17T12:00:00.000Z');
    let local = serverNow; // our own clock is correct here — the skew is the PEER's
    const clock = new SettingsStampClock(() => local);
    clock.observe(new Date(serverNow + SERVER_CLAMP_MS).toISOString());

    // Ten minutes later the user edits. Both clocks advanced by the same ten
    // minutes, so the clamp bound moved with us.
    local = serverNow + 10 * 60_000;
    const minted = Date.parse(clock.nowIso());
    const clampBound = serverNow + 10 * 60_000 + SERVER_CLAMP_MS;

    expect(minted).toBeLessThanOrEqual(clampBound); // the server's clamp compares with <=
  });

  it('never rewinds a clock that is AHEAD — the correction is floored at zero', () => {
    // Observing an older row must not drag our stamps backwards: a machine whose
    // clock leads is already winning the arbitrations it should, and pulling it
    // back would invent a second way to lose while fixing the first.
    const clock = new SettingsStampClock(() => Date.parse('2026-08-17T12:00:00.000Z'));
    clock.observe('2020-01-01T00:00:00.000Z');
    expect(clock.correctionMs).toBe(0);
    expect(clock.nowIso()).toBe('2026-08-17T12:00:00.000Z');
  });

  it('an unparseable or absent stamp is NOT evidence', () => {
    // `Iso8601` is `z.string().min(1)` — a name, not a validator — so junk really
    // does arrive. Read as epoch it would teach a correction of minus fifty-six
    // years; ranked lexically, 'yesterday' would teach an unbounded one.
    const clock = new SettingsStampClock(() => Date.parse('2026-08-17T12:00:00.000Z'));
    clock.observe('yesterday');
    clock.observe('');
    clock.observe(undefined);
    clock.observe(null);
    expect(clock.correctionMs).toBe(0);
    expect(stampMs('yesterday')).toBeNull();
    expect(stampMs(undefined)).toBeNull();
  });

  it('keeps the LARGEST observation, not the latest one', () => {
    // A snapshot carries many rows and most of them are old. Taking the newest
    // ARRIVING stamp rather than the largest one would let a stale row erase a
    // correction that a fresh row had just established.
    const local = Date.parse('2026-08-17T12:00:00.000Z');
    const clock = new SettingsStampClock(() => local);
    clock.observe('2026-08-17T13:00:00.000Z'); // an hour ahead of us
    clock.observe('2026-08-17T09:00:00.000Z'); // an old row, arriving afterwards
    expect(clock.correctionMs).toBe(HOUR);
  });

  it('mints ISO-8601 UTC, the same shape the phone mints', () => {
    // Both sides feed one comparison. The phone uses
    // DateTime.now().toUtc().toIso8601String(); a stamp shaped differently would
    // still parse, but the two would stop being readable as the same fact in a
    // log.
    const clock = new SettingsStampClock(() => Date.parse('2026-08-17T12:34:56.789Z'));
    expect(clock.nowIso()).toBe('2026-08-17T12:34:56.789Z');
  });
});
