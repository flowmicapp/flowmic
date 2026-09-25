// 🔴 CARD RC5 — A RECOVERY ATTEMPT STILL PREPARING WHEN THE ACCOUNT CHANGES
// NEVER REACHES THE WIRE.
//
// SPEC-REF:
//   `_dispatch/2026-09-25-codex-review-rc4.out.md` item 3 (P1): the RC4
//     follow-up cancels only an attempt that already holds the wire. An
//     attempt that passed its RC-S account check and is awaiting its journal
//     commit is not on the wire yet, so the account change finds nothing to
//     yield, and `_runOnWire` did not ask about the account again.
//   apps/mobile/lib/src/session/chat_ptt_lifecycle.dart
//     `stopRecordingForAccountChange` (the account-change hook)
//   apps/mobile/lib/src/session/recovery_leg_wire.dart `_runOnWire` (the last
//     check before `audio:start`)
//
// A long recording made under A owes a stretch. A sweep under A passes the
// account check, and its attempt blocks on the journal commit (the rig's gated
// filesystem). A signs out through the real `LoginController` (the hook
// main.dart wires), B becomes the account the recording binding reads, the
// link stays up, then the commit is released:
//   · no recovery `audio:start` is emitted;
//   · no failure, no backoff, the range stays owed;
//   · positive control: under A again, a sweep does start the attempt.
//
// Two more cases pin each half of the fix on its own: A signs out and A signs
// in again before the commit lands (the account reads the same, only the
// cancellation can refuse), and the binding changes with no hook call at all
// (only the account recheck can refuse).
//
// Reverse controls (logs in the RC5 report): both halves removed ⇒ case 1
// red; the cancellation removed ⇒ case 2 red; the recheck removed ⇒ case 3
// red. Case 1 also reproduced red on integ `1e5f8f0f` before the fix.
//
// "B is signed in" is the account source the binding reads (main.dart binds it
// to `LoginController.email`), set by the test: the real sign-in needs a relay
// handshake this rig does not fake, and the RC-S gate reads nothing else.

import 'dart:async';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

const String _row0 = '先把上周的数字过一遍，然后看新的排期。';
const String _span = '这一行里有断线前后的话。';
const String _lastA = '最后一段，散会前再确认一次。';
const String _hole = '断线那段时间里说过的话。';

/// One run: a long recording under A owes a stretch; a sweep under A passes
/// the account check and blocks on its journal commit; [change] happens; the
/// commit is released. Returns the rig, the article and the account source
/// setter, with the rig still open (the caller tears it down).
Future<({Rc3Rig r, String a, void Function(String?) setNext})> _blockedThenChanged(
  WidgetTester tester,
  Future<void> Function(LoginController login, void Function(String?) setNext,
          void Function(String?) setHeld)
      change,
) async {
  late final Rc3Rig r;
  late final LoginController login;
  late final String a;
  // Who the recording binding answers: an override, else the signed-in
  // account, else the account that signed in after it.
  String? heldAs;
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
    r.spill.recordingAccount.bind(() => heldAs ?? login.email ?? nextAccount);
    r.relay.onStop = (Rc3Stop stop) {
      if (stop.recovery) return;
      Future<void>.delayed(const Duration(milliseconds: 20), () {
        r.relay.pushIncoming(FlowMicEvents.sttFinal,
            r.relay.terminal(stop, text: _lastA, durationMs: 20000, segmentIdx: 2));
      });
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
    // The recording-end sweep must not take the stretch before the test is
    // ready to block it: while the live stop settles, the binding answers a
    // third account, and RC-S holds the recording.
    heldAs = 'c@example.com';
    await r.controller.pttUp();
    await r.until(() => r.rows.any((TimelineEntry e) => e.displayText == _lastA));
    await r.until(() => !r.controller.backfill.isBusy);
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(r.relay.recoveryStarts, isEmpty,
        reason: 'setup: nothing ran while the recording was held');
    expect(r.fs.blocked, isFalse, reason: 'setup: no write in flight');

    // A sweep under A passes the account check and blocks on the commit.
    heldAs = null;
    r.fs.gate = Completer<void>();
    unawaited(r.controller.backfill.sweep(sourceLang: 'zh'));
    await r.until(() => r.fs.blocked, max: const Duration(seconds: 10));
    expect(r.fs.blocked, isTrue,
        reason: 'positive control: the attempt is preparing, blocked on a write');
    expect(r.session.recoveryHoldsWire, isFalse,
        reason: 'not on the wire yet — the case the RC4 follow-up missed');

    await change(login, (String? v) => nextAccount = v, (String? v) => heldAs = v);

    // The link stays connected; the commit goes through.
    final Completer<void> g = r.fs.gate!;
    r.fs.gate = null;
    g.complete();
    await Future<void>.delayed(const Duration(milliseconds: 300));
    await r.until(() => !r.controller.backfill.isBusy);
  });
  addTearDown(() => tester.runAsync(() async {
        login.dispose();
        await r.dispose();
      }));
  return (
    r: r,
    a: a,
    setNext: (String? v) {
      heldAs = null;
      nextAccount = v;
    },
  );
}

