import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/diag/utterance_timing.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart' show ServerChannel;
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/article_rig.dart';

void main() {
  const cases = <(String?, String?)>[
    ('guard_reject', 'polishNotApplied'),
    ('timeout', 'polishTimedOut'),
    ('llm_error', 'polishUnavailable'),
    // NR-123: nothing configured is its own badge, not 「unavailable」.
    ('not_configured', 'polishNoModel'),
    // NR-130: a model the provider refused is its own badge too.
    ('model_rejected', 'polishModelRejected'),
    ('empty_output', 'polishNotApplied'),
    (null, 'polishSkipped'),
    ('future_reason', 'polishSkipped'),
    ('empty_output', null),
  ];
  for (final (reason, key) in cases) {
    testWidgets('real chat: $reason -> ${key ?? 'empty tail, no badge'}', (
      tester,
    ) async {
      late ArticleRig rig;
      final bool emptyTail = key == null;
      await tester.runAsync(() async {
        rig = ArticleRig();
        rig.session.timings.frameHook = UtteranceTiming.scheduleFrame;
        await pumpEventQueue();
        // Translate accumulates earlier segments until the terminal final,
        // so the empty-tail case still has a real, visible row to inspect.
        if (emptyTail) rig.controller.setMode(FlowMode.translate);
        expect(await rig.controller.pttDown(), isTrue);
        if (emptyTail) {
          await rig.say('Earlier synthetic sentence', 0, isSegment: true);
        }
        await rig.controller.pttUp();
        rig.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
          'text': emptyTail ? '  ' : 'Synthetic recognized sentence',
          'confidence': .95,
          'language': 'en',
          'segment_idx': emptyTail ? 1 : 0,
          'is_segment': false,
          'duration_ms': 500,
          'polish': 'skipped',
          'polish_reason': reason,
        });
        await pumpEventQueue();
        if (emptyTail) {
          rig.transport
              .pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
                'request_id': rig.store.entries.single.clientId,
                'output_text': 'Synthetic translated sentence',
              });
          await pumpEventQueue();
        }
      });
      await mountLightRecordScreen(tester, rig);
      // The row count proves the lazy list actually built the subject.
      expect(find.byType(ChatMessageTile), findsOneWidget);
      final tile = tester.widget<ChatMessageTile>(find.byType(ChatMessageTile));
      final strings = AppStrings.of(AppLocale.zh);
      final expectedLabel = switch (key) {
        'polishNotApplied' => strings.polishNotApplied,
        'polishTimedOut' => strings.polishTimedOut,
        'polishUnavailable' => strings.polishUnavailable,
        'polishNoModel' => strings.polishNoModel,
        'polishModelRejected' => strings.polishModelRejected,
        'polishSkipped' => strings.polishSkipped,
        null => null,
        _ => throw StateError('unexpected badge key: $key'),
      };
      expect(tile.polishSkippedLabel, expectedLabel);
      if (expectedLabel == null) {
        for (final label in <String>[
          strings.polishNotApplied,
          strings.polishTimedOut,
          strings.polishUnavailable,
          strings.polishNoModel,
          strings.polishModelRejected,
          strings.polishSkipped,
        ]) {
          expect(find.text(label), findsNothing);
        }
      } else {
        expect(find.text(expectedLabel), findsOneWidget);
      }
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(rig.dispose);
    });
  }

  // ── NR-123: the one-time 「set a model up on the computer」 hint ──────────────
  // Mounted on the REAL chat screen (anti-façade ⑥): the hint lives in the
  // page's one banner slot, so a controller-only assertion would prove half.
  Future<void> speakOnce(ArticleRig rig, String? reason) async {
    expect(await rig.controller.pttDown(), isTrue);
    await rig.controller.pttUp();
    rig.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': 'Synthetic recognized sentence',
      'confidence': .95,
      'language': 'en',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 500,
      'polish': reason == null ? 'applied' : 'skipped',
      'polish_reason': ?reason,
    });
    await pumpEventQueue();
  }

  for (final ServerChannel? route in <ServerChannel?>[
    ServerChannel.lan,
    ServerChannel.cloudRelay,
  ]) {
    testWidgets('NR-123 real chat, route=${route?.name}: not_configured rows '
        'show the short badge, the hint only on LAN and only once', (
      tester,
    ) async {
      late ArticleRig rig;
      final strings = AppStrings.of(AppLocale.zh);
      await tester.runAsync(() async {
        rig = ArticleRig();
        rig.session.timings.frameHook = UtteranceTiming.scheduleFrame;
        rig.session.serverChannel.value = route;
        await pumpEventQueue();
        await speakOnce(rig, 'not_configured');
        await speakOnce(rig, 'not_configured');
      });
      await mountLightRecordScreen(tester, rig);
      // Positive control for the badge: two rows, both carry 「no model」, and
      // neither says 「unavailable」 (the one-value-one-question half).
      expect(find.byType(ChatMessageTile), findsNWidgets(2));
      expect(find.text(strings.polishNoModel), findsNWidgets(2));
      expect(find.text(strings.polishUnavailable), findsNothing);
      final bool lan = route == ServerChannel.lan;
      // Two not_configured rows, ONE hint (LAN) or none (cloud relay).
      expect(find.text(strings.polishNoModelHint), lan ? findsOneWidget : findsNothing);
      expect(rig.controller.polishNoModelHint, lan);
      if (lan) {
        // Put away, then a third row on the same PC: it does not come back.
        rig.controller.dismissPolishNoModelHint();
        await tester.runAsync(() => speakOnce(rig, 'not_configured'));
        await tester.pump();
        expect(rig.controller.polishNoModelHint, isFalse);
        expect(find.text(strings.polishNoModelHint), findsNothing);
      }
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(rig.dispose);
    });
  }

  // ── NR-130: the same one-time hint mechanism for a REFUSED model ────────────
  for (final ServerChannel? route in <ServerChannel?>[
    ServerChannel.lan,
    ServerChannel.cloudRelay,
  ]) {
    testWidgets('NR-130 real chat, route=${route?.name}: model_rejected rows '
        'show the short badge, the hint only on LAN and only once', (
      tester,
    ) async {
      late ArticleRig rig;
      final strings = AppStrings.of(AppLocale.zh);
      await tester.runAsync(() async {
        rig = ArticleRig();
        rig.session.timings.frameHook = UtteranceTiming.scheduleFrame;
        rig.session.serverChannel.value = route;
        await pumpEventQueue();
        await speakOnce(rig, 'model_rejected');
        await speakOnce(rig, 'model_rejected');
      });
      await mountLightRecordScreen(tester, rig);
      expect(find.byType(ChatMessageTile), findsNWidgets(2));
      expect(find.text(strings.polishModelRejected), findsNWidgets(2));
      // One value, one question: neither "unavailable" nor "no model".
      expect(find.text(strings.polishUnavailable), findsNothing);
      expect(find.text(strings.polishNoModel), findsNothing);
      final bool lan = route == ServerChannel.lan;
      expect(find.text(strings.polishModelRejectedHint), lan ? findsOneWidget : findsNothing);
      expect(rig.controller.polishModelRejectedHint, lan);
      // The no-model hint is a different fact and stays down.
      expect(rig.controller.polishNoModelHint, isFalse);
      expect(find.text(strings.polishNoModelHint), findsNothing);
      if (lan) {
        rig.controller.dismissPolishModelRejectedHint();
        await tester.runAsync(() => speakOnce(rig, 'model_rejected'));
        await tester.pump();
        expect(rig.controller.polishModelRejectedHint, isFalse);
        expect(find.text(strings.polishModelRejectedHint), findsNothing);
      }
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(rig.dispose);
    });
  }

  testWidgets('NR-130: a later applied final clears the refused-model hint', (
    tester,
  ) async {
    late ArticleRig rig;
    final strings = AppStrings.of(AppLocale.zh);
    await tester.runAsync(() async {
      rig = ArticleRig();
      rig.session.timings.frameHook = UtteranceTiming.scheduleFrame;
      rig.session.serverChannel.value = ServerChannel.lan;
      await pumpEventQueue();
      await speakOnce(rig, 'model_rejected');
    });
    await mountLightRecordScreen(tester, rig);
    expect(find.text(strings.polishModelRejectedHint), findsOneWidget);
    await tester.runAsync(() => speakOnce(rig, null));
    await tester.pump();
    expect(find.text(strings.polishModelRejectedHint), findsNothing);
    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(rig.dispose);
  });

  testWidgets('NR-123: a later applied final clears a hint still on screen', (
    tester,
  ) async {
    late ArticleRig rig;
    final strings = AppStrings.of(AppLocale.zh);
    await tester.runAsync(() async {
      rig = ArticleRig();
      rig.session.timings.frameHook = UtteranceTiming.scheduleFrame;
      rig.session.serverChannel.value = ServerChannel.lan;
      await pumpEventQueue();
      await speakOnce(rig, 'not_configured');
    });
    await mountLightRecordScreen(tester, rig);
    expect(find.text(strings.polishNoModelHint), findsOneWidget);
    await tester.runAsync(() => speakOnce(rig, null));
    await tester.pump();
    expect(find.text(strings.polishNoModelHint), findsNothing);
    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(rig.dispose);
  });
}
