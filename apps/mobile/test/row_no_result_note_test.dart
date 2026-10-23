// NR-279 (A2) — a row the 20 s watchdog turned ✗ with `INJECT_NO_RESULT` says
// WHY in words, instead of printing the bare identifier.
//
// Root cause: .local/device-evidence/0315-upgrade/rca-anomalies.md §2.3 — none
// of the four note tables knows the phone's own `INJECT_NO_RESULT`, so the row
// rendered 「✗ Not delivered · not successful · INJECT_NO_RESULT」, while doc 15
// (`15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md`, row-level watchdog line)
// specifies 「✗ +「电脑没有回应」」.
//
// The sentence is REUSED, not new: the blocking banner's own text for the same
// event (`composeSendError(ComposeSendFailure.noResult)`, nine languages).
// ⚠️ The pill word is deliberately untouched (owner ruling ⑩; reopening it is an
// owner question, rca-anomalies.md §2.6 ②) — asserted below so a change to it
// is a visible decision, not a side effect.
//
// Ruler (D-15): every 「can the user read it」 assertion lands on the RENDERED
// paragraph (`didExceedMaxLines`, intrinsic width vs the real box), never on
// `Text.data` alone. Same harness shape as test/pc_offline_note_test.dart.

import 'dart:io';

import 'package:flowmic/src/session/compose_gate.dart' show ComposeSendFailure;
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/status_badge.dart'
    show DeliveryFace, StatusMeta, deliveryFaceMeta, deliveryFaceOf, kRowNoResultCode;
import 'package:flowmic/src/ui/tokens.dart' show FlowMicColors;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/legibility.dart' show ahemWidthFor;

const String _id = 'loc_noresult';

/// Exactly what `manual_delivery_result.dart` `_onResultTimeout` writes: a
/// failed row, no PC verdict, no `wireMode`.
TimelineEntry _row({String code = kRowNoResultCode}) {
  final DateTime now = DateTime.utc(2026, 10, 19, 10, 38, 48);
  return TimelineEntry(
    id: _id,
    clientId: 'c',
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: null,
    outputText: '这一句发出去了，可是电脑一直没有回话',
    status: EntryStatus.failed,
    cachedByVerdict: false,
    origin: 'paired',
    entryType: TimelineEntry.kTranscript,
    failureReason: code,
    createdAt: now,
    updatedAt: now,
  );
}

Widget _tile(TimelineEntry e, AppStrings strings, {bool owed = true}) => MaterialApp(
  home: Scaffold(
    body: ChatMessageTile(
      entry: e,
      strings: strings,
      // The queue still owes this row (its 45 s watchdog only re-queues).
      queued: true,
      owed: owed,
      canResendImage: true,
      onRetry: (TimelineEntry _) {},
    ),
  ),
);

Finder get _note => find.byKey(const ValueKey<String>('entry.reasonNote.$_id'));

