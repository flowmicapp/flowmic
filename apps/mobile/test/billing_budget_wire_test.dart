// Card S2-02 — IS THE `billing:budget` PATH REALLY WIRED, END TO END ON THIS PHONE.
//
// 🔴 WHY THIS FILE EXISTS, in the shape `p8_engine_status_wire_test.dart`
// established. A test that drove `CloudSummaryController.applyBudget` directly
// would stay green with the whole `case FlowMicEvents.billingBudget:` arm
// deleted, because an event eaten by `_onIncomingRouted`'s `default: break;`
// does not error, does not log and leaves no symbol to grep — anti-façade ①'s
// "the fault has no new symbol, only an empty value". So this walks the real
// chain: a real `PttSession`, its real dispatch loop, its real public stream,
// and the real controller the settings gauge reads.
//
// The only stand-in is the socket transport, because "the relay sent a frame"
// is exactly what arrives there on a device.
//
// 🔴 WHAT THIS FILE DELIBERATELY DOES NOT CLAIM. It does not prove anything is
// PAINTED. `quota_gauge.dart`'s own lesson (0.2.53) is that a copy assertion
// must land on the rendered result — but this card renders no new copy: it
// moves a number the existing gauge already knows how to draw, and the gauge's
// arithmetic is pinned by `quota_gauge_test.dart`. What was missing was the
// path, and the path is what is asserted here.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/cloud_summary_controller.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/signaling/inbound_payloads.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/cloud_summary_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/mic_permission_fakes.dart';

const String kEndpoint = 'ws://192.168.1.5:41879';

/// The frame `apps/server-core/src/billing/budget-push.ts` builds, verbatim.
/// A free account with 20 minutes a month, 90 seconds of which are left.
Map<String, Object?> frame({
  Object? remainingMs = 90000,
  String mode = 'plan',
  Object? resetsAt = 1800000000000,
  String reason = 'heartbeat',
  bool exhausted = false,
}) => <String, Object?>{
  'remaining_ms': remainingMs,
  'mode': mode,
  'resets_at': resetsAt,
  'reason': reason,
  if (exhausted) 'exhausted': true,
};

