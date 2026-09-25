// 🔴 CARD RC6 (F2 ②③) — A LONG RECORDING STOPPED WITH ITS ENGINE DOWN: THE PHONE
// WAITS FOR THE RELAY, AND THE ARTICLE ENDS WITH ONE COPY. MOUNTED ON THE
// SCREEN THE RECORDING IS READ ON.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d (the RC6 block, F2)
//   lib/src/ptt/ptt_unheard_tail.dart `_longStopNet` / `_withdrawTailHeardByClosingRung`
//   lib/src/session/chat_utterance.dart (the late live final of a superseded attempt)
//   server-core stt/orchestrator-terminal.ts `settleOwedVoice` (the closing rung's `ready`)
//   test/support/rc3_rig.dart (the rig: the real chain, a scripted relay)
//
// THE SHAPE (the yield drill of CR-12-E re-check 5): the engine is down at the
// stop, so RC-P owes the tail from where the relay last answered (35 s). The
// relay's closing rung gets through after all: it says `ready{replayed_ms}`
// (replayed from 35 s) and, much later, sends a terminal final carrying every
// word. On the device the phone gave up at 15 s + 45 s, transcribed the tail
// itself at 60 s, and filed the 79.6 s final too: the middle twice, the head
// 3:32 for a 2:00 recording.
//
// ① the phone waits (the 15 s RC-M net is shrunk to 0.3 s here, so the old
//   behaviour would recover at ≈45 s; the final comes at 48 s), the tail is
//   withdrawn on the rung's `ready`, and the final is the only copy;
// ② if the wait does end without the final (here a test ceiling of 0.3 s on the
//   long-stop wait), the recovery takes the tail and a late live final of that
//   recording is dropped — still one copy.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/entry_metrics.dart' show formatEntryDuration;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

const int _prefixMs = 30000;
const int _answeredMs = 35000;
const int _totalMs = 100000;
const Duration _finalAfterStop = Duration(seconds: 48);
const String _row0 = '第一段：今天先把发布计划过一遍。';
const String _tail = '断线以后说的这一整段：迁移推到下周，回滚方案已经演练过，预算也批下来了。';

/// [ceiling] — a test ceiling on the long-stop wait; null = the production 5 min.
/// [rungReady] — the closing rung's `ready` reaches the phone (a relay before RC6
/// never sends one).
Future<Rc3Rig> _stopWithEngineDown({Duration? ceiling, bool rungReady = true}) async {
  final Rc3Rig r = await Rc3Rig.open(
    processingTimeout: const Duration(milliseconds: 300),
    longStopCeiling: ceiling,
  );
  r.relay.onStop = (Rc3Stop stop) {
    if (stop.recovery) {
      // The recovery transcribes what it is fed: the whole tail from the prefix.
      Future<void>.delayed(const Duration(milliseconds: 20), () {
        r.relay.pushIncoming(FlowMicEvents.sttFinal,
            r.relay.terminal(stop, text: _tail, durationMs: stop.toMs - stop.fromMs));
      });
      return;
    }
    // The closing rung connects and replays from where the relay last answered.
    if (rungReady) {
      Future<void>.delayed(const Duration(milliseconds: 500), () {
        r.relay.pushIncoming(FlowMicEvents.sttEngineStatus, <String, Object?>{
          'status': 'ready', 'provider': 'soniox', 'replayed_ms': _totalMs - _answeredMs,
        });
      });
    }
    // …and its terminal final, with every word, long after the stop.
    Future<void>.delayed(_finalAfterStop, () {
      r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
          text: _tail, durationMs: _totalMs - _prefixMs, segmentIdx: 1));
    });
  };
  await r.begin();
  await r.feedMs(_prefixMs);
  await r.segment(_row0, 0, _prefixMs);
  await r.feedMs(_answeredMs - _prefixMs);
  await r.interim(1, ackedMs: _answeredMs);
  await r.engine('reconnecting');
  await r.feedMs(_totalMs - _answeredMs);
  await r.controller.pttUp();
  // Past the final, and past any recovery it could still have started.
  await Future<void>.delayed(_finalAfterStop + const Duration(seconds: 3));
  await r.until(() => !r.controller.backfill.isBusy);
  return r;
}

Future<void> _expectOneCopy(WidgetTester tester, Rc3Rig r) async {
  final String all = r.rows.map((TimelineEntry e) => e.displayText).join('\n');
  expect(_tail.allMatches(all), hasLength(1),
      reason: 're-check 5 yield drill: the tail twice, the head 3:32 for 2:00');
  expect(r.rows.map((TimelineEntry e) => e.displayText).toList(), <String>[_row0, _tail]);
  expect(r.rowsMs, _totalMs, reason: 'the head is the recorded length');
  await rc3MountAndOpen(tester, r);
  expect(
    <String>[
      for (final int s in <int>[_totalMs ~/ 1000 - 1, _totalMs ~/ 1000, _totalMs ~/ 1000 + 1])
        _zh.articleCardMeta(formatEntryDuration(s * 1000), 2),
    ],
    contains(rc3TextOf(tester, const Key('article.meta'))),
  );
  expect(find.textContaining(_tail), findsOneWidget);
}

void main() {
  testWidgets(
      '🔴 RC6 F2 ②: engine down at the stop, the closing rung hears the tail and its '
      'final comes 48 s later ⇒ the phone waited, no recovery ran, one copy',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await _stopWithEngineDown();
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, isEmpty,
        reason: 'the relay session was alive; on the device the phone recovered at 60 s');
    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.attempts.last.outcome, RecoveryQueueState.settled,
        reason: 'the final carried the whole recording');
    expect(r.pcmPresent, isFalse);
    await _expectOneCopy(tester, r);
  });

  testWidgets(
      '🔴 RC6 F2 ③: the wait ended without the final and the recovery took the tail ⇒ '
      'the late live final of that recording is dropped, one copy',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await _stopWithEngineDown(ceiling: const Duration(milliseconds: 300), rungReady: false);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, hasLength(1),
        reason: 'precondition: the grace ran out before the final and the recovery took the tail');
    await _expectOneCopy(tester, r);
  });
}
