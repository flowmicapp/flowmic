// NR-61 — the phone follows a PC that changed node WHILE ITS OWN SOCKET STAYED UP.
//
// SPEC-REF:
//   docs/strategy/2026-09-16-node-selection-audit.md §4-1 (fourth row) / §5-C
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md §49
//   lib/src/ptt/ptt_presence_poll.dart      (the discovery)
//   lib/src/ptt/ptt_reconnect_ack.dart      (_followMovedPcNode / _applyNodeMove)
//   apps/server-core/src/http/presence-routes.ts (the two additive keys)
//
// ── THE DEFECT, AND WHY NOTHING ELSE IN THE APP COULD SEE IT ────────────────
//
// The phone learns `home_node` from ONE place: its own `mobile:reconnect` /
// `mobile:pair` ack. The desktop re-picks its node on every start, on the
// offline switch returning, and on a heartbeat-death rebuild
// (`socket/node_select.rs`) — and none of those drops THIS phone's socket. So
// there is no next ack, `reconnect.pcHomeNode` keeps naming the old node, and
// the phone's room stays in a process the PC has left.
//
// Nothing then reports anything. The old node answers the idle poll 「online」 —
// truthfully, off a forwarded heartbeat — and `audio.handler.ts` `mirrorToPc`
// drops every audio frame for a room with no PC in it with no error, no refusal
// and no log. The user talks, the phone shows text, the computer shows nothing,
// and both ends are green. The only cure was backgrounding the app
// (`app_lifecycle_edges.dart` kicks a reconnect, which produces a fresh ack).
//
// ── WHAT THIS FILE PINS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────
//
// It drives the REAL `PttSession` (a real `resumePairing`, the real poll timer,
// the real `ReconnectCoordinator`) and asserts the phone DIALS THE OTHER NODE.
// It does not assert anything about the relay's JSON — the reading is handed in
// through `PttSession.presenceReader`, and the server half has its own evidence
// (`apps/server-core/test/http-pc-presence.test.ts` + golden G16). The two halves
// meet at `PcPresenceReading.homeNode`, which is parsed in
// `pc_presence_probe_test.dart` against a REAL HttpServer.
//
// ── 🔴 REVERSE CONTROL, MEASURED RED 2026-09-17 ────────────────────────────
// `unawaited(_followMovedPcNode(...))` in ptt_presence_poll.dart replaced by the
// marker REVERSE-CONTROL-NR61. Verbatim, `+3 -1`:
//
//   🔴 a PC that moved node while this socket stayed up is FOLLOWED [E]
//     Expected: a value greater than <0>
//       Actual: <0>
//        Which: is not a value greater than <0>
//
// ⚠️ THE OTHER THREE STAYED GREEN, and that is the useful half of the reading:
// the downgrade case does not depend on the move (its gate is the wrong-node
// check, which was already there), and the two 「do nothing」 cases cannot tell a
// working comparison from a missing one — which is exactly why this file needs
// the first case and why 「three of four green」 would have proved nothing.
//
// Restored, `grep -rn REVERSE-CONTROL-NR61 apps/mobile/lib` finds nothing, 4/4
// green again.

import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/signaling/node_follow.dart' show RelayNode;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/mic_permission_fakes.dart';

const String _kToken = 'tok-test-abcdefghijklmnopqrstuvwxyz012';
const String _kEndpoint = 'http://127.0.0.1:9999';
const String _kPcId = 'pc-test-1';
const String _kHereUrl = 'https://srvny.example';
const String _kThereUrl = 'https://srvjp.example';

class _Built {
  _Built(this.session, this.transport);
  final PttSession session;
  final FakeSocketTransport transport;
}

/// A session that is paired, connected, idle, and KNOWS IT IS ON `srvny`.
///
/// The first ack is deliberately SETTLED (`home_node == node`): the ack leg must
/// have nothing to do, so any hop this file observes was caused by the poll and
/// by nothing else. That is the positive control for every case below.
_Built _pairedOnSrvny(FakeAsync async, {required PcPresenceReading answer}) {
  final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
  final PttSession session = PttSession(
    transport: t,
    stateMachine: FlowmicStateMachine(),
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: InMemoryTokenStorage(),
    micPermission: newTestMicPermission(),
  );
  session.healthReader = (Uri url, Duration timeout) async => HealthReading.offline;
  session.presenceReader = (Uri url, String token, Duration timeout) async => answer;
  t.ackQueue.addAll(<Object?>[
    // Where this phone is, and where the PC was when it last said so.
    <String, Object?>{'ok': true, 'pc_id': _kPcId, 'node': 'srvny', 'home_node': 'srvny'},
    // The re-admission on the PC's new node, once we get there.
    <String, Object?>{'ok': true, 'pc_id': _kPcId, 'node': 'srvjp', 'home_node': 'srvjp'},
  ]);

  bool? accepted;
  unawaited(session.resumePairing(const MobileSession(
    token: _kToken,
    endpoint: _kEndpoint,
    channel: 'standalone',
    pcId: _kPcId,
    pcMachineUid: 'machine-test-1',
  )).then((bool ok) => accepted = ok));
  async.flushMicrotasks();
  if (accepted != true) {
    throw StateError('test setup: resumePairing did not accept (accepted=$accepted)');
  }
  // 🔴 SEEDED AFTER THE ACK, NOT BEFORE, and this cost an hour: `noteAnsweringNode`
  // kicks `NodeLabels.ensureLoaded(endpoint)` off that very ack, and
  // `httpNodeListFetch` answers 「empty list」 for every failure — so a directory
  // seeded before pairing is OVERWRITTEN WITH NOTHING the moment the loopback
  // address refuses the connection, and every case below then passes for the
  // wrong reason (`resolveNodeUrl` returns null ⇒ 「stay」 ⇒ no dial ⇒ three of
  // the four assertions still green). Seeding here is also the production
  // ordering: by the time the idle poll runs, the directory has been read.
  session.reconnect.nodeLabels.debugSeed(
    <String, String>{'srvny': 'us', 'srvjp': 'asia'},
    nodes: <RelayNode>[
      const RelayNode(id: 'srvny', url: _kHereUrl, isWriter: true),
      const RelayNode(id: 'srvjp', url: _kThereUrl),
    ],
  );
  return _Built(session, t);
}

