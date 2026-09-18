// owner 2026-09-17 — the App scans the site's demo QR and joins as an
// EPHEMERAL session (docs/decisions/2026-09-17-owner-app-scans-demo-qr-as-
// ephemeral-session.md; design docs/strategy/2026-09-17-app-ephemeral-demo-
// session-design.md). This file is the wiring proof for the five faces the
// design names, on the REAL chain (PttSession + PairEntry.parse) over a fake
// socket, with a REAL clock where the question is 「will it dial again by
// itself」 — the same reasoning hold_out_recheck_wire_test.dart gives for not
// using fakeAsync there.
//
// What each case pins, and why the positive control sits beside it:
//   · recognition: the demo link (with and without a locale prefix) parses as
//     `ephemeral`; the `/go/pair` form and a `/go/xx/pair` form do not.
//   · persistence: after a demo pair, token storage is EMPTY. The control is
//     the same ack through the `/go/pair` form, which leaves one row — so an
//     empty storage cannot be a storage that never works.
//   · crosstalk: `session.pcId` is the ack's `pc_id`, nothing else.
//   · the ladder: after the socket drops, no redial in 1.4 s, hold-out never
//     armed, `isRunning` false. The control is the persistent form, whose
//     ladder DOES redial on the same drop.
//   · residue: after `clearConnectedInstance`, the ladder holds no url/token
//     and the flag is down.

import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/pair_result.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const String _query =
    'endpoint=wss://relay.flowmic.app&code=4831&channel=saas&pcid=930582147&v=1';

/// The English demo page's QR, byte-for-byte what `webRoomPairUrl` mints with
/// `DEMO_PAIR_HTTPS_PATH` (apps/server-core/src/http/web-room-routes.ts).
const String _demoLink = 'https://flowmic.app/go/demo?$_query';

/// The Simplified-Chinese page's QR: a locale in front, the last segment the
/// same (flowmic-web pairAddress.ts only promises the last segment).
const String _demoLinkZh = 'https://flowmic.app/go/zh-cn/demo?$_query';

/// The persistent form of the SAME query — the positive control.
const String _pairLink = 'https://flowmic.app/go/pair?$_query';

Map<String, Object?> _ack() => <String, Object?>{
      'ok': true,
      'token': 'demo-token-000000000000000000000000',
      'pc_id': 'pc-demo-1',
      'pc_instance_id': 'inst-demo-1',
      'pc_name': 'FlowMic Web',
    };

PttSession _session(FakeSocketTransport transport, InMemoryTokenStorage storage) {
  transport.connectSucceeds = true;
  final PttSession s = newTestSession(transport: transport, tokenStorage: storage);
  // The channel probe must not reach a real network: this file measures
  // persistence and dialling, not the relay's /api/health.
  s.healthReader = (Uri url, Duration timeout) async => HealthReading.offline;
  return s;
}

