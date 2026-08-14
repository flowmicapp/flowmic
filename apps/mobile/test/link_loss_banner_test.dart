// SEG-2 — the local dead-recording notice, asserted on the RENDERED result
// (0.2.53 law: a string a widget holds is not the glyphs a person can read).
//
// SPEC-REF:
//   docs/strategy/2026-08-11-unified-transcription-session-design.md §2-R4
//     (local judgement, local notice; copy = the two provable facts, nothing
//      about transcription)
//   test/w83_autostop_banner_test.dart (the chain shape this file imitates —
//     the notice rides the SAME banner chain, only the reason is local)
//
// The rig is w83's: real PttSession + real ChatController + the production
// banner adapter (`chatBannerSources`) + the production renderer (BannerSlot /
// ChatFlowPage). The doubles are the socket, the OS recorder, and — here —
// the RETAINED-AUDIO STORE, at the lowest layer ([_MemRetainedStore], the
// `_StubAdapter` precedent from retained_audio_wiring_test.dart): the spill,
// whose kept/plain decision this file renders, stays production code.
//
// 🔴 WHY NO REAL DISK, AND WHY TEARDOWN NEVER AWAITS THE SESSION — both are
// the SAME measured scar, not caution: inside testWidgets' FakeAsync zone the
// real capture chain's futures never complete (instrumented in
// mic_permission_denial_widget_test.dart `_swipeUpCancel`'s doc: `await
// _pcmSub.cancel()` completed only after the test body was over), and real
// file I/O is worse — its completions ride the real event loop the fake zone
// never drains. The FIRST version of this file did both (a temp-dir store +
// `await session.dispose()`), and all three tests hung to the 10-minute
// timeout. The disk half of retention is proven where real time runs:
// ptt_link_loss_test.dart.

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_banner_sources.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const AppStrings _zh = AppStringsZh();

class _FakeOwner implements InstanceOwnerProbe {
  _FakeOwner(this.instanceId, this.instanceName);
  @override
  String? instanceId;
  @override
  String? instanceName;
}

/// Lowest-layer store double: bytes live in memory, every method completes on
/// microtasks (which `tester.pump` drains), no file future ever hangs the
/// fake zone. Everything ABOVE it — spill decision, capture verb, session
/// trigger, controller, adapter, renderer — is production code.
class _MemRetainedStore extends RetainedAudioStore {
  _MemRetainedStore() : super(dir: Directory('mem-retained-unused'));

  final Map<int, BytesBuilder> _segs = <int, BytesBuilder>{};

  @override
  Future<void> open() async {}

  @override
  Future<bool> append(
      {required int segmentIdx, required Uint8List bytes}) async {
    (_segs[segmentIdx] ??= BytesBuilder(copy: true)).add(bytes);
    return true;
  }

  @override
  Future<void> settle(int segmentIdx) async {
    _segs.remove(segmentIdx);
  }

  @override
  Future<List<int>> pendingSegments() async => _segs.keys.toList()..sort();

  @override
  Future<Uint8List?> read(int segmentIdx) async => _segs[segmentIdx]?.toBytes();

  @override
  Future<void> sweep() async {}
}

/// w83's rig plus a real spill over the in-memory store.
class _Rig {
  _Rig._();

  late final _MemRetainedStore retainedStore;
  late final RetainedAudioSpill spill;
  late final FakeSocketTransport transport;
  late final FakeAudioRecorder recorder;
  late final AudioCapture capture;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  static _Rig create({bool withSpill = true}) {
    final _Rig r = _Rig._();
    r.retainedStore = _MemRetainedStore();
    r.spill = RetainedAudioSpill(store: r.retainedStore);
    r.transport = FakeSocketTransport();
    r.recorder = FakeAudioRecorder();
    r.capture = AudioCapture(
      recorder: r.recorder,
      spill: withSpill ? r.spill : null,
    );
    r.session = newTestSession(transport: r.transport, audio: r.capture);
    r.store = newTestStore(owner: _FakeOwner('inst-seg2', '书房电脑'));
    r.destination = DestinationController();
    r.controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: r.session,
      store: r.store,
      destination: r.destination,
      syncGate: TimelineSyncGate(transport: r.transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    r.transport.pushStatus(SocketStatus.connected);
    return r;
  }

  BannerQueue bannersFor(AppStrings strings) => chatBannerSources(
    controller: controller,
    strings: strings,
    onRetrySendFailure: null,
  );

  /// 🔴 SYNCHRONOUS on purpose (see the file header). Every timer-releasing
  /// line in `disposeRouted` runs BEFORE its first await, so an un-awaited
  /// dispose still releases them all synchronously; the awaits after them are
  /// stream-sub cancels on the live capture's streams — the measured FakeAsync
  /// deadlock — so neither they nor `session.dispose()` may be awaited here.
  /// No timer survives: the trigger stopped the heartbeat, the grace fired,
  /// the presence poll never started (never paired), and the reconnect edge
  /// cancelled the session-lost watch. Leaked stream controllers are inert and
  /// not checked by the binding.
  void teardownSync() {
    debugCancelBannerAutoHideTimers(controller);
    unawaited(controller.dispose());
    destination.dispose();
    store.dispose();
  }
}

Finder _renderedBanner(String message) => find.descendant(
  of: find.byType(BannerSlot),
  matching: find.text(message),
);

/// Drive the rig through the whole edge: record → drop → 3 s grace expiry.
Future<void> _driveToDeadRecording(WidgetTester tester, _Rig r) async {
  unawaited(r.controller.pttDown());
  await tester.pump();
  await tester.pump();
  expect(r.capture.currentState, RecorderState.recording,
      reason: 'positive control: the production chain really entered capture');
  r.recorder.feed(makePcm(kChunkBytes));
  await tester.pump();

  r.transport.pushStatus(SocketStatus.disconnected);
  await tester.pump();
  await tester.pump(const Duration(seconds: 4)); // past the 3 s grace
  await tester.pump();
  expect(r.capture.currentState, RecorderState.stopped,
      reason: 'positive control: the grace expired and the trigger ran');
}

void main() {
  testWidgets(
      '🔴 the whole chain renders: edge → notice → glyphs, and the link '
      'banner defers (never swallows) it while the wire is still down',
      (WidgetTester tester) async {
    final _Rig r = _Rig.create();
    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: r.controller)),
    );
    await tester.pump();
    expect(_renderedBanner(_zh.recordingStoppedLinkLossKept), findsNothing,
        reason: 'positive control for the finder');

