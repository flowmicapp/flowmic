// Card C3 — the clock-skew correction that keeps a lagging phone from silently
// losing settings arbitrations it should win.
//
// The unit under test authors nothing on its own; what it guarantees is a
// PROPERTY of the stamps that do get authored, so every case here is stated
// against the server's own rules rather than against a bare number:
//   · refusal  = stored stamp STRICTLY newer than the incoming one — the
//                `existingMs > incomingMs` guard in
//                apps/server-core/src/socket/handlers/settings.handler.ts;
//   · re-stamp = incoming stamp more than five minutes ahead of server time —
//                same file, `SETTINGS_STAMP_MAX_SKEW_MS`.
// [_serverRefuses] is a MIRROR of the first rule, not a second definition of it:
// it exists so a case can read「the server would refuse this」rather than as a
// comparison of two strings. Its authority is the citation. The wire-level proof
// belongs to the server's own suite, which this fence does not reach.
//
// ── REVERSE CONTROL 1 (executed 2026-08-17) ──────────────────────────────────
// Break: `SettingsStampClock.observe` stops updating `_ahead`, i.e. every stamp
// is authored straight off the device clock.
// OBSERVED over this file + scenario_card_controller_test + settings_client_test:
// `+29 -3`, and the three reds are exactly the three cases that assert a
// correction:
//   · ACCEPTANCE (a) here — `Expected: Duration:<1:00:00.000000> /
//     Actual: Duration:<0:00:00.000000>`
//   · 'keeps the LARGEST observation, not the latest one' here
//   · ACCEPTANCE (a) in scenario_card_controller_test.dart
// CONTROL-ON-CONTROL: 'never rewinds a clock that is AHEAD', 'an unparseable or
// absent stamp is NOT evidence', the clamp-boundary case and the six existing
// arbitration cases in scenario_card_controller_test.dart all stayed GREEN — so
// the break is specific to the correction, not to stamping in general. Had the
// whole file gone red it would have proved only that the class is imported.
//
// ── REVERSE CONTROL 2, THE ONE THAT MATTERS MORE ─────────────────────────────
// Break: delete `_clock.observe(stamp)` from `SettingsClient._publish` — the
// class is left perfect and simply never fed.
// OBSERVED: `+31 -1`. EVERY case in THIS file stayed green, and the single red
// is the wired case in scenario_card_controller_test.dart. That is the point:
// this file cannot tell a working correction from an unwired one, which is why
// the acceptance case lives over there, driving the real client.

import 'package:flowmic/src/settings/settings_stamp_clock.dart';
import 'package:flutter_test/flutter_test.dart';

/// Mirror of the server's regress guard (`existingMs > incomingMs` in
/// settings.handler.ts). Unknown on
/// either side means "cannot be compared", which routes to "write it" — never to
/// a refusal.
bool _serverRefuses(String? storedIso, String? incomingIso) {
  final DateTime? stored = storedIso == null ? null : DateTime.tryParse(storedIso);
  final DateTime? incoming = incomingIso == null ? null : DateTime.tryParse(incomingIso);
  if (stored == null || incoming == null) return false;
  return stored.isAfter(incoming);
}

/// The clamp `SETTINGS_STAMP_MAX_SKEW_MS`. Mirrored rather than imported: the
/// phone cannot import TypeScript, which is the same reason its error-copy table
/// is hand-mirrored.
const Duration _serverClamp = Duration(minutes: 5);

