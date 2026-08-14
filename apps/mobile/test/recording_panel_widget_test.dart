// R6 T-5d acceptance — the recording panel + the PTT four-state face.
// SPEC-REF: REDESIGN §6.2 ⑤ / §6.3; master-plan §4.2 F-7; demo mobile.html
// frame 3 (.recpanel / .wave / .rmeta) and .ptt / .ptt.rec / .ptt.noted / .ptt.dis.
//
// Pure widget tests: every value is passed in, so nothing here touches a real
// PttSession async chain (the FakeAsync deadlock this repo has already hit).
// The recording face runs a repeating pulse, so those cases use pump(), never
// pumpAndSettle().

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/mic_glyph.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flowmic/src/ui/recording_panel.dart';
import 'package:flowmic/src/ui/tokens.dart';
// Flutter's own ConnectionState (AsyncSnapshot) collides with the signalling
// one — same hide the chat flow page uses.
import 'package:flutter/material.dart' hide ConnectionState;
// Unrestricted (was `show RenderParagraph`): the new a11y test also needs
// SemanticsHandle/SemanticsNode — same unrestricted import
// ptt_bar_a11y_test.dart uses for the same reason.
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';
import 'support/legibility.dart' show ahemWidthFor;

final AppStrings zh = AppStrings.of(AppLocale.zh);
final AppStrings en = AppStrings.of(AppLocale.en);

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

Widget _panel({
  Duration elapsed = const Duration(seconds: 42),
  List<double> amplitude = const <double>[-20, -14, -9, -25],
  int segments = 2,
  RecordingLink link = RecordingLink.ok,
  AppStrings? strings,
}) => _wrap(
  RecordingPanel(
    elapsed: elapsed,
    amplitudeWindow: amplitude,
    segmentCount: segments,
    link: link,
    strings: strings ?? zh,
  ),
);

/// The amplitude bars are the only fixed-width 3 px boxes in the panel.
Iterable<Container> _bars(WidgetTester tester) => tester
    .widgetList<Container>(find.byType(Container))
    .where((Container c) => c.constraints?.maxWidth == 3);

/// WP8 VF-5: the link + segment honesty faces are the only containers wearing
/// the chip look (chipbg fill, r99 — `_honestyChip` in recording_panel.dart).
/// Matched by decoration, not by position, so this stays valid regardless of
/// how many faces are showing.
Iterable<Container> _chips(WidgetTester tester) =>
    tester.widgetList<Container>(find.byType(Container)).where((Container c) {
      final BoxDecoration? d = c.decoration as BoxDecoration?;
      return d?.color == FlowMicDockColors.chipbg &&
          d?.borderRadius == BorderRadius.circular(99);
    });

