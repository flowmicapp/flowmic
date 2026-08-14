// PTT cancel-armed face — mock motion table:
//   swipe up to cancel: once displacement crosses the threshold the bar turns gray 「松开 取消」
//
// Crossing −60dp must paint the gray `.ptt.gry` face and the new sentence
// BEFORE the utterance is discarded. Sliding back restores the recording
// face. Reverse control: drop the `_cancelArmed` overlay in ptt_bar.dart
// and the gray-face assertion below goes red.

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/hold_to_talk_surface.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

Widget _host({
  required ValueNotifier<PttVisual> visual,
  Future<bool> Function()? onDown,
  Future<void> Function()? onUp,
  Future<void> Function()? onCancel,
}) => MaterialApp(
  home: Scaffold(
    body: Center(
      child: SizedBox(
        width: 300,
        child: ValueListenableBuilder<PttVisual>(
          valueListenable: visual,
          builder: (_, PttVisual v, Widget? child) => PttBar(
            visual: v,
            strings: _zh,
            onDown: onDown ??
                () async {
                  visual.value = PttVisual.recording;
                  return true;
                },
            onUp: onUp ?? () async {},
            onCancel: onCancel ?? () async {},
          ),
        ),
      ),
    ),
  ),
);

Color? _barColor(WidgetTester tester) {
  final Container bar = tester.widget(find.byKey(const ValueKey<String>('ptt.bar')));
  return (bar.decoration! as BoxDecoration).color;
}

void main() {
  testWidgets('swipe past 60dp paints gray 「松开 取消」; release then cancels', (
    WidgetTester tester,
  ) async {
    final ValueNotifier<PttVisual> visual = ValueNotifier<PttVisual>(PttVisual.idle);
    addTearDown(visual.dispose);
    bool cancelled = false;
    bool sent = false;
    await tester.pumpWidget(
      _host(
        visual: visual,
        onUp: () async => sent = true,
        onCancel: () async => cancelled = true,
      ),
    );

    final TestGesture g = await tester.startGesture(
      tester.getCenter(find.byType(PttBar)),
    );
    await tester.pump(HoldToTalkSurface.acceptHold);
    await tester.pump();
    expect(find.text('● ${_zh.pttRecording}'), findsOneWidget);
    expect(_barColor(tester), FlowMicDockColors.recFill);

    await g.moveBy(const Offset(0, -100));
    await tester.pump();
    expect(find.text(_zh.pttCancelArmed), findsOneWidget);
    expect(find.text('● ${_zh.pttRecording}'), findsNothing);
    expect(_barColor(tester), FlowMicDockColors.recordOnly);
    expect(cancelled, isFalse, reason: 'the gray face is armed, not committed');

    await g.up();
    await tester.pump();
    expect(cancelled, isTrue);
    expect(sent, isFalse);
  });

  testWidgets('slide back off the zone restores the recording face; release sends', (
    WidgetTester tester,
  ) async {
    final ValueNotifier<PttVisual> visual = ValueNotifier<PttVisual>(PttVisual.idle);
    addTearDown(visual.dispose);
    bool cancelled = false;
    bool sent = false;
    await tester.pumpWidget(
      _host(
        visual: visual,
        onUp: () async => sent = true,
        onCancel: () async => cancelled = true,
      ),
    );

    final TestGesture g = await tester.startGesture(
      tester.getCenter(find.byType(PttBar)),
    );
    await tester.pump(HoldToTalkSurface.acceptHold);
    await tester.pump();
    await g.moveBy(const Offset(0, -100));
    await tester.pump();
    expect(find.text(_zh.pttCancelArmed), findsOneWidget);

    await g.moveBy(const Offset(0, 100));
    await tester.pump();
    expect(find.text('● ${_zh.pttRecording}'), findsOneWidget);
    expect(find.text(_zh.pttCancelArmed), findsNothing);
    expect(_barColor(tester), FlowMicDockColors.recFill);

    await g.up();
    await tester.pump();
    expect(sent, isTrue);
    expect(cancelled, isFalse);
  });
}
