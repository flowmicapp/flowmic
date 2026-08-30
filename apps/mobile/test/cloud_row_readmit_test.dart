// 🔴 owner 2026-08-30 — TAPPING THE LIGHT-RECORD ROW ANSWERED WITH A PAIRING
// THAT DOES NOT EXIST.
//
//   「连接清单中点击轻记录会提醒：与电脑的配对取消……这个卡片点击只可能有登录
//    失效的问题，不存在有配对的问题……这个登录是永久的，不应该失效，要修复回来」
//   ("tapping the light record in the connections list warns that the pairing
//    with the PC was cancelled … tapping this card can only ever have a login
//    problem, there is no pairing involved … this login is permanent, it should
//    not expire, fix it back")
//
// Both halves are asserted here, and they are DIFFERENT defects that happened to
// surface in one sentence:
//   ① the copy — a cloud instance has no PC, no pairing code and no revoke
//      button, so 「电脑上已取消这台手机的配对」 names an act nobody could have
//      performed and an action (re-pair) that cannot fix it;
//   ② the dead end — the refusal is the DEVICE registration, not the account,
//      so the phone can re-mint it from the login it already holds instead of
//      telling the user to sign out and back in.
//
// Whole argument, including the two middleware branches that make ② provable
// rather than hopeful: lib/src/session/cloud_readmit.dart.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/cloud_readmit.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketHandshakeException;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

/// Refuses the next [armed] connects at the handshake, then behaves normally.
///
/// This is the real shape: `SocketCore.onConnectError` records the server's
/// words on `lastConnectError` and completes the future with an error, which is
/// what `handshakeRefusal` reads. Refusing only a bounded number is what lets
/// one test watch the re-admission dial AGAIN and succeed — a fake that refused
/// forever could only ever prove the give-up path.
///
/// 🔴 [armed] IS SET BY THE TEST, IMMEDIATELY BEFORE THE TAP, AND THE FIRST
/// VERSION OF THIS FIXTURE DID NOT HAVE IT — 「refuse the first connect」 sounded
/// equivalent and was not. `login()` dials this same transport, so signing in
/// SPENT the refusal, every tap that followed connected happily, and two of the
/// reverse controls below passed while proving nothing (they asserted that a row
/// was not re-admitted, on a run where nothing had refused it). One of them was
/// the assertion protecting a PC from being silently re-paired.
///
/// ⇒ 先核你的尺子 ("check your ruler first"): a fixture that counts calls must be
/// armed where the behaviour under test begins, not where the object is built.
class _RefusesNextConnect extends FakeSocketTransport {
  _RefusesNextConnect(this.err);
  final String err;

  /// How many further connects to refuse. Decremented as they fire, so a test
  /// can assert it reached 0 — i.e. the refusal really happened.
  int armed = 0;
  int fired = 0;

  @override
  Future<void> connect({
    required String url,
    String? token,
    String? jwt,
    String? pinFingerprint,
  }) async {
    if (armed > 0) {
      armed--;
      fired++;
      setLastConnectError(err);
      throw SocketHandshakeException(err);
    }
    await super.connect(url: url, token: token, jwt: jwt, pinFingerprint: pinFingerprint);
  }
}

