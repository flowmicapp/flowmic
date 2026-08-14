// 🔴 Card G-16-b (follow-up) — `INJECT_SERVER_BUSY` had no sentence on the phone.
//
// ── WHAT MAKES THIS ONE DIFFERENT FROM ITS TWO SISTER FILES ─────────────────
//
// `inject_verdict_note_test.dart` (0.2.53) and `pc_offline_note_test.dart`
// (G-16-a) were both written after a HUMAN saw the defect — one on a real
// device, one while reading the tables. This one was found BY A MACHINE:
// `test/error_code_copy_binding_test.dart` derives 「can this code reach the
// phone's row surface」 from `inject-verdict-authorship.ts` and reported this
// code as reachable-with-no-copy. That is the whole point of that gate, and
// this file is the first time it has been cashed.
//
// ── THE LEG (there is exactly one, and naming it is load-bearing) ───────────
//
// Producer: server-core `inject-routes.ts`, the `attempt.kind === 'overloaded'`
// arm of the HTTP IMAGE ingress — the request_id waiter table is momentarily
// full. It answers HTTP 200 `{ok:false, error:'INJECT_SERVER_BUSY'}`.
// Phone: `image_upload.dart` maps that to `ImageUploadStatus.serverRefused`;
// `image_send_http.dart`'s `serverRefused` arm calls `applyInjectResult`
// WITHOUT a `wireMode` ⇒ the row settles `EntryStatus.failed` ⇒ ✗, a face
// `_faceSpeaksReason` speaks on unconditionally ⇒ before this card the user
// read the bare string 「· INJECT_SERVER_BUSY」.
//
// ⚠️ There is NO socket leg for this code (unlike `INJECT_PC_OFFLINE`, whose
// test needed two). `relay.handler.ts` never emits it — grep it: the only
// producer is the HTTP ingress. So this file asserts ONE face, and says so
// rather than inventing a second entry shape that production cannot produce.
//
// ── 🔴 THE PROMISE DISCIPLINE (the reason this file exists at all) ──────────
//
// R11: every status word must answer 「凭什么这么说」. This copy contains an
// IMPERATIVE (「请稍后重发」), so the affordance it names must exist — and for a
// PICTURE row that takes two independent things, both asserted below (③组):
//   ① the FACE renders the button: `failed` ∈ `retryableFace`;
//   ② the ITEM is still resendable: `canResendImage` needs the queue item
//      pending, and it is — the `serverRefused` arm never calls `settleQueued`.
// And the copy must NOT promise an automatic retry: the 45 s watchdog does
// return the item to `queued`, but a queued item needs a DRAIN, whose edge is
// `PttSession.roomJoins` — an edge that never fires on a connection that never
// drops. 「会自动再送」 would be F-1 verbatim: a wait with no mechanism.
// ①组 pins both halves of that.
//
// 🔴 Same law as both sister files: 「用户能不能读到这句话」 is asserted on the
// RENDERED result (widget-by-key + `didExceedMaxLines`), never on `Text.data`.
// 0.2.53 shipped with 1259 tests green because the assertion bypassed clipping.
//
// 🔴 Ruler declaration: `flutter_test` uses the Ahem placeholder font — every glyph is a
// full em box, so a line holds far fewer characters than a real font. The
// direction is CONSERVATIVE (not clipped under Ahem ⇒ not clipped on a real
// device); the reverse does NOT follow, so this file must never be cited for
// 「it fits on a real device」.
//
// ── REVERSE CONTROL 【measured】 (2026-08-09, dev-pc-a) ──────────────────
// Method: rename the `case 'INJECT_SERVER_BUSY':` label in chat_strings.dart to
// `REVERSE_CONTROL_G16B` (removes the mapping without deleting the four
// sentences), then run this file TOGETHER WITH the binding gate. Result:
// **+8 -10**, and the distinct failures are recorded verbatim at the bottom.
//
// 🔴 THE RESULT WORTH KEEPING: `error_code_copy_binding_test.dart` WENT RED TOO,
// on its own terms — 「every code that can ride inject:result has copy in its
// segment's table…」 plus its coverage invariant (`Expected: <20> Actual: <19>`).
// That is the G-16-b mechanism catching this exact regression class without
// anyone having written a test for this code — which is the entire claim that
// card makes, demonstrated against a real removal rather than argued.
// ✅ Reverted, `REVERSE_CONTROL_G16B` grep = 0 repo-wide, both files green.

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

