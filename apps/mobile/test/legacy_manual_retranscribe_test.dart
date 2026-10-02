// NR-138 ④ — A LEGACY RECORDING WHOSE AUTOMATIC ROUTE STOPPED IS STILL THE
// USER'S: Re-transcribe (this recording only) and Delete.
//
// Through the production controller and the production `PendingRecoveryStore`
// (the object the screen is handed in production), and — anti-façade ⑥ — the
// real `PendingRecoveryPage` mounted over them, because the deliverable is what
// that screen offers.
//
// REVERSE CONTROLS (run 2026-10-01, red on this file, then restored green):
//   · the legacy arm restored in `PendingRecoveryItem.actions` (delete only)
//     ⇒ the list and widget cases red (no retry offered; no retry key found);
//   · the legacy arm restored in `PendingRecoveryStore.retryNow` (answer
//     `unavailable`) ⇒ all five red (nothing on the wire);
//   · (round 2, review B2, billing) the capability gate removed from the send
//     point `_replayOne` ⇒ the review probe red (`Expected: refusedServer
//     Actual: done`: the second segment's metered start went out);
//   · the stopped state mapped back to 「waiting」 in `_legacyStateIn` ⇒ four
//     red, the widget case on the rendered sentence (`Actual: 'Waiting for
//     the next automatic attempt'`).

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/pending_recovery_store.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/pending_recovery_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/legacy_backfill_rig.dart';

const LegacyRetryRecord kStopped =
    LegacyRetryRecord(starts: 5, failedStarts: 5);


Future<PendingRecoveryItem> itemOf(LegacyRig rig, String key) async =>
    (await rig.pending.list()).singleWhere((PendingRecoveryItem i) => i.id == key);

