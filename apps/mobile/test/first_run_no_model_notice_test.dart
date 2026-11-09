// FR-M1 — what the phone says when the computer it is connected to refuses to open
// a speech engine, with the frame arriving the way it arrives in production and the
// answer read off the real conversation screen.
//
// SPEC-REF: docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §3.2 「局域网电脑
// 拒绝开引擎」; docs/rebuild/17-SPEECH-PIPELINE-STATES-AND-FLOW.md §二;
// .local/device-evidence/2026-11-06-mkt-phase3/
//   flowmic-0.3.120-android-firstrun-no-model-error-while-holding-en.png
//
// 🔴 WHAT THE PHONE CAN AND CANNOT KNOW. `STT_CONFIG_MISSING` covers no model, no
// runtime, no route and no endpoint, and the frame does not say which; `message` is a
// diagnostic the phone never renders. What it does know is which leg refused, from
// `/api/health.mode`. So the sentence names the PLACE (a fact) and the likely fix,
// without asserting the cause. Over the relay the place would be false, and with the
// channel unmeasured it would be a guess, so both keep the older sentence.
//
// 🔴 THE ROW QUESTION IS ANSWERED BY THE CONTRACT, NOT BY THIS CARD. 17 §二: 「这四种情况
// 一律不生成记录，但必须有提示」; master-plan §4.0 A: an entry is built when the
// utterance completes. A press that ends on this refusal therefore leaves NO timeline
// row, and the case below pins that rather than changing it.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal_scan.dart';
import 'package:flowmic/src/audio/retained_audio_manifest.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/pending_recovery_store.dart';
import 'package:flowmic/src/session/instance_probe.dart' show ServerChannel;
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart' show SttStall, SttStallReason;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/legibility.dart';
import 'support/live_settle_rig.dart';

const Map<String, Object?> _frame = <String, Object?>{
  'retryable': false,
  'code': 'STT_CONFIG_MISSING',
  'message': 'sherpa-local open failed: The built-in speech model is not ready yet.',
};

Future<ChatController> _pairedController(FakeSocketTransport transport) async {
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  transport.connectSucceeds = true;
  transport.ackQueue.add(<String, Object?>{
    'token': 'tok-model-000000000000000000000000',
    'pc_name': 'Test PC',
    'pc_instance_id': 'inst-model',
  });
  final PairResult pair = await session.pair(
    PairEntry.parse('1234'),
    endpoint: 'ws://192.0.2.5:41879',
  );
  expect(pair.ok, isTrue, reason: 'harness pair failed: ${pair.error}');
  return ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: newTestStore(),
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(),
  );
}

/// Mounts the real conversation screen, presses, delivers the refusal frame through
/// the transport (so `ptt_inbound.dart` reads the channel itself), and hands back
/// everything needed to read the screen and to let go.
Future<ChatController> _press(
  WidgetTester tester, {
  required ServerChannel? channel,
  required AppLocale locale,
  required FakeSocketTransport transport,
}) async {
  tester.view.physicalSize = const Size(360, 640);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  final ChatController controller = await _pairedController(transport);
  addTearDown(() async {
    controller.session.debugStopIdlePresencePoll();
    debugCancelBannerAutoHideTimers(controller);
    await controller.dispose();
    controller.destination.dispose();
    controller.store.dispose();
    await controller.session.dispose();
  });
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController settings = AppSettingsController(prefs: prefs);
  addTearDown(settings.dispose);
  await settings.load();
  settings.setLocale(locale);

  transport.pushStatus(SocketStatus.connected);
  // The value `ptt_channel_probe.dart` writes from `/api/health.mode`.
  controller.session.serverChannel.value = channel;
  await tester.pumpWidget(MaterialApp(
    home: ChatFlowPage(controller: controller, appSettings: settings),
  ));
  controller.session.fsm.onPttDown();
  transport.pushIncoming(FlowMicEvents.sttError, _frame);
  await tester.pump();
  return controller;
}

void _windDown(ChatController controller) {
  controller.session.fsm.onPttCancel();
  controller.session.debugStopIdlePresencePoll();
}