void main() {
  test('ACCEPTANCE (a): a phone ONE HOUR BEHIND still wins with a genuinely '
      'newer edit', () {
    // The desktop (correct clock) edited the card at 12:00. This phone's clock
    // reads 11:00 when it is really 12:00.
    final DateTime trueNoon = DateTime.utc(2026, 8, 17, 12);
    DateTime local = trueNoon.subtract(const Duration(hours: 1));
    final SettingsStampClock clock = SettingsStampClock(now: () => local);

    // Uncorrected, this is the defect: the edit the user makes five minutes
    // AFTER the desktop's is stamped 11:05, the server refuses it, hands back
    // the stored card, and the user's custom terms revert with nothing said.
    local = trueNoon.subtract(const Duration(minutes: 55));
    expect(_serverRefuses('2026-08-17T12:00:00.000Z', clock.nowIso()), isTrue);

    // Rewind to the room-join edge: the settings:list snapshot carries the
    // desktop's stamp, which is all the evidence this needs.
    local = trueNoon.subtract(const Duration(hours: 1));
    clock.observe('2026-08-17T12:00:00.000Z');
    expect(clock.correction, const Duration(hours: 1));

    // The same edit, five minutes later by this phone's own reckoning.
    local = trueNoon.subtract(const Duration(minutes: 55));
    final String corrected = clock.nowIso();
    expect(_serverRefuses('2026-08-17T12:00:00.000Z', corrected), isFalse);
    expect(corrected, '2026-08-17T12:05:00.000Z'); // i.e. when it really happened
  });

  test('a corrected stamp stays inside the server +5min clamp, so it is stored '
      'as sent rather than re-stamped', () {
    // The worst legitimate observation: a peer sitting exactly at the clamp
    // boundary, so the row we read is five minutes ahead of true time. Our own
    // clock is correct here — the skew being absorbed is somebody else's.
    final DateTime serverNow = DateTime.utc(2026, 8, 17, 12);
    DateTime local = serverNow;
    final SettingsStampClock clock = SettingsStampClock(now: () => local);
    clock.observe(serverNow.add(_serverClamp).toIso8601String());

    // Ten minutes later the user edits. Both clocks advanced by the same ten
    // minutes, so the clamp bound moved with us.
    local = serverNow.add(const Duration(minutes: 10));
    final DateTime minted = DateTime.parse(clock.nowIso());
    final DateTime bound = serverNow.add(const Duration(minutes: 10)).add(_serverClamp);
    expect(minted.isAfter(bound), isFalse); // the server's clamp compares with <=
  });

  test('never rewinds a clock that is AHEAD — the correction is floored at zero',
      () {
    // A device whose clock leads already wins the arbitrations it should. Pulling
    // it back on the strength of an old row would invent a second way to lose
    // while fixing the first.
    final DateTime local = DateTime.utc(2026, 8, 17, 12);
    final SettingsStampClock clock = SettingsStampClock(now: () => local);
    clock.observe('2020-01-01T00:00:00.000Z');
    expect(clock.correction, Duration.zero);
    expect(clock.nowIso(), '2026-08-17T12:00:00.000Z');
  });

  test('an unparseable or absent stamp is NOT evidence', () {
    // `Iso8601` on the wire is `z.string().min(1)` — a name, not a validator —
    // so junk really does arrive. Read as epoch it would teach a correction of
    // minus fifty-six years; ranked lexically, 'yesterday' sorts above '2026-…'
    // and would teach an unbounded one.
    final DateTime local = DateTime.utc(2026, 8, 17, 12);
    final SettingsStampClock clock = SettingsStampClock(now: () => local);
    clock.observe('yesterday');
    clock.observe('');
    clock.observe(null);
    expect(clock.correction, Duration.zero);
  });

  test('keeps the LARGEST observation, not the latest one', () {
    // A snapshot carries many rows and most of them are old. Taking the newest
    // ARRIVING stamp rather than the largest would let a stale row erase a
    // correction a fresh row had just established.
    final DateTime local = DateTime.utc(2026, 8, 17, 12);
    final SettingsStampClock clock = SettingsStampClock(now: () => local);
    clock.observe('2026-08-17T13:00:00.000Z');
    clock.observe('2026-08-17T09:00:00.000Z');
    expect(clock.correction, const Duration(hours: 1));
  });

  test('mints ISO-8601 UTC even when the device is on a local timezone clock',
      () {
    // Both ends feed ONE comparison; a stamp carrying a local offset would still
    // parse, but the two sides would stop being readable as the same fact in a
    // log — and this is a phone, which is the device that actually changes zone.
    final DateTime local = DateTime.utc(2026, 8, 17, 12, 34, 56, 789).toLocal();
    final SettingsStampClock clock = SettingsStampClock(now: () => local);
    expect(clock.nowIso(), '2026-08-17T12:34:56.789Z');
  });
}