const String kServerBusy = 'INJECT_SERVER_BUSY';

/// The four members of `deliveryRefusalNote` that ARE terminal. This code is
/// not one of them — and neither is `INJECT_PC_OFFLINE` — which is why the
/// table's doc had to be corrected in G-16-a. Kept here so a future change to
/// `isTerminalRefusalCode` that swept this code in would redden ①组.
const List<String> kTerminalRefusalCodes = <String>[
  'INJECT_FRAME_TOO_LARGE',
  'INJECT_FRAME_INVALID',
  'INJECT_PC_MISMATCH',
  'INJECT_PC_UNSPECIFIED',
];

/// The ONE production shape: HTTP image ingress ⇒ no `wireMode` ⇒ `failed` ⇒ ✗.
TimelineEntry _failedEntry({String id = 'loc_busy'}) => _entry(id: id);

TimelineEntry _entry({
  required String id,
  String failureReason = kServerBusy,
  String text = '这是一张发给中继的图片',
  String entryType = TimelineEntry.kTranscript,
}) {
  final DateTime now = DateTime.utc(2026, 8, 9, 11, 15);
  return TimelineEntry(
    id: id,
    clientId: 'c',
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: null,
    outputText: text,
    // `serverRefused` ⇒ applyInjectResult WITHOUT wireMode ⇒ failed.
    status: EntryStatus.failed,
    cachedByVerdict: false,
    origin: 'paired',
    entryType: entryType,
    failureReason: failureReason,
    // 🔴 Deliberately no pcName / injectTarget: the premise of this code is
    // that the RELAY refused to take the delivery, so no PC ever saw the frame.
    // Inventing those fields would paint a frame nobody received as arrived.
    createdAt: now,
    updatedAt: now,
  );
}

Widget _tile(
  TimelineEntry e, {
  AppStrings strings = _zh,
  double width = 411,
  bool canResendImage = true,
}) => MaterialApp(
  home: MediaQuery(
    data: MediaQueryData(size: Size(width, 900)),
    child: Scaffold(
      body: SizedBox(
        width: width,
        // The queue genuinely still owes this row: the `serverRefused` arm
        // never settles the item, so it stays pending until the watchdog
        // requeues it. 裁定⑩: the row states its own verdict, the queue states
        // its own in the banner — both true at once.
        child: ChatMessageTile(
          entry: e,
          strings: strings,
          queued: true,
          canResendImage: canResendImage,
          onRetry: (TimelineEntry _) {},
        ),
      ),
    ),
  ),
);

