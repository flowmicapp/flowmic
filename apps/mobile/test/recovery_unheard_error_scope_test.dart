// 🔴 CODEX RC4 REVIEW ② (P1) — A RECOVERY'S OWN 「NOT TRANSCRIBED」 IS NOT THE
// LIVE RECORDING'S. MOUNTED ON THE SCREEN THE RECORDING IS READ ON.
//
// SPEC-REF:
//   Codex review of 05df80df..1e5f8f0f (2026-09-25), item 2 (dispatch; not in the tree)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d (the RC4-S5 block)
//   lib/src/ptt/ptt_unheard_tail.dart `_oweUnheardTail`
//   lib/src/ptt/ptt_backfill.dart `openSessionIsRecovery` (who opened the wire's session)
//   test/support/rc3_rig.dart (the rig: the real chain, a scripted relay)
//
// THE SHAPE: the S5 stop (engine up, the relay owes 84–102.4 s), and then the
// RECOVERY of that tail is itself cut short on the relay: it answers
// STT_SEGMENT_NOT_TRANSCRIBED, then a final with only part of the stretch and a
// receipt that counts every frame it was fed.
//
// The handler asked only 「is the live recording's tail owed」 — the article
// clock, the live attempt and the owed flag all outlive the stop — so it read
// the recovery's error as the live one, answered 「owed, already recovered by
// itself」 and kept it from the state machine. The recovery then ended on a
// normal terminal final, settled, and released the only copy of the words the
// relay had just said it did not transcribe.
//
// Here the recovery's error must reach the state machine: the attempt stays
// incomplete, the stretch stays owed, and the audio stays on the phone.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

const int _prefixMs = 36800;
const int _unheardMs = 84000;
const int _totalMs = 102400;
const String _row0 = '今天上午我们先把仓库里积压的几张任务卡过一遍。';
const String _draft = '清晨的访问量最低，就算出了问题影响到的用户也会少很多。';
const String _tailPart = '这件事我建议下周约对方的';

Map<String, Object?> _unheard(int fromMs) => <String, Object?>{
      'code': 'STT_SEGMENT_NOT_TRANSCRIBED',
      'message': 'The recording ended with captured voice that no engine received',
      'retryable': false,
      'unheard_from_ms': fromMs,
    };

void main() {
  testWidgets(
      '🔴 Codex rc4 ②: the RECOVERY answers STT_SEGMENT_NOT_TRANSCRIBED and a partial '
      'final ⇒ the attempt stays incomplete, the stretch stays owed, the audio stays',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    int recoveries = 0;
    await tester.runAsync(() async {
      r = await Rc3Rig.open();
      r.relay.onStop = (Rc3Stop stop) {
        if (!stop.recovery) {
          Future<void>.delayed(const Duration(milliseconds: 20),
              () => r.relay.pushIncoming(FlowMicEvents.sttError, _unheard(_unheardMs)));
          Future<void>.delayed(const Duration(milliseconds: 80), () {
            // The relay's rows are wall-clock spans and routinely land a little off
            // the captured length (re-run 4: −0.1…+0.2 s per recording). Here a
            // second short, so after the tail is placed the article clock still
            // sits 1 s before the end of the audio — the state in which a
            // recovery's error, read as the live one, looked like a fresh tail.
            r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
                text: _draft, durationMs: _totalMs - _prefixMs - 1000, segmentIdx: 1));
          });
          return;
        }
        recoveries += 1;
        if (recoveries > 1) return; // only the first pass is under test
        // The recovery's own relay session ends short: the code, then a partial final.
        Future<void>.delayed(const Duration(milliseconds: 20),
            () => r.relay.pushIncoming(FlowMicEvents.sttError, _unheard(_unheardMs + 6000)));
        Future<void>.delayed(const Duration(milliseconds: 80), () {
          r.relay.pushIncoming(FlowMicEvents.sttFinal,
              r.relay.terminal(stop, text: _tailPart, durationMs: stop.toMs - stop.fromMs));
        });
      };
      await r.begin();
      await r.feedMs(_prefixMs);
      await r.segment(_row0, 0, _prefixMs);
      await r.feedMs(_totalMs - _prefixMs);
      await r.interim(1, ackedMs: 80000);
      await r.controller.pttUp();
      await r.until(() => r.relay.recoveryStarts.isNotEmpty);
      // The first recovery attempt has closed, one way or the other.
      await r.untilAsync(() async {
        final RecordingManifest? m = await r.manifest();
        return m != null && m.attempts.length >= 2 && m.attempts.last.outcome != null;
      });
      await r.until(() => !r.controller.backfill.isBusy);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    // PRECONDITION — the live stop owed the tail and one recovery pass ran on it.
    expect(r.relay.recoveryStarts.first['range_start_sample'], _unheardMs * 16);
    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.attempts.last.outcome, isNot(RecoveryQueueState.settled),
        reason: 'the relay said part of this stretch was not transcribed');
    expect(m.settled, isFalse);
    expect(m.attempts.last.failureCode, 'STT_SEGMENT_NOT_TRANSCRIBED',
        reason: 'the relay\'s own word for how this attempt ended reached the attempt, '
            'not the live recording');
    expect(m.owedRanges, hasLength(1),
        reason: 'the one stretch the stop owed; the recovery\'s error is not a new live tail');
    expect(m.owedRanges.single.isOwed, isTrue, reason: 'the stretch is still owed');
    expect(r.pcmPresent, isTrue, reason: 'the only copy of those words');

    await rc3MountAndOpen(tester, r);
    expect(find.byKey(const Key('article.backfill')), findsOneWidget,
        reason: 'the page still says a stretch is waiting to be transcribed');
    expect(r.rows.map((TimelineEntry e) => e.displayText), contains(_draft));
  });
}
