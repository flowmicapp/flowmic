// card B4-15 —— complete the pairing path, at the session layer.
//
// The pure decisions live in endpoint_candidates_test.dart. THIS file answers
// the questions a pure test cannot: does `pair()` actually dial the address the
// probe chose, does the pairing REMEMBER the others, does a reconnect fall
// through to them, and does a total failure say which addresses it tried.
//
// The scenario is owner's own machine (2026-08-01 measured): the desktop resolved
// `10.0.0.78` (the VPN NIC) three rounds running and put that in the QR,
// while the phone can only reach `100.64.7.78`.

import 'dart:async';
import 'dart:io' show SocketException;

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/reconnect.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const String kVpn = '10.0.0.78';
const String kLan = '100.64.7.78';
const String kPort = '41879';

/// The exact string the desktop now writes (apps/desktop/src/lib/pairing.ts).
const String kQrWithAlt =
    'flowmic://pair?endpoint=ws://$kVpn:$kPort&code=1234&channel=standalone&alt=$kLan';
const String kQrNoAlt =
    'flowmic://pair?endpoint=ws://$kVpn:$kPort&code=1234&channel=standalone';

/// A transport that can REFUSE a dial — `FakeSocketTransport.connect` only ever
/// pushes an error status, and the "none of them connect" report is built in the catch around
/// a throwing connect, which is the shape a real dead host has.
class _RefusingTransport extends FakeSocketTransport {
  final Set<String> refuse = <String>{};

  @override
  Future<void> connect({
    required String url,
    String? token,
    String? jwt,
    String? pinFingerprint,
  }) async {
    if (refuse.contains(url)) throw const SocketException('connection refused');
    return super.connect(
      url: url,
      token: token,
      jwt: jwt,
      pinFingerprint: pinFingerprint,
    );
  }
}

/// Records every probe AND how many dials had happened when it ran, so a test
/// can tell a SELECTION probe (before the dial) from the channel-label probe
/// `pair()` fires afterwards. Without that split the 「single candidate probes
/// nothing」 assertion cannot be written at all.
class _Reader {
  _Reader(this.online, this.transport);
  final Set<String> online;
  final FakeSocketTransport transport;
  final List<String> beforeDial = <String>[];
  final List<String> afterDial = <String>[];

  Future<HealthReading> call(Uri url, Duration timeout) async {
    (transport.connectCalls == 0 ? beforeDial : afterDial).add(url.host);
    return online.contains(url.host)
        ? const HealthReading(ok: true, channel: ServerChannel.lan)
        : HealthReading.offline;
  }
}

Map<String, Object?> ackWithToken() => <String, Object?>{
  'token': 'tok-abcdefghijklmnopqrstuvwxyz012345',
  'pairing_id': 'pair-1',
  'pc_instance_id': 'inst-1',
  'pc_id': 'pc-1',
  'pc_machine_uid': 'machine-1',
  'pc_name': 'Studio PC',
};

