// Card U12 — accessibility for the press-to-talk control.
//
// `ptt_bar.dart` had ZERO `Semantics` in the file before this card: a
// GestureDetector with no accessible name, no state, and — the part that
// makes a naive fix WORSE than nothing — a payload that is press DURATION.
// A screen reader's default activation (double-tap / Switch Access
// single-activate) opens and closes a gesture recognizer in one frame, so a
// `Semantics(button:true, onTap: syntheticDownThenUp)` would look accessible
// while capturing an empty utterance every time — the exact fake affordance
// the project's red line forbids ("a control that changes nothing is worse
// than no control").
//
// The fix makes activation a TOGGLE instead of a synthetic tap: activation 1
// starts the hold, activation 2 (independent, whenever the user is ready)
// ends it — same FSM edges as the touch path, same [_active] guard, just two
// discrete steps instead of one continuous gesture. See
// `PttBar._handleSemanticActivate` for the full reasoning and the
// DOCUMENTED GAP (no AT-accessible cancel — left open, not faked).
//
// 🔴 REVERSE CONTROL — actually executed: with the `Semantics(...)` wrapper
// in ptt_bar.dart's `build()` deleted (GestureDetector returned bare), 3 of
// the 7 tests in this file went red:
//   (a) idle test — NOT at `find.bySemanticsLabel` as first assumed (that
//       stayed green: the plain `Text` widget still auto-generates a
//       semantics node carrying its own string as the label, wrapper or
//       not) — it actually failed one line later, at
//       `hasFlag(SemanticsFlag.isButton)` (`true` → `false`): the label
//       survives, the button/enabled/activation semantics do not.
//   (b) processing test — same shape, `hasFlag(SemanticsFlag.hasEnabledState)`
//       (`true` → `false`).
//   (c) two-activations test — first `expect(downCalls, 1)` stayed `0`:
//       nothing was wired to receive the activation at all.
// The 4 text-scale tests stayed green throughout (they exercise layout, not
// Semantics — correctly independent of this wrapper). Restoring the wrapper
// turned all 3 red tests green again (7/7). Residual marker string search
// after restore: grep=0 for "REVERSE-CONTROL-U12-REMOVED".

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/legibility.dart';

final AppStrings _en = AppStrings.of(AppLocale.en);

/// What the RECORDING face actually paints (WP8 VF-2).
///
/// The mock's recording bar reads `● 松开 结束`, and the leading dot is a LAYOUT
/// glyph concatenated in `ptt_bar.dart` — the owner-frozen sentence in the
/// strings shard is untouched. It deliberately does NOT reach the a11y label
/// (a screen reader would pronounce it), which is why this file needs two
/// spellings: `_en.pttRecording` for anything semantics-side, and this for
/// anything that looks at the painted `Text`.
final String _paintedRecording = '● ${_en.pttRecording}';

Widget _host({
  required PttVisual visual,
  Future<bool> Function()? onDown,
  Future<void> Function()? onUp,
  Future<void> Function()? onCancel,
  double textScale = 1.0,
}) => MaterialApp(
  home: MediaQuery(
    data: MediaQueryData(textScaler: TextScaler.linear(textScale)),
    child: Scaffold(
      // Mirrors chat_flow_composer.dart's real embedding: a plain Column
      // child (not Expanded/Center), so PttBar receives the same
      // (minHeight:0, maxHeight:infinity) constraint production gives it.
      body: SizedBox(
        width: 360,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            PttBar(
              visual: visual,
              strings: _en,
              onDown: onDown ?? () async => true,
              onUp: onUp ?? () async {},
              onCancel: onCancel ?? () async {},
            ),
          ],
        ),
      ),
    ),
  ),
);

