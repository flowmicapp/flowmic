// NR-137 — A RETAINED `settled_unverified` LONG RECORDING CAN BE RE-TRANSCRIBED
// FROM THE PENDING PAGE, AND THE PRESS REPLACES ITS WORDS RATHER THAN ADDING A
// SECOND COPY OF THEM.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a, the NR-137 correction (2026-10-02)
//   _dispatch/2026-10-02-nr137-design.md
//
// The real chain (`PttSession` → `ChatController` → `BackfillRunner` →
// `RecoveryJournalLeg`, support/rc3_rig.dart) against a fake relay, and —
// anti-façade ⑥ — the real `PendingRecoveryPage` over the production
// `PendingRecoveryStore`, because what that screen offers is the deliverable.
//
// HOW THE RECORDING GETS THERE: a long recording with two live rows, stopped;
// the relay's terminal final is empty and its receipt says the session did not
// end normally ⇒ the live settle keeps the audio as `settled_unverified`
// (live_settle.dart: words exist, completeness unproven).
//
// REVERSE CONTROLS (run 2026-10-02 on this file only, each one production line,
// red, restored byte-for-byte by sha256, re-run green):
//   · replacement widening removed (`_finishVerdict` back to shortfall only)
//     ⇒ success red: rows [First half…, The whole meeting…, Second half…];
//   · placement pin removed (`_attempt` persistedStartMs) ⇒ success red: the
//     new row filed AFTER the kept ones [First…, Second…, The whole…];
//   · same-recording join removed (`BackfillRunner.retranscribe`) ⇒ double
//     press red: 2 recovery starts;
//   · `keptWordsReplaceable` dropped from `itemOf` ⇒ boundary red:
//     retranscribable Actual <true> on an ordinary press;
//   · empty-answer rule disabled (`_keptWordsNoWordsBack`) ⇒ empty-answer red:
//     the card said 「Nothing was recognised here, even after trying again…」
//     about a recording whose words are on the page.
// ROUND 2 (MAIN 2026-10-02), same procedure:
//   · the note fold disabled (`_keptWordsResult` returns the rows as they
//     are) ⇒ ordinary-press red: notes `has length of <0>`;
//   · the legacy kept path disabled (`_retranscribeLegacy` answers
//     `unavailable`) ⇒ legacy red: `Actual: unavailable`;
//   · the minutes line no longer gated on a metered channel ⇒ red on LAN:
//     `pressUsesMinutes` Actual <true>;
//   · tier C no longer withholds the press ⇒ red: actions {retryNow, delete};
//   · the row mark removed from the tile ⇒ both mark cases red (0 widgets
//     with key `entry.retranscribedMarker.…`).
//
// ⚠️ Under `tester.runAsync`, like every Rc3Rig case: the production chain
// awaits real timers.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/pending_recovery_store.dart';
import 'package:flowmic/src/session/instance_probe.dart' show ServerChannel;
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/pending_recovery_page.dart';
import 'package:flowmic/src/ui/recovery_status_sentence.dart';
import 'package:flowmic/src/ui/time_label.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/legacy_backfill_rig.dart';
import 'support/rc3_rig.dart';

final AppStrings _en = AppStrings(AppLocale.en);

const String _a = 'First half of the meeting notes.';
const String _b = 'Second half of the meeting notes.';
const String _again = 'The whole meeting, transcribed again.';
const int _totalMs = 4000;

/// How the relay answers a recovery `audio:start` in one case.
typedef _Answer = void Function(Rc3Rig r, Rc3Stop stop);

void _words(Rc3Rig r, Rc3Stop stop) => Future<void>.delayed(
    const Duration(milliseconds: 20),
    () => r.relay.pushIncoming(FlowMicEvents.sttFinal,
        r.relay.terminal(stop, text: _again, durationMs: _totalMs)));

void _empty(Rc3Rig r, Rc3Stop stop) => Future<void>.delayed(
    const Duration(milliseconds: 20),
    () => r.relay.pushIncoming(FlowMicEvents.sttFinal,
        r.relay.terminal(stop, text: '', durationMs: 0)));

void _stall(Rc3Rig r, Rc3Stop stop) => Future<void>.delayed(
    const Duration(milliseconds: 20),
    () => r.relay.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
          'code': 'STT_ENGINE_TIMEOUT',
          'message': 'the engine did not answer',
          'retryable': false,
        }));