void main() {
  test('🔴 a stopped legacy recording offers Re-transcribe; the press feeds '
      'that recording only, delivers nothing, and settles it', () async {
    final LegacyRig rig = await LegacyRig.open();
    addTearDown(rig.dispose);
    await rig.seed('run-m');
    await rig.seed('run-n');
    expect(await rig.store.writeLegacyRetry('run-m', kStopped), isTrue);
    // run-n is waiting, an hour from its next automatic start.
    expect(await rig.store.writeLegacyRetry('run-n', LegacyRetryRecord(
        starts: 1, failedStarts: 1, nextEligibleAtMs: rig.nowMs + 3600000)), isTrue);

    final PendingRecoveryItem m = await itemOf(rig, 'run-m');
    expect(m.state, PendingRecoveryState.needsManual);
    expect(m.actions, <PendingRecoveryAction>{
      PendingRecoveryAction.retryNow,
      PendingRecoveryAction.delete,
    });
    expect((await itemOf(rig, 'run-n')).actions,
        contains(PendingRecoveryAction.retryNow),
        reason: 'a waiting legacy recording gets the journal table too');

    rig.relay.replyWords('Manual words');
    expect(await rig.pending.retryNow(m), PendingRetryOutcome.done);
    await rig.idle();

    expect(rig.relay.starts, hasLength(1), reason: 'run-m only');
    expect(rig.relay.starts.single['delivery'], 'none');
    expect(rig.relay.emittedNames, isNot(contains(FlowMicEvents.injectRequest)),
        reason: 'recovered words are never sent to a PC (deferred-delivery '
            'red line)');
    final TimelineEntry row = rig.timeline.entries
        .singleWhere((TimelineEntry e) => e.displayText == 'Manual words');
    expect(row.delivery, Delivery.none);
    expect(await rig.store.bytesForSession('run-m'), 0);
    expect(rig.budgetFile('run-m').existsSync(), isFalse,
        reason: 'no audio left ⇒ no record left');
    expect(await rig.store.bytesForSession('run-n'), 6400,
        reason: 'a press on one card never transcribes another recording');
    expect((await rig.pending.list()).map((PendingRecoveryItem i) => i.id),
        <String>['run-n']);
  });

  test('🔴 a press never resets or moves the automatic budget', () async {
    final LegacyRig rig = await LegacyRig.open();
    addTearDown(rig.dispose);
    await rig.seed('run-p');
    final LegacyRetryRecord waiting = LegacyRetryRecord(
        starts: 2, failedStarts: 2, nextEligibleAtMs: rig.nowMs + 600000);
    expect(await rig.store.writeLegacyRetry('run-p', waiting), isTrue);
    rig.relay.stallEveryStart = true;

    expect(await rig.pending.retryNow(await itemOf(rig, 'run-p')),
        PendingRetryOutcome.failed);
    expect(rig.relay.starts, hasLength(1),
        reason: 'positive control: the press reached the wire');
    final LegacyRetryRecord after =
        (await rig.store.readLegacyRetry('run-p')).record!;
    expect(after.starts, 2, reason: 'a press is not an automatic start');
    expect(after.failedStarts, 2);
    expect(after.nextEligibleAtMs, waiting.nextEligibleAtMs);
    expect(after.reservedAtMs, isNull);

    // And a stopped one stays stopped for the automatic route.
    expect(await rig.store.writeLegacyRetry('run-p', kStopped), isTrue);
    expect(await rig.pending.retryNow(await itemOf(rig, 'run-p')),
        PendingRetryOutcome.failed);
    rig.relay.stallEveryStart = false;
    rig.nowMs += const Duration(days: 1).inMilliseconds;
    await rig.sweep();
    expect(rig.relay.starts, hasLength(2), reason: 'two presses, zero automatic');
    expect((await itemOf(rig, 'run-p')).state, PendingRecoveryState.needsManual);
    expect(await rig.store.bytesForSession('run-p'), 6400);
  });

  test('NR-137 hook: a press replays untouched segments, never the ones kept '
      'unverified', () async {
    final LegacyRig rig = await LegacyRig.open();
    addTearDown(rig.dispose);
    await rig.seed('run-q', idx: 0);
    await rig.seed('run-q', idx: 1);
    expect(await rig.store.markUnverified(0, session: 'run-q'), isTrue);
    expect(await rig.store.writeLegacyRetry('run-q', kStopped), isTrue);
    expect((await itemOf(rig, 'run-q')).state, PendingRecoveryState.needsManual,
        reason: 'untouched audio decides the row, not the kept segment');

    rig.relay.replyWords('Second segment');
    expect(await rig.pending.retryNow(await itemOf(rig, 'run-q')),
        PendingRetryOutcome.done);
    expect(rig.relay.starts, hasLength(1));
    expect(await rig.store.read(1, session: 'run-q'), isNull);
    expect(await rig.store.read(0, session: 'run-q'), isNotNull);
    final PendingRecoveryItem left = await itemOf(rig, 'run-q');
    expect(left.state, PendingRecoveryState.settledUnverified);
    // ⚠️ 更正（NR-137 round 2, MAIN 2026-10-02）: was `{delete}`. Only kept
    // audio left now offers the kept-words press (a new note,
    // backfill_legacy_kept.dart); this press still did not replay segment 0.
    expect(left.actions, <PendingRecoveryAction>{
      PendingRecoveryAction.retryNow,
      PendingRecoveryAction.delete,
    });
    expect(left.retranscribeAsNote, isTrue);
  });

  // Round 2 — the independent review's probe (B2), kept in shape: the relay's
  // acknowledgment changes to 「no capabilities」 as the first segment's row
  // is written. Round 1 checked the gate once per press and sent the second
  // segment anyway (2 starts). *** billing ***
  test('🔴 REVIEW every manual segment rechecks capability before sending',
      () async {
    final GateChangePersistence persistence = GateChangePersistence();
    final LegacyRig r = await LegacyRig.open(persistence: persistence);
    addTearDown(r.dispose);
    await r.seed('run-gate', idx: 0);
    await r.seed('run-gate', idx: 1);
    await r.store.writeLegacyRetry('run-gate', kStopped);
    persistence.change = () => r.session.reconnect
        .noteServerCapabilities(<String, Object?>{'capabilities': <String>[]});
    r.relay.replyWords('First segment');
    r.relay.replyWords('Second segment');
    expect(await r.pending.retryNow((await r.pending.list()).single),
        PendingRetryOutcome.refusedServer);
    expect(r.relay.starts, hasLength(1),
        reason: 'after the relay capability changes to unsupported no second '
            'metered start may leave');
    expect(await r.store.pendingSegments(session: 'run-gate'), <int>[1],
        reason: 'the second segment stays on the phone');
  });

  test('the press is refused, and says why, when nothing may be sent', () async {
    final LegacyRig rig = await LegacyRig.open();
    addTearDown(rig.dispose);
    await rig.seed('run-r');
    expect(await rig.store.writeLegacyRetry('run-r', kStopped), isTrue);
    final PendingRecoveryItem r = await itemOf(rig, 'run-r');

    rig.session.fsm.onPttDown();
    expect(await rig.pending.retryNow(r), PendingRetryOutcome.refusedBusy);
    rig.session.fsm.onPttCancel();
    await rig.idle();
    rig.relay.pushStatus(SocketStatus.disconnected);
    await rig.idle();
    expect(await rig.pending.retryNow(r), PendingRetryOutcome.refusedNoLink);
    expect(rig.relay.starts, isEmpty);
    expect(await rig.store.bytesForSession('run-r'), 6400);
  });

  testWidgets(
      '🔴 the pending-recovery page shows the stopped sentence with a working '
      'Re-transcribe for a legacy recording', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
    final AppStrings en = AppStrings(AppLocale.en);
    late LegacyRig rig;
    await tester.runAsync(() async {
      rig = await LegacyRig.open();
      await rig.seed('run-1757000000000000');
      await rig.store.writeLegacyRetry('run-1757000000000000', kStopped);
    });
    const String id = 'run-1757000000000000';
    final Finder retry = find.byKey(const ValueKey<String>('pendingRecovery.retry.$id'));
    final Finder sentence =
        find.byKey(const ValueKey<String>('pendingRecovery.sentence.$id'));

    await tester.runAsync(() async {
      await tester.pumpWidget(MaterialApp(
        home: PendingRecoveryPage(
          source: PendingRecoveryStore(runner: rig.runner, sourceLang: () => 'en'),
          strings: en,
        ),
      ));
      await Future<void>.delayed(const Duration(milliseconds: 300));
    });
    await tester.pump();
    expect(tester.widget<Text>(sentence).data, en.pendingRecoveryStateNeedsManual);
    expect(retry, findsOneWidget);

    rig.relay.replyWords('Pressed words');
    // Tapped INSIDE `runAsync`: the press starts real file I/O (the runner
    // reads the segment), and I/O started in the fake-async zone never ends.
    await tester.runAsync(() async {
      await tester.tap(retry);
      final DateTime deadline = DateTime.now().add(const Duration(seconds: 10));
      while (rig.relay.starts.isEmpty && DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
      await rig.idle();
      await Future<void>.delayed(const Duration(milliseconds: 300));
    });
    await tester.pump();
    expect(rig.relay.starts, hasLength(1),
        reason: 'the button reached the wire, for this recording');
    expect(find.byKey(const ValueKey<String>('pendingRecovery.card.$id')),
        findsNothing, reason: 'transcribed and settled: the card is gone');

    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(rig.dispose);
  });
}
