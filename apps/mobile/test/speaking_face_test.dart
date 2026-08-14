// 🔴 T-4 (0.2.63) accept — speaking-face unification: while speaking the lower
// edge is only PttBar + RecordingPanel, and the live-draft row is in the
// viewport at the moment the mouth opens.
//
// Contract＝docs/ui-design/2026-08-13-compose-band-redesign.md §3 (S5/S6/S7 and
// 「S5 的一个真缺口」) and §9 ⑤⑧; task book＝§2-6 T-4.
// The "liveText has only one render site" case lives in
// live_interim_single_render_site_test.dart.
//
// ── Reverse control (measured red, then reverted) ───────────────────────────
// ① Change row 2's yield condition back to only recognizing `_editHold` ⇒ this
//    file's S5 case goes red;
// ② Delete the snap-to-bottom line inside `_pttDownRouted` ⇒ the "open mouth
//    snaps to bottom" case goes red.
// Verbatim in this round's return report; both reverted and green again.
//
// ⚠️ PTT is driven the same way as expanded_compose_test.dart (unawaited + pump,
// teardown must not await); the reasons are written item-by-item on that file's
// `_pumpPage`. Restated here in one sentence: an **accepted** pttDown drags a
// real async chain into the FakeAsync zone.

import 'dart:async';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/compose_band.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

final Finder _preview = find.byKey(const ValueKey<String>('compose.preview'));
final Finder _keysGroup =
    find.byKey(const ValueKey<String>('compose.keys.group'));
final Finder _enterKey =
    find.byKey(const ValueKey<String>('compose.ctrl.enter'));
final Finder _timeline = find.byKey(const ValueKey<String>('chat.timeline'));

