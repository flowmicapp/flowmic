// NR-137 round 10c — A RELEASE NEVER HOLDS TIMELINE WRITES WITHOUT BOUND.
//
// SPEC-REF: lib/src/timeline/timeline_write_gate.dart (budgets and why),
//   lib/src/session/recovery_leg_rows.dart (`_sealRelease`).
//
// Round 10b held the timeline write gate from before a release's final proof
// to after its PCM delete, with no limit: a proof that hung stopped every
// timeline write, a new dictation's included. Here, on the real chain
// (`Rc3Rig` → `PendingRecoveryStore.retryNow`) over the shipped backends:
//   · the final proof hangs → a timeline write made meanwhile lands at once,
//     and the press ends failed within the proof budget with its audio kept;
//   · the final proof is slow → a write made meanwhile lands at once, and the
//     release proves again and completes;
//   · a relevant write lands after the final proof's census has read → the
//     release proves again, sees it, and keeps the audio;
//   · the seal (the settling commit) hangs → a write waiting on it lands
//     within the hold budget, and the late commit is put back: audio kept.
// The write is the one a dictation makes: the shipped persistence's upsert.
//
// FINDING THE FINAL PROOF without any hook into the product: a calibration
// press counts the census reads (`loadInventory`) made before the seal's
// commit is written; the last of them is the final proof's. A second press
// on a fresh rig stalls exactly that read.
//
// REVERSE CONTROL (2026-10-02): this file on `c3d57817` (round 10b), product
// code unmodified, one backend per run — all eight cases red (the writes did
// not land in time; the hung press never ended). The relevant-write case is
// red there for a different reason — 10b made the write wait and ordered it
// after the release, which was safe — so its evidence is on the fix: without
// the yield it goes red (the stale proof releases the audio). Also on the fix:
// no proof budget → hung proof ×2 red; no hold budget → hung seal ×2 red; a
// put-back that does not wait for the late commit → hung seal ×2 red (the
// cleanup mark comes back on an unverified recording). Round-10 report,
// "Round 10c".

import 'dart:async';
import 'dart:io';

import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_client.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_payload.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_verified_reads.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'support/nr137_rig.dart';
import 'support/portable_rows.dart';
import 'support/rc3_rig.dart';

/// SQLite that will not open this session; whether its file exists is real.
class _NoSqliteFactory implements DatabaseFactory {
  @override
  Future<Database> openDatabase(String path, {OpenDatabaseOptions? options}) =>
      Future<Database>.error(StateError('SQLite will not open this session'));
  @override
  Future<bool> databaseExists(String path) =>
      databaseFactoryFfi.databaseExists(path);
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

enum _Backend { fallback, sqlite }

Future<TimelinePersistence> _backend(_Backend b, SharedPreferences prefs) async {
  final Directory dir = await Directory.systemTemp.createTemp('nr137-r10c-');
  addTearDown(() async {
    try { await dir.delete(recursive: true); } on Object { /* best effort */ }
  });
  final TimelineStorageOpen open = await openTimelinePersistence(
      prefs: prefs,
      factory: b == _Backend.sqlite ? databaseFactoryFfi : _NoSqliteFactory(),
      path: '${dir.path}/timeline.db');
  if (open.persistence is SqfliteTimelinePersistence) {
    addTearDown((open.persistence as SqfliteTimelinePersistence).close);
  }
  return open.persistence;
}

/// Counts census reads; stalls read number [stallAt] on [stall] — before it
/// reads, or with [afterRead] once it has read.
class _CensusSlot extends Nr137BackendSlot {
  _CensusSlot(super.current);
  int census = 0;
  int? stallAt;
  bool afterRead = false;
  Future<void> stall = Future<void>.value();
  final Completer<void> reached = Completer<void>();
  @override
  Future<TimelineInventory> loadInventory() async {
    if (++census != stallAt) return super.loadInventory();
    final TimelineInventory? read = afterRead ? await super.loadInventory() : null;
    reached.complete();
    await stall;
    return read ?? super.loadInventory();
  }
}

bool _settledTemp(String path, List<int> bytes) =>
    path.endsWith(RetainedAudioJournal.manifestTempSuffix) &&
    RecordingManifest.decode(String.fromCharCodes(bytes)).recoveryState ==
        RecoveryQueueState.settled;

/// The census read that is the final proof's (see the file header).
Future<int> _finalCensus(_Backend backend) async {
  final _CensusSlot slot =
      _CensusSlot(await _backend(backend, await nr137EmptyPrefs()));
  final Rc3Rig r = await nr137Article(slot);
  int? before;
  r.fs.onWrite = (String path, List<int> bytes) {
    if (before == null && _settledTemp(path, bytes)) before = slot.census;
  };
  expect(await nr137Press(r), PendingRetryOutcome.done,
      reason: 'calibration: an undisturbed press releases');
  expect(before, isNotNull, reason: 'calibration: the seal was written');
  return before!;
}

/// Does [write] land within [within]?
Future<bool> _landsWithin(Future<void> write, Duration within) =>
    write.then((_) => true).timeout(within, onTimeout: () => false);

TimelineEntry _dictated(String id) =>
    testRow(id: id, text: 'Dictated while a re-transcription runs.');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(sqfliteFfiInit);

