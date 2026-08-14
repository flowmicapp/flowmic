// §4b-8 — the chat-flow row actually shows the duration/word-count chip.
// Positive probe requirement (CLAUDE.md): a negative "it's absent" assertion
// is worthless without a paired positive one proving the render path itself
// is alive, so every "omitted" case here sits beside a case that DOES render.

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

final AppStrings zh = AppStrings.of(AppLocale.zh);
final AppStrings en = AppStrings.of(AppLocale.en);

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

TimelineEntry _entry({
  String source = '你好世界',
  String? output,
  String? processMode,
  int? durationMs,
  String entryType = TimelineEntry.kTranscript,
}) {
  final DateTime now = DateTime.utc(2026, 8, 1, 10, 0);
  return TimelineEntry(
    id: 'loc_mobile_c',
    clientId: 'c',
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: source,
    outputText: output ?? source,
    processMode: processMode,
    processedText: processMode == null ? null : (output ?? source),
    status: EntryStatus.injected,
    durationMs: durationMs,
    entryType: entryType,
    createdAt: now,
    updatedAt: now,
  );
}

void main() {
  group('ChatMessageTile — §4b-8 per-row duration + word count', () {
    testWidgets('a landed row with a real duration shows "Ns · N 字"', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _wrap(
          ChatMessageTile(
            queued: false,
            canResendImage: false,
            strings: zh,
            entry: _entry(source: '你好世界', durationMs: 12000),
          ),
        ),
      );
      // 你好世界 = 4 CJK chars, 12000ms = "12s".
      expect(find.text('12s · 4 字'), findsOneWidget);
    });

    testWidgets('durationMs null omits the duration clause but still shows '
        'the word count — never a fabricated "0s"', (WidgetTester tester) async {
      await tester.pumpWidget(
        _wrap(
          ChatMessageTile(
            queued: false,
            canResendImage: false,
            strings: zh,
            entry: _entry(source: '你好世界', durationMs: null),
          ),
        ),
      );
      expect(find.text('4 字'), findsOneWidget); // positive probe: it renders
      expect(find.textContaining('0s'), findsNothing);
      expect(find.textContaining('s ·'), findsNothing);
    });

    testWidgets('translate row: the chip counts the TRANSLATED text, not 原文', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _wrap(
          ChatMessageTile(
            queued: false,
            canResendImage: false,
            strings: zh,
            entry: _entry(
              source: '这是一段比较长的原始文字内容',
              output: 'Short translation.',
              processMode: 'translate',
              durationMs: 3000,
            ),
          ),
        ),
      );
      // "Short translation." = 2 words, NOT the 14-character 原文 count.
      expect(find.text('3s · 2 字'), findsOneWidget);
    });

    testWidgets('a picture row shows NEITHER duration nor a word count', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _wrap(
          ChatMessageTile(
            queued: false,
            canResendImage: false,
            strings: zh,
            entry: _entry(
              source: '🖼 PNG · 78 KB',
              durationMs: 5000,
              entryType: TimelineEntry.kImage,
            ),
          ),
        ),
      );
      expect(find.textContaining('字'), findsNothing);
      expect(find.textContaining('5s'), findsNothing);
      // Positive control: the same row, NOT an image, at the same durationMs,
      // DOES render — proving the omission above is the image gate and not a
      // dead render path.
      await tester.pumpWidget(
        _wrap(
          ChatMessageTile(
            queued: false,
            canResendImage: false,
            strings: zh,
            entry: _entry(source: '你好', durationMs: 5000),
          ),
        ),
      );
      expect(find.text('5s · 2 字'), findsOneWidget);
    });

    testWidgets('en locale renders the paired English word-count copy', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _wrap(
          ChatMessageTile(
            queued: false,
            canResendImage: false,
            strings: en,
            entry: _entry(source: 'hello world', durationMs: 1000),
          ),
        ),
      );
      expect(find.text('1s · 2 words'), findsOneWidget);
    });
  });

  group('LiveDraftTile — §4b-8 live duration/word count while transcribing', () {
    testWidgets('growing interim text updates the live word count '
        '(elapsed held fixed)', (WidgetTester tester) async {
      await tester.pumpWidget(
        _wrap(
          LiveDraftTile(
            text: '你好',
            mode: FlowMode.realtime,
            strings: zh,
            elapsed: const Duration(seconds: 3),
          ),
        ),
      );
      expect(find.text('3s · 2 字'), findsOneWidget);

      await tester.pumpWidget(
        _wrap(
          LiveDraftTile(
            text: '你好世界朋友',
            mode: FlowMode.realtime,
            strings: zh,
            elapsed: const Duration(seconds: 3),
          ),
        ),
      );
      expect(find.text('3s · 6 字'), findsOneWidget);
      expect(find.text('3s · 2 字'), findsNothing); // stale count does not linger
    });

    // 🔴 THE POINT OF THIS TEST (owner's §4b-8 「动态显示」, verified against the
    // REAL source — see LiveDraftTile's class doc). Positive-probe discipline:
    // assert the value appears, THEN assert it changes — a static single-pump
    // assertion cannot tell a live readout from a frozen placeholder.
    testWidgets('elapsed genuinely renders and updates as the REAL clock '
        'advances (positive probe: appears, then changes)', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _wrap(
          LiveDraftTile(
            text: '',
            mode: FlowMode.realtime,
            strings: zh,
            elapsed: const Duration(seconds: 2),
          ),
        ),
      );
      expect(find.text('2s'), findsOneWidget); // appeared

      await tester.pumpWidget(
        _wrap(
          LiveDraftTile(
            text: '',
            mode: FlowMode.realtime,
            strings: zh,
            elapsed: const Duration(seconds: 9),
          ),
        ),
      );
      expect(find.text('9s'), findsOneWidget); // changed
      expect(find.text('2s'), findsNothing); // stale reading does not linger
    });

    // The instant PTT-down fires, `elapsed` is genuinely `Duration.zero` (the
    // ticker has not fired its first 200ms tick yet) — RecordingPanel already
    // renders this same instant as "00:00" (recording_panel_widget_test.dart).
    // Rendering it here too is the HONEST reading, not the forbidden
    // fabricated-zero shape: that rule is about a committed row's `durationMs`
    // being ABSENT (no fact was ever recorded), not about a live clock that
    // has genuinely counted zero elapsed seconds so far.
    testWidgets('zero elapsed at the very start of recording is a real value, '
        'not hidden', (WidgetTester tester) async {
      await tester.pumpWidget(
        _wrap(
          LiveDraftTile(
            text: '',
            mode: FlowMode.realtime,
            strings: zh,
            elapsed: Duration.zero,
          ),
        ),
      );
      expect(find.text('0.0s'), findsOneWidget);
    });

    testWidgets('empty interim (still "…") shows duration ALONE — no word '
        'count yet', (WidgetTester tester) async {
      await tester.pumpWidget(
        _wrap(
          LiveDraftTile(
            text: '',
            mode: FlowMode.realtime,
            strings: zh,
            elapsed: const Duration(seconds: 5),
          ),
        ),
      );
      expect(find.text('…'), findsOneWidget);
      expect(find.text('5s'), findsOneWidget); // duration alone …
      expect(find.textContaining('字'), findsNothing); // … no word count
      expect(find.textContaining('·'), findsNothing); // … and no separator
    });
  });
}