void main() {
  late FakeSocketTransport transport;
  late PttSession session;
  late LoginController login;
  late CloudSummaryController summary;

  setUp(() {
    transport = FakeSocketTransport()..connectSucceeds = true;
    session = PttSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(),
      tokenStorage: InMemoryTokenStorage(),
      micPermission: newTestMicPermission(),
    );
    // RV-89 precedent: a real server that happens to be listening on the dev
    // machine must not get to answer for this fixture.
    session.healthReader =
        (Uri url, Duration timeout) async => HealthReading.offline;
    login = newTestLogin(
      transport: FakeSocketTransport(),
      accountStore: InMemoryAccountStore(const CloudAccount(
        jwt: 'jwt-budget', email: 'budget@example.com', plan: 'free',
      )),
    );
    summary = newTestCloudSummary(login: login);
  });

  tearDown(() {
    summary.dispose();
    login.dispose();
    session.dispose();
  });

  test('① a billing:budget frame off the socket reaches the session stream', () async {
    final Future<BillingBudget> first = session.billingBudget.first;
    transport.pushIncoming('billing:budget', frame());
    final BillingBudget got = await first.timeout(const Duration(seconds: 2));
    expect(got.remainingMs, 90000);
    expect(got.mode, 'plan');
    expect(got.reason, 'heartbeat');
    expect(got.exhausted, isFalse);
    expect(got.resetsAt, DateTime.fromMillisecondsSinceEpoch(1800000000000, isUtc: true));
  });

  test('② the whole chain: a frame moves the number the settings gauge draws', () async {
    // A prior read is the PRECONDITION, not a convenience: the frame carries
    // what is LEFT and the gauge needs a ceiling to place it against.
    summary.applyBudget(const BillingBudget(
      remainingMs: 90000, mode: 'plan', resetsAt: null,
    ));
    expect(summary.summary, isNull,
        reason: 'positive control: with no ceiling on screen the frame must change nothing, '
            'or case ③ below would be vacuously true');

    // The composition root passes exactly this: the controller OWNS the
    // subscription, so nothing between the socket and the gauge is stubbed.
    final CloudSummaryController live = newTestCloudSummary(
      login: login,
      fetcher: fixedCloudSummary(testSummary(usedMin: 0, limitMin: 20)),
      budgetFeed: session.billingBudget,
    );
    addTearDown(live.dispose);
    await login.hydrate(); // the signed-in transition; refresh() rides it
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(live.summary?.minutes?.used, 0, reason: 'the fixture read must have landed first');

    transport.pushIncoming('billing:budget', frame(remainingMs: 90000));
    await Future<void>.delayed(const Duration(milliseconds: 20));

    // 20 minutes with 90 s left ⇒ 18.5 spent. Derived from the frame, not from
    // a second HTTP read: this is the number the gauge draws.
    expect(live.summary?.minutes?.used, closeTo(18.5, 0.001));
    expect(live.summary?.minutes?.limit, 20);
    expect(live.summary?.resetsAt,
        DateTime.fromMillisecondsSinceEpoch(1800000000000, isUtc: true));
  });

  test('③ remaining_ms:null is "this relay does not meter", never zero', () async {
    // 🔴 The mapping that would be silently wrong: reading null as 0 paints a
    // spent meter on a self-hosted install that has no billing at all.
    final CloudSummaryController live = newTestCloudSummary(
      login: login,
      fetcher: fixedCloudSummary(testSummary(usedMin: 3, limitMin: 20)),
    );
    addTearDown(live.dispose);
    await login.hydrate();
    await Future<void>.delayed(const Duration(milliseconds: 20));

    live.applyBudget(const BillingBudget(
      remainingMs: null, mode: 'plan', resetsAt: null,
    ));
    expect(live.summary?.minutes?.used, 3, reason: 'an unmetered relay must not move this account\'s meter');
  });

  test('④ an unreadable frame is dropped whole, never half-applied', () {
    // `mode` missing ⇒ the reading has no provenance. Parsed to null and
    // dropped by the dispatch arm; asserted on the parser because the arm's
    // own drop is what case ① and ② would notice.
    expect(BillingBudget.tryFromJson(<String, Object?>{'remaining_ms': 1}), isNull);
    // A non-null, non-numeric remainder is a BROKEN frame, not an unmetered
    // one — dropping it is what keeps a parser bug from reading as "no quota".
    expect(
      BillingBudget.tryFromJson(<String, Object?>{'remaining_ms': 'lots', 'mode': 'plan'}),
      isNull,
    );
    // `resets_at: null` is legal and means "no cycle" — the frame survives.
    final BillingBudget? ok = BillingBudget.tryFromJson(
      <String, Object?>{'remaining_ms': 5, 'mode': 'plan', 'resets_at': null},
    );
    expect(ok, isNotNull);
    expect(ok!.resetsAt, isNull);
  });

  test('⑤ the exhaustion frame is carried as its own flag, not inferred from zero', () async {
    final Future<BillingBudget> first = session.billingBudget.first;
    transport.pushIncoming(
      'billing:budget',
      frame(remainingMs: 0, reason: 'exhausted', exhausted: true),
    );
    final BillingBudget got = await first.timeout(const Duration(seconds: 2));
    expect(got.exhausted, isTrue);
    expect(got.remainingMs, 0);
    // 🔴 AND IT CHANGES NOTHING ELSE. The refusal has two owners already
    // (stt:error{QUOTA_EXCEEDED} and audio:auto-stopped{quota_exhausted}); this
    // flag must never become a third. If a future change makes the phone act on
    // it, that is a decision, and this line is where it has to be argued.
  });
}