void main() {
  group('PairEntry.parse — recognition', () {
    test('the demo link, with and without a locale prefix, parses as ephemeral', () {
      for (final String link in <String>[_demoLink, _demoLinkZh]) {
        final PairEntry e = PairEntry.parse(link);
        expect(e.ephemeral, isTrue, reason: link);
        expect(e.payload.qrPayload, link, reason: 'forwarded VERBATIM');
        expect(e.endpoint, 'wss://relay.flowmic.app');
      }
    });

    test('the /go/pair form of the same query is NOT ephemeral (unchanged)', () {
      final PairEntry e = PairEntry.parse(_pairLink);
      expect(e.ephemeral, isFalse);
      expect(e.payload.qrPayload, _pairLink);
    });

    test('a locale-prefixed /go/xx/pair is not recognised as either form', () {
      // It is neither the declared pair prefix nor a demo link: the loud
      // FormatException is the honest answer, not a quiet ephemeral session.
      expect(
        () => PairEntry.parse('https://flowmic.app/go/zh-cn/pair?$_query'),
        throwsFormatException,
      );
    });

    test('a demo link without a 4-digit code is refused like any other link', () {
      expect(
        () => PairEntry.parse('https://flowmic.app/go/demo?endpoint=wss://relay.flowmic.app&channel=saas'),
        throwsFormatException,
      );
    });
  });

  test('a demo pair persists NOTHING; the same ack via /go/pair persists one row (control)', () async {
    // ── ephemeral ──
    final FakeSocketTransport t1 = FakeSocketTransport();
    final InMemoryTokenStorage s1 = InMemoryTokenStorage();
    final PttSession demo = _session(t1, s1);
    addTearDown(demo.dispose);
    t1.ackQueue.add(_ack());
    final PairResult r1 = await demo.pair(PairEntry.parse(_demoLink), endpoint: 'wss://relay.flowmic.app');
    expect(r1.ok, isTrue, reason: r1.error);
    expect(r1.session, isNull, reason: 'nothing for the list to remember');
    expect(await s1.readPairings(), isEmpty, reason: 'mobile_pairings / token must not be persisted');
    expect(demo.ephemeralSession.value, isTrue);
    expect(demo.paired.value, isTrue, reason: 'the room is real — only the persistence is not');
    expect(demo.connectedDeviceName.value, 'FlowMic Web', reason: 'the header name comes from the ack');
    // 绝不许串号 — the ONE author of target_pc_id is this ack's pc_id.
    expect(demo.pcId, 'pc-demo-1');
    // The ack itself is the ordinary mobile:pair frame with the link verbatim.
    final Object? sent = t1.emittedWhere('mobile:pair').single.data;
    expect((sent as Map)['qr_payload'], _demoLink);

    // ── control: persistent ──
    final FakeSocketTransport t2 = FakeSocketTransport();
    final InMemoryTokenStorage s2 = InMemoryTokenStorage();
    final PttSession persistent = _session(t2, s2);
    addTearDown(persistent.dispose);
    t2.ackQueue.add(_ack());
    final PairResult r2 = await persistent.pair(PairEntry.parse(_pairLink), endpoint: 'wss://relay.flowmic.app');
    expect(r2.ok, isTrue, reason: r2.error);
    expect(r2.session, isNotNull);
    expect((await s2.readPairings()).length, 1, reason: 'the control proves storage works — so the empty one above is a decision, not a broken store');
    expect(persistent.ephemeralSession.value, isFalse);
    expect(persistent.pcId, 'pc-demo-1');
  });

  test('after the socket drops, an ephemeral session never dials again (real clock); the persistent one does (control)', () async {
    final FakeSocketTransport t1 = FakeSocketTransport();
    final PttSession demo = _session(t1, InMemoryTokenStorage());
    addTearDown(demo.dispose);
    t1.ackQueue.add(_ack());
    expect((await demo.pair(PairEntry.parse(_demoLink), endpoint: 'wss://relay.flowmic.app')).ok, isTrue);
    expect(demo.reconnect.isRunning, isFalse, reason: 'the ladder must never have been started');
    expect(t1.connectCalls, 1);

    // The relay closes the socket (room expired, or the page went away and the
    // relay dropped us). Nothing on this phone may knock again.
    t1.pushStatus(SocketStatus.disconnected);
    await Future<void>.delayed(const Duration(milliseconds: 1400));
    expect(t1.connectCalls, 1, reason: 'a redial here IS the defect: 「App 不重连」');
    expect(demo.reconnect.isRunning, isFalse);
    expect(demo.holdOutArmed, isFalse, reason: 'no mobile:reconnect ⇒ no PAIR_RELEASED ⇒ no timer');
    expect(t1.emittedWhere('mobile:reconnect'), isEmpty);

    // ── control ──
    final FakeSocketTransport t2 = FakeSocketTransport();
    final PttSession persistent = _session(t2, InMemoryTokenStorage());
    addTearDown(persistent.dispose);
    t2.ackQueue.add(_ack());
    expect((await persistent.pair(PairEntry.parse(_pairLink), endpoint: 'wss://relay.flowmic.app')).ok, isTrue);
    expect(persistent.reconnect.isRunning, isTrue);
    t2.pushStatus(SocketStatus.disconnected);
    await Future<void>.delayed(const Duration(milliseconds: 1400));
    expect(t2.connectCalls, greaterThan(1), reason: 'the ladder\'s first rung is 1 s — the control shows the clock above was long enough to catch a redial');
  });

  test('leaving the page leaves nothing behind: no url/token in the ladder, flag down, storage still empty', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final InMemoryTokenStorage storage = InMemoryTokenStorage();
    final PttSession demo = _session(t, storage);
    addTearDown(demo.dispose);
    t.ackQueue.add(_ack());
    expect((await demo.pair(PairEntry.parse(_demoLinkZh), endpoint: 'wss://relay.flowmic.app')).ok, isTrue);
    expect(demo.reconnect.url, isNotNull, reason: 'while it lasts, the presence poll reads these');
    expect(demo.reconnect.token, isNotNull);

    // What `ConnectionsController.leaveRoom()` does on the return edge.
    await demo.reconnect.stop();
    await t.disconnect();
    demo.paired.value = false;
    demo.clearConnectedInstance();

    expect(demo.ephemeralSession.value, isFalse);
    expect(demo.reconnect.url, isNull);
    expect(demo.reconnect.token, isNull);
    expect(demo.pcId, isNull);
    expect(demo.connectedInstanceId, isNull);
    expect(await storage.readPairings(), isEmpty);
    expect(t.connectCalls, 1);
  });
}
