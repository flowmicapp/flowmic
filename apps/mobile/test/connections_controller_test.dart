// WP-R23-1 — ConnectionsController: instance-list load, add-by-code pairing, and
// tap-to-connect (mobile:reconnect). All in-process with fakes (no socket). The
// central invariant under test is FAIL-LOUD: a rejected pair / dead token NEVER
// yields a fake connected state — the error code is surfaced and the list stays
// truthful.
//
// SPEC-REF: docs/rebuild/08-MOBILE-SPEC.md §4; CLAUDE.md red line: no silent failure.

import 'dart:async';
import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
// L-② — the sentence the user actually reads is asserted here, not just the
// code, because 「the copy table has this row」 is green while the code reaching
// it is faked.
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

void main() {
  late FakeSocketTransport t;
  late PttSession session;
  late LoginController login;
  late ConnectionsController ctl;
  late List<Uri> probed;
  late Map<String, bool> probeUp;
  late Map<String, ServerChannel> probeChannel;
  // RV-98 — the SECOND probe the resting list makes (GET /api/pc/presence).
  // Recorded as (url, token) pairs so a test can assert WHICH credential was
  // presented for WHICH row: 「asked the right PC」 is half of never mix IDs.
  late List<({Uri url, String token})> presenceAsked;
  /// token → what the server answers. Absent ⇒ 「could not ask」.
  late Map<String, PcPresenceReading> presenceAnswer;

  setUp(() {
    t = FakeSocketTransport()..connectSucceeds = true;
    session = PttSession(
      transport: t,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(),
      tokenStorage: InMemoryTokenStorage(),
    );
    login = LoginController(
      transport: t,
      accountStore: InMemoryAccountStore(),
      saasEndpoint: 'https://saas.test:443',
    );
    probed = <Uri>[];
    probeUp = <String, bool>{};
    probeChannel = <String, ServerChannel>{};
    presenceAsked = <({Uri url, String token})>[];
    presenceAnswer = <String, PcPresenceReading>{};
    ctl = ConnectionsController(
      session: session,
      login: login,
      saasEndpoint: 'https://saas.test:443',
      // Injected in EVERY test: the production probe is a real HttpClient and
      // must never be reachable from unit tests.
      healthReader: (Uri url, Duration timeout) async {
        probed.add(url);
        final bool up = probeUp[url.host] ?? false;
        // v0.2.3: the probe answers BOTH questions off one response. The default
        // fake reports a LAN server; tests that care about the channel override.
        return HealthReading(ok: up, channel: up ? probeChannel[url.host] : null);
      },
      // RV-98 — same rule for the second probe. Default: 「could not ask」, which is the
      // honest pre-0.2.36-server answer and keeps every OLD test's expectations.
      presenceReader: (Uri url, String token, Duration timeout) async {
        presenceAsked.add((url: url, token: token));
        return presenceAnswer[token] ?? PcPresenceReading.unknown;
      },
    );
  });

  tearDown(() async {
    ctl.dispose();
    login.dispose();
    await session.dispose();
  });

  // Log in against the fake SaaS server so login.jwt is populated for the cloud
  // admission tests below.
  Future<void> loginOk({String token = 'jwt-abc'}) async {
    t.ackQueue.add(<String, Object?>{
      'ok': true,
      'token': token,
      'user': <String, Object?>{'id': 'u1', 'email': 'fang@example.com', 'plan': 'free'},
      'mode': 'saas',
    });
    await login.login(email: 'fang@example.com', password: 'secret12');
  }

  MobileSession seededPairing({String token = 'tok-seeded-00000000000000000000'}) => MobileSession(
    token: token,
    endpoint: 'http://192.168.1.5:41879',
    channel: 'standalone',
    pcName: 'Studio PC',
    pairingId: 'pair-seed',
  );

  group('normalizePairEndpoint', () {
    test('maps ws/wss/bare to http(s)', () {
      expect(normalizePairEndpoint('192.168.1.5:41879'), 'http://192.168.1.5:41879');
      expect(normalizePairEndpoint('ws://192.168.1.5:41879'), 'http://192.168.1.5:41879');
      expect(normalizePairEndpoint('wss://flowmic.app'), 'https://flowmic.app');
      expect(normalizePairEndpoint('http://x:1'), 'http://x:1');
      expect(normalizePairEndpoint('  '), '');
    });
  });

  test('load() reads remembered pairings, most-recent first', () async {
    await session.tokenStorage.addOrUpdatePairing(seededPairing(token: 'tok-a-0000000000000000000000000'));
    await session.tokenStorage.addOrUpdatePairing(seededPairing(token: 'tok-b-0000000000000000000000000'));
    await ctl.load();
    expect(ctl.loading, isFalse);
    expect(ctl.pairings.map((p) => p.token).toList(), <String>[
      'tok-b-0000000000000000000000000',
      'tok-a-0000000000000000000000000',
    ]);
  });

  test('addByCode success persists the pairing and reports ok', () async {
    t.defaultAck = <String, Object?>{
      'mobile_token': 'tok-fresh-0000000000000000000000',
      'pairing_id': 'pair-1',
      'pc_name': 'Desk PC',
    };
    final ConnectOutcome out = await ctl.addByCode(rawEndpoint: '192.168.1.5:41879', code: '1234');
    expect(out.success, isTrue);
    expect(session.paired.value, isTrue);
    expect(ctl.pairings.length, 1);
    expect(ctl.pairings.first.token, startsWith('tok-fresh-'));
    expect(ctl.lastError, isNull);
  });

  test('addByCode surfaces the server error loudly — no fake pairing', () async {
    t.defaultAck = <String, Object?>{'error': 'PAIR_INVALID_CODE'};
    final ConnectOutcome out = await ctl.addByCode(rawEndpoint: '192.168.1.5:41879', code: '4321');
    expect(out.success, isFalse);
    expect(out.error, 'PAIR_INVALID_CODE');
    expect(ctl.lastError, 'PAIR_INVALID_CODE');
    expect(session.paired.value, isFalse);
    await ctl.load();
    expect(ctl.pairings, isEmpty);
  });

  test('addByCode rejects a malformed code before any wire call', () async {
    final ConnectOutcome out = await ctl.addByCode(rawEndpoint: '192.168.1.5:41879', code: '12');
    expect(out.success, isFalse);
    expect(out.error, 'PAIR_INVALID_CODE');
    expect(t.emittedNames, isEmpty); // never dialled / emitted
  });

  test('addByCode requires an endpoint for a bare code', () async {
    final ConnectOutcome out = await ctl.addByCode(rawEndpoint: '', code: '1234');
    expect(out.success, isFalse);
    expect(out.error, 'NO_ENDPOINT');
  });

  test('a pasted flowmic:// link carries its own endpoint', () async {
    t.defaultAck = <String, Object?>{
      'mobile_token': 'tok-qr-00000000000000000000000000',
      'pairing_id': 'pair-qr',
      'pc_name': 'QR PC',
    };
    final ConnectOutcome out = await ctl.addByCode(
      rawEndpoint: '', // none typed — the link supplies it
      code: 'flowmic://pair?endpoint=ws://192.168.1.9:41879&code=1234&channel=standalone',
    );
    expect(out.success, isTrue);
    // ⚠️ Correction (RV-97). This asserted the QR's `ws://` string VERBATIM. The
    // load-bearing half — 「host:port comes from the link, not from the input box」 — is unchanged and
    // is what the assertion below still pins; the scheme is now normalized WHERE
    // IT IS PERSISTED (`PttSession.pair`), because that string is also the base
    // of every http request this pairing makes and `HttpClient` rejects `ws`.
    // Old rows keep working: the three http funnels normalize on read
    // (signaling/http_endpoint.dart), so this is population control, not the fix.
    expect(ctl.pairings.first.endpoint, 'http://192.168.1.9:41879');
  });

  test('connectTo a remembered PC reconnects by token', () async {
    await session.tokenStorage.addOrUpdatePairing(seededPairing());
    await ctl.load();
    t.defaultAck = <String, Object?>{'pc_name': 'Studio PC'}; // no error → accepted
    final ConnectOutcome out = await ctl.connectTo(ctl.pairings.first);
    expect(out.success, isTrue);
    expect(t.emittedNames, contains('mobile:reconnect'));
    expect(session.paired.value, isTrue);
  });

  test('connectTo with a dead token fails loud and purges the pairing', () async {
    await session.tokenStorage.addOrUpdatePairing(seededPairing());
    await ctl.load();
    t.defaultAck = <String, Object?>{'error': 'AUTH_TOKEN_INVALID'};
    final ConnectOutcome out = await ctl.connectTo(ctl.pairings.first);
    expect(out.success, isFalse);
    expect(out.error, 'AUTH_TOKEN_INVALID');
    expect(ctl.lastError, 'AUTH_TOKEN_INVALID');
    // The reconnect flow purged the dead session from local storage.
    expect(ctl.pairings, isEmpty);
  });

  // ── 🔴 L-② (2026-08-02) — 「PC 刚点了断开」 must not read as 「登录已失效」 ──────
  //
  // The defect this group pins: `connectTo` used to HARD-CODE
  // `'AUTH_TOKEN_INVALID'` for every failure, so a `PAIR_RELEASED` hold-out (the
  // PC pressed 断开 seconds ago; the pairing is intact and the token was
  // deliberately kept) surfaced as 「登录已失效，请重新配对」 — the opposite of the
  // truth, sending the user to redo a pairing that was fine. The server had even
  // predicted it by name: `mobile.handler.ts:214-215` says PAIR_RELEASED exists
  // because the phone 「would DELETE the pairing on AUTH_TOKEN_INVALID」.
  //
  // 🔴 WHY THESE ASSERT THE NUMBER AND NOT JUST THE SENTENCE (window D1 law): a test
  // that only checks 「the copy table has the PAIR_RELEASED row」 stays GREEN while the code
  // reaching it is still fabricated, and a test that only checks the code stays
  // GREEN while the server's real 47 s is replaced by a hard-coded 60. So each
  // assertion below names the SERVER's own millisecond value and requires it to
  // reach the screen.
  group('L-② PAIR_RELEASED is the PC pressing 断开, not a dead token', () {
    /// A distinctive, non-round remaining window. 🔴 Deliberately NOT 60 000:
    /// that is `RELEASE_SUPPRESS_MS`, so a phone that ever hard-codes the window
    /// LENGTH instead of reading the server's REMAINING ms would still pass.
    /// 47 321 ms ⇒ 48 s (ceil).
    const int heldOutMs = 47321;
    const int heldOutSecs = 48;

    Future<ConnectOutcome> tapWhileHeldOut() async {
      await session.tokenStorage.addOrUpdatePairing(seededPairing());
      await ctl.load();
      // Byte-shape of the real refusal (mobile.handler.ts:229-233).
      t.defaultAck = <String, Object?>{
        'error': 'PAIR_RELEASED',
        'retryable': true,
        'retry_after_ms': heldOutMs,
      };
      return ctl.connectTo(ctl.pairings.first);
    }

    test('surfaces the server\'s own code + budget, and keeps the pairing', () async {
      final ConnectOutcome out = await tapWhileHeldOut();
      expect(out.success, isFalse);
      // 🔴 REVERSE CONTROL, pinned as an assertion: this is the exact literal the
      // body used to hard-code. If anyone puts it back, this line goes red.
      expect(out.error, isNot('AUTH_TOKEN_INVALID'));
      expect(ctl.lastError, isNot('AUTH_TOKEN_INVALID'));
      // POSITIVE CONTROL — the probe is not blind: the real answer IS here, with
      // the server's own number packed in (`encodeHoldOut`).
      expect(out.error, 'PAIR_RELEASED:$heldOutMs');
      expect(ctl.lastError, 'PAIR_RELEASED:$heldOutMs');
      // 🔴 And the structural difference from a dead token: nothing was purged.
      // `mobile_reconnect_flow.dart:75` keeps the token on any non-
      // AUTH_TOKEN_INVALID code — which is the whole reason the server chose one.
      expect(ctl.pairings, hasLength(1));
    });

    test('puts the server\'s REAL remaining seconds on screen, in all four locales', () async {
      final ConnectOutcome out = await tapWhileHeldOut();
      for (final AppLocale locale in AppLocale.values) {
        final String shown = AppStrings.of(locale).pairError(out.error);
        // The number the server measured reached the user, verbatim-derived.
        expect(shown, contains('$heldOutSecs'),
            reason: '$locale must show the server\'s remaining window');
        // Not the raw wire identifier, and not the generic 「配对失败：…」 arm.
        expect(shown, isNot(contains('PAIR_RELEASED')),
            reason: '$locale fell through to the default arm');
        expect(shown, isNot(contains('$heldOutMs')),
            reason: '$locale printed raw milliseconds');
      }
      // 🔴 The sentence must not be the re-pair one. Asserted by IDENTITY against
      // the AUTH_TOKEN_INVALID copy rather than by keyword, so it cannot rot if
      // that copy is reworded.
      final AppStrings zh = AppStrings.of(AppLocale.zh);
      expect(zh.pairError(out.error), isNot(zh.pairError('AUTH_TOKEN_INVALID')));
    });

    test('a hold-out with no budget still says WAIT, never 「请重新配对」', () async {
      await session.tokenStorage.addOrUpdatePairing(seededPairing());
      await ctl.load();
      // An older relay that names the code but omits the budget.
      t.defaultAck = <String, Object?>{'error': 'PAIR_RELEASED', 'retryable': true};
      final ConnectOutcome out = await ctl.connectTo(ctl.pairings.first);
      expect(out.error, 'PAIR_RELEASED'); // no `:ms` suffix invented
      final AppStrings zh = AppStrings.of(AppLocale.zh);
      expect(zh.pairError(out.error), isNot(zh.pairError('AUTH_TOKEN_INVALID')));
      expect(ctl.pairings, hasLength(1));
    });

    test('no ack at all stays 「我们没问到」 — no code is invented', () async {
      await session.tokenStorage.addOrUpdatePairing(seededPairing());
      await ctl.load();
      // No ack — what a timeout / dead relay really looks like at this seam
      // (`runMobileReconnect` leaves `ack` non-Map ⇒ refused, code unknown).
      t.defaultAck = null;
      final ConnectOutcome out = await ctl.connectTo(ctl.pairings.first);
      expect(out.success, isFalse);
      // 🔴 The rule the old body broke: a refusal we could not name must stay
      // unnamed. Borrowing any code here is how the fabrication started.
      expect(out.error, isNull);
      expect(ctl.pairings, hasLength(1));
    });
  });

  test('remove forgets a pairing', () async {
    await session.tokenStorage.addOrUpdatePairing(seededPairing());
    await ctl.load();
    expect(ctl.pairings.length, 1);
    await ctl.remove(ctl.pairings.first);
    expect(ctl.pairings, isEmpty);
  });

  group('enterCloud (WP-R4-2 ②)', () {
    test('not logged in → fail-loud NOT_LOGGED_IN, never a fake cloud session', () async {
      final ConnectOutcome out = await ctl.enterCloud();
      expect(out.success, isFalse);
      expect(out.error, 'NOT_LOGGED_IN');
      expect(session.paired.value, isFalse);
      expect(t.emittedNames, isNot(contains('mobile:pair')));
    });

    test('logged in → SaaS handshake carries the JWT + persists channel:saas', () async {
      await loginOk(token: 'jwt-abc');
      expect(login.jwt, 'jwt-abc');
      t.ackQueue.add(<String, Object?>{
        'pairing_id': 'p-cloud',
        'mobile_token': 'fm_${'0' * 64}',
        'pc_id': 'pc-cloud',
        'pc_instance_id': 'flowmic-cloud-instance',
        'pc_name': 'FlowMic Cloud',
        'room_uuid': 'room-1',
        'pc_online': false,
        'role': 'active',
      });
      final ConnectOutcome out = await ctl.enterCloud();
      expect(out.success, isTrue);
      // The pair socket dialled the SaaS endpoint carrying auth.jwt.
      expect(t.lastConnectUrl, 'https://saas.test:443');
      expect(t.lastConnectJwt, 'jwt-abc');
      // mobile:pair went out with the cloud_instance variant.
      final Map<dynamic, dynamic> pairPayload =
          t.emittedWhere('mobile:pair').single.data as Map<dynamic, dynamic>;
      expect(pairPayload['cloud_instance'], true);
      // Persisted as a saas-channel MobileSession.
      final saved = await session.tokenStorage.readPairings();
      expect(saved.single.channel, 'saas');
      expect(saved.single.pcInstanceId, 'flowmic-cloud-instance');
      expect(session.paired.value, isTrue);
    });

    test('expired JWT ack → clears the account + drives back to login (fail-loud)', () async {
      await loginOk(token: 'jwt-stale');
      expect(login.isLoggedIn, isTrue);
      t.ackQueue.add(<String, Object?>{'error': 'AUTH_TOKEN_EXPIRED'});
      final ConnectOutcome out = await ctl.enterCloud();
      expect(out.success, isFalse);
      expect(out.error, 'AUTH_TOKEN_EXPIRED');
      // The stale bearer is gone and the controller is in the re-login state.
      expect(login.jwt, isNull);
      expect(login.isLoggedIn, isFalse);
      expect(login.errorCode, 'AUTH_TOKEN_EXPIRED');
    });
  });

  // T-6c — local display alias write path (no widget FakeAsync).
  group('setAlias', () {
    test('sets alias and reloads so pairingDisplayName wins', () async {
      final MobileSession seed = seededPairing();
      await session.tokenStorage.addOrUpdatePairing(seed);
      await ctl.load();
      expect(pairingDisplayName(ctl.pairings.single), 'Studio PC');

      await ctl.setAlias(ctl.pairings.single, '办公桌');
      expect(ctl.pairings.single.displayAlias, '办公桌');
      expect(pairingDisplayName(ctl.pairings.single), '办公桌');
    });

    test('blank alias clears back to device name', () async {
      final MobileSession seed = seededPairing();
      await session.tokenStorage.addOrUpdatePairing(seed);
      await ctl.load();
      await ctl.setAlias(ctl.pairings.single, '办公桌');
      await ctl.setAlias(ctl.pairings.single, '   ');
      expect(ctl.pairings.single.displayAlias, isNull);
      expect(pairingDisplayName(ctl.pairings.single), 'Studio PC');
    });

    test('renaming preserves last_connected_at and does not reorder rows', () async {
      final DateTime older = DateTime.utc(2026, 7, 20, 1);
      final DateTime newer = DateTime.utc(2026, 7, 21, 2);
      await session.tokenStorage.addOrUpdatePairing(
        seededPairing(token: 'tok-older-00000000000000000000000')
            .copyWith(lastConnectedAt: older),
      );
      await session.tokenStorage.addOrUpdatePairing(
        seededPairing(token: 'tok-newer-00000000000000000000000')
            .copyWith(lastConnectedAt: newer),
      );
      await ctl.load();
      final List<String> before = ctl.pairings.map((MobileSession p) => p.token).toList();

      await ctl.setAlias(ctl.pairings.last, '只改备注');

      expect(ctl.pairings.map((MobileSession p) => p.token).toList(), before);
      expect(ctl.pairings.last.displayAlias, '只改备注');
      expect(ctl.pairings.last.lastConnectedAt, older);
      expect(ctl.pairings.first.lastConnectedAt, newer);
    });
  });

  // T-6d — active pairing label for the chat header (no PttSession mutation).
  group('activePairingDisplayName', () {
    test('after connectTo, tracks alias → device via pairingDisplayName', () async {
      await session.tokenStorage.addOrUpdatePairing(seededPairing());
      await ctl.load();
      t.defaultAck = <String, Object?>{'pc_name': 'Studio PC'};
      expect(ctl.activePairingDisplayName, isNull);

      final ConnectOutcome out = await ctl.connectTo(ctl.pairings.first);
      expect(out.success, isTrue);
      expect(ctl.activePairingDisplayName, 'Studio PC');
      // Ack truth on the session is untouched by the local label path.
      expect(session.connectedDeviceName.value, 'Studio PC');

      await ctl.setAlias(ctl.pairings.single, '办公桌');
      expect(ctl.activePairingDisplayName, '办公桌');
      expect(session.connectedDeviceName.value, 'Studio PC');
    });

    // owner 2026-07-27: backing out of the transcription page must leave the ROOM,
    // not just pop a route. Before this the socket stayed up, the PC still counted
    // the phone as present, and its capsule kept floating with nobody on the other
    // end. The stored pairing must survive — this ends the session, not the pairing.
    test('leaveRoom drops the session but keeps the pairing tappable', () async {
      await session.tokenStorage.addOrUpdatePairing(seededPairing());
      await ctl.load();
      t.defaultAck = <String, Object?>{'pc_name': 'Studio PC'};
      expect((await ctl.connectTo(ctl.pairings.first)).success, isTrue);
      expect(ctl.session.paired.value, isTrue);
      final int before = ctl.pairings.length;

      await ctl.leaveRoom();

      expect(ctl.session.paired.value, isFalse);
      expect(t.currentStatus.name, 'disconnected'); // the socket was really dropped
      await ctl.load();
      expect(ctl.pairings.length, before); // the remembered PC is still listed
    });

    // owner 2026-07-27 ①:「点击某个实例连接时要有 CONNECTING 状态，否则会一直点，
    // 同时…应有轻量级的检查对应的实例是否在线…包括云端实例也一样」。
    group('connecting state + reachability probe', () {
      test('the row being dialled is named while the connect is in flight', () async {
        await session.tokenStorage.addOrUpdatePairing(seededPairing());
        await ctl.load();
        final MobileSession p = ctl.pairings.single;
        t.defaultAck = <String, Object?>{'pc_name': 'Studio PC'};

        String? seenWhileDialling;
        void spy() => seenWhileDialling ??= ctl.connectingKey;
        ctl.addListener(spy);
        final Future<ConnectOutcome> pending = ctl.connectTo(p);
        expect(seenWhileDialling, ConnectionsController.keyFor(p)); // the FIRST notify already names it
        expect((await pending).success, isTrue);
        ctl.removeListener(spy);

        expect(ctl.connectingKey, isNull); // and it is released afterwards
      });

      test('a failed connect releases the connecting row (no stuck spinner)', () async {
        await session.tokenStorage.addOrUpdatePairing(seededPairing());
        await ctl.load();
        t.defaultAck = <String, Object?>{'error': 'AUTH_TOKEN_INVALID'};

        expect((await ctl.connectTo(ctl.pairings.single)).success, isFalse);
        expect(ctl.connectingKey, isNull);
      });

      test('probes every listed endpoint AND the cloud relay, reporting each verdict', () async {
        await session.tokenStorage.addOrUpdatePairing(seededPairing());
        await ctl.load();
        probeUp['192.168.1.5'] = true; // the PC answers /api/health
        // saas.test deliberately left down.

        await ctl.refreshReachability();

        expect(ctl.reachOf('http://192.168.1.5:41879'), InstanceReach.online);
        expect(ctl.reachOf('https://saas.test:443'), InstanceReach.offline);
        // The probe is a health GET on the server root — never the stored path.
        expect(probed.map((Uri u) => u.path).toSet(), <String>{'/api/health'});
        expect(probed.length, 2);
      });

      test('an endpoint listed twice is probed ONCE', () async {
        await session.tokenStorage.addOrUpdatePairing(seededPairing());
        await session.tokenStorage.addOrUpdatePairing(
          seededPairing(token: 'tok-second-0000000000000000000').copyWith(pcName: 'Same host'),
        );
        await ctl.load();
        await ctl.refreshReachability();

        expect(ctl.pairings.length, 2);
        expect(probed.where((Uri u) => u.host == '192.168.1.5').length, 1);
      });

      test('an endpoint never probed is unknown — never silently 在线', () {
        expect(ctl.reachOf('http://10.0.0.9:41879'), InstanceReach.unknown);
      });

      test('the row shows 检测中 before the answer lands', () async {
        await session.tokenStorage.addOrUpdatePairing(seededPairing());
        await ctl.load();
        final Completer<HealthReading> gate = Completer<HealthReading>();
        final ConnectionsController slow = ConnectionsController(
          session: session,
          login: login,
          saasEndpoint: 'https://saas.test:443',
          healthReader: (Uri url, Duration timeout) => gate.future,
        );
        await slow.load();

        final Future<void> pending = slow.refreshReachability();
        expect(slow.reachOf('http://192.168.1.5:41879'), InstanceReach.checking);
        gate.complete(const HealthReading(ok: true, channel: ServerChannel.lan));
        await pending;
        expect(slow.reachOf('http://192.168.1.5:41879'), InstanceReach.online);
        slow.dispose();
      });

      test('a probe that throws reads as offline, not as a crash', () async {
        await session.tokenStorage.addOrUpdatePairing(seededPairing());
        final ConnectionsController boom = ConnectionsController(
          session: session,
          login: login,
          saasEndpoint: 'https://saas.test:443',
          healthReader: (Uri url, Duration timeout) async => throw const SocketException('no route'),
        );
        await boom.load();
        await boom.refreshReachability();
        expect(boom.reachOf('http://192.168.1.5:41879'), InstanceReach.offline);
        boom.dispose();
      });
    });
  });

  // ── v0.2.3: 「这条连接走的是哪条通道」 is a MEASUREMENT ────────────────────
  //
  // owner 2026-07-29: a PC paired by scanning its CLOUD-RELAY QR still read
  // 本地局域网. The chip came from `MobileSession.channel`, which answers
  // 「is the peer that virtual cloud instance」 — a different question, and a real PC answers
  // `false` to it on EITHER transport. The list now asks the SERVER
  // (`/api/health.mode`), the same source the chat header uses since 0.2.1.
  group('v0.2.3 measured channel', () {
    test('a server that reports saas makes the row 云端中继, not 本地局域网', () async {
      await session.tokenStorage.addOrUpdatePairing(seededPairing());
      probeUp['192.168.1.5'] = true;
      probeChannel['192.168.1.5'] = ServerChannel.cloudRelay;
      await ctl.load();
      await ctl.refreshReachability();
      expect(ctl.channelOf('http://192.168.1.5:41879'), ServerChannel.cloudRelay);
    });

    test('a server that reports standalone is 本地局域网', () async {
      await session.tokenStorage.addOrUpdatePairing(seededPairing());
      probeUp['192.168.1.5'] = true;
      probeChannel['192.168.1.5'] = ServerChannel.lan;
      await ctl.load();
      await ctl.refreshReachability();
      expect(ctl.channelOf('http://192.168.1.5:41879'), ServerChannel.lan);
    });

    test('never measured ⇒ null, which the row renders as NO chip', () async {
      // The whole point: an absent label is true, a defaulted one is not.
      await session.tokenStorage.addOrUpdatePairing(seededPairing());
      await ctl.load();
      expect(ctl.channelOf('http://192.168.1.5:41879'), isNull);
    });

    test('an UNREACHABLE probe does not erase what we already knew', () async {
      // 「could not ask this time」 is not 「it changed」. A blip must not silently relabel a row.
      await session.tokenStorage.addOrUpdatePairing(seededPairing());
      probeUp['192.168.1.5'] = true;
      probeChannel['192.168.1.5'] = ServerChannel.cloudRelay;
      await ctl.load();
      await ctl.refreshReachability();
      expect(ctl.channelOf('http://192.168.1.5:41879'), ServerChannel.cloudRelay);
      expect(ctl.liveChannelOf('http://192.168.1.5:41879'), ServerChannel.cloudRelay);

      probeUp['192.168.1.5'] = false;
      await ctl.refreshReachability();
      expect(ctl.reachOf('http://192.168.1.5:41879'), InstanceReach.offline);
      expect(
        ctl.channelOf('http://192.168.1.5:41879'),
        ServerChannel.cloudRelay,
        reason: 'unreachable says nothing about which channel it is',
      );
      expect(
        ctl.liveChannelOf('http://192.168.1.5:41879'),
        isNull,
        reason: 'RV-54: last-known must not answer 「now」 while offline',
      );
    });

    test('dialHostLabel strips the scheme so LAN IP and relay domain differ', () {
      expect(dialHostLabel('http://192.168.1.5:41879'), '192.168.1.5:41879');
      expect(dialHostLabel('https://flowmic.app'), 'flowmic.app');
      expect(dialHostLabel('ws://10.0.0.2:41879'), '10.0.0.2:41879');
      expect(dialHostLabel(''), isEmpty);
    });

    test('a reachable server that names an UNKNOWN mode yields null', () async {
      // A future third mode must not silently read as one of these two.
      await session.tokenStorage.addOrUpdatePairing(seededPairing());
      probeUp['192.168.1.5'] = true; // channel deliberately absent from probeChannel
      await ctl.load();
      await ctl.refreshReachability();
      expect(ctl.reachOf('http://192.168.1.5:41879'), InstanceReach.online);
      expect(channelFromHealthMode('something-new'), isNull);
    });
  });

  // ── RV-98 (card B4-14) — the list page really does ask that PC ─────────────
  //
  // owner 2026-08-01 real-device quote: 「截图 2 中的云端中继这个实例显示的是『中继可达 · 电脑
  // 是否在线未知』，**实际上 PC 是在线的**，这样显示不对，**要能正确显示 PC 端是否在
  // 线**」。
  //
  // ⚠️ Reverse control (really seen red; original in the handoff report):
  //   · Change `_presence[key] = …` inside `_probePresenceOne` to 「keep the last
  //     value on failure」
  //     ⇒ 「must fall back to unknown when we could not ask」 goes red;
  //   · Drop `instanceTargetOf(p) != InstanceTarget.pc` from `refreshReachability`
  //     ⇒ 「the cloud-notes row is not even asked」 goes red;
  //   · Change the `_presence` key from `keyFor(p)` to the endpoint ⇒ 「one
  //     relay address, two PCs」 goes red.
  group('RV-98 · PcPresence (list domain)', () {
    /// A **real PC** reached via the relay (`channel: 'standalone'`), with pcId
    /// so the echo can be checked.
    MobileSession relayPc({
      required String token,
      String pcId = 'pc-relay-1',
      String endpoint = 'https://saas.test:443',
      String instance = 'inst-relay-1',
    }) => MobileSession(
      token: token,
      endpoint: endpoint,
      channel: 'standalone',
      pcId: pcId,
      pcInstanceId: instance,
      pcName: 'Relay PC',
      pairingId: 'pair-$pcId',
    );

    test('🔴 the correct reading of the owner\'s scene: the relay answers health, the PC itself answers presence ⇒ this row is 「online」', () async {
      final MobileSession p = relayPc(token: 'tok-relay-000000000000000000000');
      await session.tokenStorage.addOrUpdatePairing(p);
      probeUp['saas.test'] = true;
      probeChannel['saas.test'] = ServerChannel.cloudRelay;
      presenceAnswer[p.token] =
          const PcPresenceReading(presence: PcPresence.online, pcId: 'pc-relay-1');

      await ctl.load();
      await ctl.refreshReachability();

      expect(ctl.presenceOf(p), PcPresence.online);
      // Positive control: that ask really went out, to /api/pc/presence, carrying this row's token.
      expect(presenceAsked.single.url.path, '/api/pc/presence');
      expect(presenceAsked.single.url.host, 'saas.test');
      expect(presenceAsked.single.token, p.token);
      // 🔴 The two values stay apart: reachability is /api/health's own answer, not rewritten by this ask.
      expect(ctl.reachOf(p.endpoint), InstanceReach.online);
      expect(ctl.channelOf(p.endpoint), ServerChannel.cloudRelay);
    });

    test('PC left ⇒ offline (that is what the machine in the owner\'s screenshot should say when it is off)', () async {
      final MobileSession p = relayPc(token: 'tok-relay-off-000000000000000');
      await session.tokenStorage.addOrUpdatePairing(p);
      probeUp['saas.test'] = true;
      presenceAnswer[p.token] =
          const PcPresenceReading(presence: PcPresence.offline, pcId: 'pc-relay-1');
      await ctl.load();
      await ctl.refreshReachability();
      expect(ctl.presenceOf(p), PcPresence.offline);
    });

    test('🔴 could not ask ⇒ fall back to unknown, never reuse the last online', () async {
      final MobileSession p = relayPc(token: 'tok-relay-stale-0000000000000');
      await session.tokenStorage.addOrUpdatePairing(p);
      probeUp['saas.test'] = true;
      presenceAnswer[p.token] =
          const PcPresenceReading(presence: PcPresence.online, pcId: 'pc-relay-1');
      await ctl.load();
      await ctl.refreshReachability();
      expect(ctl.presenceOf(p), PcPresence.online, reason: 'positive control: we really did ask once');

      // Next pass the server does not answer (old server 404 / 401 / network blip).
      presenceAnswer.remove(p.token);
      await ctl.refreshReachability();
      expect(
        ctl.presenceOf(p),
        PcPresence.unknown,
        reason: '「could not ask this time」 is not 「it is still there」 — keeping the last value is the lie the owner hit',
      );
    });

    test('🔴 a probe that throws is also only 「unknown」, never 「offline」', () async {
      final MobileSession p = relayPc(token: 'tok-relay-throw-0000000000000');
      await session.tokenStorage.addOrUpdatePairing(p);
      probeUp['saas.test'] = true;
      final ConnectionsController boom = ConnectionsController(
        session: session,
        login: login,
        saasEndpoint: 'https://saas.test:443',
        healthReader: (Uri url, Duration t) async =>
            const HealthReading(ok: true, channel: ServerChannel.cloudRelay),
        presenceReader: (Uri url, String token, Duration t) async =>
            throw StateError('boom'),
      );
      addTearDown(boom.dispose);
      await boom.load();
      await boom.refreshReachability();
      expect(boom.presenceOf(p), PcPresence.unknown);
    });

    test('🔴 the owner\'s exception is structural: the cloud-notes row is not even asked', () async {
      await session.tokenStorage.addOrUpdatePairing(const MobileSession(
        token: 'tok-cloud-notes-00000000000000',
        endpoint: 'https://saas.test:443',
        channel: 'saas',
        pcId: 'pc-cloud-virtual',
      ));
      probeUp['saas.test'] = true;
      await ctl.load();
      await ctl.refreshReachability();
      // 「ask then ignore」 is a comment the next person can delete; 「do not ask」 is structure.
      expect(presenceAsked, isEmpty);
    });

    test('🔴 the key is the pairing, not the endpoint: two PCs behind one relay address each answer for themselves', () async {
      final MobileSession a = relayPc(
          token: 'tok-a-relay-00000000000000000',
          pcId: 'pc-a',
          instance: 'inst-a');
      final MobileSession b = relayPc(
          token: 'tok-b-relay-00000000000000000',
          pcId: 'pc-b',
          instance: 'inst-b');
      await session.tokenStorage.addOrUpdatePairing(a);
      await session.tokenStorage.addOrUpdatePairing(b);
      probeUp['saas.test'] = true;
      presenceAnswer[a.token] =
          const PcPresenceReading(presence: PcPresence.online, pcId: 'pc-a');
      presenceAnswer[b.token] =
          const PcPresenceReading(presence: PcPresence.offline, pcId: 'pc-b');

      await ctl.load();
      await ctl.refreshReachability();

      expect(ctl.presenceOf(a), PcPresence.online);
      expect(ctl.presenceOf(b), PcPresence.offline);
      // Two pairings share one address, but each was asked once, each with its
      // own token. Deduping by endpoint would paint A's answer on B's row —
      // the list-page edition of mixing IDs.
      expect(presenceAsked.length, 2);
      expect(
        presenceAsked.map((r) => r.token).toSet(),
        <String>{a.token, b.token},
      );
    });

    test('🔴 never mix IDs: echo pc_id does not match ⇒ treat as not asked', () async {
      final MobileSession p = relayPc(token: 'tok-mismatch-0000000000000000', pcId: 'pc-mine');
      await session.tokenStorage.addOrUpdatePairing(p);
      probeUp['saas.test'] = true;
      presenceAnswer[p.token] = const PcPresenceReading(
        presence: PcPresence.online,
        pcId: 'pc-someone-else', // answered for a machine we did not ask
      );
      await ctl.load();
      await ctl.refreshReachability();
      expect(
        ctl.presenceOf(p),
        PcPresence.unknown,
        reason: 'an answer that does not match is not an answer — neither 「online」 nor 「offline」',
      );
      // Positive control: the same path, echo matches, so it is accepted.
      presenceAnswer[p.token] =
          const PcPresenceReading(presence: PcPresence.online, pcId: 'pc-mine');
      await ctl.refreshReachability();
      expect(ctl.presenceOf(p), PcPresence.online);
    });

    test('an old server that does not return pc_id (echo missing) ⇒ nothing to check, do not block', () async {
      final MobileSession p = relayPc(token: 'tok-nopcid-00000000000000000', pcId: 'pc-mine');
      await session.tokenStorage.addOrUpdatePairing(p);
      probeUp['saas.test'] = true;
      presenceAnswer[p.token] = const PcPresenceReading(presence: PcPresence.online);
      await ctl.load();
      await ctl.refreshReachability();
      expect(ctl.presenceOf(p), PcPresence.online);
    });

    test('forgetting a pairing takes its presence answer with it (do not leave it for the next same-key row)', () async {
      final MobileSession p = relayPc(token: 'tok-forget-00000000000000000');
      await session.tokenStorage.addOrUpdatePairing(p);
      probeUp['saas.test'] = true;
      presenceAnswer[p.token] =
          const PcPresenceReading(presence: PcPresence.online, pcId: 'pc-relay-1');
      await ctl.load();
      await ctl.refreshReachability();
      expect(ctl.presenceOf(p), PcPresence.online);

      await session.tokenStorage.removePairing(p);
      await ctl.load();
      expect(ctl.presenceOf(p), PcPresence.unknown);
    });
  });
}
