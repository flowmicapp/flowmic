// Card RC-1b — THE TWO ACTIONS, ON THE REAL CHAIN.
//
// `recovery_copy_matches_capability_test.dart` mounts the screen over a fake
// source and asks what the user READS. This file asks what actually HAPPENS: it
// builds the production `BackfillRunner` over a real temp directory and a fake
// socket, and drives `PendingRecoveryStore` — the object the screen is handed
// in production (`session/chat_pending_recovery.dart`).
//
// 🔴 WHY IT CANNOT BE A UNIT TEST OF THE STORE. The thing worth proving is that
// a press reaches the wire as `attempt_kind: user_retranscribe`, and that
// stamp crosses four objects (store → runner → journal leg → PttSession) before
// it becomes a frame. CLAUDE.md's anti-façade ③ is the rule: a green unit test
// has zero proving power about wiring. So the assertion lands on the emitted
// `audio:start` payload, which is the thing the server will read.
//
// ⚠️ Ordinary `test`, not `testWidgets`: nothing here renders. The screen's own
// behaviour is the other file's subject.

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/backfill_runner.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/pending_recovery_store.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/session/recovery_identity.dart';
import 'package:flowmic/src/session/recovery_leg_policy.dart';
import 'package:flowmic/src/session/recovery_settle.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/delete_race_fs.dart';
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/temp_teardown.dart';

const int kBytesPerSecond = 32000;

const List<String> kTierA = <String>[
  kCapabilityCoverageReceipt,
  kCapabilityDeliveryNoneSafe,
  kCapabilityIdempotentOperation,
];

/// Records every `audio:start` so a case can read what left the phone.
class _StartRecordingTransport extends FakeSocketTransport {
  final List<Map<String, Object?>> starts = <Map<String, Object?>>[];

  final Completer<void> _onWire = Completer<void>();

  /// Completes the instant the FIRST `audio:start` leaves the phone.
  ///
  /// 🔴 IT EXISTS SO A CASE CAN SAY 「the attempt is on the wire」 INSTEAD OF
  /// 「10 ms have passed」. See the delete-race case below for the whole story;
  /// the short version is that a wall-clock head start decides WHICH PART of
  /// the leg the delete lands in, and on a loaded machine it chose a different
  /// part than the case claims to be about.
  Future<void> get onWire => _onWire.future;

  @override
  void emit(String event, Object? payload) {
    super.emit(event, payload);
    if (event == FlowMicEvents.audioStart && payload is Map<String, Object?>) {
      starts.add(payload);
      if (!_onWire.isCompleted) _onWire.complete();
    }
  }
}

/// A filesystem that refuses to delete files whose path ends with [refuse].
///
/// 🔴 IT IS THE ONLY WAY TO REACH THE Z1 BRANCH. The defect it exists for is
/// what the delete does AFTER a removal fails, and on a real temp directory
/// every removal succeeds — so the failure has to be injected at the seam
/// `RetainedAudioSpill` already exposes for exactly this (`journalFs`).
/// Everything else delegates, so the recording is written and scanned by the
/// real implementation.
class _RefusingDeleteFs implements JournalFileSystem {
  _RefusingDeleteFs(this.refuse);

  final String refuse;
  final JournalFileSystem _inner = const IoJournalFileSystem();
  final List<String> deleted = <String>[];

  @override
  Future<void> deleteFile(String path) async {
    if (path.endsWith(refuse)) {
      throw const FileSystemException('refused by the test');
    }
    deleted.add(path);
    await _inner.deleteFile(path);
  }

  @override
  Future<void> ensureDirectory(String path) => _inner.ensureDirectory(path);
  @override
  Future<bool> exists(String path) => _inner.exists(path);
  @override
  Future<int> lengthOf(String path) => _inner.lengthOf(path);
  @override
  Future<List<String>> listNames(String path) => _inner.listNames(path);
  @override
  Future<JournalFileHandle> openAppend(String path) => _inner.openAppend(path);
  @override
  Future<Uint8List> readBytes(String path) => _inner.readBytes(path);
  @override
  Future<Uint8List> readRange(String path, int start, int end) =>
      _inner.readRange(path, start, end);
  @override
  Future<void> rename(String from, String to) => _inner.rename(from, to);
  @override
  Future<void> writeBytes(String path, Uint8List bytes, {bool flush = true}) =>
      _inner.writeBytes(path, bytes, flush: flush);
}


class _Rig {
  _Rig._(this.tmp, this.store, this.spill);

  static Future<_Rig> open({
    List<String> capabilities = kTierA,
    JournalFileSystem? journalFs,
  }) async {
    final Directory tmp =
        await Directory.systemTemp.createTemp('flowmic-rc1b-');
    final RetainedAudioStore store =
        RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    final _Rig r = _Rig._(
      tmp,
      store,
      // 🔴 The journal face ON. Production still builds the spill with
      // `retainFromFirstFrame: false` (retained_audio_boot.dart lists the five
      // things that must land first), so a rig that used the default would be
      // testing the legacy leg while claiming to test this card.
      RetainedAudioSpill(
        store: store,
        retainFromFirstFrame: true,
        journalFs: journalFs ?? const IoJournalFileSystem(),
      ),
    );
    r._build(capabilities);
    while (r.runner.isBusy) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    return r;
  }

  final Directory tmp;
  final RetainedAudioStore store;
  final RetainedAudioSpill spill;

  late final _StartRecordingTransport transport;
  late final PttSession session;
  late final TimelineStore timeline;
  late final BackfillRunner runner;
  late final PendingRecoveryStore pending;

