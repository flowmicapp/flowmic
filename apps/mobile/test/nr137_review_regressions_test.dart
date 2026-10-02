// NR-137 ROUND 3 — THE INDEPENDENT REVIEW'S REPRODUCTIONS, MADE PERMANENT.
//
// SPEC-REF:
//   _dispatch/2026-10-02-nr137-review.md.out (B1–B5, REJECT of a1b3c9aa)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a, the NR-137 round-3 correction
//
// Each case below is the reviewer's probe (`nr137-review-probes.dart`,
// `nr137-review-durability.dart`), kept in shape and run on the real chain:
// `PttSession` → `ChatController` → `BackfillRunner` → the journal or legacy
// leg, against a fake relay. The relay half of B1 — that the ONE start this
// file pins is ONE claim on the real handler and ledger — is
// `apps/server-core/test/nr137-one-press-one-claim.test.ts`, which reads the
// frames this file captured (`test/fixtures/nr137-one-press-frames.json`
// there; regenerate with `NR137_CAPTURE=1`).
//
// REVERSE CONTROLS (run 2026-10-02 on this file only, one production line or
// block each, red, restored byte-for-byte by sha256, re-run 8/8 green):
//   · B1 journal — `_attempt` no longer feeds kept words whole (`asFed` ⇒ x)
//     ⇒ both journal B1 cases red: `range_start_sample` Actual <32000>;
//   · B1 legacy — only the first kept segment fed ⇒ red: `range_end_sample`
//     Expected <6400> Actual <3200>;
//   · B2 — the failed kept-words press writes `pending` ⇒ red: Expected
//     'settled_unverified' Actual 'pending';
//   · B3 — `_replayOne` hands back every row in the timeline instead of its
//     settlement ledger ⇒ red: the note read 'Unrelated note typed meanwhile

//     Only these words…';
//   · B4 — `removeRowsDurably` reports success when the delete throws ⇒ red:
//     Expected failed Actual done;
//   · B5 — the in-place replacement reads the LOADED members instead of
//     storage ⇒ the B5 case and the reloaded B1 case red: storage held
//     ['First half…', …].
// ROUND 4 (delta review D1/D2), same procedure, re-run 12/12 green:
//   · the attempt inventory filtered by the loaded window again
//     (`recovery_leg_wire.dart`) ⇒ D1 red with the reviewer's exact loss:
//     storage held ['Recovered second half'] only;
//   · the paged-out fail-closed disabled (`pagedOut = false`) ⇒ D1 red: the
//     press settled with the half-placed new rows;
//   · `provenGone` treats a failed read as gone ⇒ both D2 cases red
//     (`removeRowsDurably` Actual <true>; the legacy press Actual done).
// The relay half: replacing the fixture with the round-2 press (two starts,
// `_dispatch/nr137-review-legacy-frames.json`) turns
// `nr137-one-press-one-claim.test.ts` red (`got 2`, two manual claims).
//
// ⚠️ Rc3Rig cases call real timers; they are plain `test`s, like the
// reviewer's probes, so no fake-async zone is involved.

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/kept_words_retranscribe.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/pending_recovery_store.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart' show newTestStore;
import 'support/legacy_backfill_rig.dart';
import 'support/rc3_rig.dart';

const String _a = 'First half of the meeting notes.';
const String _b = 'Second half of the meeting notes.';
const String _again = 'The whole meeting, transcribed again.';
const int _totalMs = 4000;

typedef _Answer = void Function(Rc3Rig r, Rc3Stop stop);

void _words(Rc3Rig r, Rc3Stop stop) => Future<void>.delayed(
    const Duration(milliseconds: 20),
    () => r.relay.pushIncoming(FlowMicEvents.sttFinal,
        r.relay.terminal(stop, text: _again, durationMs: stop.toMs - stop.fromMs)));

