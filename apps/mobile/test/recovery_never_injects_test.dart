// Card FX-2 — A RECOVERED TRANSCRIPT REACHED THE PC.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A4 (recovery results NEVER auto-inject — E17, `delivery:'none'`)
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md  (O-8: no 「send to PC」 for recovered text)
//   CLAUDE.md 「补投绝不自动注入」
//
// ── WHAT THE DEVICE MEASURED (drills DF-2 note (a) and B-11, 2026-09-06) ────
//
// Force-stop mid-press, relaunch, let the queue recover: the recovery
// attempt's transcript arrived on the PC as `inject:request` with
// `inject_origin:"live"`, while the manifest called the attempt `auto_retry`.
// All three modes reproduced it.
//
// 🔴 THE SERVER WAS NOT THE LEAK. `beginBackfill` sends `delivery: none` and
// the relay gates its own fan-out on `delivery !== 'none'`
// (`audio.handler.ts`), so it forwarded nothing. THE PHONE SENT IT ITSELF: the
// terminal final of a recovery rides the SAME inbound route as a live one
// (`ptt_inbound` → `ChatController._onFinal` → `_settleSpan`), and the row was
// minted with `c._activeDelivery` — a field written in `pttDown` and nowhere
// else, so it held the previous press's destination or, after a relaunch, its
// own default `Delivery.inject`.
//
// ⚠️ WHY `recovery_queue_core_test.dart` STAYED GREEN THROUGH ALL OF IT. Its
// rig builds `DestinationController(fixedRecordOnly: true)`, so every row it
// ever mints is `origin: 'cloud'` and `_deliverDirect` returns on its FIRST
// line. That rig cannot reach the delivery fork at all. This file's rig is the
// same one with the destination a paired phone actually has — which is the
// whole difference between a suite that could see this defect and one that
// could not.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_identity.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/temp_teardown.dart';

const List<String> tierACaps = <String>[
  kCapabilityCoverageReceipt,
  kCapabilityDeliveryNoneSafe,
  kCapabilityIdempotentOperation,
];

/// Answers `audio:stop` the way the server does and echoes back the identity
/// the phone put on `audio:start`, so a recovery final is indistinguishable
/// from a live one except in the ways production can really tell them apart.
class _EchoingTransport extends FakeSocketTransport {
  final List<Map<String, Object?>> starts = <Map<String, Object?>>[];
  int chunkFrames = 0;
  String finalText = 'recovered words';

  @override
  void emit(String event, Object? payload) {
    super.emit(event, payload);
    if (event == FlowMicEvents.audioStart && payload is Map<String, Object?>) {
      starts.add(payload);
      chunkFrames = 0;
    }
    if (event == FlowMicEvents.audioChunk) chunkFrames += 1;
    if (event == FlowMicEvents.audioStop && starts.isNotEmpty) {
      final Map<String, Object?> s = starts.last;
      Future<void>.microtask(() {
        pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
          'text': finalText,
          'confidence': 0.9,
          'language': 'zh',
          'segment_idx': 0,
          'is_segment': false,
          'duration_ms': 1000,
          'coverage_receipt_version': 1,
          'fed_frames': chunkFrames,
          'seq_gaps': 0,
          'drops': 0,
          'engine_leg_rollovers': 0,
          'ended_normally': true,
          'recording_id': s['recording_id'],
          'attempt_id': s['attempt_id'],
          'range_start_sample': s['range_start_sample'],
          'range_end_sample': s['range_end_sample'],
        });
      });
    }
  }
}

class _Rig {
  _Rig._(this.tmp, this.store, this.spill);

  static Future<_Rig> open() async {
    final Directory tmp =
        await Directory.systemTemp.createTemp('flowmic-fx2-');
    final RetainedAudioStore store =
        RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    final _Rig r = _Rig._(
      tmp,
      store,
      RetainedAudioSpill(store: store, retainFromFirstFrame: true),
    );
    r._build();
    while (r.controller.backfill.isBusy) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    return r;
  }

  final Directory tmp;
  final RetainedAudioStore store;
  final RetainedAudioSpill spill;
  late final _EchoingTransport transport;
  late final PttSession session;
  late final TimelineStore timeline;
  late final ChatController controller;

  void _build() {
    transport = _EchoingTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder(), spill: spill),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    session.reconnect
        .noteServerCapabilities(<String, Object?>{'capabilities': tierACaps});
    timeline = newTestStore();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: timeline,
      // 🔴 THE ONE LINE THAT MAKES THIS RIG DIFFERENT from
      // `recovery_queue_core_test.dart`: a phone paired to a PC, i.e. the
      // destination every affected user was in.
      destination: DestinationController(),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    transport.pushStatus(SocketStatus.connected);
  }

  /// Write one journal onto the real temp directory, the way capture would.
  Future<String> writeJournal({required String id, int bytes = 32000}) async {
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
      dirPath: tmp.path,
      recordingId: id,
      configSnapshot: <String, Object?>{
        kConfigSnapshotMode: 'realtime',
        kConfigSnapshotSourceLang: 'zh',
        kConfigSnapshotPrefsDigest: '',
      },
      commitInterval: const Duration(days: 1),
    );
    await j.appendPcm(Uint8List(bytes));
    await j.close();
    return id;
  }

  Future<void> settleQueue() async {
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 10));
    while (controller.backfill.isBusy && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    await pumpEventQueue();
  }

  Future<void> dispose() async {
    await settleQueue();
    await controller.dispose();
    timeline.dispose();
    await session.dispose();
    await spill.dispose();
    await store.dispose();
      await removeTempDir(tmp);
  }
}