/// A long recording whose live settle kept it `settled_unverified`, two rows
/// on the page. [answer] is how the relay answers each later recovery start.
Future<Rc3Rig> _unverifiedArticle(_Answer answer) async {
  final Rc3Rig r = await Rc3Rig.open();
  r.relay.onStop = (Rc3Stop stop) {
    if (stop.recovery) return answer(r, stop);
    Future<void>.delayed(const Duration(milliseconds: 20), () {
      r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
          text: '', durationMs: 0, segmentIdx: 2, endedNormally: false));
    });
  };
  await r.begin();
  await r.feedMs(_totalMs);
  await r.segment(_a, 0, 2000);
  await r.segment(_b, 1, 2000);
  await r.controller.pttUp();
  await r.untilAsync(() async =>
      (await r.manifest())?.recoveryState ==
      RecoveryQueueState.settledUnverified);
  return r;
}

PendingRecoveryStore _source(Rc3Rig r) =>
    PendingRecoveryStore(runner: r.controller.backfill, sourceLang: () => 'zh');

Future<PendingRecoveryItem> _only(Rc3Rig r) async =>
    (await _source(r).list()).single;

List<String> _texts(Rc3Rig r) =>
    r.rows.map((TimelineEntry e) => e.displayText).toList();

Future<void> _mountPage(WidgetTester tester, Rc3Rig r) async {
  // Wide on purpose: the two NR-137 strings are DEV placeholders
  // (`'DEV: <key> pending-copy …'`), far longer than the copy that will
  // replace them, and the button row is a fixed Row. Whether the final copy
  // fits at 360 dp is the copy job's check (copy-context page), not this file's.
  tester.view.physicalSize = const Size(1600, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.runAsync(() async {
    await tester.pumpWidget(MaterialApp(
      home: PendingRecoveryPage(source: _source(r), strings: _en),
    ));
    await Future<void>.delayed(const Duration(milliseconds: 300));
  });
  await tester.pump();
}

/// Tap [finder] inside `runAsync` (the press starts real I/O), wait until
/// [starts] recovery starts were seen and the runner is idle again, then pump
/// until [shown] holds — a condition, not a fixed delay: under the full suite's
/// load the page's re-read of its list lands well after any fixed pause.
Future<void> _tapAndSettle(WidgetTester tester, Rc3Rig r, Finder finder,
    int starts, {required bool Function() shown}) async {
  await tester.runAsync(() async {
    await tester.tap(finder);
    await r.recoveries(starts, max: const Duration(seconds: 30));
  });
  final DateTime deadline = DateTime.now().add(const Duration(seconds: 30));
  while (true) {
    await tester.pump();
    if (shown() || DateTime.now().isAfter(deadline)) break;
    await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)));
  }
}

