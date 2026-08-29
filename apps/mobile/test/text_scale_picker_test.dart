// 🔴 THE PICKER for the global text size — the control the user touches.
//
// Split out of `text_scale_test.dart` on 2026-08-27; that file's header carries
// the full story and `support/text_scale_rig.dart` carries the reason for the
// split. The one-sentence version: owner, on an English device, read the five
// chips Small / Medium / Large / Larger / Largest as 「two 'large' entries」, and
// ruled the row into ONE SLIDER whose current rung reads as a PERCENTAGE
// (`docs/decisions/2026-08-27-owner-text-scale-slider.md`).
//
// ── What this file must prove ───────────────────────────────────────────────
// ① every one of the five rungs is REACHABLE through the real control on the
//    real page, and landing on one switches the whole page (the wiring
//    criterion — the chips it replaces once had ZERO references under `test/`
//    and the row could have been deleted with the suite staying green);
// ② the same gesture that moves the thumb is already on disk (即改即存, the
//    settings red line: this page has no save button);
// ③ 🔴 the thumb can come to rest ONLY on the five rungs — the one real risk a
//    slider adds over a row of chips;
// ④ the percentage the user reads is the one derived from the factor;
// ⑤ a screen-reader user is told what the control is AND what it is set to.
//
// ⚠️ What this file does NOT prove: anything about the rungs themselves (the
// factors, the system-curve multiplication, the overflow budgets). Those are
// `text_scale_test.dart`'s, and the ruling deliberately left them alone.
//
// ⚠️ Ruler, inherited unchanged: `flutter_test` paints in Ahem, every glyph a
// full-em square. 「Not clipped here ⇒ not clipped on a real device」 holds; the
// converse does not. Real-device unproven, as always in this suite.

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/legibility.dart';
import 'support/text_scale_rig.dart';

// The four shims below keep the moved cases **character-for-character** what
// they were in `text_scale_test.dart` (see that move's diff discipline note in
// `support/text_scale_rig.dart`). They are one line each and they buy a diff
// in which nothing but the file name changed.
const String kTextScaleKey = kTextScalePrefKey;
final Finder _slider = textScaleSliderFinder;
String _pct(AppTextScale step) => textScalePct(step);
void _expectReadOutOnScreen(WidgetTester tester, Finder f, {required String reason}) =>
    expectTextScaleReadOutOnScreen(tester, f, reason: reason);
Future<AppSettingsController> _boot(Map<String, Object> initial) =>
    bootTextScale(initial);
void _tallViewport(WidgetTester tester) => tallSettingsViewport(tester);
typedef _SettingsRig = TextScaleSettingsRig;

