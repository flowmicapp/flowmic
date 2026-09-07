// Card AW-1b — the live draft row's ASR-health sentence, mounted for REAL and
// measured on the RENDERED result.
//
// ── WHAT THIS FILE ACTUALLY MEASURES, AND WHAT IT ONCE ONLY CLAIMED TO ──────
// The header of this file used to say it "never asserts on `Text.data`", and
// every assertion in it was `find.text(...)` — which finds a widget BY its
// `Text.data`. The claim and the code disagreed, and the gap was not cosmetic:
// the health sentences were being poured into a `Flexible` status pill that at
// 360 dp is 52-170 logical pixels wide while the sentences want 171-478, so 40
// of the 45 locale x signal combinations rendered as an ellipsed fragment —
// and the one "layout" case in here asserted `maxLines == 1`, which is TRUE of
// a sentence chopped to three characters. 0.2.53 verbatim.
//
// So, precisely:
//   · `find.text(...)` is used here ONLY to LOCATE the paragraph — never as
//     the assertion. It answers "which RenderParagraph", not "did the user
//     read this".
//   · The ASSERTIONS about readability are on the render object: its
//     `size.height` against a budget, and `maxLines` (which must be null —
//     see below).
//   · 🔴 THE HEIGHT BUDGET REPLACED A TAUTOLOGY, and the tautology is worth
//     naming because it looked exactly like the right assertion. This loop
//     used to assert `didExceedMaxLines isFalse` on a Text with neither
//     `maxLines` nor an ellipsis — and that flag can only ever be true when
//     one of those is set. Nine locales times six signals of a value that
//     could not go the other way, sitting under a comment about 0.2.53. The
//     reverse control below it was real, but it proved the probe worked on a
//     DIFFERENT widget (a one-line Flexible pill), so it never touched this.
//     What is actually at risk with no clamp is not clipping but HEIGHT: the
//     row lives in the timeline list, so a runaway paragraph pushes the draft
//     it annotates off the screen rather than getting cut. That is measured
//     now, and the control drives the real tile.
//   · `maxLines == null` is asserted, not incidental. Every clamp that fits
//     the five short `liveHealth*` sentences cuts the terminal-error branch in
//     half: MEASURED at 360 dp, those five want 1-2 lines while
//     `sttStallBannerMessage`'s entries are 165-206 characters and want 8-11.
//     Re-introducing any `maxLines` on that Text turns this assertion red,
//     which is the point — the old one-line clamp is what hid the bug.
//   · `AppLocale.values` x `_signals` is the whole matrix — 9 locales, 5 plus
//     the terminal-error path — because the bug was locale-shaped: EN happened
//     to be one of the wider ones, but ja/ko/ru each overflow at a different
//     width and a single-locale test sees none of it.
//
// ── AHEM, AND WHY THE MEASUREMENT IS CONSERVATIVE IN ONE DIRECTION ONLY ─────
// `flutter_test` renders with the Ahem placeholder font: every glyph is a full
// em square. A 11.5 px sentence therefore measures 11.5 px per character here,
// against roughly 5-7 px for real Latin text and ~11.5 for real CJK. So
// "it fits under Ahem" implies "it fits on the device" — the direction this
// file relies on. THE CONVERSE IS FALSE: nothing here may be read as evidence
// that a sentence which overflows under Ahem would also overflow on a phone.
// The same caveat is written into `inject_verdict_note_test.dart`, for the
// same reason and after the same bug.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/asr_health.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/live_health_copy.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const AppStringsEn _en = AppStringsEn();
const AppStringsZh _zh = AppStringsZh();

/// Every signal that produces a sentence, plus the terminal-error path (whose
/// sentence comes from `sttStallBannerMessage`, a table this file does not
/// own but whose output lands in the same box).
const List<AsrHealthSnapshot> _signals = <AsrHealthSnapshot>[
  AsrHealthSnapshot(byteStall: true),
  AsrHealthSnapshot(digitalSilence: true),
  AsrHealthSnapshot(noFirstResult: AsrHealthLevel.level1),
  AsrHealthSnapshot(noFirstResult: AsrHealthLevel.level2),
  AsrHealthSnapshot(noProgress: true),
  AsrHealthSnapshot(
    terminalError: AsrTerminalError(code: 'STT_LANGUAGE_UNSUPPORTED'),
  ),
];

