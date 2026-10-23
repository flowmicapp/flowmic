// NR-286 — the PRODUCTION wiring of the retry-while-connected rule (doc 15
// `15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md` §2.6-a), end to end through a
// real ChatController: real outbox, real 20 s row watchdog, real 45 s queue
// watchdog, real backoff table, the real link predicate passed by
// chat_controller_wiring.dart — and the row rendered (D-15) at the two moments
// the user looks at it.
//
// The device case it reproduces (0.3.116, 2026-10-20, report.md A1): the phone
// stays in the room, the computer swallows the first frame and says nothing,
// then recovers. Before NR-286 the second frame only left when the user left
// the chat and came back (6.5 minutes on the device); here nobody navigates.
//
// The queue rules in isolation (backoff shape, link-down, origins, no
// duplicate in flight, reset) are in test/outbox_no_answer_retry_test.dart.

import 'dart:async' show unawaited;

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/compose_gate.dart' show ComposeSendFailure;
import 'package:flowmic/src/session/delivery_outbox.dart'
    show kOutboxInflightTimeout, kOutboxNoAnswerRetryBackoff;
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show SendPolicy;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/status_badge.dart'
    show DeliveryFace, StatusMeta, deliveryFaceMeta, deliveryFaceOf;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
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
    // Rows are owned by the paired session, as in production; without it the
    // chat SCREEN (review N5) narrows them away and renders none.
    timeline = newTestStore(owner: _SessionOwner(session));
    controller = ChatController(
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
  late final ChatController controller;

  List<Map<Object?, Object?>> get injectFrames => <Map<Object?, Object?>>[
    for (final EventEnvelope e in transport.emitted)
      if (e.name == FlowMicEvents.injectRequest && e.data is Map)
        e.data! as Map<Object?, Object?>,
  ];

  Future<void> dispose() async {
    await controller.dispose();
    await session.dispose();
    timeline.dispose();
    await transport.close();
  }
}

Future<void> _flush(WidgetTester tester) async {
  for (int i = 0; i < 12; i++) {
    await tester.pump();
  }
}

/// Advance the fake clock in one-second steps so every timer due inside the
/// span fires in order and its async tail runs before the next one.
Future<void> _elapse(WidgetTester tester, Duration span, {Duration step = const Duration(seconds: 1)}) async {
  Duration done = Duration.zero;
  while (done < span) {
    final Duration d = span - done < step ? span - done : step;
    await tester.pump(d);
    done += d;
  }
  await _flush(tester);
}

/// The pill exactly as `ChatMessageTile` paints it: glyph, space, word.
String _pillOf(TimelineEntry e, _Rig rig, AppStrings s) {
  final DeliveryFace face = deliveryFaceOf(
    e,
    queued: rig.controller.queuedEntryIds.contains(e.id),
    owed: rig.controller.owedEntryIds.contains(e.id),
  );
  final StatusMeta m = deliveryFaceMeta(face, s);
  return '${m.glyph} ${m.label}';
}

Widget _tile(TimelineEntry e, _Rig rig, AppStrings s) => MaterialApp(
  home: Scaffold(
    body: ChatMessageTile(
      entry: e,
      strings: s,
      // The same two reads the chat list makes (chat_flow_scroll.dart).
      queued: rig.controller.queuedEntryIds.contains(e.id),
      owed: rig.controller.owedEntryIds.contains(e.id),
      canResendImage: true,
      onRetry: (TimelineEntry _) {},
    ),
  ),
);

/// Typed words, the device case (the "+" panel's saved phrase goes through
/// `deliverText` → enqueue → drain, i.e. the queue's own `_attempt`).
Future<void> _sendTyped(_Rig rig, WidgetTester tester) async {
  unawaited(rig.controller.sendFavorite('电脑卡住了一会儿'));
  await _flush(tester);
}

/// Speech in Direct send, the main use: `_deliverDirect` enqueues and emits the
/// first frame BESIDE the queue (no item watchdog of its own).
Future<void> _speak(_Rig rig, WidgetTester tester) async {
  rig.session.segments.clear();
  unawaited(rig.controller.pttDown());
  unawaited(rig.controller.pttUp());
  rig.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
    'text': '电脑卡住了一会儿', 'confidence': 0.95, 'language': 'zh',
    'segment_idx': 0, 'is_segment': false, 'duration_ms': 1200,
  });
  await _flush(tester);
}

