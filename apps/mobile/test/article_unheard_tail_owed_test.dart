// 🔴 CARD RC4-S5 — A LONG RECORDING STOPPED WITH THE ENGINE UP, AND THE RELAY
// SAYS A STRETCH REACHED NO ENGINE: THE PHONE OWES EXACTLY THAT STRETCH AND
// RECOVERS IT IN PLACE, ONCE. MOUNTED ON THE SCREEN THE RECORDING IS READ ON.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d (the RC4-S5 block)
//   docs/rebuild/04-PROTOCOL-SPEC.md `stt:error` row (`unheard_from_ms`)
//   lib/src/ptt/ptt_unheard_tail.dart / lib/src/audio/retained_audio_owed_after_stop.dart
//   test/support/rc3_rig.dart (the rig: the real chain, a scripted relay)
//
// ── THE SHAPE (S5 of CR-12-E re-run 4, rounded to 200 ms frames) ─────────────
//
//   capture  0–36.8 s   row 0 (settled live)
//            50–60 s    the SECOND engine outage, replayed in place by the relay
//                       (`ready.replayed_ms` covers it ⇒ nothing owed mid-way)
//            84 s       the relay's last row cut; its flush is still out at the stop
//            84–102.4   the user talks on; no engine leg ever hears it
//            102.4      stop, the engine UP. The relay says
//                       STT_SEGMENT_NOT_TRANSCRIBED{unheard_from_ms: 84 000}, then
//                       sends the terminal final: 36.8–84 s's words, over the
//                       row's span up to the stop (65.6 s).
//
//   before the card: nothing owed (RC-P owes only when the stop sees the link or
//     the engine down), the live settle kept the file `settled_unverified`, and
//     84–102.4 s was in no row, ever (S5: sentence 17 and the end of 16);
//   after: owed from 84 s, the draft row at 36.8 s (47.2 s), the recovered tail
//     at 84 s (18.4 s), each sentence once, the head 1:42.
//
// 🔴 THE FAKE RELAY TRANSCRIBES WHAT IT IS FED: a recovery whose range starts
// before 83 s hears the draft's words too, so a range that started early shows
// up as the draft sentence twice; a range that started late would drop the tail.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/entry_metrics.dart' show formatEntryDuration;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

const int _prefixMs = 36800;
const int _downMs = 50000;
const int _upMs = 60000;
const int _ackedMs = 80000; // the last interim's answer: the vendor was behind
const int _unheardMs = 84000; // where the relay's answered mark stopped
const int _totalMs = 102400; // 1:42
const String _row0 = '今天上午我们先把仓库里积压的几张任务卡过一遍。';
const String _draft = '清晨的访问量最低，就算出了问题影响到的用户也会少很多。';
const String _tail = '这件事我建议下周约对方的技术负责人再聊一次，把需求彻底问清楚再动手。';

/// [unheardFrom] — what the relay puts on the error; null = a relay older than
/// the card (no field).
Future<(Rc3Rig, List<int>)> _recordS5AndStop({int? unheardFrom = _unheardMs}) async {
  final Rc3Rig r = await Rc3Rig.open();
  final List<int> recoveryFed = <int>[];
  r.relay.onStop = (Rc3Stop stop) {
    if (!stop.recovery) {
      Future<void>.delayed(const Duration(milliseconds: 20), () {
        r.relay.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
          'code': 'STT_SEGMENT_NOT_TRANSCRIBED',
          'message': 'The recording ended with captured voice that no engine received',
          'retryable': false,
          'unheard_from_ms': ?unheardFrom,
        });
      });
      Future<void>.delayed(const Duration(milliseconds: 80), () {
        r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
            text: _draft, durationMs: _totalMs - _prefixMs, segmentIdx: 1));
      });
      return;
    }
    recoveryFed.add(stop.fed);
    final String heard = stop.fromMs < _unheardMs - 1000 ? '$_draft$_tail' : _tail;
    Future<void>.delayed(const Duration(milliseconds: 20), () {
      r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
          text: heard, durationMs: stop.toMs - stop.fromMs));
    });
  };
  await r.begin();
  await r.feedMs(_prefixMs);
  await r.segment(_row0, 0, _prefixMs);
  await r.feedMs(_downMs - _prefixMs);
  await r.interim(1, ackedMs: _downMs);
  await r.engine('reconnecting');
  await r.feedMs(_upMs - _downMs);
  // The relay replayed the whole outage from its ring (S5: `replayed_ms 55600`).
  await r.engine('ready', replayedMs: 14000);
  await r.feedMs(90000 - _upMs);
  await r.interim(1, ackedMs: _ackedMs);
  await r.feedMs(_totalMs - 90000);
  await r.controller.pttUp();
  await r.recoveries(1);
  await r.until(() => r.rows.any((TimelineEntry e) => e.displayText.contains(_tail)));
  return (r, recoveryFed);
}

