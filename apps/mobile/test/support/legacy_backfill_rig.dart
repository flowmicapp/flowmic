// NR-138 — a rig for the LEGACY segment leg through the PRODUCTION controller.
//
// `backfill_channel_test.dart` drives a hand-built `BackfillRunner` for most of
// its legacy cases (`manualBackfill: true` disposes `controller.backfill`). The
// NR-138 root cause asked for the opposite: the retry loop it describes is made
// of production edges (the recording-end sweep, the RC-O timer, the queued
// passes), so this rig keeps `controller.backfill` — the runner production
// builds — and hands the test only the two seams production already exposes
// for this: the recovery clock and the retry-timer factory.

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/backfill_runner.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/pending_recovery_store.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'di.dart';
import 'fakes.dart';
import 'temp_teardown.dart';

const List<String> kLegacyTierA = <String>[
  kCapabilityCoverageReceipt,
  kCapabilityDeliveryNoneSafe,
  kCapabilityIdempotentOperation,
];

/// A relay that answers like one: `audio:stop` with the finals queued for it,
/// or — when [stallEveryStart] — every `audio:start` with a terminal engine
/// error, delivered synchronously (the P0-1 shape `backfill_channel_test.dart`
/// models: the stall has already happened when `endBackfill` returns).
class LegacyRelay extends FakeSocketTransport {
  bool stallEveryStart = false;
  final List<Map<String, Object?>> starts = <Map<String, Object?>>[];
  final List<List<Map<String, Object?>>> replies = <List<Map<String, Object?>>>[];

  @override
  void emit(String event, Object? payload) {
    super.emit(event, payload);
    if (event == FlowMicEvents.audioStart && payload is Map<String, Object?>) {
      starts.add(payload);
      if (stallEveryStart) {
        pushIncoming(FlowMicEvents.sttError, <String, Object?>{
          'code': 'STT_ENGINE_TIMEOUT',
          'message': 'engine stalled',
          'retryable': false,
        });
      }
    }
    if (event != FlowMicEvents.audioStop || replies.isEmpty) return;
    final List<Map<String, Object?>> finals = replies.removeAt(0);
    Future<void>(() async {
      for (final Map<String, Object?> f in finals) {
        pushIncoming(FlowMicEvents.sttFinal, f);
        await pumpEventQueue();
      }
    });
  }

  /// One terminal final carrying [text] for the next `audio:stop`.
  void replyWords(String text) => replies.add(<Map<String, Object?>>[
        <String, Object?>{
          'text': text,
          'confidence': 0.95,
          'language': 'en',
          'segment_idx': 0,
          'is_segment': false,
          'duration_ms': 100,
        },
      ]);
}

/// NR-138 round 2 — the independent review's B2 seam: runs [change] once,
/// right after a timeline row has been written, i.e. between one segment's
/// result and the next segment's start.
class GateChangePersistence extends InMemoryTimelinePersistence {
  void Function()? change;

  @override
  Future<void> upsert(TimelineEntry entry) async {
    await super.upsert(entry);
    final void Function()? c = change;
    change = null;
    c?.call();
  }
}
/// The RC-O timer, fired by hand. Production arms ONE timer for the earliest
/// due time and replaces it on every pass; [armedFor] is that request.
class ManualRetryTimer implements Timer {
  ManualRetryTimer(this.wait, this._fire);
  final Duration wait;
  final void Function() _fire;
  bool _active = true;

  void fire() {
    if (!_active) return;
    _active = false;
    _fire();
  }

  @override
  void cancel() => _active = false;
  @override
  bool get isActive => _active;
  @override
  int get tick => 0;
}

class LegacyRig {
  LegacyRig._(this.tmp, this.store, this.spill);

  static Future<LegacyRig> open({
    Directory? directory,
    List<String>? capabilities = kLegacyTierA,
    bool journalFace = true,
    int startMs = 1000000,
    TimelinePersistence? persistence,
  }) async {
    final Directory tmp =
        directory ?? await Directory.systemTemp.createTemp('flowmic-nr138-');
    final RetainedAudioStore store = RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    final LegacyRig r = LegacyRig._(
      tmp,
      store,
      RetainedAudioSpill(store: store, retainFromFirstFrame: journalFace),
    );
    r.nowMs = startMs;
    r._build(capabilities, persistence);
    await r.idle();
    return r;
  }

  final Directory tmp;
  final RetainedAudioStore store;
  final RetainedAudioSpill spill;
  late final LegacyRelay relay;
  late final PttSession session;
  late final TimelineStore timeline;
  late final ChatController controller;
  late final PendingRecoveryStore pending;
  int nowMs = 0;
  ManualRetryTimer? armed;

  BackfillRunner get runner => controller.backfill;

  void _build(List<String>? capabilities, TimelinePersistence? persistence) {
    relay = LegacyRelay();
    session = newTestSession(
      transport: relay,
      audio: AudioCapture(recorder: FakeAudioRecorder(), spill: spill),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    if (capabilities != null) {
      session.reconnect.noteServerCapabilities(
          <String, Object?>{'capabilities': capabilities});
    }
    timeline = newTestStore(persistence: persistence);
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: timeline,
      destination: DestinationController(fixedRecordOnly: true),
      syncGate: TimelineSyncGate(transport: relay),
      localPrefs: InMemoryLocalPrefs(),
      recoveryClock: () => nowMs,
      recoveryRetryTimer: (Duration wait, void Function() fire) =>
          armed = ManualRetryTimer(wait, fire),
    );
    pending = PendingRecoveryStore(runner: runner, sourceLang: () => 'en');
    relay.pushStatus(SocketStatus.connected);
  }

  /// One legacy segment file, written through the store's own append.
  Future<void> seed(String key, {int idx = 0, int bytes = 6400}) async {
    store.beginSession(key);
    await store.append(segmentIdx: idx, bytes: Uint8List(bytes));
    store.endSession();
  }

  File budgetFile(String key) =>
      File('${tmp.path}${Platform.pathSeparator}${key}__legacy-retry.json');

  int get autoStarts => relay.starts
      .where((Map<String, Object?> s) => s['attempt_kind'] == 'auto_retry')
      .length;

  /// Wait for the runner to be idle — a fact the product publishes, not a
  /// number of event-loop turns (see backfill_channel_test.dart `until`).
  Future<void> idle() async {
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 15));
    await pumpEventQueue();
    while (runner.isBusy) {
      if (DateTime.now().isAfter(deadline)) fail('the runner never went idle');
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    await pumpEventQueue();
  }

  Future<void> sweep() async {
    await runner.sweep(sourceLang: 'en');
    await idle();
  }

  /// Fire the RC-O timer the runner armed last, as production's would.
  Future<void> fireRetry() async {
    armed?.fire();
    await idle();
  }

  Future<void> dispose() async {
    await idle();
    await controller.dispose();
    timeline.dispose();
    await session.dispose();
    await spill.dispose();
    await store.dispose();
    await removeTempDir(tmp);
  }
}
