// 🔴 CODEX RC4 REVIEW ① (P1) — AN EARLIER HOLE MUST NOT SWALLOW THE UNHEARD
// TAIL. MOUNTED ON THE SCREEN THE RECORDING IS READ ON.
//
// SPEC-REF:
//   Codex review of 05df80df..1e5f8f0f (2026-09-25), item 1 (dispatch; not in the tree)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d (the RC4-S5 block)
//   lib/src/ptt/ptt_unheard_tail.dart `_oweUnheardTail`
//   lib/src/audio/retained_audio_journal.dart `setOwedRange` (RC-K: stretches are appended)
//   test/support/rc3_rig.dart (the rig: the real chain, a scripted relay)
//
// THE SHAPE: a long recording loses its engine mid-way and the relay's ring no
// longer holds the start of the outage ⇒ a BOUNDED hole is owed (RC-3b / RC-L:
// 87.5–97.0 s). Later the recording stops with the engine up, and the relay says
// STT_SEGMENT_NOT_TRANSCRIBED{unheard_from_ms: 135 000} ahead of the terminal
// final (the RC4-S5 tail, 135–140 s).
//
// `RetainedAudioSpill.owesTail` answers 「is anything owed」, and the bounded
// hole had already set it; the handler read it as 「this tail is already owed」,
// wrote no range for the tail and hid the error. The recovery then fed the hole,
// settled the recording and released the PCM: the last five seconds were on no
// row and nothing marked them.
//
// Here both stretches must be on the manifest, both fed, each once, and the
// recording settled only after both.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

const String _row0 = '第一段：今天先把发布计划过一遍。';
const String _holeText = '断线那一段：数据库迁移推到下周。';
const String _spanning = '跨过断线的那一行：回滚方案已经演练过。';
const String _draft = '最后一行的前半：接下来谈';
const String _tail = '最后一行没被听到的后半：下周约技术负责人再聊。';
const int _unheardMs = 135000;
const int _totalMs = 140000;

void main() {
  testWidgets(
      '🔴 Codex rc4 ①: an earlier bounded hole, then an unheard terminal tail ⇒ '
      'both stretches owed, both recovered once, and the audio kept until both',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    final List<bool> pcmAtRecoveryStart = <bool>[];
    await tester.runAsync(() async {
      r = await Rc3Rig.open();
      r.relay.onStop = (Rc3Stop stop) {
        if (!stop.recovery) {
          Future<void>.delayed(const Duration(milliseconds: 20), () {
            r.relay.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
              'code': 'STT_SEGMENT_NOT_TRANSCRIBED',
              'message': 'The recording ended with captured voice that no engine received',
              'retryable': false,
              'unheard_from_ms': _unheardMs,
            });
          });
          Future<void>.delayed(const Duration(milliseconds: 80), () {
            r.relay.pushIncoming(FlowMicEvents.sttFinal,
                r.relay.terminal(stop, text: _draft, durationMs: _totalMs - 133000, segmentIdx: 2));
          });
          return;
        }
        pcmAtRecoveryStart.add(r.pcmPresent);
        final String heard = stop.fromMs >= _unheardMs - 1000 ? _tail : _holeText;
        Future<void>.delayed(const Duration(milliseconds: 20), () {
          r.relay.pushIncoming(FlowMicEvents.sttFinal,
              r.relay.terminal(stop, text: heard, durationMs: stop.toMs - stop.fromMs));
        });
      };
      await r.begin();
      await r.feedMs(60000);
      await r.segment(_row0, 0, 60000);
      await r.feedMs(31000); // to 91.0 s
      await r.interim(1, ackedMs: 88500);
      await r.engine('reconnecting');
      await r.feedMs(32000); // to 123.0 s
      await r.engine('ready', replayedMs: 27000); // ⇒ the bounded hole 87.5–97.0 s
      await r.feedMs(10000);
      await r.segment(_spanning, 1, 73000);
      await r.feedMs(7000); // to 140.0 s
      await r.interim(2, ackedMs: 138000);
      await r.controller.pttUp();
      await r.recoveries(2);
      await r.until(() => r.rows.any((TimelineEntry e) => e.displayText == _tail));
    });
    addTearDown(() => tester.runAsync(r.dispose));

    // The user-visible fact first.
    final String all = r.rows.map((TimelineEntry e) => e.displayText).join('\n');
    expect(_tail.allMatches(all), hasLength(1),
        reason: 'the tail no engine heard is on no row once the hole is recovered');
    expect(_holeText.allMatches(all), hasLength(1));
    expect(_draft.allMatches(all), hasLength(1));

    final List<Map<String, Object?>> rec = r.relay.recoveryStarts;
    expect(rec.map((Map<String, Object?> s) => s['range_start_sample']).toList(),
        <int>[87500 * 16, _unheardMs * 16],
        reason: 'both stretches fed, each once, the hole first');
    expect(pcmAtRecoveryStart, <bool>[true, true],
        reason: 'the audio is still on the phone for the second stretch');
    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.owedRanges, hasLength(2), reason: 'two owed stretches, recorded side by side (RC-K)');
    expect(m.settled, isTrue);

    await rc3MountAndOpen(tester, r);
    expect(find.textContaining(_tail), findsOneWidget);
    expect(find.byKey(const Key('article.backfill')), findsNothing);
  });
}
