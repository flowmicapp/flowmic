// 🔴 CARD RC-N (MAIN ruling 2, option B) — A LATE FRAME IS PLACED BY THE
// SESSION IT BELONGS TO. MOUNTED ON THE SCREEN THE RECORDING IS READ ON.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §3.3 / §4.2 / §8 RC-N /
//     §11-2
//   apps/mobile/lib/src/audio/recovery_attempt_ledger.dart
//   test/support/rc3_rig.dart (the rig)
//
// The recording is the RC-3b shape (article_engine_back_test.dart): 40 s row,
// the engine goes for 30 s, the relay re-feeds 12 s, the row spanning the
// outage (45 s on the relay's clock), 20 s more, stop — 1:45, with 44–64 s
// owed and recovered after the stop.
//
//   (a) S5: the live stop's final arrives AFTER a recovery opened its cursor.
//       It used to take the recovery's cursor — stretch start + what was
//       already placed there, an offset another row held (S5: 65,714). Now it
//       takes the live clock: 85,000, where it was said.
//   (b) S6: an attempt judged failed (its clocks ran out) gets its complete
//       result late, and no newer attempt covers the range ⇒ settled as if it
//       had come in time: one row, the recording settled, the bytes released.
//   (c) the same, but a newer attempt already covers the range ⇒ the late
//       result is dropped: one row, from the newer attempt.
//
// Reverse controls (logs in the card report): (a) the claim ignoring the
// session and `concludeReplay` leaving the cursor open ⇒ 60,000 (red);
// (b) no late-settle registration ⇒ not settled (red); (c) no supersede ⇒ a
// second copy of the recovered row (red).

import 'dart:async';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_leg_policy.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/entry_metrics.dart' show formatEntryDuration;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

const String _row0 = '先把上周的数字过一遍，然后看新的排期。';
const String _span = '这一行里有断线前后的话。';
const String _hole = '断线那段时间里说过的话。';
const String _last = '最后一段，散会前再确认一次。';
const int _totalMs = 105000; // 1:45

/// Short recovery clocks: a relay that stays silent after the feed fails the
/// attempt in about a second.
const RecoveryTimeouts _quick = RecoveryTimeouts(
  uploadProgress: Duration(seconds: 5),
  engineProgress: Duration(milliseconds: 700),
  noProgress: Duration(milliseconds: 1500),
  totalBudgetBase: Duration(seconds: 20),
  totalBudgetPerAudioMinute: Duration.zero,
);

Future<void> _recordHoleAndStop(Rc3Rig r) async {
  await r.begin();
  await r.feedMs(40000);
  await r.segment(_row0, 0, 40000);
  await r.feedMs(5000);
  await r.engine('reconnecting');
  await r.feedMs(30000);
  await r.engine('ready', replayedMs: 12000);
  await r.feedMs(10000);
  await r.segment(_span, 1, 45000);
  await r.feedMs(20000);
  await r.controller.pttUp();
}

void _liveFinal(Rc3Rig r, Rc3Stop stop, {Duration after = const Duration(milliseconds: 20)}) {
  Future<void>.delayed(after, () {
    r.relay.pushIncoming(FlowMicEvents.sttFinal,
        r.relay.terminal(stop, text: _last, durationMs: 20000, segmentIdx: 2));
  });
}

Map<String, Object?> _holeFinal(Rc3Rig r, Rc3Stop stop) =>
    r.relay.terminal(stop, text: _hole, durationMs: stop.toMs - stop.fromMs);

List<String> _meta(int parts) => <String>[
      for (final int s in <int>[_totalMs ~/ 1000 - 1, _totalMs ~/ 1000, _totalMs ~/ 1000 + 1])
        _zh.articleCardMeta(formatEntryDuration(s * 1000), parts),
    ];

Future<void> _attemptClosed(Rc3Rig r, String outcome) => r.untilLastAttempt(outcome);