    await _driveToDeadRecording(tester, r);

    // The retention the copy is about really happened (in-memory here; the
    // disk half is ptt_link_loss_test.dart's subject).
    await r.spill.flush();
    expect(await r.retainedStore.pendingSegments(), isNotEmpty,
        reason: 'positive control: the spill really took the tail');

    // While the link is down, the blocking link banner owns the single slot —
    // the notice is QUEUED behind it (deferred, not swallowed: banner_queue's
    // contract), and the queue already carries the kept-variant sentence.
    expect(_renderedBanner(_zh.recordingStoppedLinkLossKept), findsNothing);
    final BannerQueue queued = r.bannersFor(_zh);
    expect(
      queued.all.any((BannerItem b) =>
          b.id == BannerIds.autoStop &&
          b.message == _zh.recordingStoppedLinkLossKept),
      isTrue,
      reason: 'the notice must be in the queue with the retention-claiming '
          'copy — retention really happened (a live spill took the tail)',
    );

    // The link comes back: the link banner self-clears and the notice takes
    // the slot — the moment the user can first act again is the moment they
    // read why the recording is gone.
    r.transport.pushStatus(SocketStatus.connected);
    await tester.pump();
    expect(_renderedBanner(_zh.recordingStoppedLinkLossKept), findsOneWidget);

    r.teardownSync();
  });

  testWidgets(
      'four languages, rendered through the production adapter + renderer '
      '(0.2.53: the assertion is on glyphs under BannerSlot, per locale)',
      (WidgetTester tester) async {
    final _Rig r = _Rig.create();
    // Reach the notice state once; then render the SAME live queue in each
    // language, exactly as the page would (adapter → BannerSlot).
    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: r.controller)),
    );
    await tester.pump();
    await _driveToDeadRecording(tester, r);
    r.transport.pushStatus(SocketStatus.connected);
    await tester.pump();

    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings(locale);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: BannerSlot(queue: r.bannersFor(s), strings: s),
          ),
        ),
      );
      await tester.pump();
      expect(
        find.descendant(
          of: find.byType(BannerSlot),
          matching: find.text(s.recordingStoppedLinkLossKept),
        ),
        findsOneWidget,
        reason: 'locale ${locale.name}: the kept-variant sentence must be the '
            'rendered slot content, not merely a string in a table',
      );
    }
    r.teardownSync();
  });

  testWidgets(
      'no retention layer ⇒ the rendered sentence refuses the retention claim',
      (WidgetTester tester) async {
    // A spill-less rig — the degraded boot (store failed to open in main()).
    final _Rig r = _Rig.create(withSpill: false);
    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: r.controller)),
    );
    await tester.pump();

    await _driveToDeadRecording(tester, r);
    r.transport.pushStatus(SocketStatus.connected);
    await tester.pump();

    expect(_renderedBanner(_zh.recordingStoppedLinkLoss), findsOneWidget);
    expect(_renderedBanner(_zh.recordingStoppedLinkLossKept), findsNothing,
        reason: 'nothing was retained, so the retention sentence would be an '
            'unbacked promise (15 册 §2.0-b constraint 3)');
    expect(await r.retainedStore.pendingSegments(), isEmpty,
        reason: 'positive control: this rig really retained nothing');

    r.teardownSync();
  });
}
