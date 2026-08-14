// 🔴 Card G-16-a —— `INJECT_PC_OFFLINE` previously had not a single human
// sentence on the phone.
//
// It is **the same family** as `inject_verdict_note_test.dart` (0.2.53,
// `INJECT_SELF_WINDOW_NO_INPUT` clipped to 「INJ…」), but the two legs show
// different symptoms, and the second is worse:
//
//   · **HTTP image leg** (`image_send_http.dart`'s `pcOffline` branch does
//     not pass `wireMode` ⇒ the row lands `failed` ⇒ the ✗ face) — paints
//     the **bare identifier** `· INJECT_PC_OFFLINE`.
//   · **socket leg** (`relay.handler.ts`'s `answerReject` uniformly sends
//     `mode:'cached'` ⇒ the row lands `cached + cachedByVerdict` ⇒
//     [DeliveryFace.undelivered]) — that face 🔴 **says not a single
//     character** (`_faceSpeaksReason` only lets undelivered speak when the
//     human sentence is non-empty) ⇒ the user reads 「待投递」+ a 「重发」
//     button + **zero explanation**.
//     CLAUDE.md R11 requires every status word to answer "by what right do
//     we say this" — **a pure wait that does not even say what it is
//     waiting for** is worse than a bare code (card B4-12 wrote the same
//     argument for the two cloud-image codes).
//
// 🔴 This file follows the law set in `inject_verdict_note_test.dart`'s
// header: **any acceptance of "can the user read this sentence" must land
// the assertion on the rendered result** (`didExceedMaxLines` / intrinsic
// width vs. the actual box), **never on `Text.data`**. The 0.2.53 run of
// 1259 all-green with only three letters on screen was exactly because the
// assertion walked around clipping.
//
// 🔴 **Ruler declaration** (same as the two sister files): `flutter_test`
// uses the Ahem placeholder font, every glyph a full-em square ⇒ a line
// holds about `width/11.5` characters, real fonts are much looser.
// The direction is **conservative**: not clipped under Ahem ⇒ a real
// device will not clip; **the converse does not hold**.
// ⚠️ Therefore **do not** use this file to argue "this sentence just fits
// on a real device".
//
// ⚠️ **This file uses two widths, and their proving power is not the
// same — do not mix them**:
//   · **360dp** (group ② first two cases, Chinese) — the narrowest
//     real-device width on record in the repo (the 0.2.51 two-row header
//     card did its arithmetic at 360dp). These two are **stricter than a
//     real device**; this card's narrow-screen conclusion comes from them
//     alone.
//     ⚠️ The Chinese sentence **fits on one line at 411dp** (measured
//     intrinsic 379.5 vs. box 383.0) ⇒ at 411dp the "positive control" is
//     false and the whole test goes blind to regression. **360 was not
//     picked to make it green, it was picked so it has something to say**
//     — on a real 360dp device this sentence wraps too.
//   · **700dp** (group ② third case, four languages × two faces) —
//     only answers "all four languages render the full sentence"; it is
//     roughly **equivalent** to a real device, not stricter. Reasons and
//     measured numbers sit on that case's own header.
//
// ── Reverse control [measured] (2026-08-09, this machine = dev-pc-a,
// this card's executor ran it twice) ──────
// Method: change the **label** of the `case 'INJECT_PC_OFFLINE':` in
// `chat_strings.dart` to `REVERSE_CONTROL_G16A` (= lift this one entry
// off the table without deleting the four strings), then run this file.
// Result **EXIT=1, +5 -9**. The three reds each said a different thing,
// verbatim:
//
//   ① the mapping is gone:
//        Expected: not null
//          Actual: <null>
//   ② 🔴 **that entire human-sentence row no longer exists** (not "the
//      copy got shorter") — `_reasonNoteFor` returns null when the human
//      sentence is null, so the row is never minted:
//        Expected: exactly one matching candidate
//          Actual: _KeyWidgetFinder:<Found 0 widgets with key
//                  [<'entry.reasonNote.loc_offline'>]: []>
//           Which: means none were found but one was expected
//   ③ 🔴 **the bare identifier is back on screen immediately** — this is
//      the symptom this card is here to fix:
//        Expected: no matching candidates
//          Actual: _TextContainingWidgetFinder:<Found 1 widget with text
//                  containing INJECT_PC_OFFLINE: [
//           Which: means one was found but none were expected
//
// ⚠️ Group ④ (unknown codes) **stayed green throughout**, and that is
// correct: this card opened no fallback table, lifting this one entry
// must not change `PC_UNREACHABLE`'s behaviour. **A reverse control that
// goes red on the whole suite after one change cannot prove where it
// went red.**
// ✅ Restored (label put back to `INJECT_PC_OFFLINE`),
// `REVERSE_CONTROL_G16A` repo-wide grep = 0, this file re-greened 15/15
// (the old header wrote 14, now stale). ⚠️ grepping `test(`/`testWidgets(`
// only counts 14 static call sites — the 15th is the `testWidgets` inside
// the leg loop of the "two faces" group, one run per leg ⇒ executes
// twice. Do not grep this number back to 14: count it by running, not by
// counting source.