/// How wide this text wants to be with no constraint at all.
double _intrinsicWidth(Text t) {
  final TextPainter p = TextPainter(
    text: TextSpan(text: t.data, style: t.style),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  return p.width;
}

/// Did the rendered text overflow its own `maxLines` (i.e. the user sees 「…」).
bool _clipped(WidgetTester tester, Finder f) =>
    tester.renderObject<RenderParagraph>(f).didExceedMaxLines;

void main() {
  // ── ①组 THE COPY EXISTS, IN THE RIGHT TABLE, AND ITS PROMISES ARE BACKED ──
  group('① mapping and the mechanism behind the promise', () {
    test('all four locales get a human sentence (not null, not empty)', () {
      for (final AppLocale loc in AppLocale.values) {
        final String? note = AppStrings(loc).deliveryRefusalNote(kServerBusy);
        expect(note, isNotNull, reason: loc.name);
        expect(note!.trim(), isNotEmpty, reason: loc.name);
      }
      // Positive control: four DIFFERENT sentences, not one repeated four
      // times. Without this, a `_t` that returned `zh` for every locale would
      // pass the loop above.
      final Set<String> all = <String>{
        for (final AppLocale loc in AppLocale.values)
          AppStrings(loc).deliveryRefusalNote(kServerBusy)!,
      };
      expect(all.length, AppLocale.values.length);
    });

    test('🔴 it belongs on the delivery-segment table, must never enter the injection-segment table', () {
      // Delivery ≠ injection (15 册 §2.0). The frame never reached a PC, so an
      // injection-segment sentence would answer for a machine that never judged it.
      // This is also exactly the placement rule the binding gate enforces
      // mechanically (relay ⇒ deliveryRefusalNote) — asserted here too so the
      // reasoning lives next to the copy it constrains.
      expect(_zh.deliveryRefusalNote(kServerBusy), isNotNull);
      expect(_zh.injectVerdictNote(kServerBusy), isNull);
      expect(_zh.cloudImageRelayErrorNote(kServerBusy), isNull);
    });

    test('🔴 not a single injection-segment word appears (four locales)', () {
      // The row's own capsule already says 未投递; this sentence explains WHY
      // the delivery did not happen. 「未注入」/「not injected」 would speak for a
      // PC that never received the frame.
      const List<String> forbidden = <String>[
        '注入',
        'inject',
        '注入されて',
        '주입',
      ];
      for (final AppLocale loc in AppLocale.values) {
        final String note = AppStrings(loc).deliveryRefusalNote(kServerBusy)!;
        for (final String bad in forbidden) {
          expect(
            note.toLowerCase().contains(bad.toLowerCase()),
            isFalse,
            reason: '${loc.name} sentence contains the injection-segment word 「$bad」: $note',
          );
        }
      }
    });

    test('🔴 not terminal ⇒ the queue still owes it (this is exactly why we must not write "failed for good")', () {
      expect(isTerminalRefusalCode(kServerBusy), isFalse);
      // Positive control: the predicate is not simply answering false for
      // everything — the four real terminals still answer true.
      for (final String code in kTerminalRefusalCodes) {
        expect(isTerminalRefusalCode(code), isTrue, reason: code);
      }
    });

    test('🔴 deliberately does not promise 「会自动再送」 — that edge is not guaranteed to arrive on this leg', () {
      // The mechanism that WOULD justify such a promise is the drain, and since
      // 0.2.52 its edge is `PttSession.roomJoins`. On a link that never drops,
      // that edge never fires, so the sentence would be a wait with no
      // mechanism — the F-1 red line verbatim, and the exact mistake the
      // `INJECT_PC_OFFLINE` copy caught in its own first draft.
      //
      // ⚠️ This asserts the COPY, which is all a copy test can honestly
      // assert. It is the mirror of `pc_offline_note_test`'s promise test:
      // there the promise had to BE there (and be pinned to its edge); here it
      // must NOT be.
      const List<String> autoRetryClaims = <String>[
        '自动',
        '会再送',
        'automatically',
        'will be sent again',
        '自動',
        '자동',
      ];
      for (final AppLocale loc in AppLocale.values) {
        final String note = AppStrings(loc).deliveryRefusalNote(kServerBusy)!;
        for (final String claim in autoRetryClaims) {
          expect(
            note.toLowerCase().contains(claim.toLowerCase()),
            isFalse,
            reason:
                '${loc.name} promised an automatic re-delivery that no mechanism guarantees (「$claim」): $note',
          );
        }
      }
      // Reverse control: the neighbour that DOES promise it still does — otherwise
      // this assertion could pass simply because nothing anywhere promises
      // anything, and the G-16-a promise could rot away unnoticed.
      expect(
        _zh.deliveryRefusalNote('INJECT_PC_OFFLINE'),
        contains('会再送'),
      );
    });
  });

  // ── ②组 THE USER CAN ACTUALLY READ IT ───────────────────────────────────
  group('② render result (not Text.data)', () {
    testWidgets('this code lands on ✗, and the ✗ face unconditionally says "why"', (WidgetTester tester) async {
      final TimelineEntry e = _failedEntry();
      expect(deliveryFaceOf(e, queued: true), DeliveryFace.failed);
      await tester.pumpWidget(_tile(e));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('entry.reasonNote.loc_busy')), findsOneWidget);
    });

    testWidgets('🔴 the bare identifier no longer appears on screen', (WidgetTester tester) async {
      // THE symptom this card exists to remove.
      await tester.pumpWidget(_tile(_failedEntry()));
      await tester.pumpAndSettle();
      expect(find.textContaining(kServerBusy), findsNothing);
    });

    testWidgets('360dp narrow screen (Chinese): the whole sentence renders, and is not cut by the ellipsis', (
      WidgetTester tester,
    ) async {
      // 360dp is the narrowest real width on record in this repo (the 0.2.51
      // two-row header card was costed on it). Under Ahem this is STRICTER
      // than a real device.
      //
      // ⚠️ ZH ONLY AT THIS WIDTH, AND THAT IS THE PRECEDENT'S CHOICE, NOT
      // LAZINESS. `pc_offline_note_test` also restricts 360dp to Chinese. A
      // four-locale loop here throws before it can assert anything: under Ahem
      // the tile's META row (badge/time/capsule/resend/source/word-count)
      // overflows a 360 box by ~242px for the wider locales — a property of
      // Ahem's full-em glyphs and that pre-existing Row, NOT of this sentence.
      // Asserting four languages here would be measuring the placeholder font.
      // The four-language claim is made at 700dp below, where it is honest.
      //
      // ⚠️ MEASURED, and worth recording because it is tight: the zh sentence's
      // intrinsic width is 356.5 against a 360 box (2026-08-09, dev-pc-a)
      // — it fits ONE line with ~3.5px to spare, so a one-character edit can
      // flip it to two. Two lines is FINE (the rule is 「must not be clipped」,
      // not 「must be one line」); do not read this test as proof of a
      // single-line fit, and do not tune the copy to preserve one.
      // 🔴 The first draft asserted `intrinsic > 360` here as a positive
      // control and FAILED at 356.5 — which is exactly how this number came to
      // be known. The wrap-is-really-exercised control now lives on the 700dp
      // test, where English genuinely wraps.
      await tester.pumpWidget(_tile(_failedEntry(), width: 360));
      await tester.pumpAndSettle();
      final Finder f = find.byKey(const Key('entry.reasonNote.loc_busy'));
      expect(f, findsOneWidget);
      expect(
        _clipped(tester, f),
        isFalse,
        reason: 'the whole sentence was clipped at 360dp — the shape of the 0.2.53 defect',
      );
    });

    testWidgets('four locales × 700dp: every language renders the whole sentence, and wrapping was actually exercised', (
      WidgetTester tester,
    ) async {
      // 700dp answers only 「all four languages render the whole sentence」; it
      // is roughly EQUIVALENT to a real device rather than stricter, and the
      // meta row fits here, so the four-locale loop is meaningful.
      final Map<String, double> widths = <String, double>{};
      for (final AppLocale loc in AppLocale.values) {
        await tester.pumpWidget(
          _tile(
            _failedEntry(),
            strings: AppStrings(loc),
            // 🔴 Nine-locale expansion (2026-08-14): the base is this case's
            // own declared 700 (the comment above it says "700dp answers only
            // 'all four languages render the whole sentence'; it is roughly
            // equivalent to a real device rather than stricter"), so the
            // scale starts from 700 not 411. Starting from 411 yields 740;
            // measured, the meta row still `A RenderFlex overflowed by 21
            // pixels` — that 700 was **tuned for English** at the time, and
            // de/ru capsules are longer than English, while a letter-count
            // coefficient cannot tell en from de.
            width: ahemWidthFor(700, loc),
          ),
        );
        await tester.pumpAndSettle();
        final Finder f = find.byKey(const Key('entry.reasonNote.loc_busy'));
        expect(f, findsOneWidget, reason: loc.name);
        expect(_clipped(tester, f), isFalse, reason: loc.name);
        widths[loc.name] = _intrinsicWidth(tester.widget<Text>(f));
      }
      // 🔴 POSITIVE CONTROL ON THE MEASUREMENT: at least one locale must want
      // MORE than one line here, or 「not clipped」 would just be saying the
      // strings are short and the test would go blind to the very regression
      // it exists for (0.2.53 shipped because an assertion bypassed layout).
      // English is the long one (~108 chars ⇒ well over 700 under Ahem).
      expect(
        widths.values.where((double w) => w > 700),
        isNotEmpty,
        reason:
            'no locale needs to wrap at 700dp ⇒ this "not clipped" proved nothing. '
            'measured intrinsic widths: $widths',
      );
    });
  });

  // ── ③组 THE IMPERATIVE IS MECHANISM-BACKED (both halves) ────────────────
  group('③ the mechanism that backs the 「请稍后重发」 imperative', () {
    testWidgets('① the face half: ✗ is a retryable face ⇒ the button is actually drawn', (
      WidgetTester tester,
    ) async {
      // `retryableFace` is a LOCAL bool inside `chat_message_tile.dart`'s
      // build (it includes `failed`), not an exported predicate — so the only
      // honest way to assert it is to render the row and look for the button.
      // That is also the stronger assertion: it is what the user gets.
      await tester.pumpWidget(_tile(_failedEntry()));
      await tester.pumpAndSettle();
      expect(find.text(_zh.resendAction), findsOneWidget);
    });

    testWidgets('② the item half: the button disappears when the item is no longer pending (⇒ this imperative depends on it)', (
      WidgetTester tester,
    ) async {
      // For a PICTURE row the button additionally needs `canResendImage`,
      // which the host computes from `OutboxPendingView.resendableImageEntryIds`
      // ⇒ `OutboxItem.isPending` ⇒ `!isTerminal`. On this leg the item IS
      // pending, for a precise and greppable reason: `image_send_http.dart`'s
      // `serverRefused` arm is the ONLY refusal arm there that never calls
      // `settleQueued`, so nothing settles it terminal.
      //
      // This test pins the DEPENDENCY rather than restating the claim: flip
      // that input and the affordance the sentence names disappears. Without
      // it, 「请稍后重发」 would be an imperative whose backing nothing checks.
      await tester.pumpWidget(
        _tile(
          _entry(
            id: 'loc_busy',
            text: '🖼 PNG · 214 KB',
            entryType: TimelineEntry.kImage,
          ),
          canResendImage: false,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text(_zh.resendAction), findsNothing);
    });
  });

  // ── ④组 BOUNDARY: nothing else changed ──────────────────────────────────
  group('④ boundary: an unrecognised code still has not a word invented for it', () {
    test('unknown codes still return null (none of the three tables may fall back)', () {
      for (final String code in <String>[
        'PC_UNREACHABLE',
        'LINK_DOWN',
        'INJECT_SOMETHING_NEW',
        '',
      ]) {
        expect(_zh.deliveryRefusalNote(code), isNull, reason: code);
        expect(_zh.injectVerdictNote(code), isNull, reason: code);
        expect(_zh.cloudImageRelayErrorNote(code), isNull, reason: code);
      }
    });

    testWidgets('unrecognised code: the ✗ face still prints the bare identifier (this card opened no fallback)', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _tile(_entry(id: 'loc_busy', failureReason: 'PC_UNREACHABLE')),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('PC_UNREACHABLE'), findsOneWidget);
    });
  });
}

