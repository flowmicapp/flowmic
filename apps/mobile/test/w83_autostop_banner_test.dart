// W8-3 — the 5-minute auto-stop must not be silent on the phone.
//
// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §B-5 (a recording that stops must never
//     silently vanish) / docs/strategy/R6-UI-AUDIT-REMEDIATION.md P0-R3
//   docs/strategy/2026-08-10-w8-real-device-findings.md §7-3 (the defect)
//
// ── WHY THIS FILE EXISTS, GIVEN THE SUITE WAS ALREADY GREEN ──────────────────
//
// The 2026-08-10 real-device round measured a 5-minute cap that ended the
// recording with no banner at all (65 frames at ~0.72 s/frame; the 44 after the
// mic went off were MD5-identical, and a sibling banner was caught in 9 frames
// by the same rig, so the method can see banners).
//
// 🔴 The suite could not have caught that, and the reason is the shape of the
// coverage rather than its amount. TWO tests owned the two HALVES:
//   · chat_controller_test.dart 「R6 P0-R3」 pushes the frame and asserts
//     `controller.autoStopped` — the FLAG, and stops there;
//   · banner_queue_test.dart / pc_busy_banner_test.dart call
//     `buildChatBanners(autoStopped: true, …)` — a bool a human typed in.
// Nothing asserted the JOIN. Every hop between 「the flag went true」 and 「the
// sentence is on screen」 could break with both halves still green, which is
// exactly the class of defect the device round reported.
//
// So this file asserts the WHOLE path, from a frame on the wire to the rendered
// glyphs, in the shapes the device actually ran it.
//
// ⚠️ WHAT A GREEN RUN HERE PROVES, STATED SO IT CANNOT BE OVERREAD: it proves
// the banner is CONSTRUCTED AND DELIVERED — the frame reaches the controller,
// the notice reaches the queue, and the queue's top renders its sentence into
// the widget tree. It does NOT prove a human sees words on a screen at second
// 300 of a real recording. That half belongs to the device line and no Flutter
// test can stand in for it.

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
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

/// The real data layer (PttSession) + the real orchestration hub
/// (ChatController) + the real banner adapter. Only the socket and the
/// recorder are doubles — the hops under test are all production code.
class _Rig {
  _Rig._();

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  static _Rig create() {
    final _Rig r = _Rig._();
    r.transport = FakeSocketTransport();
    r.session = newTestSession(
      transport: r.transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    r.store = newTestStore(owner: _FakeOwner('inst-w83', '书房电脑'));
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

  /// The banner queue the chat page actually builds — read through the
  /// production adapter, never by calling `buildChatBanners` with a hand-typed
  /// bool (that is the half-test this file exists to replace).
  BannerQueue get banners => chatBannerSources(
    controller: controller,
    strings: _zh,
    onRetrySendFailure: null,
  );

  BannerItem? get autoStopBanner {
    for (final BannerItem i in banners.all) {
      if (i.id == BannerIds.autoStop) return i;
    }
    return null;
  }

  /// The server hit its own wall — the frame, byte-shaped as
  /// `AudioAutoStoppedSchema` emits it (stt-session.ts:519).
  void cap() => transport.pushIncoming(
    FlowMicEvents.audioAutoStopped,
    const <String, Object?>{'reason': 'hard_limit'},
  );

  /// The TERMINAL final the hard-limit path flushes right behind the cap.
  void terminalFinal(int idx) =>
      transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
        'text': '第 $idx 轮的最后一段',
        'confidence': 0.95,
        'language': 'zh',
        'segment_idx': idx,
        'is_segment': false,
        'duration_ms': 5000,
      });

  /// A soft-segment final — a 5-minute recording is made of these, and each one
  /// mints and delivers a row while the FSM stays in RECORDING.
  void segmentFinal(int idx) =>
      transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
        'text': '标记 $idx 号',
        'confidence': 0.95,
        'language': 'zh',
        'segment_idx': idx,
        'is_segment': true,
        'duration_ms': 30000,
      });

  void teardownSync() {
    debugCancelBannerAutoHideTimers(controller);
    controller.dispose();
    destination.dispose();
    store.dispose();
  }
}

