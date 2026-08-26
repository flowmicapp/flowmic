// Card PAIR-SUCCESS (owner 2026-08-25, 「这非常重要」) — the phone's floating
// 「connected」 confirmation on the transcription page after a DELIBERATE entry.
//
// SPEC-REF:
//   lib/src/session/pairing_success_notice.dart (the fact and its ONE writer)
//   lib/src/ui/chat_banner_sources.dart (the banner) /
//   lib/src/session/chat_transient_banner_timers.dart (the 4 s auto-hide)
//   lib/src/ui/connections_page.dart `_enterChat` → `onDeliberateEntry`
//
// 【rendered-result】 the sentence is asserted on the laid-out paragraph inside
// the BannerSlot (`expectLegible`), never on `Text.data`.
//
// 🔴 REVERSE CONTROL (mandatory): an AUTOMATIC reconnect — the room-join edge
// the ladder produces on every network flap — must NOT raise the banner. Seen
// red by making ChatController raise the notice from `_onRoomJoined` (recorded
// in the commit): the case below then fails on
//   Expected: no matching candidates
//   Actual: _DescendantWidgetFinder:<Found 1 widget with text "已连接到电脑，可以开始说话了"…>
// — i.e. the 0.3.27 「36 out of 36」 shape, a banner that fires on every flap.

import 'dart:async';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/pairing_success_notice.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale, AppSettingsController;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/haptics.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/legibility.dart' show ahemWidthFor, expectLegible;
import 'support/mic_permission_fakes.dart';

const double kPhoneDp = 411;
const AppStrings _zh = AppStringsZh();

Finder _banner(String message) =>
    find.descendant(of: find.byType(BannerSlot), matching: find.text(message));

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
    unawaited(controller.dispose());
    destination.dispose();
    store.dispose();
  }
}

Future<_Rig> _pump(WidgetTester tester, {AppLocale locale = AppLocale.zh}) async {
  tester.view.physicalSize = Size(ahemWidthFor(kPhoneDp, locale) * 3, 890 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  final _Rig r = _Rig();
  addTearDown(r.teardown);
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final AppSettingsController appSettings =
      AppSettingsController(prefs: await SharedPreferences.getInstance())..setLocale(locale);
  await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller, appSettings: appSettings)));
  await tester.pump();
  return r;
}

void main() {
  testWidgets('a DELIBERATE entry raises the banner: legible in the slot, then it hides by itself after '
      'kBannerAutoHideAfter', (WidgetTester tester) async {
    final _Rig r = await _pump(tester);
    expect(_banner(_zh.pairingSuccessBanner), findsNothing, reason: 'positive control for the finder');

    // What main.dart wires `onDeliberateEntry` to.
    r.controller.pairingSuccess.raise();
    await tester.pump();
    expectLegible(tester, _banner(_zh.pairingSuccessBanner));

    // EVENT-type: it leaves on its own — the same reconciler every other past
    // event rides, the same constant.
    await tester.pump(kBannerAutoHideAfter + const Duration(milliseconds: 50));
    await tester.pump();
    expect(_banner(_zh.pairingSuccessBanner), findsNothing, reason: 'the banner must end by itself');
  });

  testWidgets('🔴 an AUTOMATIC reconnect (the room-join edge) raises NOTHING', (WidgetTester tester) async {
    final _Rig r = await _pump(tester);
    // The ladder's rejoin: the same edge every network flap produces.
    r.session.noteRoomJoined();
    r.session.noteRoomJoined();
    await tester.pump();
    await tester.pump();
    expect(r.session.roomJoins.value, 2, reason: 'positive control: the edges really fired');
    expect(find.byType(BannerSlot), findsOneWidget, reason: 'positive control: the slot rendered');
    expect(_banner(_zh.pairingSuccessBanner), findsNothing);
  });

  testWidgets('✕ dismisses it early, and a SECOND deliberate entry gets its own full window', (WidgetTester tester) async {
    final _Rig r = await _pump(tester);
    r.controller.pairingSuccess.raise();
    await tester.pump();
    expect(_banner(_zh.pairingSuccessBanner), findsOneWidget);
    r.controller.pairingSuccess.dismiss();
    await tester.pump();
    expect(_banner(_zh.pairingSuccessBanner), findsNothing);
    r.controller.pairingSuccess.raise();
    await tester.pump();
    expect(_banner(_zh.pairingSuccessBanner), findsOneWidget);
    await tester.pump(kBannerAutoHideAfter + const Duration(milliseconds: 50));
    await tester.pump();
    expect(_banner(_zh.pairingSuccessBanner), findsNothing);
  });

  testWidgets('every locale renders its own legible sentence', (WidgetTester tester) async {
    for (final AppLocale locale in AppLocale.values) {
      final _Rig r = await _pump(tester, locale: locale);
      r.controller.pairingSuccess.raise();
      await tester.pump();
      expectLegible(tester, _banner(AppStrings.of(locale).pairingSuccessBanner), reason: '$locale');
      r.controller.pairingSuccess.dismiss();
      await tester.pump();
      await tester.pumpWidget(const SizedBox.shrink());
    }
  });

  group('the haptic is its own feel', () {
    test('pairingSuccess is the plain vibrate — distinguishable from the three push-to-talk impacts', () async {
      TestWidgetsFlutterBinding.ensureInitialized();
      final List<MethodCall> calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (MethodCall call) async {
            if (call.method == 'HapticFeedback.vibrate') calls.add(call);
            return null;
          });
      addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null));

      await FlowMicHaptics.pairingSuccess();
      await FlowMicHaptics.pttDown();
      await FlowMicHaptics.pttSend();
      await FlowMicHaptics.pttCancel();
      final List<Object?> patterns = calls.map((MethodCall c) => c.arguments).toList();
      expect(patterns.first, isNull, reason: 'plain vibrate carries no HapticFeedbackType');
      expect(patterns.sublist(1), <String>[
        'HapticFeedbackType.mediumImpact',
        'HapticFeedbackType.lightImpact',
        'HapticFeedbackType.heavyImpact',
      ]);
      expect(patterns.sublist(1), isNot(contains(patterns.first)));
    });

    test('raise() fires the haptic once per raise; dismiss() never does', () async {
      int fired = 0;
      int changed = 0;
      final PairingSuccessNotice n = PairingSuccessNotice(
        onChanged: () => changed++,
        haptic: () async => fired++,
      );
      expect(n.ticket, isNull);
      n.raise();
      expect(n.ticket, 1);
      expect(fired, 1);
      n.dismiss();
      expect(n.ticket, isNull);
      expect(fired, 1);
      n.raise();
      expect(n.ticket, 2, reason: 'a new occurrence is a NEW number — a fresh auto-hide window');
      expect(changed, 3);
      n.dismiss();
      n.dismiss();
      expect(changed, 4, reason: 'a second dismiss is a no-op, not a repaint');
    });
  });
}
