// NR-137 round 7 (final review D2) — LEGACY CONVERSION NEVER HIDES AN
// UNREADABLE ROW.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a, the NR-137 correction (2026-10-02)
//   lib/src/timeline/timeline_verified_reads.dart (the three-state reads)
//
// Final review of `c1dc426e` (`_dispatch/2026-10-02-nr137-r6-review.md.out`,
// BLOCKING D2): the SharedPrefs fallback read its legacy array only until the
// conversion marker was set; conversion copies the READABLE entries and leaves
// the array as it is, so an undecodable entry was then in no inventory at all.
// Measured there: holes 1 → 0, `provenGone` true, press `done`, PCM released.
// Both of the reviewer's variants run here on the real chain (`Rc3Rig` →
// `PendingRecoveryStore.retryNow`) over the shipped fallback persistence.
//
// REVERSE CONTROL (2026-10-02): this file run on `c1dc426e` — both press
// cases red on `Expected: failed, Actual: done`, the report case red on
// `complete`; see the round-7 report.

import 'dart:convert';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/session/kept_words_retranscribe.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/pending_recovery_store.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'support/rc3_rig.dart';

const String _legacyKey = 'flowmic.timeline.entries.v1';
const String _convertedKey = 'flowmic.timeline.legacy_converted.v1';

const String _a = 'First half of the meeting notes.';
const String _b = 'Second half of the meeting notes.';
const String _again = 'Whole recording transcribed again';

Future<SharedPreferences> _prefs() async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  return SharedPreferences.getInstance();
}

PendingRecoveryStore _pending(Rc3Rig r) => PendingRecoveryStore(
    runner: r.controller.backfill, sourceLang: () => 'zh');

/// A four-second article kept `settled_unverified` with two paragraphs on
/// the fallback; a recovery answers the whole recording with [_again].
Future<Rc3Rig> _article(SharedPrefsTimelinePersistence p) async {
  final Rc3Rig r = await Rc3Rig.open(persistence: p);
  addTearDown(r.dispose);
  r.relay.onStop = (Rc3Stop stop) {
    final bool recovery = stop.recovery;
    Future<void>.delayed(
        const Duration(milliseconds: 20),
        () => r.relay.pushIncoming(
            FlowMicEvents.sttFinal,
            recovery
                ? r.relay.terminal(stop, text: _again, durationMs: 4000)
                : r.relay.terminal(stop,
                    text: '', durationMs: 0, segmentIdx: 2,
                    endedNormally: false)));
  };
  await r.begin();
  await r.feedMs(4000);
  await r.segment(_a, 0, 2000);
  await r.segment(_b, 1, 2000);
  await r.controller.pttUp();
  await r.untilAsync(() async =>
      (await r.manifest())?.recoveryState ==
      RecoveryQueueState.settledUnverified);
  for (final TimelineEntry row in r.rows) {
    await r.timeline.awaitPersisted(row.id);
  }
  return r;
}

Future<PendingRetryOutcome> _press(Rc3Rig r) async {
  final PendingRecoveryStore s = _pending(r);
  final PendingRetryOutcome out = await s.retryNow((await s.list()).single);
  await r.recoveries(1);
  return out;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(sqfliteFfiInit);

  group('legacy conversion (SharedPrefs fallback)', () {
    test('control: an ordinary press on the fallback replaces and releases',
        () async {
      final SharedPrefsTimelinePersistence p =
          SharedPrefsTimelinePersistence(await _prefs(),
              sqliteFile: SqliteFileEvidence.absent);
      final Rc3Rig r = await _article(p);
      expect(await _press(r), PendingRetryOutcome.done);
      expect(r.pcmPresent, isFalse);
    });

    test('an undecodable legacy member stays unproven after conversion',
        () async {
      final SharedPreferences prefs = await _prefs();
      final SharedPrefsTimelinePersistence p =
          SharedPrefsTimelinePersistence(prefs,
              sqliteFile: SqliteFileEvidence.absent);
      final Rc3Rig r = await _article(p);
      final TimelineEntry old = r.rows.first;
      await p.delete(old.id);
      final Map<String, Object?> bad = Map<String, Object?>.from(old.toJson())
        ..['duration_ms'] = 'undecodable-duration';
      expect(decodeTimelineRow(bad), isNull, reason: 'decoder control');
      final String blob = jsonEncode(<Object?>[bad]);
      await prefs.setString(_legacyKey, blob);
      expect((await p.loadInventory()).mayOmitMemberOf(r.articleId!), isTrue);
      expect(await provenGone(r.timeline, old.id), isFalse);

      final PendingRetryOutcome out = await _press(r);

      expect(prefs.getBool(_convertedKey), isTrue,
          reason: 'control: the press ran the conversion');
      expect(prefs.getString(_legacyKey), blob,
          reason: 'control: the undecodable entry is still stored');
      expect(out, PendingRetryOutcome.failed,
          reason: 'a conversion marker cannot prove an unreadable member gone');
      expect(r.pcmPresent, isTrue);
      expect((await p.loadInventory()).unreadable, hasLength(1),
          reason: 'conversion must not drop the hole');
      expect(await provenGone(r.timeline, old.id), isFalse);
    });

    test('a wholly unparseable legacy array stays a hole after conversion',
        () async {
      final SharedPreferences prefs = await _prefs();
      final SharedPrefsTimelinePersistence p =
          SharedPrefsTimelinePersistence(prefs,
              sqliteFile: SqliteFileEvidence.absent);
      final Rc3Rig r = await _article(p);
      const String blob = '{unparseable-array';
      await prefs.setString(_legacyKey, blob);
      expect((await p.loadInventory()).mayOmitMemberOf(r.articleId!), isTrue);

      final PendingRetryOutcome out = await _press(r);

      expect(prefs.getBool(_convertedKey), isTrue, reason: 'control');
      expect(prefs.getString(_legacyKey), blob, reason: 'control');
      expect(out, PendingRetryOutcome.failed);
      expect(r.pcmPresent, isTrue);
      expect((await p.loadInventory()).complete, isFalse);
    });

    test('the user-visible unreadable report is unchanged after conversion',
        () async {
      final SharedPreferences prefs = await _prefs();
      final SharedPrefsTimelinePersistence p =
          SharedPrefsTimelinePersistence(prefs,
              sqliteFile: SqliteFileEvidence.absent);
      await prefs.setString(_legacyKey, '{unparseable-array');
      await prefs.setBool(_convertedKey, true);
      final List<TimelineEntry> shown = await p.loadAll();
      expect(shown, isEmpty);
      expect(p.unreadableRows, 0,
          reason: 'a converted array was never reported; it still is not');
      expect((await p.loadInventory()).complete, isFalse);
    });
  });
}