void main() {
  group('pair() picks a REACHABLE address out of the QR', () {
    late _RefusingTransport t;
    late PttSession session;
    late _Reader reader;

    void build({required Set<String> online}) {
      t = _RefusingTransport()..connectSucceeds = true;
      t.defaultAck = ackWithToken();
      session = newTestSession(transport: t)
        ..candidateProbeTimeout = const Duration(milliseconds: 50);
      reader = _Reader(online, t);
      session.healthReader = reader.call;
    }

    tearDown(() => session.dispose());

    test('dials the LAN NIC even though the QR named the VPN one', () async {
      build(online: <String>{kLan});
      final PairResult r = await session.pair(
        PairEntry.parse(kQrWithAlt),
        endpoint: 'ws://$kVpn:$kPort',
      );
      expect(r.ok, isTrue);
      expect(t.lastConnectUrl, 'ws://$kLan:$kPort');
      // Both were asked, and asked BEFORE anything was dialled.
      expect(reader.beforeDial, <String>[kVpn, kLan]);
    });

    test('REVERSE: when the QR`s own address answers, that is the one dialled', () {
      // Otherwise an implementation that simply always took the last candidate
      // would pass the test above — and it would move every single-NIC pairing
      // off the address the desktop chose.
      build(online: <String>{kVpn, kLan});
      return session
          .pair(PairEntry.parse(kQrWithAlt), endpoint: 'ws://$kVpn:$kPort')
          .then((PairResult r) {
            expect(r.ok, isTrue);
            expect(t.lastConnectUrl, 'ws://$kVpn:$kPort');
          });
    });

    test('a QR with no alt= probes NOTHING before dialling', () async {
      // The compatibility guarantee, measured: a pre-B4-15 QR and a hand-typed
      // address must cost exactly what they cost before this card.
      build(online: <String>{kVpn});
      final PairResult r = await session.pair(
        PairEntry.parse(kQrNoAlt),
        endpoint: 'ws://$kVpn:$kPort',
      );
      expect(r.ok, isTrue);
      expect(reader.beforeDial, isEmpty);
      expect(t.lastConnectUrl, 'ws://$kVpn:$kPort');
    });

    test('the pairing REMEMBERS the other addresses (normalized, http form)', () async {
      build(online: <String>{kLan});
      await session.pair(PairEntry.parse(kQrWithAlt), endpoint: 'ws://$kVpn:$kPort');
      final MobileSession stored = (await session.tokenStorage.readSession())!;
      // The endpoint is where it really connected, not what the QR said.
      expect(stored.endpoint, 'http://$kLan:$kPort');
      expect(stored.endpointCandidates, <String>[
        'http://$kVpn:$kPort',
        'http://$kLan:$kPort',
      ]);
    });

    test('a single-address pairing records NO candidate list', () async {
      // "one candidate" must stay indistinguishable from "this feature does not exist" on disk too:
      // a one-element list would be the endpoint said twice, and the next reader
      // would have to decide which copy is authoritative.
      build(online: <String>{kVpn});
      await session.pair(PairEntry.parse(kQrNoAlt), endpoint: 'ws://$kVpn:$kPort');
      final MobileSession stored = (await session.tokenStorage.readSession())!;
      expect(stored.endpointCandidates, isEmpty);
    });

    test('nothing reachable AND the dial refused ⇒ the report names both', () async {
      build(online: <String>{});
      t.refuse.addAll(<String>['ws://$kVpn:$kPort', 'ws://$kLan:$kPort']);
      final PairResult r = await session.pair(
        PairEntry.parse(kQrWithAlt),
        endpoint: 'ws://$kVpn:$kPort',
      );
      expect(r.ok, isFalse);
      // What the SHEET puts on screen — the whole point of the loud report.
      final String copy = AppStrings.of(AppLocale.zh).pairError(r.error);
      expect(copy, contains(kVpn));
      expect(copy, contains(kLan));
      expect(copy, contains('够不着'));
      // …and it is NOT the one-line 「无法连接到电脑」 that hid this before.
      expect(copy, isNot('无法连接到电脑'));
    });

    test('a single-address failure keeps the OLD copy (no address list)', () async {
      // Reverse control for the branch above: the new sentence must not leak
      // into the case it was not written for.
      build(online: <String>{});
      t.refuse.add('ws://$kVpn:$kPort');
      final PairResult r = await session.pair(
        PairEntry.parse(kQrNoAlt),
        endpoint: 'ws://$kVpn:$kPort',
      );
      expect(r.ok, isFalse);
      expect(r.error, startsWith('CONNECT_FAILED:'));
      expect(AppStrings.of(AppLocale.zh).pairError(r.error), '无法连接到电脑');
    });
  });

  group('resumePairing() heals onto another NIC of the same PC', () {
    test('the stored address is dead ⇒ dial the recorded alternate, and REMEMBER it', () async {
      final _RefusingTransport t = _RefusingTransport()..connectSucceeds = true;
      t.defaultAck = <String, Object?>{'ok': true, 'pc_name': 'Studio PC'};
      final PttSession session = newTestSession(transport: t)
        ..candidateProbeTimeout = const Duration(milliseconds: 50);
      final _Reader reader = _Reader(<String>{kLan}, t);
      session.healthReader = reader.call;
      addTearDown(session.dispose);

      const MobileSession stored = MobileSession(
        token: 'tok-abcdefghijklmnopqrstuvwxyz012345',
        endpoint: 'http://$kVpn:$kPort',
        pcInstanceId: 'inst-1',
        pcId: 'pc-1',
        pcMachineUid: 'machine-1',
        endpointCandidates: <String>['http://$kVpn:$kPort', 'http://$kLan:$kPort'],
      );
      await session.tokenStorage.addOrUpdatePairing(stored);

      expect(await session.resumePairing(stored), isTrue);
      expect(t.lastConnectUrl, 'http://$kLan:$kPort');

      final List<MobileSession> rows = await session.tokenStorage.readPairings();
      // ONE row, not two: the identity is the PC's instance id, so healing the
      // address updates the pairing instead of forking a second one.
      expect(rows, hasLength(1));
      expect(rows.single.endpoint, 'http://$kLan:$kPort');
      expect(rows.single.endpointCandidates, hasLength(2));
    });

    test('a pairing with no recorded candidates dials exactly what it stored', () async {
      final _RefusingTransport t = _RefusingTransport()..connectSucceeds = true;
      t.defaultAck = <String, Object?>{'ok': true};
      final PttSession session = newTestSession(transport: t);
      final _Reader reader = _Reader(<String>{}, t);
      session.healthReader = reader.call;
      addTearDown(session.dispose);

      const MobileSession stored = MobileSession(
        token: 'tok-abcdefghijklmnopqrstuvwxyz012345',
        endpoint: 'http://$kVpn:$kPort',
        pcInstanceId: 'inst-1',
      );
      await session.resumePairing(stored);
      expect(t.lastConnectUrl, 'http://$kVpn:$kPort');
      expect(reader.beforeDial, isEmpty);
    });
  });

  group('the candidate list survives the places that REBUILD a MobileSession', () {
    const MobileSession row = MobileSession(
      token: 'tok-abcdefghijklmnopqrstuvwxyz012345',
      endpoint: 'http://$kLan:$kPort',
      pcInstanceId: 'inst-1',
      endpointCandidates: <String>['http://$kVpn:$kPort', 'http://$kLan:$kPort'],
    );

    test('alias_keeps_candidates — renaming a PC must not drop them', () async {
      // `_setAliasIn` builds a MobileSession LITERAL (it needs an explicit null
      // to CLEAR an alias, which copyWith cannot express), so every new field has
      // to be listed there by hand. CLAUDE.md anti-façade ⑤ is exactly this shape:
      // 「字面量里没有的字段，调用方永远看不到」 — and it produced a silently empty
      // array that survived for weeks. This test is the guard that fails instead.
      final InMemoryTokenStorage store = InMemoryTokenStorage();
      await store.addOrUpdatePairing(row);
      await store.setPairingAlias(row, '书房台式机');
      final MobileSession after = (await store.readSession())!;
      expect(after.displayAlias, '书房台式机');
      expect(after.endpointCandidates, row.endpointCandidates);
    });

    test('the JSON round-trip keeps them, and a legacy row simply has none', () {
      final MobileSession back = MobileSession.fromJson(row.toJson())!;
      expect(back.endpointCandidates, row.endpointCandidates);
      // A pairing written before this card: absent, not guessed.
      final Map<String, Object?> legacy = row.toJson()..remove('endpoint_candidates');
      expect(MobileSession.fromJson(legacy)!.endpointCandidates, isEmpty);
      // And junk in the array is dropped element-by-element rather than cast.
      final MobileSession dirty = MobileSession.fromJson(<String, Object?>{
        ...legacy,
        'endpoint_candidates': <Object?>['http://$kVpn:$kPort', '', 42, null],
      })!;
      expect(dirty.endpointCandidates, <String>['http://$kVpn:$kPort']);
    });
  });

  group('the reconnect ladder can move address (ReconnectCoordinator contract)', () {
    test('no resolver ⇒ the rung dials the configured url, unchanged', () {
      // The compatibility half: every harness in this repo builds the ladder
      // without a resolver, and this is what says they are untouched.
      fakeAsync((FakeAsync async) {
        final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = false;
        final ReconnectCoordinator coord = ReconnectCoordinator(
          transport: t,
          bufferedChunksProvider: () => const <Map<String, Object?>>[],
          url: 'ws://$kVpn:$kPort',
        )..start();
        t.pushStatus(SocketStatus.disconnected);
        async.elapse(const Duration(seconds: 1));
        expect(t.connectCalls, 1);
        expect(t.lastConnectUrl, 'ws://$kVpn:$kPort');
        expect(coord.url, 'ws://$kVpn:$kPort');
      });
    });

    test('a resolver`s answer is DIALLED and ADOPTED as the ladder`s url', () {
      fakeAsync((FakeAsync async) {
        final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = false;
        final List<String> asked = <String>[];
        final ReconnectCoordinator coord = ReconnectCoordinator(
          transport: t,
          bufferedChunksProvider: () => const <Map<String, Object?>>[],
          url: 'ws://$kVpn:$kPort',
          dialUrlResolver: (String current) async {
            asked.add(current);
            return 'ws://$kLan:$kPort';
          },
        )..start();
        t.pushStatus(SocketStatus.disconnected);
        async.elapse(const Duration(seconds: 1));
        async.flushMicrotasks();
        expect(asked, <String>['ws://$kVpn:$kPort']);
        expect(t.lastConnectUrl, 'ws://$kLan:$kPort');
        // Adopted, so the NEXT rung and everyone reading `url` (the channel
        // probe on the reconnected edge) agree with what was dialled.
        expect(coord.url, 'ws://$kLan:$kPort');
      });
    });

    test('a resolver that answers null / throws leaves the ladder alone', () {
      fakeAsync((FakeAsync async) {
        final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = false;
        final ReconnectCoordinator coord = ReconnectCoordinator(
          transport: t,
          bufferedChunksProvider: () => const <Map<String, Object?>>[],
          url: 'ws://$kVpn:$kPort',
          dialUrlResolver: (String current) async => null,
        )..start();
        t.pushStatus(SocketStatus.disconnected);
        async.elapse(const Duration(seconds: 1));
        async.flushMicrotasks();
        expect(t.lastConnectUrl, 'ws://$kVpn:$kPort');
        expect(coord.url, 'ws://$kVpn:$kPort');

        final FakeSocketTransport t2 = FakeSocketTransport()..connectSucceeds = false;
        ReconnectCoordinator(
          transport: t2,
          bufferedChunksProvider: () => const <Map<String, Object?>>[],
          url: 'ws://$kVpn:$kPort',
          dialUrlResolver: (String current) async => throw StateError('resolver blew up'),
        ).start();
        t2.pushStatus(SocketStatus.disconnected);
        async.elapse(const Duration(seconds: 1));
        async.flushMicrotasks();
        expect(t2.lastConnectUrl, 'ws://$kVpn:$kPort');
      });
    });
  });
}
