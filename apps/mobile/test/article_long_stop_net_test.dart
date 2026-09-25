// 🔴 CARD RC4-S5 FOLLOW-UP (MAIN ruling 1) — A LONG RECORDING'S STOP WAITS FOR
// THE RELAY'S CLOSING WORK. MOUNTED ON THE SCREEN THE RECORDING IS READ ON.
//
// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §2 (the RC4-S5 follow-up block under RC-M)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §1 table, `engine_flush_timeout` row
//   lib/src/ptt/ptt_unheard_tail.dart `_longStopNet`
//   lib/src/signaling/state_machine.dart `onPttUp(netAtLeast:)`
//   test/support/rc3_rig.dart (the rig: the real chain, a scripted relay)
//
// THE SHAPE (S5 of CR-12-E re-run 4): while the relay closes a long recording
// it sends no stt frame, and the terminal final came 18.0 s after the stop. The
// RC-M net (15 s without a frame) fired first: PROCESSING was judged 「no
// response」, the late final still filed its words, but the live settle read
// `notEndedNormally` ⇒ `settled_unverified` ⇒ the pending card said
// 「完整性待校验」 for a text that was complete.
//
// Here: a 60 s long recording, the relay's last interim answered 40 s (20 s
// unanswered ⇒ net 25 s), the final 18 s after the stop with NOTHING between.
// A second case has a relay that never reports a position (no
// `acked_audio_ms` ⇒ the relay's own worst case, 35 s). Both must settle
// normally. The rig's net is the production 15 s, so the reverse control
// (the 15 s net kept for a long recording) is literal.
//
// ⚠️ 更正（RC6 F2，2026-09-25）：the formula above fell short on the device
// (CR-12-E re-check 5, s5b): 26.1 s unanswered ⇒ a ≈31 s net, and the relay's
// final came 37.2 s after the stop (the flush in flight, then the closing leg).
// The stop now waits for the final, bounded by the link and a 5 minute cap
// (`kLongStopWaitCap`). Both cases below answer 37.2 s after the stop; the
// reverse control is the ≈31 s net of the old formula.
//
// ⚠️ REAL TIME: each case waits 37 s under `tester.runAsync`, because the
// production chain arms real timers.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

const int _prefixMs = 30000;
const int _totalMs = 60000;
const Duration _finalAfterStop = Duration(milliseconds: 37200); // re-check 5 s5b
const String _row0 = '今天上午我们先把仓库里积压的几张任务卡过一遍。';
const String _row1 = '清晨的访问量最低，就算出了问题影响到的用户也会少很多。';

Future<Rc3Rig> _stopAndAnswerLate({required bool relayReportsPosition}) async {
  final Rc3Rig r = await Rc3Rig.open();
  r.relay.onStop = (Rc3Stop stop) {
    if (stop.recovery) return;
    Future<void>.delayed(_finalAfterStop, () {
      r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
          text: _row1, durationMs: _totalMs - _prefixMs, segmentIdx: 1));
    });
  };
  await r.begin();
  await r.feedMs(_prefixMs);
  await r.segment(_row0, 0, _prefixMs);
  await r.feedMs(_totalMs - _prefixMs);
  // The vendor is behind: the last interim says it answered up to 40 s.
  await r.interim(1, ackedMs: relayReportsPosition ? 40000 : null);
  await r.controller.pttUp();
  await r.until(() => r.rows.any((TimelineEntry e) => e.displayText == _row1),
      max: const Duration(seconds: 50));
  await r.untilAsync(() async {
    final RecordingManifest? m = await r.manifest();
    return m != null && m.attempts.isNotEmpty && m.attempts.last.outcome != null;
  });
  return r;
}

Future<void> _expectSettledNormally(WidgetTester tester, Rc3Rig r) async {
  expect(r.rows.map((TimelineEntry e) => e.displayText).toList(), <String>[_row0, _row1],
      reason: 'positive control: the late final was filed');
  final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
  expect(m.attempts.last.outcome, RecoveryQueueState.settled,
      reason: 're-check 5 s5b: the ≈31 s net fired before the 37.2 s final, and a complete '
          'text was kept as settled_unverified (「完整性待校验」)');
  expect(r.rowsMs, _totalMs);
  await rc3MountAndOpen(tester, r);
  expect(find.byKey(const Key('article.backfill')), findsNothing);
  expect(find.textContaining(_row1), findsOneWidget);
}

void main() {
  testWidgets(
      '🔴 RC6 F2: a long recording\'s final 37.2 s after the stop, no frame '
      'between (20 s unanswered) ⇒ it settles normally', (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await _stopAndAnswerLate(relayReportsPosition: true);
    });
    addTearDown(() => tester.runAsync(r.dispose));
    await _expectSettledNormally(tester, r);
  });

  testWidgets(
      '🔴 RC6 F2: a relay that reports no position ⇒ the stop still waits for the '
      '37.2 s final', (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await _stopAndAnswerLate(relayReportsPosition: false);
    });
    addTearDown(() => tester.runAsync(r.dispose));
    await _expectSettledNormally(tester, r);
  });
}