/// The band alone — the S5/S6 geometry is a property of the band and needs no
/// session. (The page-level half of the same states is covered by the scroll
/// case below, which runs on a real page.)
///
/// PA-1: the band's constructor lost the send/policy inputs with the controls
/// themselves (SUP-2/SUP-3) — the policy chip is a row-1 / page concern now.
Future<void> _pumpBand(
  WidgetTester tester, {
  required PttVisual visual,
  SendPolicy policy = SendPolicy.direct,
  String buffer = '',
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Align(
          alignment: Alignment.bottomCenter,
          child: ComposeBand(
            buffer: buffer,
            strings: AppStrings.of(AppLocale.zh),
            enabled: true,
            visual: visual,
            onExpand: () {},
            onControlKey: (_) => true,
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

/// Session owner probe — the chat list narrows to the CONNECTED instance, so a
/// harness that seeds rows must stamp them through the same probe production
/// uses, or the list it scrolls is empty (chat_stick_bottom_widget_test.dart).
class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

class _Page {
  _Page(this.controller, this.transport);
  final ChatController controller;
  final FakeSocketTransport transport;
}

Future<_Page> _pumpPage(WidgetTester tester, {required int rows}) async {
  tester.view.physicalSize = const Size(360 * 3, 780 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);

  final FakeSocketTransport transport = FakeSocketTransport();
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  transport.connectSucceeds = true;
  transport.ackQueue.add(<String, Object?>{
    'token': 'tok-speak-000000000000000000000000',
    'pc_name': 'Widget PC',
    'pc_instance_id': 'inst-speak',
  });
  final PairResult pair = await session.pair(
    PairEntry.parse('1234'),
    endpoint: 'ws://192.0.2.5:41879',
  );
  expect(pair.ok, isTrue, reason: 'harness pair failed: ${pair.error}');
  final TimelineStore store = newTestStore(owner: _SessionOwner(session));
  final ChatController controller = ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: store,
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(),
  );
  // 🔴 SYNCHRONOUS teardown — a live capture makes the awaits inside dispose()
  // unresolvable in FakeAsync (expanded_compose_test.dart's `liveCapture` doc,
  // link_loss_banner_test.dart's `_Rig.teardownSync`).
  addTearDown(() {
    unawaited(controller.dispose());
    controller.destination.dispose();
    store.dispose();
  });
  for (int i = 0; i < rows; i++) {
    store.buildFromUtterance(
      clientId: 'seed-$i',
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      text: '历史消息 #$i — ${'字' * 24}',
    );
  }
  transport.pushStatus(SocketStatus.connected);
  await tester.pumpWidget(
    MaterialApp(home: ChatFlowPage(controller: controller)),
  );
  await tester.pump();
  return _Page(controller, transport);
}

ScrollController _scrollOf(WidgetTester tester) =>
    tester.widget<ListView>(_timeline).controller!;

void main() {
  testWidgets('🔴 S5 (contract §9 ⑤): while speaking the whole lower edge is zero-height — row 2 and the key group both yield', (
    WidgetTester tester,
  ) async {
    await _pumpBand(tester, visual: PttVisual.recording);

    expect(_preview, findsNothing, reason: '🔴 while speaking, row 2 still paints the preview bar');
    expect(_keysGroup, findsNothing);
    expect(_enterKey, findsNothing);

    // 🔴 The criterion is **measured**: the whole band is zero-height. Asserting
    // "those keys are not found" still leaves room for a half-measure like
    // "yielded but left an 8px gap", and the design book says yield, not shrink.
    expect(
      tester.getSize(find.byType(ComposeBand)).height,
      0,
      reason: '🔴 while speaking the lower edge is not zero-height ⇒ something '
          'that says nothing is still sitting above PttBar',
    );
  });

  testWidgets('🔴 S6: manual + an existing draft + speaking — the whole band is zero-height the same way', (
    WidgetTester tester,
  ) async {
    await _pumpBand(
      tester,
      visual: PttVisual.recording,
      policy: SendPolicy.manual,
      buffer: '已经说了一段',
    );
    expect(_enterKey, findsNothing);
    expect(tester.getSize(find.byType(ComposeBand)).height, 0);
  });

  testWidgets('🔴 SUP-4 (Plan A′ §2): the key group yields **also** during processing — '
      'the whole band is zero-height, the same face as recording', (WidgetTester tester) async {
    // 🔴 RED-BY-DESIGN FLIP (contract §7): the 0.2.63 case here asserted the
    // keys STAYED during processing (supplement #2 read literally as 「非
    // recording」). Plan A′ key state ⑤ answers the question that reading left
    // open (compose-band contract §10-1) in the HIDE direction: the processing
    // dock is amber PTT + caption only. SUP-4 is the ruling; this case now
    // guards the new predicate's processing edge.
    await _pumpBand(tester, visual: PttVisual.processing);

    expect(
      _preview,
      findsNothing,
      reason: '🔴 the box popped back between release and the final ⇒ the user '
          'thinks they can start editing, and at that moment the buffer is still empty',
    );
    expect(
      _enterKey,
      findsNothing,
      reason: '🔴 SUP-4: the processing dock is amber PTT + one caption, the '
          'key group must not flash back and vanish in these 1–2 seconds',
    );
    expect(tester.getSize(find.byType(ComposeBand)).height, 0);
  });

  testWidgets('🔴 idle positive control: when not speaking, row 2 and the key group are both there (the findsNothing cases above are not because this widget paints nothing at all)', (WidgetTester tester) async {
    await _pumpBand(tester, visual: PttVisual.idle);
    expect(_preview, findsOneWidget);
    expect(_keysGroup, findsOneWidget);
    expect(_enterKey, findsOneWidget);
    expect(tester.getSize(find.byType(ComposeBand)).height, greaterThan(0));
  });

  testWidgets('🔴 T-4 ③ (contract §9 ⑧): scrolled away from the bottom before speaking ⇒ snap to bottom once at the moment the mouth opens, '
      'the live-draft row is in the viewport', (WidgetTester tester) async {
    final _Page p = await _pumpPage(tester, rows: 14);
    final ScrollController sc = _scrollOf(tester);

    // Premise: this screen can actually scroll, and we really did scroll away
    // from the bottom.
    expect(
      sc.position.maxScrollExtent,
      greaterThan(300),
      reason: 'premise failed: not enough seeded rows to scroll away from the bottom',
    );
    sc.jumpTo(300);
    await tester.pump();
    expect(sc.offset, 300);
    // reverse: true ⇒ offset 0 is the **visual bottom**, 300 is "flipped up to
    // look at history".
    expect(
      find.byKey(const ValueKey<String>('chat.backToBottom')),
      findsOneWidget,
      reason: 'positive control: the page itself also thinks the user has scrolled away from the bottom',
    );

    // Open the mouth — go through the callback production wired on (`() => _pttDownRouted(s)`).
    final PttBar bar = tester.widget<PttBar>(find.byType(PttBar));
    unawaited(bar.onDown!());
    await tester.pump();
    await tester.pump();
    expect(p.controller.isRecording, isTrue, reason: 'premise failed: this press was not accepted');

    // A 200ms animation (the same path as the "back to bottom" button).
    await tester.pump(const Duration(milliseconds: 250));
    expect(
      sc.offset,
      0,
      reason: '🔴 the mouth opened but the viewport is still parked in history ⇒ '
          'the user cannot see the words grow while speaking, and "seeing the '
          'words grow" is the entirety of this card',
    );
    // The other half of the criterion: that row is **really** in the viewport,
    // not merely that offset went to zero.
    expect(find.byType(LiveDraftTile), findsOneWidget);
    final Rect live = tester.getRect(find.byType(LiveDraftTile));
    final Rect view = tester.getRect(_timeline);
    expect(live.top, greaterThanOrEqualTo(view.top - 0.5));
    expect(live.bottom, lessThanOrEqualTo(view.bottom + 0.5));

    unawaited(p.controller.pttCancel());
    await tester.pump();
    p.controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 reverse gate: a **refused** press must not move the viewport (it produces nothing to look at)', (
    WidgetTester tester,
  ) async {
    // This case guards the `if (!ok) return` inside `_pttDownRouted` — without
    // it, every PTT press that does not take would fling the history the user
    // is reading back to the bottom.
    //
    // ⚠️ The way we manufacture "refused" is deliberately a **second press**
    // (`canPtt` requires `_sess == idle`), not dropping the link: dropping the
    // link would wind the reconnect ladder and the link-loss grace timers, and
    // `AutomatedTestWidgetsFlutterBinding` inspects pending Timers the moment
    // the tree is torn down — the measured failure of writing it that way this
    // round was `A Timer is still pending even after the widget
    // tree was disposed`, **it reads like the assertion was wrong, when the
    // assertions had all passed**.
    final _Page p = await _pumpPage(tester, rows: 14);
    final ScrollController sc = _scrollOf(tester);
    final PttBar bar = tester.widget<PttBar>(find.byType(PttBar));

    // First press: accepted (this half also re-proves the case above).
    unawaited(bar.onDown!());
    await tester.pump();
    await tester.pump();
    expect(p.controller.isRecording, isTrue);

    // Jump back into history, then press again — this time the FSM is not idle,
    // so it must be refused.
    sc.jumpTo(300);
    await tester.pump();
    unawaited(bar.onDown!());
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));

    expect(
      sc.offset,
      300,
      reason: '🔴 a refused press flung the viewport back to the bottom — the '
          'user said nothing, yet lost the place they were reading',
    );

    unawaited(p.controller.pttCancel());
    await tester.pump();
    p.controller.session.debugStopIdlePresencePoll();
  });
}
