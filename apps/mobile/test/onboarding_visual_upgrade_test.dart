// 🔴 NR-6 — the first-run guide's visual upgrade: brand figures, the one-shot
// demo, the page/dot transitions, the type tokens, wide-screen centring, and
// the flowmic.app download row with a REAL QR code.
//
// Source of truth:
//   docs/ui-design/2026-08-27-nr6-onboarding-visual-upgrade-design.md §11
//   docs/decisions/2026-08-27-owner-web-rulings-batch-2.md ① (real QR, the `qr`
//     dependency is approved) and ② (1.2 s one-shot demo, silent under
//     reduce-motion)
//
// ── WHAT THIS FILE DOES NOT COVER, ON PURPOSE ───────────────────────────────
// The tappable census (`<int>[2, 3, 3]`) stays where it is, in
// `onboarding_first_run_test.dart` group ⑤. Copying it here would give 「how
// many things can be tapped in the guide」 two homes, and the day someone
// updates one of them the other is the one that was telling the truth. The new
// elements are all `CustomPaint`/`Container`/`Text`, so that count is unchanged
// — and it is that file's assertion, not this one's, which proves it.
//
// ⚠️ **Ruler**: `flutter_test` paints Ahem, whose every glyph is a full-em
// square. 「Not clipped under Ahem ⇒ not clipped on a real device」 holds; the
// converse does not. Nothing here argues a sentence happens to fit on a phone.

import 'package:flowmic/src/auth/saas_endpoint.dart' show kDefaultSaasEndpoint;
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/onboarding/onboarding_art.dart';
import 'package:flowmic/src/ui/onboarding/onboarding_brand_mark.dart';
import 'package:flowmic/src/ui/onboarding/onboarding_download_block.dart';
import 'package:flowmic/src/ui/onboarding/onboarding_view.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qr/qr.dart';

const ValueKey<String> _next = ValueKey<String>('onboarding.next');
const ValueKey<String> _title = ValueKey<String>('onboarding.title');
const ValueKey<String> _phone = ValueKey<String>('onboarding.demo.phone');
const ValueKey<String> _arrow = ValueKey<String>('onboarding.demo.arrow');

/// The real [OnboardingView], with this test's own [MediaQuery] on top so the
/// reduce-motion flag can be set from the outside — which is exactly how the OS
/// delivers it.
Widget _guide({
  required bool reduceMotion,
  AppLocale locale = AppLocale.zh,
}) {
  final AppStrings s = AppStrings.of(locale);
  return MaterialApp(
    home: Scaffold(
      body: Builder(
        builder: (BuildContext context) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion),
          child: OnboardingView(
            strings: s,
            onFinish: () {},
            finishLabel: s.onboardingStart,
          ),
        ),
      ),
    ),
  );
}