double _intrinsicWidth(Text t) {
  final TextPainter p = TextPainter(
    text: TextSpan(text: t.data, style: t.style),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  return p.width;
}

bool _clipped(WidgetTester tester, Finder f) =>
    tester.renderObject<RenderParagraph>(f).didExceedMaxLines;

void main() {
  testWidgets('🔴 360 dp: the ✗ row says 「no answer from the computer」 in full, and no bare code', (
    WidgetTester tester,
  ) async {
    tester.view.physicalSize = const Size(360 * 3, 780 * 3);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
    // English, not Chinese: measured, the zh sentence fits on ONE line at
    // 360 dp (172.5 < 176.25), which would make the clip probe below blind.
    final AppStrings en = AppStrings.of(AppLocale.en);

    final TimelineEntry e = _row();
    // The queue still owes it ⇒ the 「no answer yet」 presentation state; its pill
    // has its own word since NR-280 (swap-point test below).
    expect(deliveryFaceOf(e, queued: true, owed: true), DeliveryFace.noAnswerYet);

    await tester.pumpWidget(_tile(e, en));
    expect(_note, findsOneWidget, reason: 'the ✗ row must say why in words');
    expect(tester.widget<Text>(_note).data,
        en.composeSendError(ComposeSendFailure.noResult),
        reason: 'the same sentence the banner shows for the same event');
    // Positive control for the clip probe: the sentence really needs more than
    // one line here, so 「not clipped」 is a measurement, not a tautology.
    expect(_intrinsicWidth(tester.widget<Text>(_note)),
        greaterThan(tester.getSize(_note).width),
        reason: 'sample too short, this test is blind to regression');
    expect(_clipped(tester, _note), isFalse,
        reason: 'the sentence was eaten by an ellipsis');
    expect(find.textContaining(kRowNoResultCode), findsNothing,
        reason: 'the internal identifier must not be painted next to the sentence');
  });

  testWidgets('positive control: a code nobody knows still prints the bare identifier and no sentence', (
    WidgetTester tester,
  ) async {
    // Without this, 「findsNothing」 above could be a blind finder.
    tester.view.physicalSize = const Size(360 * 3, 780 * 3);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
        _tile(_row(code: 'NR279_UNKNOWN_CODE'), const AppStringsZh()));
    expect(_note, findsNothing);
    expect(find.textContaining('NR279_UNKNOWN_CODE'), findsOneWidget);
  });

  testWidgets('nine languages: the reused sentence renders in full on the ✗ row', (
    WidgetTester tester,
  ) async {
    // Width per script, from the same 700 dp base pc_offline_note_test.dart
    // uses for its all-language case (the meta-row pill, not this sentence,
    // is what needs the width). The narrow-screen claim is the 360 dp case.
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
    for (final AppLocale locale in AppLocale.values) {
      tester.view.physicalSize = Size(ahemWidthFor(700, locale) * 3, 890 * 3);
      final AppStrings s = AppStrings.of(locale);
      await tester.pumpWidget(_tile(_row(), s));
      expect(_note, findsOneWidget, reason: '$locale');
      expect(tester.widget<Text>(_note).data,
          s.composeSendError(ComposeSendFailure.noResult),
          reason: '$locale');
      expect(_clipped(tester, _note), isFalse, reason: '$locale clipped');
    }
  });

  group('🔴 owner 2026-10-19 (reopens ⑩) — 「no answer yet」 is its own presentation state', () {
    TimelineEntry row(String code, {EntryStatus status = EntryStatus.failed}) =>
        TimelineEntry(
          id: _id,
          clientId: 'c',
          mode: FlowMode.realtime,
          delivery: Delivery.inject,
          sourceText: null,
          outputText: 'x',
          status: status,
          cachedByVerdict: false,
          origin: 'paired',
          entryType: TimelineEntry.kTranscript,
          failureReason: code,
          createdAt: DateTime.utc(2026, 10, 19),
          updatedAt: DateTime.utc(2026, 10, 19),
        );

    test('watchdog timeout + queue still owes the row (queued OR inflight) ⇒ noAnswerYet', () {
      // queued:false + owed:true is the 20–45 s window: the item is inflight.
      for (final bool queued in <bool>[false, true]) {
        expect(deliveryFaceOf(row(kRowNoResultCode), queued: queued, owed: true),
            DeliveryFace.noAnswerYet, reason: 'queued=$queued');
      }
    });

    test('a REAL final failure stays failed / its own face', () {
      // The queue no longer owes it (item refused: overflow, bytes gone, …).
      expect(deliveryFaceOf(row(kRowNoResultCode), queued: false, owed: false),
          DeliveryFace.failed);
      // The computer answered with its own failure ⇒ that answer wins.
      expect(deliveryFaceOf(row('INJECT_FOCUS_LOST'), queued: false, owed: true),
          DeliveryFace.deliveredNotInjected);
      // A terminal refusal ⇒ ⛔, never 「no answer yet」.
      expect(deliveryFaceOf(row('INJECT_PC_MISMATCH'), queued: false, owed: true),
          DeliveryFace.refused);
      // Any other phone code (no answer was not the reason) ⇒ ✗ as before.
      expect(deliveryFaceOf(row('LINK_DOWN'), queued: false, owed: true),
          DeliveryFace.failed);
      // A late success flips it like any other row.
      expect(
          deliveryFaceOf(row(kRowNoResultCode, status: EntryStatus.injected),
              queued: false, owed: true),
          DeliveryFace.injected);
    });

    test('SWAP POINT pinned: the pill says its own word, not the ✗ word (all nine locales)', () {
      // NR-280 landed the word: deliveryFaceMeta's `noAnswerYet` arm reads
      // `statusNoAnswerYet`. (「Colour and glyph are still ✗'s」 stood here;
      // the NR-280 follow-up moved them to the pending family, pinned below.)
      // (Before NR-280 this pinned `a.label == s.statusFailed`.)
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final StatusMeta a = deliveryFaceMeta(DeliveryFace.noAnswerYet, s);
        final StatusMeta b = deliveryFaceMeta(DeliveryFace.failed, s);
        expect(a.label, s.statusNoAnswerYet, reason: '$locale');
        expect(a.label, isNot(b.label),
            reason: '$locale: a final failure and a pending one must not share a word');
        // NR-280 follow-up (MAIN 2026-10-19): the pending family's look, not
        // ✗'s. (Before it this pinned `(a.color, a.glyph) == (b.color, b.glyph)`.)
        final StatusMeta d = deliveryFaceMeta(DeliveryFace.delivering, s);
        expect((a.color, a.glyph), (d.color, d.glyph), reason: '$locale');
        expect(a.color, isNot(b.color), reason: '$locale: no failure colour');
        expect(a.glyph, isNot(b.glyph), reason: '$locale: no failure glyph');
      }
    });

    testWidgets('🔴 pending family, rendered: amber ⏳ pill and amber resend, no red ✗ (all nine locales)', (
      WidgetTester tester,
    ) async {
      // NR-280 follow-up (MAIN 2026-10-19; contract 15-RECEIPT-STATES.md
      // §2.0.1-c). Asserted on the painted paragraphs (D-15), not on the
      // meta map alone: the pill and the resend link each draw their own text.
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      for (final AppLocale locale in AppLocale.values) {
        tester.view.physicalSize = Size(ahemWidthFor(700, locale) * 3, 890 * 3);
        final AppStrings s = AppStrings.of(locale);
        await tester.pumpWidget(_tile(_row(), s));
        final Finder pill = find.text('⏳ ${s.statusNoAnswerYet}');
        expect(pill, findsOneWidget, reason: '$locale: the pill wears ⏳');
        final Color? pillColour =
            tester.renderObject<RenderParagraph>(pill).text.style?.color;
        expect(pillColour, FlowMicColors.amber, reason: '$locale pill colour');
        expect(find.textContaining('✗'), findsNothing,
            reason: '$locale: no failure glyph anywhere on the row');
        final Finder resend = find.descendant(
          of: find.byKey(const ValueKey<String>('entry.resend.$_id')),
          matching: find.byType(RichText),
        );
        expect(resend, findsOneWidget, reason: '$locale: resend is still offered');
        expect(
          tester.renderObject<RenderParagraph>(resend).text.style?.color,
          FlowMicColors.amber,
          reason: '$locale resend colour follows the pill',
        );
      }
      // Positive control: the same harness on a final ✗ (queue no longer
      // owes it) paints red ✗ — so the finders above can see a red ✗.
      final AppStrings en = AppStrings.of(AppLocale.en);
      await tester.pumpWidget(_tile(_row(), en, owed: false));
      final Finder failed = find.text('✗ ${en.statusFailed}');
      expect(failed, findsOneWidget);
      expect(tester.renderObject<RenderParagraph>(failed).text.style?.color,
          FlowMicColors.red);
    });

    test('production wiring: the chat list passes the queue\'s owed set, not a default', () {
      // `owed` defaults to false (bounded: renders like today's ✗). The one
      // production site that HAS a queue must pass it, or the state is a façade.
      final String src = File('lib/src/ui/chat_flow_scroll.dart').readAsStringSync();
      expect(src, contains('owed: controller.owedEntryIds.contains(entry.id)'));
    });
  });

  test('🔴 the code stays phone-local: it is in no protocol registry file', () {
    // chat_row_reason.dart `_rowNoteFor` answers it OUTSIDE the four gated wire
    // tables precisely because it is not a registry code
    // (error_code_copy_binding_test.dart ④ pins `_humanNoteFor` to the four).
    // The day the protocol registers it, this goes red and the sentence must
    // move into a gated, segment-checked table instead.
    final List<File> registry = Directory('../../packages/protocol/src')
        .listSync()
        .whereType<File>()
        .where((File f) =>
            RegExp(r'[\\/](error-codes[^\\/]*|inject-verdict-authorship)\.ts$')
                .hasMatch(f.path))
        .toList();
    expect(registry.length, greaterThanOrEqualTo(2),
        reason: 'positive control: the registry files were found at all');
    for (final File f in registry) {
      expect(f.readAsStringSync(), isNot(contains(kRowNoResultCode)),
          reason: f.path);
    }
  });

  test('the four wire tables do not know this code (the new answer cannot shadow one)', () {
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      expect(s.cloudImageRelayErrorNote(kRowNoResultCode), isNull);
      expect(s.injectVerdictNote(kRowNoResultCode), isNull);
      expect(s.pcAdmissionRefusalNote(kRowNoResultCode), isNull);
      expect(s.deliveryRefusalNote(kRowNoResultCode), isNull);
    }
  });
}
