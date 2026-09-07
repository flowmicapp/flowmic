// Card RC-1b — `recovery_copy_matches_capability_test` (audit §A10, P2-10).
//
// THE ASSERTION THE AUDIT ASKED FOR, in its own words: 「恢复文案三分支（有入口/
// 无入口/服务器不支持）; O-8 未裁 ⇒ 不出现「需手动发送」」 — the recovery copy
// branches by what is actually possible, and while O-8 stands (it is now ruled:
// there IS no send entry) the words 「send it manually」 must not appear.
//
// 🔴 IT MOUNTS THE REAL SCREEN. `PendingRecoveryPage` over a fake source, one
// state at a time — CLAUDE.md anti-façade ⑥: 「验收用例必须挂载 X 屏」. Asserting
// the switch in `PendingRecoveryCard.sentenceFor` directly would prove that a
// pure function returns five different strings, which nobody doubted, and would
// have stayed green through the defect that rule was written for (the model was
// right and the screen never rendered it).
//
// ⚠️ RULER: `flutter_test` paints Ahem, every glyph a full-em square, so the
// legibility group uses `support/legibility.dart`'s `ahemWidthBudget` — 「not
// clipped under Ahem」 ⇒ 「not clipped on a real device」, and NOT the converse.
// The same file's header is also why this test does not simply assert
// `didExceedMaxLines == false`: with `maxLines` unset that reading is
// structurally unable to fail, so `expectLegible` reads the four falsifiable
// facts instead and only asserts the flag where the product really set a cap.

import 'dart:async';

import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/pending_recovery_entry.dart';
import 'package:flowmic/src/ui/pending_recovery_page.dart';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/legibility.dart' show ahemWidthBudget, expectLegible;

/// A source with no filesystem behind it. Every answer is set by the case.
class FakePendingRecoverySource implements PendingRecoverySource {
  FakePendingRecoverySource(this.items);

  List<PendingRecoveryItem> items;
  bool recording = false;
  PendingRetryOutcome retryAnswer = PendingRetryOutcome.done;

  final List<String> retried = <String>[];
  final List<String> deleted = <String>[];

  /// What the store answers a delete with. Default is the ordinary path; a
  /// case that wants the Z1 failure sentence sets it to
  /// [PendingDeleteOutcome.failed], and the item deliberately STAYS in the
  /// list, because that is what a refused file removal leaves behind.
  PendingDeleteOutcome deleteAnswer = PendingDeleteOutcome.done;

  /// When set, [retryNow] parks on it — the only way to hold the screen in its
  /// in-flight state long enough to ask what it offers there.
  Completer<void>? retryGate;

  @override
  bool get recordingNow => recording;

  @override
  Future<List<PendingRecoveryItem>> list() async => items;

  @override
  Future<PendingRetryOutcome> retryNow(PendingRecoveryItem item) async {
    retried.add(item.id);
    final Completer<void>? gate = retryGate;
    if (gate != null) await gate.future;
    return retryAnswer;
  }

  @override
  Future<PendingDeleteOutcome> delete(PendingRecoveryItem item) async {
    deleted.add(item.id);
    if (deleteAnswer == PendingDeleteOutcome.failed) return deleteAnswer;
    items = items
        .where((PendingRecoveryItem e) => e.id != item.id)
        .toList(growable: false);
    return deleteAnswer;
  }
}

PendingRecoveryItem itemIn(
  PendingRecoveryState state, {
  String id = 'run-1757000000000000-r1757000000000',
  bool legacy = false,
  int durationMs = 95000,
}) =>
    PendingRecoveryItem(
      id: id,
      state: state,
      durationMs: durationMs,
      legacy: legacy,
      recordedAtMs: recordedAtMsFromId(id),
    );

