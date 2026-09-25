// 🔴 CARD RC4 FOLLOW-UP (MAIN 2026-09-25) — A RECOVERY PASS RUNNING UNDER ONE
// ACCOUNT IS THROWN AWAY WHEN THE ACCOUNT CHANGES, AND RUNS AGAIN ONLY UNDER
// ITS OWN ACCOUNT. MOUNTED ON THE LIST SCREEN.
//
// SPEC-REF:
//   `_dispatch/2026-09-25-rc4-phantom-press.report.md` open item 2 and its
//     follow-up section (MAIN: a recovery kept running across sign-out
//     reopens the RC-S cross-account hole)
//   apps/mobile/lib/src/session/chat_ptt_lifecycle.dart
//     `stopRecordingForAccountChange` (the hook main.dart wires to
//     `LoginController.onBeforeAccountChange`)
//   apps/mobile/lib/src/ptt/ptt_backfill.dart `yieldRecoveryForLive` (the one
//     way off the wire: discard stop, ack barrier, refusal without failure)
//   apps/mobile/lib/src/audio/recording_account.dart `recordingOwnerOf` (RC-S)
//
// A long recording made under A owes a stretch; its recovery attempt holds the
// wire, waiting on a relay still flushing. A signs out:
//   · `audio:stop {discard}` is sent before the account is cleared;
//   · what the relay had already produced for the attempt (a segment final and
//     an interim, pushed before the stop's ack) is not processed;
//   · no failure, no backoff, the range stays owed;
//   · with nobody signed in, and then with B, no attempt opens;
//   · positive control: once A is the account again, the stretch is recovered
//     by the same job.
//
// "B signs in" and "A signs in again" are the account source the recording
// binding reads (main.dart binds it to `LoginController.email`), set by the
// test: the real sign-in needs a relay handshake this rig does not fake, and
// the RC-S gate reads nothing else.
//
// Reverse control (log in the RC4 report): the recovery branch removed from
// `stopRecordingForAccountChange` ⇒ red on "discard stop before the account
// is cleared".

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart' show LiveDraftTile;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

const String _row0 = '先把上周的数字过一遍，然后看新的排期。';
const String _span = '这一行里有断线前后的话。';
const String _lastA = '最后一段，散会前再确认一次。';
const String _hole = '断线那段时间里说过的话。';
const String _stale = '账号切换前还在路上的半句';
const String _staleInterim = '账号切换前还在路上的预览';

