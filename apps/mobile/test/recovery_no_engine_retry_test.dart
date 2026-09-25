// 🔴 CARD RC6 (F1) — A RECOVERY NO ENGINE HEARD IS A FAILURE THAT RETRIES, NOT
// 「NO SPEECH」. MOUNTED ON THE SCREEN THE RECORDING IS READ ON.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d (the RC6 block, F1)
//   lib/src/session/recovery_leg_settle.dart `_settleLate`
//   server-core stt/empty-final-cause.ts (no `empty_reason` once an engine error spoke)
//   test/support/rc3_rig.dart (the rig: the real chain, a scripted relay)
//
// THE SHAPE (S6 of CR-12-E re-check 5, runs ph / swh): a long recording stops
// with its engine unreachable (RC-P owes the tail from 35.9 s). The first
// recovery opens while the engine is still unreachable: the relay answers
// `STT_NETWORK_DROP`, the phone feeds the whole range anyway, and at its stop
// the relay says `STT_NO_ENGINE_REACHED` and sends an EMPTY final with no
// `empty_reason`. That final landed on the failed attempt and was read as 「the
// engine answered and there were no words」 ⇒ `emptyResult` ⇒
// `settled_unverified`, no `nextEligibleAtMs`, never retried, and the card said
// 「录音未识别出有效文本」 for 55 s no engine ever heard.
//
// Here: the first attempt stays a failure with a backoff, the RC-O timer (run in
// milliseconds by an injected clock and timer) retries it, the engine answers,
// and the tail is recovered once.

import 'dart:async';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

const int _prefixMs = 35800;
const int _totalMs = 91400;
const String _row0 = '今天上午我们先把仓库里积压的几张任务卡过一遍。';
const String _tail = '断网时录下的这一段：发布推迟到下周三，风险清单今天发给客户。';

void main() {
  testWidgets(
      '🔴 RC6 F1: the first recovery reaches no engine (NETWORK_DROP, NO_ENGINE_REACHED, '
      'an empty final with no empty_reason) ⇒ it stays a failure, the timer retries, '
      'and the tail is recovered once', (WidgetTester tester) async {
    late final Rc3Rig r;
    int skew = 0;
    final List<Duration> armed = <Duration>[];
    await tester.runAsync(() async {
      r = await Rc3Rig.open(
        recoveryClock: () => DateTime.now().millisecondsSinceEpoch + skew,
        // The RC-O timer, run in milliseconds: when it fires, the clock has
        // moved past the backoff it was armed for.
        recoveryRetryTimer: (Duration d, void Function() cb) {
          armed.add(d);
          return Timer(const Duration(milliseconds: 200), () {
            skew += d.inMilliseconds + 1000;
            cb();
          });
        },
      );
      int recoveries = 0;
      r.relay.onStop = (Rc3Stop stop) {
        if (!stop.recovery) {
          // The live stop: the closing dial failed; no draft came back.
          Future<void>.delayed(const Duration(milliseconds: 20), () {
            r.relay.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
              'code': 'STT_SEGMENT_NOT_TRANSCRIBED',
              'message': 'The recording ended with captured voice that no engine received',
              'retryable': false,
            });
          });
          Future<void>.delayed(const Duration(milliseconds: 80), () {
            r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
                text: '', durationMs: _totalMs - _prefixMs, segmentIdx: 1));
          });
          return;
        }
        recoveries += 1;
        if (recoveries == 1) {
          // Engine still unreachable: the drop, then 「0 bytes reached an engine」,
          // then an empty final the relay stamps no reason on.
          Future<void>.delayed(const Duration(milliseconds: 20), () {
            r.relay.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
              'code': 'STT_NETWORK_DROP', 'message': 'engine connection dropped', 'retryable': false,
            });
          });
          Future<void>.delayed(const Duration(milliseconds: 60), () {
            r.relay.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
              'code': 'STT_NO_ENGINE_REACHED',
              'message': '1781760 bytes passed the feed gate, 0 bytes reached an engine',
              'retryable': false,
            });
          });
          Future<void>.delayed(const Duration(milliseconds: 100), () {
            r.relay.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
              ...r.relay.terminal(stop, text: '', durationMs: stop.toMs - stop.fromMs),
              'confidence': 0.0,
            });
          });
          return;
        }
        Future<void>.delayed(const Duration(milliseconds: 20), () {
          r.relay.pushIncoming(FlowMicEvents.sttFinal,
              r.relay.terminal(stop, text: _tail, durationMs: stop.toMs - stop.fromMs));
        });
      };
      await r.begin();
      await r.feedMs(_prefixMs);
      await r.segment(_row0, 0, _prefixMs);
      await r.interim(1, ackedMs: _prefixMs);
      await r.engine('reconnecting');
      await r.feedMs(_totalMs - _prefixMs);
      await r.controller.pttUp();
      await r.recoveries(2, max: const Duration(seconds: 30));
      await r.until(() => r.rows.any((TimelineEntry e) => e.displayText == _tail));
    });
    addTearDown(() => tester.runAsync(r.dispose));

    // The user-visible fact first: the tail is there, once.
    final String all = r.rows.map((TimelineEntry e) => e.displayText).join('\n');
    expect(_tail.allMatches(all), hasLength(1),
        reason: 'S6: the stretch no engine heard was filed as 「no speech」 and never retried');
    expect(r.relay.recoveryStarts, hasLength(2), reason: 'the first attempt, then one retry');
    expect(armed, isNotEmpty, reason: 'the retry came from the RC-O timer, not from a user tap');

    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    final List<JournalAttempt> recovery =
        m.attempts.where((JournalAttempt a) => a.kind != 'live').toList();
    expect(recovery.first.outcome, JournalAttempt.outcomeFailed);
    expect(recovery.first.failureCode, isNot('emptyResult'),
        reason: 'nothing was heard, so nothing was 「said with no words」');
    expect(recovery.last.outcome, RecoveryQueueState.settled);
    expect(m.settled, isTrue);
    expect(r.rowsMs, _totalMs);

    await rc3MountAndOpen(tester, r);
    expect(find.textContaining(_tail), findsOneWidget);
    expect(find.byKey(const Key('article.backfill')), findsNothing);
  });
}