/// How tall the health paragraph may render at 360dp before it stops being an
/// annotation on the draft and becomes the screen.
///
/// 🔴 MEASURED, THEN ROUNDED UP ONCE. Under Ahem at 360dp the nine locales x
/// six signals top out at 128px (fr and de, both on the terminal-error branch:
/// 191-206 characters); the shortest, zh/zh-TW, are 32px. 200px is that
/// worst case plus half again, and it is 31% of a 640dp screen — a paragraph
/// past it is not a sentence that grew, it is one that broke.
///
/// ⚠️ THE AHEM CAVEAT RUNS THE SAME WAY AS THE FILE HEADER'S: every glyph is a
/// full em square here, so real Latin text is roughly half this wide and CJK
/// about the same. 「fits under Ahem」 therefore implies 「fits on the device」,
/// and NOT the converse — nothing here may be read as evidence that a
/// paragraph which busts the budget under Ahem would also bust it on a phone.
const double _healthLineBudget = 200.0;

/// 360dp — the phone-width fixture this repo's own layout laws are measured
/// against (0.2.53's own note file uses the same number for the analogous
/// row).
Widget _host(Widget child) {
  return MaterialApp(
    home: Scaffold(
      body: Align(
        alignment: Alignment.topLeft,
        child: SizedBox(width: 360, child: child),
      ),
    ),
  );
}

LiveDraftTile _tileFor(AsrHealthSnapshot snapshot, AppStrings strings) {
  return LiveDraftTile(
    text: 'partial words',
    committedChars: 0,
    mode: FlowMode.realtime,
    strings: strings,
    statusLabel: strings.liveTranscribing,
    healthNote: liveHealthNote(snapshot, strings),
    elapsed: const Duration(seconds: 3),
  );
}

