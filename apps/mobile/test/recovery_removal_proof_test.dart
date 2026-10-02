// NR-137 ROUND 5 — NO RETAINED AUDIO IS RELEASED UNTIL EVERY ROW REMOVAL IT
// DEPENDS ON IS PROVEN BY STORAGE (ordinary recovery and RC-3 shortfall retries).
//
// SPEC-REF:
//   apps/mobile/lib/src/session/recovery_leg_rows.dart (the header says what
//     changed and why)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a, the NR-137 round-5 correction
//
// The real chain (support/rc3_rig.dart): a long recording whose engine went
// away mid-way, so its tail is OWED and the recovery leg feeds it back. The
// timeline persistence is one the test controls, so a delete can be refused,
// a readback can fail, or one row's write can fail.
//
// REVERSE CONTROLS: see `_dispatch/2026-10-02-nr137-r5.report.md` and the
// commit that added this file.
//
// ⚠️ Plain `test`s over real timers, like the other Rc3Rig repro files.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/session/recovery_journal_leg.dart'
    show kWithdrawNotProvenPrefix;
import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

const String _a = 'The opening before the engine went away.';
const String _short = 'Eight words.';
const String _whole = 'The whole tail, transcribed again.';

/// A persistence the test steers: refuse deletes, fail a keyed readback of
/// a row whose delete was "accepted", or fail the write of one text.
class _Steered extends InMemoryTimelinePersistence
    implements TimelineKeyedPersistence {
  bool refuseDeletes = false;
  bool readbackFailsAfterDelete = false;
  String? refuseWriteOf;
  int refusedDeletes = 0;
  final Set<String> acceptedNoop = <String>{};

  @override
  Future<void> upsert(TimelineEntry entry) async {
    if (refuseWriteOf != null && entry.displayText == refuseWriteOf) {
      throw StateError('injected write failure');
    }
    await super.upsert(entry);
  }

  @override
  Future<void> delete(String id) async {
    if (readbackFailsAfterDelete) {
      acceptedNoop.add(id);
      return;
    }
    if (refuseDeletes) {
      refusedDeletes++;
      throw StateError('injected delete failure');
    }
    await super.delete(id);
  }

  @override
  Future<TimelineEntry?> readRecord(String id) async {
    if (acceptedNoop.contains(id)) throw StateError('readback unavailable');
    for (final TimelineEntry e in await loadAll()) {
      if (e.id == id) return e;
    }
    return null;
  }
}

/// How the relay answers the n-th recovery start (1-based).
typedef _Recovery = void Function(Rc3Rig r, Rc3Stop stop, int n);

void _final(Rc3Rig r, Rc3Stop stop, String text,
        {bool endedNormally = true, int segmentIdx = 0}) =>
    Future<void>.delayed(
        const Duration(milliseconds: 20),
        () => r.relay.pushIncoming(
            FlowMicEvents.sttFinal,
            r.relay.terminal(stop,
                text: text,
                durationMs: stop.toMs - stop.fromMs,
                segmentIdx: segmentIdx,
                endedNormally: endedNormally)));

/// A long recording: 2 s of words, then the engine goes away and 2 s more is
/// recorded (the owed tail). [recovery] answers each tail attempt.
Future<Rc3Rig> _owedTail(_Steered p, _Recovery recovery) async {
  final Rc3Rig r = await Rc3Rig.open(persistence: p);
  int n = 0;
  r.relay.onStop = (Rc3Stop stop) {
    if (stop.recovery) return recovery(r, stop, ++n);
    Future<void>.delayed(const Duration(milliseconds: 20), () {
      r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
          text: '', durationMs: 0, segmentIdx: 2, endedNormally: false));
    });
  };
  await r.begin();
  await r.feedMs(2000);
  await r.segment(_a, 0, 2000);
  await r.engine('reconnecting');
  await r.feedMs(2000);
  await r.controller.pttUp();
  await r.recoveries(1);
  return r;
}

Future<RecordingManifest> _manifest(Rc3Rig r) async => (await r.manifest())!;

Future<List<String>> _storedTexts(Rc3Rig r) async =>
    (await articleMembersOnDisk(r.timeline, r.articleId!))
        .map((TimelineEntry e) => e.displayText)
        .toList();

Future<void> _retry(Rc3Rig r, int starts) async {
  final String id = (await _manifest(r)).recordingId;
  await r.controller.backfill.retranscribe(recordingId: id, sourceLang: 'zh');
  await r.recoveries(starts);
}

