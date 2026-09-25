// 🔴 FOLLOW-UP (MAIN 2026-09-24) — A RECOVERY ATTEMPT YIELDS TO LIVE SPEECH,
// AND NO ATTEMPT OPENS WHILE A LIVE FINAL IS OWED. MOUNTED ON THE SCREEN THE
// RECORDING IS READ ON.
//
// SPEC-REF:
//   `_dispatch/2026-09-24-rc3-phone-a.report.md` open items 3 and 4 (one
//     cause: a recovery attempt and live speech contend for one wire)
//   apps/mobile/lib/src/ptt/ptt_backfill.dart `yieldRecoveryForLive`
//   apps/mobile/lib/src/audio/recovery_attempt_ledger.dart (`liveHold`,
//     `yieldWire`, the ack barrier)
//   test/support/rc3_rig.dart (the rig)
//
// (A) A long recording A owes a stretch; its recovery attempt is on the wire,
//     waiting on a relay still flushing. The user starts a new long recording
//     B. The attempt yields: `audio:stop {discard}`, its in-flight segment
//     final (the relay produced it before the stop reached it) is dropped —
//     segment finals carry no receipt, and it used to be filed under B — and
//     no failure or backoff is written. B records, stops, its final lands with
//     no recovery on the wire, and B settles and releases its audio. Then A's
//     stretch is recovered once, by an attempt of the same job and kind (card
//     RC-R derives the operation from exactly those, so the relay's
//     `meterOnce` charges it once).
// (B) A live stop's final is late (the phone's net gave up first) and a sweep
//     fires in between: no attempt opens until the live final has landed.
//
// Reverse controls (logs in the report): (A) no yield (`recoveryHoldsWire`
// false) ⇒ the press is refused; the ack barrier off ⇒ the stale words are
// filed under B; (B) the live hold off in `_runOnWire` ⇒ the recovery starts
// before the live final.

import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/session/recovery_identity.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart' show SessionState;
import 'package:flowmic/src/timeline/entry_metrics.dart' show formatEntryDuration;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/chat_article_tile.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

const String _row0 = '先把上周的数字过一遍，然后看新的排期。';
const String _span = '这一行里有断线前后的话。';
const String _hole = '断线那段时间里说过的话。';
const String _lastA = '最后一段，散会前再确认一次。';
const String _stale = '补转写还在路上的半句';
const String _b1 = '第二篇开头，今天只讲发布。';
const String _b2 = '第二篇结尾，下午四点开始灰度。';