  void _build(List<String> capabilities) {
    transport = _StartRecordingTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder(), spill: spill),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    session.reconnect
        .noteServerCapabilities(<String, Object?>{'capabilities': capabilities});
    timeline = newTestStore();
    runner = BackfillRunner(
      session: session,
      store: timeline,
      sleep: (Duration _) async {},
      // The engine in this rig never answers, so every attempt ends on the
      // no-progress / total-budget clocks. Shrunk to milliseconds because the
      // subject here is WHAT WAS SENT and what happened to the bytes, not how
      // long the product waits — the production values are pinned by
      // `recovery_queue_core_test.dart`, and leaving them at two minutes here
      // would add half a minute of dead wall clock per case.
      recoveryTimeouts: const RecoveryTimeouts(
        uploadProgress: Duration(milliseconds: 200),
        engineProgress: Duration(milliseconds: 200),
        noProgress: Duration(milliseconds: 200),
        totalBudgetBase: Duration(milliseconds: 400),
        totalBudgetPerAudioMinute: Duration.zero,
      ),
    );
    pending = PendingRecoveryStore(runner: runner, sourceLang: () => 'zh');
    transport.pushStatus(SocketStatus.connected);
  }

  Future<void> writeJournal({
    required String id,
    required int bytes,
    bool cancelled = false,
  }) async {
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
      dirPath: tmp.path,
      recordingId: id,
      configSnapshot: const <String, Object?>{
        kConfigSnapshotMode: 'realtime',
        kConfigSnapshotSourceLang: 'zh',
        kConfigSnapshotPrefsDigest: '',
      },
      commitInterval: const Duration(days: 1),
    );
    await j.appendPcm(Uint8List(bytes));
    if (cancelled) j.markCancelled();
    await j.close();
  }

  /// Spend the automatic budget the way five failed attempts would, so a case
  /// can start from the state card RC-1b exists for.
  Future<void> exhaustAutoBudget(String id) async {
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
      dirPath: tmp.path,
      recordingId: id,
      commitInterval: const Duration(days: 1),
    );
    for (int i = 0; i < kRecoveryMaxAutoAttempts; i++) {
      j.addAttempt(JournalAttempt(
        attemptId: 'a$i',
        startedAtMs: i,
        kind: RecoveryAttemptKind.autoRetry.wire,
      ));
      j.closeAttempt('a$i', outcome: JournalAttempt.outcomeFailed);
    }
    j.setRecoveryState(RecoveryQueueState.needsManual);
    await j.commit();
    await j.close();
  }

  String pathOf(String name) => '${tmp.path}${Platform.pathSeparator}$name';

  Future<void> dispose() async {
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 10));
    while (runner.isBusy && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    runner.dispose();
    timeline.dispose();
    await session.dispose();
    await spill.dispose();
    await store.dispose();
    await removeTempDir(tmp);
  }
}