import 'package:flowmic/src/session/outbox_item.dart'
    show isTerminalRefusalCode;
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/status_badge.dart'
    show DeliveryFace, deliveryFaceOf;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'support/legibility.dart' show ahemWidthFor;

const AppStrings _zh = AppStringsZh();

const String kPcOffline = 'INJECT_PC_OFFLINE';

/// The four members this table already had — they are **all** terminal,
/// and this card's one is not. That difference is not style; it is the
/// fulfilment mechanism of this card's second human sentence (see the
/// last case of group ①).
const List<String> kTerminalRefusalCodes = <String>[
  'INJECT_FRAME_TOO_LARGE',
  'INJECT_FRAME_INVALID',
  'INJECT_PC_MISMATCH',
  'INJECT_PC_UNSPECIFIED',
];

/// socket leg: relay `answerReject` sends `mode:'cached'` ⇒ row `cached +
/// cachedByVerdict` ⇒ [DeliveryFace.undelivered] (「待投递」).
TimelineEntry _undeliveredEntry({String id = 'loc_offline'}) =>
    _entry(id: id, status: EntryStatus.cached, cachedByVerdict: true);

/// HTTP image leg: `image_send_http.dart`'s `pcOffline` branch **does not
/// pass** `wireMode` (M4-15 ruling: do not invent a `'cached'` there) ⇒
/// row `failed` ⇒ ✗.
TimelineEntry _failedEntry({String id = 'loc_offline'}) =>
    _entry(id: id, status: EntryStatus.failed, cachedByVerdict: false);

TimelineEntry _entry({
  required String id,
  required EntryStatus status,
  required bool cachedByVerdict,
  String failureReason = kPcOffline,
  String text = '这是一句发给一台没连上的电脑的转录',
}) {
  final DateTime now = DateTime.utc(2026, 8, 9, 10, 30);
  return TimelineEntry(
    id: id,
    clientId: 'c',
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: null,
    outputText: text,
    status: status,
    cachedByVerdict: cachedByVerdict,
    origin: 'paired',
    entryType: TimelineEntry.kTranscript,
    failureReason: failureReason,
    // 🔴 Deliberately do not set pcName / injectTarget: this code's premise
    // is **there is no PC in the room**, the frame never reached any
    // machine, and fabricating those two fields would paint a frame nobody
    // received as if it had arrived.
    createdAt: now,
    updatedAt: now,
  );
}

Widget _tile(TimelineEntry e, {AppStrings strings = _zh}) => MaterialApp(
  home: Scaffold(
    body: ChatMessageTile(
      entry: e,
      strings: strings,
      // The queue **really still owes** this row (`isTerminalRefusalCode` is
      // false ⇒ the item returns to `queued`). Ruling ⑩: the row speaks its
      // own verdict, the queue speaks its own in the banner, both sentences
      // are true.
      queued: true,
      canResendImage: true,
      onRetry: (TimelineEntry _) {},
    ),
  ),
);

