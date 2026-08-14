// PA-2 acceptance — the one-line caption under the PTT bar (Plan A′ contract
// §4 A1/A2/A4/A8/A9, §5-1/§5-2, MD-4).
//
// The rendered states run on the REAL ChatFlowPage (0.2.51 law: a widget-only
// case stays green after the production wiring is deleted). The processing /
// recording / justDone branches are asserted against [pttCaption] directly —
// the SAME selector the composer renders — because reaching those FSM states
// inside testWidgets' FakeAsync zone deadlocks the real async PTT chain (the
// scar expanded_compose_test.dart documents line by line).
//
// ── Reverse control (run red, then reverted — quoted in the WP7 report) ─────
// Forcing [pttCaption]'s idle branch to `strings.pttSubDirect` regardless of
// policy turns 「caption switches with policy」 red:
//   Expected: '松开后留在手机，确认后投递'
//     Actual: '松开即投递到电脑 · 上滑取消'
//
// Ahem ruler (0.2.53 discipline, compose_preview_strip_test.dart's wording):
// zh is asserted at the 360dp product width; the four-locale loop runs at a
// measuring width because Ahem doubles latin glyph widths.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart' show SessionState;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/ptt_bar.dart' show PttVisual;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';
import 'support/locale_terms.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

final Finder _caption = find.byKey(const ValueKey<String>('ptt.caption'));

Future<ChatController> _pumpPage(
  WidgetTester tester, {
  SendPolicy policy = SendPolicy.direct,
  bool connected = true,
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
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(sendPolicy: policy),
  );
  addTearDown(() async {
    await controller.dispose();
    controller.destination.dispose();
    controller.store.dispose();
    await controller.session.dispose();
  });
  await controller.loadSendPolicy();
  if (connected) transport.pushStatus(SocketStatus.connected);
  await tester.pumpWidget(
    MaterialApp(home: ChatFlowPage(controller: controller)),
  );
  await tester.pump();
  return controller;
}

String _rendered(WidgetTester tester) =>
    tester.widget<Text>(_caption).data ?? '';