void main() {
  group('the list', () {
    test('a journal recording whose budget is spent reads as needs-manual',
        () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-1', bytes: kBytesPerSecond * 2);
      await rig.exhaustAutoBudget('rec-1');

      final List<PendingRecoveryItem> rows = await rig.pending.list();

      expect(rows, hasLength(1));
      expect(rows.single.id, 'rec-1');
      expect(rows.single.state, PendingRecoveryState.needsManual);
      expect(rows.single.legacy, isFalse);
      // Measured from the verified recoverable range and the recording's own
      // format, never from a constant in the copy.
      expect(rows.single.durationMs, 2000);
      expect(rows.single.actions,
          contains(PendingRecoveryAction.retryNow));
    });

    test('🔴 a cancelled recording is listed — O-5 needs somewhere to delete it',
        () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(
          id: 'rec-x', bytes: kBytesPerSecond, cancelled: true);

      final List<PendingRecoveryItem> rows = await rig.pending.list();

      expect(rows.single.state, PendingRecoveryState.cancelled);
      expect(rows.single.actions,
          <PendingRecoveryAction>{PendingRecoveryAction.delete},
          reason: 'the recovery leg must never feed it back, and the user is '
              'the only one who may remove it');
    });

    test('an unknown server puts every recording in the tier-C sentence',
        () async {
      final _Rig rig = await _Rig.open(capabilities: const <String>[]);
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-c', bytes: kBytesPerSecond);
      await rig.runner.sweep(sourceLang: 'zh');

      final List<PendingRecoveryItem> rows = await rig.pending.list();

      expect(rows.single.state, PendingRecoveryState.serverUnsupported);
      expect(rows.single.actions.contains(PendingRecoveryAction.retryNow),
          isFalse);
      expect(rig.transport.starts, isEmpty, reason: 'zero audio:start on C');
      expect(File(rig.pathOf('rec-c.pcm')).lengthSync(), kBytesPerSecond,
          reason: 'zero deletes on C');
    });

    test('legacy segment audio is listed too, and offers no retry', () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      rig.store.beginSession('run-1757000000000000');
      await rig.store.append(
          segmentIdx: 0, bytes: Uint8List(kBytesPerSecond));
      rig.store.endSession();

      final List<PendingRecoveryItem> rows = await rig.pending.list();

      expect(rows, hasLength(1));
      expect(rows.single.legacy, isTrue);
      expect(rows.single.state, PendingRecoveryState.waitingAuto);
      expect(rows.single.durationMs, 1000);
      expect(rows.single.actions,
          <PendingRecoveryAction>{PendingRecoveryAction.delete});
    });
  });

  group('retry now', () {
    test('🔴 mints a NEW attempt stamped user_retranscribe on the wire',
        () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-2', bytes: 6400 * 2);
      await rig.exhaustAutoBudget('rec-2');

      // The automatic route refuses it — that is the whole premise of the card.
      await rig.runner.sweep(sourceLang: 'zh');
      expect(rig.transport.starts, isEmpty,
          reason: 'the budget is spent; only a person moves this now');

      final PendingRecoveryItem item = (await rig.pending.list()).single;
      await rig.pending.retryNow(item);

      expect(rig.transport.starts, hasLength(1));
      final Map<String, Object?> start = rig.transport.starts.single;
      expect(start['attempt_kind'], 'user_retranscribe');
      expect(start['recording_id'], 'rec-2');
      expect(start['attempt_id'], isA<String>());
      expect(start['operation_id'], isA<String>());
      // 🔴 `job_id` IS ASSERTED ON THE FRAME, not on the identity object. It is
      // the only end of `deriveJobId` that anything outside this phone reads,
      // and a grep for that function finds only tests - so without this line
      // the whole derivation looks like dead code to the next reviewer, and a
      // change that stopped putting it on the wire would pass everything.
      expect(start['job_id'], isA<String>());
      expect((start['job_id']! as String).length, 32,
          reason: 'the §A6-1 ② format: 32 hex characters of sha256, stable '
              'across runs so a resumed job is the SAME job');
      // 🔴 The red line the whole recovery leg hangs on: recovered speech has
      // nowhere to be delivered, and a user's own retry does not change that
      // (owner ruling O-8 — there is no send entry anywhere on this screen).
      expect(start['delivery'], 'none');
    });

    test('🔴 a user attempt does not spend the automatic budget', () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-3', bytes: 6400);
      await rig.exhaustAutoBudget('rec-3');

      final PendingRecoveryItem item = (await rig.pending.list()).single;
      await rig.pending.retryNow(item);

      final List<RecordingScan> scans =
          await RetainedAudioJournalScan.scan(dirPath: rig.tmp.path);
      final RecordingManifest m = scans.single.manifest!;
      final RecoveryJobStatus status = RecoveryJobStatus.fromManifest(m);
      expect(status.failedAutoAttempts, kRecoveryMaxAutoAttempts,
          reason: 'the user press is recorded as history but counted by '
              'nothing — a ceiling that counted it would take away the one '
              'route the ruling left');
      expect(m.attempts.where((JournalAttempt a) =>
              a.kind == RecoveryAttemptKind.userRetranscribe.wire),
          hasLength(1));
      expect(status.state, RecoveryQueueState.needsManual);
    });

    test('🔴 refused while a press holds the microphone, and nothing is sent',
        () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-4', bytes: 6400);
      await rig.exhaustAutoBudget('rec-4');
      final PendingRecoveryItem item = (await rig.pending.list()).single;

      // The real gate, not a flag this test set: the FSM is in RECORDING and
      // `PttSession.beginBackfill` is what says no.
      rig.session.fsm.onPttDown();
      expect(rig.runner.recordingNow, isTrue);

      final PendingRetryOutcome outcome = await rig.pending.retryNow(item);

      expect(outcome, PendingRetryOutcome.refusedBusy);
      expect(rig.transport.starts, isEmpty);
      expect(File(rig.pathOf('rec-4.pcm')).existsSync(), isTrue);
    });

    test('🔴 refused on an unknown server, before anything reaches the wire',
        () async {
      final _Rig rig = await _Rig.open(capabilities: const <String>[]);
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-5', bytes: 6400);
      final PendingRecoveryItem item = (await rig.pending.list()).single;

      final PendingRetryOutcome outcome = await rig.pending.retryNow(item);

      expect(outcome, PendingRetryOutcome.refusedServer);
      expect(rig.transport.starts, isEmpty);
    });

    test('a legacy session has no per-recording entry and says so', () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      rig.store.beginSession('run-1757000000000001');
      await rig.store.append(segmentIdx: 0, bytes: Uint8List(6400));
      rig.store.endSession();
      final PendingRecoveryItem item = (await rig.pending.list()).single;

      expect(await rig.pending.retryNow(item), PendingRetryOutcome.unavailable);
      expect(rig.transport.starts, isEmpty,
          reason: 'a press on THIS card must never transcribe some other '
              'recording');
    });
  });

  group('delete', () {
    test('🔴 a journal recording loses its bytes AND its manifest', () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-6', bytes: kBytesPerSecond);
      expect(File(rig.pathOf('rec-6.pcm')).existsSync(), isTrue);
      expect(File(rig.pathOf('rec-6.manifest.json')).existsSync(), isTrue);

      final PendingRecoveryItem item = (await rig.pending.list()).single;
      await rig.pending.delete(item);

      expect(File(rig.pathOf('rec-6.pcm')).existsSync(), isFalse);
      expect(File(rig.pathOf('rec-6.manifest.json')).existsSync(), isFalse);
      expect(await rig.pending.list(), isEmpty,
          reason: 'the card has to disappear — a delete the list still shows '
              'reads as a delete that failed');
    });

    test('🔴 cancelled audio is exactly what this delete is for (O-5)',
        () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(
          id: 'rec-7', bytes: kBytesPerSecond, cancelled: true);

      final PendingRecoveryItem item = (await rig.pending.list()).single;
      expect(item.state, PendingRecoveryState.cancelled);
      await rig.pending.delete(item);

      expect(File(rig.pathOf('rec-7.pcm')).existsSync(), isFalse);
      expect(await rig.pending.list(), isEmpty);
    });

    test('🔴 a legacy session gets a tombstone AND loses its segments',
        () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      rig.store.beginSession('run-1757000000000002');
      await rig.store.append(segmentIdx: 0, bytes: Uint8List(6400));
      await rig.store.append(segmentIdx: 1, bytes: Uint8List(6400));
      rig.store.endSession();

      final PendingRecoveryItem item = (await rig.pending.list()).single;
      await rig.pending.delete(item);

      expect(await rig.store.tombstonedSessions(),
          contains('run-1757000000000002'),
          reason: 'written FIRST: a crash mid-delete must leave a session that '
              'is inert, not one the next sweep transcribes');
      expect(await rig.store.pendingSegments(session: 'run-1757000000000002'),
          isEmpty);
      expect(await rig.pending.list(), isEmpty);
    });
  });

  // ── Z7 / audit A5-3 vs A7-3 tier B ───────────────────────────────────────
  //
  // One queue state, two facts. `settled_unverified` is written both when the
  // coverage receipt was missing or short AND when every condition passed and
  // only the server tier withheld the delete. They had one sentence, and it
  // was the wrong one for the second: it told a user their transcription might
  // be incomplete when the receipt said it was.
  group('why the bytes were kept decides which sentence is shown', () {
    Future<void> settleUnverified(_Rig rig, String id, String code) async {
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: rig.tmp.path,
        recordingId: id,
        commitInterval: const Duration(days: 1),
      );
      j.addAttempt(JournalAttempt(
        attemptId: 'a0',
        startedAtMs: 0,
        kind: RecoveryAttemptKind.autoRetry.wire,
      ));
      j.closeAttempt('a0',
          outcome: JournalAttempt.outcomeSettledUnverified, failureCode: code);
      j.setRecoveryState(RecoveryQueueState.settledUnverified);
      await j.commit();
      await j.close();
    }

    test('🔴 tier B alone reads as 「kept anyway」, not 「we could not confirm」',
        () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-b', bytes: kBytesPerSecond);
      // The reason code the settle really writes for this case: the refusal
      // list is collected, not short-circuited, so a lone tier-B refusal is
      // exactly one name.
      await settleUnverified(
          rig, 'rec-b', RecoverySettleRefusal.serverTierKeepsBytes.name);

      final PendingRecoveryItem item = (await rig.pending.list()).single;
      expect(item.state, PendingRecoveryState.settledServerKeepsAudio,
          reason: 'every condition passed; the receipt was complete and only '
              'the server version withheld the delete');
      expect(item.actions,
          <PendingRecoveryAction>{PendingRecoveryAction.delete});
    });

    test('a receipt that really was incomplete keeps the unverified sentence',
        () async {
      // The control: without it the routing above could just be returning the
      // new state for every settled-unverified recording.
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-u', bytes: kBytesPerSecond);
      await settleUnverified(
          rig, 'rec-u', RecoverySettleRefusal.noReceipt.name);

      expect((await rig.pending.list()).single.state,
          PendingRecoveryState.settledUnverified);
    });

    test('tier B PLUS a real receipt problem is still 「we could not confirm」',
        () async {
      // Both refusals present ⇒ completeness genuinely is unknown, and the
      // tier is not the only thing standing in the way. The joined reason code
      // is what carries that, which is why this reads the whole string rather
      // than searching it.
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-both', bytes: kBytesPerSecond);
      await settleUnverified(
          rig,
          'rec-both',
          '${RecoverySettleRefusal.gapsOrDrops.name}+'
              '${RecoverySettleRefusal.serverTierKeepsBytes.name}');

      expect((await rig.pending.list()).single.state,
          PendingRecoveryState.settledUnverified);
    });
  });

  // ── Card WB-6 / audit A5-4, the second time ──────────────────────────────
  //
  // An empty result offers the button because a retry can legitimately fix it.
  // When the USER has taken that offer and the engine answered with nothing
  // again, the offer stops being honest: nothing is scheduled, the automatic
  // route is permanently closed for every settled state, and the card was
  // repeating an invitation we had measured twice to change nothing. What
  // carries the fact across a restart is the attempt history, which is what
  // these two cases read.
  group('an empty result the user has already retried is the end of the road',
      () {
    Future<void> settleEmpty(_Rig rig, String id, RecoveryAttemptKind kind)
        async {
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: rig.tmp.path,
        recordingId: id,
        commitInterval: const Duration(days: 1),
      );
      j.addAttempt(JournalAttempt(
        attemptId: 'a0',
        startedAtMs: 0,
        kind: kind.wire,
      ));
      j.closeAttempt('a0',
          outcome: JournalAttempt.outcomeSettledUnverified,
          failureCode: RecoverySettleRefusal.emptyResult.name);
      j.setRecoveryState(RecoveryQueueState.settledUnverified);
      await j.commit();
      await j.close();
    }

    test('an AUTOMATIC attempt that came back empty still offers the button',
        () async {
      // The control. Without it, the case below could simply be returning the
      // terminal state for every empty result, which would take away the one
      // route §A6 R-2 exists to provide.
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-auto-empty', bytes: kBytesPerSecond);
      await settleEmpty(rig, 'rec-auto-empty', RecoveryAttemptKind.autoRetry);

      final PendingRecoveryItem item = (await rig.pending.list()).single;
      expect(item.state, PendingRecoveryState.emptyResult);
      expect(item.actions.contains(PendingRecoveryAction.retryNow), isTrue);
      expect(item.awaitingTranscription, isTrue);
    });

    test('🔴 the user pressing it and getting nothing back closes it',
        () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-user-empty', bytes: kBytesPerSecond);
      await settleEmpty(
          rig, 'rec-user-empty', RecoveryAttemptKind.userRetranscribe);

      final PendingRecoveryItem item = (await rig.pending.list()).single;
      expect(item.state, PendingRecoveryState.emptyConfirmed);
      expect(item.actions,
          <PendingRecoveryAction>{PendingRecoveryAction.delete},
          reason: 'the bytes stay and the user may remove them (O-2 / O-5); '
              'what ends is the promise that something is still going to '
              'happen to them');
      expect(item.awaitingTranscription, isFalse,
          reason: 'so the door on the light-record screen stops counting it '
              'among the recordings that are waiting');
    });
  });

  group('a delete that lands while an attempt is running', () {
    test('🔴 the leg does not resurrect the manifest of a deleted recording',
        () async {
      // The race the screen used to allow: Retry is pressed, the leg opens a
      // journal handle, and the audio is deleted underneath it. Every write in
      // `_finish` would then commit through that still-valid handle and
      // RECREATE the manifest — the scan would list the recording again, with
      // its claim ahead of an absent file, and the delete would look as if it
      // had silently failed.
      final PosixUnlinkFs fs = PosixUnlinkFs();
      final _Rig rig = await _Rig.open(journalFs: fs);
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-race', bytes: 6400);
      final PendingRecoveryItem item = (await rig.pending.list()).single;

      final Future<PendingRetryOutcome> attempt = rig.pending.retryNow(item);
      // Deleted through the store, which is what the leg cannot see: another
      // object, another handle, while this attempt is on the wire.
      //
      // 🔴 ON THE WIRE IS A FACT, AND IT USED TO BE A STOPWATCH (fixed
      // 2026-09-12). This line was `await Future.delayed(10 ms)`, and 10 ms is
      // not a description of anything — it is a bet about how long
      // `retryNow` takes to get from the button to `audio:start`. The leg does
      // real work first (it SCANS the directory before it dials), so on a
      // loaded box the 10 ms expired mid-scan and the delete landed there
      // instead. MEASURED on dev-pc-a, 2026-09-12: the
      // `rec-race.manifest.json` assertion below went `Expected: false
      // Actual: <true>` — the manifest was back — twice during a cold cargo
      // build, and once in 15 runs under a 48-worker CPU hog with this
      // stopwatch put back deliberately. (No line number here on purpose:
      // this file moves, and a coordinate in a comment rots silently.)
      //
      // ⚠️ AND THE THING IT HIT THERE IS REAL, SO IT IS WRITTEN DOWN RATHER
      // THAN WAITED OUT. A file-level probe on the failing run showed the
      // resurrecting write was NEITHER `RetainedAudioJournal._commitLocked`
      // (both of its `deleted` guards were silent — it never ran) NOR
      // `publishManifest` (it returns early when the PCM is gone, and the PCM
      // was already marked by then). By elimination it is
      // `RetainedAudioJournalScan._publishManifest`, which republishes a
      // `claimAheadOfObserved`-marked manifest with NO `DeletedRecordings`
      // guard and no post-write undo — a fourth check-then-write door of the
      // RF-2 family, in the scan rather than in the leg. That is a DIFFERENT
      // case from this one, and it now has one of its own: 「a delete that
      // lands inside the recovery SCAN」 at the end of this group, which pins
      // that door deterministically instead of waiting for a loaded machine to
      // find it. This test never claimed the scan: its own sentence is 「the leg
      // opens a journal handle, and the audio is deleted underneath it」.
      //
      // So: wait for the leg to actually reach the wire, then delete. The
      // interleaving is now the same one on every machine, and the ceiling is a
      // liveness bound — nothing is concluded from reaching it.
      await rig.transport.onWire.timeout(const Duration(seconds: 30));
      expect(await rig.pending.delete(item), PendingDeleteOutcome.done,
          reason: 'positive control: the delete itself worked, and it ran while '
              'the attempt was demonstrably on the wire');
      await attempt;
      while (rig.runner.isBusy) {
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }

      expect(await fs.exists(rig.pathOf('rec-race.pcm')), isFalse);
      expect(await fs.exists(rig.pathOf('rec-race.manifest.json')), isFalse,
          reason: 'the settle (or the closing commit) wrote an outcome onto a '
              'recording that no longer exists, and the manifest came back '
              'with it');
      expect(await rig.pending.list(), isEmpty,
          reason: 'the card must stay gone — a row that reappears after a '
              'confirmed delete reads as a delete that failed');
    });

    test('🔴 and it holds wherever in the attempt the delete lands',
        () async {
      // 🔴 THE CASE ABOVE PINS ONE INSTANT (10 ms in) AND THAT IS WHY IT
      // WENT GREEN WHILE THE DEFECT WAS ALIVE. The leg writes at several
      // points — the `commit()` that records the attempt, the settle's
      // commits, and the commit `close()` performs on its way out — and each
      // was guarded by its own `await _fs.exists(...)` immediately before it.
      // Every one of those is a check-then-write: the delete only has to land
      // inside one of the windows BETWEEN a check and its write. On a loaded
      // machine it did, once, and the file reported
      // `Expected: false  Actual: <true>` — the manifest was back
      // (gate 0 of the 0.3.75 relay deploy, 2026-09-07).
      //
      // So this sweeps the delete across the whole attempt instead of picking
      // a number. 30 passes, 12 ms apart, against a total budget of 400 ms.
      //
      // ⚠️ MEASURED, AND THE HONEST READING IS THAT IT IS NOT ENOUGH: with
      // the RF-2 fix removed entirely, this sweep was still 30/30 GREEN on an
      // idle machine. A wall-clock delay cannot reliably land inside a window
      // that is microseconds wide. It is kept because it covers the ordinary
      // interleavings cheaply; the case BELOW is the one that actually pins
      // the defect, and its reverse control is the one that went red.
      final PosixUnlinkFs fs = PosixUnlinkFs();
      final _Rig rig = await _Rig.open(journalFs: fs);
      addTearDown(rig.dispose);

      for (int pass = 0; pass < 30; pass++) {
        final String id = 'rec-sweep-$pass';
        await rig.writeJournal(id: id, bytes: 6400);
        final PendingRecoveryItem item =
            (await rig.pending.list()).firstWhere((PendingRecoveryItem i) => i.id == id);

        final Future<PendingRetryOutcome> attempt = rig.pending.retryNow(item);
        await Future<void>.delayed(Duration(milliseconds: pass * 12));
        expect(await rig.pending.delete(item), PendingDeleteOutcome.done,
            reason: 'positive control (pass $pass): the delete itself worked');
        await attempt;
        while (rig.runner.isBusy) {
          await Future<void>.delayed(const Duration(milliseconds: 5));
        }

        expect(await fs.exists(rig.pathOf('$id.pcm')), isFalse,
            reason: 'pass $pass');
        expect(await fs.exists(rig.pathOf('$id.manifest.json')), isFalse,
            reason: 'pass $pass: a write in flight put the manifest of a '
                'deleted recording back');
        expect(await rig.pending.list(), isEmpty, reason: 'pass $pass');
      }
    }, timeout: const Timeout(Duration(seconds: 90)));

    test('🔴 a delete that lands between the check and the write it guards',
        () async {
      // THE INTERLEAVING THE OTHER TWO CASES CANNOT REACH. See
      // [DeleteAtWriteFs]: the delete runs inside the leg's own publish, i.e.
      // after `await _fs.exists(<manifest>)` said the recording was still
      // there. That is the shape gate 0 hit once on a loaded machine, and no
      // number of extra existence checks can close it — only a fact that is
      // true from the moment the delete BEGINS.
      //
      // TWO REVERSE CONTROLS, BOTH REALLY RUN 2026-09-07 — the fix has two
      // halves and each one alone is not enough:
      //   (a) remove `spill.deletedRecordings.mark(recordingId);` from
      //       `PendingRecoveryStore._deleteJournal` ⇒
      //       `Expected: false  Actual: <true>`;
      //   (b) keep the mark but remove the post-rename undo from
      //       `RetainedAudioJournal._commitLocked` ⇒ the same failure. The
      //       pre-check inside `_commitLocked` cannot catch this one either:
      //       the delete lands after IT has run too.
      // Both restored; green again.
      final DeleteAtWriteFs fs = DeleteAtWriteFs();
      final _Rig rig = await _Rig.open(journalFs: fs);
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-mid', bytes: 6400);
      final PendingRecoveryItem item = (await rig.pending.list()).single;

      PendingDeleteOutcome? deleted;
      fs.onManifestWrite = () async {
        deleted = await rig.pending.delete(item);
      };
      await rig.pending.retryNow(item);
      while (rig.runner.isBusy) {
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }

      expect(deleted, PendingDeleteOutcome.done,
          reason: 'positive control: the hook really did fire and the delete '
              'really did run inside the leg');
      expect(await fs.exists(rig.pathOf('rec-mid.pcm')), isFalse);
      expect(await fs.exists(rig.pathOf('rec-mid.manifest.json')), isFalse,
          reason: 'a write that was already past its guard put the manifest of '
              'a deleted recording back on disk');
      expect(await rig.pending.list(), isEmpty);
    });

    test('🔴 a delete that lands inside the recovery SCAN', () async {
      // THE FOURTH DOOR OF THE RF-2 FAMILY, AND THE ONLY ONE THAT IS NOT IN A
      // WRITER. `RetainedAudioJournalScan` is documented as a reader, so it was
      // not counted when the registry was introduced — but it performs one
      // write: a manifest whose claim ran ahead of its file gets a
      // `claimAheadOfObservedAt` marker republished onto it, through the same
      // temp-file-and-rename as every other publish.
      //
      // 🔴 IT IS ALSO THE DOOR THE USER IS MOST LIKELY TO WALK THROUGH, which
      // is why the leg case above kept hitting it by accident: pressing Retry
      // SCANS the directory before it dials, and the pending screen scans on
      // every `list()`. The delete-while-a-retry-is-starting interleaving lands
      // here, not in the leg's own writes.
      //
      // ⚠️ NO CLOCK ANYWHERE IN THIS CASE. The other two cases in this group
      // bet on wall-clock offsets, and the sweep one is honest that with the
      // fix removed it was still 30/30 green on an idle machine — a delay
      // cannot reliably land inside a window that is microseconds wide. Here
      // the filesystem seam opens the window on demand and a Completer carries
      // the outcome back out, so the interleaving is identical on every machine
      // and nothing is concluded from a duration.
      //
      // REVERSE CONTROL, REALLY RUN 2026-09-12 — both halves, one at a time:
      //   (a) remove the pre-check from `RetainedAudioJournalScan
      //       ._publishManifest` only ⇒ still GREEN. Written down rather than
      //       quietly omitted: this case does not pin that half, and no case
      //       does. The pre-check is not a second defence, it answers the
      //       EARLIER question (the mark was already standing when the scan
      //       reached the write, so there is nothing to publish and nothing to
      //       take back) and keeps the three manifest writers reading alike;
      //   (b) remove the post-write undo ⇒ `Expected: false  Actual: <true>`
      //       on the manifest, and the card is back in `list()` with no audio
      //       behind it. That is the defect, and it is the half this case pins.
      final DeleteAtWriteFs fs = DeleteAtWriteFs();
      final _Rig rig = await _Rig.open(journalFs: fs);
      addTearDown(rig.dispose);

      // A manifest whose claim outruns its file is what makes the scan write at
      // all. Built the way a crash does it: commit the claim, then leave less
      // on disk than was claimed. NOT `settled`, so this is the §A3-8
      // commit-order violation and not card LS-1b's benign released-bytes case.
      await rig.writeJournal(id: 'rec-scan', bytes: kBytesPerSecond);
      await File(rig.pathOf('rec-scan.pcm'))
          .writeAsBytes(Uint8List(kBytesPerSecond ~/ 2), flush: true);

      final PendingRecoveryItem item = (await rig.pending.list()).single;
      expect(item.id, 'rec-scan',
          reason: 'positive control: the claim-ahead recording is listed, so '
              'the scan really did take the branch that publishes a marker');

      // The delete runs INSIDE the scan's own publish, after it decided to
      // write and before the write lands — the window no extra check can close.
      final Completer<PendingDeleteOutcome> deletedMidWrite =
          Completer<PendingDeleteOutcome>();
      fs.onManifestWrite = () async {
        deletedMidWrite.complete(await rig.pending.delete(item));
      };
      await rig.pending.list();

      expect(await deletedMidWrite.future, PendingDeleteOutcome.done,
          reason: 'positive control: the hook really did fire inside the scan '
              'and the delete really did run there');
      expect(await fs.exists(rig.pathOf('rec-scan.pcm')), isFalse);
      expect(await fs.exists(rig.pathOf('rec-scan.manifest.json')), isFalse,
          reason: 'the scan republished the marker onto a recording the user '
              'had just deleted, and the manifest came back with it');
      expect(await rig.pending.list(), isEmpty,
          reason: 'and that manifest is what the next scan reads: the card '
              'returns with no audio behind it, which reads as a delete that '
              'silently failed');
    });

    test('🔴 a delete that lands inside the manifest REPUBLISH QUEUE', () async {
      // THE FIFTH DOOR, AND THE ONE WITH THE LONGEST FUSE.
      // `ManifestRepublishQueue` holds a manifest whose publish threw and
      // retries it at the START and the END of every later recording,
      // UNAWAITED. Its guard was a lone `fs.exists(<pcm>)` inside
      // `publishManifest` - a check-then-write, with no registry and no undo -
      // so a delete arriving after that check republished the manifest of a
      // recording the user had just removed. The card then returns to the
      // pending list with no audio behind it, which is what a delete that
      // silently failed looks like.
      //
      // 🔴 WHY IT SURVIVED FOUR PASSES OVER THIS FAMILY. The comment on the
      // leg case above eliminated `publishManifest` by reasoning - 「it returns
      // early when the PCM is gone」 - and that sentence is true of the instant
      // it was asked about and false of the instant that matters. Reaching
      // this writer at all needs a FAILED COMMIT first, which no other case in
      // this file produces, so nothing was ever driven through it.
      //
      // ⚠️ NO CLOCK IN THIS CASE EITHER. The disk is full on demand and the
      // delete runs inside the retry's own write, so the interleaving is
      // identical on every machine.
      //
      // REVERSE CONTROL, REALLY RUN 2026-09-12 - the current guard pasted back
      // (`if (!await fs.exists('$base.pcm')) return;` and nothing else):
      //   `Expected: false  Actual: <true>` on `<id>.manifest.json`, with the
      //   card back in `list()`. Restored; green again.
      // And, one at a time on top of the fix:
      //   (a) pre-check only removed  => still GREEN. Written down rather than
      //       quietly omitted: this case does not pin that half. The pre-check
      //       answers the EARLIER question (the mark was already standing when
      //       the retry reached the write) and keeps all three manifest writers
      //       reading alike;
      //   (b) post-rename undo only removed => `Expected: false Actual: <true>`
      //       again. That is the half this case pins.
      final EnospcThenDeleteAtWriteFs fs = EnospcThenDeleteAtWriteFs();
      final _Rig rig = await _Rig.open(journalFs: fs);
      addTearDown(rig.dispose);

      // A real recording through the production spill, because the queue is
      // only reachable that way: one healthy commit, then the disk fills.
      await rig.spill.beginRecording();
      final String id = rig.spill.currentRecordingId!;
      rig.spill.appendCaptured(Uint8List(kBytesPerSecond));
      await rig.spill.journalFlush();
      expect(await fs.exists(rig.pathOf('$id.manifest.json')), isTrue,
          reason: 'positive control: the healthy commit landed, so the failure '
              'below is the disk and not the rig');

      fs.blockManifestWrites = true;
      rig.spill.appendCaptured(Uint8List(kBytesPerSecond));
      await rig.spill.journalFlush();
      await rig.spill.endRecording(interruptReason: JournalInterrupt.ioError);

      expect(await rig.spill.republishPendingManifests(), 0,
          reason: 'still full: nothing can land yet');
      expect(rig.spill.unpublishedManifestIds, <String>[id],
          reason: 'positive control: the manifest really is queued, so the '
              'retry below is the production path and not a no-op');

      // Space came back. The delete runs INSIDE the retry's own write.
      fs.blockManifestWrites = false;
      final PendingRecoveryItem item = (await rig.pending.list())
          .firstWhere((PendingRecoveryItem i) => i.id == id);
      final Completer<PendingDeleteOutcome> deletedMidWrite =
          Completer<PendingDeleteOutcome>();
      fs.onManifestWrite = () async {
        deletedMidWrite.complete(await rig.pending.delete(item));
      };
      await rig.spill.republishPendingManifests();

      expect(await deletedMidWrite.future, PendingDeleteOutcome.done,
          reason: 'positive control: the hook really did fire inside the retry '
              'and the delete really did run there');
      expect(await fs.exists(rig.pathOf('$id.pcm')), isFalse);
      expect(await fs.exists(rig.pathOf('$id.manifest.json')), isFalse,
          reason: 'the republish queue put the manifest of a deleted recording '
              'back on disk');
      expect(await rig.pending.list(), isEmpty,
          reason: 'the card must stay gone - a row that reappears after a '
              'confirmed delete reads as a delete that failed');
      expect(rig.spill.unpublishedManifestIds, isEmpty,
          reason: 'and the entry is dropped rather than retried forever: the '
              'recording it describes will never exist again');
    });
  });

  // ── Z1 / owner ruling O-2 ────────────────────────────────────────────────
  //
  // 「Unrecovered audio counts against the cap」 has a corollary the code did
  // not have: audio that counts against the cap must be nameable and
  // removable. Both cases below were previously invisible — the first because
  // the list skipped it, the second because the delete manufactured it.
  group('audio we cannot read is still audio (O-2)', () {
    test('🔴 an orphan PCM is LISTED, and the delete really removes it',
        () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      // A PCM with no manifest: a crash before the first commit, or a
      // pre-journal layout. The scan calls it `manifestMissing`; every reader
      // used to skip it, so it sat on the disk consuming the cap with nothing
      // on the device able to name it.
      await File(rig.pathOf('rec-orphan.pcm'))
          .writeAsBytes(Uint8List(kBytesPerSecond * 3));

      final List<PendingRecoveryItem> rows = await rig.pending.list();
      expect(rows, hasLength(1));
      expect(rows.single.state, PendingRecoveryState.unreadable);
      expect(rows.single.actions,
          <PendingRecoveryAction>{PendingRecoveryAction.delete},
          reason: 'there is no readable range and no format — a retry button '
              'would be refused on every press');
      expect(rows.single.durationMs, 3000,
          reason: 'the bytes on disk, so the card can answer 「how much space '
              'is this costing me」');

      expect(await rig.pending.delete(rows.single), PendingDeleteOutcome.done);
      expect(File(rig.pathOf('rec-orphan.pcm')).existsSync(), isFalse);
      expect(await rig.pending.list(), isEmpty);
    });

    test('🔴 a manifest whose bytes are GONE is listed, not skipped', () async {
      // MEASURED 2026-09-06 (drill B-1, second-run.manifest.json):
      // `committedClaimBytes` 1,318,400, `recoveryState` pending, `settled`
      // false — and NO pcm file. The scan reports `claimAheadOfObserved` with
      // an empty recoverable range, and an empty range was the one thing both
      // the list AND `RecoveryJournalLeg._scanCandidates` skipped, so the
      // manifest sat there naming a recording nothing could show or remove.
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-hollow', bytes: kBytesPerSecond * 2);
      File(rig.pathOf('rec-hollow.pcm')).deleteSync();

      final List<PendingRecoveryItem> rows = await rig.pending.list();
      expect(rows, hasLength(1),
          reason: 'invisible is the one thing it may not be (O-2)');
      expect(rows.single.id, 'rec-hollow');
      expect(rows.single.state, PendingRecoveryState.unreadable);
      expect(rows.single.actions,
          <PendingRecoveryAction>{PendingRecoveryAction.delete},
          reason: 'nothing can be fed back, so delete is the only honest '
              'offer — the same sentence an orphan PCM gets');

      expect(await rig.pending.delete(rows.single), PendingDeleteOutcome.done);
      expect(await rig.pending.list(), isEmpty);
    });

    test('🔴 a delete whose PCM refuses STOPS, keeps the manifest, and says '
        'failed', () async {
      final _RefusingDeleteFs fs = _RefusingDeleteFs('.pcm');
      final _Rig rig = await _Rig.open(journalFs: fs);
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-stuck', bytes: kBytesPerSecond);

      final PendingRecoveryItem item = (await rig.pending.list()).single;
      final PendingDeleteOutcome outcome = await rig.pending.delete(item);

      expect(outcome, PendingDeleteOutcome.failed);
      // 🔴 THE ASSERTION THAT MATTERS. The old code caught inside the loop and
      // went on to remove the manifest, which turned a recording the user
      // could see into an orphan PCM that `list()` and
      // `RecoveryJournalLeg._scanCandidates` both skip — invisible AND
      // undeletable, created by the button that was supposed to remove it.
      expect(File(rig.pathOf('rec-stuck.pcm')).existsSync(), isTrue);
      expect(File(rig.pathOf('rec-stuck.manifest.json')).existsSync(), isTrue,
          reason: 'the manifest is the only thing that keeps this recording '
              'nameable while its bytes are still here');
      expect(fs.deleted, isEmpty, reason: 'it stopped at the first failure');

      final List<PendingRecoveryItem> after = await rig.pending.list();
      expect(after, hasLength(1),
          reason: 'the card stays, so the next press tries the same file '
              'again — which is the whole point of stopping');
      expect(after.single.state, isNot(PendingRecoveryState.unreadable),
          reason: 'a failed delete must not downgrade a readable recording '
              'into an unreadable one');
    });
  });
}
