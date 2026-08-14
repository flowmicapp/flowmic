// REQ-12-13 — the four remote keys: mint a row + haptics (owner P0 2026-08-12).
// Ruling = docs/decisions/2026-08-12-owner-p0-control-key-history-and-haptics.md
// Contract = docs/rebuild/15 §2.0-e
//
// 🔴 Every group in this file corresponds to "what happens if it is missing",
// not "does the code look right":
//   ① mint a row: after pressing a key, the phone history has nothing at all
//      (owner's original words were exactly this);
//   ② mint only **after it has gone out**: an event that never happened gets
//      a receipt (the other direction of the red line);
//   ③ this row is not an utterance: `!isImage` is an open predicate ⇒
//      catch-up / edit / rerun / word-count **automatically** grow onto it,
//      and catch-up will re-deliver this row;
//   ④ haptics: pressing down produces no reaction in the hand (owner's
//      second original words), and success vs failure must be distinguishable.
//
// Haptic observation is the same as v204_touch_feedback_widget_test.dart:
// mock `HapticFeedback.vibrate` on `SystemChannels.platform` — no plugin;
// what we watch is the **platform call that actually went out**, not a
// boolean we recorded ourselves.

import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/entry_metrics.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/chat_control_tile.dart';
import 'package:flowmic/src/ui/compose_band.dart';
import 'package:flowmic/src/ui/haptics.dart';
import 'package:flowmic/src/ui/ptt_bar.dart' show PttVisual;

TimelineEntry controlEntry({String kind = 'clear'}) => TimelineEntry(
  id: 'loc_dev_k1-1',
  clientId: 'k1-1',
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: null,
  outputText: '',
  status: EntryStatus.noted,
  entryType: TimelineEntry.kControl,
  controlKind: kind,
  createdAt: DateTime.utc(2026, 8, 12, 10),
  updatedAt: DateTime.utc(2026, 8, 12, 10),
);