void main() {
  testWidgets(
      '🔴 RC-N (a): the live stop\'s final lands while a recovery holds its '
      'cursor ⇒ it takes the LIVE clock (85 s), not the cursor (S5: an offset '
      'another row already held)', (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      // The phone's 15 s net, scaled: it gives up on the live stop at 300 ms,
      // and the recovery opens before the live final comes back at 1.5 s.
      r = await Rc3Rig.open(processingTimeout: const Duration(milliseconds: 300));
      r.relay.onStop = (Rc3Stop stop) {
        if (!stop.recovery) {
          _liveFinal(r, stop, after: const Duration(milliseconds: 1500));
          return;
        }
        Future<void>.delayed(const Duration(milliseconds: 20),
            () => r.relay.pushIncoming(FlowMicEvents.sttFinal, _holeFinal(r, stop)));
      };
      await _recordHoleAndStop(r);
      await r.recoveries(1);
      await r.until(() => r.rows.any((TimelineEntry e) => e.displayText == _last));
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, hasLength(1),
        reason: 'positive control: the recovery opened before the live final');
    expect(r.rows.map((TimelineEntry e) => e.displayText).toList(),
        <String>[_row0, _hole, _span, _last]);
    expect(r.rows.map((TimelineEntry e) => e.articleOffsetMs).toList(),
        <int>[0, 40000, 60000, 85000],
        reason: 'on the recovery\'s cursor it read 40,000 + 20,000 = 60,000');
    expect(r.rowsMs, _totalMs);

    await rc3MountAndOpen(tester, r);
    expect(_meta(4), contains(rc3TextOf(tester, const Key('article.meta'))));
    expect(find.textContaining(_last), findsOneWidget);
  });

  testWidgets(
      '🔴 RC-N (b): an attempt judged failed gets its complete result late, no '
      'newer attempt ⇒ settled: one row, the recording settled, the bytes gone',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    void Function()? release;
    await tester.runAsync(() async {
      r = await Rc3Rig.open(recoveryTimeouts: _quick);
      r.relay.onStop = (Rc3Stop stop) {
        if (!stop.recovery) return _liveFinal(r, stop);
        release = () => r.relay.pushIncoming(FlowMicEvents.sttFinal, _holeFinal(r, stop));
      };
      await _recordHoleAndStop(r);
      await r.recoveries(1);
      await _attemptClosed(r, JournalAttempt.outcomeFailed);
      expect((await r.manifest())!.attempts.last.outcome, JournalAttempt.outcomeFailed,
          reason: 'positive control: the attempt was judged failed first');
      expect(r.rows.where((TimelineEntry e) => e.displayText == _hole), isEmpty);
      release!();
      await _attemptClosed(r, JournalAttempt.outcomeSettled);
      await r.until(() => !r.controller.backfill.isBusy);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, hasLength(1), reason: 'no second transcription');
    expect(r.rows.where((TimelineEntry e) => e.displayText == _hole), hasLength(1));
    expect(r.rows.map((TimelineEntry e) => e.articleOffsetMs).toList(),
        <int>[0, 40000, 60000, 85000]);
    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    final String fed = r.relay.recoveryStarts.single['attempt_id']! as String;
    expect(
        m.attempts.singleWhere((JournalAttempt a) => a.attemptId == fed).outcome,
        JournalAttempt.outcomeSettled,
        reason: 'the failure is replaced by what actually happened');
    expect(m.settled, isTrue);
    expect(m.nextEligibleAtMs, isNull, reason: 'no retry is waiting any more');
    expect(r.pcmPresent, isFalse);

    await rc3MountAndOpen(tester, r);
    expect(_meta(4), contains(rc3TextOf(tester, const Key('article.meta'))));
    expect(find.textContaining(_hole), findsOneWidget);
    expect(find.byKey(const Key('article.backfill')), findsNothing);
  });

  testWidgets(
      '🔴 Codex rc3 ⑥: the complete result lands AFTER the wait ended but BEFORE '
      'the failure is written ⇒ it is still settled — no second attempt',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    void Function()? release;
    await tester.runAsync(() async {
      r = await Rc3Rig.open(recoveryTimeouts: _quick);
      r.relay.onStop = (Rc3Stop stop) {
        if (!stop.recovery) return _liveFinal(r, stop);
        // Hold the journal writes from here: the failure's commit waits.
        r.fs.gate = Completer<void>();
        release = () => r.relay.pushIncoming(FlowMicEvents.sttFinal, _holeFinal(r, stop));
      };
      await _recordHoleAndStop(r);
      await r.recoveries(1, max: const Duration(seconds: 5));
      // The wait has ended and `_finish` is parked on its commit.
      await r.until(() => r.fs.blocked, max: const Duration(seconds: 10));
      expect(r.fs.blocked, isTrue, reason: 'positive control: the commit is held');
      release!();
      await r.until(() => r.rows.any((TimelineEntry e) => e.displayText == _hole));
      final Completer<void> g = r.fs.gate!;
      r.fs.gate = null;
      g.complete();
      await r.untilLastAttempt(JournalAttempt.outcomeSettled);
      await r.until(() => !r.controller.backfill.isBusy);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.settled, isTrue, reason: 'the words are on the page; nothing is owed');
    expect(m.nextEligibleAtMs, isNull, reason: 'no retry is waiting');
    expect(r.relay.recoveryStarts, hasLength(1));
    expect(r.rows.where((TimelineEntry e) => e.displayText == _hole), hasLength(1));
  });

  testWidgets(
      '🔴 RC-N (c): the failed attempt\'s result arrives after a newer attempt '
      'covered the range ⇒ dropped, no row; the page holds the newer one only',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    void Function()? releaseFirst;
    await tester.runAsync(() async {
      r = await Rc3Rig.open(recoveryTimeouts: _quick);
      r.relay.onStop = (Rc3Stop stop) {
        if (!stop.recovery) return _liveFinal(r, stop);
        if (r.relay.recoveryStarts.length == 1) {
          releaseFirst = () =>
              r.relay.pushIncoming(FlowMicEvents.sttFinal, _holeFinal(r, stop));
          return;
        }
        Future<void>.delayed(const Duration(milliseconds: 20),
            () => r.relay.pushIncoming(FlowMicEvents.sttFinal, _holeFinal(r, stop)));
      };
      await _recordHoleAndStop(r);
      await r.recoveries(1);
      await _attemptClosed(r, JournalAttempt.outcomeFailed);
      final String id = r.relay.recoveryStarts.single['recording_id']! as String;
      await r.controller.backfill.retranscribe(recordingId: id, sourceLang: 'zh');
      await r.recoveries(2);
      await r.until(() => r.rows.any((TimelineEntry e) => e.displayText == _hole));
      releaseFirst!();
      await Future<void>.delayed(const Duration(milliseconds: 300));
      await r.until(() => !r.controller.backfill.isBusy);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, hasLength(2), reason: 'positive control');
    expect(r.rows.where((TimelineEntry e) => e.displayText == _hole), hasLength(1),
        reason: 'S6: the same stretch was minted once per result');
    expect(r.rowsMs, _totalMs);
    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.settled, isTrue);

    await rc3MountAndOpen(tester, r);
    expect(_meta(4), contains(rc3TextOf(tester, const Key('article.meta'))),
        reason: 'counted twice it would read 2:05');
    expect(find.textContaining(_hole), findsOneWidget);
  });
}