void main() {
  group('U12 — semantics reach the tree, not just the widget', () {
    testWidgets('idle: labelled + exposed as a tappable button', (
      WidgetTester tester,
    ) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await tester.pumpWidget(_host(visual: PttVisual.idle));

      // The label reaches the SEMANTICS TREE (not merely `Text.data` — see
      // CLAUDE.md's standing rule on that distinction), and reaches it
      // EXACTLY ONCE: `excludeSemantics: true` on the wrapper must drop the
      // inner Text/Icon's own auto-generated nodes, or a screen reader would
      // announce the label twice.
      expect(find.bySemanticsLabel(_en.pttHold), findsOneWidget);

      final SemanticsNode node = tester.getSemantics(find.byType(PttBar));
      final SemanticsData data = node.getSemanticsData();
      expect(data.hasFlag(SemanticsFlag.isButton), isTrue);
      expect(data.hasFlag(SemanticsFlag.hasEnabledState), isTrue);
      expect(data.hasFlag(SemanticsFlag.isEnabled), isTrue);
      expect(
        data.hasAction(SemanticsAction.tap),
        isTrue,
        reason: 'enabled states must expose an accessible activation action',
      );

      handle.dispose();
    });

    testWidgets('processing: disabled state has NO tap action wired', (
      WidgetTester tester,
    ) async {
      // Card U12: a control the user cannot legally activate right now
      // (`_enabled` is false while PROCESSING/JUST_DONE/disabled) must not
      // claim otherwise — an AT user double-tapping a "button" that silently
      // does nothing is the same fake-affordance shape as the duration bug,
      // just on the disabled edge instead of the recording edge.
      final SemanticsHandle handle = tester.ensureSemantics();
      await tester.pumpWidget(_host(visual: PttVisual.processing));

      expect(find.bySemanticsLabel(_en.pttProcessing), findsOneWidget);
      final SemanticsNode node = tester.getSemantics(find.byType(PttBar));
      final SemanticsData data = node.getSemanticsData();
      expect(data.hasFlag(SemanticsFlag.hasEnabledState), isTrue);
      expect(data.hasFlag(SemanticsFlag.isEnabled), isFalse);
      expect(data.hasAction(SemanticsAction.tap), isFalse);

      handle.dispose();
    });

    testWidgets(
      'two independent activations start then stop — the honest accessible '
      'alternative to a held gesture',
      (WidgetTester tester) async {
        int downCalls = 0;
        int upCalls = 0;
        final SemanticsHandle handle = tester.ensureSemantics();
        await tester.pumpWidget(
          _host(
            visual: PttVisual.idle,
            onDown: () async {
              downCalls++;
              return true;
            },
            onUp: () async {
              upCalls++;
            },
          ),
        );

        final SemanticsNode node = tester.getSemantics(find.byType(PttBar));
        final SemanticsOwner owner = tester.binding.pipelineOwner.semanticsOwner!;

        // Activation 1: starts the hold. Reproduces the exact failure this
        // card is about — before the fix, nothing was wired to this action
        // at all (`node.hasAction(tap)` was false), so a screen reader's
        // default gesture did literally nothing.
        owner.performAction(node.id, SemanticsAction.tap);
        await tester.pumpAndSettle();
        expect(downCalls, 1);
        expect(upCalls, 0);

        // Activation 2: a SEPARATE, later user action ends the hold. The
        // interval between the two real taps is what carries the recording —
        // there is no synthetic instant down+up anywhere in this path.
        owner.performAction(node.id, SemanticsAction.tap);
        await tester.pumpAndSettle();
        expect(downCalls, 1);
        expect(upCalls, 1);

        handle.dispose();
      },
    );
  });

  group('U12 — text-scale must not clip the state label', () {
    // Before the fix: `Container(height: 64)` + `Row(mainAxisSize: min)` with
    // a bare `Text` (no Flexible). At scale >= ~1.6 the longest label
    // ("Release to send · swipe up to cancel") no longer fits `Row`'s
    // available width and Flutter throws "A RenderFlex overflowed by N
    // pixels on the right" — the literal yellow/black stripes the card
    // reports. Reproduced directly (then reverted) while building this fix:
    // the same host below, same scale, threw that exact assertion.
    for (final double scale in <double>[1.0, 1.5, 2.0]) {
      testWidgets('scale=$scale: no overflow, no clipped line', (
        WidgetTester tester,
      ) async {
        await tester.pumpWidget(
          _host(visual: PttVisual.recording, textScale: scale),
        );

        // No RenderFlex overflow (or any other) exception was thrown during
        // layout/paint for this frame.
        expect(tester.takeException(), isNull);

        // 🔴 W5a §8-2 fix: `didExceedMaxLines` alone is vacuous here —
        // `ptt_bar.dart`'s label Text never sets `maxLines`, so the getter
        // is structurally false regardless of whether the label actually got
        // cut off. `expectLegible` (support/legibility.dart) picks its
        // criterion from the paragraph's own structure instead of assuming
        // `maxLines` is set: softWrap, no ellipsis, finite width, and — if
        // the text needs more than one line's worth of width — the box
        // actually grew past one line instead of silently clipping.
        expectLegible(
          tester,
          find.text(_paintedRecording),
          reason: 'the label must be allowed to wrap, not get cut off',
        );
      });
    }

    testWidgets('the bar grows taller to fit a wrapped label instead of '
        'clipping it', (WidgetTester tester) async {
      Future<Size> barSizeAt(double scale, {required PttVisual visual}) async {
        await tester.pumpWidget(_host(visual: visual, textScale: scale));
        final RenderBox box = tester.renderObject(
          find.byKey(const ValueKey<String>('ptt.bar')),
        );
        return box.size;
      }

      // 🔴 WP8 VF-2 SPLIT THIS CASE IN TWO, and the split is an Ahem-ruler
      // fact rather than a weakened assertion.
      // The floor is 60 now (`.ptt{height:60px}`, was 64), and the label grew
      // 15 → 17sp WITH 1px of tracking. Under flutter_test's Ahem placeholder
      // font every glyph is a full em, so at 18px/char the EN recording
      // sentence ("Release to send · swipe up to cancel", the longest of the
      // six) already wraps to four lines at scale 1.0 in a 360dp bar — its box
      // is 84 there, for a reason that has nothing to do with whether the
      // floor is respected. (Real fonts lay that string out in ~250px, one
      // line; the 0.2.53 Ahem discipline is conservative in ONE direction, and
      // this is the other one.)
      // ⇒ the FLOOR is measured on a face whose label fits (idle), and the
      //   GROWTH on the face that wraps (recording). Both halves of the
      //   original guarantee are still pinned, each where it is measurable.
      expect(
        (await barSizeAt(1.0, visual: PttVisual.idle)).height,
        60,
        reason: 'the floor moved — `.ptt{height:60px}` is the mock value',
      );

      final Size at1 = await barSizeAt(1.0, visual: PttVisual.recording);
      final Size at2 = await barSizeAt(2.0, visual: PttVisual.recording);
      expect(
        at1.height,
        greaterThanOrEqualTo(60),
        reason: 'positive control: the wrapping face is never BELOW the floor',
      );
      expect(
        at2.height,
        greaterThan(at1.height),
        reason:
            'a fixed 60 would have forced the wrapped second line into the '
            'same box — height must be a floor (minHeight), not a cap',
      );
    });
  });
}
