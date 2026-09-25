// 🔴 CARD RC6 (F3) — A HOLE THE TWO CLOCKS MADE UP IS NOT OWED; A STRETCH THE
// RELAY CALLS SILENCE SETTLES AS SILENCE. MOUNTED ON THE SCREEN THE RECORDING IS
// READ ON.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d (the RC6 block, F3)
//   lib/src/ptt/engine_outage_stretch.dart `kMinOwedHoleMs` (the derivation)
//   lib/src/ptt/ptt_capture_pump.dart `_noteEngineStatusForArticle`
//   lib/src/session/recovery_settle.dart `resultIsSilence`
//   test/support/rc3_rig.dart (the rig: the real chain, a scripted relay)
//
// THE SHAPE (lf of CR-12-E re-check 5): the engine drops at 80.3 s, the relay's
// last answer was 80.0 s, and it comes back at 112.0 s having replayed the
// outage in place. The phone reads 「captured at `ready`」 on its own clock, so a
// replay from the answered point can look like a hole of up to 1.4 s — lf owed
// 60.2–63.6 s (3.4 s with the 1 s edges), the stretch was silence, the recovery
// came back empty, and the recording sat as 「完整性待校验」 with its audio kept.
//
// ① a 1.4 s raw hole ⇒ nothing owed, no recovery, the live settle settles it;
// ② a 1.6 s raw hole ⇒ owed (3.6 s with the edges); its recovery comes back
//   empty and the relay stamps `empty_reason: 'no_voice'` ⇒ that is silence: the
//   recording settles, its audio goes, the head adds up.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

const String _row0 = '第一段：今天先把发布计划过一遍。';
const String _spanning = '跨过断线的那一行：回滚方案已经演练过。';
const String _last = '最后一行：下周约技术负责人再聊。';
const int _totalMs = 124000;

/// [replayFromMs] — where the relay's replay began, as the phone computes it
/// (its capture at `ready`, 112.0 s, minus `replayed_ms`).
Future<Rc3Rig> _outageReplayedInPlace(int replayFromMs) async {
  final Rc3Rig r = await Rc3Rig.open();
  r.relay.onStop = (Rc3Stop stop) {
    Future<void>.delayed(const Duration(milliseconds: 20), () {
      if (stop.recovery) {
        // The stretch is silence: the relay's gate accepted none of it.
        r.relay.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
          ...r.relay.terminal(stop, text: '', durationMs: stop.toMs - stop.fromMs),
          'empty_reason': 'no_voice',
        });
        return;
      }
      r.relay.pushIncoming(FlowMicEvents.sttFinal,
          r.relay.terminal(stop, text: _last, durationMs: 4000, segmentIdx: 2));
    });
  };
  await r.begin();
  await r.feedMs(60000);
  await r.segment(_row0, 0, 60000);
  await r.feedMs(20300); // to 80.3 s
  await r.interim(1, ackedMs: 80000); // the dead leg had answered to 80.0 s
  await r.engine('reconnecting');
  await r.feedMs(31700); // to 112.0 s
  await r.engine('ready', replayedMs: 112000 - replayFromMs);
  await r.feedMs(8000); // to 120.0 s
  await r.segment(_spanning, 1, 60000); // the relay's clock: 60 → 120 s
  await r.feedMs(_totalMs - 120000);
  await r.controller.pttUp();
  await r.until(() => r.rows.any((TimelineEntry e) => e.displayText == _last));
  await r.untilAsync(() async {
    final RecordingManifest? m = await r.manifest();
    return m != null && (m.settled || m.recoveryState == RecoveryQueueState.settledUnverified);
  });
  await r.until(() => !r.controller.backfill.isBusy);
  return r;
}

void main() {
  testWidgets(
      '🔴 RC6 F3 ①: a 1.4 s raw hole after an in-place replay is the two clocks, '
      'not lost audio ⇒ nothing owed, nothing recovered, the recording settles',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await _outageReplayedInPlace(81400);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.owedRanges, isEmpty, reason: 're-check 5 lf owed 3.4 s nothing had lost');
    expect(r.relay.recoveryStarts, isEmpty);
    expect(m.settled, isTrue, reason: 'lf: 「完整性待校验」 for a stretch that was never lost');
    expect(r.rows.map((TimelineEntry e) => e.displayText).toList(), <String>[_row0, _spanning, _last]);
    expect(r.rowsMs, _totalMs);

    await rc3MountAndOpen(tester, r);
    expect(find.byKey(const Key('article.backfill')), findsNothing);
  });

  testWidgets(
      '🔴 RC6 F3 ②: a real 1.6 s hole is owed; its recovery comes back empty and the '
      'relay says no_voice ⇒ silence: the recording settles and its audio goes',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await _outageReplayedInPlace(81600);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, hasLength(1), reason: 'positive control: the hole was owed and fed');
    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.attempts.last.outcome, RecoveryQueueState.settled,
        reason: 'the relay said the stretch was silence; lf kept it as settled_unverified');
    expect(m.settled, isTrue);
    expect(r.pcmPresent, isFalse, reason: 'settled ⇒ the audio goes');
    expect(r.rows.map((TimelineEntry e) => e.displayText).toList(), <String>[_row0, _spanning, _last],
        reason: 'silence makes no row');
    expect(r.rowsMs, _totalMs, reason: 'the time lent to the hole went back to the row spanning it');

    await rc3MountAndOpen(tester, r);
    expect(find.byKey(const Key('article.backfill')), findsNothing);
  });
}
