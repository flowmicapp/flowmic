// 2026-08-18 — the instance list's REACH probe: retry, hysteresis, and not
// throwing away an answer while asking for the next one.
//
// SPEC-REF:
//   lib/src/session/instance_probe.dart ([HealthMiss], [readHealthRetrying],
//     [kInstanceListReachBudget], [kReachMissesBeforeOffline], and the measured
//     table above the pooled probe client)
//   lib/src/session/connections_controller.dart (`_reachVerdict`, `_probeOne`,
//     `refreshReachability`)
//   lib/src/session/pc_presence.dart ([instanceLivenessFaceOf])
//
// ── WHAT WENT WRONG, AND WHY THE WHOLE SUITE WAS GREEN THROUGH IT ───────────
// owner reported the cloud-relay and cloud-light-record rows flapping between
// online and offline, and sometimes sticking at offline. Measured on the tablet
// (TB335ZC, office Wi-Fi, direct — no proxy — 2026-08-18, 80 samples of exactly
// the request `httpHealthRead` makes):
//
//   fresh connection every probe : p50 1.14 s  p90 2.68 s  p95 3.37 s  max 8.53 s
//   the same 80, minus TCP+TLS   : p50 0.55 s  p90 1.25 s  p95 1.43 s  max 1.90 s
//   past the probe's 3 s budget  : 7.5 %                             →  0 of 80
//   the same tablet, same minute, to a domestic host: p50 0.092 s, nothing > 2 s
//
// So: the path was good enough to answer every single one of those 80 requests,
// and the probe was calling it 「离线」("offline") several times an hour — because
// it paid a fresh TCP+TLS handshake on every tick, asked exactly once, and had
// one word for 「it is not serving」 and 「we did not get an answer」.
//
// 🔴 None of that was visible to a test, and that is the part worth keeping:
// every fake reader in this suite answers INSTANTLY and DETERMINISTICALLY. A
// handshake cost, a per-attempt budget and a retry are all invisible to a double
// that returns on the same microtask — the same shape as 0.2.35's 「the channel
// probe never went out」 (13 册 §7 / vol. 13 §7): the defect lived entirely in
// the layer the doubles replace. What CAN be pinned here is the DECISION LOGIC,
// and that is what this file pins. The cost half is pinned by the measurement
// above, taken on a real device, and by nothing else in this repository.

import 'dart:async';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

const String kSaas = 'https://saas.test:443';
const HealthReading up = HealthReading(ok: true, channel: ServerChannel.cloudRelay);
const HealthReading timedOut = HealthReading.missed(HealthMiss.timeout);
const HealthReading netDown = HealthReading.missed(HealthMiss.network);
const HealthReading served502 = HealthReading.missed(HealthMiss.http);

/// A budget with no waiting in it — the retry COUNT is what these cases are
/// about, and a real backoff would only make the suite slower.
const HealthRetryBudget instant3 = HealthRetryBudget(
  attempts: 3,
  perAttemptTimeout: Duration(milliseconds: 5),
  backoff: <Duration>[Duration.zero, Duration.zero],
);

