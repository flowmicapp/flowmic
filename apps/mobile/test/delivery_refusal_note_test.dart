// 🔴 Card U5 [measured] — terminal states on the delivery leg that the relay
// itself refused. Before this card, all four codes landed as a bare identifier.
//
// Of the 61 protocol error codes, ~53 have only one fate on the phone:
// `_reasonLineFor` truncates the identifier to 28 characters and stuffs it into
// the meta row. `INJECT_FRAME_TOO_LARGE` / `INJECT_FRAME_INVALID` /
// `INJECT_PC_MISMATCH` / `INJECT_PC_UNSPECIFIED` are the four that stand out:
// they all land on ⛔ `DeliveryFace.refused` (`isTerminalRefusalCode`,
// outbox_item.dart) — i.e. the face CLAUDE.md R11 already required the
// 「凭什么」 to be readable on — and before this card, neither
// `injectVerdictNote` nor `cloudImageRelayErrorNote` recognised them,
// `_humanNoteFor` answered null on both tables, and the behaviour was the bare
// code: `⛔ 未投递 · 投递被拒 · INJECT_PC_MISMATCH`.
//
// relay.handler.ts `answerReject` emits `mode:'cached'` for all four codes
// (lines 128-136); `applyInjectResult` therefore settles the row as
// `EntryStatus.cached`. That differs from `injectVerdictNote`'s six codes, of
// which exactly half are not cached (server maps them to `failed`) — these four
// have only ever had one status, because the relay refused them in place and
// they were never handed to the PC to judge.
//
// 🔴 Same law as the header of `inject_verdict_note_test.dart`: acceptance of
// 「can the user actually read this sentence」 must land on the rendered result
// (`didExceedMaxLines` / intrinsic width vs. the actual box), never on
// `Text.data` — group ② of this file reuses the same method.

import 'package:flowmic/src/session/outbox_item.dart'
    show isTerminalRefusalCode, kOutboxImageBytesGone, kOutboxOverflow;
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

const AppStrings _zh = AppStringsZh();

/// The four terminal refusal codes on the delivery leg, one by one.
const List<String> kRefusalCodes = <String>[
  'INJECT_FRAME_TOO_LARGE',
  'INJECT_FRAME_INVALID',
  'INJECT_PC_MISMATCH',
  'INJECT_PC_UNSPECIFIED',
];

TimelineEntry _entry({
  required String failureReason,
  String id = 'loc_refusal',
  String text = '这是一句会被 relay 就地拒收的内容',
}) {
  final DateTime now = DateTime.utc(2026, 8, 4, 12, 0);
  return TimelineEntry(
    id: id,
    clientId: 'c',
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: null,
    outputText: text,
    // relay.handler.ts `answerReject` always emits mode:'cached' ⇒ the row
    // lands cached; `cachedByVerdict: true` is the same reason `_isRefused`
    // judges before that guard (status_badge.dart lines 158-171) — the real
    // production shape, not a branch invented for the test's convenience.
    status: EntryStatus.cached,
    cachedByVerdict: true,
    origin: 'paired',
    entryType: TimelineEntry.kTranscript,
    failureReason: failureReason,
    // 🔴 Deliberately no pcName / injectTarget: all four codes were refused by
    // the relay before the PC ever received the frame. 「which machine / which
    // window it actually landed on」 never happened; fabricating those two
    // fields would paint a frame that never reached the PC as if it had.
    createdAt: now,
    updatedAt: now,
  );
}

Widget _tile(TimelineEntry e, {AppStrings strings = _zh}) => MaterialApp(
  home: Scaffold(
    body: ChatMessageTile(
      entry: e,
      strings: strings,
      queued: false,
      canResendImage: true,
      onRetry: (TimelineEntry _) {},
    ),
  ),
);

