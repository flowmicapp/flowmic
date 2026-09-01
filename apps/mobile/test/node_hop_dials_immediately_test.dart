// 🔴 P0 S2 (owner 2026-09-01) — 「pairing must succeed ONCE, the first time」:
// the follow-your-PC hop must not spend a second of the user's first
// impression waiting out a backoff rung it did not earn.
//
// SPEC-REF:
//   lib/src/ptt/ptt_reconnect_ack.dart  (_followNodeIfMisplaced)
//   lib/src/signaling/reconnect.dart    (kickNow, initialBackoff = 1 s)
//   lib/src/signaling/node_list_client.dart (planNodeHop's `cached`)
//
// ── WHAT THE LADDER WAS DOING, AND WHY IT WAS RIGHT TO ──────────────────────
// The hop ends in `transport.disconnect()`, which publishes `disconnected` —
// deliberately, because `superseded` publishes `connecting` and the ladder
// schedules nothing on that (F-5, the capsule flicker). So the ladder reads a
// real drop and arms its FIRST RUNG: `initialBackoff`, one second. Backoff is
// there to stop a client hammering a link that is failing; this link did not
// fail, we moved it. Same distinction 0.2.51 drew between 「replacing a live
// connection」 and 「a real drop」, one layer up.
//
// ── HOW THIS FILE MEASURES IT ───────────────────────────────────────────────
// Real clock, not `fakeAsync`: the criterion is 「did the dial happen WITHOUT
// waiting out the rung」, and a fake clock turns that into 「did I elapse the
// right amount」. 120 ms is far below the 1 s rung and far above the zero-delay
// timer, so the two outcomes cannot be confused. The node directory is SEEDED
// (`NodeLabels.debugSeed`) so `planNodeHop` resolves from memory and this test
// never opens a socket to anywhere — which is also the second thing it proves.
//
// ── 🔴 TWO REVERSE CONTROLS, BOTH MEASURED RED (2026-09-01) ─────────────────
// (C, marker REVERSE-CONTROL-C) `s.reconnect.kickNow(reason: 'node-hop')`
// commented out — i.e. the hop rides the ladder's first rung again. Verbatim,
// with the ladder's own debug line one line above it:
//
//   [flowmic.reconnect] schedule attempt=1 delay=1000ms url=https://srvjp.example
//   🔴 a deliberate hop dials the new node IMMEDIATELY, not after the ladder's
//   1 s first rung [E]
//     Expected: a value greater than <1>
//       Actual: <1>
//        Which: is not a value greater than <1>
//
// (D, marker REVERSE-CONTROL-D) the pair leg's
// `unawaited(_followNodeIfMisplaced(this, token, ack))` moved back ABOVE
// `reconnect.configure`, which is where it stood until today. Verbatim:
//
//   🔴 THE PAIR LEG HOPS AT ALL — the 「user just scanned the QR」 path … [E]
//     Expected: 'https://srvjp.example'
//       Actual: 'http://192.0.2.5:55889'
//        Which: is different. … Differ at offset 4
//
// Both restored; `grep -rn REVERSE-CONTROL apps/mobile/lib` finds none of
// these markers; re-greened 4/4 here and 7/7 in node_follow_wired_test.dart.

import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show PairEntry;
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/signaling/node_follow.dart' show RelayNode;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const String _token = 'tok-0123456789abcdef0123456789abcdef';
const String _here = 'http://192.0.2.5:55889';
const String _home = 'https://srvjp.example';

PttSession _session(FakeSocketTransport transport) {
  transport.connectSucceeds = true;
  final PttSession s = newTestSession(transport: transport);
  s.healthReader = (Uri url, Duration timeout) async => HealthReading.offline;
  // 🔴 The directory the node badge already read. Seeding it is what keeps this
  // test off the network AND is the second half of the card: `planNodeHop`
  // consults it before it fetches, so a hop that can be resolved from memory
  // costs no round trip at all.
  s.reconnect.nodeLabels.debugSeed(
    <String, String>{'srvjp': 'asia'},
    nodes: <RelayNode>[
      const RelayNode(id: 'srvny', url: 'https://srvny.example', isWriter: true),
      const RelayNode(id: 'srvjp', url: _home),
    ],
  );
  return s;
}

/// The ack a phone gets when it is talking to the writer while its PC lives on
/// a replica — the exact situation the P0 is about.
Map<String, Object?> _crossNodeAck() => <String, Object?>{
      'ok': true,
      'pc_id': 'pc-1',
      'home_node': 'srvjp',
      'node': 'srvny',
    };

Future<bool> _resume(PttSession s) => s.resumePairing(
      const MobileSession(token: _token, endpoint: _here),
    );