void main() {
  late PttSession session;
  late LoginController login;
  late ConnectionsController ctl;

  /// Swappable per test AND between rounds — the second half of this file needs
  /// round 1 to answer and round 2 to hang.
  late Future<HealthReading> Function() health;
  late Future<PcPresenceReading> Function() presence;

  setUp(() {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    session = PttSession(
      transport: t,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(),
      tokenStorage: InMemoryTokenStorage(),
    );
    login = LoginController(
      transport: t,
      accountStore: InMemoryAccountStore(),
      saasEndpoint: kSaas,
    );
    health = () async => HealthReading.offline;
    presence = () async => const PcPresenceReading.unanswered(PcPresenceMiss.timeout);
    ctl = ConnectionsController(
      session: session,
      login: login,
      saasEndpoint: kSaas,
      healthReader: (Uri url, Duration timeout) => health(),
      presenceReader: (Uri url, String token, Duration timeout) => presence(),
    );
  });

  tearDown(() async {
    ctl.dispose();
    login.dispose();
    await session.dispose();
  });

  InstanceReach reach() => ctl.reachOf(kSaas);

  group('readHealthRetrying — asks again only when that could change the answer', () {
    test('a retryable miss is retried, and the answer that lands wins', () async {
      int calls = 0;
      final HealthReading r = await readHealthRetrying(
        Uri.parse('$kSaas/api/health'),
        budget: instant3,
        reader: (Uri url, Duration timeout) async {
          calls++;
          return calls < 3 ? timedOut : up;
        },
      );
      expect(r.ok, isTrue);
      expect(calls, 3, reason: 'both misses were retryable, so both were retried');
    });

    test('a SERVED refusal is not retried — the server answered, it said no', () async {
      int calls = 0;
      final HealthReading r = await readHealthRetrying(
        Uri.parse('$kSaas/api/health'),
        budget: instant3,
        reader: (Uri url, Duration timeout) async {
          calls++;
          return served502;
        },
      );
      expect(r.miss, HealthMiss.http);
      expect(calls, 1, reason: 're-asking a 502 is load, not recovery');
    });

    test('an UNCLASSIFIED miss is not retried (rule ③), and keeps its old meaning', () async {
      int calls = 0;
      final HealthReading r = await readHealthRetrying(
        Uri.parse('$kSaas/api/health'),
        budget: instant3,
        // Exactly what every pre-existing fake in this suite returns.
        reader: (Uri url, Duration timeout) async {
          calls++;
          return HealthReading.offline;
        },
      );
      expect(r.miss, isNull);
      expect(calls, 1);
    });

    test('a reader that THROWS is an unclassified miss, never a crash', () async {
      final HealthReading r = await readHealthRetrying(
        Uri.parse('$kSaas/api/health'),
        budget: instant3,
        reader: (Uri url, Duration timeout) async => throw StateError('boom'),
      );
      expect(r.ok, isFalse);
      expect(r.miss, isNull);
    });

    test('the shipped budget fits inside one poll tick', () {
      // 🔴 The presence probe runs CONCURRENTLY with this one on the same tick,
      // so both worst cases have to clear the interval or the polls stack.
      // Arithmetic, checked here rather than asserted in prose.
      expect(kInstanceListReachBudget.worstCase, const Duration(milliseconds: 6300));
      expect(
        kInstanceListReachBudget.worstCase,
        lessThan(kInstanceListPresencePollInterval),
      );
      expect(
        kInstanceListPresenceBudget.worstCase,
        lessThan(kInstanceListPresencePollInterval),
      );
    });
  });

  group('one unanswered round is not "offline"', () {
    test('first answer-less round says unanswered; the second says offline', () async {
      health = () async => timedOut;
      await ctl.refreshReachability();
      expect(
        reach(),
        InstanceReach.unanswered,
        reason: 'REVERSE CONTROL FOR THE WHOLE CARD: on the pre-fix tree this '
            'was InstanceReach.offline — a red 「离线」 about a relay measured '
            'answering 92.5 % of the time.',
      );

      await ctl.refreshReachability();
      expect(reach(), InstanceReach.offline, reason: 'two in a row IS evidence');
    });

    test('a SERVED refusal is offline on the very first round — no waiting', () async {
      health = () async => served502;
      await ctl.refreshReachability();
      expect(
        reach(),
        InstanceReach.offline,
        reason: 'hysteresis is about 「could not ask」, never about 「it said no」',
      );
    });

    test('an unclassified miss stays immediately offline (every pre-existing fake)', () async {
      health = () async => HealthReading.offline;
      await ctl.refreshReachability();
      expect(reach(), InstanceReach.offline);
    });

    test('any answer clears the streak, so the next lone miss is soft again', () async {
      health = () async => netDown;
      await ctl.refreshReachability();
      expect(reach(), InstanceReach.unanswered);

      health = () async => up;
      await ctl.refreshReachability();
      expect(reach(), InstanceReach.online);

      health = () async => netDown;
      await ctl.refreshReachability();
      expect(
        reach(),
        InstanceReach.unanswered,
        reason: 'the counter counts CONSECUTIVE misses; an answer ends the run',
      );
    });

    test('a forgotten endpoint does not lend its miss streak to a new row', () async {
      health = () async => timedOut;
      await ctl.refreshReachability();
      expect(reach(), InstanceReach.unanswered);
      // load() re-reads the pairing list and prunes; the saas row survives it,
      // so this asserts the prune did not take the counter with it either.
      await ctl.load();
      await ctl.refreshReachability();
      expect(reach(), InstanceReach.offline);
    });
  });

  group('the previous answer survives the next question', () {
    test('the FIRST ever probe still paints 检测中 — there is nothing to keep', () async {
      final Completer<HealthReading> gate = Completer<HealthReading>();
      health = () => gate.future;
      final Future<void> round = ctl.refreshReachability();
      expect(reach(), InstanceReach.checking);
      gate.complete(up);
      await round;
      expect(reach(), InstanceReach.online);
    });

    test('a re-probe keeps the last answer on screen while it runs', () async {
      health = () async => up;
      await ctl.refreshReachability();
      expect(reach(), InstanceReach.online);

      final Completer<HealthReading> gate = Completer<HealthReading>();
      health = () => gate.future;
      final Future<void> round = ctl.refreshReachability();
      expect(
        reach(),
        InstanceReach.online,
        reason: 'REVERSE CONTROL: on the pre-fix tree this read '
            'InstanceReach.checking — a grey flash four times a minute, '
            'measured p50 1.14 s long on the real path.',
      );
      gate.complete(up);
      await round;
      expect(reach(), InstanceReach.online);
    });

    test('a FAILED re-probe still overwrites — nothing stale outlives its round', () async {
      health = () async => up;
      await ctl.refreshReachability();
      expect(reach(), InstanceReach.online);

      health = () async => served502;
      await ctl.refreshReachability();
      expect(
        reach(),
        InstanceReach.offline,
        reason: 'keeping the last answer is only for the interval BETWEEN '
            'question and answer — a landed verdict always wins',
      );
    });

    test('a PC row keeps its presence while the next presence probe is in flight', () async {
      const MobileSession pairing = MobileSession(
        token: 'tok-presence-000000000000000000',
        endpoint: 'http://192.168.1.5:41879',
        pcName: 'Studio PC',
        pairingId: 'pair-a',
      );
      await session.tokenStorage.addOrUpdatePairing(pairing);
      await ctl.load();

      health = () async => up;
      presence = () async => const PcPresenceReading(presence: PcPresence.online);
      await ctl.refreshReachability();
      expect(ctl.presenceOf(pairing), PcPresence.online);

      final Completer<PcPresenceReading> gate = Completer<PcPresenceReading>();
      presence = () => gate.future;
      final Future<void> round = ctl.refreshReachability();
      expect(
        ctl.presenceOf(pairing),
        PcPresence.online,
        reason: 'REVERSE CONTROL: the pre-fix tree wiped this to unknown at the '
            'TOP of every round, so the row printed 「中继可达 · 电脑是否在线未知」 '
            'for up to 10.2 s of every 15 s tick — the amber sentence owner '
            'reported on 2026-08-17, manufactured by the poller itself.',
      );
      gate.complete(const PcPresenceReading(presence: PcPresence.online));
      await round;
      expect(ctl.presenceOf(pairing), PcPresence.online);
    });

    test('a row that CANNOT be asked is still wiped to unknown', () async {
      // No token ⇒ no credential to present ⇒ this round cannot ask, and an
      // answer we cannot refresh must not stay on screen. (The half of the old
      // unconditional wipe that was right, kept.)
      const MobileSession tokenless = MobileSession(
        token: '',
        endpoint: 'http://192.168.1.9:41879',
        pcName: 'No Token PC',
        pairingId: 'pair-b',
      );
      await session.tokenStorage.addOrUpdatePairing(tokenless);
      await ctl.load();
      health = () async => up;
      await ctl.refreshReachability();
      expect(ctl.presenceOf(tokenless), PcPresence.unknown);
    });
  });

  group('the word on the row', () {
    test('unanswered gets its own face, and it is not the offline one', () {
      expect(
        instanceLivenessFaceOf(
          reach: InstanceReach.unanswered,
          answeringChannel: null,
          target: InstanceTarget.pc,
          pcPresence: PcPresence.unknown,
        ),
        InstanceLivenessFace.reachUnanswered,
      );
      expect(
        instanceLivenessFaceOf(
          reach: InstanceReach.offline,
          answeringChannel: null,
          target: InstanceTarget.pc,
          pcPresence: PcPresence.unknown,
        ),
        InstanceLivenessFace.unreachable,
      );
    });

    test('the cloud light-record row gets the same soft face', () {
      // owner's exception makes reach the WHOLE answer for that row, so it is
      // the one that flapped hardest — and it must not read 「离线」 either.
      expect(
        instanceLivenessFaceOf(
          reach: InstanceReach.unanswered,
          answeringChannel: ServerChannel.cloudRelay,
          target: InstanceTarget.cloudNotes,
          pcPresence: PcPresence.unknown,
        ),
        InstanceLivenessFace.reachUnanswered,
      );
    });

    test('every locale words it differently from offline, in both places', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        expect(s.reachUnanswered.trim(), isNotEmpty, reason: locale.name);
        expect(
          s.reachUnanswered,
          isNot(s.offline),
          reason: '${locale.name}: 「we did not get an answer」 and 「it is not '
              'there」 must not read alike',
        );
        expect(
          s.guideStatusReachUnanswered,
          isNot(s.guideStatusOffline),
          reason: '${locale.name}: the offline gloss sends the reader off to '
              'troubleshoot; this face has nothing to troubleshoot',
        );
      }
    });
  });
}
