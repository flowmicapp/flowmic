// Card WB-6 — EVERY PRESS OF 「try again now」 IS ANSWERED, AND THE ANSWER IS ON
// THE SCREEN.
//
// SPEC-REF:
//   docs/archive/strategy/2026-09-12-phone-pending-transcription-retry-rca.md
//     (§0 the report, §1-2 the three presses, §1-3 the wrong sentence,
//      §2-3 the thirteen early exits, seven of them silent)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-b, R11
//   apps/mobile/lib/src/ui/pending_recovery_page.dart (what is under test)
//
// ── WHY THE EXISTING SUITE COULD NOT SEE THIS ───────────────────────────────
//
// `recovery_copy_matches_capability_test.dart` mounts the same screen over the
// same kind of fake and is green, and it was green through the whole defect.
// Its fake answers `retryNow` and the case then asserts a sentence — which
// works for every outcome that HAS one. The one that had none is the one that
// happens in production: an attempt runs, the engine answers with nothing
// again, and the list comes back holding the same card. There was no case for
// 「done, and the list did not change」, so the arm that returns null was never
// looked at.
//
// 🔴 THE FAKE HERE IS DIFFERENT IN EXACTLY ONE WAY, AND THAT IS THE POINT: it
// can be told what `list()` returns AFTER the retry. That is the fact the
// screen now reads before it decides whether silence is an answer, so a fake
// that cannot change its mind cannot test it.
//
// MEASURED BEFORE THE FIX (reverse control, 2026-09-12): with
// `_noticeFor`'s `done` arm put back to `null`, 「says so when the recording is
// still empty」 fails with
//   Expected: exactly one matching candidate
//     Actual: _TextWidgetFinder:<zero widgets with text "Tried again. This
//             recording still has no words in it.">
// and with the busy face removed, 「the card shows it is working」 fails on
// `pendingRecovery.retrying.…`.

import 'dart:async';

import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/pending_recovery_entry.dart';
import 'package:flowmic/src/ui/pending_recovery_page.dart';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// A source whose list can change under the screen, which is what a real
/// recovery does.
class _Source implements PendingRecoverySource {
  _Source(this.items);

  List<PendingRecoveryItem> items;

  /// What `list()` answers once [retryNow] has been called. Null ⇒ unchanged,
  /// which is the production shape this card exists for.
  List<PendingRecoveryItem>? afterRetry;

  PendingRetryOutcome retryAnswer = PendingRetryOutcome.done;
  PendingRetryBlocker? blocker;

  /// Parks [retryNow] so a case can look at the screen mid-attempt.
  Completer<void>? gate;

  final List<String> retried = <String>[];

  @override
  PendingRetryBlocker? get retryBlocker => blocker;

  @override
  Future<List<PendingRecoveryItem>> list() async => items;

  @override
  Future<PendingRetryOutcome> retryNow(PendingRecoveryItem item) async {
    retried.add(item.id);
    final Completer<void>? g = gate;
    if (g != null) await g.future;
    final List<PendingRecoveryItem>? next = afterRetry;
    if (next != null) items = next;
    return retryAnswer;
  }

  @override
  Future<PendingDeleteOutcome> delete(PendingRecoveryItem item) async {
    items = items
        .where((PendingRecoveryItem e) => e.id != item.id)
        .toList(growable: false);
    return PendingDeleteOutcome.done;
  }
}

PendingRecoveryItem _item(
  PendingRecoveryState state, {
  String id = 'run-1757000000000000-r1757000000000',
}) =>
    PendingRecoveryItem(
      id: id,
      state: state,
      durationMs: 6000,
      legacy: false,
      recordedAtMs: recordedAtMsFromId(id),
    );

Future<void> _mount(
  WidgetTester tester,
  PendingRecoverySource source,
  AppStrings strings,
) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    home: PendingRecoveryPage(source: source, strings: strings),
  ));
  await tester.pumpAndSettle();
}

