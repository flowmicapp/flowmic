// 🔴 CARD RC-P — A LONG RECORDING STOPPED WITH ITS ENGINE DOWN: THE OWED TAIL
// STARTS WHERE THE RELAY ANSWERED, AND IS PLACED AFTER THE DEAD LEG'S DRAFT.
// MOUNTED ON THE SCREEN THE RECORDING IS READ ON. (The S6 shape of the header
// criterion, ruling 5: 1:42, one row set, no duplicates.)
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §2.1 (S6) / §8 RC-P
//   test/support/rc3_rig.dart (the rig)
//
// ── THE SHAPE (S6, numbers rounded to 200 ms frames) ────────────────────────
//
//   capture  0–36.8 s   row 0 (settled live)
//            36.8–45.2  speech the relay heard and ANSWERED (interim acked 45.2)
//            45.2       the engine goes; the user talks on
//            102.4      stop. The relay first says STT_SEGMENT_NOT_TRANSCRIBED,
//                       then sends the terminal final: the dead leg's draft,
//                       36.8–45.2's words, reported over its own wall clock
//                       (65.6 s = 36.8 → 102.4).
//
//   before RC-P: the tail was owed from 36.8 (the settled prefix) and the clock
//     pushed to 102.4 at the stop, so the draft row landed at 102,400 and the
//     recovery fed 36.8–45.2 again — its words twice, billed twice;
//   after: owed from 45.2, the draft row at 36,800 (8.4 s), the recovered tail
//     at 45,200 (57.2 s), each sentence once, the head 1:42.
//
// 🔴 THE FAKE RELAY TRANSCRIBES WHAT IT IS FED: a recovery whose range starts
// before 45.2 s hears the draft's words too, so a range that still started at
// the prefix shows up as the draft sentence twice.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/entry_metrics.dart' show formatEntryDuration;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

const int _prefixMs = 36800;
const int _answeredMs = 45200;
const int _totalMs = 102400; // 1:42
const String _row0 = '我先说一下今天的安排，然后看日志。';
const String _draft = '我看了一下日志，发现请求其实已经发出去了。';
const String _tail = '只是界面没有刷新，所以看起来像是卡住了。';

/// [draftText] is what the live terminal final brings: the dead leg's draft,
/// or '' when the relay lost it.
Future<Rc3Rig> _recordS6AndStop({String draftText = _draft}) async {
  final Rc3Rig r = await Rc3Rig.open();
  r.relay.onStop = (Rc3Stop stop) {
    if (!stop.recovery) {
      // The live stop: the closing verdict first, the draft final after it.
      Future<void>.delayed(const Duration(milliseconds: 20), () {
        r.relay.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
          'code': 'STT_SEGMENT_NOT_TRANSCRIBED',
          'message': 'no engine leg was open to take it',
          'retryable': false,
        });
      });
      Future<void>.delayed(const Duration(milliseconds: 80), () {
        r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
            text: draftText, durationMs: _totalMs - _prefixMs, segmentIdx: 1));
      });
      return;
    }
    final String heard =
        stop.fromMs < _answeredMs - 1000 ? '$_draft$_tail' : _tail;
    Future<void>.delayed(const Duration(milliseconds: 20), () {
      r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
          text: heard, durationMs: stop.toMs - stop.fromMs));
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
  await r.recoveries(1);
  await r.until(() => r.rows.any((TimelineEntry e) => e.displayText.contains(_tail)));
  return r;
}