void _stall(Rc3Rig r, Rc3Stop stop) => Future<void>.delayed(
    const Duration(milliseconds: 20),
    () => r.relay.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
          'code': 'STT_ENGINE_TIMEOUT',
          'message': 'the engine did not answer',
          'retryable': false,
        }));

Future<Rc3Rig> _unverifiedArticle(_Answer answer,
    {bool twoStretches = false}) async {
  final Rc3Rig r = await Rc3Rig.open();
  r.relay.onStop = (Rc3Stop stop) {
    if (stop.recovery) return answer(r, stop);
    Future<void>.delayed(const Duration(milliseconds: 20), () {
      r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
          text: '', durationMs: 0, segmentIdx: 2, endedNormally: false));
    });
  };
  await r.begin();
  await r.feedMs(_totalMs);
  await r.segment(_a, 0, 2000);
  await r.segment(_b, 1, 2000);
  await r.controller.pttUp();
  await r.untilAsync(() async =>
      (await r.manifest())?.recoveryState ==
      RecoveryQueueState.settledUnverified);
  if (twoStretches) {
    // The reviewer's persisted fixture: an earlier stretch concluded without
    // proof, and the last stretch still owed — as production leaves it.
    final RecordingManifest m = (await r.manifest())!;
    final String p = r.fs.paths
        .singleWhere((String p) => p.endsWith(RetainedAudioJournal.manifestSuffix));
    await r.fs.writeBytes(
        p,
        Uint8List.fromList(utf8.encode(m.copyWith(owedRanges: const <OwedRange>[
          OwedRange(start: 0, end: 64000, atMs: 0, done: OwedRange.doneUnverified),
          OwedRange(start: 64000, end: 128000, atMs: 2000),
        ]).encode())));
  }
  return r;
}

PendingRecoveryStore _source(Rc3Rig r) =>
    PendingRecoveryStore(runner: r.controller.backfill, sourceLang: () => 'zh');

Future<PendingRecoveryItem> _only(Rc3Rig r) async =>
    (await _source(r).list()).single;

List<String> _texts(Rc3Rig r) =>
    r.rows.map((TimelineEntry e) => e.displayText).toList();

/// A persistence whose deletes all fail (the reviewer's `_DeleteFails`).
class _DeleteFails extends InMemoryTimelinePersistence {
  int failures = 0;
  @override
  Future<void> delete(String id) async {
    failures++;
    throw StateError('injected delete failure');
  }
}

/// Round 4 (review D2): a delete that returns but keeps the row, and a keyed
/// readback that then fails for that row (the reviewer's
/// `DeleteNoopReadFails`). The full inventory still reads.
class _DeleteNoopReadFails extends InMemoryTimelinePersistence
    implements TimelineKeyedPersistence {
  final Set<String> deleted = <String>{};
  @override
  Future<void> delete(String id) async => deleted.add(id);
  @override
  Future<TimelineEntry?> readRecord(String id) async {
    if (deleted.contains(id)) throw StateError('readback unavailable');
    for (final TimelineEntry e in await loadAll()) {
      if (e.id == id) return e;
    }
    return null;
  }
}