void main() {
  testWidgets(
      '🔴 sign-out while a recovery attempt holds the wire ⇒ discard stop '
      'before the account clears, its late frames dropped, the range still '
      'owed with no failure, no attempt under nobody or B; A again ⇒ recovered',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    late final LoginController login;
    late final String a;
    String? nextAccount;
    await tester.runAsync(() async {
      r = await Rc3Rig.open();
      login = LoginController(
        transport: r.relay,
        accountStore: InMemoryAccountStore(
            const CloudAccount(jwt: 'jwt-a', email: 'a@example.com')),
        saasEndpoint: 'https://example.invalid',
        // The closure main.dart passes.
        onBeforeAccountChange: () => r.controller.stopRecordingForAccountChange(),
      );
      await login.hydrate();
      r.spill.recordingAccount.bind(() => login.email ?? nextAccount);

      r.relay.onStop = (Rc3Stop stop) {
        if (!stop.recovery) {
          Future<void>.delayed(const Duration(milliseconds: 20), () {
            r.relay.pushIncoming(FlowMicEvents.sttFinal,
                r.relay.terminal(stop, text: _lastA, durationMs: 20000, segmentIdx: 2));
          });
          return;
        }
        // The first attempt's relay is still flushing when A signs out; the
        // attempt that runs under A again is answered.
        if (r.relay.recoveryStarts.length == 1) return;
        Future<void>.delayed(const Duration(milliseconds: 20), () {
          r.relay.pushIncoming(FlowMicEvents.sttFinal,
              r.relay.terminal(stop, text: _hole, durationMs: stop.toMs - stop.fromMs));
        });
      };
      // What the relay had produced for the attempt before the discard stop
      // reached it: pushed before the ack (the socket is ordered).
      r.relay.onDiscard = (Map<String, Object?> start) async {
        if (!Rc3Relay.isRecovery(start)) return;
        await Future<void>.delayed(const Duration(milliseconds: 100));
        r.relay.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
          'text': _staleInterim, 'segment_idx': 0,
        });
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
      await r.until(() =>
          r.relay.recoveryStarts.length == 1 && r.session.recoveryHoldsWire);
    });
    addTearDown(() => tester.runAsync(() async {
          login.dispose();
          await r.dispose();
        }));
    expect(r.session.recoveryHoldsWire, isTrue,
        reason: 'positive control: a recovery attempt of A is on the wire');

    // The screen the user is on.
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    bool? discardSentWhenCleared;
    bool? wireHeldWhenCleared;
    login.addListener(() {
      if (login.email == null && discardSentWhenCleared == null) {
        discardSentWhenCleared = r.relay.events.contains('discard-stop');
        wireHeldWhenCleared = r.session.recoveryHoldsWire;
      }
    });

    await tester.runAsync(() async {
      await login.logout();
      // Let the ack barrier pass, the leg return, and any resumed pass run.
      await Future<void>.delayed(const Duration(milliseconds: 400));
      await r.until(() => !r.controller.backfill.isBusy);
      await Future<void>.delayed(const Duration(milliseconds: 200));
      await r.until(() => !r.controller.backfill.isBusy);
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    // (1) Thrown away before the account went.
    expect(discardSentWhenCleared, isTrue,
        reason: 'discard stop before the account is cleared');
    expect(wireHeldWhenCleared, isFalse,
        reason: 'the attempt no longer held the wire when the account cleared');
    final List<String> ev = r.relay.events;
    expect(ev.where((String e) => e == 'discard-stop'), hasLength(1));
    expect(ev.last, 'discard-stop',
        reason: 'nothing started on the wire after it (no attempt under nobody)');

    // (2) Its late frames were not processed.
    expect(
        r.timeline.entries.map((TimelineEntry e) => e.displayText).join('\n'),
        isNot(contains(_stale)));
    expect(r.session.segments.unsettledJoined, isNot(contains(_staleInterim)));
    expect(find.byType(LiveDraftTile), findsNothing);
    expect(find.textContaining(_staleInterim), findsNothing);
    expect(find.textContaining(_zh.pttRecording), findsNothing);

    // (3) No failure, no backoff, the range still owed.
    Future<RecordingManifest> manifestA() async => (await r.manifests())
        .singleWhere((RecordingManifest m) =>
            RetainedAudioSpill.sessionKeyOf(m.recordingId) == a);
    final RecordingManifest m1 = (await tester.runAsync(manifestA))!;
    expect(m1.settled, isFalse);
    expect(m1.owedRanges, isNotEmpty, reason: 'the stretch is still owed');
    expect(
        m1.attempts.where((JournalAttempt x) => x.outcome == JournalAttempt.outcomeFailed),
        isEmpty,
        reason: 'thrown away is not failed');
    final RecoveryJobStatus st = RecoveryJobStatus.fromManifest(m1);
    expect(st.failedAutoAttempts, 0);
    expect(st.nextEligibleAtMs, isNull, reason: 'no backoff');

    // (4) B signs in: A's stretch does not run under B.
    await tester.runAsync(() async {
      nextAccount = 'b@example.com';
      await r.controller.backfill.sweep(sourceLang: 'zh');
      await r.until(() => !r.controller.backfill.isBusy);
    });
    expect(r.relay.recoveryStarts, hasLength(1), reason: 'no attempt under B');

    // (5) Positive control: A again ⇒ the same job recovers the stretch once.
    await tester.runAsync(() async {
      nextAccount = 'a@example.com';
      await r.controller.backfill.sweep(sourceLang: 'zh');
      await r.recoveries(2);
      await r.until(() => articleMembersOf(r.timeline, a)
          .any((TimelineEntry e) => e.displayText == _hole));
    });
    final List<Map<String, Object?>> rec = r.relay.recoveryStarts;
    expect(rec, hasLength(2));
    expect(rec[1]['job_id'], rec[0]['job_id']);
    expect(rec[1]['range_start_sample'], rec[0]['range_start_sample']);
    expect(rec[1]['range_end_sample'], rec[0]['range_end_sample']);
    expect(
        articleMembersOf(r.timeline, a).where((TimelineEntry e) => e.displayText == _hole),
        hasLength(1));
    final RecordingManifest m2 = (await tester.runAsync(manifestA))!;
    expect(m2.settled, isTrue);
  });
}
