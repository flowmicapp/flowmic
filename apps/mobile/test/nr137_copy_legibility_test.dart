// NR-137 ROUND 5 — THE SIX NEW STRINGS, RENDERED (D-15).
//
// SPEC-REF:
//   CLAUDE.md D-15 (assert on the rendered result, never on `Text.data`)
//   test/support/legibility.dart (the instrument and the 360 dp ruler)
//   _dispatch/2026-10-02-nr137-copy-context.md (the six keys)
//
// What is mounted is what the person reads them on:
//   · the real `PendingRecoveryPage` (over a fake source — this file is about
//     pixels, the real chain is nr137_unverified_retranscribe_test.dart):
//     the in-place sentence, the new-note sentence, the 「uses minutes again」
//     line, and the Re-transcribe button beside Delete;
//   · the real Notes row (`ChatMessageTile`) carrying the re-transcription
//     marker, dated and undated.
// At the 360 dp phone (`ahemWidthBudget`, the Ahem ruler per script), in all
// nine locales, at the app's LARGEST text rung (`AppTextScale.xxlarge`,
// applied the way production applies it: `FlowMicTextScaler` over the
// system scaler, text_scale_scope.dart).
//
// Checks, on the render tree: each paragraph is legible
// (`expectParagraphLegible` — `didExceedMaxLines` where a max is set, else
// "needed wider than the box ⇒ it really wrapped"); no paragraph is cut
// vertically by its box; no flex overflowed (`takeException`); and both
// buttons are on screen and answer a tap.
//
// ⚠️ Ahem is conservative in one direction only: fits under Ahem ⇒ fits on a
// device; not the converse. This file cannot prove a real device.

import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/settings/app_settings.dart'
    show AppLocale, AppTextScale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/pending_recovery_page.dart';
import 'package:flowmic/src/ui/text_scale_scope.dart' show FlowMicTextScaler;
import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart' show HitTestEntry, HitTestResult;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'recovery_copy_matches_capability_test.dart'
    show FakePendingRecoverySource;
import 'support/legibility.dart' show ahemWidthBudget, expectParagraphLegible;

const String _inPlace = 'run-1790000000000000-r1790000000000001';
const String _asNote = 'run-1790000000000000-r1790000000000002';

PendingRecoveryItem _kept(String id, {required bool asNote}) =>
    PendingRecoveryItem(
      id: id,
      state: PendingRecoveryState.settledUnverified,
      durationMs: 754000,
      legacy: false,
      recordedAtMs: 1790000000000,
      retranscribable: true,
      retranscribeAsNote: asNote,
      pressUsesMinutes: true,
    );

Widget _largeText(Widget child) => Builder(
      builder: (BuildContext context) {
        final MediaQueryData data = MediaQuery.of(context);
        return MediaQuery(
          data: data.copyWith(
            textScaler: FlowMicTextScaler(
              system: data.textScaler,
              factor: AppTextScale.xxlarge.factor,
            ),
          ),
          child: child,
        );
      },
    );

/// The rendered criterion for one paragraph, with the vertical half
/// `expectParagraphLegible` leaves to the caller: the box must be tall enough
/// for the lines it laid out.
void _legible(WidgetTester tester, Finder finder, String what) {
  expect(finder, findsWidgets, reason: 'positive control: $what is on screen');
  for (final Element e in finder.evaluate()) {
    final RenderParagraph p = e.renderObject! as RenderParagraph;
    expectParagraphLegible(p, reason: what);
    final double needed = p.getMaxIntrinsicHeight(p.size.width);
    expect(needed, lessThanOrEqualTo(p.size.height + 0.5),
        reason: '$what: needs ${needed.toStringAsFixed(1)}px of height, its box '
            'is ${p.size.height.toStringAsFixed(1)}px (cut vertically)');
  }
}