void main() {
  group('LiveDraftTile — which sentence appears (AW-1b)', () {
    testWidgets('a clear snapshot adds NO health line — the pill alone',
        (WidgetTester tester) async {
      await tester.pumpWidget(_host(_tileFor(AsrHealthSnapshot.clear, _en)));
      expect(liveHealthNote(AsrHealthSnapshot.clear, _en), isNull);
      expect(find.text('Transcribing'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('every signal maps to its OWN sentence — none collapses into '
        'another (§A8)', (WidgetTester tester) async {
      final Set<String> seen = <String>{};
      for (final AsrHealthSnapshot s in _signals) {
        final String? note = liveHealthNote(s, _en);
        expect(note, isNotNull, reason: 'signal $s produced no sentence');
        expect(seen.add(note!), isTrue,
            reason: 'two signals share one sentence: "$note" — §A8 forbids '
                'collapsing them, because the actions they imply differ');
        await tester.pumpWidget(_host(_tileFor(s, _en)));
        // The pill keeps its short word; the sentence is a SECOND paragraph.
        expect(find.text('Transcribing'), findsOneWidget);
        expect(find.text(note), findsOneWidget);
        expect(tester.takeException(), isNull);
      }
    });

    testWidgets('retryableBounces produces no sentence at all (diag-only)',
        (WidgetTester tester) async {
      const AsrHealthSnapshot s = AsrHealthSnapshot(retryableBounces: 7);
      expect(liveHealthNote(s, _en), isNull,
          reason: 'a bounce count has no honest user-facing sentence — it is '
              'carried by diag only (chat_asr_health_wire.dart)');
      await tester.pumpWidget(_host(_tileFor(s, _en)));
      expect(find.text('Transcribing'), findsOneWidget);
      expect(find.textContaining('7'), findsNothing,
          reason: 'no count may leak onto the screen');
      expect(tester.takeException(), isNull);
    });

    testWidgets('zh_CN renders the zh_CN sentence, not the English one',
        (WidgetTester tester) async {
      const AsrHealthSnapshot s = AsrHealthSnapshot(byteStall: true);
      await tester.pumpWidget(_host(_tileFor(s, _zh)));
      expect(find.text(_zh.liveHealthByteStall), findsOneWidget);
      expect(find.text(_en.liveHealthByteStall), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });

  group('LiveDraftTile — the sentence FITS at 360x640, in all nine locales '
      '(the measurement, not the string)', () {
    for (final AppLocale locale in AppLocale.values) {
      testWidgets('${locale.name}: no health sentence outgrows its budget',
          (WidgetTester tester) async {
        tester.view.physicalSize = const Size(360, 640);
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);

        final AppStrings strings = AppStrings.of(locale);
        for (final AsrHealthSnapshot s in _signals) {
          final String note = liveHealthNote(s, strings)!;
          await tester.pumpWidget(_host(_tileFor(s, strings)));
          await tester.pump();
          expect(tester.takeException(), isNull,
              reason: 'a RenderFlex overflow throws during layout; none may '
                  'occur for "$note"');
          final RenderParagraph p =
              tester.renderObject<RenderParagraph>(find.text(note));
          expect(p.size.height, lessThanOrEqualTo(_healthLineBudget),
              reason: '[${locale.name}] "$note" renders '
                  '${p.size.height}px tall at 360dp — past the budget, it '
                  'starts pushing the draft it is annotating off the screen. '
                  'Shorten the sentence; do not raise the number.');
          expect(p.maxLines, isNull,
              reason: 'the health line must not be clamped at all: any clamp '
                  'that fits the short signals truncates the engine-error '
                  'paragraph (see this file\'s header for the measurements)');
        }
      });
    }

    testWidgets('reverse control: the budget probe can go over',
        (WidgetTester tester) async {
      // Without this the loop above is worth nothing: a height assertion that
      // has never been seen to fail is indistinguishable from one measuring a
      // widget that is not there. Six hundred characters is not a product
      // sentence — that is the point, it is what a runaway one would look
      // like — and the probe must catch it in the REAL tile, not in a
      // hand-built stand-in.
      final String runaway = 'word ' * 120;
      await tester.pumpWidget(_host(LiveDraftTile(
        text: 'partial words',
        committedChars: 0,
        mode: FlowMode.realtime,
        strings: _en,
        statusLabel: _en.liveTranscribing,
        healthNote: runaway,
        elapsed: const Duration(seconds: 3),
      )));
      final RenderParagraph p =
          tester.renderObject<RenderParagraph>(find.text(runaway));
      expect(p.size.height, greaterThan(_healthLineBudget),
          reason: 'the probe must be able to see a paragraph that is too '
              'tall, or the loop above is measuring nothing');
    });

    testWidgets('reverse control: the probe is NOT blind — the same sentence '
        'in the one-line pill it used to live in IS seen as clipped',
        (WidgetTester tester) async {
      // "didExceedMaxLines is false everywhere" is worth nothing unless this
      // probe can go true. So render the SAME sentence the way the bug
      // rendered it — a Flexible in a row, one line, ellipsis, at the pill's
      // measured width — and require the probe to catch it. This is the bug
      // itself, kept executable: if someone puts the health sentence back
      // into the pill, the loop above goes red and this case explains why.
      const String note = 'No new words have come back for a while';
      expect(note, _en.liveHealthNoProgress,
          reason: 'this control must use a REAL product sentence, not a '
              'stand-in long enough to overflow anything');
      await tester.pumpWidget(_host(
        const Row(children: <Widget>[
          SizedBox(width: 190), // badge + "Now" + dot + duration
          Flexible(
            child: Text(
              note,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12),
            ),
          ),
        ]),
      ));
      final RenderParagraph p =
          tester.renderObject<RenderParagraph>(find.text(note));
      expect(p.didExceedMaxLines, isTrue,
          reason: 'the probe must be able to see a clipped paragraph, or its '
              'green says nothing');
    });
  });

  // ── the whole screen, not the tile (anti-façade ⑥) ───────────────────────
  //
  // Everything above mounts `LiveDraftTile` on its own, and the tile is not
  // the deliverable: the deliverable is a phone whose recording controls the
  // user can still reach while the longest sentence this row can produce is
  // on it. Those are two different claims and the first does not imply the
  // second — 0.3.47's lesson, one screen over.
  group('the recording controls survive the longest health sentence', () {
    testWidgets('360x640: the terminal-error paragraph renders and the PTT '
        'bar is still on screen', (WidgetTester tester) async {
      tester.view.physicalSize = const Size(360, 640);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      final FakeSocketTransport transport = FakeSocketTransport();
      final ChatController controller = await _pairedController(transport);
      addTearDown(() async {
        controller.session.debugStopIdlePresencePoll();
        debugCancelBannerAutoHideTimers(controller);
        await controller.dispose();
        controller.destination.dispose();
        controller.store.dispose();
        await controller.session.dispose();
      });

      // English on purpose: the terminal-error paragraph is 165 characters in
      // en against 46 in the page's default zh, and this case exists to put
      // the LONGEST sentence the row can produce on a real screen.
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      final AppSettingsController settings =
          AppSettingsController(prefs: prefs);
      addTearDown(settings.dispose);
      await settings.load();
      settings.setLocale(AppLocale.en);

      transport.pushStatus(SocketStatus.connected);
      await tester.pumpWidget(MaterialApp(
        home: ChatFlowPage(controller: controller, appSettings: settings),
      ));
      controller.session.fsm.onPttDown();
      // The real terminal-error path (`state_machine.dart`'s
      // `sttErrorImmediate`), not a snapshot handed to the widget: this case
      // is about what the SCREEN does, so the fact has to arrive the way it
      // arrives in production.
      controller.session.fsm
          .onSttTerminalError(code: 'STT_LANGUAGE_UNSUPPORTED');
      await tester.pump();

      final String note =
          liveHealthNote(controller.asrHealth.value, _en)!;
      expect(note.length, greaterThan(150),
          reason: 'this case is only worth running on the LONGEST sentence '
              'the row can produce');
      expect(find.byType(LiveDraftTile), findsOneWidget);
      expect(find.text(note), findsOneWidget);

      // 🔴 THE ASSERTION. The timeline is inside an `Expanded`, so the dock
      // keeps its place however tall the tile grows — but that is an argument,
      // and this is the measurement. If someone ever takes the list out of the
      // Expanded, the health paragraph is what will push the button off the
      // bottom, and this goes red instead of a user finding out.
      final Finder bar = find.byKey(const ValueKey<String>('ptt.bar'));
      expect(bar, findsOneWidget);
      expect(tester.getBottomLeft(bar).dy, lessThanOrEqualTo(640.0),
          reason: 'the PTT bar was pushed off the bottom of the screen');
      expect(tester.getTopLeft(bar).dy, lessThan(640.0));
      expect(tester.takeException(), isNull);

      // Wind the machinery down INSIDE the body: the binding checks for
      // pending timers the instant the tree is torn down, before any
      // addTearDown runs. `onPttCancel` cancels the asr-health ticker (armed
      // on the recording edge) and the presence poll was armed by the real
      // `pair()` above — same escape hatch chat_stick_bottom_widget_test.dart
      // uses, and for the same reason.
      controller.session.fsm.onPttCancel();
      controller.session.debugStopIdlePresencePoll();
      await tester.pump();
    });
  });
}

/// The same harness `chat_stick_bottom_widget_test.dart` uses: a real
/// `PttSession` and a real `ChatController` (so `wireAsrHealth` runs), with
/// only the socket and the platform recorder doubled.
Future<ChatController> _pairedController(FakeSocketTransport transport) async {
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  transport.connectSucceeds = true;
  transport.ackQueue.add(<String, Object?>{
    'token': 'tok-health-00000000000000000000000',
    'pc_name': 'Health PC',
    'pc_instance_id': 'inst-health',
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