void main() {
  group('B1 — one press, one operation', () {
    test('legacy: two kept segments ⇒ ONE start, ONE operation, ONE note',
        () async {
      final LegacyRig rig = await LegacyRig.open();
      addTearDown(rig.dispose);
      const String key = 'review-legacy-multi';
      for (int i = 0; i < 2; i++) {
        await rig.seed(key, idx: i);
        expect(await rig.store.markUnverified(i, session: key), isTrue);
      }
      rig.relay.replyWords('First and second recovered segment');
      expect(await rig.pending.retryNow((await rig.pending.list()).single),
          PendingRetryOutcome.done);
      await rig.idle();
      final List<Map<String, Object?>> frames = rig.relay.starts;
      expect(frames, hasLength(1), reason: 'one press is one audio:start');
      final Map<String, Object?> f = frames.single;
      expect(f['attempt_kind'], 'user_retranscribe');
      expect(f['delivery'], 'none');
      expect(f['recording_id'], '${key}__kept');
      expect(f['range_start_sample'], 0);
      expect(f['range_end_sample'], 2 * 6400 ~/ 2,
          reason: 'both segments, as samples, in the one range');
      expect(
          rig.timeline.entries.where((TimelineEntry e) => e.retranscribedFrom != null),
          hasLength(1));
      expect(await rig.store.bytesForSession(key), 0);
      if (Platform.environment['NR137_CAPTURE'] == '1') {
        await File('../server-core/test/fixtures/nr137-one-press-frames.json')
            .writeAsString(const JsonEncoder.withIndent('  ').convert(frames));
      }
      // The frame the relay test feeds its real handler must be this shape.
      final List<Object?> fixture = jsonDecode(File(
              '../server-core/test/fixtures/nr137-one-press-frames.json')
          .readAsStringSync()) as List<Object?>;
      expect(fixture, hasLength(1));
      final Map<String, Object?> fx = fixture.single! as Map<String, Object?>;
      expect(fx.keys.toSet(), f.keys.toSet());
      for (final String k in <String>[
        'attempt_kind',
        'delivery',
        'range_start_sample',
        'range_end_sample',
        'mode',
      ]) {
        expect(fx[k], f[k], reason: k);
      }
    });

    for (final bool reloaded in <bool>[false, true]) {
      test(
          'journal, two stretches${reloaded ? ', timeline reloaded' : ''} ⇒ ONE '
          'start over the whole recording, and the article holds one set of '
          'words at its place', () async {
        final Rc3Rig r = await _unverifiedArticle(_words, twoStretches: true);
        addTearDown(r.dispose);
        if (reloaded) {
          for (int i = 0; i < 65; i++) {
            final TimelineEntry e = r.timeline.buildFromUtterance(
                clientId: 'filler-$i',
                mode: FlowMode.realtime,
                delivery: Delivery.none,
                text: 'filler $i',
                origin: 'cloud');
            await r.timeline.awaitPersisted(e.id);
          }
          await r.timeline.load();
        }
        final PendingRecoveryItem item = await _only(r);
        expect(item.retranscribable, isTrue);
        expect(item.retranscribeAsNote, isFalse,
            reason: 'an article is replaced in place, loaded or not');
        await _source(r).retryNow(item);
        await r.recoveries(1);
        await Future<void>.delayed(const Duration(milliseconds: 300));
        expect(r.relay.recoveryStarts, hasLength(1));
        final Map<String, Object?> f = r.relay.recoveryStarts.single;
        expect(f['range_start_sample'], 0);
        expect(f['range_end_sample'], _totalMs * 16);
        final List<TimelineEntry> stored =
            await articleMembersOnDisk(r.timeline, r.articleId!);
        expect(stored.map((TimelineEntry e) => e.displayText), <String>[_again],
            reason: 'one set of words, in storage');
        expect(stored.single.articleOffsetMs, 0);
        expect(
            r.timeline.entries.where((TimelineEntry e) => e.retranscribedFrom != null),
            isEmpty,
            reason: 'in place, not a note');
        expect((await r.manifest())!.settled, isTrue);
      });
    }
  });

  test('B2 — a manual press that fails never opens the automatic route',
      () async {
    final Rc3Rig r = await _unverifiedArticle(_stall, twoStretches: true);
    addTearDown(r.dispose);
    final PendingRetryOutcome out = await _source(r).retryNow(await _only(r));
    await r.recoveries(1);
    expect(out, PendingRetryOutcome.failed);
    final RecordingManifest afterPress = (await r.manifest())!;
    expect(afterPress.recoveryState, RecoveryQueueState.settledUnverified);
    await r.controller.backfill.sweep(sourceLang: 'zh');
    await r.recoveries(1, max: const Duration(seconds: 2));
    expect(r.relay.recoveryStarts.map((Map<String, Object?> f) => f['attempt_kind']),
        <String>['user_retranscribe'],
        reason: 'no auto_retry after the failed manual press');
    final RecordingManifest afterSweep = (await r.manifest())!;
    expect(RecoveryJobStatus.fromManifest(afterSweep).failedAutoAttempts, 0);
    expect(afterSweep.recoveryState, RecoveryQueueState.settledUnverified);
    expect(_texts(r), <String>[_a, _b], reason: 'the earlier words stand');
    expect(r.pcmPresent, isTrue);
    expect((await _only(r)).retranscribable, isTrue,
        reason: 'and it can still be re-transcribed by hand');
  });

  group('B3 — a row the press did not settle is never touched', () {
    test('legacy: a delivered row written during the replay survives the fold',
        () async {
      final GateChangePersistence p = GateChangePersistence();
      final LegacyRig rig = await LegacyRig.open(persistence: p);
      addTearDown(rig.dispose);
      const String key = 'review-concurrent-row';
      await rig.seed(key);
      await rig.store.markUnverified(0, session: key);
      TimelineEntry? other;
      TimelineEntry? noted;
      p.change = () {
        // A record-only note written meanwhile: passes every per-row check,
        // so only the ownership ledger keeps it out of the fold.
        noted = rig.timeline.buildFromUtterance(
            clientId: 'unrelated-noted',
            mode: FlowMode.realtime,
            delivery: Delivery.none,
            text: 'Unrelated note typed meanwhile',
            origin: 'cloud',
            mcpContentReady: true);
        final TimelineEntry e = rig.timeline.buildFromUtterance(
            clientId: 'unrelated-delivered',
            mode: FlowMode.realtime,
            delivery: Delivery.inject,
            text: 'Unrelated already delivered words');
        rig.timeline.applyInjectResult(
            correlationId: e.clientId, ok: true, wireMode: 'injected');
        other = rig.timeline.findById(e.id);
      };
      rig.relay.replyWords('Only these words were re-transcribed');
      await rig.pending.retryNow((await rig.pending.list()).single);
      await rig.idle();
      expect(other, isNotNull, reason: 'positive control: the row was written');
      expect(other!.status, EntryStatus.injected);
      final TimelineEntry? still = rig.timeline.findById(other!.id);
      expect(still, isNotNull, reason: 'the delivered row survives');
      expect(still!.displayText, 'Unrelated already delivered words');
      final TimelineEntry note = rig.timeline.entries
          .singleWhere((TimelineEntry e) => e.retranscribedFrom != null);
      expect(note.displayText, 'Only these words were re-transcribed',
          reason: 'no unrelated text in the note');
      expect(rig.timeline.findById(noted!.id)?.displayText,
          'Unrelated note typed meanwhile',
          reason: 'a row this replay did not settle is not its to fold');
    });

    test('journal: a delivered row written during the replay survives',
        () async {
      final Rc3Rig r = await Rc3Rig.open(fixedRecordOnly: false);
      addTearDown(r.dispose);
      TimelineEntry? other;
      r.relay.onStop = (Rc3Stop stop) {
        if (stop.recovery) {
          final TimelineEntry e = r.timeline.buildFromUtterance(
              clientId: 'unrelated-delivered-j',
              mode: FlowMode.realtime,
              delivery: Delivery.inject,
              text: 'Unrelated delivered words, journal');
          r.timeline.applyInjectResult(
              correlationId: e.clientId, ok: true, wireMode: 'injected');
          other = r.timeline.findById(e.id);
          return _words(r, stop);
        }
        Future<void>.delayed(const Duration(milliseconds: 20), () {
          r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
              text: _a, durationMs: 2000, endedNormally: false));
        });
      };
      await r.controller.pttDown();
      await r.feedMs(2000);
      await r.controller.pttUp();
      await r.untilAsync(() async =>
          (await r.manifest())?.recoveryState ==
          RecoveryQueueState.settledUnverified);
      expect(await _source(r).retryNow(await _only(r)), PendingRetryOutcome.done);
      await r.recoveries(1);
      expect(other, isNotNull, reason: 'positive control');
      expect(r.timeline.findById(other!.id)?.displayText,
          'Unrelated delivered words, journal');
      final TimelineEntry note = r.timeline.entries
          .singleWhere((TimelineEntry e) => e.retranscribedFrom != null);
      expect(note.displayText, _again);
    });
  });

  test('B4 — a removal that does not complete is a failed press: audio kept, '
      'nothing released, one copy on disk', () async {
    final _DeleteFails p = _DeleteFails();
    final LegacyRig rig = await LegacyRig.open(persistence: p);
    addTearDown(rig.dispose);
    const String key = 'review-failed-fold-delete';
    await rig.seed(key);
    await rig.store.markUnverified(0, session: key);
    rig.relay.replyWords('Replay text duplicated if delete fails');
    final PendingRetryOutcome out =
        await rig.pending.retryNow((await rig.pending.list()).single);
    await rig.idle();
    expect(p.failures, greaterThan(0), reason: 'positive control');
    expect(out, PendingRetryOutcome.failed, reason: 'said truthfully');
    expect(await rig.store.bytesForSession(key), 6400, reason: 'audio kept');
    expect(await rig.store.unverifiedSegments(key), <int>{0});
    final List<TimelineEntry> stored = await p.loadAll();
    expect(
        stored.where((TimelineEntry e) =>
            !e.deleted && e.displayText == 'Replay text duplicated if delete fails'),
        hasLength(lessThanOrEqualTo(1)),
        reason: 'never a note AND its replay row');
  });

  test('B5 — a reload in the middle of an in-place press leaves one copy on '
      'disk', () async {
    final Rc3Rig r = await _unverifiedArticle((Rc3Rig r, Rc3Stop stop) {
      Future<void>(() async {
        for (int i = 0; i < 65; i++) {
          final TimelineEntry e = r.timeline.buildFromUtterance(
              clientId: 'midpress-filler-$i',
              mode: FlowMode.realtime,
              delivery: Delivery.none,
              text: 'newer row $i',
              origin: 'cloud');
          await r.timeline.awaitPersisted(e.id);
        }
        await r.timeline.load();
        r.relay.pushIncoming(FlowMicEvents.sttFinal,
            r.relay.terminal(stop, text: _again, durationMs: _totalMs));
      });
    });
    addTearDown(r.dispose);
    final PendingRecoveryItem item = await _only(r);
    expect(item.retranscribeAsNote, isFalse);
    await _source(r).retryNow(item);
    await r.recoveries(1);
    final List<TimelineEntry> stored =
        await articleMembersOnDisk(r.timeline, r.articleId!);
    expect(stored.map((TimelineEntry e) => e.displayText), <String>[_again],
        reason: 'the earlier words were removed from storage, not only from '
            'the loaded window');
    expect((await r.manifest())!.settled, isTrue);
  });

  // ── ROUND 4 (delta review `_dispatch/2026-10-02-nr137-r3-review.md.out`) ──
  group('D1 — a row this press wrote is its own, paged out or not', () {
    test('a replay segment paged out mid-press is never taken for 「earlier」 '
        'text: nothing of the press survives half-placed, the earlier words '
        'and the audio stay, and the press says failed', () async {
      late final String producedId;
      final Rc3Rig r = await _unverifiedArticle((Rc3Rig r, Rc3Stop stop) {
        Future<void>(() async {
          await r.segment('Recovered first half', 0, 2000);
          final TimelineEntry produced = r.rows
              .singleWhere((TimelineEntry e) => e.displayText == 'Recovered first half');
          producedId = produced.id;
          await r.timeline.awaitPersisted(produced.id);
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
          r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
              text: 'Recovered second half', durationMs: 2000, segmentIdx: 1));
        });
      });
      addTearDown(r.dispose);
      final PendingRetryOutcome out = await _source(r).retryNow(await _only(r));
      await r.recoveries(1);
      expect(r.timeline.findById(producedId), isNull,
          reason: 'positive control: the replay segment was paged out');
      final List<TimelineEntry> stored =
          await articleMembersOnDisk(r.timeline, r.articleId!);
      expect(stored.map((TimelineEntry e) => e.displayText), <String>[_a, _b],
          reason: 'no row the press did not create was deleted, and none of '
              'its own was left behind half-placed');
      expect(out, PendingRetryOutcome.failed, reason: 'said truthfully');
      expect(r.pcmPresent, isTrue, reason: 'the audio stays');
      final RecordingManifest m = (await r.manifest())!;
      expect(m.settled, isFalse);
      expect(m.recoveryState, RecoveryQueueState.settledUnverified);
    });
  });

  group('D2 — a removal is proven only by storage saying 「gone」', () {
    test('a readback that fails is unknown, never verified absence', () async {
      final _DeleteNoopReadFails p = _DeleteNoopReadFails();
      final TimelineStore t = newTestStore(persistence: p);
      addTearDown(t.dispose);
      final TimelineEntry row = t.buildFromUtterance(
          clientId: 'remove-read-error',
          mode: FlowMode.realtime,
          delivery: Delivery.none,
          text: 'still on disk');
      await t.awaitPersisted(row.id);
      expect(await removeRowsDurably(t, <TimelineEntry>[row]), isFalse);
      expect((await p.loadAll()).map((TimelineEntry e) => e.displayText),
          contains('still on disk'),
          reason: 'positive control: the row really is still there');
    });

    test('the real legacy press with a failing readback: failed, audio kept',
        () async {
      final _DeleteNoopReadFails p = _DeleteNoopReadFails();
      final LegacyRig rig = await LegacyRig.open(persistence: p);
      addTearDown(rig.dispose);
      const String key = 'r3-readback-error';
      await rig.seed(key);
      await rig.store.markUnverified(0, session: key);
      rig.relay.replyWords('Duplicated when absence is mis-proven');
      final PendingRetryOutcome out =
          await rig.pending.retryNow((await rig.pending.list()).single);
      await rig.idle();
      expect(out, PendingRetryOutcome.failed);
      expect(await rig.store.bytesForSession(key), 6400);
      expect(
          (await p.loadAll()).where((TimelineEntry e) =>
              !e.deleted && e.displayText == 'Duplicated when absence is mis-proven'),
          hasLength(lessThanOrEqualTo(1)),
          reason: 'never the note AND its replay row');
    });

    test('the journal press with every delete refused: failed, audio kept, '
        'still manual-only (review F1, the accepted residual)', () async {
      final _DeleteFails p = _DeleteFails();
      final Rc3Rig r = await Rc3Rig.open(persistence: p);
      addTearDown(r.dispose);
      r.relay.onStop = (Rc3Stop stop) {
        if (stop.recovery) return _words(r, stop);
        Future<void>.delayed(const Duration(milliseconds: 20), () {
          r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
              text: '', durationMs: 0, segmentIdx: 2, endedNormally: false));
        });
      };
      await r.begin();
      await r.feedMs(_totalMs);
      await r.segment(_a, 0, 2000);
      await r.segment(_b, 1, 2000);
      await r.controller.pttUp();
      await r.untilAsync(() async =>
          (await r.manifest())?.recoveryState ==
          RecoveryQueueState.settledUnverified);
      final PendingRetryOutcome out = await _source(r).retryNow(await _only(r));
      await r.recoveries(1);
      expect(p.failures, greaterThan(0), reason: 'positive control');
      expect(out, PendingRetryOutcome.failed);
      expect(r.pcmPresent, isTrue);
      expect((await r.manifest())!.recoveryState,
          RecoveryQueueState.settledUnverified);
      await r.controller.backfill.sweep(sourceLang: 'zh');
      await r.recoveries(1, max: const Duration(seconds: 2));
      expect(r.relay.recoveryStarts, hasLength(1), reason: 'no automatic start');
    });
  });
}