void main() {
  late _RefusesNextConnect t;
  late PttSession session;
  late LoginController login;
  late ConnectionsController ctl;

  /// The remembered cloud instance — a `MobileSession` like any other, which is
  /// exactly how it inherited a PC's copy table.
  MobileSession cloudRow() => MobileSession(
    token: 'fm_${'0' * 64}',
    endpoint: 'https://saas.test:443',
    channel: 'saas',
    pcName: 'FlowMic Cloud',
    pairingId: 'p-cloud',
    pcInstanceId: 'flowmic-cloud-instance',
  );

  MobileSession lanRow() => const MobileSession(
    token: 'tok-lan-000000000000000000000000',
    endpoint: 'http://192.168.1.5:41879',
    channel: 'standalone',
    pcName: 'Studio PC',
    pairingId: 'pair-lan',
  );

  void build({String handshakeError = kHandshakeTokenInvalid}) {
    t = _RefusesNextConnect(handshakeError)..connectSucceeds = true;
    session = PttSession(
      transport: t,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(),
      tokenStorage: InMemoryTokenStorage(),
    );
    session.healthReader = (Uri url, Duration timeout) async => HealthReading.offline;
    login = LoginController(
      transport: t,
      accountStore: InMemoryAccountStore(),
      saasEndpoint: 'https://saas.test:443',
    );
    ctl = ConnectionsController(
      session: session,
      login: login,
      saasEndpoint: 'https://saas.test:443',
      healthReader: (Uri url, Duration timeout) async => HealthReading.offline,
    );
    addTearDown(() async {
      ctl.dispose();
      login.dispose();
      await session.dispose();
    });
  }

  Future<void> loginOk() async {
    t.ackQueue.add(<String, Object?>{
      'ok': true,
      'token': 'jwt-abc',
      'user': <String, Object?>{'id': 'u1', 'email': 'fang@example.com', 'plan': 'free'},
      'mode': 'saas',
    });
    await login.login(email: 'fang@example.com', password: 'secret12');
  }

  /// The ack a successful cloud admission gets back.
  Map<String, Object?> cloudPairAck() => <String, Object?>{
    'pairing_id': 'p-cloud',
    'mobile_token': 'fm_${'1' * 64}',
    'pc_id': 'pc-cloud',
    'pc_instance_id': 'flowmic-cloud-instance',
    'pc_name': 'FlowMic Cloud',
    'room_uuid': 'room-1',
    'pc_online': false,
    'role': 'active',
  };

  // ── ② the dead end ─────────────────────────────────────────────────────────

  group('a lost cloud registration heals itself', () {
    test('the tap succeeds, and it succeeds by re-admitting — not by luck', () async {
      build();
      await loginOk();
      await session.tokenStorage.addOrUpdatePairing(cloudRow());
      await ctl.load();
      t.ackQueue.add(cloudPairAck());
      // Arm the refusal HERE — after every dial the setup itself makes.
      t.armed = 1;

      final ConnectOutcome out = await ctl.connectTo(ctl.pairings.first);

      expect(out.success, isTrue,
          reason: 'the user pressed a row whose credential we can re-mint ourselves');
      // 🔴 POSITIVE CONTROL — the success must come from the cloud ADMISSION,
      // not from a retry of the same reconnect. Without this the test would pass
      // on any implementation that simply dialled twice, which heals nothing:
      // the second dial carries the same dead device token.
      expect(t.emittedNames, contains('mobile:pair'));
      final Map<dynamic, dynamic> payload =
          t.emittedWhere('mobile:pair').single.data as Map<dynamic, dynamic>;
      expect(payload['cloud_instance'], true);
      // The handshake really was refused once — otherwise the whole scenario
      // never happened and every assertion above is about nothing.
      expect(t.fired, 1);
      expect(t.armed, 0);
      // And the account was never touched: this was never a login problem.
      expect(login.isLoggedIn, isTrue);
      expect(login.jwt, 'jwt-abc');
    });

    test('one attempt only — a second refusal is spoken, not looped', () async {
      build();
      await loginOk();
      await session.tokenStorage.addOrUpdatePairing(cloudRow());
      await ctl.load();
      // The re-admission dials and the relay refuses the account this time.
      t.ackQueue.add(<String, Object?>{'error': 'AUTH_TOKEN_EXPIRED'});
      // Arm the refusal HERE — after every dial the setup itself makes.
      t.armed = 1;

      final ConnectOutcome out = await ctl.connectTo(ctl.pairings.first);

      expect(out.success, isFalse);
      expect(out.error, 'AUTH_TOKEN_EXPIRED');
      // 🔴 THE TERMINATION ASSERTION. `mobile:pair` exactly once means the
      // re-admission did not re-enter itself. A missing guard here is not a
      // slow test — it is a phone dialling forever behind a spinner.
      expect(t.emittedWhere('mobile:pair'), hasLength(1));
      expect(t.fired, 1);
      expect(ctl.readmitting, isFalse, reason: 'the guard must not stay latched');
    });

    test('signed out ⇒ nothing to re-admit with, so it says so instead', () async {
      build();
      await session.tokenStorage.addOrUpdatePairing(cloudRow());
      await ctl.load();
      // Arm the refusal HERE — after every dial the setup itself makes.
      t.armed = 1;

      final ConnectOutcome out = await ctl.connectTo(ctl.pairings.first);

      expect(out.success, isFalse);
      expect(t.fired, 1, reason: 'positive control: the refusal this test is about did happen');
      expect(t.emittedNames, isNot(contains('mobile:pair')),
          reason: 'admitting with no account would be a fabricated session');
    });
  });

  // ── 🔴 REVERSE CONTROL: the healing must not reach a real pairing ───────────

  group('reverse control — a PC row is never re-paired behind the user', () {
    test('a LAN row refused at the handshake stays refused', () async {
      build();
      await loginOk();
      await session.tokenStorage.addOrUpdatePairing(lanRow());
      await ctl.load();
      // Arm the refusal HERE — after every dial the setup itself makes.
      t.armed = 1;

      final ConnectOutcome out = await ctl.connectTo(ctl.pairings.first);

      expect(out.success, isFalse);
      expect(t.fired, 1, reason: 'positive control: the refusal this test is about did happen');
      // 🔴 This is the assertion that would go red if the predicate stopped
      // asking about the channel: re-pairing a PC without the user's code (and
      // without the user) is a far worse defect than the copy this round fixes.
      expect(t.emittedNames, isNot(contains('mobile:pair')));
    });

    test('a cloud row refused for any OTHER reason is not re-admitted', () async {
      build(handshakeError: 'xhr poll error');
      await loginOk();
      await session.tokenStorage.addOrUpdatePairing(cloudRow());
      await ctl.load();
      // Arm the refusal HERE — after every dial the setup itself makes.
      t.armed = 1;

      final ConnectOutcome out = await ctl.connectTo(ctl.pairings.first);

      expect(out.success, isFalse);
      expect(t.fired, 1, reason: 'positive control: the refusal this test is about did happen');
      // 「we could not reach the relay」 is not 「our registration is gone」.
      // Re-admitting on it would turn every flaky network into a re-registration.
      expect(t.emittedNames, isNot(contains('mobile:pair')));
    });
  });

  // ── ① the copy ─────────────────────────────────────────────────────────────

  group('copy: a row with no PC never speaks about a PC', () {
    for (final AppLocale locale in AppLocale.values) {
      test('${locale.name} — cloudError is not the re-pair sentence', () {
        final AppStrings s = AppStrings(locale);
        final String cloud = s.cloudError(kHandshakeTokenInvalid);
        final String pc = s.pairError(kHandshakeTokenInvalid);
        // 🔴 Asserted by IDENTITY against the PC sentence rather than by keyword,
        // for the reason the L-② group already records: a keyword assertion rots
        // the moment either copy is reworded, and this pair must differ FOREVER.
        expect(cloud, isNot(pc),
            reason: 'the light-record row would be told to re-pair with a PC it does not have');
        // POSITIVE CONTROL — the probe is not merely finding two different
        // strings: the cloud sentence must actually be the sign-in one.
        expect(cloud, s.cloudError('AUTH_TOKEN_INVALID'));
        expect(cloud, isNotEmpty);
      });
    }
  });

  // ── 🔴 THE SENTENCE ON SCREEN, NOT THE SENTENCE IN THE TABLE ───────────────
  //
  // The group above proves the two copy tables DIFFER. That is exactly half the
  // claim, and it is the half that was already true before this round: the cloud
  // table has had its own AUTH_TOKEN_INVALID arm all along — nothing on the
  // returning user's path ever reached it. So this group taps the row and reads
  // what the SnackBar actually renders (0.2.53: a 「can the user read this」
  // verdict lands on the rendered result, never on the table it came from).

  group('rendered: the light-record row\'s toast', () {
    testWidgets('says sign in, and never 「重新配对」', (WidgetTester tester) async {
      final _RefusesNextConnect t = _RefusesNextConnect(kHandshakeTokenInvalid)
        ..connectSucceeds = true;
      // Signed OUT on purpose: that is the branch where a sentence is spoken at
      // all. Signed in, the row heals itself and there is nothing to read.
      await tester.pumpWidget(await rigWithCloudRow(t));
      await tester.pumpAndSettle();

      t.armed = 1;
      // The saas ROW does not print the pcName — it prints the product's own
      // name for the cloud instance (connections_row_cards.dart: `cloud ?
      // s.cloudInstance : pairingDisplayName(...)`). Tapping the stored name
      // would find nothing, which is a finder that silently tests nothing.
      await tester.tap(find.text(AppStrings(AppLocale.zh).cloudInstance).first);
      await tester.pumpAndSettle();

      expect(t.fired, 1, reason: 'positive control: the tap really was refused');
      final AppStrings zh = AppStrings(AppLocale.zh);
      // 🔴 The defect, as the owner read it off the screen.
      expect(find.text(zh.pairError(kHandshakeTokenInvalid)), findsNothing,
          reason: 'a row with no PC was told the PC cancelled its pairing');
      // POSITIVE CONTROL — a toast was shown, and it is the right one. Without
      // this the assertion above passes on a screen with no toast at all.
      expect(find.text(zh.cloudError(kHandshakeTokenInvalid)), findsOneWidget);
    });
  });

  // ── the predicate itself, exhaustively ─────────────────────────────────────

  group('shouldReadmitCloudRow', () {
    bool call({
      String? channel = kCloudChannel,
      String? code = kHandshakeTokenInvalid,
      bool loggedIn = true,
      bool tried = false,
    }) => shouldReadmitCloudRow(
      channel: channel,
      refusalCode: code,
      loggedIn: loggedIn,
      alreadyTried: tried,
    );

    test('all four conditions are load-bearing', () {
      expect(call(), isTrue);
      expect(call(channel: 'standalone'), isFalse);
      expect(call(channel: null), isFalse);
      expect(call(code: 'PAIR_RELEASED'), isFalse);
      expect(call(code: 'PC_BUSY'), isFalse);
      expect(call(code: null), isFalse);
      expect(call(loggedIn: false), isFalse);
      expect(call(tried: true), isFalse);
    });

    test('a hold-out code carrying its budget is still not this', () {
      // `connectTo` packs `CODE:ms` for the two hold-out codes. Neither can
      // occur on a row with no PC, and neither may be healed if it somehow does.
      expect(call(code: 'PAIR_RELEASED:47321'), isFalse);
      // And the guarded code must be matched WHOLE — a prefix is not a match.
      expect(call(code: '${kHandshakeTokenInvalid}_SOMETHING'), isFalse);
    });
  });
}

