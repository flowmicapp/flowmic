// NR-123 (D-15): the two NEW strings must be READABLE on the real chat screen,
// not merely present. `polish_badge_screen_test.dart` asserts `find.text(...)`
// (true for a clipped layout too) and `polish_badge_geometry_test.dart` only
// measures the `polishUnavailable` label. This file mounts the real
// `ChatFlowPage` on a 360 dp phone at text scale 1.3, in every UI locale, with
// the LAN route and a `not_configured` final, and asserts on RENDERED geometry:
//   * the row badge (`polishNoModel`, a `PolishSkippedMark`) lies inside the
//     message card and its paragraph fits the box it was given;
//   * the one-time banner (`polishNoModelHint`) lies inside the screen width
//     and its paragraph neither exceeds a line limit nor is taller than its box.
// NR-130 runs the same geometry for `model_rejected` (`polishModelRejected` +
// `polishModelRejectedHint`), so the refused-model pair is held to the same bar.
// Ahem caveat (D-15): "not clipped under Ahem" implies "not clipped on a real
// device", not the converse. Reverse control: shrink the screen or the box
// (e.g. give the banner `maxLines: 1`) and this file goes red.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/diag/utterance_timing.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart' show ServerChannel;
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/article_rig.dart';

void main() {
  final cases =
      <
        (
          String,
          String,
          String Function(AppStrings),
          String Function(AppStrings),
        )
      >[
        (
          'NR-123',
          'not_configured',
          (s) => s.polishNoModel,
          (s) => s.polishNoModelHint,
        ),
        (
          'NR-130',
          'model_rejected',
          (s) => s.polishModelRejected,
          (s) => s.polishModelRejectedHint,
        ),
      ];
  for (final (card, reason, badgeOf, hintOf) in cases) {
    for (final AppLocale locale in AppLocale.values) {
      testWidgets(
        '$card real chat @360dp, text scale 1.3, ${locale.name}: the $reason '
        'badge and the setup hint are readable',
        (WidgetTester tester) async {
          SharedPreferences.setMockInitialValues(<String, Object>{});
          final SharedPreferences prefs = await SharedPreferences.getInstance();
          final AppSettingsController settings = AppSettingsController(
            prefs: prefs,
          );
          addTearDown(settings.dispose);
          await settings.load();
          settings.setLocale(locale);
          final AppStrings s = AppStrings.of(locale);

          late ArticleRig rig;
          await tester.runAsync(() async {
            rig = ArticleRig();
            rig.session.timings.frameHook = UtteranceTiming.scheduleFrame;
            rig.session.serverChannel.value = ServerChannel.lan;
            await pumpEventQueue();
            expect(await rig.controller.pttDown(), isTrue);
            await rig.controller.pttUp();
            rig.transport
                .pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
                  'text': 'Synthetic recognized sentence',
                  'confidence': .95,
                  'language': 'en',
                  'segment_idx': 0,
                  'is_segment': false,
                  'duration_ms': 500,
                  'polish': 'skipped',
                  'polish_reason': reason,
                });
            await pumpEventQueue();
          });

          tester.view.physicalSize = const Size(360, 2400);
          tester.view.devicePixelRatio = 1.0;
          tester.platformDispatcher.textScaleFactorTestValue = 1.3;
          addTearDown(tester.view.reset);
          addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
          await tester.pumpWidget(
            MaterialApp(
              home: ChatFlowPage(
                controller: rig.controller,
                appSettings: settings,
              ),
            ),
          );
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));

          // Positive controls: every probe found its subject, in THIS language.
          expect(find.byType(ChatMessageTile), findsOneWidget);
          final Finder badge = find.byType(PolishSkippedMark);
          expect(badge, findsOneWidget);
          final Finder badgeText = find.descendant(
            of: badge,
            matching: find.text(badgeOf(s)),
          );
          expect(badgeText, findsOneWidget);
          final Finder hintText = find.text(hintOf(s));
          expect(hintText, findsOneWidget);

          // Badge: inside the message tile, paragraph fits its box.
          final Rect tileRect = tester.getRect(find.byType(ChatMessageTile));
          final Rect badgeRect = tester.getRect(badge);
          expect(
            badgeRect.left >= tileRect.left &&
                badgeRect.right <= tileRect.right,
            isTrue,
            reason:
                '${locale.name}: badge $badgeRect must lie inside tile '
                '$tileRect',
          );
          final RenderParagraph badgePara = tester
              .renderObject<RenderParagraph>(badgeText);
          expect(badgePara.didExceedMaxLines, isFalse);
          expect(badgePara.size.width, lessThanOrEqualTo(badgeRect.width));
          expect(badgePara.size.height, lessThanOrEqualTo(badgeRect.height));

          // Status pill (the delivery word): inside the tile, whole word laid out
          // (wraps rather than overflows; never line-limited or ellipsized).
          final Finder pillText = find.descendant(
            of: find.byType(StatusPill),
            matching: find.byType(Text),
          );
          expect(pillText, findsOneWidget);
          final Rect pillRect = tester.getRect(find.byType(StatusPill));
          expect(
            pillRect.left >= tileRect.left && pillRect.right <= tileRect.right,
            isTrue,
            reason:
                '${locale.name}: status pill $pillRect must lie inside tile '
                '$tileRect',
          );
          final RenderParagraph pillPara = tester.renderObject<RenderParagraph>(
            pillText,
          );
          expect(pillPara.didExceedMaxLines, isFalse);
          expect(pillPara.size.height, lessThanOrEqualTo(pillRect.height));

          // Hint: inside the 360 dp screen, paragraph fits, not line-limited.
          final Rect hintRect = tester.getRect(hintText);
          expect(hintRect.left, greaterThanOrEqualTo(0));
          expect(hintRect.right, lessThanOrEqualTo(360));
          final RenderParagraph hintPara = tester.renderObject<RenderParagraph>(
            hintText,
          );
          expect(hintPara.didExceedMaxLines, isFalse);
          expect(hintPara.size.width, lessThanOrEqualTo(hintRect.width));
          expect(hintPara.size.height, lessThanOrEqualTo(hintRect.height));

          // Any RenderFlex overflow anywhere on the screen fails the test.
          // No locale is exempt: a row that overflows clips real text (D-15).
          // History: in `fr` a message row used to overflow by 27 px here (the
          // meta row); fixed by layout in `chat_message_tile.dart`.
          expect(tester.takeException(), isNull, reason: locale.name);

          await tester.pumpWidget(const SizedBox());
          await tester.runAsync(rig.dispose);
        },
      );
    }
  }
}