/// Every paragraph under [root] whose text is exactly [text].
Finder _paragraphOf(Finder root, String text) => find.descendant(
    of: root,
    matching: find.byWidgetPredicate((Widget w) =>
        w is RichText && w.text.toPlainText() == text));

void _labelInside(WidgetTester tester, Finder card, String text, Key button,
    double width, String what) {
  final Finder label = _paragraphOf(card, text);
  expect(label, findsOneWidget, reason: 'positive control: $what');
  final RenderParagraph p = tester.renderObject<RenderParagraph>(label);
  final double oneLine = p.getMaxIntrinsicHeight(double.infinity);
  expect(p.size.height, lessThanOrEqualTo(oneLine + 0.5),
      reason: '$what: a button label must stay on one line');
  expect(p.getMaxIntrinsicWidth(double.infinity),
      lessThanOrEqualTo(p.size.width + 0.5),
      reason: '$what: label squeezed narrower than it needs');
  final Rect l = tester.getRect(label);
  final Rect b = tester.getRect(find.byKey(button));
  expect(l.left >= b.left - 0.5 && l.right <= b.right + 0.5, isTrue,
      reason: '$what: label $l outside its button $b');
  expect(b.right, lessThanOrEqualTo(width + 0.5),
      reason: '$what: button right edge ${b.right.toStringAsFixed(1)} past the '
          '${width.toStringAsFixed(1)}px screen '
          '(overflow ${(b.right - width).toStringAsFixed(1)}px)');
}

void _onScreenAndTappable(
    WidgetTester tester, Finder button, double width, String what) {
  expect(button, findsOneWidget, reason: 'positive control: $what');
  final Rect r = tester.getRect(button);
  expect(r.left, greaterThanOrEqualTo(-0.5), reason: '$what: left edge $r');
  expect(r.right, lessThanOrEqualTo(width + 0.5),
      reason: '$what: right edge ${r.right.toStringAsFixed(1)} past the '
          '${width.toStringAsFixed(1)}px screen');
  expect(r.height, greaterThanOrEqualTo(32 - 0.5), reason: '$what: $r');
  // The tap lands on the button itself, not on something drawn over it.
  final HitTestResult hit = tester.hitTestOnBinding(r.center);
  final RenderObject target = tester.renderObject(button);
  expect(hit.path.any((HitTestEntry h) => h.target == target), isTrue,
      reason: '$what: a tap at its centre does not reach it');
}

