// P2 (round-four device drill, 2026-09-06) — HOW MUCH MEMORY A RECOVERY FEED
// HOLDS WHEN THE SERVER STOPS DRAINING.
//
// MEASURED ON DEVICE: recovering a 38.6 MiB recording over LAN against a
// stalling engine raised PSS by 45.5 MB — very nearly the whole file — even
// though `_streamRange` reads the file in bounded blocks and never holds it
// whole. (`.local/session-2026-09-06-durability-drill-r4/LAN-CTL/verdict.md`.)
//
// ── WHAT THIS FILE MEASURES, AND WHY IT IS NOT AN RSS ASSERTION ─────────────
//
// The holder is not our loop, so weighing the Dart heap would measure the wrong
// thing: `socket.io` accepts every `emit` and buffers it, and
// `PttSession.feedBackfillBlock`'s own doc already says its return value is
// "frames emitted, which is not frames delivered". What can be counted exactly
// — here, and on the wire — is HOW MANY BYTES WE HANDED OVER while the server
// said nothing back, and that number is the queue's size.
//
// So the rig is a transport that records everything and answers nothing, and
// the assertion is a byte count. An RSS number would be a worse test of the
// same claim: noisy, platform-dependent, and unable to say WHY it grew.
//
// SPEC-REF:
//   apps/mobile/lib/src/session/recovery_leg_policy.dart
//     (`kRecoveryInFlightWindowBytes` — why the engine's traffic is the only
//      honest pacing signal available, and why a sleep would bound nothing)
//   apps/mobile/lib/src/session/recovery_leg_wire.dart (`_awaitWindowRoom`)

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
import 'package:flowmic/src/session/recovery_identity.dart';
import 'package:flowmic/src/session/recovery_journal_leg.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/temp_teardown.dart';

/// Exactly 20 read blocks, so the arithmetic below has no remainder to argue
/// about: 8,192,000 B = 1,280 wire frames = 256 s of audio.
const int kFileBytes = 20 * kRecoveryReadBlockBytes;

const List<String> _tierA = <String>[
  kCapabilityCoverageReceipt,
  kCapabilityDeliveryNoneSafe,
  kCapabilityIdempotentOperation,
];

/// The server that takes the audio and never says anything — the state the
/// drill was in. It is not a broken socket: `emit` succeeds every time, which
/// is exactly what makes the queue invisible from our side.
class _SilentTransport extends FakeSocketTransport {
  int chunkFrames = 0;

  @override
  void emit(String event, Object? payload) {
    super.emit(event, payload);
    if (event == FlowMicEvents.audioChunk) chunkFrames += 1;
  }

  int get chunkBytes => chunkFrames * kBackfillChunkBytes;
}

class _Rig {
  _Rig._(this.tmp, this.store, this.spill, this.transport, this.session,
      this.timeline, this.runner);

  final Directory tmp;
  final RetainedAudioStore store;
  final RetainedAudioSpill spill;
  final _SilentTransport transport;
  final PttSession session;
  final TimelineStore timeline;
  final BackfillRunner runner;

  static Future<_Rig> open() async {
    final Directory tmp =
        await Directory.systemTemp.createTemp('flowmic-feed-');
    final RetainedAudioStore store =
        RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    final RetainedAudioSpill spill =
        RetainedAudioSpill(store: store, retainFromFirstFrame: true);
    final _SilentTransport transport = _SilentTransport();
    final PttSession session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder(), spill: spill),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    session.reconnect
        .noteServerCapabilities(<String, Object?>{'capabilities': _tierA});
    final TimelineStore timeline = newTestStore();
    final BackfillRunner runner = BackfillRunner(
      session: session,
      store: timeline,
      // Every clock here is shortened so the test measures the SHAPE of the
      // stall rather than sitting through the production deadlines. Their
      // relative order is preserved: the window's wait (uploadProgress) is
      // shorter than the attempt's total budget, which is what keeps the budget
      // authoritative in production too.
      recoveryTimeouts: const RecoveryTimeouts(
        uploadProgress: Duration(milliseconds: 300),
        engineProgress: Duration(milliseconds: 300),
        noProgress: Duration(milliseconds: 400),
        totalBudgetBase: Duration(milliseconds: 600),
        totalBudgetPerAudioMinute: Duration.zero,
      ),
      // A real (tiny) sleep, not a stub: the window's wait loop yields through
      // this seam, and a stub would turn it into a hot spin on the test's own
      // CPU rather than a wait.
      sleep: (Duration _) =>
          Future<void>.delayed(const Duration(milliseconds: 1)),
    );
    transport.pushStatus(SocketStatus.connected);
    while (runner.isBusy) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    return _Rig._(tmp, store, spill, transport, session, timeline, runner);
  }

  Future<void> writeJournal(String id) async {
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
    await j.appendPcm(Uint8List(kFileBytes));
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

void main() {
  test('a stalled server cannot make the feed hand over the whole file',
      () async {
    final _Rig rig = await _Rig.open();
    addTearDown(rig.dispose);
    await rig.writeJournal('rec-stall');

    await rig.runner.sweep(sourceLang: 'zh');

    // 🔴 THE MEASUREMENT. Before the window this was the whole file: every one
    // of the 1,280 frames went into a queue nobody was draining, which is the
    // +45.5 MB the drill weighed on a 38.6 MiB recording.
    expect(
      rig.transport.chunkBytes,
      lessThanOrEqualTo(
          kRecoveryInFlightWindowBytes + kRecoveryReadBlockBytes),
      reason: 'the feed must stop reading once a window of bytes is out and '
          'unconfirmed; handing over the whole file means nothing is bounding '
          'the socket queue',
    );
    expect(rig.transport.chunkBytes, lessThan(kFileBytes),
        reason: 'positive control on the file itself: a recording smaller than '
            'one window would pass the assertion above without ever '
            'exercising the window');

    // …and stopping the feed is NOT a settle. The bytes are the point.
    expect(
      File('${rig.tmp.path}${Platform.pathSeparator}rec-stall.pcm')
          .existsSync(),
      isTrue,
      reason: 'a partial range produces no matching coverage receipt, so the '
          'recording stays owed and the job backs off — the same rule every '
          'other clock in this leg follows',
    );
  }, timeout: const Timeout(Duration(seconds: 60)));

  test('a server that answers is never throttled: the whole range goes out',
      () async {
    // The negative control for the window itself. Without it, a window that was
    // simply too small — or an `_awaitWindowRoom` that never returned room —
    // would look exactly like a pass above.
    final _Rig rig = await _Rig.open();
    addTearDown(rig.dispose);
    await rig.writeJournal('rec-live');

    // The engine speaks while the upload runs, which is what a working server
    // does: every interim resets the window, so the feed never holds.
    bool feeding = true;
    unawaited(Future<void>.microtask(() async {
      while (feeding) {
        rig.transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
          'text': '…',
          'confidence': 0.5,
          'language': 'zh',
          'segment_idx': 0,
        });
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
    }));
    await rig.runner.sweep(sourceLang: 'zh');
    feeding = false;

    expect(rig.transport.chunkBytes, kFileBytes,
        reason: 'the window may never cost a healthy transfer a single byte');
  }, timeout: const Timeout(Duration(seconds: 60)));
}