Future<void> _scenario(
  WidgetTester tester, {
  required Future<void> Function(_Rig, WidgetTester) send,
  required DeliveryFace faceAt21s,
}) async {
  final AppStrings en = AppStrings.of(AppLocale.en);
  final _Rig rig = _Rig();
  await rig.controller.outbox.load();
  rig.transport.pushStatus(SocketStatus.connected);
  rig.session.noteRoomJoined(atHomeNode: true);
  await _flush(tester);

  // ── the frame leaves and nothing comes back ─────────────────────────────
  await send(rig, tester);
  expect(rig.injectFrames, hasLength(1), reason: 'premise: the first attempt went out');
  final Object? rid = rig.injectFrames.single['request_id'];
  expect(rid, isA<String>());

  // ── 21 s: what the row says while nobody has answered, rendered ─────────
  await _elapse(tester, const Duration(seconds: 21));
  final TimelineEntry waiting = rig.timeline.entries.single;
  final DeliveryFace face = deliveryFaceOf(
    waiting,
    queued: rig.controller.queuedEntryIds.contains(waiting.id),
    owed: rig.controller.owedEntryIds.contains(waiting.id),
  );
  expect(face, faceAt21s, reason: 'premise: the pending state this path shows');
  await tester.pumpWidget(_tile(waiting, rig, en));
  expect(find.text(_pillOf(waiting, rig, en)), findsOneWidget);
  expect(find.textContaining('✗'), findsNothing, reason: 'an owed row is never drawn as a failure');
  await tester.pumpWidget(const SizedBox());

  // ── 45 s: back in the queue; then the retry, with nobody touching anything
  await _elapse(tester, kOutboxInflightTimeout - const Duration(seconds: 21));
  expect(rig.injectFrames, hasLength(1),
      reason: 'nothing is re-sent inside the first 45 s budget');
  await _elapse(tester, kOutboxNoAnswerRetryBackoff.first + const Duration(seconds: 1));
  expect(
    rig.injectFrames,
    hasLength(2),
    reason: 'the phone stayed in the room and the queue never tried again — '
        'report.md A1: pending for 6.5 minutes until the user navigated',
  );
  final Map<Object?, Object?> retry = rig.injectFrames.last;
  expect(retry['request_id'], rid, reason: 'the retry is the SAME delivery (the PC dedups by id)');
  expect(retry['inject_origin'], 'live',
      reason: 'about 50 s after the words and never promised ⇒ still live (doc 15 §2.6-a rule 2)');

  // ── the computer recovered and answers the retry ─────────────────────────
  rig.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
    'ok': true,
    'mode': 'sendinput',
    'request_id': rid,
    'entry_id': retry['entry_id'],
    'inject_target': <String, Object?>{
      'window_title': 'Untitled - gedit',
      'process_name': 'gedit',
      'injected_at': 'now',
    },
  });
  await _flush(tester);
  final TimelineEntry done = rig.timeline.entries.single;
  expect(done.status, EntryStatus.injected);
  expect(rig.controller.owedEntryIds, isEmpty, reason: 'the queue no longer owes it');
  expect(rig.controller.outbox.pendingCountTotal, 0, reason: 'the banner count is back to zero');

  // ── once: an hour later nothing else has gone out ───────────────────────
  await _elapse(tester, const Duration(minutes: 60), step: const Duration(minutes: 1));
  expect(rig.injectFrames, hasLength(2), reason: 'delivered once; no retry after an answer');

  // Rendered: the row now wears the delivered face, not a pending one.
  final DeliveryFace doneFace = deliveryFaceOf(done, queued: false, owed: false);
  expect(doneFace, DeliveryFace.injected);
  await tester.pumpWidget(_tile(done, rig, en));
  expect(find.text(_pillOf(done, rig, en)), findsOneWidget);
  expect(find.text('⏳ ${en.statusNoAnswerYet}'), findsNothing);
  await tester.pumpWidget(const SizedBox());

  // Teardown waits on both clocks: the in-memory stores settle on the real
  // one, the session's capture shutdown on the fake one that started it.
  bool disposed = false;
  unawaited(rig.dispose().then((_) => disposed = true));
  for (int i = 0; i < 200 && !disposed; i++) {
    await tester.pump(const Duration(seconds: 1));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
  }
  expect(disposed, isTrue, reason: 'fixture: teardown finished');
}