void main() {
  testWidgets(
      '🔴 RC4-S5: STT_SEGMENT_NOT_TRANSCRIBED with the engine up ⇒ the stretch '
      'from 84 s is owed and recovered in place, each sentence once, the head 1:42',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    late final List<int> fed;
    await tester.runAsync(() async {
      (r, fed) = await _recordS5AndStop();
    });
    addTearDown(() => tester.runAsync(r.dispose));

    // The user-visible facts first, so a regression names its symptom.
    final String all = r.rows.map((TimelineEntry e) => e.displayText).join('\n');
    expect(_tail.allMatches(all), hasLength(1),
        reason: 'S5: the last ~20 s were in no row and nothing recovered them');
    expect(_draft.allMatches(all), hasLength(1),
        reason: 'the words the terminal final carried, transcribed a second time');
    expect(r.rows.map((TimelineEntry e) => e.displayText).toList(),
        <String>[_row0, _draft, _tail], reason: 'in the order they were said');
    expect(r.rows.map((TimelineEntry e) => e.articleOffsetMs).toList(),
        <int>[0, _prefixMs, _unheardMs]);
    expect(r.rowsMs, _totalMs, reason: 'the head is the recorded length (S5: +18.0 s)');

    // Once: one recovery, fed only the stretch no engine heard.
    final List<Map<String, Object?>> rec = r.relay.recoveryStarts;
    expect(rec, hasLength(1), reason: 'positive control: the owed tail was fed, once');
    expect(rec.single['range_start_sample'], _unheardMs * 16,
        reason: 'from where the relay said, not from the last acked interim (80 s)');
    expect(fed.single, (_totalMs - _unheardMs) ~/ 200);
    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.settled, isTrue, reason: 'S5 left it settled_unverified, never retried');

    await rc3MountAndOpen(tester, r);
    expect(
      <String>[
        for (final int s in <int>[_totalMs ~/ 1000 - 1, _totalMs ~/ 1000, _totalMs ~/ 1000 + 1])
          _zh.articleCardMeta(formatEntryDuration(s * 1000), 3),
      ],
      contains(rc3TextOf(tester, const Key('article.meta'))),
      reason: 'S5 read 3:48 for a 3:30 recording',
    );
    expect(find.textContaining(_tail), findsOneWidget);
    expect(find.textContaining(_draft), findsOneWidget);
    expect(find.byKey(const Key('article.backfill')), findsNothing);
  });

  testWidgets(
      'RC4-S5, a relay older than the card (no unheard_from_ms): owed from the '
      'last acked interim — the tail is recovered, nothing is lost',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      (r, _) = await _recordS5AndStop(unheardFrom: null);
    });
    addTearDown(() => tester.runAsync(r.dispose));

    final String all = r.rows.map((TimelineEntry e) => e.displayText).join('\n');
    expect(_tail.allMatches(all), hasLength(1));
    expect(all, contains(_draft));
    expect(r.relay.recoveryStarts.single['range_start_sample'], _ackedMs * 16);
    expect(r.rowsMs, _totalMs);
    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.settled, isTrue);
  });
}