void main() {
  group('① the row itself: can say which key was pressed, in all four languages', () {
    testWidgets('every key has its own name in all four languages, and it is the same name as on the toolbar', (
      WidgetTester tester,
    ) async {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings(locale);
        for (final String kind in <String>['enter', 'backspace', 'undo', 'clear']) {
          final String label = controlKeyLabel(s, kind);
          // 🔴 Same source as the button label: not "looks like", the same getter.
          final String fromButton = switch (kind) {
            'enter' => s.keyEnter,
            'backspace' => s.keyBackspace,
            'undo' => s.keyUndo,
            _ => s.keyClear,
          };
          expect(label, fromButton, reason: '$locale/$kind');
          expect(label, isNotEmpty);
          expect(s.controlRowLabel(label), contains(label));
        }
      }
    });

    test('an unrecognised kind prints the raw identifier — never invent a sentence for it', () {
      expect(controlKeyLabel(AppStrings(AppLocale.zh), 'quantum_key'), 'quantum_key');
    });

    testWidgets('🔴 the clear-key row speaks about the **PC** end, and says plainly the local draft was not touched', (
      WidgetTester tester,
    ) async {
      // 🔴 T-1 (2026-08-13) changed this from "assert it exists" to "assert
      // what it says", and that change itself is the close-out of a defect
      // this round caught:
      // the note used to say 「**已清空本机输入框**，并请电脑清除焦点窗口」; after
      // owner supplement #3 split the ✕ ↔ local-buffer coupling, **the first
      // half became false that same day**.
      // ⚠️ And this case was **green** at the time — it asserted
      // `findsOneWidget` (is the sentence present), not what the sentence
      // said ⇒ copy that lied to the user could ship with a fully green gate.
      // This is the counter-sample of the 0.2.53 law (the criterion must land
      // on what the user reads).
      // ⚠️ The design-book §4-4 "same-round must-change four places" list
      // **did not include** this one; it is the fifth, and the only one of
      // those four that the user can actually read.
      const AppStrings s = AppStringsZh();
      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: ChatControlTile(entry: controlEntry(), strings: s),
        ),
      );
      expect(find.byKey(const ValueKey<String>('entry.control.clear.loc_dev_k1-1')), findsOneWidget);
      final Finder note =
          find.byKey(const ValueKey<String>('entry.control.clearNote.loc_dev_k1-1'));
      expect(
        note,
        findsOneWidget,
        reason: '✕ is the only one of the four keys that makes people worry about their own draft; the note cannot be missing',
      );
      // ① It speaks about the PC end — this half has always been true.
      expect(tester.widget<Text>(note).data, contains('电脑'));
      // ② 🔴 It must no longer claim it cleared the local input box. Assert
      // on the **rendered string**.
      expect(
        tester.widget<Text>(note).data,
        isNot(contains('已清空本机输入框')),
        reason: '🔴 the note still says 「已清空本机输入框」, but after ✕ the draft is still there as-is — R11',
      );
      // ③ And it answers head-on the question the user is actually asking
      // at this moment.
      expect(tester.widget<Text>(note).data, contains('草稿不受影响'));
    });

    testWidgets('the other three keys have no such note — they only move the PC', (WidgetTester tester) async {
      const AppStrings s = AppStringsZh();
      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: ChatControlTile(entry: controlEntry(kind: 'undo'), strings: s),
        ),
      );
      expect(find.byKey(const ValueKey<String>('entry.control.clearNote.loc_dev_k1-1')), findsNothing);
    });

    testWidgets('🔴 the row says 「已发出」, never 「已投递」', (WidgetTester tester) async {
      // control:key has no receipt frame ⇒ this end cannot prove "the PC
      // received it". 「已投递」 is a segment-① word; its success criterion is
      // getting the PC's receipt (15 册 §2.0.1 first row), and this path
      // has none.
      const AppStrings s = AppStringsZh();
      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: ChatControlTile(entry: controlEntry(), strings: s),
        ),
      );
      expect(find.text(s.controlRowSent), findsOneWidget);
      expect(find.text('已投递'), findsNothing);
    });
  });

  group('② this row is not an utterance', () {
    test('🔴 word count is null, and the criterion is not "its text happens to be empty"', () {
      // Reverse-control shape: write the criterion as "empty string counts
      // as 0"; someday someone stores a face on a key row, the counter
      // quietly starts counting keys, and every case stays green.
      expect(entryWordCount(controlEntry()), isNull);
      final TimelineEntry faked = TimelineEntry(
        id: 'loc_dev_k2',
        clientId: 'k2',
        mode: FlowMode.realtime,
        delivery: Delivery.none,
        sourceText: null,
        outputText: '清除清除',
        status: EntryStatus.noted,
        entryType: TimelineEntry.kControl,
        controlKind: 'clear',
        createdAt: DateTime.utc(2026, 8, 12),
        updatedAt: DateTime.utc(2026, 8, 12),
      );
      expect(entryWordCount(faked), isNull, reason: 'the criterion is "what it is", not "whether it has words"');
    });

    test('🔴 persist and read back is still a key row — the two-branch ternary would rewrite it into a transcript row', () {
      // This is the one that **loses data**: the row is written whole into
      // the sqlite payload and read back; after being rewritten it is
      // written again, so after one restart the loss is permanent, and it
      // then gets resend / edit / catch-up — catch-up will re-deliver this
      // row.
      final TimelineEntry back = TimelineEntry.fromJson(controlEntry().toJson())!;
      expect(back.entryType, TimelineEntry.kControl);
      expect(back.controlKind, 'clear');
      expect(back.isControl, isTrue);
    });

    test('positive control: an ordinary row comes back without a single word changed, and carries no controlKind', () {
      final TimelineEntry t = TimelineEntry(
        id: 'loc_dev_u1',
        clientId: 'u1',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        sourceText: '一句话',
        outputText: '一句话',
        status: EntryStatus.injected,
        createdAt: DateTime.utc(2026, 8, 12),
        updatedAt: DateTime.utc(2026, 8, 12),
      );
      final TimelineEntry back = TimelineEntry.fromJson(t.toJson())!;
      expect(back.entryType, TimelineEntry.kTranscript);
      expect(back.controlKind, isNull);
      expect(back.isControl, isFalse);
    });

    test('🔴 never on the wire: toHistoryItem has neither control nor controlKind', () {
      // The protocol's EntryTypeSchema is deliberately still two values: if
      // a frame can call itself "I am a key row", one phone can send
      // inject:request carrying both the text to type and a claim that it
      // is a key row.
      final Map<String, Object?> wire = controlEntry().toHistoryItem(
        pcDeviceId: 'pc1',
        userId: 'u1',
      );
      expect(wire.containsKey('entry_type'), isFalse);
      expect(wire.containsKey('control_kind'), isFalse);
      expect(wire.values.contains('control'), isFalse);
    });
  });

  group('③ haptics: pressing down must produce a reaction in the hand, and success vs failure must be distinguishable', () {
    late List<MethodCall> calls;

    setUp(() {
      calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (MethodCall call) async {
            if (call.method == 'HapticFeedback.vibrate') calls.add(call);
            return null;
          });
    });

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null);
    });

    List<String> patterns() =>
        calls.map((MethodCall c) => c.arguments as String).toList(growable: false);

    Future<void> pumpBand(
      WidgetTester tester, {
      required bool sends,
      required List<ControlKeyKind> pressed,
    }) async {
      const AppStrings s = AppStringsZh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ComposeBand(
              buffer: '',
              strings: s,
              enabled: true,
              // T-1: the keys must be ON SCREEN for a press to be possible at
              // all — `recording` would take the whole row off the tree and
              // these haptic cases would fail on a missing finder, not on a
              // missing buzz.
              visual: PttVisual.idle,
              onControlKey: (ControlKeyKind k) {
                pressed.add(k);
                return sends;
              },
              // T-2/T-3: the preview strip's tap. These cases press the REMOTE
              // keys only, so nothing here ever calls it — but it is required
              // with no friendly production default (反 façade ②), which is why
              // the stub has to be written out rather than omitted.
              onExpand: () {},
            ),
          ),
        ),
      );
    }

    testWidgets('🔴 it went out: one selectionClick, different from both inject-success and inject-failure buzzes', (
      WidgetTester tester,
    ) async {
      final List<ControlKeyKind> pressed = <ControlKeyKind>[];
      await pumpBand(tester, sends: true, pressed: pressed);
      await tester.tap(find.byKey(const ValueKey<String>('compose.ctrl.clear')));
      await tester.pumpAndSettle();
      expect(pressed, <ControlKeyKind>[ControlKeyKind.clear]);
      expect(patterns(), <String>['HapticFeedbackType.selectionClick']);
    });

    testWidgets('🔴 it did not go out: two light impacts — distinguishable from the one success buzz', (WidgetTester tester) async {
      // "Something happened" that cannot answer "did it succeed" is exactly
      // what the haptics.dart file header forbids.
      // ⚠️ Vibration is never the only feedback: `sendControlKey` raises the
      // compose banner on both refusal arms (that half lives in
      // manual_delivery.dart, guarded by its own cases).
      final List<ControlKeyKind> pressed = <ControlKeyKind>[];
      await pumpBand(tester, sends: false, pressed: pressed);
      await tester.tap(find.byKey(const ValueKey<String>('compose.ctrl.undo')));
      await tester.pumpAndSettle(const Duration(milliseconds: 400));
      expect(pressed, <ControlKeyKind>[ControlKeyKind.undo]);
      expect(patterns(), <String>[
        'HapticFeedbackType.lightImpact',
        'HapticFeedbackType.lightImpact',
      ]);
    });

    testWidgets('all four keys buzz — it is not only the first one that was wired', (WidgetTester tester) async {
      final List<ControlKeyKind> pressed = <ControlKeyKind>[];
      await pumpBand(tester, sends: true, pressed: pressed);
      for (final ControlKeyKind k in kComposeControlKeys) {
        await tester.tap(find.byKey(ValueKey<String>('compose.ctrl.${k.name}')));
        await tester.pumpAndSettle();
      }
      expect(pressed, kComposeControlKeys);
      expect(patterns().length, kComposeControlKeys.length);
    });

    test('success and failure haptics are not the same method — an "unreadable buzz" equals no feedback', () {
      expect(FlowMicHaptics.controlKeySent, isNot(same(FlowMicHaptics.controlKeyRefused)));
      expect(FlowMicHaptics.controlKeySent, isNot(same(FlowMicHaptics.injectSuccess)));
    });
  });
}
