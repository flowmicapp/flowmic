// P4 (0.3.1) acceptance — the edit sheet's COMMIT button tells the truth per
// mode (docs/strategy/2026-08-15-031-fix-batch-design.md §6):
//   · PC target ⇒ 「投递 ➤」 and an inject:request on tap (unchanged control);
//   · fixed destination (light-record / cloud) ⇒ 「保存」, a LOCAL noted row,
//     zero frames — the word 「投递」 may not stand on a button with no
//     delivery mechanism behind it (15 §2.0);
//   · PC target with the link down ⇒ the disabled-LOOKING button still
//     answers the tap and the `notConnected` raise lands on the banner state
//     (PA-1's dead-control ban, compose_band.dart precedent).
//
// The data-layer half (noted row, no frame, reverse control run RED first) is
// pinned in typed_send_row_test.dart; this file pins the FACES.
//
// 🔴 All cases run on the REAL ChatFlowPage + REAL ChatController (0.2.51 law).

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart'
    show EventEnvelope, SocketStatus;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

final Finder _sheet = find.byKey(const ValueKey<String>('compose.card'));
final Finder _commit =
    find.byKey(const ValueKey<String>('compose.card.deliver'));
final Finder _field = find.byKey(const ValueKey<String>('compose.field'));

class _Page {
  _Page(this.transport, this.controller);
  final FakeSocketTransport transport;
  final ChatController controller;

  List<EventEnvelope> get injects =>
      transport.emittedWhere(FlowMicEvents.injectRequest);
}

/// Same shape as edit_sheet_test's `_pumpPage`, plus the two axes this card
/// is about: `cloudInstance` (fixed record-only destination) and `connect`
/// (the link-down face needs a page that was never / no longer connected).
Future<_Page> _pumpPage(
  WidgetTester tester, {
  bool cloudInstance = false,
  bool connect = true,
}) async {
  tester.view.physicalSize = const Size(360 * 3, 780 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);

  final FakeSocketTransport transport = FakeSocketTransport();
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  giveSessionAPairedIdentity(session);
  final ChatController controller = ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: newTestStore(),
    destination: DestinationController(fixedRecordOnly: cloudInstance),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.manual),
  );
  addTearDown(() async {
    await controller.dispose();
    controller.destination.dispose();
    controller.store.dispose();
    await session.dispose();
    await transport.close();
  });
  await controller.loadSendPolicy();
  if (connect) transport.pushStatus(SocketStatus.connected);
  await tester.pumpWidget(
    MaterialApp(home: ChatFlowPage(controller: controller)),
  );
  await tester.pump();
  return _Page(transport, controller);
}

