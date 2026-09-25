// Card RC-P follow-up (integ merge 3, 2026-09-24) — a recovery pass held for a
// live terminal final records no attempt.
//
// SPEC-REF:
//   the RC3 phone A report (2026-09-24), "Merge notes for Phone B", item 1
//     (the empty attempt record)
//   apps/mobile/lib/src/session/recovery_journal_leg.dart `_attempt` (the check
//     before `addAttempt`)
//   apps/mobile/lib/src/session/recovery_leg_wire.dart `_runOnWire` (the
//     refusal that used to be the only one)
//
// BEFORE: `_runOnWire` refused a recording whose owed tail was still pending,
// but `_attempt` had already added and committed a `JournalAttempt`, so the
// manifest kept an attempt with no outcome.
//
// DRIVEN THROUGH PRODUCTION: the recording is made by the production spill and
// the sweep is the production `BackfillRunner` over a real temp directory. The
// pending tail is set on the session's real `ArticleScribe` with the call the
// capture pump uses (`holdOwedTail`). Only the socket and microphone are fakes.
//
// REVERSE CONTROL (seen red while writing this file): remove the check in
// `_attempt` ⇒ the held sweep still sends nothing, but the manifest carries one
// attempt and the first case fails on `m1.attempts, isEmpty`.

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
  test(
      '🔴 a held owed tail ⇒ the sweep sends nothing and records no attempt; '
      'once the tail resolves the same sweep runs and records one', () async {
    final HeldTailRig rig = await HeldTailRig.open();
    addTearDown(rig.dispose);

    final String id = await rig.recordThroughSpill(kBytesPerSecond);
    rig.session.articles.holdOwedTail(
      RetainedAudioSpill.sessionKeyOf(id),
      kBytesPerSecond ~/ 2,
      recordingId: id,
    );
    expect(
        rig.session.articles
            .owedTailPendingFor(RetainedAudioSpill.sessionKeyOf(id)),
        isTrue,
        reason: 'precondition: the tail is pending for this recording');

    await rig.runner.sweep(sourceLang: 'zh');
    expect(rig.transport.starts, isEmpty,
        reason: 'held for the live terminal final: nothing goes on the wire');
    final RecordingManifest m1 = await rig.readManifest(id);
    expect(m1.attempts, isEmpty,
        reason: 'a held pass is not an attempt: no record without an outcome');
    expect(m1.nextEligibleAtMs, isNull);
    expect(RecoveryQueueState.normalise(m1.recoveryState),
        RecoveryQueueState.pending);
    expect(rig.session.articles.attempts.hasHeldSweep, isTrue,
        reason: 'the pass is remembered so it runs when the final lands');

    // POSITIVE CONTROL: the same recording once the tail is placed.
    rig.session.articles.resolveOwedTail();
    await rig.runner.sweep(sourceLang: 'zh');
    expect(rig.transport.starts, hasLength(1));
    expect(rig.transport.starts.single['recording_id'], id);
    final RecordingManifest m2 = await rig.readManifest(id);
    expect(m2.attempts, hasLength(1),
        reason: 'positive control: an attempt that goes out is recorded');
  });
}

/// Records every `audio:start`; answers nothing, so an attempt that does go out
/// ends on its own (short) clocks.
class StartRecordingTransport extends FakeSocketTransport {
  final List<Map<String, Object?>> starts = <Map<String, Object?>>[];

  @override
  void emit(String event, Object? payload) {
    super.emit(event, payload);
    if (event == FlowMicEvents.audioStart && payload is Map<String, Object?>) {
      starts.add(payload);
    }
  }
}

class HeldTailRig {
  HeldTailRig._(this.tmp, this.store, this.spill);

  static Future<HeldTailRig> open() async {
    final Directory tmp =
        await Directory.systemTemp.createTemp('flowmic-rc-p-held-');
    final RetainedAudioStore store =
        RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    int micros = 1757000000000000;
    final HeldTailRig r = HeldTailRig._(
      tmp,
      store,
      RetainedAudioSpill(
        store: store,
        retainFromFirstFrame: true,
        clock: () => micros += 1000000,
      ),
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

  late final StartRecordingTransport transport;
  late final PttSession session;
  late final TimelineStore timeline;
  late final BackfillRunner runner;

  void _build() {
    transport = StartRecordingTransport();
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

  /// One recording made the way a press makes it, closed by a link loss so
  /// nothing is settling it.
  Future<String> recordThroughSpill(int bytes) async {
    spill.noteConfigSnapshot(
        recordingConfigSnapshot(mode: 'realtime', sourceLang: 'zh'));
    await spill.beginRecording();
    final String id = spill.currentRecordingId!;
    spill.appendCaptured(Uint8List(bytes));
    await spill.endRecording(interruptReason: JournalInterrupt.linkLoss);
    return id;
  }

  Future<RecordingManifest> readManifest(String id) async {
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
      dirPath: tmp.path,
      recordingId: id,
      commitInterval: const Duration(days: 1),
    );
    final RecordingManifest m = j.manifest;
    await j.close();
    return m;
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