void main() {
  group('RC-3 shortfall retry', () {
    _Recovery shortThenWhole() => (Rc3Rig r, Rc3Stop stop, int n) => n == 1
        ? _final(r, stop, _short, endedNormally: false)
        : _final(r, stop, _whole);

    test('control: proven ⇒ one set of words on disk, the audio goes', () async {
      final _Steered p = _Steered();
      final Rc3Rig r = await _owedTail(p, shortThenWhole());
      addTearDown(r.dispose);
      expect((await _manifest(r)).recoveryState, RecoveryQueueState.shortfall);
      await _retry(r, 2);
      expect(await _storedTexts(r), <String>[_a, _whole]);
      expect((await _manifest(r)).settled, isTrue);
      expect(r.pcmPresent, isFalse);
    });

    test('a refused delete of the partial rows ⇒ no release; the attempt says '
        'which rows it could not withdraw', () async {
      final _Steered p = _Steered();
      final Rc3Rig r = await _owedTail(p, shortThenWhole());
      addTearDown(r.dispose);
      expect((await _manifest(r)).recoveryState, RecoveryQueueState.shortfall);
      p.refuseDeletes = true;
      await _retry(r, 2);
      expect(p.refusedDeletes, greaterThan(0), reason: 'positive control');
      final RecordingManifest m = await _manifest(r);
      expect(m.settled, isFalse);
      expect(r.pcmPresent, isTrue, reason: 'the audio stays');
      expect(m.attempts.last.outcome, JournalAttempt.outcomeFailed);
      expect(m.attempts.last.failureCode, startsWith(kWithdrawNotProvenPrefix));
    });

    test('a failed readback is never proof: no release', () async {
      final _Steered p = _Steered();
      final Rc3Rig r = await _owedTail(p, shortThenWhole());
      addTearDown(r.dispose);
      p.readbackFailsAfterDelete = true;
      await _retry(r, 2);
      expect(p.acceptedNoop, isNotEmpty, reason: 'positive control');
      expect((await _manifest(r)).settled, isFalse);
      expect(r.pcmPresent, isTrue);
    });

    test('the partial rows paged out before the retry are still replaced '
        '(read from storage), one set of words', () async {
      final _Steered p = _Steered();
      final Rc3Rig r = await _owedTail(p, shortThenWhole());
      addTearDown(r.dispose);
      final String partial = r.timeline.entries
          .singleWhere((TimelineEntry e) => e.displayText == _short)
          .id;
      for (int i = 0; i < 65; i++) {
        final TimelineEntry e = r.timeline.buildFromUtterance(
            clientId: 'evict-$i',
            mode: FlowMode.realtime,
            delivery: Delivery.none,
            text: 'filler $i',
            origin: 'cloud');
        await r.timeline.awaitPersisted(e.id);
      }
      await r.timeline.load();
      expect(r.timeline.findById(partial), isNull,
          reason: 'positive control: paged out');
      await _retry(r, 2);
      expect(await _storedTexts(r), isNot(contains(_short)),
          reason: 'the partial words were replaced in storage');
      expect(await _storedTexts(r), contains(_whole));
    });
  });

  group('an ordinary attempt whose rows did not all land', () {
    test('its withdrawal is proven; one it could not prove holds every later '
        'release until those rows are gone', () async {
      final _Steered p = _Steered()
        ..refuseWriteOf = 'Part two.'
        ..refuseDeletes = true;
      final Rc3Rig r = await _owedTail(p, (Rc3Rig r, Rc3Stop stop, int n) {
        if (n == 1) {
          // Two rows: the first lands, the second's write fails.
          Future<void>.delayed(const Duration(milliseconds: 10), () {
            r.relay.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
              'text': 'Part one.', 'confidence': 0.9, 'language': 'zh',
              'segment_idx': 0, 'is_segment': true, 'duration_ms': 1000,
            });
          });
          return _final(r, stop, 'Part two.', segmentIdx: 1);
        }
        _final(r, stop, _whole);
      });
      addTearDown(r.dispose);
      RecordingManifest m = await _manifest(r);
      expect(m.attempts.last.failureCode, startsWith(kWithdrawNotProvenPrefix),
          reason: 'the unproven withdrawal is written onto the attempt');
      expect(await _storedTexts(r), contains('Part one.'),
          reason: 'positive control: the row really is still there');

      // A later attempt that succeeds may NOT release while it is there.
      p.refuseWriteOf = null;
      await _retry(r, 2);
      m = await _manifest(r);
      expect(m.settled, isFalse);
      expect(m.attempts.last.failureCode, 'earlierWithdrawNotProven');
      expect(r.pcmPresent, isTrue);

      // Control: once storage lets it go, the next attempt removes it,
      // proves it, and only then releases.
      p.refuseDeletes = false;
      await _retry(r, 3);
      m = await _manifest(r);
      expect(await _storedTexts(r), isNot(contains('Part one.')));
      expect(m.settled, isTrue);
      expect(r.pcmPresent, isFalse);
    });
  });
}