void main() {
  testWidgets(
      '🔴 (A) a new long recording starts while a recovery attempt holds the '
      'wire ⇒ the attempt yields; its late segment final is not filed under '
      'the new recording; the new recording settles; the stretch is then '
      'recovered once, by the same job', (WidgetTester tester) async {
    late final Rc3Rig r;
    late final String a;
    late final String b;
    late final bool pressed;
    await tester.runAsync(() async {
      r = await Rc3Rig.open();
      r.relay.onStop = (Rc3Stop stop) {
        final int n = r.relay.recoveryStarts.length;
        if (!stop.recovery) {
          final bool isA = n == 0;
          Future<void>.delayed(const Duration(milliseconds: 20), () {
            r.relay.pushIncoming(
                FlowMicEvents.sttFinal,
                isA
                    ? r.relay.terminal(stop, text: _lastA, durationMs: 20000, segmentIdx: 2)
                    : r.relay.terminal(stop, text: _b2, durationMs: 10000, segmentIdx: 1));
          });
          return;
        }
        if (n == 1) return; // the first attempt's relay is still flushing
        Future<void>.delayed(const Duration(milliseconds: 20), () {
          r.relay.pushIncoming(FlowMicEvents.sttFinal,
              r.relay.terminal(stop, text: _hole, durationMs: stop.toMs - stop.fromMs));
        });
      };
      // What the relay had already produced for the attempt when the stop
      // reached it: a segment final with no receipt, arriving after the live
      // press has opened on the phone and before the stop's ack.
      r.relay.onDiscard = (Map<String, Object?> start) async {
        if (!Rc3Relay.isRecovery(start)) return;
        await Future<void>.delayed(const Duration(milliseconds: 300));
        r.relay.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
          'text': _stale, 'confidence': 0.9, 'language': 'zh',
          'segment_idx': 0, 'is_segment': true, 'duration_ms': 3000,
        });
        await Future<void>.delayed(const Duration(milliseconds: 50));
      };
      // A: 40 s row, a 30 s engine outage with 12 s replayed, 20 s more, stop.
      await r.begin();
      a = r.articleId!;
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
      // The attempt for A's stretch is on the wire, waiting.
      await r.until(() => r.relay.recoveryStarts.length == 1 &&
          r.session.recoveryHoldsWire);
      expect(r.controller.canPtt, isTrue,
          reason: 'the button is open while a recovery holds the wire');
      // B starts.
      await r.begin();
      b = r.articleId!;
      pressed = r.controller.isRecording;
      // Nothing of B's can come back before the relay has handled the stop
      // (ordered socket): let the in-flight frame land first.
      await Future<void>.delayed(const Duration(milliseconds: 450));
      await r.feedMs(20000);
      await r.segment(_b1, 0, 20000);
      await r.feedMs(10000);
      await r.controller.pttUp();
      await r.recoveries(2);
      await r.until(() =>
          articleMembersOf(r.timeline, a).any((TimelineEntry e) => e.displayText == _hole));
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(pressed, isTrue, reason: 'the press was taken, not refused');
    final List<Map<String, Object?>> stops = <Map<String, Object?>>[
      for (final e in r.relay.emittedWhere(FlowMicEvents.audioStop))
        if (e.data is Map<String, Object?>) e.data! as Map<String, Object?>,
    ];
    expect(stops.where((Map<String, Object?> s) => s['discard'] == true), hasLength(1),
        reason: 'the attempt was thrown away on the relay, not finished');

    // (1) Nothing of the yielded attempt reached any row.
    expect(r.timeline.entries.map((TimelineEntry e) => e.displayText).join('\n'),
        isNot(contains(_stale)),
        reason: 'a segment final carries no receipt; it used to be filed under B');
    // B: its own words, its own clock.
    final List<TimelineEntry> rowsB = articleMembersOf(r.timeline, b);
    expect(rowsB.map((TimelineEntry e) => e.displayText).toList(), <String>[_b1, _b2]);
    expect(rowsB.map((TimelineEntry e) => e.articleOffsetMs).toList(), <int>[0, 20000]);
    // (2) B's final landed with no recovery on the wire: B settles and its
    // audio goes.
    final List<RecordingManifest> ms =
        (await tester.runAsync<List<RecordingManifest>>(r.manifests))!;
    final RecordingManifest mb = ms.singleWhere(
        (RecordingManifest m) => RetainedAudioSpill.sessionKeyOf(m.recordingId) == b);
    expect(mb.settled, isTrue);
    expect(r.pcmOf(mb.recordingId), isFalse);
    // A: recovered once, placed where it was said, no failure on the way.
    final RecordingManifest ma = ms.singleWhere(
        (RecordingManifest m) => RetainedAudioSpill.sessionKeyOf(m.recordingId) == a);
    expect(articleMembersOf(r.timeline, a).where((TimelineEntry e) => e.displayText == _hole),
        hasLength(1));
    expect(r.timeline.findByClientId(a)!.durationMs, 105000, reason: 'A still reads 1:45');
    expect(ma.settled, isTrue);
    expect(ma.attempts.where((JournalAttempt x) => x.outcome == JournalAttempt.outcomeFailed),
        isEmpty, reason: 'yielding is not a failure');
    expect(RecoveryJobStatus.fromManifest(ma).failedAutoAttempts, 0);
    final List<Map<String, Object?>> rec = r.relay.recoveryStarts;
    expect(rec, hasLength(2), reason: 'the yielded attempt and the one that resumed');
    expect(rec[1]['job_id'], rec[0]['job_id']);
    expect(rec[1]['attempt_kind'], RecoveryAttemptKind.autoRetry.wire,
        reason: 'same job and kind ⇒ the same derived operation (RC-R): billed once');

    // The screen B is read on.
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tap(find.ancestor(
        of: find.textContaining(_b1.substring(0, 6)),
        matching: find.byType(ChatArticleTile)));
    await tester.pumpAndSettle();
    expect(find.byType(ArticlePage), findsOneWidget);
    expect(
      <String>[for (final int s in <int>[29, 30, 31]) _zh.articleCardMeta(formatEntryDuration(s * 1000), 2)],
      contains(rc3TextOf(tester, const Key('article.meta'))),
    );
    expect(find.textContaining(_stale), findsNothing);
  });

  testWidgets(
      '🔴 Codex rc3 ⑤ (phone half): the yielded attempt was already flushing, '
      'and its terminal stt:error arrives after the new recording started ⇒ '
      'the new recording keeps recording', (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await Rc3Rig.open();
      r.relay.onStop = (Rc3Stop stop) {
        final int n = r.relay.recoveryStarts.length;
        if (!stop.recovery && n == 0) {
          Future<void>.delayed(const Duration(milliseconds: 20), () {
            r.relay.pushIncoming(FlowMicEvents.sttFinal,
                r.relay.terminal(stop, text: _lastA, durationMs: 20000, segmentIdx: 2));
          });
        }
        // The recovery's flush never answers with words.
      };
      // What the flush sends before the relay has handled the discard: its
      // flush cap ran out, a terminal error with no session named on it.
      r.relay.onDiscard = (Map<String, Object?> start) async {
        if (!Rc3Relay.isRecovery(start)) return;
        await Future<void>.delayed(const Duration(milliseconds: 300));
        r.relay.pushIncoming(FlowMicEvents.sttError, <String, Object?>{
          'code': 'STT_NETWORK_DROP',
          'message': 'flush cap reached',
          'retryable': false,
        });
        await Future<void>.delayed(const Duration(milliseconds: 50));
      };
      await r.begin();
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
      await r.until(() => r.relay.recoveryStarts.length == 1 &&
          r.session.recoveryHoldsWire &&
          r.session.fsm.session == SessionState.processing);
      await r.begin(); // B, while the attempt waits on its flush
      expect(r.controller.isRecording, isTrue, reason: 'positive control');
      await Future<void>.delayed(const Duration(milliseconds: 600));
    });
    addTearDown(() => tester.runAsync(() async {
          await r.controller.pttUp();
          await r.dispose();
        }));

    expect(r.session.continuous.isActive, isTrue,
        reason: 'the flush\'s error stopped the new recording');
    expect(r.controller.isRecording, isTrue);
  });

  testWidgets(
      '🔴 (B) the phone gave up on a live stop before its final came, and a '
      'sweep fires in between ⇒ no recovery opens until the live final has '
      'landed', (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await Rc3Rig.open(processingTimeout: const Duration(milliseconds: 300));
      // Debt from an earlier run: an orphan recording's audio, owed whole.
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: r.store.dirPath,
        recordingId: 'orphan-1',
        fs: r.fs,
        configSnapshot: const <String, Object?>{
          kConfigSnapshotMode: 'realtime',
          kConfigSnapshotSourceLang: 'zh',
          kConfigSnapshotPrefsDigest: '',
        },
        commitInterval: const Duration(days: 1),
      );
      await j.appendPcm(Uint8List(5 * 32000));
      await j.close();
      r.relay.onStop = (Rc3Stop stop) {
        if (!stop.recovery) {
          Future<void>.delayed(const Duration(milliseconds: 1500), () {
            r.relay.events.add('live-final');
            r.relay.pushIncoming(FlowMicEvents.sttFinal,
                r.relay.terminal(stop, text: _b2, durationMs: 10000, segmentIdx: 1));
          });
          return;
        }
        Future<void>.delayed(const Duration(milliseconds: 20), () {
          r.relay.pushIncoming(FlowMicEvents.sttFinal,
              r.relay.terminal(stop, text: _hole, durationMs: stop.toMs - stop.fromMs));
        });
      };
      await r.begin();
      await r.feedMs(20000);
      await r.segment(_b1, 0, 20000);
      await r.feedMs(10000);
      await r.controller.pttUp();
      // The net gives up at 300 ms; a sweep (the retry timer, a link edge) at
      // 700 ms finds the session at rest.
      await Future<void>.delayed(const Duration(milliseconds: 700));
      await r.controller.backfill.sweep(sourceLang: 'zh');
      await r.recoveries(1);
      await r.until(() => r.timeline.entries.any((TimelineEntry e) => e.displayText == _hole));
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.events.where((String e) => e != 'live-start').toList(),
        <String>['live-final', 'recovery-start'],
        reason: 'a live final landing while a recovery holds the wire is filed '
            'as a foreign frame and its live settle does not run');
    final RecordingManifest mb = (await tester.runAsync<List<RecordingManifest>>(r.manifests))!
        .singleWhere((RecordingManifest m) =>
            RetainedAudioSpill.sessionKeyOf(m.recordingId) == r.articleId);
    expect(mb.liveSettlePendingAtMs, isNull, reason: 'the live settle ran');
    expect(RecoveryQueueState.isTerminalSettle(RecoveryQueueState.normalise(mb.recoveryState)),
        isTrue, reason: 'nothing left for the recovery queue to take again');
    expect(r.relay.recoveryStarts.single['recording_id'], 'orphan-1',
        reason: 'the live recording is not re-transcribed');

    await rc3MountAndOpen(tester, r);
    expect(find.textContaining(_b2), findsOneWidget);
  });
}
