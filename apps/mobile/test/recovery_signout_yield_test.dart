// 🔴 CARD RC6 — SIGNING OUT WITH A RECOVERY IN FLIGHT IS A YIELD, NOT A
// FAILURE. MOUNTED ON THE LIST SCREEN.
//
// SPEC-REF:
//   `_dispatch/2026-09-25-cr12e-recheck5.report.md` criterion 3 (device,
//     measured): the relay never received `audio:stop {discard}` — the
//     recovery session ended when the socket went away — and the attempt was
//     written `outcome:"failed", failureCode:"engine_progress"` with a new
//     backoff. On the device the user reaches 登出 from the home screen, and
//     leaving the chat page disconnects the socket (main_page_builders.dart
//     `onBack: () => _session.transport.disconnect()`), so at sign-out the FSM
//     was no longer RECORDING/PROCESSING and the RC4 hook
//     (`recoveryHoldsWire`) found nothing to yield; the attempt then ran out
//     its engine-progress clock.
//   apps/mobile/lib/src/session/chat_ptt_lifecycle.dart
//     `stopRecordingForAccountChange`
//   apps/mobile/lib/src/ptt/ptt_backfill.dart `yieldRecoveryForAccountChange`
//   apps/mobile/lib/src/auth/login_controller.dart `_beforeAccountChange`
//
// (1) Socket up: the discard stop is sent and ACKNOWLEDGED before the account
//     is cleared and before `mobile:logout` goes out; the attempt yields (no
//     failure, no backoff, the range still owed).
// (2) Socket already gone (the page was left): the attempt is yielded anyway —
//     no failure, no backoff, the range still owed — and no stop is attempted
//     on the dead socket.
//
// Reverse controls (logs in the RC6 report): the hook's acknowledgement not
// awaited by `logout` ⇒ (1) red; the hook back on `recoveryHoldsWire` only
// ⇒ (2) red on the failed attempt; the `accountChangeOpen` refusal removed
// from `_runOnWire` ⇒ (1) red — the yield's own resume starts the stretch
// again under the outgoing account while the acknowledgement is awaited.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/session/recovery_leg_policy.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart' show LiveDraftTile;
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

const String _row0 = '先把上周的数字过一遍，然后看新的排期。';
const String _span = '这一行里有断线前后的话。';
const String _lastA = '最后一段，散会前再确认一次。';