Finder _renderedBanner(String message) => find.descendant(
  of: find.byType(BannerSlot),
  matching: find.text(message),
);

void main() {
  setUp(DiagLog.instance.clear);

  // ── ① the join: a frame on the wire reaches the QUEUE ─────────────────────
  group('the frame reaches the banner queue (the hop nothing asserted)', () {
    test('a cap taken mid-recording puts the notice in the queue', () {
      fakeAsync((FakeAsync async) {
        final _Rig r = _Rig.create();
        r.controller.pttDown();
        async.flushMicrotasks();
        expect(r.autoStopBanner, isNull, reason: 'positive control: nothing is '
            'in the slot before the cap, so a hit below is the cap talking');

        r.cap();
        async.flushMicrotasks();

        final BannerItem? b = r.autoStopBanner;
        expect(b, isNotNull, reason: 'W8-3: the recording ended without the '
            'user releasing — 08 §B-5 forbids that being silent');
        expect(b!.message, _zh.recordingAutoStopped);
        expect(b.severity, BannerSeverity.degraded);
        expect(b.dismissible, isTrue);
        // A degraded notice must be the one the slot actually shows here:
        // nothing else is competing, so a queue entry that loses the slot
        // would be as silent as no entry at all.
        expect(r.banners.top?.id, BannerIds.autoStop);
        r.teardownSync();
        async.flushTimers();
      });
    });

    test('both frames in ONE turn (cap then terminal final) — the wire shape', () {
      fakeAsync((FakeAsync async) {
        final _Rig r = _Rig.create();
        r.controller.pttDown();
        async.flushMicrotasks();
        // SocketCore's inbound controller is sync, so two frames the server
        // emitted back to back both dispatch before any microtask runs. The
        // notice travels on an ASYNC broadcast stream, so it settles after the
        // final has already driven the FSM — that ordering is the reason this
        // case is written out rather than assumed.
        r.cap();
        r.terminalFinal(0);
        async.flushMicrotasks();
        expect(r.autoStopBanner, isNotNull);
        expect(r.store.entries, hasLength(1),
            reason: 'positive control: the content really did survive, so the '
                'assertion above is about the NOTICE and not about a dead rig');
        r.teardownSync();
        async.flushTimers();
      });
    });

    test('a long recording (soft segments, then the cap) still says so', () {
      fakeAsync((FakeAsync async) {
        final _Rig r = _Rig.create();
        r.controller.pttDown();
        async.flushMicrotasks();
        for (int i = 0; i < 3; i++) {
          r.segmentFinal(i);
          async.flushMicrotasks();
          async.elapse(const Duration(seconds: 30));
        }
        r.cap();
        async.flushMicrotasks();
        r.terminalFinal(3);
        async.flushMicrotasks();
        expect(r.autoStopBanner, isNotNull);
        r.teardownSync();
        async.flushTimers();
      });
    });

    test('a SECOND round, minutes later, says so again (hidden is not gone)', () {
      fakeAsync((FakeAsync async) {
        final _Rig r = _Rig.create();
        // Round 1 — banner up, then auto-hidden by its own window.
        r.controller.pttDown();
        async.flushMicrotasks();
        r.cap();
        async.flushMicrotasks();
        expect(r.autoStopBanner, isNotNull);
        r.terminalFinal(0);
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 10));
        expect(r.autoStopBanner, isNull, reason: 'the window elapsed');

        // Round 2 — the device round that was measured was the SECOND one.
        async.elapse(const Duration(minutes: 7));
        r.controller.pttDown();
        async.flushMicrotasks();
        async.elapse(const Duration(minutes: 5));
        r.cap();
        async.flushMicrotasks();
        expect(r.autoStopBanner, isNotNull, reason: 'a hidden banner is not a '
            'spent one — the second occurrence gets said too');
        r.teardownSync();
        async.flushTimers();
      });
    });

    test('the cap can also arrive with the FSM already out of RECORDING', () {
      fakeAsync((FakeAsync async) {
        final _Rig r = _Rig.create();
        // `AudioAutoStoppedSchema` has four reasons and only one of them is the
        // 5-minute wall; a disconnect edge can land here with nothing to stop.
        // `fsm.onPttUp()` is refused in that case and the notice must still be
        // raised — it is the LAST line of the arm, not a consequence of the FSM.
        r.cap();
        async.flushMicrotasks();
        expect(r.autoStopBanner, isNotNull);
        r.teardownSync();
        async.flushTimers();
      });
    });
  });

  // ── ② the rendered surface ────────────────────────────────────────────────
  testWidgets('the sentence is really in the widget tree, not just in the queue',
      (WidgetTester tester) async {
    final _Rig r = _Rig.create();
    addTearDown(() async {
      await r.controller.dispose();
      r.destination.dispose();
      r.store.dispose();
      await r.session.dispose();
      await r.transport.close();
    });
    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: r.controller)),
    );
    await tester.pump();
    // Driven through the FSM rather than `await controller.pttDown()`: awaiting
    // the real PttSession chain inside testWidgets deadlocks (the scar
    // mic_permission_denial_widget_test.dart's header records).
    r.session.fsm.onPttDown();
    await tester.pump();
    expect(_renderedBanner(_zh.recordingAutoStopped), findsNothing,
        reason: 'positive control for the finder');

    r.cap();
    await tester.pump();

    // 🔴 The assertion is on the RENDERED text under BannerSlot, not on
    // `controller.autoStopped`: 0.2.53 paid for the difference between a string
    // a widget holds and the glyphs a person can read.
    expect(_renderedBanner(_zh.recordingAutoStopped), findsOneWidget);

    // Release every timer the arm armed, the way send_retry_banner_test's
    // `releaseWatchdogs` does: the binding checks for pending timers when the
    // BODY ends, which is before addTearDown runs. The cap put the FSM into
    // PROCESSING, so its 15 s net is live — walked out through the two edges
    // that disarm it rather than by letting it fire (a fired net would raise a
    // stall banner and rewrite the very slot just asserted).
    r.session.fsm.onSttFinal();
    r.session.fsm.onJustDoneTimeout();
    r.controller.delivery.dispose();
    debugCancelBannerAutoHideTimers(r.controller);
    r.session.debugStopIdlePresencePoll();
  });

  // ── ③ the trail ───────────────────────────────────────────────────────────
  group('the path leaves a trail (what the device round did not have)', () {
    test('emit and receipt are both recorded, and the emit says who was '
        'listening', () {
      fakeAsync((FakeAsync async) {
        final _Rig r = _Rig.create();
        r.controller.pttDown();
        async.flushMicrotasks();
        r.cap();
        async.flushMicrotasks();

        final List<String> trail = DiagLog.instance.snapshot();
        final Iterable<String> emitted =
            trail.where((String l) => l.contains('audio.auto_stopped.emitted'));
        final Iterable<String> received =
            trail.where((String l) => l.contains('audio.auto_stopped.received'));
        expect(emitted, hasLength(1));
        expect(received, hasLength(1),
            reason: 'an emit with no receipt after it is the one hypothesis a '
                'screen capture can never rule out');
        // 🔴 `has_listener` is the whole point of the emit line. A broadcast
        // controller with no listener DISCARDS the event, and that outcome is
        // byte-identical — in every log, test and screenshot — to an arm that
        // never ran at all. This is the fact that separates them.
        expect(emitted.first, contains('has_listener=true'));
        r.teardownSync();
        async.flushTimers();
      });
    });
  });
}