// ── REVERSE CONTROL 【measured】 — verbatim output ──────────────────────────────
//
// With `case 'INJECT_SERVER_BUSY':` renamed to `REVERSE_CONTROL_G16B`:
//
//   ① the mapping is gone (①组):
//        Expected: not null
//          Actual: <null>
//   ② 🔴 the whole human-readable LINE stops existing (②组) — `_reasonNoteFor`
//      returns null when there is no copy, so the row is never minted:
//        Expected: exactly one matching candidate
//          Actual: _KeyWidgetFinder:<Found 0 widgets with key
//                  [<'entry.reasonNote.loc_busy'>]: []>
//   ③ 🔴 the bare identifier returns to the screen — the symptom itself (②组):
//        Expected: no matching candidates
//          Actual: _TextContainingWidgetFinder:<Found 1 widget with text
//                  containing INJECT_SERVER_BUSY: [...]>
//
//   ④ 🔴 and the BINDING GATE reddened independently:
//        Expected: empty
//          Actual: ['INJECT_SERVER_BUSY (author: relay) — NO user-facing copy
//                   anywhere…']
//        Expected: <20>            (its reachable-with-copy accounting)
//          Actual: <19>
//
// ⚠️ ③组 and ④组 stayed GREEN throughout, and both are correct:
//   · ③组 asserts the resend affordance, which does not depend on this sentence;
//   · ④组 asserts unrecognised codes still get nothing invented for them —
//     this card opened no fallback table, so removing one mapping must not
//     change that.
// **A reverse control that reddens everything proves nothing about where it
// reddened** — the two groups that stayed green are what make the ten that
// went red mean something specific.