void main() {
  testWidgets('LAN, while holding: the red line on the row says it is the computer '
      'and what to do there, with no engine vocabulary', (WidgetTester tester) async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final ChatController c = await _press(tester,
        channel: ServerChannel.lan, locale: AppLocale.en, transport: transport);
    final AppStrings s = AppStrings.of(AppLocale.en);

    expect(find.byType(LiveDraftTile), findsOneWidget);
    final Finder line = find.text(s.sttStallBannerMessage(c.sttStalledForTest));
    expect(line, findsOneWidget);
    final String read = (tester.widget<Text>(line)).data!;
    expect(read.toLowerCase(), contains('computer'));
    expect(read.toLowerCase(), contains('speech model'));
    expect(read.toLowerCase(), isNot(contains('engine')));
    expect(read.toLowerCase(), isNot(contains('runtime')));
    expectLegible(tester, line);
    // The line must not cost them the button they are holding.
    final Finder bar = find.byKey(const ValueKey<String>('ptt.bar'));
    expect(tester.getBottomLeft(bar).dy, lessThanOrEqualTo(640.0));
    expect(tester.takeException(), isNull);
    _windDown(c);
  });

  testWidgets('LAN, after letting go: the same sentence in the banner, and by contract '
      'no timeline row', (WidgetTester tester) async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final ChatController c = await _press(tester,
        channel: ServerChannel.lan, locale: AppLocale.en, transport: transport);
    final AppStrings s = AppStrings.of(AppLocale.en);

    c.session.fsm.onPttUp();
    await tester.pump();

    // Positive control first: the stall really fired and it is on the screen.
    expect(c.sttStalled, isNotNull);
    final String said = s.sttStallBannerMessage(c.sttStalled!);
    expect(said, s.sttStallConfigMissingOnComputer);
    expect(find.text(said), findsOneWidget);
    expect(find.byType(LiveDraftTile), findsNothing);
    // 17 §二 / master-plan §4.0 A.
    expect(c.store.entries, isEmpty);

    // An event-type notice (owner 2026-08-01): it goes by itself, and the sentence
    // comes back on the next press. Pinned because a stranger gets 4 s to read it.
    await tester.pump(kBannerAutoHideAfter + const Duration(milliseconds: 100));
    await tester.pump();
    expect(find.text(said), findsNothing);
    expect(c.sttStalled, isNull);
    _windDown(c);
  });

  testWidgets('the trace that does stay: the recording is kept and, past the settle '
      'window, nothing hides it from the waiting list', (WidgetTester tester) async {
    // 15 §3.2 says the trace of this press is the waiting-to-be-transcribed entry and
    // not the timeline. That is a statement about the journal, so it is read from the
    // production store over real file I/O, the way live_settle_pending_recovery_test
    // does it.
    //
    // ⚠️ THE LAST STEP IS READ OFF THE SCAN, NOT OFF `list()`: `list()` uses the wall
    // clock and the window is 30 s, so the scan is asked the same question with an
    // explicit clock. `m.settled` and `liveSettlePending` are the two filters in
    // `PendingRecoveryStore.list` that apply here, and the sister test 「a recording
    // that really is owed a transcription DOES raise it」 walks the rest to the row.
    late Rig r;
    late String id;
    late List<PendingRecoveryItem> before;
    late RecordingManifest? kept;
    late RecordingScan later;
    await tester.runAsync(() async {
      r = await Rig.open(capabilities: const <String>[]);
      r.transport.withReceipt = false;
      r.transport.holdTerminalFinal = true;
      final PendingRecoveryStore src = PendingRecoveryStore(
          runner: r.controller.backfill, sourceLang: () => 'en');
      await r.session.pttDown();
      id = r.spill.liveAttempt!.recordingId;
      r.recorder.feed(makePcm(frameBytes));
      await r.pump();
      r.transport.pushIncoming(FlowMicEvents.sttError, _frame);
      await r.session.pttUp();
      await r.spill.journalFlush();
      await r.pump(4);
      expect(r.controller.sttStalled?.code, 'STT_CONFIG_MISSING',
          reason: 'positive control: this press really ended on the refusal');
      expect(r.controller.store.entries, isEmpty);
      before = await src.list();
      kept = await r.manifestOf(id);
      final int past =
          DateTime.now().millisecondsSinceEpoch + kLiveSettlePendingGraceMs + 1;
      later = (await RetainedAudioJournalScan.scan(
        dirPath: r.store.dirPath,
        recordingId: id,
        clock: () => past,
      )).single;
      await r.dispose();
    });
    expect(before.map((PendingRecoveryItem i) => i.id), isNot(contains(id)),
        reason: 'inside the settle window the list must not claim a debt (UX2-1)');
    expect(kept?.settled, isFalse, reason: 'the audio was thrown away or written off');
    expect(later.verifiedRecoverableRange.isEmpty, isFalse,
        reason: 'the bytes of the press are not on disk');
    expect(later.liveSettlePending, isFalse,
        reason: 'a refused press would stay hidden from the waiting list forever');
  });

  for (final (String name, ServerChannel? channel) in <(String, ServerChannel?)>[
    ('cloud relay', ServerChannel.cloudRelay),
    ('channel not measured', null),
  ]) {
    testWidgets('$name: keeps the older sentence, because the place would be a false '
        'claim or a guess', (WidgetTester tester) async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final ChatController c = await _press(tester,
          channel: channel, locale: AppLocale.en, transport: transport);
      final AppStrings s = AppStrings.of(AppLocale.en);
      expect(find.text(s.sttStallConfigMissing), findsOneWidget);
      expect(find.text(s.sttStallConfigMissingOnComputer), findsNothing);
      _windDown(c);
    });
  }

  for (final AppLocale locale in AppLocale.values) {
    testWidgets('${locale.name}: the LAN sentence renders whole at 360x640 in the row',
        (WidgetTester tester) async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final ChatController c = await _press(tester,
          channel: ServerChannel.lan, locale: locale, transport: transport);
      final AppStrings s = AppStrings.of(locale);
      final Finder line = find.text(s.sttStallConfigMissingOnComputer);
      expect(line, findsOneWidget, reason: locale.name);
      expectLegible(tester, line, reason: locale.name);
      // A long paragraph here grows the row; the PTT bar must still be on screen.
      final Finder bar = find.byKey(const ValueKey<String>('ptt.bar'));
      expect(tester.getBottomLeft(bar).dy, lessThanOrEqualTo(640.0),
          reason: locale.name);
      expect(tester.takeException(), isNull, reason: locale.name);
      _windDown(c);
    });
  }
}

extension on ChatController {
  /// The sentence's source while still holding: the row's own snapshot, re-expressed
  /// as the stall the banner will get, so both faces are asked the same question.
  SttStall get sttStalledForTest {
    final err = asrHealth.value.terminalError!;
    return SttStall(
      SttStallReason.engineError,
      code: err.code,
      message: err.message,
      engineOnComputer: err.engineOnComputer,
    );
  }
}