/// Every sentence this screen can render, so a case can assert that the other
/// four are ABSENT — one sentence per state is the requirement, and 「the right
/// one is there」 is only half of it.
List<String> allSentences(AppStrings s) => <String>[
      s.pendingRecoveryStateWaiting,
      s.pendingRecoveryStateNeedsManual,
      s.pendingRecoveryStateUnverified,
      s.pendingRecoveryStateServerKeepsAudio,
      s.pendingRecoveryStateEmptyResult,
      s.pendingRecoveryStateServerUnsupported,
      s.pendingRecoveryStateCancelled,
      s.pendingRecoveryStateUnreadable,
    ];

Future<void> mountPage(
  WidgetTester tester,
  PendingRecoverySource source,
  AppStrings strings,
) async {
  await tester.pumpWidget(MaterialApp(
    home: PendingRecoveryPage(source: source, strings: strings),
  ));
  await tester.pumpAndSettle();
}

void main() {
  final AppStrings en = AppStrings(AppLocale.en);

  group('one state, one sentence, on the real screen', () {
    for (final PendingRecoveryState state in PendingRecoveryState.values) {
      testWidgets('${state.name}: its own sentence and none of the others',
          (WidgetTester tester) async {
        tester.view.physicalSize = const Size(1080, 2400);
        tester.view.devicePixelRatio = 3.0;
        addTearDown(tester.view.reset);

        await mountPage(
            tester, FakePendingRecoverySource(<PendingRecoveryItem>[
          itemIn(state),
        ]), en);

        final String mine = switch (state) {
          PendingRecoveryState.waitingAuto => en.pendingRecoveryStateWaiting,
          PendingRecoveryState.needsManual =>
            en.pendingRecoveryStateNeedsManual,
          PendingRecoveryState.settledUnverified =>
            en.pendingRecoveryStateUnverified,
          PendingRecoveryState.settledServerKeepsAudio =>
            en.pendingRecoveryStateServerKeepsAudio,
          PendingRecoveryState.emptyResult =>
            en.pendingRecoveryStateEmptyResult,
          PendingRecoveryState.serverUnsupported =>
            en.pendingRecoveryStateServerUnsupported,
          PendingRecoveryState.cancelled =>
            en.pendingRecoveryStateCancelled,
          PendingRecoveryState.unreadable =>
            en.pendingRecoveryStateUnreadable,
        };
        expect(find.text(mine), findsOneWidget);
        for (final String other in allSentences(en)) {
          if (other == mine) continue;
          expect(find.text(other), findsNothing,
              reason: 'a second state\'s sentence is on a card that is not in '
                  'that state — one value answering two questions');
        }
      });
    }

    testWidgets(
        '🔴 O-8: not one sentence on this screen mentions sending to a PC',
        (WidgetTester tester) async {
      // The audit's own wording: while there is no send entry, the copy may not
      // name one. Checked across all nine languages, because the prohibition is
      // about the PRODUCT and a translator would have no way of knowing.
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings(locale);
        for (final String sentence in <String>[
          ...allSentences(s),
          s.pendingRecoveryTitle,
          s.pendingRecoveryEmpty,
          s.pendingRecoveryRetryNow,
          s.pendingRecoveryRetryBusy,
          s.pendingRecoveryRetryFailed,
          s.pendingRecoveryDeleteTitle,
          s.pendingRecoveryDeleteBody,
        ]) {
          final String lower = sentence.toLowerCase();
          for (final String banned in <String>[
            'pc',
            'computer',
            'ordinateur',
            'computadora',
            'rechner',
            '电脑',
            '電腦',
            'パソコン',
            '컴퓨터',
            'компьютер',
          ]) {
            expect(lower.contains(banned), isFalse,
                reason: '${locale.name}: 「$sentence」 names a destination that '
                    'has no entry point (owner ruling O-8)');
          }
        }
      }
    });
  });

  group('the copy matches the capability', () {
    testWidgets('🔴 tier C: the sentence is there and the retry button is not',
        (WidgetTester tester) async {
      final FakePendingRecoverySource src =
          FakePendingRecoverySource(<PendingRecoveryItem>[
        itemIn(PendingRecoveryState.serverUnsupported),
      ]);
      await mountPage(tester, src, en);

      expect(find.text(en.pendingRecoveryStateServerUnsupported),
          findsOneWidget);
      expect(find.text(en.pendingRecoveryRetryNow), findsNothing,
          reason: 'A7-3 tier C sends zero audio:start — a retry here would be '
              'refused by evaluateRecoveryGate on every press');
      // Delete is still offered: the audio is on this phone and owner ruling
      // O-5 makes the user the only one who may remove it.
      expect(find.text(en.confirmDelete), findsOneWidget);
    });

    testWidgets(
        '🔴 settled-unverified and cancelled offer delete and nothing else',
        (WidgetTester tester) async {
      for (final PendingRecoveryState state in <PendingRecoveryState>[
        PendingRecoveryState.settledUnverified,
        PendingRecoveryState.cancelled,
      ]) {
        await mountPage(
            tester,
            FakePendingRecoverySource(<PendingRecoveryItem>[itemIn(state)]),
            en);
        expect(find.text(en.pendingRecoveryRetryNow), findsNothing,
            reason: '${state.name}: retrying either re-transcribes words the '
                'user already has, or resurrects one they threw away');
        expect(find.text(en.confirmDelete), findsOneWidget);
      }
    });

    testWidgets('needs-manual is the one state that exists to offer the button',
        (WidgetTester tester) async {
      final FakePendingRecoverySource src =
          FakePendingRecoverySource(<PendingRecoveryItem>[
        itemIn(PendingRecoveryState.needsManual),
      ]);
      await mountPage(tester, src, en);
      expect(find.text(en.pendingRecoveryRetryNow), findsOneWidget);
      await tester.tap(find.text(en.pendingRecoveryRetryNow));
      await tester.pumpAndSettle();
      expect(src.retried, hasLength(1),
          reason: '§A6 R-2: the entry must reach the queue, not just exist');
    });

    testWidgets('🔴 a legacy recording gets the sentence but no button',
        (WidgetTester tester) async {
      // There is no per-recording entry into the legacy leg; a button here
      // would have to sweep everything, i.e. this card would transcribe some
      // other recording.
      await mountPage(
          tester,
          FakePendingRecoverySource(<PendingRecoveryItem>[
            itemIn(PendingRecoveryState.waitingAuto,
                id: 'run-1757000000000000', legacy: true),
          ]),
          en);
      expect(find.text(en.pendingRecoveryStateWaiting), findsOneWidget);
      expect(find.text(en.pendingRecoveryRetryNow), findsNothing);
    });

    testWidgets('while a recording is running, no card offers a retry',
        (WidgetTester tester) async {
      final FakePendingRecoverySource src =
          FakePendingRecoverySource(<PendingRecoveryItem>[
        itemIn(PendingRecoveryState.needsManual),
      ])
        ..recording = true;
      await mountPage(tester, src, en);
      expect(find.text(en.pendingRecoveryRetryNow), findsNothing);
      expect(find.text(en.confirmDelete), findsOneWidget);
    });

    testWidgets('a refusal is said out loud, in its own words',
        (WidgetTester tester) async {
      final FakePendingRecoverySource src =
          FakePendingRecoverySource(<PendingRecoveryItem>[
        itemIn(PendingRecoveryState.needsManual),
      ])
        ..retryAnswer = PendingRetryOutcome.refusedBusy;
      await mountPage(tester, src, en);
      await tester.tap(find.text(en.pendingRecoveryRetryNow));
      await tester.pumpAndSettle();
      expect(find.text(en.pendingRecoveryRetryBusy), findsOneWidget,
          reason: 'a press that goes nowhere and says nothing is the silent '
              'failure the red line forbids');
    });

    testWidgets('a failed attempt says the audio is still here',
        (WidgetTester tester) async {
      final FakePendingRecoverySource src =
          FakePendingRecoverySource(<PendingRecoveryItem>[
        itemIn(PendingRecoveryState.needsManual),
      ])
        ..retryAnswer = PendingRetryOutcome.failed;
      await mountPage(tester, src, en);
      await tester.tap(find.text(en.pendingRecoveryRetryNow));
      await tester.pumpAndSettle();
      expect(find.text(en.pendingRecoveryRetryFailed), findsOneWidget);
    });

    testWidgets('🔴 a delete that did not happen says so (O-2)',
        (WidgetTester tester) async {
      // Before this, a refused file removal was swallowed into a diag line and
      // the card simply reappeared. That is not a sentence: this page re-reads
      // its list after EVERY action, so 「still there」 also describes a
      // perfectly successful delete of a different card. The person just
      // confirmed a destructive dialog and is owed an answer.
      final FakePendingRecoverySource src =
          FakePendingRecoverySource(<PendingRecoveryItem>[
        itemIn(PendingRecoveryState.cancelled),
      ])
        ..deleteAnswer = PendingDeleteOutcome.failed;
      await mountPage(tester, src, en);
      await tester.tap(find.text(en.confirmDelete));
      await tester.pumpAndSettle();
      await tester.tap(find.text(en.confirmDelete).last);
      await tester.pumpAndSettle();

      expect(src.deleted, hasLength(1), reason: 'the press must reach the store');
      expect(find.text(en.pendingRecoveryDeleteFailed), findsOneWidget);
      expect(find.text(en.pendingRecoveryStateCancelled), findsOneWidget,
          reason: 'the recording is still on the phone, so its card stays');
    });

    testWidgets('🔴 a delete that DID happen says nothing (the control)',
        (WidgetTester tester) async {
      // The reverse of the case above, and it is what stops the sentence from
      // becoming decoration: an ordinary delete must leave the screen silent.
      final FakePendingRecoverySource src =
          FakePendingRecoverySource(<PendingRecoveryItem>[
        itemIn(PendingRecoveryState.cancelled),
      ]);
      await mountPage(tester, src, en);
      await tester.tap(find.text(en.confirmDelete));
      await tester.pumpAndSettle();
      await tester.tap(find.text(en.confirmDelete).last);
      await tester.pumpAndSettle();

      expect(find.text(en.pendingRecoveryDeleteFailed), findsNothing);
      expect(find.byKey(const Key('pendingRecovery.empty')), findsOneWidget);
    });

    testWidgets('🔴 delete is withheld while a retry is in flight', (
        WidgetTester tester) async {
      // The race this closes: the leg opens a journal handle for the attempt,
      // and a delete landing underneath it let the settle write that
      // recording's manifest back — audio the user had just removed
      // reappearing as a card. The leg refuses that on its own now, but a
      // button that can start the race is still a button that can start it,
      // and Retry was already withheld here for the same reason.
      final Completer<void> gate = Completer<void>();
      final FakePendingRecoverySource src =
          FakePendingRecoverySource(<PendingRecoveryItem>[
        itemIn(PendingRecoveryState.needsManual),
      ])
        ..retryGate = gate;
      await mountPage(tester, src, en);
      expect(find.text(en.confirmDelete), findsOneWidget);

      await tester.tap(find.text(en.pendingRecoveryRetryNow));
      await tester.pump();

      expect(find.text(en.pendingRecoveryRetryNow), findsNothing,
          reason: 'setup: the retry must actually be in flight');
      expect(find.text(en.confirmDelete), findsNothing,
          reason: 'delete may not be pressed into a running attempt');

      gate.complete();
      await tester.pumpAndSettle();
      expect(find.text(en.confirmDelete), findsOneWidget,
          reason: 'and it comes straight back — withheld for the second it '
              'takes, never removed');
    });

    testWidgets('🔴 O-2: an unreadable recording is on the screen, and the '
        'only thing it offers is delete', (WidgetTester tester) async {
      final FakePendingRecoverySource src =
          FakePendingRecoverySource(<PendingRecoveryItem>[
        itemIn(PendingRecoveryState.unreadable),
      ]);
      await mountPage(tester, src, en);

      expect(find.text(en.pendingRecoveryStateUnreadable), findsOneWidget,
          reason: 'audio nothing lists is audio nobody can remove, and it '
              'counts against the cap either way (O-2)');
      expect(find.text(en.pendingRecoveryRetryNow), findsNothing,
          reason: 'there is no readable range and no format to feed it in — a '
              'button here would be refused every time it was pressed');
      expect(find.text(en.confirmDelete), findsOneWidget);
    });
  });

  group('nine locales, rendered, at a 360dp phone', () {
    for (final AppLocale locale in AppLocale.values) {
      testWidgets('${locale.name}: every state sentence lands unclipped',
          (WidgetTester tester) async {
        final double width = ahemWidthBudget(locale);
        tester.view.physicalSize = Size(width * 3, 2400 * 3);
        tester.view.devicePixelRatio = 3.0;
        addTearDown(tester.view.reset);

        final AppStrings s = AppStrings(locale);
        for (final PendingRecoveryState state in PendingRecoveryState.values) {
          final PendingRecoveryItem item = itemIn(state);
          await mountPage(
              tester,
              FakePendingRecoverySource(<PendingRecoveryItem>[item]),
              s);
          expectLegible(
            tester,
            find.byKey(ValueKey<String>('pendingRecovery.sentence.${item.id}')),
            reason: '${locale.name}/${state.name}',
          );
          expect(tester.takeException(), isNull,
              reason: '${locale.name}/${state.name}: the card overflowed its '
                  'box vertically — expectLegible only covers the horizontal');
        }
      });
    }
  });

  group('the door', () {
    testWidgets('🔴 absent when nothing is waiting', (WidgetTester tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: PendingRecoveryEntry(
            source: FakePendingRecoverySource(const <PendingRecoveryItem>[]),
            strings: en,
          ),
        ),
      ));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('pendingRecovery.entry')), findsNothing,
          reason: 'a permanent row that usually opens an empty list implies, '
              'every day, that something is owed');
    });

    testWidgets('🔴 present with one recording, and it really opens the page',
        (WidgetTester tester) async {
      final FakePendingRecoverySource src =
          FakePendingRecoverySource(<PendingRecoveryItem>[
        itemIn(PendingRecoveryState.needsManual),
      ]);
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: PendingRecoveryEntry(source: src, strings: en),
        ),
      ));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('pendingRecovery.entry')), findsOneWidget);

      // anti-façade ⑥: walk the middle. A row that renders and routes nowhere
      // is a page that does not exist.
      await tester.tap(find.byKey(const Key('pendingRecovery.entry')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('pendingRecovery.title')), findsOneWidget);
      expect(find.text(en.pendingRecoveryStateNeedsManual), findsOneWidget);
    });

    testWidgets('a cancelled recording is enough to open the door',
        (WidgetTester tester) async {
      // Owner ruling O-5 names this list as the only place the user can remove
      // cancelled audio — so a phone whose only kept audio is cancelled must
      // still have a way in. `BackfillProgress.hasKeptAudio` cannot see this
      // case and says so; the row is built from the list instead.
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: PendingRecoveryEntry(
            source: FakePendingRecoverySource(<PendingRecoveryItem>[
              itemIn(PendingRecoveryState.cancelled),
            ]),
            strings: en,
          ),
        ),
      ));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('pendingRecovery.entry')), findsOneWidget);
    });
  });

  group('the recorded-at line is read, never invented', () {
    test('both minting shapes are understood, and nothing else is', () {
      // 🔴 THE ID IS TAKEN OFF A REAL DEVICE, NOT INVENTED. This case used to
      // feed `-r1757000000123` — thirteen digits, a millisecond value that the
      // product never mints — and so it asserted the parser's bug as the spec.
      // The real shape (drill D-2, 2026-09-06) is BOTH halves in MICROseconds,
      // 56 µs apart, because `retained_audio_spill.dart`'s `_wallClock` is
      // `DateTime.now().microsecondsSinceEpoch`, the same clock
      // `retained_audio_store.dart`'s `_defaultSessionKey` uses.
      const String realId = 'run-1788670774204536-r1788670774204592';
      expect(recordedAtMsFromId(realId), 1788670774204);
      // journal — retained_audio_spill.dart `beginRecording`, MICROseconds
      expect(recordedAtMsFromId('run-1757000000000000-r1757000000123456'),
          1757000000123);
      // legacy — retained_audio_store.dart `_defaultSessionKey`, MICROseconds
      expect(recordedAtMsFromId('run-1757000000000000'), 1757000000000);
      // 🔴 the trap, and it is a YEAR assertion because the card renders
      // weekday/month/day and NO year: a 56,000-year error looked like an
      // ordinary "Sat, Sep 21" on screen, so only the year can see it.
      expect(
          DateTime.fromMillisecondsSinceEpoch(recordedAtMsFromId(realId)!)
              .year,
          2026);
      expect(recordedAtMsFromId('run-1757000000000000'),
          lessThan(DateTime(2100).millisecondsSinceEpoch));
      // anything else is ABSENCE, not a fabricated zero
      expect(recordedAtMsFromId('legacy-session'), isNull);
      expect(recordedAtMsFromId('run-nope'), isNull);
    });

    testWidgets('an unreadable id renders the duration and no date',
        (WidgetTester tester) async {
      final PendingRecoveryItem item = itemIn(
        PendingRecoveryState.waitingAuto,
        id: 'no-clock-here',
        durationMs: 95000,
      );
      expect(item.recordedAtMs, isNull);
      await mountPage(
          tester,
          FakePendingRecoverySource(<PendingRecoveryItem>[item]),
          en);
      final Text meta = tester.widget<Text>(
        find.byKey(ValueKey<String>('pendingRecovery.meta.${item.id}')),
      );
      expect(meta.data, '1:35',
          reason: 'the duration is measured; the date is absent because it is '
              'not known, and a fabricated one would be used to decide what '
              'to delete');
    });
  });

  // ─────────────────────────────────────────────────────── Card FX-1, D-5b
  //
  // A 30.7 s press lost 26.5 s to a full disk and the card said
  // 「Sun, Sep 6 · 3s / Waiting for the next automatic attempt」 — a truthful
  // duration presented as the whole recording, with a retry offered as though
  // there were nothing to say. The duration was already measured from the
  // recoverable range and stays as it is; what was missing is the second line.
  //
  // MOUNTED ON THE REAL SCREEN for the reason this file's header gives: the
  // model was already able to carry the flag, and a test that asserted the
  // model would have stayed green through a card that never read it.
  group('FX-1 partly saved is a second line, not a ninth state', () {
    testWidgets('the line appears and the state sentence survives it',
        (WidgetTester tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      const PendingRecoveryItem item = PendingRecoveryItem(
        id: 'run-1757000000000000-r1757000000000',
        state: PendingRecoveryState.waitingAuto,
        durationMs: 3600,
        legacy: false,
        partlySaved: true,
      );
      await mountPage(tester,
          FakePendingRecoverySource(<PendingRecoveryItem>[item]), en);

      expect(find.text(en.pendingRecoveryPartlySaved), findsOneWidget);
      expect(find.text(en.pendingRecoveryStateWaiting), findsOneWidget,
          reason: 'an incomplete recording is still owed an attempt');
      // O-9 / A6 R-2: what survived can still become words, so the offer stays.
      expect(
        find.byKey(ValueKey<String>('pendingRecovery.retry.${item.id}')),
        findsOneWidget,
      );
    });

    testWidgets('a whole recording never shows it',
        (WidgetTester tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      await mountPage(
        tester,
        FakePendingRecoverySource(
            <PendingRecoveryItem>[itemIn(PendingRecoveryState.waitingAuto)]),
        en,
      );
      expect(find.text(en.pendingRecoveryPartlySaved), findsNothing);
    });
  });
}