/// One poll tick plus enough time for the zero-delay rung `kickNow` arms.
void _oneTick(FakeAsync async) {
  async.elapse(kIdlePcPresencePollInterval);
  async.flushMicrotasks();
  async.elapse(const Duration(milliseconds: 50));
  async.flushMicrotasks();
}

void main() {
  test('🔴 a PC that moved node while this socket stayed up is FOLLOWED', () {
    fakeAsync((FakeAsync async) {
      final _Built b = _pairedOnSrvny(
        async,
        // The relay's answer: the computer IS there — on srvjp. `pc_online:true`
        // is not a mistake in this fixture, it is the defect: today that bit is
        // all the phone gets, and it reads perfectly healthy.
        answer: const PcPresenceReading(
          presence: PcPresence.online,
          pcId: _kPcId,
          homeNode: 'srvjp',
          node: 'srvny',
        ),
      );
      final int dialsBefore = b.transport.connectCalls;

      _oneTick(async);

      expect(b.transport.connectCalls - dialsBefore, greaterThan(0),
          reason: 'the phone never re-dialled, so its room is still in the '
              'process the PC left — and mirrorToPc drops those frames without '
              'a word to either end');
      expect(b.transport.lastConnectUrl, _kThereUrl,
          reason: 'and it has to be the PC\'s node, not a re-dial of where we were');
      expect(b.session.reconnect.url, _kThereUrl,
          reason: 'the ladder must have ADOPTED the new address, or the next '
              'rung would take us back');

      b.session.debugStopIdlePresencePoll();
      b.session.dispose();
      async.flushMicrotasks();
    });
  });

  test('the reading is downgraded to UNKNOWN, never left saying 「online」', () {
    fakeAsync((FakeAsync async) {
      final _Built b = _pairedOnSrvny(
        async,
        answer: const PcPresenceReading(
          presence: PcPresence.online,
          pcId: _kPcId,
          homeNode: 'srvjp',
          node: 'srvny',
        ),
      );
      // 🔴 THE DIAL IS MADE TO FAIL ON PURPOSE, and it is the only way this
      // assertion can be about anything: when the hop SUCCEEDS the re-admission
      // ack lands inside the same tick and legitimately re-establishes presence,
      // so a reading taken after it would be measuring the ack, not the poll.
      // A hop whose new node does not answer yet is also the case that matters —
      // that is the moment a screen still claiming 「online」 would be lying.
      b.transport.connectSucceeds = false;
      _oneTick(async);
      // 🔴 「online」 from a node that is not the PC's establishes something about
      // that node's room, not about this phone's ability to reach the computer.
      // `unknown` lets liveness_hold keep whatever was last actually
      // established; painting a fresh certainty is the shape this repo pays for.
      expect(b.session.pcPresence.value, PcPresence.unknown);

      b.session.debugStopIdlePresencePoll();
      b.session.dispose();
      async.flushMicrotasks();
    });
  });

  test('REVERSE CONTROL — same node ⇒ no dial at all', () {
    fakeAsync((FakeAsync async) {
      final _Built b = _pairedOnSrvny(
        async,
        answer: const PcPresenceReading(
          presence: PcPresence.online,
          pcId: _kPcId,
          homeNode: 'srvny',
          node: 'srvny',
        ),
      );
      final int dialsBefore = b.transport.connectCalls;
      _oneTick(async);
      // If this ever dials, the poll has become a reconnect generator: it runs
      // every 10 s for as long as a session is idle.
      expect(b.transport.connectCalls, dialsBefore);
      expect(b.session.reconnect.url, _kEndpoint);
      // Positive control for the negative above: the very same fixture DOES
      // dial when the ids disagree (case 1), so a zero here is the comparison
      // working and not the tick failing to fire.
      expect(b.session.pcPresence.value, PcPresence.online,
          reason: 'and an agreeing answer must still be believed — downgrading '
              'it would be a second defect wearing the first one\'s clothes');

      b.session.debugStopIdlePresencePoll();
      b.session.dispose();
      async.flushMicrotasks();
    });
  });

  test('DEGRADE CONTROL — a relay that sends no home_node changes nothing', () {
    fakeAsync((FakeAsync async) {
      final _Built b = _pairedOnSrvny(
        async,
        // Every relay in the field until this ships, every LAN sidecar, and
        // every self-hosted deployment. The failure direction the whole
        // additive change rests on: no field ⇒ today's behaviour, which is
        // 「stay where you are and believe the answer」.
        answer: const PcPresenceReading(presence: PcPresence.online, pcId: _kPcId),
      );
      final int dialsBefore = b.transport.connectCalls;
      _oneTick(async);
      expect(b.transport.connectCalls, dialsBefore);
      expect(b.session.reconnect.url, _kEndpoint);
      expect(b.session.pcPresence.value, PcPresence.online);

      b.session.debugStopIdlePresencePoll();
      b.session.dispose();
      async.flushMicrotasks();
    });
  });
}
