// 🔴 CARD RC-M — A RECOVERY WAITS FOR ITS RELAY, NOT FOR A FIXED 15 s NET.
// MOUNTED ON THE SCREEN THE RECORDING IS READ ON.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §3.2 / §8 RC-M / §11-1
//   docs/rebuild/08-MOBILE-SPEC.md §2 (the RC-M correction)
//   test/support/rc3_rig.dart (the rig)
//
// ── THE SHAPE (S6, attempts 2–5) ────────────────────────────────────────────
//
// The recovery fed its range and sent `audio:stop`; the relay, flushing a
// backlog, sent interims for 26 s and then the terminal final. The phone had
// given up at 15.3 s — GA-03's fixed net — recorded `stall_timeout`, and the
// words that came back 11 s later were thrown away (and later minted anyway,
// twice: that half is RC-N).
//
// Scaled, so the test takes seconds: the FSM's net is 300 ms here and the
// relay answers 1.5 s after the stop with an interim every 100 ms. With the
// fixed net armed for a recovery the attempt stalls at 300 ms; without it the
// leg's own clocks (`RecoveryTimeouts`, interims keep them alive) wait, and
// the attempt settles on the result.
//
// Reverse control: `endBackfill` arming the fixed net (`fsm.onPttUp()` and
// `onSttActivity` a no-op) ⇒ red on the stall and on `settled` — log in the
// card report.

import 'dart:async';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
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
const int _totalMs = 105000; // 40 + 45 (the relay's clock) + 20

void main() {
  testWidgets(
      '🔴 RC-M: the relay answers a recovery 1.5 s after its stop (net 300 ms), '
      'interims flowing ⇒ no stall, the attempt settles, one row, the head is '
      'the recording\'s length', (WidgetTester tester) async {
    late final Rc3Rig r;
    final List<SttStall> stalls = <SttStall>[];
    await tester.runAsync(() async {
      r = await Rc3Rig.open(processingTimeout: const Duration(milliseconds: 300));
      r.relay.onStop = (Rc3Stop stop) {
        if (!stop.recovery) {
          Future<void>.delayed(const Duration(milliseconds: 20), () {
            r.relay.pushIncoming(FlowMicEvents.sttFinal,
                r.relay.terminal(stop, text: _last, durationMs: 20000, segmentIdx: 2));
          });
          return;
        }
        // The relay is flushing a backlog: interims, then the final.
        stalls.clear();
        unawaited(() async {
          for (int i = 0; i < 15; i++) {
            await Future<void>.delayed(const Duration(milliseconds: 100));
            r.relay.pushIncoming(FlowMicEvents.sttInterim,
                <String, Object?>{'text': '断线那段', 'segment_idx': 0});
          }
          r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
              text: _hole, durationMs: stop.toMs - stop.fromMs));
        }());
      };
      await r.begin();
      r.session.fsm.sttStalled.listen(stalls.add);
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
      await r.recoveries(1);
      await r.until(() => r.rows.any((TimelineEntry e) => e.displayText == _hole));
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, hasLength(1),
        reason: 'positive control: the owed stretch was fed once');
    expect(stalls.where((SttStall s) => s.reason == SttStallReason.timeout), isEmpty,
        reason: 'the fixed 15 s net (300 ms here) cut every such attempt');
    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.attempts.last.outcome, JournalAttempt.outcomeSettled,
        reason: 'S6 recorded `stall_timeout` here');
    expect(m.settled, isTrue);
    expect(r.rows.where((TimelineEntry e) => e.displayText == _hole), hasLength(1));
    expect(r.rows, hasLength(4));

    await rc3MountAndOpen(tester, r);
    expect(
      <String>[
        for (final int s in <int>[_totalMs ~/ 1000 - 1, _totalMs ~/ 1000, _totalMs ~/ 1000 + 1])
          _zh.articleCardMeta(formatEntryDuration(s * 1000), 4),
      ],
      contains(rc3TextOf(tester, const Key('article.meta'))),
    );
    expect(find.textContaining(_hole), findsOneWidget);
  });
}
