// Card RC-R, phone side (MAIN ruling 3, option 甲, 2026-09-24) — every attempt
// at the same recovery job carries the same `operation_id`, so the relay's
// `meterOnce(user, operation_id, 'stt')` charges the job once.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §2.2, §8 RC-R, §11
//     ruling 3
//   apps/mobile/lib/src/session/recovery_identity.dart `deriveOperationId`
//     (the exact derivation the relay-side card is written against)
//
// MEASURED BEFORE THE CARD (CR-12-E re-run 3, S6): one 65.9 s owed stretch was
// billed 4 × 65.85 s, because every attempt minted `'o-${_newId()}'` and the
// relay's ledger keys on the operation.
//
// DRIVEN THROUGH PRODUCTION: the production `BackfillRunner` over a real temp
// directory; what is asserted is the `audio:start` frame that left the phone.
//
// REVERSE CONTROL (seen red while writing this file): put back
// `operationId: 'o-${_newId()}'` in `RecoveryJournalLeg._attempt` ⇒ the first
// case fails on `starts[1]['operation_id'], starts[0]['operation_id']`.
//
// FOLLOW-UP (MAIN, 2026-09-24): owner ruling O-4 wins for USER presses — each
// explicit re-transcription is billed as a new attempt, so each press gets a
// fresh id. REVERSE CONTROL (seen red): derive user presses too ⇒ the
// 「two user presses」 case fails on `isNot(starts[0]['operation_id'])`.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/backfill_runner.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/session/recovery_identity.dart';
import 'package:flowmic/src/session/recovery_leg_policy.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/temp_teardown.dart';

const int kBytesPerSecond = 32000;

const List<String> kTierA = <String>[
  kCapabilityCoverageReceipt,
  kCapabilityDeliveryNoneSafe,
  kCapabilityIdempotentOperation,
];

void main() {
  group('RC-R — the operation id is derived from the job', () {
    test(
        '🔴 two automatic attempts at one job send the same operation_id '
        '(and two different attempt_ids)', () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'run-op-r1757000000000000');

      await rig.runner.sweep(sourceLang: 'zh');
      await rig.releaseBackoff('run-op-r1757000000000000');
      await rig.runner.sweep(sourceLang: 'zh');

      final List<Map<String, Object?>> starts = rig.transport.starts;
      expect(starts, hasLength(2),
          reason: 'positive control: both attempts really went out');
      expect(starts[0]['job_id'], starts[1]['job_id']);
      expect(starts[0]['attempt_id'], isNot(starts[1]['attempt_id']),
          reason: 'each try is still its own attempt');
      expect(starts[1]['operation_id'], starts[0]['operation_id'],
          reason: 'the relay charges once per operation: a fresh one per '
              'attempt is what billed one stretch four times');
      // …and it is exactly the stated derivation, so the relay-side card and
      // this one agree on the value, not just on its stability.
      expect(
        starts[0]['operation_id'],
        deriveOperationId(
          jobId: starts[0]['job_id']! as String,
          attemptKind: RecoveryAttemptKind.autoRetry,
        ),
      );
    });

    test(
        '🔴 two user re-transcription presses on one job send two different '
        'operation_ids (owner ruling O-4)', () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'run-op-r1757000000000000');

      await rig.runner.retranscribe(
          recordingId: 'run-op-r1757000000000000', sourceLang: 'zh');
      await rig.runner.retranscribe(
          recordingId: 'run-op-r1757000000000000', sourceLang: 'zh');

      final List<Map<String, Object?>> starts = rig.transport.starts;
      expect(starts, hasLength(2),
          reason: 'positive control: both presses really went out');
      expect(starts[0]['attempt_kind'], 'user_retranscribe');
      expect(starts[1]['attempt_kind'], 'user_retranscribe');
      expect(starts[0]['job_id'], starts[1]['job_id'],
          reason: 'the same job — only the operation may differ');
      expect(starts[1]['operation_id'], isNot(starts[0]['operation_id']),
          reason: 'O-4: every explicit re-transcription is a new, billed '
              'attempt');
    });

    test('two different jobs send two different operation_ids', () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'run-op-r1757000000000000');
      await rig.writeJournal(id: 'run-op-r1757000001000000');

      await rig.runner.sweep(sourceLang: 'zh');
      // Each attempt fails and stops the sweep; release both and go again
      // until both recordings have had one.
      for (int i = 0; i < 3 && rig.startedRecordings.length < 2; i++) {
        await rig.releaseBackoff('run-op-r1757000000000000');
        await rig.releaseBackoff('run-op-r1757000001000000');
        await rig.runner.sweep(sourceLang: 'zh');
      }
      expect(rig.startedRecordings, hasLength(2));
      final Map<Object?, Object?> opByRecording = <Object?, Object?>{
        for (final Map<String, Object?> s in rig.transport.starts)
          s['recording_id']: s['operation_id'],
      };
      expect(opByRecording.values.toSet(), hasLength(2));
    });

    test('the derivation: stable, and it moves with the job, the kind and the '
        'conflict generation', () {
      const String job = 'job-1';
      final String a =
          deriveOperationId(jobId: job, attemptKind: RecoveryAttemptKind.autoRetry);
      expect(
          deriveOperationId(
              jobId: job, attemptKind: RecoveryAttemptKind.autoRetry),
          a);
      expect(a, startsWith('o-'));
      expect(a.length, 34);
      expect(
          deriveOperationId(
              jobId: 'job-2', attemptKind: RecoveryAttemptKind.autoRetry),
          isNot(a));
      // The relay binds attempt_kind into the operation: an automatic retry and
      // a user's re-transcription of one job must not share an id.
      expect(
          deriveOperationId(
              jobId: job, attemptKind: RecoveryAttemptKind.userRetranscribe),
          isNot(a));
      expect(
          deriveOperationId(
              jobId: job,
              attemptKind: RecoveryAttemptKind.autoRetry,
              generation: 1),
          isNot(a));
      expect(
          () => deriveOperationId(
              jobId: job, attemptKind: RecoveryAttemptKind.live),
          throwsArgumentError);
    });
  });
}