void main() {
  group('recording panel — every indicator is fed by a real source', () {
    testWidgets('PA-3 strip: ⏱ m:ss + 📍 seg N render from the passed truth, '
        'and a HEALTHY link renders NO link face at all (MD-3)', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(_panel());
      expect(find.text('0:42'), findsOneWidget);
      expect(find.text('seg 2'), findsOneWidget);
      // Parity-walk micro-fix: the mock paints `↑ 上滑取消` — the painted
      // spelling carries the glyph, so the finder must match it.
      expect(find.text('↑ 上滑取消'), findsOneWidget);
      // 🔴 The glyph is a LAYOUT prefix (ptt_bar.dart's `● ` precedent), not
      // part of the frozen copy — this is the assertion that stops a future
      // refactor from silently dropping it: reading the widget's OWN data,
      // not merely a substring match, so a reorder like "上滑取消 ↑" or a
      // dropped space would also be caught.
      final Text cancelHint = tester.widget<Text>(find.text('↑ 上滑取消'));
      expect(
        cancelHint.data,
        startsWith('↑ '),
        reason: 'WP8 VF-5 parity walk: mock frames A-03/A-04/A-07 draw '
            '`<span>↑ 上滑取消</span>` — the arrow must lead the hint',
      );
      // MD-3: the link face appears when and only when unhealthy — a standing
      // 「网络正常」 was the pre-PA-3 face, and it is chrome, not information.
      expect(find.text('网络正常'), findsNothing);
    });

    testWidgets(
      '🔴 parity-walk micro-fix: the ↑ glyph stays OUT of the a11y label — '
      'same rule as ptt_bar.dart\'s ● prefix (a screen reader must receive '
      'the owner-frozen sentence, never the painted arrow)',
      (WidgetTester tester) async {
        // FINDING: recording_panel.dart had ZERO explicit Semantics before
        // this fix. A bare Text still auto-generates a semantics node from
        // its OWN painted string regardless of a wrapper (documented
        // precedent: ptt_bar_a11y_test.dart's header comment) — so simply
        // prefixing the glyph onto Text.data would have leaked "↑ 上滑取消"
        // into the accessibility tree. Fixed with the same
        // `Semantics(label: <raw>, excludeSemantics: true)` shape
        // ptt_bar.dart already uses for its `●` prefix.
        final SemanticsHandle handle = tester.ensureSemantics();
        await tester.pumpWidget(_panel());

        final SemanticsNode node = tester.getSemantics(
          find.bySemanticsLabel(zh.recSwipeCancel),
        );
        expect(
          node.getSemanticsData().label,
          zh.recSwipeCancel, // exact — no leading '↑ ', proven by string ==
          reason: 'a screen reader must never receive the layout glyph',
        );

        handle.dispose();
      },
    );

    testWidgets('the timer formats m:ss and turns amber near the 5-min cap', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(_panel(elapsed: const Duration(seconds: 5)));
      expect(find.text('0:05'), findsOneWidget);
      Text timer = tester.widget<Text>(find.text('0:05'));
      // WP8 VF-5 §2: pinned via the TOKEN, not a raw literal — 0xFFF87171
      // happens to equal FlowMicDockColors.rec in dark (this suite's default
      // theme), which would silently pass even if the widget still read the
      // old FlowMicColors.red alias. Asserting the actual token is what
      // proves WHICH source the colour now comes from.
      expect(timer.style?.color, FlowMicDockColors.rec); // rec, normal

      await tester.pumpWidget(
        _panel(elapsed: const Duration(minutes: 4, seconds: 40)),
      );
      expect(find.text('4:40'), findsOneWidget);
      timer = tester.widget<Text>(find.text('4:40'));
      expect(
        timer.style?.color,
        FlowMicColors.amber, // deliberate keep — the mock never draws this face
        reason: 'the approach to the server-side hard cap must be visible',
      );
    });

    testWidgets('📍 seg is OMITTED below TWO — no guessed "seg 1" chrome on a '
        'routine one-segment utterance (MD-3)', (WidgetTester tester) async {
      await tester.pumpWidget(_panel(segments: 0));
      expect(find.textContaining('seg'), findsNothing);
      expect(find.text('↑ 上滑取消'), findsOneWidget); // the rest still renders
      await tester.pumpWidget(_panel(segments: 1));
      expect(
        find.textContaining('seg'),
        findsNothing,
        reason: 'seg 1 is every utterance — the counter is a long-recording '
            'signal, not standing chrome',
      );
      await tester.pumpWidget(_panel(segments: 2));
      expect(find.text('seg 2'), findsOneWidget);
    });

    testWidgets('📡 shows the LINK STATE when unhealthy (never an invented '
        'latency figure)', (WidgetTester tester) async {
      await tester.pumpWidget(_panel(link: RecordingLink.degraded));
      expect(find.text('重连中 · 已缓冲'), findsOneWidget);
      await tester.pumpWidget(_panel(link: RecordingLink.down));
      expect(find.text('网络已断开'), findsOneWidget);
      // Nothing anywhere claims a millisecond figure.
      expect(find.textContaining('ms'), findsNothing);
    });

    testWidgets('no amplitude data: does not crash, does not fake motion: bars stay at the floor and nothing is '
        'claimed', (WidgetTester tester) async {
      await tester.pumpWidget(_panel(amplitude: const <double>[]));
      expect(tester.takeException(), isNull);
      final List<Container> bars = _bars(tester).toList();
      expect(bars, hasLength(RecordingPanel.kBars));
      for (final Container bar in bars) {
        expect(
          bar.constraints?.maxHeight,
          4,
          reason: 'no samples ⇒ every bar sits at the 4dp floor (§5-1)',
        );
      }
      // No data is NOT the same claim as "no sound right now".
      expect(find.text('此刻无声'), findsNothing);
    });

    testWidgets('🔴 PA-3: bar heights FOLLOW the amplitude window — louder '
        'sample, taller bar, in order', (WidgetTester tester) async {
      // REVERSE CONTROL for PA-3 (run red, reverted): a synthetic constant
      // height in `_wave` (ignoring the sample) breaks the strict ordering
      // below — quoted in the WP7 return report.
      await tester.pumpWidget(
        _panel(amplitude: const <double>[-48, -36, -24, -12]),
      );
      final List<Container> bars = _bars(tester).toList();
      final List<double> heights = <double>[
        for (int i = RecordingPanel.kBars - 4; i < RecordingPanel.kBars; i++)
          bars[i].constraints!.maxHeight,
      ];
      for (int i = 1; i < heights.length; i++) {
        expect(
          heights[i],
          greaterThan(heights[i - 1]),
          reason: '🔴 a louder sample did not draw a taller bar ⇒ amplitude no longer comes from the real window',
        );
      }
      // And the mapping is the documented one, not merely monotonic.
      expect(heights.first, closeTo(4 + 20 * (12 / 60), 0.01));
      expect(heights.last, closeTo(4 + 20 * (48 / 60), 0.01));
    });

    testWidgets(
      '🔴 WP8 VF-5: below the silence floor the bars STAY rec-red at the '
      'floor height and the sentence still says so — the F-7 grey face is '
      'RETIRED (colour carries no honesty signal any more, only height does)',
      (WidgetTester tester) async {
        await tester.pumpWidget(
          _panel(amplitude: const <double>[-100, -98, -95]),
        );
        expect(find.text('此刻无声'), findsOneWidget);
        for (final Container bar in _bars(tester)) {
          final BoxDecoration d = bar.decoration! as BoxDecoration;
          expect(
            d.color,
            FlowMicDockColors.rec,
            reason:
                'REVERSE-CONTROL subject: a grey recolour on silence must '
                'turn this assertion red (quoted verbatim in the WP8 VF-5 '
                'return report)',
          );
        }
      },
    );

    // ── Q5 (design 2026-08-13 §14, owner ㋐): 「此刻无声」must actually READ as
    // a whole word on the narrowest real phone, not just exist in AppStrings.
    // The label sits in a `Flexible` + `maxLines:1` + ellipsis right next to
    // the 8 amplitude bars and the 📡/📍 meta column (`_wave()` /
    // `recording_panel.dart:174-184`) — the exact shape that clipped the
    // inject-verdict note to three letters in 0.2.53
    // (inject_verdict_note_test.dart). 0.2.53 law: assert on the RENDER
    // result (`didExceedMaxLines`), never on `Text.data` of a string that was
    // never laid out.
    testWidgets('🔴 Q5 · recNoSound (zh) is not clipped by the ellipsis at '
        '360dp — the narrowest real phone, where the misreading Q5 fixes '
        'actually happens next to a growing Chinese char count', (
      WidgetTester tester,
    ) async {
      // 360dp: common Android narrowest width (same budget the header-name
      // measurement precedent uses). segments:3 + a real amplitude window so
      // the 📍/📊 neighbours are at their production width, not an empty best
      // case.
      tester.view.physicalSize = const Size(360 * 3, 780 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        _panel(amplitude: const <double>[-100, -98, -95], segments: 3),
      );

      final Finder note = find.text(zh.recNoSound);
      expect(note, findsOneWidget);
      final RenderParagraph p = tester.renderObject<RenderParagraph>(note);
      expect(
        p.didExceedMaxLines,
        isFalse,
        reason: 'recNoSound was eaten by the ellipsis (360dp, sharing the row with the amplitude bars + 📡/📍)',
      );
    });

    // 🔴 FINDING (out of Q5's wording-only scope, recorded rather than
    // silently worked around): at 360dp the meta column's `recLinkOk`
    // translations are already 2–2.5x wider than the zh one under Ahem
    // ('Network OK'≈107px / 'ネットワーク正常'≈86px / '네트워크 정상'≈75px vs
    // '网络正常'≈43px, measured), which leaves the wave row's Flexible with
    // near-zero space left for en/ja/ko — confirmed by measuring that even an
    // 8-character English fragment ("No sound") still clips there. This is a
    // PRE-EXISTING RecordingPanel layout constraint (the meta column is not
    // itself flexible), not something introduced by this wording change and
    // not fixable without touching layout — which this card is explicitly
    // wording-only and told not to do. It first becomes visible here only
    // because this is the first measurement test this row has ever had.
    // ⇒ this sweep uses 600dp, this repo's own established Ahem-inflation
    // compensation width for a similarly meta-row-crowded case
    // (inject_verdict_note_test.dart's 8-code sweep, same reasoning: Ahem
    // renders every glyph as a full em square, so English measures far wider
    // here than the real font ever will — conservative, not exact-fit).
    testWidgets('recNoSound reads as a whole word in all four locales at '
        '600dp (Ahem-compensated — real font has more room, never less)', (
      WidgetTester tester,
    ) async {
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      for (final AppLocale locale in AppLocale.values) {
        // 🔴 Nine-locale expansion (2026-08-14): the width is no longer a
        // hardcoded 600, it is `ahemWidthFor(600, locale)`. That 600 used to
        // carry two things at once — "how wide a panel the product must work
        // on" and "how much Ahem inflated this locale" — and with nine
        // locales the second thing forks by language. **The product criterion
        // did not change** (still a 600dp panel); what changed is how many px
        // this locale converts to on the ruler; Hans/Hant/Jpan scale is 1.0,
        // so the zh/ja/zhTw line is still 600 byte-for-byte.
        tester.view.physicalSize = Size(ahemWidthFor(600, locale) * 3, 780 * 3);
        final AppStrings s = AppStrings.of(locale);
        await tester.pumpWidget(
          _panel(
            amplitude: const <double>[-100, -98, -95],
            segments: 3,
            strings: s,
          ),
        );
        final Finder n = find.text(s.recNoSound);
        expect(n, findsOneWidget, reason: '$locale');
        expect(
          tester.renderObject<RenderParagraph>(n).didExceedMaxLines,
          isFalse,
          reason: 'recNoSound clipped at 600dp for $locale',
        );
      }
    });

    testWidgets(
      '🔴 reverse control: stuffing this sentence into a 40px box gets it clipped — proves the measurement technique itself works',
      (WidgetTester tester) async {
        // Not a test of production code — a test that the MEASUREMENT ITSELF
        // is capable of going red. Same technique as
        // inject_verdict_note_test.dart's squeeze case.
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SizedBox(
                width: 40,
                child: Text(
                  zh.recNoSound,
                  key: const ValueKey<String>('squeezed'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
          ),
        );
        expect(
          tester
              .renderObject<RenderParagraph>(
                find.byKey(const ValueKey<String>('squeezed')),
              )
              .didExceedMaxLines,
          isTrue,
          reason: 'even this does not go red, which means the measurement technique itself has gone blind',
        );
      },
    );

    testWidgets('a loud sample drives a taller RED bar than a quiet one '
        '(PA-3: live signal wears the recording red, mock ③)', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(_panel(amplitude: const <double>[-50, -3]));
      final List<Container> bars = _bars(tester).toList();
      final double quiet = bars[RecordingPanel.kBars - 2].constraints!.maxHeight;
      final double loud = bars[RecordingPanel.kBars - 1].constraints!.maxHeight;
      expect(loud, greaterThan(quiet));
      final BoxDecoration d = bars.last.decoration! as BoxDecoration;
      expect(d.color, FlowMicDockColors.rec); // rec — live signal
    });

    testWidgets(
      '🔴 WP8 VF-5: bars resolve to FlowMicDockColors.rec in BOTH themes '
      '(light #DC2626 / dark #F87171) — never the retired grey',
      (WidgetTester tester) async {
        // SEAM: assigning the notifier directly is the documented legal test
        // seam (tokens.dart's FlowMicTheme doc; test/dock_tokens_test.dart
        // uses the same pattern). Reset to dark afterwards — this suite's
        // other groups (PTT four-state faces in particular) assume the
        // default dark theme and are not written to re-resolve per test.
        addTearDown(() => FlowMicTheme.brightness.value = Brightness.dark);

        FlowMicTheme.brightness.value = Brightness.light;
        await tester.pumpWidget(
          _panel(amplitude: const <double>[-20, -14, -9, -25]),
        );
        for (final Container bar in _bars(tester)) {
          final BoxDecoration d = bar.decoration! as BoxDecoration;
          expect(d.color, const Color(0xFFDC2626), reason: 'light rec');
        }

        FlowMicTheme.brightness.value = Brightness.dark;
        await tester.pumpWidget(
          _panel(amplitude: const <double>[-20, -14, -9, -25]),
        );
        for (final Container bar in _bars(tester)) {
          final BoxDecoration d = bar.decoration! as BoxDecoration;
          expect(d.color, const Color(0xFFF87171), reason: 'dark rec');
        }
      },
    );

    testWidgets(
      '🔴 WP8 VF-5: the link + segment honesty faces restyle to chipbg '
      'pills, r99 (padding h12/v4) — appearance changes, predicates do not',
      (WidgetTester tester) async {
        await tester.pumpWidget(
          _panel(link: RecordingLink.degraded, segments: 3),
        );
        final List<Container> chips = _chips(tester).toList();
        expect(
          chips.length,
          2,
          reason: 'one chip for the link face, one for the segment chip',
        );
        for (final Container chip in chips) {
          expect(
            chip.padding,
            const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          );
        }
        // The label text inside each chip is `sub`, 11sp (was t2 10.5sp).
        final Text linkLabel = tester.widget<Text>(
          find.text(zh.recLinkDegraded),
        );
        expect(linkLabel.style?.color, FlowMicDockColors.sub);
        expect(linkLabel.style?.fontSize, 11);
        final Text segLabel = tester.widget<Text>(
          find.text(zh.recSegments(3)),
        );
        expect(segLabel.style?.color, FlowMicDockColors.sub);
        expect(segLabel.style?.fontSize, 11);
      },
    );

    testWidgets('copy is bilingual (en panel shares no zh string)', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _panel(
          amplitude: const <double>[-100],
          strings: en,
          link: RecordingLink.degraded,
        ),
      );
      expect(find.text('No sound right now'), findsOneWidget);
      expect(find.text('Reconnecting · buffered'), findsOneWidget);
      expect(find.text('↑ Swipe up to cancel'), findsOneWidget);
      expect(find.text('此刻无声'), findsNothing);
    });
  });

  // ── WP8 VF-2 (2026-08-14) touched this group and NOTHING ELSE in this file ──
  // The five cases below pinned the PRE-MOCK PTT faces (gradients, the Material
  // mic, the old amber/green). VF-2 rebuilt `ptt_bar.dart` to the Plan A′ mock,
  // so they went red BY DESIGN (visual-fidelity contract §5: 「visual tests that
  // pin the OLD dock faces turn red by design — rewrite to pin the mock
  // values」). What each case GUARDS is unchanged; only the value it names moved,
  // and every colour now goes through `FlowMicDockColors` (pinned against the
  // mock in dock_tokens_test.dart) instead of a re-typed hex.
  // ⚠️ The recording-strip half of this file is untouched — it belongs to
  // another card.
  group('PTT four-state face (R6 T-5d)', () {
    testWidgets('idle — brand fill, 「按住 说话」, the mock\'s mic', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(_wrap(const PttBar(visual: PttVisual.idle)));
      expect(find.text('按住 说话'), findsOneWidget);
      // `Icons.mic_none` → [MicGlyph], the mock's own SVG mic transcribed as a
      // painter. Asserting the TYPE (not an icon code point) is what makes the
      // swap visible here at all: a Material icon finder simply reports
      // nothing, which reads as 「no glyph」 rather than 「a different glyph」.
      expect(find.byType(MicGlyph), findsOneWidget);
      expect(_barFill(tester), FlowMicDockColors.pri);
    });

    testWidgets('recording — red fill + a LIVE pulse (no dead binding)', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(_wrap(const PttBar(visual: PttVisual.recording)));
      // The `● ` is a LAYOUT glyph concatenated in ptt_bar.dart (mock A-03
      // `● 松开 结束`); the owner-frozen sentence itself is byte-identical, and
      // the dot stays out of the a11y label.
      expect(find.text('● 松开 结束'), findsOneWidget);
      // `recFill`, not `rec`: `.ptt.rec` has no `.dk` override, so the BAR is
      // #DC2626 in both themes; only the strip's bars/timer lighten in dark.
      expect(_barFill(tester), FlowMicDockColors.recFill);
      // The pulse is a real repeating animation: the foreground wash changes
      // between frames. pump() only — pumpAndSettle would never settle.
      await tester.pump(const Duration(milliseconds: 1));
      final Color? first = _pulseWash(tester);
      await tester.pump(const Duration(milliseconds: 400));
      final Color? later = _pulseWash(tester);
      expect(first, isNotNull);
      expect(later, isNotNull);
      expect(
        later!.a,
        isNot(first!.a),
        reason: 'the recording pulse must actually animate',
      );
      // Leave the ticker in a state the test binding can dispose cleanly.
      await tester.pumpWidget(_wrap(const PttBar(visual: PttVisual.idle)));
    });

    testWidgets('processing — amber, 处理中…', (WidgetTester tester) async {
      await tester.pumpWidget(_wrap(const PttBar(visual: PttVisual.processing)));
      expect(find.text('处理中…'), findsOneWidget);
      // `.ptt.amb{background:#D97706}` (was the pre-mock 0xFFFBBF24).
      expect(_barFill(tester), FlowMicDockColors.processing);
      // A-05 draws the processing bar LABEL-ONLY — the hourglass went with the
      // gradients.
      expect(find.byType(MicGlyph), findsNothing);
    });

    testWidgets('justDone — green with the ✓', (WidgetTester tester) async {
      await tester.pumpWidget(_wrap(const PttBar(visual: PttVisual.justDone)));
      expect(find.text('已完成'), findsOneWidget);
      // The ✓ STAYS: the boards never drew the 1.5s confirmation, so this face
      // keeps its existing glyph rather than inheriting a rule the mock did not
      // state for it. Only the green moved (prototype `pttBg='#16A34A'`).
      expect(find.byIcon(Icons.check), findsOneWidget);
      expect(_barFill(tester), FlowMicDockColors.doneFlash);
    });

    testWidgets('noted / disabled faces are unchanged', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(_wrap(const PttBar(visual: PttVisual.noted)));
      expect(find.text('按住 说话 · 仅记录'), findsOneWidget);
      await tester.pumpWidget(_wrap(const PttBar(visual: PttVisual.disabled)));
      expect(find.text('未连接 · 暂时不能说话'), findsOneWidget);
    });

    testWidgets('processing / justDone refuse a PTT-down (the FSM is busy)', (
      WidgetTester tester,
    ) async {
      int downs = 0;
      for (final PttVisual busy in <PttVisual>[
        PttVisual.processing,
        PttVisual.justDone,
        PttVisual.disabled,
      ]) {
        await tester.pumpWidget(
          _wrap(
            PttBar(
              visual: busy,
              onDown: () async {
                downs++;
                return true;
              },
            ),
          ),
        );
        await tester.longPress(find.byType(PttBar));
        await tester.pump();
      }
      expect(downs, 0);
    });

    testWidgets('en locale renders the paired English copy', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _wrap(PttBar(visual: PttVisual.processing, strings: en)),
      );
      expect(find.text('Processing…'), findsOneWidget);
      await tester.pumpWidget(
        _wrap(PttBar(visual: PttVisual.idle, strings: en)),
      );
      expect(find.text('Hold to talk'), findsOneWidget);
    });
  });

  group('chat flow wiring — panel visibility follows the FSM', () {
    testWidgets(
      'R6 T-5d: the panel is UP for RECORDING and gone at idle/processing, and '
      'the PTT face walks the FSM',
      (WidgetTester tester) async {
        // The FSM is driven DIRECTLY here: a widget test must never await the
        // real PttSession async chain (audio.start → platform channel) inside
        // the FakeAsync zone — that deadlock has already bitten this repo.
        final FakeSocketTransport transport = FakeSocketTransport();
        final PttSession session = newTestSession(
          transport: transport,
          audio: AudioCapture(recorder: FakeAudioRecorder()),
        );
        final TimelineStore store = newTestStore();
        final DestinationController destination = DestinationController();
        final InMemoryLocalPrefs prefs = InMemoryLocalPrefs();
        final ChatController controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
          session: session,
          store: store,
          destination: destination,
          syncGate: TimelineSyncGate(transport: transport),
          localPrefs: prefs,
        );
        // Only the controller owns a timer here (its 200 ms panel ticker, never
        // started because pttDown was not called); the session's own teardown is
        // async plumbing this widget test deliberately does not enter.
        addTearDown(() async {
          await controller.dispose();
          destination.dispose();
          store.dispose();
        });

        transport.pushStatus(SocketStatus.connected);
        await tester.pumpWidget(
          MaterialApp(home: ChatFlowPage(controller: controller)),
        );
        expect(find.byType(RecordingPanel), findsNothing);
        expect(find.text('按住 说话'), findsOneWidget);

        session.fsm.onPttDown(); // → RECORDING
        await tester.pump();
        expect(find.byType(RecordingPanel), findsOneWidget);
        // WP8 VF-2: the `● ` layout glyph, see the PTT four-state group's note.
        expect(find.text('● 松开 结束'), findsOneWidget);
        // PA-3: m:ss face, and a HEALTHY link shows no link text (MD-3).
        expect(find.text('0:00'), findsOneWidget);
        expect(find.text('网络正常'), findsNothing);

        session.fsm.onPttUp(); // → PROCESSING: the panel collapses
        await tester.pump();
        expect(find.byType(RecordingPanel), findsNothing);
        expect(find.text('处理中…'), findsOneWidget);

        session.fsm.onSttFinal(); // → JUST_DONE
        await tester.pump();
        expect(find.text('已完成'), findsOneWidget);

        session.fsm.onJustDoneTimeout(); // → IDLE (also clears its timer)
        await tester.pump();
        expect(find.text('按住 说话'), findsOneWidget);
        expect(find.byType(RecordingPanel), findsNothing);
      },
    );

    testWidgets(
      'R6 T-5: a link drop raises the ONE slot; no second banner widget exists',
      (WidgetTester tester) async {
        final FakeSocketTransport transport = FakeSocketTransport();
        final PttSession session = newTestSession(
          transport: transport,
          audio: AudioCapture(recorder: FakeAudioRecorder()),
        );
        final TimelineStore store = newTestStore();
        final DestinationController destination = DestinationController();
        final InMemoryLocalPrefs prefs = InMemoryLocalPrefs();
        final ChatController controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
          session: session,
          store: store,
          destination: destination,
          syncGate: TimelineSyncGate(transport: transport),
          localPrefs: prefs,
        );
        addTearDown(() async {
          await controller.dispose();
          destination.dispose();
          store.dispose();
        });

        transport.pushStatus(SocketStatus.connected);
        await tester.pumpWidget(
          MaterialApp(home: ChatFlowPage(controller: controller)),
        );
        expect(find.byType(BannerSlot), findsOneWidget);
        expect(find.text('网络已断开 · 内容已缓冲'), findsNothing);

        transport.pushStatus(SocketStatus.reconnecting);
        await tester.pump();
        expect(find.text('正在重连 · 内容已缓冲'), findsOneWidget);

        transport.pushStatus(SocketStatus.disconnected);
        await tester.pump();
        expect(find.text('网络已断开 · 内容已缓冲'), findsOneWidget);
        expect(find.text('正在重连 · 内容已缓冲'), findsNothing); // replaced, not stacked
        expect(find.byType(BannerSlot), findsOneWidget); // still exactly one slot
        expect(find.text('未连接 · 暂时不能说话'), findsOneWidget); // PTT disabled face

        // owner ②: the disconnect above armed the sustained-disconnect watch.
        // Run it out inside the FakeAsync zone so no timer leaks past the body.
        await tester.pump(const Duration(seconds: 11));
        await tester.pumpAndSettle();
      },
    );
  });

  group('banner slot — single slot rendering (R6 T-5)', () {
    testWidgets('renders only the top entry + 「还有 N 条」, which expands to all', (
      WidgetTester tester,
    ) async {
      final BannerQueue q = BannerQueue()
        ..push(
          const BannerItem(
            id: 'a',
            severity: BannerSeverity.blocking,
            message: '阻断错误文案',
          ),
        )
        ..push(
          const BannerItem(
            id: 'b',
            severity: BannerSeverity.degraded,
            message: '降级警告文案',
          ),
        );
      await tester.pumpWidget(_wrap(BannerSlot(queue: q, strings: zh)));
      expect(find.text('阻断错误文案'), findsOneWidget);
      expect(find.text('降级警告文案'), findsNothing); // deferred, not stacked
      expect(find.text('还有 1 条'), findsOneWidget);

      await tester.tap(find.text('还有 1 条'));
      await tester.pumpAndSettle();
      expect(find.text('全部提示'), findsOneWidget);
      expect(find.text('降级警告文案'), findsOneWidget); // reachable, never swallowed
    });

    testWidgets('an empty queue renders nothing at all', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _wrap(BannerSlot(queue: BannerQueue(), strings: zh)),
      );
      expect(find.byType(Icon), findsNothing);
      expect(find.byType(Text), findsNothing);
    });

    testWidgets('R6 P0-R3 auto-stop copy still reaches the user, now through '
        'the slot, with a working ✕', (WidgetTester tester) async {
      bool dismissed = false;
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.connected,
        autoStopped: true,
        // 🔴 fix-026 added this line and nothing else. The banner's copy is now
        // chosen by the WIRE `reason`, so "which sentence" is a second question
        // from "is there a banner" — and an auto-stop with NO reason
        // deliberately renders the honest unknown sentence rather than the
        // five-minute one (the whole point of that card: the ceiling sentence
        // was being shown for every cause there is). This case's subject is
        // the SLOT and the ✕, so it names the ceiling explicitly and its
        // assertion below is unchanged.
        autoStopReason: 'hard_limit',
        strings: zh,
        onDismissAutoStop: () => dismissed = true,
      );
      await tester.pumpWidget(_wrap(BannerSlot(queue: q, strings: zh)));
      expect(find.text('录音已达 5 分钟上限，已自动停止'), findsOneWidget);
      expect(find.text('还有 1 条'), findsNothing);
      await tester.tap(find.byIcon(Icons.close));
      expect(dismissed, isTrue);
    });

    testWidgets('a live blocking link banner offers NO dismiss ✕', (
      WidgetTester tester,
    ) async {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.disconnected,
        autoStopped: false,
        strings: zh,
      );
      await tester.pumpWidget(_wrap(BannerSlot(queue: q, strings: zh)));
      expect(find.text('网络已断开 · 内容已缓冲'), findsOneWidget);
      expect(find.byIcon(Icons.close), findsNothing);
    });
  });
}

/// The animated white wash the recording pulse paints over the bar.
Color? _pulseWash(WidgetTester tester) {
  final Iterable<DecoratedBox> boxes = tester.widgetList<DecoratedBox>(
    find.byType(DecoratedBox),
  );
  for (final DecoratedBox box in boxes) {
    if (box.position != DecorationPosition.foreground) continue;
    final BoxDecoration d = box.decoration as BoxDecoration;
    if (d.color != null) return d.color;
  }
  return null;
}

/// The solid fill of the PTT bar.
///
/// Located by KEY, not by height. This helper used to say
/// `c.constraints?.maxHeight == 56`, so V2-03 raising the bar to 64 broke two
/// cases that only ever asserted a COLOUR — a magic dimension is not identity,
/// and it makes every future geometry change look like a regression.
Color? _barFill(WidgetTester tester) {
  final Container bar = tester.widget<Container>(
    find.byKey(const ValueKey<String>('ptt.bar')),
  );
  return (bar.decoration! as BoxDecoration).color;
}
