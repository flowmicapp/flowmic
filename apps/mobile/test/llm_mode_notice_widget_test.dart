// Card LLM-NOTICE (owner 2026-08-25, D1) — the STANDING note under the mode
// row on the transcription page: translate / organize selected + the PC says
// `capability.llm {usable:false}` ⇒ 「PC侧未配置LLM语言模型，此模式不支持」.
//
// SPEC-REF:
//   lib/src/ui/chat_flow_composer.dart `_modePolicyRowRouted` (the renderer)
//   lib/src/settings/llm_capability.dart (the fact)
//
// 【rendered-result】 every sentence assertion reads the laid-out paragraph
// (`expectLegible`) — never `Text.data` (0.2.53).
//
// 🔴 REVERSE CONTROL (mandatory): `usable:true` ⇒ the sentence is ABSENT for
// both modes, with the mode row itself as the positive control. Seen red by
// flipping the renderer's condition to `usable != true` (recorded in the
// commit message). Two more negatives, same control: realtime never shows it,
// and null (not told yet) never shows it.
//
// The mode STAYS selectable (owner: no silent disable, no silent fallback) —
// asserted by selecting it and reading the row back.

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
import 'support/legibility.dart' show ahemWidthFor, expectLegible;
import 'support/mic_permission_fakes.dart';

const double kPhoneDp = 411;
const Key kNote = ValueKey<String>('mode.llm_unsupported');

class _Rig {
  _Rig(this.capability) {
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
      llmCapability: capability,
    );
    transport.pushStatus(SocketStatus.connected);
  }

  final ValueNotifier<bool?> capability;
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
    capability.dispose();
  }
}

void _phoneView(WidgetTester tester, {AppLocale locale = AppLocale.zh}) {
  tester.view.physicalSize = Size(ahemWidthFor(kPhoneDp, locale) * 3, 890 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

Future<_Rig> _pump(WidgetTester tester, bool? usable, {AppLocale locale = AppLocale.zh}) async {
  _phoneView(tester, locale: locale);
  final _Rig r = _Rig(ValueNotifier<bool?>(usable));
  addTearDown(r.teardown);
  // The page reads its language off appSettings (chat_flow_page.dart
  // `_strings`); the SAME controller the settings page would hand it.
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final AppSettingsController appSettings =
      AppSettingsController(prefs: await SharedPreferences.getInstance())..setLocale(locale);
  await tester.pumpWidget(
    MaterialApp(home: ChatFlowPage(controller: r.controller, appSettings: appSettings)),
  );
  await tester.pump();
  return r;
}

void main() {
  testWidgets('usable:false + translate ⇒ the sentence is on screen and legible; the mode row is still there and still selected',
      (WidgetTester tester) async {
    final _Rig r = await _pump(tester, false);
    expect(find.byKey(kNote), findsNothing, reason: 'realtime is the default — nothing to say yet');
    r.controller.setMode(FlowMode.translate);
    await tester.pump();
    expect(r.controller.mode, FlowMode.translate, reason: 'the mode STAYS selectable — no silent disable');
    expect(find.byType(ModeSegmentedControl), findsOneWidget); // positive control
    expectLegible(tester, find.byKey(kNote));
    expect(find.text(const AppStringsZh().llmModeUnsupported), findsOneWidget);
  });

  testWidgets('usable:false + organize ⇒ same sentence (both modes need the model)', (WidgetTester tester) async {
    final _Rig r = await _pump(tester, false);
    r.controller.setMode(FlowMode.organize);
    await tester.pump();
    expectLegible(tester, find.byKey(kNote));
  });

  testWidgets('🔴 usable:true ⇒ NO sentence for either mode (the mode row proves the render)', (WidgetTester tester) async {
    final _Rig r = await _pump(tester, true);
    for (final FlowMode m in <FlowMode>[FlowMode.translate, FlowMode.organize]) {
      r.controller.setMode(m);
      await tester.pump();
      expect(find.byType(ModeSegmentedControl), findsOneWidget);
      expect(find.byKey(kNote), findsNothing, reason: '$m leaked the note with a usable model');
    }
  });

  testWidgets('not told yet (null) ⇒ nothing is claimed', (WidgetTester tester) async {
    final _Rig r = await _pump(tester, null);
    r.controller.setMode(FlowMode.translate);
    await tester.pump();
    expect(find.byType(ModeSegmentedControl), findsOneWidget);
    expect(find.byKey(kNote), findsNothing);
  });

  testWidgets('realtime never shows it, even with usable:false', (WidgetTester tester) async {
    final _Rig r = await _pump(tester, false);
    r.controller.setMode(FlowMode.realtime);
    await tester.pump();
    expect(find.byType(ModeSegmentedControl), findsOneWidget);
    expect(find.byKey(kNote), findsNothing);
  });

  testWidgets('the fact can change while the page is open: false → true hides it, true → false shows it', (WidgetTester tester) async {
    final _Rig r = await _pump(tester, false);
    r.controller.setMode(FlowMode.translate);
    await tester.pump();
    expect(find.byKey(kNote), findsOneWidget);
    r.capability.value = true;
    await tester.pump();
    expect(find.byKey(kNote), findsNothing);
    r.capability.value = false;
    await tester.pump();
    expect(find.byKey(kNote), findsOneWidget);
  });

  testWidgets('every locale renders its own legible sentence', (WidgetTester tester) async {
    for (final AppLocale locale in AppLocale.values) {
      final _Rig r = await _pump(tester, false, locale: locale);
      r.controller.setMode(FlowMode.translate);
      await tester.pump();
      expectLegible(tester, find.byKey(kNote), reason: '$locale');
      expect(find.text(AppStrings.of(locale).llmModeUnsupported), findsOneWidget, reason: '$locale');
      await tester.pumpWidget(const SizedBox.shrink());
    }
  });
}