void main() {
  testWidgets('P4: on a fixed destination the commit button reads 「保存」 — '
      'no 「投递」, no ➤ glyph — and the tap mints a LOCAL noted row with zero '
      'frames', (WidgetTester tester) async {
    final _Page p = await _pumpPage(tester, cloudInstance: true);
    p.controller.setBuffer('轻记录里手输的一句');
    await tester.pump();
    expect(_sheet, findsOneWidget);

    // The face: the save word, and neither the deliver word nor its glyph
    // anywhere inside the commit control.
    expect(
      find.descendant(of: _commit, matching: find.text(_zh.composeCardSaveNoted)),
      findsOneWidget,
      reason: 'P4: a fixed destination commits locally, so the button must '
          'say so (保存), not promise a delivery',
    );
    expect(
      find.descendant(of: _commit, matching: find.text(_zh.composeCardDeliver)),
      findsNothing,
      reason: '🔴 「投递」 on a button with no delivery mechanism behind it '
          'is the 15 §2.0 red line, verbatim',
    );
    expect(
      find.descendant(of: _commit, matching: find.text('➤')),
      findsNothing,
      reason: 'the send glyph travels with the send, not with the button',
    );

    await tester.tap(_commit);
    await tester.pump();
    expect(_sheet, findsNothing, reason: 'a successful commit collapses, same as deliver');
    expect(p.controller.buffer, isEmpty);
    final TimelineEntry row = p.controller.store.entries.single;
    expect(row.sourceText, '轻记录里手输的一句');
    expect(row.status, EntryStatus.noted);
    expect(row.delivery, Delivery.none);
    expect(
      p.injects,
      isEmpty,
      reason: 'no frame may leave for a local save — the PC-target case below '
          'is this assertion\'s positive control',
    );
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('control: with a PC target the button still reads 「投递 ➤」 and '
      'the tap still emits — byte-identical to the pre-P4 face', (
    WidgetTester tester,
  ) async {
    final _Page p = await _pumpPage(tester);
    p.controller.setBuffer('要投递的内容');
    await tester.pump();

    expect(
      find.descendant(of: _commit, matching: find.text(_zh.composeCardDeliver)),
      findsOneWidget,
    );
    expect(
      find.descendant(of: _commit, matching: find.text('➤')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: _commit, matching: find.text(_zh.composeCardSaveNoted)),
      findsNothing,
    );

    await tester.tap(_commit);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(
      p.injects,
      hasLength(1),
      reason: 'positive control: the same fake transport records the frame a '
          'PC-target deliver emits',
    );
    // Burn the delivery watchdogs the real send armed (edit_sheet_test's own
    // idiom), so no timer outlives the test body.
    await tester.pump(const Duration(seconds: 46));
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('P4: PC target + draft + link DOWN — the disabled-looking '
      'button still answers the tap: sendBuffer raises notConnected, zero '
      'frames, the draft survives', (WidgetTester tester) async {
    final _Page p = await _pumpPage(tester);
    p.controller.setBuffer('断线时写的草稿');
    await tester.pump();
    expect(_sheet, findsOneWidget);

    p.transport.pushStatus(SocketStatus.disconnected);
    await tester.pump();
    expect(p.controller.canSend, isFalse,
        reason: 'PC-target control: the link term still gates the commit');
    // The face keeps the deliver identity (there IS a PC, the link is what
    // is missing) — swapping to 保存 here would promise a local save that
    // does not happen on this leg.
    expect(
      find.descendant(of: _commit, matching: find.text(_zh.composeCardDeliver)),
      findsOneWidget,
    );

    await tester.tap(_commit);
    await tester.pump();
    // The tap went through the SAME sendBuffer path; its first wire gate
    // raised the persistent banner state — not a swallowed dead tap.
    expect(
      p.controller.sendFailure,
      ComposeSendFailure.notConnected,
      reason: '🔴 a dead button with no explanation is the silent half of '
          'the defect P4 closes',
    );
    expect(p.injects, isEmpty);
    expect(p.controller.store.entries, isEmpty,
        reason: 'no phantom row on a refused send (D10 blocked path)');
    expect(p.controller.buffer, '断线时写的草稿',
        reason: 'the draft is kept — it shows in the preview strip');
    expect(_sheet, findsNothing,
        reason: 'the collapse is what keeps the raised banner readable');

    // Cancel the sessionLost countdown armed by the disconnect before the
    // pending-timer check (the reconnect edge is its production canceller),
    // and release the banner auto-hide timers the two edges reconciled into
    // existence (the link_loss_banner_test teardown precedent).
    p.transport.pushStatus(SocketStatus.connected);
    await tester.pump();
    debugCancelBannerAutoHideTimers(p.controller);
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('P4 alignment: the FIELD follows the same leg split as the '
      'button — enabled offline on a fixed destination, disabled offline '
      'with a PC target', (WidgetTester tester) async {
    // Fixed destination, never connected: typing and saving are both local,
    // so the field must accept keystrokes (the old canCompose-only predicate
    // would grey it out for a link the commit does not need).
    final _Page cloud = await _pumpPage(
      tester,
      cloudInstance: true,
      connect: false,
    );
    cloud.controller.setBuffer('离线轻记录草稿');
    await tester.pump();
    expect(_sheet, findsOneWidget);
    expect(
      tester.widget<TextField>(_field).enabled,
      isTrue,
      reason: 'P4: on a fixed destination the field and the button both '
          'answer 「能不能提交」 without a link term',
    );
    expect(cloud.controller.canSend, isTrue);
    cloud.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('P4 alignment control: PC target offline keeps the FIELD '
      'disabled (byte-identical to the pre-P4 predicate)', (
    WidgetTester tester,
  ) async {
    final _Page p = await _pumpPage(tester);
    p.controller.setBuffer('有 PC 的草稿');
    await tester.pump();
    expect(_sheet, findsOneWidget);
    expect(tester.widget<TextField>(_field).enabled, isTrue);

    p.transport.pushStatus(SocketStatus.disconnected);
    await tester.pump();
    expect(
      tester.widget<TextField>(_field).enabled,
      isFalse,
      reason: 'a disconnected phone has no PC to type at — unchanged',
    );

    p.transport.pushStatus(SocketStatus.connected);
    await tester.pump();
    p.controller.session.debugStopIdlePresencePoll();
  });
}
