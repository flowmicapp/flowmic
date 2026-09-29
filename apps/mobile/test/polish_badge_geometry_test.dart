// NR-122b (D-15): the polish badge must be READABLE on a real row, not merely
// present. Owner's 0.3.98 screenshot: a "delivered / not injected" row with a
// resend link and long provenance had its polish badge drawn on top of the
// status line (a Positioned corner overlay), and the resend link and
// provenance showed through the translucent fill.
//
// `polish_badge_screen_test.dart` and `chat_ui_widget_test.dart` only assert
// that the badge text exists (`find.text`), which is true for the broken
// layout as well. This file mounts the real ChatFlowPage on a 360 dp phone and
// asserts on RENDERED geometry: rects, containment in the card, paragraph
// clipping. Reverse control: put the `Positioned` overlay back in
// chat_message_tile.dart and this file goes red.

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
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart' show SessionOwnerProbe;
import 'support/di.dart';
import 'support/fakes.dart';

class _Rig {
  _Rig() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    store = newTestStore(owner: SessionOwnerProbe(session));
    destination = DestinationController();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    transport.pushStatus(SocketStatus.connected);
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  /// One real utterance whose polish failed (`llm_error` => the real
  /// `polishUnavailable` badge), then the PC's verdict "delivered, not
  /// injected" with a long PC name and a long target window title.
  Future<TimelineEntry> deliveredNotInjectedRowWithBadge() async {
    expect(await controller.pttDown(), isTrue);
    await controller.pttUp();
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '这是一句用来检查布局的识别原文',
      'confidence': .95,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 500,
      'polish': 'skipped',
      'polish_reason': 'llm_error',
    });
    await pumpEventQueue();
    final TimelineEntry row = store.entries.single;
    expect(
      store.applyInjectResult(
        correlationId: row.id,
        ok: false,
        target: const InjectTarget(
          windowTitle: 'FlowMic Very Long Window Title For The Target Window',
          processName: 'flowmic-long-process.exe',
          injectedAt: '2026-09-29T09:00:00Z',
        ),
        pcName: 'Office-Workstation-With-A-Very-Long-Name',
        failureReason: 'INJECT_FOCUS_LOST',
        wireMode: 'cached',
      ),
      isTrue,
    );
    await pumpEventQueue();
    return store.findById(row.id)!;
  }

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  for (final double scale in <double>[1.0, 1.3]) {
    testWidgets(
      'NR-122b real chat @360dp, text scale $scale: polish badge sits below '
      'the meta row and overlaps nothing',
      (WidgetTester tester) async {
        late _Rig rig;
        late TimelineEntry row;
        await tester.runAsync(() async {
          rig = _Rig();
          await pumpEventQueue();
          row = await rig.deliveredNotInjectedRowWithBadge();
        });
        tester.view.physicalSize = const Size(360, 2400);
        tester.view.devicePixelRatio = 1.0;
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.view.reset);
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        await tester.pumpWidget(
          MaterialApp(home: ChatFlowPage(controller: rig.controller)),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));

        final AppStrings strings = AppStrings.of(AppLocale.zh);
        final String label = strings.polishUnavailable;

        // Positive controls: every probe below must have found its subject,
        // otherwise a zero-overlap result would just mean the probe is blind.
        expect(find.byType(ChatMessageTile), findsOneWidget);
        final Finder badge = find.byType(PolishSkippedMark);
        expect(badge, findsOneWidget);
        final Finder badgeText = find.descendant(
          of: badge,
          matching: find.text(label),
        );
        expect(badgeText, findsOneWidget);
        final Finder status = find.textContaining('未注入');
        expect(status, findsOneWidget);
        final Finder resend = find.byKey(
          ValueKey<String>('entry.resend.${row.id}'),
        );
        expect(resend, findsOneWidget);
        final Finder provenance = find.textContaining('Very Long Window');
        expect(provenance, findsOneWidget);
        final Finder card = find.byWidgetPredicate(
          (Widget w) =>
              w is Container &&
              w.decoration is BoxDecoration &&
              (w.decoration! as BoxDecoration).borderRadius ==
                  BorderRadius.circular(18),
        );
        expect(card, findsOneWidget);

        final Rect badgeRect = tester.getRect(badge);
        final Rect statusRect = tester.getRect(status);
        final Rect resendRect = tester.getRect(resend);
        final Rect provRect = tester.getRect(provenance);
        final Rect cardRect = tester.getRect(card);

        expect(
          badgeRect.overlaps(statusRect),
          isFalse,
          reason: 'badge $badgeRect must not cover status $statusRect',
        );
        expect(
          badgeRect.overlaps(resendRect),
          isFalse,
          reason: 'badge $badgeRect must not cover resend $resendRect',
        );
        expect(
          badgeRect.overlaps(provRect),
          isFalse,
          reason: 'badge $badgeRect must not cover provenance $provRect',
        );
        expect(
          badgeRect.left >= cardRect.left &&
              badgeRect.right <= cardRect.right &&
              badgeRect.top >= cardRect.top &&
              badgeRect.bottom <= cardRect.bottom,
          isTrue,
          reason: 'badge $badgeRect must lie inside card $cardRect',
        );

        // Rendered text: not clipped, not truncated.
        final RenderParagraph paragraph = tester.renderObject<RenderParagraph>(
          badgeText,
        );
        expect(paragraph.didExceedMaxLines, isFalse);
        expect(paragraph.size.width, lessThanOrEqualTo(badgeRect.width));
        expect(paragraph.size.height, lessThanOrEqualTo(badgeRect.height));
        // Status and resend must be fully readable: inside the card, and their
        // rendered paragraphs neither truncated nor over the line limit
        // (D-15: assert on the render, not on Text.data).
        for (final Rect r in <Rect>[statusRect, resendRect, provRect]) {
          expect(
            r.left >= cardRect.left && r.right <= cardRect.right,
            isTrue,
            reason: 'meta chip $r must stay inside card $cardRect',
          );
        }
        for (final Finder f in <Finder>[status, resend]) {
          final RenderParagraph rp = tester.renderObject<RenderParagraph>(
            find.descendant(of: f, matching: find.byType(RichText)).first,
          );
          expect(rp.didExceedMaxLines, isFalse);
          expect(rp.size.width, greaterThan(0));
        }
        // Any RenderFlex overflow anywhere on the screen fails the test.
        expect(tester.takeException(), isNull);

        await tester.pumpWidget(const SizedBox());
        await tester.runAsync(rig.dispose);
      },
    );
  }
}