double _intrinsicWidth(Text t) {
  final TextPainter p = TextPainter(
    text: TextSpan(text: t.data, style: t.style),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  return p.width;
}

bool _clipped(WidgetTester tester, Finder f) {
  final RenderParagraph p = tester.renderObject<RenderParagraph>(f);
  return p.didExceedMaxLines;
}

void main() {
  // ── ① Pure mapping: each of the four codes has one human sentence per locale; unknown codes must not invent one ──
  group('① deliveryRefusalNote — per-code human sentences', () {
    test('the four delivery-leg refusal codes are non-empty and pairwise distinct in every locale', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final Set<String> seen = <String>{};
        for (final String code in kRefusalCodes) {
          final String? note = s.deliveryRefusalNote(code);
          expect(note, isNotNull, reason: '$locale/$code');
          expect(note, isNotEmpty, reason: '$locale/$code');
          expect(seen.add(note!), isTrue, reason: '$locale/$code said the same sentence as an earlier code');
        }
      }
    });

    test('all four codes really are isTerminalRefusalCode (the only reason they land on ⛔)', () {
      for (final String code in kRefusalCodes) {
        expect(isTerminalRefusalCode(code), isTrue, reason: code);
      }
    });

    test('🔴 MISMATCH states the fact only; it must not imply retry helps (protocol-side original: no imperative)', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final String note = s.deliveryRefusalNote('INJECT_PC_MISMATCH')!;
        // Nine-locale expansion (2026-08-14): used to be a four-entry Map +
        // `[locale]!`; after five new locales that `!` is a null-assert crash
        // on every one of them. Switched to an exhaustive switch: adding a
        // language fails to compile, whereas a Map only blows up at runtime
        // (or someone "helpfully" writes `?? const []` and silently skips the
        // check).
        // ⚠️ Each locale's words are read out of **that locale's own
        // UNSPECIFIED sentence** (the only sentence in the product that is
        // supposed to say 「try again」) — they are not looked up in a
        // dictionary. Banning a word a translator would never write is an
        // assertion that is always true.
        final List<String> retryWords = switch (locale) {
          AppLocale.zh => <String>['重试', '重发'],
          AppLocale.zhTw => <String>['重試', '重送', '再試'],
          AppLocale.en => <String>['retry', 'try again'],
          AppLocale.fr => <String>['réessay', 'renvoy'],
          AppLocale.es => <String>['inténtalo', 'reinténta', 'reenví'],
          AppLocale.de => <String>['erneut versuchen', 'erneut senden'],
          AppLocale.ja => <String>['再試行', '再送'],
          AppLocale.ko => <String>['다시 시도', '재전송'],
          AppLocale.ru => <String>['обнови', 'повтор', 'снова'],
        };
        for (final String w in retryWords) {
          expect(note, isNot(contains(w)), reason: '$locale implied retry helps for a frame that cannot reach this PC');
        }
      }
    });

    test('UNSPECIFIED keeps the only real action the protocol side names: update the phone app', () {
      // Nine-locale expansion (2026-08-14): four-entry Map + `[locale]!` ⇒
      // exhaustive switch (same as above). Each locale's word is read from its
      // own sentence: fr「Mettez FlowMic à jour」/ es「Actualiza」/
      // de「aktualisieren」/ ru「Обновите」/ zh-TW「更新到最新版本」.
      String updateWord(AppLocale locale) => switch (locale) {
        AppLocale.zh => '更新',
        AppLocale.zhTw => '更新',
        AppLocale.en => 'update',
        AppLocale.fr => 'à jour',
        AppLocale.es => 'actualiza',
        AppLocale.de => 'aktualisieren',
        AppLocale.ja => '更新',
        AppLocale.ko => '업데이트',
        AppLocale.ru => 'обнови',
      };
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final String note = s.deliveryRefusalNote('INJECT_PC_UNSPECIFIED')!;
        expect(
          note.toLowerCase(),
          contains(updateWord(locale).toLowerCase()),
          reason: '$locale',
        );
      }
    });

    test('🔴 not one character may name an entry the phone does not have (do not invent a button/page)', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        for (final String code in kRefusalCodes) {
          final String note = s.deliveryRefusalNote(code)!;
          for (final String wrongUi in <String>['设置里', 'in Settings', '設定内', '설정에서']) {
            expect(note, isNot(contains(wrongUi)), reason: '$locale/$code');
          }
        }
      }
    });

    test('🔴 unknown codes return null — do not invent a sentence (including the deliberate exclusion of the queue\'s local terminals)', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        for (final String code in <String>[
          'LINK_DOWN',
          'PC_BUSY',
          'INJECT_FOCUS_LOST', // injection leg, goes through injectVerdictNote, not here
          'INJECT_CLOUD_IMAGE_TOO_LARGE', // cloud-image leg, goes through cloudImageRelayErrorNote
          'INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED',
          // The queue's own two local terminals: already covered by
          // outboxTerminalMessage, and they take a completely independent
          // presentation path in banner_queue.dart — answering them here too
          // would be two places each judging 「what is this」 on their own
          // (see the 「does not cover」 paragraph in the deliveryRefusalNote
          // docs).
          kOutboxImageBytesGone,
          kOutboxOverflow,
          '',
        ]) {
          expect(s.deliveryRefusalNote(code), isNull, reason: '$locale/$code');
        }
      }
    });
  });

  // ── ② Wired into chat_message_tile — the ⛔ face no longer prints a bare code ──
  group('② wiring: the ⛔ 未投递·投递被拒 face renders a human sentence, not a bare identifier', () {
    for (final String code in kRefusalCodes) {
      testWidgets('$code ⇒ a full human line, not eaten by the ellipsis, and containing no bare code', (WidgetTester tester) async {
        // Phone width, same order of magnitude as inject_verdict_note_test.dart.
        tester.view.physicalSize = const Size(411 * 3, 890 * 3);
        tester.view.devicePixelRatio = 3.0;
        addTearDown(tester.view.reset);

        await tester.pumpWidget(_tile(_entry(failureReason: code)));

        expect(find.textContaining(_zh.statusRefused), findsOneWidget, reason: code);

        final Finder note = find.byKey(
          const ValueKey<String>('entry.reasonNote.loc_refusal'),
        );
        expect(note, findsOneWidget, reason: '$code this row must be able to say why');

        final Text w = tester.widget<Text>(note);
        expect(w.data, _zh.deliveryRefusalNote(code));
        expect(_clipped(tester, note), isFalse, reason: '$code this sentence was eaten by the ellipsis');

        // The user reads the full sentence; the meta row also no longer prints
        // the bare code (`_reasonLineFor` yields to `_reasonNoteFor` when the
        // human sentence is non-empty).
        expect(find.textContaining(code), findsNothing, reason: code);
      });
    }

    testWidgets('six locales × eight codes: each renders the full sentence and none is clipped (same width order as inject_verdict_note_test)',
        (WidgetTester tester) async {
      tester.view.physicalSize = const Size(600 * 3, 890 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        for (final String code in kRefusalCodes) {
          await tester.pumpWidget(_tile(_entry(failureReason: code), strings: s));
          final Finder note = find.byKey(
            const ValueKey<String>('entry.reasonNote.loc_refusal'),
          );
          expect(note, findsOneWidget, reason: '$locale/$code');
          expect(_clipped(tester, note), isFalse, reason: '$locale/$code was eaten by the ellipsis');
          expect(find.textContaining(code), findsNothing, reason: '$locale/$code');
        }
      }
    });

    testWidgets('🔴 reverse control: stuffing this sentence back into the 56dp meta-row leftover clips it — the measurement itself can go red',
        (WidgetTester tester) async {
      tester.view.physicalSize = const Size(411 * 3, 890 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      const double kMetaRowLeftover = 56;
      final String longest = kRefusalCodes
          .map((String c) => _zh.deliveryRefusalNote(c)!)
          .reduce((String a, String b) => a.length >= b.length ? a : b);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: kMetaRowLeftover,
              child: Text(
                longest,
                key: const ValueKey<String>('squeezed'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
        ),
      );
      final Finder squeezed = find.byKey(const ValueKey<String>('squeezed'));
      expect(
        _intrinsicWidth(tester.widget<Text>(squeezed)),
        greaterThan(kMetaRowLeftover),
        reason: 'sample too short — this test is blind to the regression',
      );
      expect(_clipped(tester, squeezed), isTrue, reason: 'if even this does not go red, the measurement itself is broken');
    });
  });

  // ── ③ Unknown codes / the queue's local terminals — existing behaviour must not be changed by this card ──
  group('③ scope boundary — this card did not open the whole bare-code fallback table', () {
    testWidgets('failed + LINK_DOWN still prints the bare identifier', (WidgetTester tester) async {
      final DateTime now = DateTime.utc(2026, 8, 4, 12, 0);
      final TimelineEntry e = TimelineEntry(
        id: 'loc_unrelated',
        clientId: 'c',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        sourceText: null,
        outputText: '未受影响的一行',
        status: EntryStatus.failed,
        origin: 'paired',
        entryType: TimelineEntry.kTranscript,
        failureReason: 'LINK_DOWN',
        createdAt: now,
        updatedAt: now,
      );
      await tester.pumpWidget(_tile(e));
      expect(find.textContaining('LINK_DOWN'), findsOneWidget);
      expect(
        find.byKey(const ValueKey<String>('entry.reasonNote.loc_unrelated')),
        findsNothing,
        reason: 'a code with no human sentence must not grow a whole extra line out of nowhere',
      );
    });

    testWidgets('queue-local terminal OUTBOX_OVERFLOW: this in-row note is still the bare code — its human sentence lives elsewhere',
        (WidgetTester tester) async {
      await tester.pumpWidget(_tile(_entry(failureReason: kOutboxOverflow)));
      expect(find.textContaining(kOutboxOverflow), findsOneWidget);
      expect(
        find.byKey(const ValueKey<String>('entry.reasonNote.loc_refusal')),
        findsNothing,
        reason: 'OUTBOX_OVERFLOW\'s human sentence is outboxTerminalMessage/banner_queue, not this in-row note',
      );
    });
  });
}