void main() {
  for (final AppLocale locale in AppLocale.values) {
    testWidgets(
        '${locale.name}: the pending card — both sentences, the minutes line '
        'and the Re-transcribe button — land unclipped at 360 dp, largest '
        'text', (WidgetTester tester) async {
      final double width = ahemWidthBudget(locale);
      tester.view.physicalSize = Size(width, 4000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      final AppStrings s = AppStrings(locale);
      final FakePendingRecoverySource source = FakePendingRecoverySource(
          <PendingRecoveryItem>[
        _kept(_inPlace, asNote: false),
        _kept(_asNote, asNote: true),
      ]);
      await tester.pumpWidget(MaterialApp(
        builder: (BuildContext context, Widget? child) => _largeText(child!),
        home: PendingRecoveryPage(source: source, strings: s),
      ));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull,
          reason: '${locale.name}: a flex overflowed on the card');

      final Finder inPlace =
          find.byKey(const ValueKey<String>('pendingRecovery.card.$_inPlace'));
      final Finder asNote =
          find.byKey(const ValueKey<String>('pendingRecovery.card.$_asNote'));
      _legible(tester, _paragraphOf(inPlace, s.pendingRecoveryStateUnverifiedRetranscribe),
          '${locale.name}/dev_pendingRecoveryStateUnverifiedRetranscribe');
      _legible(tester, _paragraphOf(asNote, s.pendingRecoveryStateUnverifiedRetranscribeNote),
          '${locale.name}/dev_pendingRecoveryStateUnverifiedRetranscribeNote');
      _legible(tester, _paragraphOf(inPlace, s.pendingRecoveryRetranscribeUsesMinutes),
          '${locale.name}/dev_pendingRecoveryRetranscribeUsesMinutes');
      // The two button labels sit in a Row with no Flexible
      // (pending_recovery_card.dart `_button`): they are laid out at an
      // UNBOUNDED width and never wrap, so `expectParagraphLegible` has
      // nothing to measure there (its ③ fires: 「laid out at infinite
      // width」). For that structure the rendered criterion is: no flex
      // overflow (checked above), one line, and the whole label inside its
      // button inside the screen.
      _labelInside(tester, inPlace, s.pendingRecoveryRetranscribe,
          const ValueKey<String>('pendingRecovery.retry.$_inPlace'), width,
          '${locale.name}/dev_pendingRecoveryRetranscribe');
      _labelInside(tester, inPlace, s.confirmDelete,
          const ValueKey<String>('pendingRecovery.delete.$_inPlace'), width,
          '${locale.name}/confirmDelete (beside it)');

      _onScreenAndTappable(
          tester,
          find.byKey(const ValueKey<String>('pendingRecovery.retry.$_inPlace')),
          width,
          '${locale.name}/Re-transcribe button');
      _onScreenAndTappable(
          tester,
          find.byKey(const ValueKey<String>('pendingRecovery.delete.$_inPlace')),
          width,
          '${locale.name}/Delete button');
      // And the press really is taken.
      await tester.tap(
          find.byKey(const ValueKey<String>('pendingRecovery.retry.$_inPlace')));
      await tester.pumpAndSettle();
      expect(source.retried, <String>[_inPlace]);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
        '${locale.name}: the Notes row carries its re-transcription mark, '
        'dated and undated, unclipped at 360 dp, largest text',
        (WidgetTester tester) async {
      final double width = ahemWidthBudget(locale);
      tester.view.physicalSize = Size(width, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      final AppStrings s = AppStrings(locale);
      TimelineEntry note(String id, String from) => TimelineEntry(
            id: id,
            clientId: 'rt-$id',
            mode: FlowMode.realtime,
            delivery: Delivery.none,
            sourceText: 'Re-transcribed words',
            outputText: 'Re-transcribed words',
            status: EntryStatus.noted,
            origin: 'cloud',
            retranscribedFrom: from,
            createdAt: DateTime.utc(2026, 10, 2, 9),
            updatedAt: DateTime.utc(2026, 10, 2, 9),
          );
      await tester.pumpWidget(MaterialApp(
        builder: (BuildContext context, Widget? child) => _largeText(child!),
        home: Material(
          child: ListView(children: <Widget>[
            ChatMessageTile(
                queued: false,
                canResendImage: false,
                entry: note('dated', 'run-1790000000000000-r1790000000000000'),
                strings: s),
            ChatMessageTile(
                queued: false,
                canResendImage: false,
                entry: note('undated', 'legacy-session-without-a-clock'),
                strings: s),
          ]),
        ),
      ));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull,
          reason: '${locale.name}: the row overflowed');
      for (final String id in <String>['dated', 'undated']) {
        final Finder mark =
            find.byKey(ValueKey<String>('entry.retranscribedMarker.$id'));
        expect(mark, findsOneWidget, reason: 'positive control: $id mark');
        final String text = tester.widget<Text>(mark).data!;
        expect(text,
            id == 'dated' ? isNot(s.retranscribedNoteMarkerUndated) : s.retranscribedNoteMarkerUndated);
        _legible(
            tester,
            find.descendant(of: mark, matching: find.byType(RichText)),
            '${locale.name}/${id == 'dated' ? 'dev_retranscribedNoteMarker' : 'dev_retranscribedNoteMarkerUndated'}');
        final Rect r = tester.getRect(mark);
        expect(r.right, lessThanOrEqualTo(width + 0.5),
            reason: '${locale.name}/$id mark right edge past the screen');
      }
    });
  }
}