void main() {
  final AppStrings en = AppStrings(AppLocale.en);

  group('a press that ran and changed nothing still says something', () {
    testWidgets('🔴 the recording that came back empty AGAIN is told so',
        (WidgetTester tester) async {
      // THE OWNER'S CASE, 2026-09-12. A six-second recording of silence: the
      // attempt runs for two to three seconds, the engine answers with nothing
      // a second time, and the list comes back holding the same card. Before
      // this card the product's entire answer was to redraw an identical
      // screen.
      final _Source src = _Source(<PendingRecoveryItem>[
        _item(PendingRecoveryState.emptyResult),
      ]);
      await _mount(tester, src, en);
      await tester.tap(find.text(en.pendingRecoveryRetryNow));
      await tester.pumpAndSettle();

      expect(src.retried, hasLength(1),
          reason: 'setup: the press has to reach the queue');
      expect(find.text(en.pendingRecoveryRetryStillEmpty), findsOneWidget,
          reason: 'the card is identical to the one that was there before the '
              'press, so it cannot be the answer — and silence is not one');
    });

    testWidgets(
        '🔴 and the second empty answer ends the road: no button, delete only',
        (WidgetTester tester) async {
      // What the production store does on the next read: an attempt stamped
      // `user_retranscribe` that settled `emptyResult` turns the state into
      // `emptyConfirmed` (pending_recovery_store.dart `_userRetryCameBackEmpty`).
      // Here the fake simply reports what the store would.
      final _Source src = _Source(<PendingRecoveryItem>[
        _item(PendingRecoveryState.emptyResult),
      ])
        ..afterRetry = <PendingRecoveryItem>[
          _item(PendingRecoveryState.emptyConfirmed),
        ];
      await _mount(tester, src, en);
      await tester.tap(find.text(en.pendingRecoveryRetryNow));
      await tester.pumpAndSettle();

      expect(find.text(en.pendingRecoveryRetryStillEmpty), findsOneWidget);
      expect(find.text(en.pendingRecoveryStateEmptyConfirmed), findsOneWidget,
          reason: 'the card stops describing itself as something that is '
              'waiting for an attempt');
      expect(find.text(en.pendingRecoveryRetryNow), findsNothing,
          reason: 'offering the button a third time offers a mechanism we have '
              'now measured twice to change nothing');
      expect(find.text(en.confirmDelete), findsOneWidget,
          reason: 'owner ruling O-2/O-5: the bytes are still here and the user '
              'is the only one who may remove them');
    });

    testWidgets('a press that finished on a card that is still here says so',
        (WidgetTester tester) async {
      // Row H of the report's table: an unaligned byte range ends the step as
      // `completed` without sending anything, and the card does not move.
      final _Source src = _Source(<PendingRecoveryItem>[
        _item(PendingRecoveryState.needsManual),
      ]);
      await _mount(tester, src, en);
      await tester.tap(find.text(en.pendingRecoveryRetryNow));
      await tester.pumpAndSettle();

      expect(find.text(en.pendingRecoveryRetryKept), findsOneWidget);
    });

    testWidgets('🔴 THE CONTROL: when the card goes away, nothing is said',
        (WidgetTester tester) async {
      // This is what stops the sentences above from becoming decoration. A
      // retry that produced words removes the row, and a line about 「this
      // recording」 under a list that no longer holds it would be worse than
      // none.
      final _Source src = _Source(<PendingRecoveryItem>[
        _item(PendingRecoveryState.needsManual),
      ])
        ..afterRetry = const <PendingRecoveryItem>[];
      await _mount(tester, src, en);
      await tester.tap(find.text(en.pendingRecoveryRetryNow));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('pendingRecovery.notice')), findsNothing);
      expect(find.byKey(const Key('pendingRecovery.empty')), findsOneWidget);
    });

    testWidgets('「nothing to drive」 is said when the card is still there',
        (WidgetTester tester) async {
      final _Source src = _Source(<PendingRecoveryItem>[
        _item(PendingRecoveryState.needsManual),
      ])
        ..retryAnswer = PendingRetryOutcome.unavailable;
      await _mount(tester, src, en);
      await tester.tap(find.text(en.pendingRecoveryRetryNow));
      await tester.pumpAndSettle();

      expect(find.text(en.pendingRecoveryRetryUnavailable), findsOneWidget);
    });
  });

  group('while it is running, the card has a face', () {
    testWidgets('🔴 a spinner and a sentence, not two buttons vanishing',
        (WidgetTester tester) async {
      // MEASURED 2026-09-12 (TB335ZC): 1.81 s / 3.26 s of a card whose buttons
      // had disappeared and whose sentence was unchanged. Nothing on it said an
      // attempt was running.
      final Completer<void> gate = Completer<void>();
      final _Source src = _Source(<PendingRecoveryItem>[
        _item(PendingRecoveryState.emptyResult),
      ])
        ..gate = gate;
      await _mount(tester, src, en);
      await tester.tap(find.text(en.pendingRecoveryRetryNow));
      await tester.pump();

      expect(
          find.byKey(const ValueKey<String>(
              'pendingRecovery.retrying.run-1757000000000000-r1757000000000')),
          findsOneWidget);
      expect(find.text(en.pendingRecoveryRetrying), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text(en.pendingRecoveryRetryNow), findsNothing,
          reason: 'setup: the attempt really is in flight');

      gate.complete();
      await tester.pumpAndSettle();
      expect(find.text(en.pendingRecoveryRetrying), findsNothing,
          reason: 'and it goes when the attempt does — a spinner that stays is '
              'the frozen screen the runner catches its throws for');
    });
  });

  group('no link: the button is not drawn, and the reason is on screen', () {
    testWidgets('🔴 with no connection there is nothing to press',
        (WidgetTester tester) async {
      // Before this, the button was drawn, the press ran into
      // `beginBackfill`'s first false exit, and the screen answered 「a
      // recording is running. Try again once it ends.」 — to a phone whose
      // microphone was closed (MEASURED 2026-09-12, WiFi and data off).
      final _Source src = _Source(<PendingRecoveryItem>[
        _item(PendingRecoveryState.needsManual),
      ])
        ..blocker = PendingRetryBlocker.noLink;
      await _mount(tester, src, en);

      expect(find.text(en.pendingRecoveryRetryNow), findsNothing);
      expect(find.text(en.pendingRecoveryRetryNeedsLink), findsOneWidget);
      expect(find.text(en.pendingRecoveryRetryBusy), findsNothing,
          reason: 'the sentence that was being said to these people, and it '
              'was about somebody else');
      expect(find.text(en.confirmDelete), findsOneWidget,
          reason: 'a delete needs no link at all');
    });

    testWidgets('a recording in progress explains itself and needs no line',
        (WidgetTester tester) async {
      final _Source src = _Source(<PendingRecoveryItem>[
        _item(PendingRecoveryState.needsManual),
      ])
        ..blocker = PendingRetryBlocker.recording;
      await _mount(tester, src, en);

      expect(find.text(en.pendingRecoveryRetryNow), findsNothing);
      expect(find.text(en.pendingRecoveryRetryNeedsLink), findsNothing,
          reason: 'the link is fine; saying it is not would send somebody to '
              'fix something that is not broken');
    });

    testWidgets(
        '🔴 THE CONTROL: no link, but nothing here could be retried anyway',
        (WidgetTester tester) async {
      // 「Connect first」 is only true about a recording a connection would
      // help. On a page of cancelled audio it would be an instruction that
      // changes nothing.
      final _Source src = _Source(<PendingRecoveryItem>[
        _item(PendingRecoveryState.cancelled),
      ])
        ..blocker = PendingRetryBlocker.noLink;
      await _mount(tester, src, en);

      expect(find.text(en.pendingRecoveryRetryNeedsLink), findsNothing);
      expect(find.text(en.confirmDelete), findsOneWidget);
    });

    testWidgets('and the race — the link drops between the draw and the press',
        (WidgetTester tester) async {
      final _Source src = _Source(<PendingRecoveryItem>[
        _item(PendingRecoveryState.needsManual),
      ])
        ..retryAnswer = PendingRetryOutcome.refusedNoLink;
      await _mount(tester, src, en);
      await tester.tap(find.text(en.pendingRecoveryRetryNow));
      await tester.pumpAndSettle();

      expect(find.text(en.pendingRecoveryRetryNeedsLink), findsOneWidget);
      expect(find.text(en.pendingRecoveryRetryBusy), findsNothing);
    });
  });

  group('the list says how many, and what they are waiting for', () {
    testWidgets('🔴 a screen holding only kept audio does not say 「waiting」',
        (WidgetTester tester) async {
      final _Source src = _Source(<PendingRecoveryItem>[
        _item(PendingRecoveryState.emptyConfirmed, id: 'run-1-r1757000000001'),
        _item(PendingRecoveryState.cancelled, id: 'run-2-r1757000000002'),
      ]);
      await _mount(tester, src, en);

      expect(find.text(en.pendingRecoveryTitleKept), findsOneWidget);
      expect(find.text(en.pendingRecoveryTitle), findsNothing,
          reason: 'Book 15 §2.0-b: 「waiting」 may only be said where something '
              'is going to happen, and nothing here is');
    });

    testWidgets('and it keeps the ordinary name while anything IS waiting',
        (WidgetTester tester) async {
      final _Source src = _Source(<PendingRecoveryItem>[
        _item(PendingRecoveryState.emptyConfirmed, id: 'run-1-r1757000000001'),
        _item(PendingRecoveryState.needsManual, id: 'run-2-r1757000000002'),
      ]);
      await _mount(tester, src, en);
      expect(find.text(en.pendingRecoveryTitle), findsOneWidget);
    });

    testWidgets('🔴 the door counts what is waiting', (WidgetTester tester) async {
      final _Source src = _Source(<PendingRecoveryItem>[
        _item(PendingRecoveryState.needsManual, id: 'run-1-r1757000000001'),
        _item(PendingRecoveryState.waitingAuto, id: 'run-2-r1757000000002'),
        _item(PendingRecoveryState.cancelled, id: 'run-3-r1757000000003'),
      ]);
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: PendingRecoveryEntry(source: src, strings: en)),
      ));
      await tester.pumpAndSettle();

      expect(find.text(en.pendingRecoveryEntryWaiting(2)), findsOneWidget,
          reason: 'two of the three are owed an attempt; the cancelled one is '
              'not, and counting it would be a promise about it');
    });

    testWidgets('🔴 and stops promising when none of them is',
        (WidgetTester tester) async {
      final _Source src = _Source(<PendingRecoveryItem>[
        _item(PendingRecoveryState.emptyConfirmed, id: 'run-1-r1757000000001'),
      ]);
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: PendingRecoveryEntry(source: src, strings: en)),
      ));
      await tester.pumpAndSettle();

      expect(find.text(en.pendingRecoveryEntryKept(1)), findsOneWidget);
      expect(find.text(en.pendingRecoveryEntryWaiting(1)), findsNothing);
    });

    testWidgets('the door is still absent with nothing behind it',
        (WidgetTester tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: PendingRecoveryEntry(
            source: _Source(const <PendingRecoveryItem>[]),
            strings: en,
          ),
        ),
      ));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('pendingRecovery.entry')), findsNothing);
    });
  });
}