/// A long recording under A owes a stretch; its recovery attempt holds the
/// wire (PROCESSING, the relay never answers it); the list is mounted.
Future<({Rc3Rig r, LoginController login, String a})> _recoveryInFlight(
  WidgetTester tester, {
  RecoveryTimeouts timeouts = const RecoveryTimeouts(),
  Future<void> Function(Map<String, Object?> start)? onDiscard,
}) async {
  late final Rc3Rig r;
  late final LoginController login;
  late final String a;
  await tester.runAsync(() async {
    r = await Rc3Rig.open(recoveryTimeouts: timeouts);
    login = LoginController(
      transport: r.relay,
      accountStore: InMemoryAccountStore(
          const CloudAccount(jwt: 'jwt-a', email: 'a@example.com')),
      saasEndpoint: 'https://example.invalid',
      // The closure main.dart passes.
      onBeforeAccountChange: () => r.controller.stopRecordingForAccountChange(),
    );
    await login.hydrate();
    r.spill.recordingAccount.bind(() => login.email);
    r.relay.onStop = (Rc3Stop stop) {
      if (stop.recovery) return; // the relay is still flushing
      Future<void>.delayed(const Duration(milliseconds: 20), () {
        r.relay.pushIncoming(FlowMicEvents.sttFinal,
            r.relay.terminal(stop, text: _lastA, durationMs: 20000, segmentIdx: 2));
      });
    };
    r.relay.onDiscard = onDiscard;
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
      reason: 'positive control: A\'s recovery attempt holds the wire');
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  return (r: r, login: login, a: a);
}

/// Yielded, not failed: no failure, no backoff, the range still owed.
Future<void> _expectYielded(WidgetTester tester, Rc3Rig r, String a) async {
  final RecordingManifest m = (await tester.runAsync(() async =>
      (await r.manifests()).singleWhere((RecordingManifest m) =>
          RetainedAudioSpill.sessionKeyOf(m.recordingId) == a)))!;
  expect(
      m.attempts.where((JournalAttempt x) => x.outcome == JournalAttempt.outcomeFailed),
      isEmpty,
      reason: 'the attempt was yielded, not failed');
  final RecoveryJobStatus st = RecoveryJobStatus.fromManifest(m);
  expect(st.failedAutoAttempts, 0);
  expect(st.nextEligibleAtMs, isNull, reason: 'no backoff written');
  expect(m.settled, isFalse);
  expect(m.owedRanges, isNotEmpty, reason: 'the stretch is still owed');
}

void main() {
  testWidgets(
      '🔴 (1) sign-out with the socket up: the discard stop is acknowledged '
      'before the account clears and before mobile:logout; the attempt yields',
      (WidgetTester tester) async {
    bool acked = false;
    final run = await _recoveryInFlight(tester, onDiscard: (start) async {
      if (!Rc3Relay.isRecovery(start)) return;
      // The relay takes a moment to dispose the session and answer.
      await Future<void>.delayed(const Duration(milliseconds: 150));
      acked = true;
    });
    final Rc3Rig r = run.r;
    bool? ackedWhenCleared;
    run.login.addListener(() {
      if (run.login.email == null && ackedWhenCleared == null) {
        ackedWhenCleared = acked;
      }
    });

    await tester.runAsync(() async {
      await run.login.logout();
      await r.until(() => !r.controller.backfill.isBusy);
      await Future<void>.delayed(const Duration(milliseconds: 200));
    });
    await tester.pump();

    expect(ackedWhenCleared, isTrue,
        reason: 'the discard stop is acknowledged before the account clears');
    final List<String> sent = r.relay.emittedNames;
    final int stopAt = r.relay.emitted.indexWhere((e) =>
        e.name == FlowMicEvents.audioStop &&
        e.data is Map<String, Object?> &&
        (e.data! as Map<String, Object?>)['discard'] == true);
    expect(stopAt, isNonNegative, reason: 'the discard stop reached the relay');
    expect(stopAt, lessThan(sent.indexOf(FlowMicEvents.mobileLogout)),
        reason: 'before the server is told, i.e. before the socket is torn down');
    expect(r.relay.recoveryStarts, hasLength(1), reason: 'nothing ran under nobody');
    await _expectYielded(tester, r, run.a);
    expect(find.byType(LiveDraftTile), findsNothing);
  });

  testWidgets(
      '🔴 (2) sign-out after the socket is already gone (the page was left): '
      'the attempt is yielded anyway — no failure, no backoff',
      (WidgetTester tester) async {
    final run = await _recoveryInFlight(
      tester,
      // Short enough that an attempt nobody yields fails inside this test.
      timeouts: const RecoveryTimeouts(
        engineProgress: Duration(seconds: 6),
        noProgress: Duration(seconds: 8),
      ),
    );
    final Rc3Rig r = run.r;

    await tester.runAsync(() async {
      // What leaving the chat page does (main_page_builders.dart `onBack`).
      r.relay.pushStatus(SocketStatus.disconnected);
      // The FSM holds the session through its drop grace (3 s) and then tears
      // it down; on the device 登出 is two screens away, so the grace is over.
      await r.until(() => r.session.fsm.session == SessionState.disconnected,
          max: const Duration(seconds: 6));
      expect(r.session.fsm.connection, isNot(ConnectionState.connected),
          reason: 'positive control: the link is gone');
      expect(r.session.recoveryHoldsWire, isFalse,
          reason: 'the RC4 hook\'s condition no longer holds — the device case');
      await run.login.logout();
      // Past the attempt's own engine-progress clock, which fails an attempt
      // nobody yielded.
      await Future<void>.delayed(const Duration(seconds: 5));
      await r.until(() => !r.controller.backfill.isBusy);
    });
    await tester.pump();

    expect(r.relay.events.where((String e) => e == 'discard-stop'), isEmpty,
        reason: 'no stop attempted on a socket that is gone');
    await _expectYielded(tester, r, run.a);
  });
}