void main() {
  // ── ②b 🔴 wiring: the slider really exists on the real settings page, and moving it really switches the step ──
  group('②b wiring (real page · real slider · real render tree)', () {
    // Where on the track the stop for [index] sits.
    //
    // 🔴 Why the 24px inset rather than lerping across the widget: Slider's
    // track is inset on both sides by the overlay radius, so a naive lerp
    // over `getRect` maps the ends onto the wrong rung. The inset does not
    // have to be exact — `divisions` snaps to the NEAREST stop, and on this
    // rig the track is ~1100px wide, so being a few px out is ~0.3% against a
    // half-division tolerance of 12.5%. What must not be sloppy is the
    // direction, and every case below asserts the rung it landed on by name,
    // so a mapping that is off by a whole stop reports itself.
    Future<void> tapRung(WidgetTester tester, int index) async {
      final Rect r = tester.getRect(_slider);
      const double inset = 24;
      final double frac = index / (AppTextScale.ladder.length - 1);
      await tester.tapAt(
        Offset(r.left + inset + (r.width - inset * 2) * frac, r.center.dy),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('every rung is reachable by tapping the track on a real SettingsPage, and landing on it switches the whole page',
        (WidgetTester tester) async {
      // 🔴 This case's criterion is the production key
      // `settings.textScale.slider` from `settings_preferences.dart`, driven
      // by `tester.tapAt` on a real `SettingsPage`, read back from
      // `MediaQuery.textScalerOf` **at the slider's own location** — the one
      // every `Text` in the same tree actually asks at layout. Four facts at
      // once: the row is there, it is interactive, a **tap on the track**
      // (not only a drag) applies, and it reaches the render tree.
      //
      // 🔴 **Why walk every rung**: wiring every stop to the same rung is the
      // copy-paste slip a "move it once" test cannot see. This is inherited
      // verbatim from the chip era and is the reason this loop survives the
      // control changing shape.
      //
      // 🔴 Reverse control [measured 2026-08-27, dev-pc-a], and the
      // FIRST ATTEMPT AT IT WAS WRONG, which is the part worth keeping:
      //   · neutering `onChanged` alone (`onChanged: (double v) {}`) left
      //     **all 21 cases green**. A tap on the track fires `onChanged` AND
      //     `onChangeEnd`, so either one alone still applies it. My comment
      //     had already claimed that run went red — it did not, and the claim
      //     would have shipped as a measured fact that was never measured.
      //   · neutering BOTH is what goes red, and it goes red here first,
      //     verbatim:
      //       tapping the stop for small did not land on the controller
      //       Expected: AppTextScale:<AppTextScale.small>
      //         Actual: AppTextScale:<AppTextScale.large>
      //     (the sweep case below goes red in the same run — two cards, so
      //     「the row is unwired」 cannot be reported by only one of them.)
      // Restored from a byte copy, re-greened, `REVERSE-CONTROL-0827`
      // leftover-string grep = 0.
      //
      // ⇒ **Stated plainly rather than papered over: these cases pin that the
      // pair applies, not that each half is necessary.** The redundancy is
      // deliberate (see the row's own comment) and this file cannot tell the
      // two callbacks apart through a tap, because Flutter fires both.
      _tallViewport(tester);
      final AppSettingsController c = await _boot(<String, Object>{});
      addTearDown(c.dispose);
      final _SettingsRig rig = await _SettingsRig.create(c);
      addTearDown(rig.dispose);

      await tester.pumpWidget(rig.widget());
      await tester.pumpAndSettle();

      // Named up front so「the row was deleted」reports itself as that, instead
      // of as a bare `Bad state: No element` out of `tapAt` (page_guides_test.dart
      // wrote that lesson down after its own reverse control).
      expect(
        _slider,
        findsOneWidget,
        reason: 'the settings page has no `settings.textScale.slider` — '
            'the text-size row is no longer in the product',
      );
      // The row's title and note must also be there (a control with no title
      // cannot answer "what is this", and the note is the only place that says
      // the percentage rides ON TOP OF the system font size).
      final AppStrings s = AppStrings.of(c.locale);
      expect(find.text(s.textScaleTitle), findsOneWidget);
      expect(find.text(s.textScaleNote(_pct(AppTextScale.large))), findsOneWidget);

      // Reading is taken at the slider's own location — it sits under TextScaleScope.
      double scalerAtSlider() =>
          MediaQuery.textScalerOf(tester.element(_slider)).scale(10);

      expect(scalerAtSlider(), closeTo(10.0, 1e-9),
          reason: 'the default is no longer `large`');

      final List<AppTextScale> ladder = AppTextScale.ladder;
      for (int i = 0; i < ladder.length; i++) {
        final AppTextScale step = ladder[i];
        await tapRung(tester, i);
        expect(c.textScale, step,
            reason: 'tapping the stop for ${step.name} did not land on the controller');
        expect(
          scalerAtSlider(),
          closeTo(10 * step.factor, 1e-9),
          reason: 'after tapping the stop for ${step.name} the whole page did not switch to '
              'this rung — the slider either is not wired to setTextScale, or this stop is '
              'wired to a different rung',
        );
        // 即改即存 (apply-and-save-immediately, the settings red line): there
        // is no save button anywhere on this page, so the same gesture that
        // moved the thumb must already be on disk.
        final SharedPreferences p = await SharedPreferences.getInstance();
        expect(p.getString(kTextScaleKey), step.name,
            reason: 'the tap that moved the thumb to ${step.name} did not persist in the same gesture');
      }
      // Land back on the default so later reads in this file are unsurprising.
      await tapRung(tester, ladder.indexOf(AppTextScale.large));
    });

    testWidgets('🔴 a real DRAG lands and is on disk by the time the finger is lifted',
        (WidgetTester tester) async {
      // The other half of 「即改即存」 for a control that has two ways of being
      // used. The tap case above cannot stand in for this one: a tap is a
      // single synthetic event pair, while a drag is a stream of moves ending
      // in an up — and it is entirely possible to write a slider that tracks
      // the finger beautifully and commits nothing (that IS the shape of a
      // save-button design, which this page does not have).
      _tallViewport(tester);
      final AppSettingsController c = await _boot(<String, Object>{});
      addTearDown(c.dispose);
      final _SettingsRig rig = await _SettingsRig.create(c);
      addTearDown(rig.dispose);
      await tester.pumpWidget(rig.widget());
      await tester.pumpAndSettle();
      final SharedPreferences p = await SharedPreferences.getInstance();

      // The default rung is the MIDDLE stop (large, index 2 of 4), so the
      // thumb starts under `tester.drag`'s own start point — the centre of
      // the widget. Overshooting the end on purpose: the clamp is part of
      // what is being asserted.
      await tester.drag(_slider, Offset(tester.getSize(_slider).width, 0));
      await tester.pumpAndSettle();
      expect(c.textScale, AppTextScale.xxlarge,
          reason: 'dragging to the far right did not land on the biggest rung');
      expect(p.getString(kTextScaleKey), AppTextScale.xxlarge.name,
          reason: 'the drag moved the thumb but never reached disk — there is no save button on this page');

      await tester.drag(_slider, Offset(-tester.getSize(_slider).width * 2, 0));
      await tester.pumpAndSettle();
      expect(c.textScale, AppTextScale.small,
          reason: 'dragging to the far left did not land on the smallest rung');
      expect(p.getString(kTextScaleKey), AppTextScale.small.name);
    });

    testWidgets('🔴 the thumb can only ever come to rest on the five rungs — no in-between value can be persisted',
        (WidgetTester tester) async {
      // 🔴 THE ASSERTION THAT DID NOT EXIST IN THE CHIP ERA, and the one real
      // risk this control shape adds. A chip could only ever say one rung; a
      // slider carries a continuous double, and 「0.92 arrived on disk」 is a
      // state the whole rest of this card cannot survive (`load()`'s whitelist
      // would silently return it to the default arm, i.e. the user's choice
      // vanishes at next launch and nothing anywhere says so).
      //
      // The sweep is deliberately BLIND to the track geometry: it walks 21
      // positions across the whole widget, including both dead zones outside
      // the track. Every one of them must land on a rung, and reading left to
      // right the rungs must never go backwards — that second half is what
      // would catch a `ladder` accidentally driven off declaration order
      // (`large, medium, small, xlarge, xxlarge`), which is the order the
      // STORAGE contract uses and would put 「biggest」 in the middle.
      _tallViewport(tester);
      final AppSettingsController c = await _boot(<String, Object>{});
      addTearDown(c.dispose);
      final _SettingsRig rig = await _SettingsRig.create(c);
      addTearDown(rig.dispose);
      await tester.pumpWidget(rig.widget());
      await tester.pumpAndSettle();

      final SharedPreferences p = await SharedPreferences.getInstance();
      final List<double> factors = <double>[];
      for (int i = 0; i <= 20; i++) {
        // 🔴 The rect is re-read EVERY iteration, and that is not defensive
        // style — it is a property of this control that the chip row did not
        // have. Applying a rung re-lays-out the whole page against the new
        // `textScaler`, so **the slider moves under the finger**: every row
        // above it changes height. [measured 2026-08-27] hoisting this read
        // out of the loop made all 21 taps after the first one miss the
        // widget entirely, and the case still passed every per-iteration
        // assertion — only the positive control at the bottom reported it
        // ("the sweep only ever reached 1 rung(s)"). That is precisely why
        // that control is there.
        final Rect r = tester.getRect(_slider);
        await tester.tapAt(Offset(r.left + r.width * (i / 20), r.center.dy));
        await tester.pumpAndSettle();

        expect(AppTextScale.values, contains(c.textScale));
        expect(
          AppTextScale.values.map((AppTextScale s) => s.name),
          contains(p.getString(kTextScaleKey)),
          reason: 'position ${i / 20} persisted "${p.getString(kTextScaleKey)}", which is not one of the five rungs',
        );
        // The widget's own value is an index, so it must be a whole number:
        // this is the reading that would go red if `divisions` were dropped.
        final double v = tester.widget<Slider>(_slider).value;
        expect(v, v.roundToDouble(),
            reason: 'position ${i / 20} left the thumb at $v, between two rungs');
        expect(v, AppTextScale.ladder.indexOf(c.textScale).toDouble(),
            reason: 'the thumb and the controller disagree about which rung is current');
        factors.add(c.textScale.factor);
      }
      for (int i = 1; i < factors.length; i++) {
        expect(factors[i], greaterThanOrEqualTo(factors[i - 1]),
            reason: 'moving RIGHT along the track made the text SMALLER '
                '(${factors[i - 1]} → ${factors[i]}) ⇒ the stops are not in size order');
      }
      // Positive control: without it, a slider stuck on one rung passes every
      // assertion above (all-equal is trivially non-decreasing, and one rung
      // is trivially "one of the five").
      expect(factors.toSet().length, AppTextScale.values.length,
          reason: 'the sweep only ever reached ${factors.toSet().length} rung(s) ⇒ '
              'this case measured nothing about the other four');
    });

    testWidgets('🔴 the percentage the user reads is the one derived from the factor, at every rung (rendered, not Text.data alone)',
        (WidgetTester tester) async {
      // 92 / 100 / 109 / 125 / 141 — but written NOWHERE in this case: the
      // expected string is derived from `factor` the same way the product
      // derives it. A literal table here would be the exact mistake the
      // ruling deleted one layer up (a second table that keeps saying the old
      // number after somebody moves a factor), and it would be a table that
      // agrees with the product only by luck.
      //
      // ⚠️ `find.text` alone reads `Text.data` — the 0.2.53 law. The
      // legibility check is what lands this on the rendered result: a
      // percentage clipped to 「14…」 answers no question at all.
      _tallViewport(tester);
      for (final AppTextScale step in AppTextScale.ladder) {
        final AppSettingsController c = await _boot(<String, Object>{
          kTextScaleKey: step.name,
        });
        addTearDown(c.dispose);
        final _SettingsRig rig = await _SettingsRig.create(c);
        addTearDown(rig.dispose);
        await tester.pumpWidget(rig.widget());
        await tester.pumpAndSettle();

        final Finder readOut =
            find.byKey(const ValueKey<String>('settings.textScale.percent'));
        expect(readOut, findsOneWidget, reason: '${step.name}: no percentage read-out on the row');
        expect(tester.widget<Text>(readOut).data, _pct(step),
            reason: '${step.name}: the row says "${tester.widget<Text>(readOut).data}", '
                'the factor ${step.factor} says "${_pct(step)}"');
        _expectReadOutOnScreen(tester, readOut, reason: '${step.name} read-out');
        // The drag bubble and the screen reader must not be able to disagree
        // with the read-out: one rung, one number, four surfaces.
        expect(tester.widget<Slider>(_slider).label, _pct(step));
      }
    });

    testWidgets('🔴 accessibility: the slider is named by the row title and announces the percentage, not "50%" of its own range',
        (WidgetTester tester) async {
      // Without this, TalkBack reads an unnamed slider at 「75%」 — the
      // fraction of ITS OWN RANGE (3 of 4 divisions), a number that is not
      // the text size, is not on screen anywhere, and moves for a different
      // reason than the one the user is adjusting. That is this repo's
      // headline shape (one value answering a second question) delivered
      // straight into the ear of the user who most needs this row.
      // ⚠️ Disposed at the END OF THE BODY, not via `addTearDown` — tear-downs
      // run after the framework's end-of-test check, which then reports 「a
      // SemanticsHandle was active at the end of the test」 (measured here,
      // and already written down in `at_cancel_semantics_test.dart`).
      final SemanticsHandle handle = tester.ensureSemantics();
      _tallViewport(tester);
      final AppSettingsController c = await _boot(<String, Object>{
        kTextScaleKey: AppTextScale.xxlarge.name,
      });
      addTearDown(c.dispose);
      final _SettingsRig rig = await _SettingsRig.create(c);
      addTearDown(rig.dispose);
      await tester.pumpWidget(rig.widget());
      await tester.pumpAndSettle();

      final AppStrings s = AppStrings.of(c.locale);
      expect(
        tester.getSemantics(_slider),
        // `isSemantics`, not `containsSemantics`: the latter is deprecated as
        // of 3.40 and `flutter analyze` is a zero-issue gate here. Same
        // leniency (unspecified fields are not asserted) — `matchesSemantics`
        // would additionally demand every flag and action be spelled out.
        //
        // `value` comes from `semanticFormatterCallback`. Without it the node
        // announces `'${(value * 100).round()}%'` of the slider's OWN RANGE
        // (`slider.dart`'s else-branch, grep `config.value = '$`) — for the
        // top rung that is 「100%」 and for the middle one 「50%」, numbers that
        // are not the text size and move for a different reason.
        isSemantics(
          value: _pct(AppTextScale.xxlarge),
          isSlider: true,
          // Both actions, at every rung: Flutter registers them whenever the
          // slider is interactive and clamps at the ends. Asserting them is
          // what makes this a **usable** control without sight — the value
          // could be announced perfectly by a slider nobody can move.
          hasIncreaseAction: true,
          hasDecreaseAction: true,
        ),
        reason: 'the slider does not announce the size it is set to',
      );
      // 🔴 The name is asserted separately, with `contains`, because
      // `Slider.label` **answers two questions at once** — Flutter puts it in
      // the value-indicator bubble AND straight into the semantics label
      // (`slider.dart`: `Semantics(label: widget.label, container: true,
      // slider: true, …)`). We need the bubble to read 「141%」, so the label
      // this row supplies must be MERGED with it rather than replace it,
      // which is what the `MergeSemantics` in `settings_preferences.dart` is
      // there for. The merged label is therefore the title AND the
      // percentage; what must never be true is that the row's own name is
      // absent, because then a screen-reader user is told a number with no
      // idea what it sizes.
      expect(
        tester.getSemantics(_slider).getSemanticsData().label,
        contains(s.textScaleTitle),
        reason: 'the slider node is unnamed — TalkBack would announce a bare percentage',
      );
      handle.dispose();
    });
  });

  // ── the row's own layout on the narrowest screen this product claims ──────
  group('⑤b the slider row at 320dp', () {
    testWidgets('🔴 the slider row itself: 320dp, every rung, title + read-out + note all survive',
        (WidgetTester tester) async {
      // 🔴 NEW WITH THE SLIDER (2026-08-27). The chip row wrapped, so it could
      // not overflow horizontally by construction; this row cannot wrap — a
      // Slider has a fixed height and the title now shares one line with a
      // read-out that must never be the thing squeezed. 320dp is the
      // narrowest screen this product claims, and the top rung is where the
      // title is widest.
      //
      // ⚠️ Ruler, per this file's header and `support/legibility.dart`: the
      // box is `ahemWidthFor(320, locale)`, not a bare 320. The bare number
      // would be doing two jobs at once — 「the product must work at 320dp」
      // and 「how much Ahem inflates this script」 — and Latin at 320 is a
      // guaranteed false red.
      //
      // ru is measured alongside en because 「Размер текста」 is the longest
      // title of the nine, and Cyrillic carries Latin's inflation factor.
      for (final AppLocale locale in <AppLocale>[AppLocale.en, AppLocale.ru]) {
        for (final AppTextScale step in AppTextScale.ladder) {
          tester.view.physicalSize =
              Size(ahemWidthFor(320, locale), 4200);
          tester.view.devicePixelRatio = 1.0;
          addTearDown(tester.view.reset);

          final AppSettingsController c = await _boot(<String, Object>{
            kTextScaleKey: step.name,
          });
          addTearDown(c.dispose);
          c.setLocale(locale);
          final _SettingsRig rig = await _SettingsRig.create(c);
          addTearDown(rig.dispose);
          await tester.pumpWidget(rig.widget());
          await tester.pumpAndSettle();

          expect(
            tester.takeException(),
            isNull,
            reason: 'the settings page overflowed at ${step.name} / ${locale.name} on a 320dp screen',
          );
          final AppStrings s = AppStrings.of(locale);
          // Not just 「nothing threw」: the three things this row has to say
          // must each still be readable. An Expanded title that wrapped to
          // four lines throws nothing at all.
          _expectReadOutOnScreen(
            tester,
            find.byKey(const ValueKey<String>('settings.textScale.percent')),
            reason: '${step.name}/${locale.name} read-out',
          );
          expectLegible(tester, find.text(s.textScaleTitle),
              reason: '${step.name}/${locale.name} title');
          expectLegible(
            tester,
            find.text(s.textScaleNote(_pct(AppTextScale.large))),
            reason: '${step.name}/${locale.name} note',
          );
          expect(_slider, findsOneWidget);
        }
      }
    });
  });
}
