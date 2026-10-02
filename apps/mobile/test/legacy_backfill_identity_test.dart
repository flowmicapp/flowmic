// NR-138 ③ — WHAT A LEGACY SEGMENT START PUTS ON THE WIRE, AND WHEN IT MAY
// NOT SEND AT ALL. *** billing — reviewable in isolation ***
//
// The relay half is `apps/server-core/test/legacy-backfill-bills-once.test.ts`:
// a frame naming one derived `operation_id` is metered once per job. This file
// proves the phone actually sends that frame, through the production
// controller, and pins the SAME derivation vector the relay test pins.
//
// REVERSE CONTROLS (run 2026-10-01, red on this file, restored green, file
// hash identical after restore):
//   · the identity kept off the legacy frame (`ptt_backfill.dart`, the
//     pre-NR-138 wire) ⇒ 2 red (`recording_id` / `attempt_kind` null);
//   · the gate no longer refuses a metered relay without the idempotency bit
//     (`legacy_recovery_identity.dart`) ⇒ 2 red, the refusal case on the wire
//     (`Expected: empty`, an `audio:start` left the phone);
//   · the gate no longer waits for a capability ack ⇒ 2 red (a server
//     nobody heard from read as a verdict);
//   · every press reusing one operation id ⇒ the O-4 case red.

import 'package:flowmic/src/audio/retained_audio_store.dart'
    show LegacyRetryRecord;
import 'package:flowmic/src/session/instance_probe.dart' show ServerChannel;
import 'package:flowmic/src/session/legacy_recovery_identity.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/recovery_gate.dart';
import 'package:flowmic/src/session/recovery_identity.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/legacy_backfill_rig.dart';

const String kVectorJob = '505fb29f0fe8ac041f775a3af57d3638';
const String kVectorOp = 'o-a8f5706cb76a5d7de03311241d1e929c';