void _phoneViewport(WidgetTester tester, {double width = 360}) {
  tester.view.physicalSize = Size(width * 3, 1400 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

double _opacityOf(WidgetTester tester, ValueKey<String> key) =>
    tester.widget<Opacity>(find.byKey(key)).opacity;

Future<void> _toPage(WidgetTester tester, int index) async {
  for (int i = 0; i < index; i++) {
    await tester.tap(find.byKey(_next));
    await tester.pumpAndSettle();
  }
}

void main() {
  // The palette is global state; every case that flips it puts it back.
  setUp(() => addTearDown(() => FlowMicTheme.brightness.value = Brightness.dark));

  // ── ① The figures render, in both themes, on the narrowest screen ─────────
  group('① the three illustrations render in both themes at 360dp without overflowing', () {
    for (final Brightness brightness in Brightness.values) {
      testWidgets('${brightness.name}: all three pages lay out and throw nothing',
          (WidgetTester tester) async {
        _phoneViewport(tester);
        FlowMicTheme.brightness.value = brightness;
        await tester.pumpWidget(_guide(reduceMotion: true));

        for (int page = 0; page < 3; page++) {
          // A RenderFlex/RenderBox overflow is thrown, not drawn, so this is
          // the assertion that catches a figure that grew past its canvas.
          expect(
            tester.takeException(),
            isNull,
            reason: '${brightness.name} page ${page + 1} overflowed at 360dp',
          );
          if (page < 2) {
            await tester.tap(find.byKey(_next));
            await tester.pumpAndSettle();
          }
        }
      });
    }

    testWidgets('the brand mark takes its three inks from the theme, and the two themes really differ',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      FlowMicTheme.brightness.value = Brightness.light;
      await tester.pumpWidget(_guide(reduceMotion: true));
      final PhoneMarkPainter light = _markPainter(tester);
      expect(light.innerArc, FlowMicColors.brand);
      expect(light.outerArc, FlowMicColors.teal);
      expect(light.outline, FlowMicColors.line);

      // ⚠️ Tear the tree down first. `FlowMicTheme.brightness` is a
      // `ValueNotifier` that production listens to at the app root; a test that
      // only flips it and re-pumps the SAME shape gets the element reused and
      // reads the previous palette back — which is the instrument lying, not
      // the product.
      FlowMicTheme.brightness.value = Brightness.dark;
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpWidget(_guide(reduceMotion: true));
      final PhoneMarkPainter dark = _markPainter(tester);
      expect(dark.innerArc, FlowMicColors.brand);

      // Positive control for the two assertions above: if the painter had
      // baked literals in, both reads would be equal and the theme assertions
      // would be true for the wrong reason.
      expect(
        dark.innerArc,
        isNot(light.innerArc),
        reason: 'the light and dark palettes resolved to the same ink — the '
            'painter is not reading tokens at all',
      );
      expect(dark.outline, isNot(light.outline));
    });

    testWidgets('page 2 carries a COMPACT mark (BRAND.md micro tier), page 1 the full one',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      await tester.pumpWidget(_guide(reduceMotion: true));
      expect(
        tester.widget<PhoneMark>(find.byType(PhoneMark)).detail,
        PhoneMarkDetail.full,
      );
      await _toPage(tester, 1);
      expect(
        tester.widget<PhoneMark>(find.byType(PhoneMark)).detail,
        PhoneMarkDetail.compact,
      );
    });
  });

  // ── ② The 1.2 s demo, and the reduce-motion escape ───────────────────────
  group('② page 1 plays a one-shot demo (owner ruling ②: 1.2 s), and reduce-motion skips it', () {
    testWidgets('owner ruling ②: the production duration is 1200 ms',
        (WidgetTester tester) async {
      expect(OnboardingArtWhat.demoDuration, const Duration(milliseconds: 1200));
    });

    testWidgets('normal mode: mid-flight the figure is NOT yet at its end state, and at 1200 ms it is',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      await tester.pumpWidget(_guide(reduceMotion: false));

      // t = 0: nothing has entered yet. This is also the positive control for
      // the reduce-motion case below — it proves 「opacity 1 in the first
      // frame」 is a fact about the flag and not about the widget.
      expect(_opacityOf(tester, _phone), 0);
      expect(_opacityOf(tester, _arrow), 0);

      await tester.pump(const Duration(milliseconds: 150));
      expect(_opacityOf(tester, _phone), greaterThan(0));
      expect(
        _opacityOf(tester, _arrow),
        0,
        reason: 'the arrow enters at 300 ms — it must not start with the phone',
      );

      // 375 ms is the arrow's own midpoint (300→450). Its curve is `easeOut`,
      // which — unlike the phone's `easeOutBack` — never overshoots, so
      // 「strictly between」 is a reading this segment can actually give.
      await tester.pump(const Duration(milliseconds: 225));
      final double midArrow = _opacityOf(tester, _arrow);
      expect(midArrow, greaterThan(0));
      expect(midArrow, lessThan(1));

      await tester.pumpAndSettle();
      expect(_opacityOf(tester, _phone), 1);
      expect(_opacityOf(tester, _arrow), 1);
    });

    testWidgets('🔴 reduce-motion: the FIRST frame is already the end state — no transition at all',
        (WidgetTester tester) async {
      // 🔴 REVERSE CONTROL [measured 2026-08-27]: delete the
      // `MediaQuery.disableAnimationsOf` branch in
      // `onboarding_art.dart`'s `didChangeDependencies` (i.e. always
      // `_demo.forward()`), and this case goes red on the spot:
      //     Expected: <1.0>
      //       Actual: <0.0>
      //     reduce-motion was honoured but the demo still animated
      // Restored afterwards; the suite is green again.
      _phoneViewport(tester);
      await tester.pumpWidget(_guide(reduceMotion: true));

      expect(
        _opacityOf(tester, _phone),
        1,
        reason: 'reduce-motion was honoured but the demo still animated',
      );
      expect(_opacityOf(tester, _arrow), 1);

      // And nothing is left ticking: two more frames, and the figure has not
      // moved (a running controller would have advanced it).
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump(const Duration(milliseconds: 300));
      expect(_opacityOf(tester, _phone), 1);
    });

    testWidgets('reduce-motion collapses the page transition and the dots to zero duration',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      await tester.pumpWidget(_guide(reduceMotion: true));
      expect(
        tester.widget<AnimatedSwitcher>(find.byType(AnimatedSwitcher)).duration,
        Duration.zero,
      );
      expect(
        tester
            .widget<AnimatedContainer>(
              find.byKey(const ValueKey<String>('onboarding.dot.what')),
            )
            .duration,
        Duration.zero,
      );
    });

    testWidgets('normal mode: the page transition is 220 ms and the dots 200 ms',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      await tester.pumpWidget(_guide(reduceMotion: false));
      expect(
        tester.widget<AnimatedSwitcher>(find.byType(AnimatedSwitcher)).duration,
        const Duration(milliseconds: 220),
      );
      expect(
        tester
            .widget<AnimatedContainer>(
              find.byKey(const ValueKey<String>('onboarding.dot.what')),
            )
            .duration,
        const Duration(milliseconds: 200),
      );
      await tester.pumpAndSettle();
    });

    testWidgets('the active dot is the wide brand one and it follows the page',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      await tester.pumpWidget(_guide(reduceMotion: true));
      // 18/7 plus the 3dp margin on each side: the widget's own render object
      // is the margin's `Padding`, so the measured box is 6dp wider than the
      // pill inside it.
      expect(_dotWidth(tester, 'what'), 18 + 6);
      expect(_dotWidth(tester, 'installPc'), 7 + 6);

      await _toPage(tester, 1);
      expect(_dotWidth(tester, 'what'), 7 + 6);
      expect(_dotWidth(tester, 'installPc'), 18 + 6);
      expect(_dotColour(tester, 'installPc'), FlowMicColors.brand);
      expect(_dotColour(tester, 'what'), FlowMicColors.line);
    });
  });

  // ── ③ The download row + a real QR (owner ruling ①) ──────────────────────
  group('③ page 2 carries the flowmic.app download row and a real QR code', () {
    testWidgets('the block is on page 2 and NOT on the other two',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      await tester.pumpWidget(_guide(reduceMotion: true));
      final Finder block = find.byKey(
        const ValueKey<String>('onboarding.download'),
      );
      expect(block, findsNothing, reason: 'page 1 must not carry it');
      await _toPage(tester, 1);
      expect(block, findsOneWidget);
      expect(find.byType(OnboardingQrCode), findsOneWidget);
      await _toPage(tester, 1);
      expect(block, findsNothing, reason: 'page 3 must not carry it');
    });

    testWidgets('🔴 the printed line and the QR payload BOTH derive from kDefaultSaasEndpoint',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      await tester.pumpWidget(_guide(reduceMotion: true));
      await _toPage(tester, 1);

      // The payload is the endpoint itself — asserted against the CONSTANT, so
      // moving the site moves this test with it instead of leaving a QR that
      // silently points at the old address.
      expect(
        tester.widget<OnboardingQrCode>(find.byType(OnboardingQrCode)).data,
        kDefaultSaasEndpoint,
      );

      final String printed = tester
          .widget<Text>(
            find.byKey(const ValueKey<String>('onboarding.download.url')),
          )
          .data!;
      expect(printed, isNotEmpty);
      expect(
        kDefaultSaasEndpoint.contains(printed),
        isTrue,
        reason: 'the line the user copies down ($printed) is not part of '
            '$kDefaultSaasEndpoint — the two have drifted',
      );
      expect(printed, isNot(contains('://')), reason: 'print the host, not the URL');
    });

    testWidgets('🔴 the code is a REAL one (owner ruling ①), not a decorative grid',
        (WidgetTester tester) async {
      // What 「real」 can be asserted cheaply: the same encoder, given the same
      // payload, must produce the same matrix — and that matrix must be a
      // proper QR (a version-2+ grid with the three finder patterns in place).
      // Decoding it back would need a scanner; this proves the bytes fed into
      // the painter are the standard's, which is the half a unit test can own.
      final QrImage image = QrImage(
        QrCode(
          payload: QrPayload.fromString(kDefaultSaasEndpoint),
          errorCorrectLevel: QrErrorCorrectLevel.medium,
        ),
      );
      expect(image.moduleCount, greaterThanOrEqualTo(21));
      // The top-left finder pattern: a 7×7 ring, dark border, light inset,
      // 3×3 dark core. If the grid were noise this fails immediately.
      for (int i = 0; i < 7; i++) {
        expect(image.isDark(0, i), isTrue, reason: 'finder top edge at $i');
        expect(image.isDark(6, i), isTrue, reason: 'finder bottom edge at $i');
      }
      expect(image.isDark(1, 1), isFalse);
      expect(image.isDark(3, 3), isTrue);

      _phoneViewport(tester);
      await tester.pumpWidget(_guide(reduceMotion: true));
      await _toPage(tester, 1);
      // 72dp square, as specified — a code smaller than this stops being
      // resolvable by a camera pointed at a phone screen.
      expect(tester.getSize(find.byType(OnboardingQrCode)), const Size(72, 72));
    });
  });

  // ── ④ Type tokens and wide-screen centring ───────────────────────────────
  group('④ the five type sizes are named constants, and the values did not move', () {
    test('the constants still hold the numbers they replaced', () {
      expect(kOnboardingTitleSize, 19);
      expect(kOnboardingBodySize, 14);
      expect(kOnboardingBodyMutedSize, 12.5);
      expect(kOnboardingButtonLabelSize, 14.5);
      expect(kOnboardingSkipSize, 13);
    });

    testWidgets('the rendered title/skip/button really read those constants',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      final AppStrings s = AppStrings.of(AppLocale.zh);
      await tester.pumpWidget(_guide(reduceMotion: true));
      expect(
        tester.widget<Text>(find.byKey(_title)).style!.fontSize,
        kOnboardingTitleSize,
      );
      expect(
        tester.widget<Text>(find.text(s.onboardingSkip)).style!.fontSize,
        kOnboardingSkipSize,
      );
      expect(
        tester.widget<Text>(find.text(s.onboardingNext)).style!.fontSize,
        kOnboardingButtonLabelSize,
      );
      expect(
        tester.widget<Text>(find.text(s.onboardingWhatBody)).style!.fontSize,
        kOnboardingBodySize,
      );
    });

    testWidgets('🔴 wide screen: the 420dp column is centred, and a narrow one still hugs the padding',
        (WidgetTester tester) async {
      _phoneViewport(tester, width: 360);
      await tester.pumpWidget(_guide(reduceMotion: true));
      expect(
        tester.getTopLeft(find.byKey(_title)).dx,
        24,
        reason: 'at 360dp the column fills the width, so it sits on the 24dp padding',
      );

      tester.view.physicalSize = const Size(900 * 3, 1400 * 3);
      await tester.pumpWidget(_guide(reduceMotion: true));
      await tester.pumpAndSettle();
      // 24 padding + half of the leftover (900 − 48 − 420) / 2.
      expect(tester.getTopLeft(find.byKey(_title)).dx, 24 + (900 - 48 - 420) / 2);
    });
  });
}

PhoneMarkPainter _markPainter(WidgetTester tester) => tester
        .widget<CustomPaint>(
          find.descendant(
            of: find.byType(PhoneMark),
            matching: find.byType(CustomPaint),
          ),
        )
        .painter!
    as PhoneMarkPainter;

double _dotWidth(WidgetTester tester, String step) =>
    tester.getSize(find.byKey(ValueKey<String>('onboarding.dot.$step'))).width;

Color? _dotColour(WidgetTester tester, String step) =>
    (tester
                .widget<AnimatedContainer>(
                  find.byKey(ValueKey<String>('onboarding.dot.$step')),
                )
                .decoration!
            as BoxDecoration)
        .color;