  for (final _Backend backend in _Backend.values) {
    test('slow proof ${backend.name}: a write made during it lands at once, '
        'and the release proves again', () async {
      final int last = await _finalCensus(backend);
      final _CensusSlot slot =
          _CensusSlot(await _backend(backend, await nr137EmptyPrefs()));
      slot.stallAt = last;
      slot.stall = Future<void>.delayed(const Duration(milliseconds: 1500));
      final Rc3Rig r = await nr137Article(slot);

      final Future<PendingRetryOutcome> press = nr137Press(r);
      await slot.reached.future.timeout(const Duration(seconds: 20));
      final Stopwatch took = Stopwatch()..start();
      final bool landed = await _landsWithin(
          slot.upsert(_dictated('dictated-slow-${backend.name}')),
          const Duration(milliseconds: 1000));
      final int ms = took.elapsedMilliseconds;
      final PendingRetryOutcome out = await press;

      // ignore: avoid_print
      print('R10c slow ${backend.name}: finalCensus=$last writeLanded=$landed '
          'writeMs=$ms outcome=$out audioPresent=${r.pcmPresent}');
      expect(landed, isTrue,
          reason: 'a timeline write never waits on a release proof');
      expect(await slot.current.loadById('dictated-slow-${backend.name}'),
          isNotNull);
      expect(out, PendingRetryOutcome.done,
          reason: 'the release yields to the write and proves again');
      expect(r.pcmPresent, isFalse);
    });

    test('hung seal ${backend.name}: a write waiting on it lands within the '
        'hold budget, and the late commit is put back', () async {
      final SharedPreferences prefs = await nr137EmptyPrefs();
      final _CensusSlot slot = _CensusSlot(await _backend(backend, prefs));
      final Rc3Rig r = await nr137Article(slot);
      final Completer<void> unstick = Completer<void>();
      addTearDown(() { if (!unstick.isCompleted) unstick.complete(); });
      Future<bool>? write;
      bool sealStarted = false;
      r.fs.onWrite = (String path, List<int> bytes) {
        if (sealStarted || !_settledTemp(path, bytes)) return;
        sealStarted = true;
        // Started inside the seal: it waits for the hold to end.
        write = _landsWithin(slot.upsert(_dictated('dictated-seal-${backend.name}')),
            const Duration(milliseconds: 1500));
      };
      r.fs.onRename = (String from, String to) async {
        if (sealStarted && !unstick.isCompleted &&
            from.endsWith(RetainedAudioJournal.manifestTempSuffix)) {
          await unstick.future; // the seal's commit cannot publish
        }
      };
      DiagLog.instance.clear();
      final bool markedBefore = (await r.manifest())!.settled;

      final Future<PendingRetryOutcome> press = nr137Press(r);
      await Future.doWhile(() async {
        await Future<void>.delayed(const Duration(milliseconds: 10));
        return write == null;
      }).timeout(const Duration(seconds: 20));
      final bool landed = await write!;
      unstick.complete(); // the late commit publishes now; the put-back after it
      final PendingRetryOutcome out =
          await press.timeout(const Duration(seconds: 20));
      final RecordingManifest m = (await r.manifest())!;
      final List<String> trail = DiagLog.instance.snapshot();

      // ignore: avoid_print
      print('R10c seal ${backend.name}: writeLanded=$landed outcome=$out '
          'state=${m.recoveryState} settled=${m.settled} audioPresent=${r.pcmPresent} '
          'aborted=${trail.where((String l) => l.contains('release_aborted')).toList()}');
      expect(landed, isTrue,
          reason: 'a write waits on a seal for the hold budget at most');
      expect(out, PendingRetryOutcome.failed);
      expect(m.recoveryState, RecoveryQueueState.settledUnverified,
          reason: 'the late settling commit was put back');
      expect(m.attempts.last.outcome, JournalAttempt.outcomeSettledUnverified);
      expect(m.settled, markedBefore, reason: 'the cleanup mark as it was');
      expect(r.pcmPresent, isTrue);
      expect(trail.any((String l) => l.contains(
              'timeline.release_aborted phase=seal reason=timeout')), isTrue);
    });

    test('relevant write during the proof ${backend.name}: the release proves '
        'again, sees it, and keeps the audio', () async {
      final int last = await _finalCensus(backend);
      final SharedPreferences prefs = await nr137EmptyPrefs();
      final _CensusSlot slot = _CensusSlot(await _backend(backend, prefs));
      slot.stallAt = last;
      slot.afterRead = true;
      slot.stall = Future<void>.delayed(const Duration(milliseconds: 300));
      final Rc3Rig r = await nr137Article(slot);
      final TimelineEntry old = r.rows.first;

      final Future<PendingRetryOutcome> press = nr137Press(r);
      await slot.reached.future.timeout(const Duration(seconds: 20));
      // The final proof's census has read every store; only keyed reads of
      // timeline rows follow. A cloud merge now saves a pulled copy of a
      // replaced member: nothing left in this proof reads the retry store.
      await SharedPrefsBlindStoreCursorStore(prefs).saveRetry(
          'nr137-r10c-relevant',
          BlindStoreRemoteBlob(
              id: old.id, seq: 1, ciphertext: 'opaque-envelope', createdAtMs: 0,
              schemaVer: kBlindStoreBlobSchemaVer + 1, deleted: false));
      final PendingRetryOutcome out = await press;

      // ignore: avoid_print
      print('R10c relevant ${backend.name}: outcome=$out '
          'audioPresent=${r.pcmPresent}');
      expect(out, PendingRetryOutcome.failed,
          reason: 'a proof a writer ran through is taken again');
      expect(r.pcmPresent, isTrue);
    });

    // Last in the file: on a build whose gate a hung proof never lets go, the
    // stall leaks into every test after it.
    test('hung proof ${backend.name}: a write made during it lands at once, '
        'and the press fails with its audio kept', () async {
      final int last = await _finalCensus(backend);
      final _CensusSlot slot =
          _CensusSlot(await _backend(backend, await nr137EmptyPrefs()));
      final Completer<void> never = Completer<void>();
      addTearDown(() { if (!never.isCompleted) never.complete(); });
      slot.stallAt = last;
      slot.stall = never.future;
      final Rc3Rig r = await nr137Article(slot);
      DiagLog.instance.clear();

      final Stopwatch spent = Stopwatch()..start();
      final Future<PendingRetryOutcome?> press = nr137Press(r)
          .then<PendingRetryOutcome?>((PendingRetryOutcome o) => o)
          // The proof budget is 10 s (`TimelineWriteGate.kProofBudget`).
          .timeout(const Duration(seconds: 25), onTimeout: () => null);
      await slot.reached.future.timeout(const Duration(seconds: 20));
      final bool landed = await _landsWithin(
          slot.upsert(_dictated('dictated-hung-${backend.name}')),
          const Duration(milliseconds: 1000));
      final PendingRetryOutcome? out = await press;
      final int ms = spent.elapsedMilliseconds;
      final List<String> trail = DiagLog.instance.snapshot();

      // ignore: avoid_print
      print('R10c hung ${backend.name}: finalCensus=$last writeLanded=$landed '
          'outcome=$out pressMs=$ms audioPresent=${r.pcmPresent} '
          'aborted=${trail.where((String l) => l.contains('release_aborted')).toList()}');
      expect(landed, isTrue,
          reason: 'a hung release proof never holds a timeline write');
      expect(out, PendingRetryOutcome.failed,
          reason: 'the press ends, failed, within the proof budget');
      expect(r.pcmPresent, isTrue);
      expect(trail.any((String l) => l.contains(
              'timeline.release_aborted phase=proof reason=timeout')), isTrue);
    });
  }
}