void main() {
  testWidgets(
      '🔴 success on the real page: one metered user_retranscribe, delivered '
      'nowhere, the two earlier rows REPLACED by the new words at the same '
      'place — one set of words — and the recording settles', (
    WidgetTester tester,
  ) async {
    late final Rc3Rig r;
    await tester.runAsync(() async => r = await _unverifiedArticle(_words));
    addTearDown(() => tester.runAsync(r.dispose));
    expect(_texts(r), <String>[_a, _b],
        reason: 'positive control: the kept words are on the page');
    final String id = (await tester.runAsync<RecordingManifest?>(r.manifest))!.recordingId;
    final PendingRecoveryItem before = (await tester.runAsync(() => _only(r)))!;
    expect(before.state, PendingRecoveryState.settledUnverified);
    expect(before.actions, <PendingRecoveryAction>{
      PendingRecoveryAction.retryNow,
      PendingRecoveryAction.delete,
    });

    await _mountPage(tester, r);
    final Finder retry =
        find.byKey(ValueKey<String>('pendingRecovery.retry.$id'));
    expect(retry, findsOneWidget, reason: 'the card offers the press');
    expect(
        tester
            .widget<Text>(
                find.byKey(ValueKey<String>('pendingRecovery.sentence.$id')))
            .data,
        _en.pendingRecoveryStateUnverifiedRetranscribe,
        reason: 'the sentence says what the press does');
    expect(find.descendant(of: retry, matching: find.text(_en.pendingRecoveryRetranscribe)),
        findsOneWidget, reason: 're-transcribe, not 「try again」');
    expect(
        tester
            .widget<Text>(
                find.byKey(ValueKey<String>('pendingRecovery.usesMinutes.$id')))
            .data,
        _en.pendingRecoveryRetranscribeUsesMinutes,
        reason: 'owner billing transparency: the press uses minutes again');
    await _tapAndSettle(tester, r, retry, 1,
        shown: () => find
            .byKey(ValueKey<String>('pendingRecovery.card.$id'))
            .evaluate()
            .isEmpty);
    await tester.runAsync(
        () => r.until(() => !_texts(r).contains(_a) && !_texts(r).contains(_b)));

    final Map<String, Object?> start = r.relay.recoveryStarts.single;
    expect(start['attempt_kind'], 'user_retranscribe');
    expect(start['delivery'], 'none');
    expect(start['range_start_sample'], 0, reason: 'the whole recording');
    expect(r.relay.emittedNames, isNot(contains(FlowMicEvents.injectRequest)),
        reason: 'deferred-delivery red line: nothing goes to a PC');
    expect(_texts(r), <String>[_again],
        reason: 'one set of words: the earlier rows are replaced, not kept '
            'beside the new ones');
    expect(r.rows.single.articleOffsetMs, 0,
        reason: 'where the earlier words were, not after them');
    expect(r.rows.single.delivery, Delivery.none);
    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.settled, isTrue);
    expect(r.pcmPresent, isFalse, reason: 'proven ⇒ the audio goes (O-1)');
    expect(find.byKey(ValueKey<String>('pendingRecovery.card.$id')),
        findsNothing, reason: 'settled: the card is gone');
  });

  testWidgets(
      '🔴 an empty answer on the real page: the card keeps its sentence (never '
      '「no words」), the earlier rows stay, the audio stays', (
    WidgetTester tester,
  ) async {
    late final Rc3Rig r;
    await tester.runAsync(() async => r = await _unverifiedArticle(_empty));
    addTearDown(() => tester.runAsync(r.dispose));
    final String id = (await tester.runAsync<RecordingManifest?>(r.manifest))!.recordingId;
    await _mountPage(tester, r);
    final Finder sentence =
        find.byKey(ValueKey<String>('pendingRecovery.sentence.$id'));
    final String? sentenceBefore = tester.widget<Text>(sentence).data;

    await _tapAndSettle(tester, r,
        find.byKey(ValueKey<String>('pendingRecovery.retry.$id')), 1,
        shown: () =>
            find.byKey(const Key('pendingRecovery.notice')).evaluate().isNotEmpty);

    expect(r.relay.recoveryStarts, hasLength(1),
        reason: 'positive control: the press reached the wire');
    expect(tester.widget<Text>(sentence).data, sentenceBefore,
        reason: 'the words are still on the page; 「no words」 would be false');
    expect(tester.widget<Text>(sentence).data,
        isNot(anyOf(_en.pendingRecoveryStateEmptyResult,
            _en.pendingRecoveryStateEmptyConfirmed)));
    expect(
        tester
            .widget<Text>(find.descendant(
                of: find.byKey(const Key('pendingRecovery.notice')),
                matching: find.byType(Text)))
            .data,
        _en.pendingRecoveryRetryKept);
    expect(_texts(r), <String>[_a, _b], reason: 'nothing replaced');
    expect(r.pcmPresent, isTrue, reason: 'the audio stays');
    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.recoveryState, RecoveryQueueState.settledUnverified);
    expect(m.attempts.last.kind, 'user_retranscribe');
    expect(m.attempts.last.outcome, JournalAttempt.outcomeFailed);
    expect(m.attempts.last.failureCode, startsWith('keptWordsNoWords:'));
    final PendingRecoveryItem after = (await tester.runAsync(() => _only(r)))!;
    expect(after.state, PendingRecoveryState.settledUnverified);
    expect(after.actions, contains(PendingRecoveryAction.retryNow),
        reason: 'the person may press again');
  });

  test('🔴 a failed press (engine stall): truthful state, the earlier rows and '
      'the audio stay, no automatic route opens', () async {
    final Rc3Rig r = await _unverifiedArticle(_stall);
    addTearDown(r.dispose);
    final PendingRecoveryItem item = await _only(r);

    final PendingRetryOutcome out = await _source(r).retryNow(item);
    await r.recoveries(1);
    expect(r.relay.recoveryStarts, hasLength(1));
    expect(out, isNot(PendingRetryOutcome.unavailable));
    expect(_texts(r), <String>[_a, _b]);
    expect(r.pcmPresent, isTrue);
    final RecordingManifest m = (await r.manifest())!;
    expect(m.recoveryState, RecoveryQueueState.settledUnverified,
        reason: 'a user press moves no queue state');
    expect(m.nextEligibleAtMs, isNull, reason: 'and arms no backoff');
    expect(m.attempts.last.outcome, JournalAttempt.outcomeFailed);
    // Never automatic, before or after the press.
    await r.controller.backfill.sweep(sourceLang: 'zh');
    await r.recoveries(1);
    expect(r.relay.recoveryStarts, hasLength(1));
    expect((await _only(r)).state, PendingRecoveryState.settledUnverified);
  });

  test('🔴 a double press starts ONE attempt (one charge)', () async {
    final Rc3Rig r = await _unverifiedArticle(_empty);
    addTearDown(r.dispose);
    final PendingRecoveryItem item = await _only(r);
    final PendingRecoveryStore source = _source(r);

    final List<PendingRetryOutcome> both = await Future.wait(
        <Future<PendingRetryOutcome>>[source.retryNow(item), source.retryNow(item)]);
    await r.recoveries(1);
    await Future<void>.delayed(const Duration(milliseconds: 300));

    expect(r.relay.recoveryStarts, hasLength(1),
        reason: 'the second press joins the first; the empty answer left the '
            'card in place, so a queued second press would have been billed');
    expect(both[0], both[1]);
  });

  test('🔴 billing identity: each press is its own metered operation, '
      'user_retranscribe, delivery none, the whole recording', () async {
    final Rc3Rig r = await _unverifiedArticle(_empty);
    addTearDown(r.dispose);
    final PendingRecoveryStore source = _source(r);

    await source.retryNow(await _only(r));
    await r.recoveries(1);
    await source.retryNow(await _only(r));
    await r.recoveries(2);

    final List<Map<String, Object?>> s = r.relay.recoveryStarts;
    expect(s, hasLength(2));
    for (final Map<String, Object?> f in s) {
      expect(f['attempt_kind'], 'user_retranscribe');
      expect(f['delivery'], 'none');
      expect(f['operation_id'], isA<String>());
      expect(f['range_start_sample'], 0);
      expect(f['range_end_sample'], _totalMs * 16);
    }
    expect(s[0]['operation_id'], isNot(s[1]['operation_id']),
        reason: 'O-4: a press is metered as a new attempt every time');
    expect(s[0]['attempt_id'], isNot(s[1]['attempt_id']));
  });

  testWidgets(
      '🔴 round 2: an ordinary press that went to the PC, kept unverified ⇒ '
      'Re-transcribe makes ONE new record-only note marked as a '
      're-transcription; the sent row is untouched; no PC frame', (
    WidgetTester tester,
  ) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await Rc3Rig.open(fixedRecordOnly: false);
      r.relay.onStop = (Rc3Stop stop) {
        if (stop.recovery) return _words(r, stop);
        Future<void>.delayed(const Duration(milliseconds: 20), () {
          r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
              text: _a, durationMs: 2000, endedNormally: false));
        });
      };
      await r.controller.pttDown();
      await r.feedMs(2000);
      await r.controller.pttUp();
      await r.untilAsync(() async =>
          (await r.manifest())?.recoveryState ==
          RecoveryQueueState.settledUnverified);
      await r.until(() =>
          r.relay.emittedNames.contains(FlowMicEvents.injectRequest));
    });
    addTearDown(() => tester.runAsync(r.dispose));
    final TimelineEntry sent =
        r.timeline.entries.singleWhere((TimelineEntry e) => e.displayText == _a);
    final int injectsBefore = r.relay.emittedNames
        .where((String n) => n == FlowMicEvents.injectRequest)
        .length;
    expect(injectsBefore, 1,
        reason: 'positive control: the press went to the PC');
    expect(sent.delivery, isNot(Delivery.none));
    final String id =
        (await tester.runAsync<RecordingManifest?>(r.manifest))!.recordingId;
    final int rowsBefore = r.timeline.entries.length;

    await _mountPage(tester, r);
    expect(
        tester
            .widget<Text>(
                find.byKey(ValueKey<String>('pendingRecovery.sentence.$id')))
            .data,
        _en.pendingRecoveryStateUnverifiedRetranscribeNote,
        reason: 'the card says the press adds a note and leaves the sent text');
    expect(
        tester
            .widget<Text>(
                find.byKey(ValueKey<String>('pendingRecovery.usesMinutes.$id')))
            .data,
        _en.pendingRecoveryRetranscribeUsesMinutes);
    await _tapAndSettle(tester, r,
        find.byKey(ValueKey<String>('pendingRecovery.retry.$id')), 1,
        shown: () => find
            .byKey(ValueKey<String>('pendingRecovery.card.$id'))
            .evaluate()
            .isEmpty);
    await tester.runAsync(() => r.until(() => !r.timeline.entries.any(
        (TimelineEntry e) =>
            e.displayText == _again && e.retranscribedFrom == null)));

    expect(r.relay.recoveryStarts.single['delivery'], 'none');
    expect(
        r.relay.emittedNames
            .where((String n) => n == FlowMicEvents.injectRequest)
            .length,
        injectsBefore,
        reason: 'no PC frame for the re-transcription');
    final TimelineEntry after =
        r.timeline.entries.singleWhere((TimelineEntry e) => e.id == sent.id);
    expect(
        <Object?>[after.displayText, after.delivery, after.status, after.updatedAt],
        <Object?>[sent.displayText, sent.delivery, sent.status, sent.updatedAt],
        reason: 'the row that went to the PC is exactly as it was');
    final List<TimelineEntry> notes = r.timeline.entries
        .where((TimelineEntry e) => e.retranscribedFrom != null)
        .toList();
    expect(notes, hasLength(1), reason: 'exactly one new row');
    expect(r.timeline.entries.length, rowsBefore + 1,
        reason: 'one new row, nothing else added or removed');
    final TimelineEntry note = notes.single;
    expect(note.retranscribedFrom, id);
    expect(note.displayText, _again);
    expect(note.delivery, Delivery.none);
    expect(note.origin, 'cloud', reason: 'a record-only note (light record)');
    expect(note.articleId, isNull);
    expect((await tester.runAsync<RecordingManifest?>(r.manifest))!.settled,
        isTrue);
    // The screen the note is read on (anti-façade ⑥): it carries the mark.
    tester.view.physicalSize = const Size(1600, 2400);
    await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: r.controller)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(ValueKey<String>('entry.retranscribedMarker.${note.id}')),
        findsOneWidget,
        reason: 'the new note is marked as a re-transcription where it is read');
    expect(find.text(_a), findsOneWidget,
        reason: 'and the sent row is still on screen as it was');
  });

  testWidgets('🔴 round 2: the note is marked as a re-transcription on its row',
      (WidgetTester tester) async {
    final DateTime made = DateTime.utc(2026, 9, 30, 8, 15);
    final TimelineEntry note = TimelineEntry(
      id: 'loc-note',
      clientId: 'rt-a-1',
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      sourceText: _again,
      outputText: _again,
      status: EntryStatus.noted,
      origin: 'cloud',
      retranscribedFrom:
          'run-1790000000000000-r${made.microsecondsSinceEpoch}',
      createdAt: DateTime.utc(2026, 10, 2),
      updatedAt: DateTime.utc(2026, 10, 2),
    );
    await tester.pumpWidget(MaterialApp(
        home: Material(child: ChatMessageTile(
            queued: false, canResendImage: false, entry: note, strings: _en))));
    expect(
        tester
            .widget<Text>(find.byKey(
                const ValueKey<String>('entry.retranscribedMarker.loc-note')))
            .data,
        _en.retranscribedNoteMarker(timelineTimeLabel(made)));
  });

  test('🔴 round 2: a LEGACY recording kept unverified ⇒ one new note, the '
      'earlier row untouched, the kept segment released', () async {
    final LegacyRig rig = await LegacyRig.open();
    addTearDown(rig.dispose);
    const String key = 'run-1757000000000000';
    await rig.seed(key);
    expect(await rig.store.markUnverified(0, session: key), isTrue);
    final TimelineEntry earlier = rig.timeline.buildFromUtterance(
        clientId: 'earlier',
        mode: FlowMode.realtime,
        delivery: Delivery.none,
        text: _a,
        origin: 'cloud',
        mcpContentReady: true);
    final PendingRecoveryItem item = (await rig.pending.list())
        .singleWhere((PendingRecoveryItem i) => i.id == key);
    expect(item.state, PendingRecoveryState.settledUnverified);
    expect(item.retranscribable, isTrue);
    expect(item.retranscribeAsNote, isTrue);

    rig.relay.replyWords(_again);
    expect(await rig.pending.retryNow(item), PendingRetryOutcome.done);
    await rig.idle();
    expect(rig.relay.starts, hasLength(1));
    expect(rig.relay.starts.single['attempt_kind'], 'user_retranscribe');
    expect(rig.relay.starts.single['delivery'], 'none');
    expect(rig.relay.emittedNames, isNot(contains(FlowMicEvents.injectRequest)));
    expect(
        rig.timeline.entries
            .singleWhere((TimelineEntry e) => e.id == earlier.id)
            .displayText,
        _a);
    final TimelineEntry note = rig.timeline.entries
        .singleWhere((TimelineEntry e) => e.retranscribedFrom != null);
    expect(note.retranscribedFrom, key);
    expect(note.displayText, _again);
    expect(note.delivery, Delivery.none);
    expect(await rig.store.bytesForSession(key), 0);
    expect(await rig.pending.list(), isEmpty);
  });

  test('🔴 round 2: an unmetered channel has no 「minutes」 line; a server that '
      'cannot (tier C) gets no button and the tier-C sentence', () async {
    final Rc3Rig r = await _unverifiedArticle(_words);
    addTearDown(r.dispose);
    r.session.serverChannel.value = ServerChannel.lan;
    PendingRecoveryItem item = await _only(r);
    expect(item.retranscribable, isTrue);
    expect(item.pressUsesMinutes, isFalse,
        reason: 'on LAN no minutes are used; saying so would be untrue');
    r.session.serverChannel.value = null;
    expect((await _only(r)).pressUsesMinutes, isTrue,
        reason: 'not probed reads as metered (fail closed)');

    r.session.reconnect
        .noteServerCapabilities(<String, Object?>{'capabilities': <String>[]});
    await r.controller.backfill.sweep(sourceLang: 'zh');
    item = await _only(r);
    expect(item.actions, <PendingRecoveryAction>{PendingRecoveryAction.delete});
    expect(item.retranscribeBlockedByServer, isTrue);
    expect(
        recoveryStatusSentence(item.state, _en,
            otherAccount: item.otherAccount,
            retranscribable: item.retranscribable,
            asNote: item.retranscribeAsNote,
            blockedByServer: item.retranscribeBlockedByServer),
        _en.pendingRecoveryStateServerUnsupported);
  });

  test('🔴 round 2: kept words recorded under another account: no button, '
      'and the other-account sentence', () async {
    final Rc3Rig r = await Rc3Rig.open();
    addTearDown(r.dispose);
    String who = 'a@example.test';
    r.spill.recordingAccount.bind(() => who);
    r.relay.onStop = (Rc3Stop stop) {
      Future<void>.delayed(const Duration(milliseconds: 20), () {
        r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
            text: _a, durationMs: 2000, endedNormally: false));
      });
    };
    await r.controller.pttDown();
    await r.feedMs(2000);
    await r.controller.pttUp();
    await r.untilAsync(() async =>
        (await r.manifest())?.recoveryState ==
        RecoveryQueueState.settledUnverified);
    expect((await _only(r)).retranscribable, isTrue,
        reason: 'positive control: under its own account it is offered');
    who = 'b@example.test';
    final PendingRecoveryItem item = await _only(r);
    expect(item.actions, <PendingRecoveryAction>{PendingRecoveryAction.delete});
    expect(item.otherAccount, isTrue);
    expect(
        recoveryStatusSentence(item.state, _en,
            otherAccount: item.otherAccount),
        _en.pendingRecoveryOtherAccount);
  });
}