/// Records every `audio:start` and fails every attempt the way a relay whose
/// engine gave out does: an `stt:error` after the phone's `audio:stop`. The
/// error returns the session to idle, so the next attempt can start; its code
/// is deliberately NOT the binding conflict, so the generation stays 0.
class _StartRecordingTransport extends FakeSocketTransport {
  final List<Map<String, Object?>> starts = <Map<String, Object?>>[];

  @override
  void emit(String event, Object? payload) {
    super.emit(event, payload);
    if (event == FlowMicEvents.audioStart && payload is Map<String, Object?>) {
      starts.add(payload);
    }
    if (event == FlowMicEvents.audioStop) {
      pushIncoming(FlowMicEvents.sttError, <String, Object?>{
        'code': 'STT_NO_ENGINE_REACHED',
        'message': 'engine gave out',
        'retryable': false,
      });
    }
  }
}

class _Rig {
  _Rig._(this.tmp, this.store, this.spill);

  static Future<_Rig> open() async {
    final Directory tmp =
        await Directory.systemTemp.createTemp('flowmic-rc-r-');
    final RetainedAudioStore store =
        RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    final _Rig r = _Rig._(
      tmp,
      store,
      RetainedAudioSpill(store: store, retainFromFirstFrame: true),
    );
    r._build();
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

  Set<Object?> get startedRecordings => <Object?>{
        for (final Map<String, Object?> s in transport.starts)
          s['recording_id'],
      };

  void _build() {
    transport = _StartRecordingTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder(), spill: spill),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    session.reconnect
        .noteServerCapabilities(<String, Object?>{'capabilities': kTierA});
    timeline = newTestStore();
    runner = BackfillRunner(
      session: session,
      store: timeline,
      sleep: (Duration _) async {},
      recoveryTimeouts: const RecoveryTimeouts(
        uploadProgress: Duration(milliseconds: 200),
        engineProgress: Duration(milliseconds: 200),
        noProgress: Duration(milliseconds: 200),
        totalBudgetBase: Duration(milliseconds: 400),
        totalBudgetPerAudioMinute: Duration.zero,
      ),
    );
    transport.pushStatus(SocketStatus.connected);
  }

  Future<void> writeJournal({required String id}) async {
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
      dirPath: tmp.path,
      recordingId: id,
      configSnapshot: recordingConfigSnapshot(mode: 'realtime', sourceLang: 'zh'),
      commitInterval: const Duration(days: 1),
    );
    await j.appendPcm(Uint8List(kBytesPerSecond));
    await j.close(interruptReason: JournalInterrupt.linkLoss);
  }

  /// Clear the backoff a failed attempt set, so the next sweep is eligible.
  Future<void> releaseBackoff(String id) async {
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
      dirPath: tmp.path,
      recordingId: id,
      commitInterval: const Duration(days: 1),
    );
    j.setRecoveryState(RecoveryQueueState.pending, clearNextEligibleAt: true);
    await j.commit();
    await j.close();
  }

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
