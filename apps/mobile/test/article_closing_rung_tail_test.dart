// 🔴 CODEX RC6 REVIEW ①② (P1) — A TAIL THE RELAY'S CLOSING LEG HEARD IS
// WITHDRAWN ONLY ONCE ITS WORDS ARE ON DISK, AND ONLY THAT SPAN. MOUNTED ON THE
// SCREEN THE RECORDING IS READ ON.
//
// SPEC-REF:
//   Codex review of 8c0d879a..bee886be (2026-09-25), items 1 and 2 (dispatch; not in the tree)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d (the RC6 block, F2 ②; the RC7 correction)
//   lib/src/ptt/ptt_unheard_tail.dart `_withdrawTailHeardByClosingRung`
//   lib/src/audio/retained_audio_owed_ranges.dart (RC-K: the owed list)
//   test/support/rc3_rig.dart (the rig: the real chain, a scripted relay)
//
// ① The engine is down at the stop, so RC-P owes the tail. The relay's closing
//   rung then says `ready` with a replay covering it. RC6 wrote that stretch
//   `done` on disk at once, so an app killed (or a socket lost) before the
//   final's words were on disk left a manifest owing nothing: the tail was gone,
//   with its audio still on the phone. Here the manifest must still owe it
//   until the final's row is persisted.
//
// ② Two outages and no segment final between them: a bounded hole 30–50 s is
//   owed, then the stop (engine down, last answer at 80 s) owes the tail from the
//   article clock. The two overlapped on disk and merged into one stretch, and
//   the closing rung's withdrawal marked the whole of it done — the hole with it.
//   Here the hole must stay owed and be recovered once, while the tail the
//   closing leg heard is not recovered at all.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

const String _row0 = '第一段：今天先把发布计划过一遍。';
const String _draft = '中间和最后这一段：迁移推到下周，回滚方案已经演练过。';
const String _holeText = '断线那一段：预算已经批下来了。';

bool _owes(RecordingManifest m, int fromMs) => m.owedRanges.any((OwedRange o) =>
    o.isOwed && o.start <= fromMs * 32 && (o.end == null || o.end! > fromMs * 32));

void main() {
  testWidgets(
      '🔴 Codex rc6 ①: the closing rung\'s `ready` covers the tail ⇒ until the final\'s '
      'words are on disk the manifest still owes it (a restart then would recover it)',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    late final RecordingManifest beforeFinal;
    await tester.runAsync(() async {
      r = await Rc3Rig.open();
      r.relay.onStop = (Rc3Stop stop) {
        if (stop.recovery) {
          Future<void>.delayed(const Duration(milliseconds: 20), () {
            r.relay.pushIncoming(FlowMicEvents.sttFinal,
                r.relay.terminal(stop, text: _draft, durationMs: stop.toMs - stop.fromMs));
          });
          return;
        }
        Future<void>.delayed(const Duration(milliseconds: 200), () {
          r.relay.pushIncoming(FlowMicEvents.sttEngineStatus, <String, Object?>{
            'status': 'ready', 'provider': 'soniox', 'replayed_ms': 100000 - 35000,
          });
        });
        Future<void>.delayed(const Duration(seconds: 3), () {
          r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
              text: _draft, durationMs: 70000, segmentIdx: 1));
        });
      };
      await r.begin();
      await r.feedMs(30000);
      await r.segment(_row0, 0, 30000);
      await r.feedMs(5000);
      await r.interim(1, ackedMs: 35000);
      await r.engine('reconnecting');
      await r.feedMs(65000); // to 100 s
      await r.controller.pttUp();
      // The `ready` has landed and anything it writes is committed; the final has not come.
      await Future<void>.delayed(const Duration(milliseconds: 1500));
      beforeFinal = (await r.manifest())!;
      await r.until(() => r.rows.any((TimelineEntry e) => e.displayText == _draft));
      await Future<void>.delayed(const Duration(seconds: 2));
      await r.until(() => !r.controller.backfill.isBusy);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(_owes(beforeFinal, 35000), isTrue,
        reason: 'no words for the tail are on disk yet; RC6 had already marked it done');
    // Once the final's row is on disk the tail is not owed any more, and nothing re-transcribes it.
    expect(r.relay.recoveryStarts, isEmpty);
    expect(r.rows.map((TimelineEntry e) => e.displayText).toList(), <String>[_row0, _draft]);
    expect(r.rowsMs, 100000);
    await rc3MountAndOpen(tester, r);
    expect(find.textContaining(_draft), findsOneWidget);
  });

  testWidgets(
      '🔴 Codex rc6 ②: an earlier bounded hole overlaps the tail on disk ⇒ the closing '
      'rung withdraws only the tail it heard; the hole stays owed and is recovered once',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await Rc3Rig.open();
      r.relay.onStop = (Rc3Stop stop) {
        if (stop.recovery) {
          final String heard = stop.fromMs < 55000 ? _holeText : '尾巴又转了一遍。';
          Future<void>.delayed(const Duration(milliseconds: 20), () {
            r.relay.pushIncoming(FlowMicEvents.sttFinal,
                r.relay.terminal(stop, text: heard, durationMs: stop.toMs - stop.fromMs));
          });
          return;
        }
        // The closing rung replays from the last answer (80 s): the tail is heard.
        Future<void>.delayed(const Duration(milliseconds: 200), () {
          r.relay.pushIncoming(FlowMicEvents.sttEngineStatus, <String, Object?>{
            'status': 'ready', 'provider': 'soniox', 'replayed_ms': 100000 - 80000,
          });
        });
        Future<void>.delayed(const Duration(seconds: 2), () {
          r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
              text: _draft, durationMs: 90000, segmentIdx: 1));
        });
      };
      await r.begin();
      await r.feedMs(10000);
      await r.segment(_row0, 0, 10000);
      await r.feedMs(21500); // to 31.5 s
      await r.interim(1, ackedMs: 31000);
      await r.engine('reconnecting');
      await r.feedMs(28500); // to 60.0 s
      await r.engine('ready', replayedMs: 60000 - 49000); // ⇒ the bounded hole 30–50 s
      await r.feedMs(20500); // to 80.5 s
      await r.interim(1, ackedMs: 80000);
      await r.engine('reconnecting');
      await r.feedMs(19500); // to 100 s
      await r.controller.pttUp();
      await r.recoveries(1, max: const Duration(seconds: 20));
      await r.until(() => r.rows.any((TimelineEntry e) => e.displayText == _holeText),
          max: const Duration(seconds: 10));
    });
    addTearDown(() => tester.runAsync(r.dispose));

    final String all = r.rows.map((TimelineEntry e) => e.displayText).join('\n');
    expect(_holeText.allMatches(all), hasLength(1),
        reason: 'the hole no engine heard was settled together with the tail and never recovered');
    expect(_draft.allMatches(all), hasLength(1));
    expect(r.relay.recoveryStarts.map((Map<String, Object?> s) => s['range_start_sample']).toList(),
        <int>[30000 * 16], reason: 'the hole, once; the tail the closing leg heard, not at all');
    await rc3MountAndOpen(tester, r);
    expect(find.textContaining(_holeText), findsOneWidget);
  });
}