void main() {
  testWidgets(
      '🔴 RC-P (S6): engine down at the stop ⇒ the draft row at 36.8 s, the owed '
      'tail from 45.2 s after it, each sentence once, the head 1:42',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await _recordS6AndStop();
    });
    addTearDown(() => tester.runAsync(r.dispose));

    final List<Map<String, Object?>> rec = r.relay.recoveryStarts;
    expect(rec, hasLength(1), reason: 'positive control: the owed tail was fed');
    // The user-visible facts first, so a regression names its symptom.
    final String all = r.rows.map((TimelineEntry e) => e.displayText).join('\n');
    expect(_draft.allMatches(all), hasLength(1),
        reason: 'S6: the draft words were transcribed, billed and printed twice');
    expect(r.rows.map((TimelineEntry e) => e.articleOffsetMs).toList(),
        <int>[0, _prefixMs, _answeredMs],
        reason: 'the draft where it was said (S6 filed it at 102,400)');
    expect(r.rows.map((TimelineEntry e) => e.displayText).toList(),
        <String>[_row0, _draft, _tail]);
    expect(rec.single['range_start_sample'], _answeredMs * 16,
        reason: 'from where the relay answered, not from the settled prefix');
    expect(r.rows[1].durationMs, _answeredMs - _prefixMs,
        reason: 'the draft\'s wall-clock span, net of the tail it contained');
    expect(r.rowsMs, _totalMs);
    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.settled, isTrue);

    await rc3MountAndOpen(tester, r);
    expect(
      <String>[
        for (final int s in <int>[_totalMs ~/ 1000 - 1, _totalMs ~/ 1000, _totalMs ~/ 1000 + 1])
          _zh.articleCardMeta(formatEntryDuration(s * 1000), 3),
      ],
      contains(rc3TextOf(tester, const Key('article.meta'))),
      reason: 'S6 read 3:54 for this 1:42 recording',
    );
    expect(find.textContaining(_draft), findsOneWidget);
    expect(find.byKey(const Key('article.backfill')), findsNothing);
  });

  testWidgets(
      '🔴 RC-P fallback: the draft never arrives (the terminal final is empty) '
      '⇒ the owed range goes back to the prefix, and 36.8–45.2 s is recovered '
      'with the tail — nothing between the prefix and the answer is lost',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await _recordS6AndStop(draftText: '');
    });
    addTearDown(() => tester.runAsync(r.dispose));

    final String all = r.rows.map((TimelineEntry e) => e.displayText).join('\n');
    expect(_draft.allMatches(all), hasLength(1),
        reason: 'started at the answer, the recovery would never feed these '
            'words, and its settle would release the only copy');
    expect(r.relay.recoveryStarts.single['range_start_sample'], _prefixMs * 16);
    expect(r.rows.map((TimelineEntry e) => e.articleOffsetMs).toList(),
        <int>[0, _prefixMs]);
    expect(r.rowsMs, _totalMs, reason: 'the empty final\'s span is no silence here');
    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.settled, isTrue);

    await rc3MountAndOpen(tester, r);
    expect(
      <String>[
        for (final int s in <int>[_totalMs ~/ 1000 - 1, _totalMs ~/ 1000, _totalMs ~/ 1000 + 1])
          _zh.articleCardMeta(formatEntryDuration(s * 1000), 2),
      ],
      contains(rc3TextOf(tester, const Key('article.meta'))),
    );
    expect(find.textContaining(_draft), findsOneWidget);
  });

  // ── Codex rc3 ① — THE OBLIGATION MUST BE ON DISK, NOT ONLY IN MEMORY ─────────
  //
  // Stop with the prefix at 36.8 s and the answer at 45.2 s, and the draft
  // final not in yet. Whatever loses the phone's memory now — a restart, or a
  // new recording (which rebuilds the scribe's pending tail) — leaves only the
  // manifest. It used to owe 45.2 s onward, so 36.8–45.2 s was fed by nobody
  // and the tail's settle released the whole file.

  /// A1: the S6 stop, with the live stop answered by nothing at all.
  Future<Rc3Rig> stopWithoutDraft() async {
    // The phone gives up on A's stop at 300 ms (its net), so B can start.
    final Rc3Rig r =
        // ⚠️ 更正（RC6 F2，2026-09-25）：a long recording's stop now waits for its
        // final (up to 5 min); the case needs A's wait to end, so it gets the same
        // 300 ms as a ceiling on that wait.
        await Rc3Rig.open(processingTimeout: const Duration(milliseconds: 300),
            longStopCeiling: const Duration(milliseconds: 300));
    int liveStops = 0;
    r.relay.onStop = (Rc3Stop stop) {
      if (!stop.recovery) {
        liveStops += 1;
        if (liveStops == 1) return; // A's draft never comes
        Future<void>.delayed(const Duration(milliseconds: 20), () {
          r.relay.pushIncoming(FlowMicEvents.sttFinal,
              r.relay.terminal(stop, text: '第二篇。', durationMs: 5000, segmentIdx: 0));
        });
        return;
      }
      final String heard = stop.fromMs < _answeredMs - 1000 ? '$_draft$_tail' : _tail;
      Future<void>.delayed(const Duration(milliseconds: 20), () {
        r.relay.pushIncoming(FlowMicEvents.sttFinal, r.relay.terminal(stop,
            text: heard, durationMs: stop.toMs - stop.fromMs));
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
    await r.untilAsync(() async =>
        ((await r.manifest())?.owedRanges.isNotEmpty ?? false));
    return r;
  }

  testWidgets(
      '🔴 Codex rc3 ①a: before the draft lands, the manifest (all a restart has) '
      'already owes from the settled prefix, 36.8 s', (WidgetTester tester) async {
    late final Rc3Rig r;
    late final RecordingManifest m;
    await tester.runAsync(() async {
      r = await stopWithoutDraft();
      m = (await r.manifest())!;
    });
    addTearDown(() => tester.runAsync(r.dispose));
    expect(m.owedRanges, isNotEmpty, reason: 'positive control: a tail is owed');
    expect(m.owedRanges.first.start, _prefixMs * 32,
        reason: 'owed from 45.2 s, a restart here loses 36.8–45.2 s for good');
  });

  testWidgets(
      '🔴 Codex rc3 ①b: a new recording starts before the draft lands ⇒ the '
      'first recording\'s 36.8–45.2 s is still recovered',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    late final String a;
    await tester.runAsync(() async {
      r = await stopWithoutDraft();
      a = r.articleId!;
      await Future<void>.delayed(const Duration(milliseconds: 500));
      await r.begin(); // B
      expect(r.controller.isRecording, isTrue, reason: 'positive control: B started');
      await r.feedMs(5000);
      await r.controller.pttUp();
      await r.recoveries(1);
      await r.until(() => articleMembersOf(r.timeline, a)
          .any((TimelineEntry e) => e.displayText.contains(_tail)));
    });
    addTearDown(() => tester.runAsync(r.dispose));

    final String all =
        articleMembersOf(r.timeline, a).map((TimelineEntry e) => e.displayText).join('\n');
    expect(all, contains(_draft),
        reason: 'fed from 45.2 s, these words exist nowhere once the PCM goes');
    expect(r.relay.recoveryStarts.single['range_start_sample'], _prefixMs * 16);
  });
}