/// MAIN 2026-10-20 (doc 15 §2.6-a rule 8): the computer never answers. The
/// first 20 s timeout raises 「No answer from the computer」 once; the queue's
/// automatic re-sends of the row that already shows no-answer raise it NO
/// MORE; a user's own resend still behaves as before (positive control).
/// The row is also rendered through the MOUNTED chat screen (review N5).
Future<void> _quietScenario(WidgetTester tester) async {
  final AppStrings zh = AppStrings.of(AppLocale.zh); // ChatFlowPage's default
  final _Rig rig = _Rig();
  await rig.controller.outbox.load();
  rig.transport.pushStatus(SocketStatus.connected);
  rig.session.noteRoomJoined(atHomeNode: true);
  await _flush(tester);

  int raises = 0;
  bool up = false;
  Future<void> watch(Duration span) async {
    for (Duration t = Duration.zero; t < span; t += const Duration(seconds: 1)) {
      await tester.pump(const Duration(seconds: 1));
      final bool now = rig.controller.sendFailure == ComposeSendFailure.noResult;
      if (now && !up) raises++;
      up = now;
    }
    await _flush(tester);
  }

  await _sendTyped(rig, tester);
  expect(rig.injectFrames, hasLength(1), reason: 'premise: the first attempt went out');

  await watch(const Duration(seconds: 21));
  expect(raises, 1, reason: 'positive control: the first timeout raises the banner');

  // N5 — the row as the chat SCREEN paints it (not a standalone tile).
  await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: rig.controller)));
  await _flush(tester);
  expect(find.text('⏳ ${zh.statusNoAnswerYet}'), findsOneWidget,
      reason: 'the mounted chat screen shows the pending no-answer pill on the row');
  expect(find.text('✗ ${zh.statusFailed}'), findsNothing,
      reason: 'an owed row is never drawn as a failure on the chat screen');
  await tester.pumpWidget(const SizedBox());
  await _flush(tester);

  // Four automatic re-sends (≈ 50 / 110 / 185 / 290 s), each unanswered.
  await watch(const Duration(seconds: 330));
  expect(rig.injectFrames.length, greaterThanOrEqualTo(5),
      reason: 'premise: the queue kept re-sending while the computer stayed silent');
  expect(raises, 1,
      reason: 'each automatic re-send re-raised 「No answer from the computer」 '
          '(the banner flashed once per retry)');

  // Positive control: the USER presses resend on that row ⇒ today's behaviour.
  final TimelineEntry row = rig.timeline.entries.single;
  rig.controller.resendEntry(row);
  await _flush(tester);
  await watch(const Duration(seconds: 21));
  expect(raises, 2, reason: "a user's own resend still raises the banner when unanswered");

  rig.controller.session.debugStopIdlePresencePoll();
  bool disposed = false;
  unawaited(rig.dispose().then((_) => disposed = true));
  for (int i = 0; i < 200 && !disposed; i++) {
    await tester.pump(const Duration(seconds: 1));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
  }
  expect(disposed, isTrue, reason: 'fixture: teardown finished');
}

void main() {
  testWidgets(
    '🔴 typed words (the device case): the computer stays connected, swallows the frame, '
    'recovers — re-sent with nobody navigating, Delivered once',
    (WidgetTester tester) => _scenario(
      tester,
      send: _sendTyped,
      faceAt21s: DeliveryFace.noAnswerYet,
    ),
    timeout: const Timeout(Duration(minutes: 2)),
  );

  testWidgets(
    '🔴 speech in Direct send: the first frame left beside the queue, the computer swallows it '
    'and recovers — re-sent with nobody navigating, Delivered once',
    (WidgetTester tester) => _scenario(
      tester,
      send: _speak,
      // No row watchdog on the live speech emit (pre-existing): the row says
      // 「Pending · queued」 until the queue's own attempt arms one.
      faceAt21s: DeliveryFace.queued,
    ),
    timeout: const Timeout(Duration(minutes: 2)),
  );

  testWidgets(
    '🔴 MAIN 2026-10-20: automatic re-sends of a row already showing no-answer do not '
    're-raise the banner; a user resend still does; row rendered on the chat screen',
    _quietScenario,
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
