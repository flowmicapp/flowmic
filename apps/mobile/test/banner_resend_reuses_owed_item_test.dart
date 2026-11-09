// rc-phone-fixes-2 (measured on a device, 2026-11-07) — the banner's Resend on a row
// the queue still owes reuses that item. Contract: doc 15 `15-RECEIPT-STATES.md`
// §2.0.1-c.
//
// The defect: row 「Pending · no answer yet」 plus the failure banner. The banner's
// Resend called `reInject` directly, so it minted `r18` while the queue owed `m17`. The
// computer saw two ids, which its dedup cannot join, and Notepad had the sentence
// twice. The row's own Resend never did this (F7); only the banner bypassed it.
//
// ⇒ This mounts the real chat page and taps the real banner button, and asserts on the
// frames that left, because two frames with two ids IS the defect.
//
// Reverse control (2026-11-07, this file only; measured red, restored, rerun green,
// same command): `resendEntry` back to `reInject` in `_retryFailedSendRouted` → the
// first case red at 「Expected: an object with length of <1>」 on the set of request ids.

import 'dart:async' show unawaited;

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const String _words = 'the computer went quiet for a while';
final AppStrings _zh = AppStrings.of(AppLocale.zh); // ChatFlowPage's default.

final Finder _bannerResend = find.descendant(
  of: find.byType(BannerSlot),
  matching: find.text(_zh.resendAction),
);

class _Owner implements InstanceOwnerProbe {
  const _Owner(this._s);
  final PttSession _s;
  @override
  String? get instanceId => _s.connectedInstanceId;
  @override
  String? get instanceName => _s.pcDisplayName;
}

class _Rig {
  _Rig() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    timeline = newTestStore(owner: _Owner(session));
    c = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: timeline,
      destination: DestinationController(),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.direct),
    );
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore timeline;
  late final ChatController c;

  List<Map<Object?, Object?>> get frames => transport.emitted
      .where((EventEnvelope e) => e.name == FlowMicEvents.injectRequest)
      .map((EventEnvelope e) => e.data! as Map<Object?, Object?>)
      .toList();

  Future<void> close(WidgetTester t) async {
    c.session.debugStopIdlePresencePoll();
    c.outbox.debugCancelNoAnswerRetries();
    await t.pumpWidget(const SizedBox());
    bool done = false;
    unawaited(() async {
      await c.dispose();
      await session.dispose();
      timeline.dispose();
      await transport.close();
      done = true;
    }());
    for (int i = 0; i < 200 && !done; i++) {
      await t.pump(const Duration(seconds: 1));
      await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
    }
    expect(done, isTrue, reason: 'fixture: teardown finished');
  }
}

Future<void> _flush(WidgetTester t) async {
  for (int i = 0; i < 12; i++) {
    await t.pump();
  }
}

Future<void> _elapse(WidgetTester t, Duration span) async {
  for (Duration d = Duration.zero; d < span; d += const Duration(seconds: 1)) {
    await t.pump(const Duration(seconds: 1));
    await t.runAsync(() => Future<void>.delayed(Duration.zero));
  }
  await _flush(t);
}

Future<_Rig> _noAnswer(WidgetTester t) async {
  t.view.physicalSize = const Size(420 * 3, 1800 * 3);
  t.view.devicePixelRatio = 3.0;
  addTearDown(t.view.reset);
  final _Rig r = _Rig();
  await r.c.outbox.load();
  r.transport.pushStatus(SocketStatus.connected);
  r.session.noteRoomJoined(atHomeNode: true);
  await _flush(t);
  await t.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.c)));
  unawaited(r.c.sendFavorite(_words));
  await _flush(t);
  expect(r.frames, hasLength(1), reason: 'premise: the frame left');
  // Just past the 20 s row watchdog, inside the banner's own life.
  await _elapse(t, const Duration(seconds: 21));
  return r;
}

void main() {
  testWidgets('🔴 the banner\'s Resend on a row the queue owes: one id, however long the '
      'computer stays quiet', (WidgetTester t) async {
    final _Rig r = await _noAnswer(t);
    final TimelineEntry row = r.timeline.entries.single;
    expect(row.failureReason, 'INJECT_NO_RESULT', reason: 'premise: the row watchdog fired');
    expect(r.c.outbox.owedEntryIds, contains(row.id), reason: 'premise: the queue owes it');
    expect(_bannerResend, findsOneWidget, reason: 'premise: the banner offers Resend');

    await t.tap(_bannerResend);
    await t.pump();
    // Past the queue's 45 s watchdog, so its own retry of the item has gone out too.
    await _elapse(t, const Duration(seconds: 70));

    final Set<Object?> ids = r.frames.map((Map<Object?, Object?> f) => f['request_id']).toSet();
    expect(ids, hasLength(1), reason: 'two ids are two deliveries: the sentence typed twice');
    expect(r.timeline.entries, hasLength(1));
    await r.close(t);
  }, timeout: const Timeout(Duration(minutes: 2)));

  testWidgets('positive control: nothing owed ⇒ the banner\'s Resend still makes a new '
      'delivery, so the button is not dead', (WidgetTester t) async {
    final _Rig r = await _noAnswer(t);
    final TimelineEntry row = r.timeline.entries.single;
    await t.runAsync(() async {
      final String id = r.frames.single['request_id']! as String;
      await r.c.outbox.settle(correlationId: id, ok: false, code: 'OUTBOX_OVERFLOW');
    });
    await _flush(t);
    expect(r.c.outbox.owedEntryIds, isNot(contains(row.id)), reason: 'premise: given up');
    expect(_bannerResend, findsOneWidget);

    await t.tap(_bannerResend);
    await t.pump();
    await _elapse(t, const Duration(seconds: 2));

    expect(r.frames.map((Map<Object?, Object?> f) => f['request_id']).toSet(), hasLength(2));
    expect(r.frames.last['text'], _words);
    await r.close(t);
  }, timeout: const Timeout(Duration(minutes: 2)));
}