Future<RecordingManifest> _manifestOf(Rc3Rig r, String a) async =>
    (await r.manifests()).singleWhere((RecordingManifest m) =>
        RetainedAudioSpill.sessionKeyOf(m.recordingId) == a);

/// No failure, no backoff, the range still owed.
Future<void> _expectStillOwed(WidgetTester tester, Rc3Rig r, String a) async {
  final RecordingManifest m = (await tester.runAsync(() => _manifestOf(r, a)))!;
  expect(m.settled, isFalse);
  expect(m.owedRanges, isNotEmpty, reason: 'the stretch is still owed');
  expect(
      m.attempts.where((JournalAttempt x) => x.outcome == JournalAttempt.outcomeFailed),
      isEmpty,
      reason: 'refused, not failed');
  final RecoveryJobStatus st = RecoveryJobStatus.fromManifest(m);
  expect(st.failedAutoAttempts, 0);
  expect(st.nextEligibleAtMs, isNull, reason: 'no backoff');
}

/// Positive control: under A the same stretch does start, and settles.
Future<void> _expectRecoversUnderA(
    WidgetTester tester, Rc3Rig r, String a, void Function(String?) setNext) async {
  await tester.runAsync(() async {
    setNext('a@example.com');
    r.relay.onStop = (Rc3Stop stop) {
      if (!stop.recovery) return;
      Future<void>.delayed(const Duration(milliseconds: 20), () {
        r.relay.pushIncoming(FlowMicEvents.sttFinal,
            r.relay.terminal(stop, text: _hole, durationMs: stop.toMs - stop.fromMs));
      });
    };
    await r.controller.backfill.sweep(sourceLang: 'zh');
    await r.recoveries(1);
  });
  expect(r.relay.recoveryStarts, hasLength(1),
      reason: 'positive control: the probe can see an attempt start');
  final RecordingManifest m = (await tester.runAsync(() => _manifestOf(r, a)))!;
  expect(m.settled, isTrue, reason: 'and it recovers under its own account');
}

void main() {
  testWidgets(
      '🔴 (1) an attempt blocked on its journal commit after the account check '
      'does not start once A has signed out and B is the account',
      (WidgetTester tester) async {
    final run = await _blockedThenChanged(tester, (login, setNext, _) async {
      await login.logout();
      setNext('b@example.com');
    });
    expect(run.r.relay.recoveryStarts, isEmpty,
        reason: 'A\'s recording must not start through B\'s session');
    await _expectStillOwed(tester, run.r, run.a);
    await _expectRecoversUnderA(tester, run.r, run.a, run.setNext);
  });

  testWidgets(
      '🔴 (2) the account change cancels a preparing attempt even when the same '
      'account is signed in again before it would start',
      (WidgetTester tester) async {
    final run = await _blockedThenChanged(tester, (login, setNext, _) async {
      await login.logout();
      setNext('a@example.com');
    });
    expect(run.r.relay.recoveryStarts, isEmpty,
        reason: 'the attempt prepared before the change does not start');
    await _expectStillOwed(tester, run.r, run.a);
    await _expectRecoversUnderA(tester, run.r, run.a, run.setNext);
  });

  testWidgets(
      '🔴 (3) the account is asked again right before audio:start, even when '
      'no account-change hook ran', (WidgetTester tester) async {
    final run = await _blockedThenChanged(tester, (_, _, setHeld) async {
      setHeld('b@example.com');
    });
    expect(run.r.relay.recoveryStarts, isEmpty,
        reason: 'the recording\'s account is not the current one');
    await _expectStillOwed(tester, run.r, run.a);
    await _expectRecoversUnderA(tester, run.r, run.a, run.setNext);
  });
}