void main() {
  test(
      'REGRESSION DF-2(a)/B-11: a recovery attempt mints a record-only row and '
      'sends NOTHING to the PC, even with the destination set to inject',
      () async {
    final _Rig r = await _Rig.open();
    // The state a relaunch leaves behind: no press has happened in this
    // process, so `_activeDelivery` is sitting on its default.
    expect(r.session.openSessionDelivery, Delivery.inject,
        reason: 'the default is what the device was in when it injected');

    await r.writeJournal(id: 'run-1757000000000000-r1757000000000');
    await r.controller.backfill.sweep(sourceLang: 'zh');
    await r.settleQueue();

    // (1) the attempt really ran, or the assertions below are vacuous.
    expect(
      r.transport.starts.where((Map<String, Object?> s) =>
          s['recording_id'] != null && s['attempt_kind'] == 'auto_retry'),
      isNotEmpty,
      reason: 'positive control: nothing is proved by a queue that idled',
    );
    // (2) the whole finding.
    expect(
      r.transport.emittedNames,
      isNot(contains(FlowMicEvents.injectRequest)),
      reason: 'E17 / owner ruling O-8 — recovered words are never sent',
    );
    // (3) and the row itself is honest, not merely un-sent: a row stamped
    // `inject` is one a later long-press re-delivery would happily send.
    final TimelineEntry row = r.timeline.entries
        .where((TimelineEntry e) => e.sourceText == 'recovered words')
        .single;
    expect(row.delivery, Delivery.none);

    await r.dispose();
  });

  test(
      'REGRESSION DF-2(b)/(c): the row is as long as the audio we fed, and the '
      'bytes go on the settle instead of waiting for the sweep', () async {
    final _Rig r = await _Rig.open();
    // 32,000 B of 16 kHz mono s16le = exactly 1 s. The fake engine reports
    // `duration_ms: 1000` for the whole thing, so a 1 s recording could not
    // tell the two sources apart - feed 8 s and let them disagree.
    const int eightSeconds = 32000 * 8;
    final String id = await r.writeJournal(
        id: 'run-1757000000000000-r1757000000000', bytes: eightSeconds);
    final String pcm =
        '${r.tmp.path}${Platform.pathSeparator}$id${RetainedAudioJournal.pcmSuffix}';
    expect(File(pcm).existsSync(), isTrue);

    await r.controller.backfill.sweep(sourceLang: 'zh');
    await r.settleQueue();

    final TimelineEntry row = r.timeline.entries
        .where((TimelineEntry e) => e.sourceText == 'recovered words')
        .single;
    // The engine said 1,000 ms for the whole attempt; we fed 8 s.
    expect(row.durationMs, 8000);
    // FX-4 / owner ruling O-1: success means the bytes go now.
    expect(File(pcm).existsSync(), isFalse,
        reason: 'the live path deletes inline; so does this one now');
    // ...and the manifest stays, because it is the record of where the words
    // went (same decision the live path documents).
    expect(
      File('${r.tmp.path}${Platform.pathSeparator}$id'
              '${RetainedAudioJournal.manifestSuffix}')
          .existsSync(),
      isTrue,
    );
    await r.dispose();
  });

  test('POSITIVE CONTROL: a live press on the same rig still injects',
      () async {
    final _Rig r = await _Rig.open();
    await r.controller.pttDown();
    expect(r.session.openSessionDelivery, Delivery.inject);
    await r.controller.pttUp();
    await pumpEventQueue();
    await pumpEventQueue();

    expect(r.transport.emittedNames, contains(FlowMicEvents.injectRequest));
    expect(
      r.timeline.entries.single.delivery,
      Delivery.inject,
      reason: 'the fix must not turn every row record-only',
    );
    await r.dispose();
  });

  test('the wire delivery follows whoever opened the session', () async {
    final _Rig r = await _Rig.open();
    expect(r.session.openSessionDelivery, Delivery.inject);
    expect(
      r.session.beginBackfill(mode: FlowMode.realtime, sourceLang: 'zh'),
      isTrue,
    );
    expect(r.session.openSessionDelivery, Delivery.none,
        reason: 'recovered audio owns the wire and it is none for all of it');
    r.session.endBackfill();
    expect(r.session.openSessionDelivery, Delivery.none,
        reason: 'the terminal final can arrive INSIDE endBackfill; a flag '
            'cleared there would be false exactly when it is read');
    // The next OPENER is the only thing that may change the answer - and the
    // positive control above is where a live press opening one is asserted.
    await r.dispose();
  });
}