void main() {
  test('the derivation vector the relay test pins', () {
    final RecoveryIdentity id = legacySegmentIdentity(
      sessionKey: 'run-1757000000000000',
      segmentIdx: 0,
      pcmBytes: 6400,
      sourceLang: 'en',
      prefs: null,
      kind: RecoveryAttemptKind.autoRetry,
      attemptId: 'a-1',
    );
    expect(id.recordingId, 'run-1757000000000000__seg-0');
    expect(id.range, const RecoverySampleRange(0, 3200));
    expect(id.jobId, kVectorJob);
    expect(id.operationId, kVectorOp);
  });

  test('🔴 the legacy start carries the identity; a second automatic attempt '
      'reuses the operation, never the attempt', () async {
    final LegacyRig rig = await LegacyRig.open();
    addTearDown(rig.dispose);
    await rig.seed('run-1757000000000000');
    rig.relay.stallEveryStart = true;
    await rig.sweep();
    rig.relay.stallEveryStart = false;
    rig.nowMs += const Duration(minutes: 1).inMilliseconds;
    rig.relay.replyWords('Recovered words');
    await rig.sweep();

    expect(rig.relay.starts, hasLength(2));
    final Map<String, Object?> a = rig.relay.starts[0];
    final Map<String, Object?> b = rig.relay.starts[1];
    for (final Map<String, Object?> s in <Map<String, Object?>>[a, b]) {
      expect(s['recording_id'], 'run-1757000000000000__seg-0');
      expect(s['job_id'], kVectorJob);
      expect(s['operation_id'], kVectorOp);
      expect(s['attempt_kind'], 'auto_retry');
      expect(s['range_start_sample'], 0);
      expect(s['range_end_sample'], 3200);
      expect(s['audio_format_version'], 1);
      // The red line the recovery leg hangs on: recovered audio is never
      // delivered anywhere.
      expect(s['delivery'], 'none');
    }
    expect(a['attempt_id'], isNot(b['attempt_id']));
    expect(await rig.store.bytesForSession('run-1757000000000000'), 0,
        reason: 'positive control: the second attempt concluded and settled');
  });

  test('🔴 a metered relay without the idempotency bit gets no legacy start',
      () async {
    final LegacyRig rig = await LegacyRig.open(capabilities: const <String>[
      kCapabilityCoverageReceipt,
      kCapabilityDeliveryNoneSafe,
    ]);
    addTearDown(rig.dispose);
    await rig.seed('run-1757000000000001');
    rig.relay.replyWords('would be billed every time');
    await rig.sweep();

    expect(rig.relay.starts, isEmpty);
    expect(rig.runner.legacyGate, LegacyRecoveryGate.refused);
    expect(await rig.store.bytesForSession('run-1757000000000001'), 6400,
        reason: 'the audio stays');
    final PendingRecoveryItem item = (await rig.pending.list()).single;
    expect(item.state, PendingRecoveryState.serverUnsupported,
        reason: '「waiting」 would promise an attempt this server never gets');
    expect(item.actions, <PendingRecoveryAction>{PendingRecoveryAction.delete});
    expect(await rig.pending.retryNow(item), PendingRetryOutcome.refusedServer);
    expect(rig.relay.starts, isEmpty, reason: 'a press is refused too');
  });

  test('🔴 a Re-transcribe press is a NEW operation each time (O-4), never '
      'the automatic one', () async {
    final LegacyRig rig = await LegacyRig.open();
    addTearDown(rig.dispose);
    await rig.seed('run-1757000000000000');
    expect(await rig.store.writeLegacyRetry(
        'run-1757000000000000', const LegacyRetryRecord(starts: 5, failedStarts: 5)),
        isTrue);
    rig.relay.stallEveryStart = true;
    PendingRecoveryItem item() => const PendingRecoveryItem(
        id: 'run-1757000000000000',
        state: PendingRecoveryState.needsManual,
        durationMs: 200,
        legacy: true);
    expect(await rig.pending.retryNow(item()), PendingRetryOutcome.failed);
    expect(await rig.pending.retryNow(item()), PendingRetryOutcome.failed);

    expect(rig.relay.starts, hasLength(2));
    final Map<String, Object?> a = rig.relay.starts[0];
    final Map<String, Object?> b = rig.relay.starts[1];
    for (final Map<String, Object?> s in <Map<String, Object?>>[a, b]) {
      expect(s['attempt_kind'], 'user_retranscribe');
      expect(s['recording_id'], 'run-1757000000000000__seg-0');
      expect(s['job_id'], kVectorJob, reason: 'the same result, asked for again');
      expect(s['operation_id'], isNot(kVectorOp),
          reason: 'never the automatic job\'s operation (the relay would '
              'refuse the changed kind)');
      expect(s['delivery'], 'none');
    }
    expect(a['operation_id'], isNot(b['operation_id']),
        reason: 'two presses, two operations, two charges (owner ruling O-4)');
  });

  test('no capability ack yet ⇒ nothing is sent and nothing is written',
      () async {
    final LegacyRig rig = await LegacyRig.open(capabilities: null);
    addTearDown(rig.dispose);
    await rig.seed('run-1757000000000002');
    await rig.sweep();

    expect(rig.relay.starts, isEmpty);
    expect(rig.runner.legacyGate, LegacyRecoveryGate.undetermined);
    expect(rig.budgetFile('run-1757000000000002').existsSync(), isFalse);
  });

  test('a standalone LAN server needs no idempotency bit (nothing is billed)',
      () async {
    final LegacyRig rig = await LegacyRig.open(capabilities: const <String>[]);
    addTearDown(rig.dispose);
    rig.session.serverChannel.value = ServerChannel.lan;
    await rig.seed('run-1757000000000003');
    rig.relay.replyWords('LAN words');
    await rig.sweep();

    expect(rig.runner.legacyGate, LegacyRecoveryGate.open);
    expect(rig.relay.starts, hasLength(1));
    expect(await rig.store.bytesForSession('run-1757000000000003'), 0);
  });

  test('the gate reads the shared verdict, not a copy of its rules', () {
    RecoveryGateVerdict v({required bool ack, required bool metered,
            required bool idem}) =>
        RecoveryGateVerdict(
          tier: RecoveryTier.undetermined,
          capabilitiesKnown: ack,
          ackSeen: ack,
          coverageReceipt: false,
          deliveryNoneSafe: false,
          idempotentOperation: idem,
          metered: metered,
        );
    expect(legacyRecoveryGateOf(v(ack: false, metered: true, idem: true)),
        LegacyRecoveryGate.undetermined);
    expect(legacyRecoveryGateOf(v(ack: true, metered: true, idem: false)),
        LegacyRecoveryGate.refused);
    expect(legacyRecoveryGateOf(v(ack: true, metered: true, idem: true)),
        LegacyRecoveryGate.open);
    expect(legacyRecoveryGateOf(v(ack: true, metered: false, idem: false)),
        LegacyRecoveryGate.open);
  });
}