/// The connections page over real controllers, holding exactly one row: the
/// remembered cloud instance. Mirrors `connections_page_widget_test.dart`'s rig
/// — every probe faked, because the production ones are real HttpClients and a
/// widget test that reached the network would hang on `pumpAndSettle`.
Future<Widget> rigWithCloudRow(FakeSocketTransport t) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
  await appSettings.load();
  appSettings.setLocale(AppLocale.zh);
  final InMemoryTokenStorage storage = InMemoryTokenStorage();
  await storage.addOrUpdatePairing(
    MobileSession(
      token: 'fm_${'0' * 64}',
      endpoint: 'https://saas.test:443',
      channel: 'saas',
      pcName: 'FlowMic Cloud',
      pairingId: 'p-cloud',
      pcInstanceId: 'flowmic-cloud-instance',
    ),
  );
  final PttSession session = PttSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    stateMachine: FlowmicStateMachine(),
    tokenStorage: storage,
    retireTransport: () => FakeSocketTransport(),
  );
  session.healthReader = (Uri url, Duration timeout) async => HealthReading.offline;
  final LoginController login = LoginController(
    transport: t,
    accountStore: InMemoryAccountStore(),
    saasEndpoint: 'https://saas.test:443',
  );
  final ConnectionsController connections = ConnectionsController(
    session: session,
    login: login,
    saasEndpoint: 'https://saas.test:443',
    healthReader: (Uri url, Duration timeout) async => HealthReading.offline,
    presenceReader: (Uri u, String tok, Duration d) async =>
        PcPresenceReading.unknown,
  );
  return MaterialApp(
    home: ConnectionsPage(
      connections: connections,
      appSettings: appSettings,
      login: login,
      destination: DestinationController(),
      chatPageBuilder: () => const Scaffold(body: Text('CHAT')),
      settingsPageBuilder: () => const Scaffold(body: Text('SETTINGS')),
      historyPageBuilder: () => const Scaffold(body: Text('HISTORY')),
      updateListenable: ValueNotifier<bool>(false),
      hasUpdate: () => false,
    ),
  );
}