void main() {
  testWidgets('🔴 A1→A2: the caption switches with the policy chip WITHOUT '
      'touching the FSM', (WidgetTester tester) async {
    final ChatController controller = await _pumpPage(tester);
    expect(_caption, findsOneWidget);
    expect(_rendered(tester), _zh.pttSubDirect);

    await controller.toggleSendPolicy();
    await tester.pump();
    expect(
      _rendered(tester),
      _zh.pttSubManual,
      reason: '🔴 the policy flipped and the caption did not follow — the promise of what release will do still names the old policy',
    );
    // 「without touching the FSM」— the switch moved copy, not state.
    expect(controller.sessionState, SessionState.idle);
    expect(controller.isRecording, isFalse);

    // 0.2.53 law: the zh sentence is READABLE at the product width.
    expect(
      tester.renderObject<RenderParagraph>(_caption).didExceedMaxLines,
      isFalse,
    );
    expect(tester.takeException(), isNull);
    controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 A8: link down ⇒ the disabled reason caption', (
    WidgetTester tester,
  ) async {
    final ChatController controller = await _pumpPage(tester, connected: false);
    expect(_caption, findsOneWidget);
    expect(_rendered(tester), _zh.pttSubDisabled);
    expect(
      tester.renderObject<RenderParagraph>(_caption).didExceedMaxLines,
      isFalse,
    );
    controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('🔴 A9: record-only destination ⇒ the noted caption', (
    WidgetTester tester,
  ) async {
    final ChatController controller = await _pumpPage(tester);
    controller.destination.setRecordOnly();
    await tester.pump();
    expect(_rendered(tester), _zh.pttSubNoted);
    expect(
      tester.renderObject<RenderParagraph>(_caption).didExceedMaxLines,
      isFalse,
    );
    controller.session.debugStopIdlePresencePoll();
  });

  group('the selector itself — the branches a widget test cannot reach', () {
    String cap(
      PttVisual v, {
      SendPolicy next = SendPolicy.direct,
      SendPolicy active = SendPolicy.direct,
      bool recordOnly = false,
    }) => pttCaption(
      visual: v,
      nextPolicy: next,
      activePolicy: active,
      recordOnly: recordOnly,
      pcName: 'dev-pc-a',
      strings: _zh,
    );

    test('A4: processing × direct names the machine; × manual promises '
        'nothing; record-only NEVER gets the delivery promise', () {
      expect(
        cap(PttVisual.processing),
        _zh.pttSubProcessingDirect('dev-pc-a'),
      );
      expect(cap(PttVisual.processing), contains('dev-pc-a'));
      expect(
        cap(PttVisual.processing, active: SendPolicy.manual),
        _zh.pttSubProcessingManual,
      );
      expect(
        cap(PttVisual.processing, recordOnly: true),
        _zh.pttSubProcessingManual,
        reason: '🔴 the record-only branch saying "deliver to X" is a lie — MD-4 may only promise the half that will actually happen',
      );
    });

    test('🔴 A4 reads the ACTIVE snapshot, not the chip: flipping the policy '
        'mid-utterance must not rewrite the promise about the sentence in '
        'flight (§4.0 B)', () {
      expect(
        cap(
          PttVisual.processing,
          next: SendPolicy.manual, // the chip already flipped…
          active: SendPolicy.direct, // …but THIS utterance was direct.
        ),
        _zh.pttSubProcessingDirect('dev-pc-a'),
      );
    });

    test('A3/A5: recording and justDone carry no caption (the strip and the '
        'flash face own those moments — MD-1)', () {
      expect(cap(PttVisual.recording), isEmpty);
      expect(cap(PttVisual.justDone), isEmpty);
    });
  });

  // ── PA-6: four locales, rendered at the measuring width ──────────────────
  for (final AppLocale locale in AppLocale.values) {
    testWidgets('🔴 PA-6 ${locale.name}: every non-empty caption renders '
        'un-clipped at the measuring width', (WidgetTester tester) async {
      final AppStrings s = AppStrings.of(locale);
      final List<String> captions = <String>[
        s.pttSubDirect,
        s.pttSubManual,
        s.pttSubNoted,
        s.pttSubProcessingDirect('dev-pc-a'),
        s.pttSubProcessingManual,
        s.pttSubDisabled,
      ];
      for (final String caption in captions) {
        // The composer's exact face: 10.5sp, centered, maxLines 2.
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SizedBox(
                width: 640,
                child: Text(
                  caption,
                  key: const ValueKey<String>('ptt.caption'),
                  textAlign: TextAlign.center,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 10.5),
                ),
              ),
            ),
          ),
        );
        expect(
          tester.renderObject<RenderParagraph>(_caption).didExceedMaxLines,
          isFalse,
          reason: '${locale.name}: 「$caption」 was clipped at the measuring width',
        );
      }
    });
  }

  test('🔴 PA-6: the caption family is four DISTINCT translations each', () {
    // Nine-locale expansion (2026-08-14): `hasLength(4)` replaced by a
    // named-key criterion; see the comment on `expectPerLocaleDistinct` in
    // `support/locale_terms.dart`.
    // measured: these five sentences differ in all nine locales ⇒ not one
    // mayShare is needed.
    final Map<String, String Function(AppStrings)> subs =
        <String, String Function(AppStrings)>{
      'pttSubDirect': (AppStrings s) => s.pttSubDirect,
      'pttSubManual': (AppStrings s) => s.pttSubManual,
      'pttSubNoted': (AppStrings s) => s.pttSubNoted,
      'pttSubProcessingManual': (AppStrings s) => s.pttSubProcessingManual,
      'pttSubDisabled': (AppStrings s) => s.pttSubDisabled,
    };
    for (final MapEntry<String, String Function(AppStrings)> e in subs.entries) {
      expectPerLocaleDistinct(e.value, what: e.key);
    }
  });
}
