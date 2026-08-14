// A2 (owner 2026-08-11, docs/decisions/2026-08-11-owner-cloud-logout-switch-account.md)
// — cloud sign-out must let the user switch accounts, which means the sign-out
// verb has to clear MORE than the JWT:
//
//   1. a live cloud-instance session must be torn down (after 「退出」 nothing on
//      this phone may keep speaking as the old account — R11: the sign-out layer
//      must hold the session facts, not just the account store);
//   2. the remembered cloud-instance pairing rows (channel 'saas') must be
//      purged: their mobile_token was minted under the old account by
//      admitCloudInstance(), and resumePairing dials by TOKEN ALONE (no JWT on
//      that handshake) — a kept row would let the NEXT account tap 「云端实例」
//      and re-enter the OLD account's cloud session with no login at all;
//   3. standalone (LAN) pairings and a live standalone session are DELIBERATELY
//      untouched — the owner ruling scopes the sign-out to the cloud account
//      (「局域网配对 / 本机 standalone 不是本条范围」).
//
// The verb under test is ConnectionsController.signOutCloud(), which WRAPS the
// one LoginController.logout() (never a second logout implementation — the
// ruling's 「勿从零造第二套」).
//
// SPEC-REF: docs/strategy/2026-08-11-a2-cloud-logout-gap-audit.md (gap M-1/M-2);
//           CLAUDE.md red line 没有静默失败 / 绝不许串号 (identity must not leak
//           across accounts).

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

void main() {
  late FakeSocketTransport t;
  late PttSession session;
  late LoginController login;
  late ConnectionsController ctl;

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
    ctl = ConnectionsController(
      session: session,
      login: login,
      saasEndpoint: 'https://saas.test:443',
      healthReader: (Uri url, Duration timeout) async =>
          const HealthReading(ok: false, channel: null),
      presenceReader: (Uri url, String token, Duration timeout) async =>
          PcPresenceReading.unknown,
    );
  });

  tearDown(() async {
    ctl.dispose();
    login.dispose();
    await session.dispose();
  });

  Future<void> loginOk({String token = 'jwt-abc'}) async {
    t.ackQueue.add(<String, Object?>{
      'ok': true,
      'token': token,
      'user': <String, Object?>{'id': 'u1', 'email': 'a@b.co', 'plan': 'free'},
      'mode': 'saas',
    });
    await login.login(email: 'a@b.co', password: 'secret12');
    expect(login.isLoggedIn, isTrue);
  }

  Future<void> enterCloudOk() async {
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
    expect(session.paired.value, isTrue);
  }

  MobileSession lanPairing() => const MobileSession(
        token: 'tok-lan-000000000000000000000000',
        endpoint: 'http://192.168.1.5:41879',
        channel: 'standalone',
        pcName: 'Studio PC',
        pairingId: 'pair-lan',
      );

  test(
      'signOutCloud after a cloud session: account cleared, live cloud link '
      'dropped, saas row purged — LAN row survives', () async {
    await session.tokenStorage.addOrUpdatePairing(lanPairing());
    await ctl.load();
    await loginOk();
    await enterCloudOk();
    expect(t.currentStatus, SocketStatus.connected);

    await ctl.signOutCloud();

    // The one account-clearing verb ran (wrapped, not duplicated).
    expect(login.isLoggedIn, isFalse);
    expect(login.jwt, isNull);
    // The live cloud session is over: no socket, no room claim.
    expect(t.currentStatus, SocketStatus.disconnected);
    expect(session.paired.value, isFalse);
    // 🔴 The stale-identity leak this card closes: the cloud-instance row whose
    // token was minted under the signed-out account is GONE from storage — the
    // next account cannot resume the old identity by tapping the list.
    final List<MobileSession> kept = await session.tokenStorage.readPairings();
    expect(kept.where((MobileSession p) => p.channel == 'saas'), isEmpty,
        reason: 'a kept saas row reconnects by token alone — old identity');
    // Negative boundary (owner ruling): the LAN pairing is untouched.
    expect(kept.map((MobileSession p) => p.pairingId), contains('pair-lan'));
    expect(ctl.pairings.single.channel, 'standalone');
  });

  test('signOutCloud with a LIVE standalone session: the LAN link stays up',
      () async {
    // Login FIRST: login()/loginWithQr dial and then drop the SHARED transport
    // (their own finally), so a login DURING a live LAN session would end that
    // session regardless of this card — a pre-existing shape recorded in the
    // A2 audit (§M-5), not the one under test here.
    await loginOk();
    await session.tokenStorage.addOrUpdatePairing(lanPairing());
    await ctl.load();
    t.defaultAck = <String, Object?>{'pc_name': 'Studio PC'}; // accepted
    final ConnectOutcome out = await ctl.connectTo(ctl.pairings.first);
    expect(out.success, isTrue);
    expect(session.paired.value, isTrue);

    await ctl.signOutCloud();

    expect(login.isLoggedIn, isFalse);
    // 🔴 Negative boundary: signing out of the CLOUD account must not end a
    // standalone (LAN) session — the active pairing is not the cloud instance,
    // so the link is left alone.
    expect(t.currentStatus, SocketStatus.connected);
    expect(session.paired.value, isTrue);
    expect((await session.tokenStorage.readPairings()).single.pairingId,
        'pair-lan');
  });

  test(
      'the honest second half survives the wrapper: a sign-out whose server '
      'never confirmed still reports it (logoutNotice)', () async {
    await loginOk();
    await enterCloudOk();

    await ctl.signOutCloud();

    // leaveRoom() dropped the socket BEFORE logout()'s mobile:logout emit, so
    // no account server confirmed — the wrapper must not swallow that fact.
    expect(login.logoutNotice, LogoutNoticeCodes.serverUnconfirmed);
    expect(login.isLoggedIn, isFalse);
  });

  test('signOutCloud when signed in but never in a cloud session: purge is a '
      'no-op on an empty list and nothing dials', () async {
    await loginOk();
    final int dialsBefore = t.connectCalls;
    await ctl.signOutCloud();
    expect(login.isLoggedIn, isFalse);
    expect(t.connectCalls, dialsBefore, reason: 'sign-out must not dial');
    expect(await session.tokenStorage.readPairings(), isEmpty);
  });
}