/// How wide this text wants on one line when **unconstrained**. Compare
/// with the actual box to know whether it was ellipsized.
double _intrinsicWidth(Text t) {
  final TextPainter p = TextPainter(
    text: TextSpan(text: t.data, style: t.style),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  return p.width;
}

/// After render, did this text overflow its own `maxLines` (= the user sees an ellipsis).
bool _clipped(WidgetTester tester, Finder f) {
  final RenderParagraph p = tester.renderObject<RenderParagraph>(f);
  return p.didExceedMaxLines;
}

Finder get _note =>
    find.byKey(const ValueKey<String>('entry.reasonNote.loc_offline'));

void main() {
  // ── ① positive control: one human sentence per language, and it answers the **delivery-leg** question ──
  group('① deliveryRefusalNote(INJECT_PC_OFFLINE) — per-language human sentence', () {
    test('all four languages non-empty, and each differs from the table\'s original four', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final String? note = s.deliveryRefusalNote(kPcOffline);
        expect(note, isNotNull, reason: '$locale');
        expect(note, isNotEmpty, reason: '$locale');
        for (final String other in kTerminalRefusalCodes) {
          expect(
            note,
            isNot(s.deliveryRefusalNote(other)),
            reason: '$locale: said the same sentence as $other',
          );
        }
      }
    });

    test('🔴 the three tables still do not intersect — only the delivery-leg table recognises it', () {
      // Order in `_humanNoteFor` is cloud-image → inject-leg → delivery-leg.
      // Either of the first two recognising it would put a relay-authored
      // code into the stretch the PC answers in its own voice (two-leg
      // terminology iron law).
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        expect(s.injectVerdictNote(kPcOffline), isNull, reason: '$locale');
        expect(
          s.cloudImageRelayErrorNote(kPcOffline),
          isNull,
          reason: '$locale',
        );
      }
    });

    test('🔴 not a single inject-leg word may appear (delivery-leg ≠ inject-leg)', () {
      // `error-codes.ts`'s `INJECT_PC_OFFLINE.zh_CN` is now 「电脑不在线，这一条未送达。」
      // (DOC-HYG `b20092f` replaced the original 「未注入」). This assertion is
      // still on duty; its job became **regression-proofing**: this stretch
      // only answers "was it delivered"; the PC is offline ⇒ it never even
      // tried, so any inject-leg word is answering on behalf of a party that
      // never took part in the verdict (owner 2026-08-02 two-leg terminology
      // iron law / 15 册 §2.0).
      // Nine-language expansion (2026-08-14): four Maps + `[locale]!` ⇒
      // exhaustive switch (the five new languages would otherwise crash on
      // an empty assertion). Each language's inject-leg words are taken from
      // a sentence that language **really uses elsewhere to talk about
      // injection** (`deliveryRefusalNote_INJECT_PC_MISMATCH`: fr「injecté」/
      // es「inyectó」/ de「eingefügt」/ ru「вставлено」/ zh-TW「注入」), so
      // what is banned is the word this language would actually write, not
      // a word a translator would never use.
      List<String> injectWords(AppLocale locale) => switch (locale) {
        AppLocale.zh => <String>['注入'],
        AppLocale.zhTw => <String>['注入'],
        AppLocale.en => <String>['inject'],
        AppLocale.fr => <String>['inject'],
        AppLocale.es => <String>['inyect'],
        AppLocale.de => <String>['eingefügt', 'einfüg', 'injiz'],
        AppLocale.ja => <String>['注入'],
        AppLocale.ko => <String>['주입'],
        AppLocale.ru => <String>['вставл', 'вставк'],
      };
      for (final AppLocale locale in AppLocale.values) {
        final String note = AppStrings.of(
          locale,
        ).deliveryRefusalNote(kPcOffline)!;
        for (final String w in injectWords(locale)) {
          expect(
            note.toLowerCase(),
            isNot(contains(w.toLowerCase())),
            reason: '$locale: a delivery-leg sentence spoke inject-leg words on the PC\'s behalf',
          );
        }
      }
    });

    test('🔴 invent no entry the phone does not have, and write no imperative like 「请等待」', () {
      // First half matches the sister file (these four sentences only state
      // facts, they do not name a surface this App does not have).
      // Second half is ruling ⑩: the action the user should take on this
      // row is **resend** (`retryableFace` contains both `failed` and
      // `undelivered`, the button is on both faces), not "wait". The
      // sentence only states **what the queue will do**, it does not
      // command the user.
      // Nine-language expansion (2026-08-14): four Maps + `[locale]!` ⇒
      // exhaustive switch.
      List<String> forbidden(AppLocale locale) => switch (locale) {
        AppLocale.zh => <String>['设置里', '请等待', '请稍候'],
        AppLocale.zhTw => <String>['設定裡', '設定中', '請等待', '請稍候'],
        AppLocale.en => <String>['in Settings', 'please wait'],
        AppLocale.fr => <String>['dans les réglages', 'veuillez patienter', 'patientez'],
        AppLocale.es => <String>['en ajustes', 'en los ajustes', 'espera un momento'],
        AppLocale.de => <String>['in den einstellungen', 'bitte warten'],
        AppLocale.ja => <String>['設定内', 'お待ちください'],
        AppLocale.ko => <String>['설정에서', '기다려'],
        AppLocale.ru => <String>['в настройках', 'подождите'],
      };
      for (final AppLocale locale in AppLocale.values) {
        final String note = AppStrings.of(
          locale,
        ).deliveryRefusalNote(kPcOffline)!;
        for (final String w in forbidden(locale)) {
          expect(
            note.toLowerCase(),
            isNot(contains(w.toLowerCase())),
            reason: '$locale/$w',
          );
        }
      }
    });

    test('🔴 the sentence 「会再送一次」 has a mechanism that fulfils it — it is this table\'s only non-terminal member', () {
      // CLAUDE.md red-line, original wording: **never name a wait that has
      // no fulfilling mechanism 「待…」**. What is asserted here is not the
      // copy, it is **the mechanism that fulfils it**:
      // `isTerminalRefusalCode` is false ⇒ `outboxSettle` takes the
      // retryable `else` at the end ⇒ the item returns to `queued` ⇒ the
      // next room-join drain will send it again. The moment this becomes
      // true, that sentence becomes a lie, and only this case goes red.
      expect(
        isTerminalRefusalCode(kPcOffline),
        isFalse,
        reason: 'the moment this code becomes terminal, 「会再送一次」 is a promise nobody fulfils',
      );
      // Positive control: the other four on the same table are **all**
      // terminal — without this, the "false" above might just mean the
      // predicate is broken entirely.
      for (final String code in kTerminalRefusalCodes) {
        expect(isTerminalRefusalCode(code), isTrue, reason: code);
      }
    });

    test('🔴 the promised trigger edge must be "this phone reconnects", never written as "wait for the PC to come back"', () {
      // ── This case covers the half the previous one measured wrong (W5F) ──
      //
      // The previous case proved "this item returns to `queued`". What it
      // **did not** prove, and cannot prove, is **"who drains it"** — and
      // the first-draft sentence credited a subscriber that does not exist:
      //
      //   first draft: 「**等电脑重新上线后**会自动再送一次。」
      //
      // The only automatic drain edge is `PttSession.roomJoins`
      // (chat_controller `_onRoomJoined` → `outbox.drain()`); its two
      // writers (ptt_pair.dart `pair()` success / ptt_reconnect_ack.dart
      // `onAccepted`) both say **"this phone joined the room"**. **"The PC
      // came back" triggers nothing**: `PcPresence`'s only consumer
      // `onPcPresenceChangedRouted` `return`s on the first line of the
      // `online` branch.
      //
      // ⇒ On the cloud leg (relay stays up, the phone stays in the room)
      //   that row would sit **indefinitely** at 「待投递 · 会自动再送」.
      //   **This is F-1 replayed verbatim**, and it lives on a card that
      //   cites the F-1 fix as its warrant.
      //
      // 🔴 **Why this assertion can only be written this way**: the thing
      // that should really be asserted — "does PC-online drain" — has no
      // observable product on the phone, **because that edge does not
      // exist**, there is nothing to assert. What can be pinned is **this
      // sentence must not attribute the trigger edge to the PC**, and the
      // moment it is written back, only this case goes red.
      // Nine-language expansion (2026-08-14): four Maps + `[locale]!` ⇒
      // exhaustive switch. The five new languages' "when/once the PC ⋯"
      // family of clause heads (fr「quand le PC」/ es「cuando el PC」/
      // de「wenn der PC」/ ru「когда ПК」) — attributing the trigger edge
      // to the PC starts with these words in those languages, so blocking
      // the clause head is more rewrite-tolerant than blocking a whole
      // sentence.
      List<String> pcTriggerWords(AppLocale locale) => switch (locale) {
        // The 「电脑…上线/回来/恢复」 family — wordings that pin the trigger edge on the PC.
        AppLocale.zh => <String>['电脑重新上线', '电脑回来', '电脑恢复', '电脑上线后'],
        AppLocale.zhTw => <String>['電腦重新上線', '電腦回來', '電腦恢復', '電腦上線後'],
        AppLocale.en => <String>[
          'once the pc is back',
          'when the pc is back',
          'once the pc comes back',
          'pc is back online',
        ],
        AppLocale.fr => <String>['quand le pc', 'lorsque le pc', 'dès que le pc'],
        AppLocale.es => <String>['cuando el pc', 'en cuanto el pc'],
        AppLocale.de => <String>['wenn der pc', 'sobald der pc'],
        AppLocale.ja => <String>['パソコンが再びオンライン', 'パソコンが戻っ'],
        AppLocale.ko => <String>['PC가 다시 온라인', 'PC가 돌아'],
        AppLocale.ru => <String>['когда пк', 'как только пк'],
      };
      for (final AppLocale locale in AppLocale.values) {
        final String note = AppStrings.of(
          locale,
        ).deliveryRefusalNote(kPcOffline)!;
        for (final String w in pcTriggerWords(locale)) {
          expect(
            note.toLowerCase(),
            isNot(contains(w.toLowerCase())),
            reason:
                '$locale: attributed the drain trigger edge to "the PC came back", and nothing subscribes to that (F-1 shape)',
          );
        }
      }
      // Positive control: this sentence **does** name the edge it actually
      // depends on. Without this, the "contains no PC-trigger word" set
      // above would also go green on a sentence that **mentions no trigger
      // at all** — and that would swallow the promise entirely, equally
      // violating "no silent failure".
      // Nine-language expansion (2026-08-14): four Maps + `[locale]!` ⇒
      // exhaustive switch.
      // ⚠️ de and ru use a **stem** ('dieses handy' / 'этого телефон')
      // rather than a whole word: this phrase inflects in those two
      // languages (de genitive 'dieses Handys', ru genitive
      // 'этого телефона'), and substring match does not decline. Cutting
      // to the stem is so a grammatical rewrite does not go red as a
      // false defect — it still pins "what is named is this phone".
      String phoneTriggerWord(AppLocale locale) => switch (locale) {
        AppLocale.zh => '这台手机',
        AppLocale.zhTw => '這臺手機',
        AppLocale.en => 'this phone',
        AppLocale.fr => 'ce téléphone',
        AppLocale.es => 'este teléfono',
        AppLocale.de => 'dieses handy',
        AppLocale.ja => 'この端末',
        AppLocale.ko => '이 휴대폰',
        AppLocale.ru => 'этого телефон',
      };
      for (final AppLocale locale in AppLocale.values) {
        expect(
          AppStrings.of(locale).deliveryRefusalNote(kPcOffline)!.toLowerCase(),
          contains(phoneTriggerWord(locale).toLowerCase()),
          reason: '$locale: the promise did not name the edge it actually depends on (this phone reconnects)',
        );
      }
    });

    test('unknown codes still return null — this card opened no fallback table', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        for (final String code in <String>[
          // Three "not now" codes in the same family as PC_OFFLINE,
          // deliberately **not** written together as a courtesy: the card
          // asked for this one, and inventing sentences for codes that
          // were not asked for is how a façade is built.
          'PC_UNREACHABLE',
          'INJECT_NO_RESULT',
          'INJECT_NOT_IN_ROOM',
          'LINK_DOWN',
          'PC_BUSY',
          '',
        ]) {
          expect(s.deliveryRefusalNote(code), isNull, reason: '$locale/$code');
        }
      }
    });
  });

  // ── ② render measurement: one face per leg, asserting painted glyphs, not Text.data ──
  group('② render measurement — socket leg (「待投递」) and HTTP image leg (✗)', () {
    testWidgets('🔴 socket leg: the 「待投递」 face previously said nothing; now it speaks and is not clipped', (
      WidgetTester tester,
    ) async {
      tester.view.physicalSize = const Size(360 * 3, 780 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      final TimelineEntry e = _undeliveredEntry();
      // Pin first that this row really lands on that face — otherwise the
      // rest measures something else.
      expect(
        deliveryFaceOf(e, queued: true),
        DeliveryFace.undelivered,
        reason: 'relay sent mode:cached ⇒ this row takes the 「待投递」 face',
      );

      await tester.pumpWidget(_tile(e));
      expect(_note, findsOneWidget, reason: '「待投递」 must be able to say what it is waiting for');

      // Positive control: it **really** is too long for one line — otherwise
      // "not clipped" proves nothing.
      final Text w = tester.widget<Text>(_note);
      expect(
        _intrinsicWidth(w),
        greaterThan(tester.getSize(_note).width),
        reason: 'sample too short, this test is blind to regression',
      );

      // 🔴 Assertion lands on the **rendered result** (`didExceedMaxLines`),
      // not `Text.data`.
      expect(_clipped(tester, _note), isFalse, reason: 'this sentence was eaten by an ellipsis');
    });

    testWidgets('🔴 HTTP image leg: the ✗ face no longer paints the bare identifier, the full sentence is not clipped', (
      WidgetTester tester,
    ) async {
      tester.view.physicalSize = const Size(360 * 3, 780 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      final TimelineEntry e = _failedEntry();
      expect(
        deliveryFaceOf(e, queued: true),
        DeliveryFace.failed,
        reason: 'no wireMode ⇒ the row lands failed (ruling ⑩: the row speaks its own verdict)',
      );

      await tester.pumpWidget(_tile(e));
      expect(_note, findsOneWidget, reason: 'the ✗ row must be able to say why');

      final Text w = tester.widget<Text>(_note);
      expect(
        _intrinsicWidth(w),
        greaterThan(tester.getSize(_note).width),
        reason: 'sample too short, this test is blind to regression',
      );
      expect(_clipped(tester, _note), isFalse, reason: 'this sentence was eaten by an ellipsis');
    });

    testWidgets('four languages × two faces: all render the full sentence and none are clipped', (WidgetTester tester) async {
      // ⚠️ **700 rather than the 360 of the two cases above, and wider even
      // than the sister file's 600 — the reason is not this card's human
      // sentence, it is the status pill on the meta row.** measured: at
      // 600dp that `Row` (chat_message_tile.dart's meta row) overflowed
      // **2.3px**, the culprit being `statusFailed`'s English
      // `Not delivered · not successful` — **30 glyphs**, ~330px under
      // full-em squares, about half in a real font. The sister file's 600
      // was enough because the face-pill it measured has only 24 glyphs
      // (`Delivered · not injected`).
      //
      // 🔴 **This case is therefore no longer "conservative", and that
      // must be said**: Ahem@700 gives this human-sentence row ~672px, the
      // English sentence's intrinsic width is 1299.5px ⇒ about 2 lines
      // (`maxLines: 5`); on a real 411dp device with a real font the same
      // sentence needs about 790px / 383px ⇒ also about 2 lines. **The two
      // are roughly equivalent, not "the test is stricter than a real
      // device"** ⇒ this case only answers "all four languages on both
      // faces render the full sentence"; **the strict narrow-screen
      // conclusion lives in the two 360dp cases above** (those two are
      // the Ahem-stricter-than-real-device direction).
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      for (final AppLocale locale in AppLocale.values) {
        // 🔴 Nine-language expansion (2026-08-14): width is now computed
        // from **this language's script** (`ahemWidthAtLeast`, see
        // `support/legibility.dart`). The "English pill needs 264dp under
        // Ahem" in the paragraph above is the same fact
        // `SCRIPT_WIDTH_FACTOR` names — back then only one language needed
        // it, so it was folded into a constant; the moment fr/es/de/ru
        // arrived that constant was immediately too small (measured
        // `AppLocale.fr … 被省略号吃了`).
        // The old number stays as a **floor**: Han / kana / hangul did not
        // get a single pixel narrower.
        // 🔴 The base is this file's own declared **700** (not 411), so
        // scaling also starts from 700. That 700 is already written above
        // as **tuned for English**: Ahem@700 and a real 411dp device with
        // a real font are roughly equivalent for the English sentence.
        // de / ru status pills are longer than English, and the
        // script-computed factor cannot tell en from de (both Latn) ⇒
        // starting from 411 yields 740, measured still
        // `A RenderFlex overflowed by 21 pixels` (the overflow is the
        // meta row, not this sentence).
        // ⚠️ Latin / Cyrillic therefore get 1260, which is wide — **and
        // this case was only ever answering "every language renders the
        // full sentence"**; the narrow-screen conclusion lives in the two
        // 360dp cases above (the header §ruler-declaration froze that
        // split). Widening this case does not give up what it guards.
        tester.view.physicalSize =
            Size(ahemWidthFor(700, locale) * 3, 890 * 3);
        final AppStrings s = AppStrings.of(locale);
        for (final TimelineEntry e in <TimelineEntry>[
          _undeliveredEntry(),
          _failedEntry(),
        ]) {
          await tester.pumpWidget(_tile(e, strings: s));
          expect(_note, findsOneWidget, reason: '$locale/${e.status}');
          expect(
            tester.widget<Text>(_note).data,
            s.deliveryRefusalNote(kPcOffline),
            reason: '$locale/${e.status}',
          );
          expect(
            _clipped(tester, _note),
            isFalse,
            reason: '$locale/${e.status} was eaten by an ellipsis',
          );
        }
      }
    });

    testWidgets('🔴 reverse control: squeeze this sentence into the meta-row leftover and it clips — the measurement itself can go red', (
      WidgetTester tester,
    ) async {
      // This is not measuring product code, it is **proving this test is
      // capable of going red**. The number is the order of magnitude from
      // the 0.2.53 real-device screenshot: a 411dp row, minus badge / time
      // / pill / resend / origin / char-count — six cells — leaves the
      // reason only a few tens of dp, which is exactly the width that
      // once clipped a 27-character code to 「INJ…」.
      tester.view.physicalSize = const Size(411 * 3, 890 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      const double kMetaRowLeftover = 56;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: kMetaRowLeftover,
              child: Text(
                _zh.deliveryRefusalNote(kPcOffline)!,
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
        reason: 'sample too short, this test is blind to regression',
      );
      expect(
        _clipped(tester, squeezed),
        isTrue,
        reason: 'if even this does not go red, the measurement itself is broken',
      );
    });
  });

  // ── ③ the bare identifier no longer appears on screen ─────────────────────
  group('③ bare identifier — must not show its face on either face', () {
    for (final ({String name, TimelineEntry entry}) leg
        in <({String name, TimelineEntry entry})>[
          (name: 'socket leg · 「待投递」', entry: _undeliveredEntry()),
          (name: 'HTTP image leg · ✗', entry: _failedEntry()),
        ]) {
      testWidgets('${leg.name}: the string INJECT_PC_OFFLINE is not on screen', (
        WidgetTester tester,
      ) async {
        tester.view.physicalSize = const Size(411 * 3, 890 * 3);
        tester.view.devicePixelRatio = 3.0;
        addTearDown(tester.view.reset);

        await tester.pumpWidget(_tile(leg.entry));
        // `_reasonLineFor` yields to `_reasonNoteFor` when the human sentence is non-empty ⇒ the meta row no longer paints the code.
        expect(find.textContaining(kPcOffline), findsNothing);
        expect(_note, findsOneWidget);
      });
    }
  });

  // ── ④ scope boundary: this card changed the behaviour of no **unknown code** ──
  group('④ scope boundary — unknown-code behaviour unchanged by a single character', () {
    testWidgets('PC_UNREACHABLE (same-family "not now") still paints the bare identifier on the ✗ face', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _tile(
          _entry(
            id: 'loc_offline',
            status: EntryStatus.failed,
            cachedByVerdict: false,
            failureReason: 'PC_UNREACHABLE',
          ),
        ),
      );
      expect(find.textContaining('PC_UNREACHABLE'), findsOneWidget);
      expect(_note, findsNothing, reason: 'a code with no human sentence must not grow a whole row out of nothing');
    });

    testWidgets('PC_UNREACHABLE on the 「待投递」 face still says not a single character', (
      WidgetTester tester,
    ) async {
      // The B4-12 branch's guard is `human != null` — this card added one
      // human sentence, it must not open the whole face to every code.
      // Strip that guard and this case goes red.
      await tester.pumpWidget(
        _tile(
          _entry(
            id: 'loc_offline',
            status: EntryStatus.cached,
            cachedByVerdict: true,
            failureReason: 'PC_UNREACHABLE',
          ),
        ),
      );
      expect(_note, findsNothing);
      expect(find.textContaining('PC_UNREACHABLE'), findsNothing);
    });
  });
}