void main() {
  test('🔴 a deliberate hop dials the new node IMMEDIATELY, not after the '
      'ladder\'s 1 s first rung', () async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final PttSession s = _session(transport);
    addTearDown(s.dispose);

    transport.ackQueue.addAll(<Object?>[
      _crossNodeAck(),
      // The re-admission on the PC's own node, once we get there.
      <String, Object?>{'ok': true, 'pc_id': 'pc-1', 'pc_name': 'dev-pc-a'},
    ]);

    expect(await _resume(s), isTrue,
        reason: 'positive control: the first admission succeeded, so what '
            'follows is a HOP and not a failure');
    final int dialsBefore = transport.connectCalls;

    // Well inside the 1 s rung the hop would otherwise have to sit out.
    await Future<void>.delayed(const Duration(milliseconds: 120));

    expect(transport.connectCalls, greaterThan(dialsBefore),
        reason: 'the hop is still waiting out a backoff rung it did not earn — '
            'that second is spent by a user who has just scanned a QR code and '
            'is watching for the confirmation');
    expect(transport.lastConnectUrl, _home,
        reason: 'and it must dial the PC\'s node, not re-dial where we were');
  });

  test('🔴 THE PAIR LEG HOPS AT ALL — the 「user just scanned the QR」 path, '
      'which is the one the P0 is about', () async {
    // 🔴 WHAT THIS CAUGHT (2026-09-01). `unawaited(f())` runs f's body
    // synchronously up to its first `await`, and `_followNodeIfMisplaced`
    // starts by reading `reconnect.url`. On the FIRST pairing of an app run
    // that is still null — `ReconnectCoordinator` is constructed with no url
    // and only `pair` / `resumePairing` ever configure one — so the call was
    // returning immediately: no node badge, no hop, on exactly the path a
    // first-time user takes. The call sat ABOVE `reconnect.configure`; moving
    // it below is the whole fix.
    //
    // ⚠️ The pre-existing wiring test (`node_follow_wired_test.dart`) greps for
    // the call and was green throughout, which is the point: 「the line is
    // there」 and 「the line does something」 are two assertions.
    final FakeSocketTransport transport = FakeSocketTransport();
    final PttSession s = _session(transport);
    addTearDown(s.dispose);
    transport.ackQueue.addAll(<Object?>[
      // The `mobile:pair` ack, answered by the WRITER because that leg is
      // writer-only, naming a PC that lives on a replica.
      <String, Object?>{
        'token': _token,
        'pc_id': 'pc-1',
        'home_node': 'srvjp',
        'node': 'srvny',
      },
      <String, Object?>{'ok': true, 'pc_id': 'pc-1'},
    ]);

    final PairResult r =
        await s.pair(PairEntry.parse('1234'), endpoint: _here);
    expect(r.ok, isTrue, reason: 'positive control: the pairing succeeded');
    await Future<void>.delayed(const Duration(milliseconds: 120));

    expect(s.reconnect.url, _home,
        reason: 'a first pairing to a PC on another node left the phone in a '
            'room its PC would never join — silently, because mirrorToPc drops '
            'a frame for an absent PC with no error and no log');
    expect(transport.lastConnectUrl, _home);
  });

  test('🔴 REVERSE DIRECTION — a hop that cannot be resolved changes nothing',
      () async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final PttSession s = newTestSession(transport: transport);
    transport.connectSucceeds = true;
    s.healthReader = (Uri url, Duration timeout) async => HealthReading.offline;
    addTearDown(s.dispose);
    // A directory that does not contain the wanted node. `planNodeHop` then
    // falls through to the real fetch, which cannot reach TEST-NET-1 and
    // answers with an empty list ⇒ stay put. The point of the case is that
    // 「we could not work out where to go」 degrades to today's behaviour and
    // never to a guess or to a dead socket.
    s.reconnect.nodeLabels.debugSeed(const <String, String>{},
        nodes: <RelayNode>[
          const RelayNode(id: 'srvny', url: 'https://srvny.example'),
        ]);
    transport.ackQueue.add(_crossNodeAck());

    expect(await _resume(s), isTrue);
    final int dialsBefore = transport.connectCalls;
    await Future<void>.delayed(const Duration(milliseconds: 120));
    expect(transport.connectCalls, dialsBefore,
        reason: 'an unresolvable hop must not drop the socket we are on');
    expect(s.reconnect.url, _here, reason: 'and must not move the ladder');
  }, timeout: const Timeout(Duration(seconds: 30)));

  test('🔴 the LADDER, not a second dialling path — the hop leaves the '
      'coordinator running and pointed at the new node', () async {
    // 「which address to dial」 is a machine identity (never cross-wire ids), so
    // it must keep ONE author. `kickNow` routes through `_scheduleReconnect` →
    // `_resolveThenDial` exactly as every other rung does; a bespoke dial here
    // would give that question a second answer.
    final FakeSocketTransport transport = FakeSocketTransport();
    final PttSession s = _session(transport);
    addTearDown(s.dispose);
    transport.ackQueue.addAll(<Object?>[
      _crossNodeAck(),
      <String, Object?>{'ok': true, 'pc_id': 'pc-1'},
    ]);

    expect(await _resume(s), isTrue);
    await Future<void>.delayed(const Duration(milliseconds: 120));

    expect(s.reconnect.url, _home);
    expect(s.reconnect.isRunning, isTrue,
        reason: 'a hop that stopped the ladder would leave the phone with no '
            'way back if the new node refused the dial');
    // The persisted endpoint IS 「remember the last known node」: a cold start
    // must go straight there rather than repeat the hop on every launch.
    final List<MobileSession> stored = await s.tokenStorage.readPairings();
    expect(stored.single.endpoint, _home);
  });
}
