// 0.3.122 — picking Translate while the target IS the spoken language opens the
// target picker on the transcription screen.
//
// SPEC-REF:
//   lib/src/ui/chat_flow_composer.dart `_onModeSelectedRouted` (the trigger)
//   lib/src/ui/mode_chip.dart `showTranslateTargetPicker` (the sheet)
//   docs/marketing/05b-defects-found.md, 2026-11-07 later: 「a new English
//     install translates English to English until the target is changed」
//
// Anti-façade ⑥: the deliverable is what the user sees on the chat screen after
// a tap on the Translate segment, so the real ChatFlowPage is mounted and the
// segment is tapped; nothing calls `setMode` directly.
//
// REVERSE CONTROL (2026-11-10, this file only): the `if (next ==
// FlowMode.translate && …)` block removed from `_onModeSelectedRouted` ⇒ the
// first case fails at 「Found 0 widgets with text "Translate into"」; restored,
// rerun green. The second case (target already differs) is the negative and
// stays green either way; its positive control is the segment being selected.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart'
    show AppLocale, AppSettingsController;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show FlowMode;
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/mode_chip.dart' show ModeSegmentedControl;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/legibility.dart' show ahemWidthFor;
import 'support/mic_permission_fakes.dart';

class _Rig {
  _Rig() {
    transport = FakeSocketTransport();
    session = PttSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      tokenStorage: InMemoryTokenStorage(),
      micPermission: newTestMicPermission(),
    );
    store = newTestStore();
    destination = DestinationController();
    controller = ChatController(
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
    );
    transport.pushStatus(SocketStatus.connected);
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  void teardown() {
    debugCancelBannerAutoHideTimers(controller);
    controller.dispose();
    destination.dispose();
    store.dispose();
  }
}

Future<_Rig> _pump(WidgetTester tester, {required String spoken}) async {
  tester.view.physicalSize =
      Size(ahemWidthFor(411, AppLocale.en) * 3, 890 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  final _Rig r = _Rig();
  addTearDown(r.teardown);
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final AppSettingsController appSettings =
      AppSettingsController(prefs: await SharedPreferences.getInstance())
        ..setLocale(AppLocale.en)
        ..setSpokenLang(spoken);
  await tester.pumpWidget(MaterialApp(
    home: ChatFlowPage(controller: r.controller, appSettings: appSettings),
  ));
  await tester.pump();
  return r;
}

Finder _segment(AppStrings s, FlowMode m) => find.descendant(
      of: find.byType(ModeSegmentedControl),
      matching: find.text(s.modeLabel(m)),
    );

void main() {
  final AppStrings en = AppStrings.of(AppLocale.en);

  testWidgets(
      '🔴 spoken en, target en: tapping Translate opens the target picker, and '
      'the pick sticks', (WidgetTester tester) async {
    final _Rig r = await _pump(tester, spoken: 'en');
    expect(r.controller.translateTarget, 'en',
        reason: 'premise: the default target equals the spoken language');
    expect(find.text(en.translateTargetSheetTitle), findsNothing);

    await tester.tap(_segment(en, FlowMode.translate));
    await tester.pumpAndSettle();
    expect(r.controller.mode, FlowMode.translate);
    expect(find.text(en.translateTargetSheetTitle), findsOneWidget,
        reason: 'translating into the spoken language shows nothing; the user '
            'is asked which language instead');

    await tester.tap(find.text(en.translateTargetRowLabel('zh')));
    await tester.pumpAndSettle();
    expect(find.text(en.translateTargetSheetTitle), findsNothing);
    expect(r.controller.translateTarget, 'zh');
    // What the user reads on the row now (the chip beside the segments).
    expect(find.text(en.translateTargetLabel('zh')), findsOneWidget);
  });

  testWidgets('spoken zh, target en: tapping Translate opens no sheet',
      (WidgetTester tester) async {
    final _Rig r = await _pump(tester, spoken: 'zh');
    await tester.tap(_segment(en, FlowMode.translate));
    await tester.pumpAndSettle();
    expect(r.controller.mode, FlowMode.translate,
        reason: 'positive control: the tap reached the segment');
    expect(find.text(en.translateTargetSheetTitle), findsNothing);
    expect(r.controller.translateTarget, 'en');
  });
}
