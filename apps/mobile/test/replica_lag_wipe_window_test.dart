// 🔴 P0 S3 (owner 2026-09-01) — a replica that has not pulled our row yet must
// not be able to DELETE the pairing the user just made.
//
// SPEC-REF:
//   lib/src/session/replica_lag_window.dart      (the fact and its derivation)
//   lib/src/signaling/mobile_reconnect_flow.dart (the ONE reader — the
//     AUTH_TOKEN_INVALID branch that calls `removeByToken`)
//   lib/src/session/hold_out_retry.dart          (noteReplicaLag — the re-ask)
//   lib/src/ptt/ptt_reconnect_ack.dart           (`suspectedReplicaLag` wiring)
//
// ── THE SHAPE ───────────────────────────────────────────────────────────────
// `mobile:pair` is writer-only, so a token exists on the writer and nowhere
// else until a replica's next 30 s pull. The phone then FOLLOWS ITS PC to that
// replica and presents the token. The replica answers `AUTH_TOKEN_INVALID` —
// truthfully, about its own copy — and the phone's standing reading of that
// code deletes the local pairing, empties the instance list, and sends the user
// back to the QR code, where the same race runs again.
//
// ── WHY BOTH REFUSAL SHAPES ARE TESTED ──────────────────────────────────────
// `runMobileReconnect` computes one `invalid` from TWO different arrivals, and
// a replica can produce either depending on whether it refuses at the handshake
// middleware or inside the `mobile:reconnect` handler:
//   · ACK-LEVEL       — socket up, the ack itself says `AUTH_TOKEN_INVALID`;
//   · HANDSHAKE-LEVEL — no ack at all; the code is on `lastConnectError` while
//                       the transport sits in `error`.
// Testing one and reasoning about the other is how half a fix ships.
//
// ── 🔴 REVERSE CONTROL, MEASURED RED (2026-09-01, marker REVERSE-CONTROL-B) ──
// The window was taken out of the decision — `final bool lag = refusedToken &&
// false;` in mobile_reconnect_flow.dart, i.e. exactly today's code. Verbatim:
//
//   the wipe 🔴 ACK-LEVEL refusal inside the window: the pairing SURVIVES and
//   the ladder is not stopped [E]
//     Expected: false
//       Actual: <true>
//     the pairing the user completed seconds ago was deleted by a replica that
//     had not pulled it yet
//
//   the wipe 🔴 HANDSHAKE-LEVEL refusal inside the window: same [E]
//     Expected: false
//       Actual: <true>
//
//   wired into the session 🔴 a token refused seconds after PAIRING survives,
//   and the phone schedules its own re-ask [E]
//
// Three cases red — one per refusal shape plus the wiring proof. Restored;
// `grep -rn REVERSE-CONTROL-B apps/mobile/lib apps/mobile/test` = 0;
// re-greened 12/12.

import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/session/replica_lag_window.dart';
import 'package:flowmic/src/signaling/mobile_reconnect_flow.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const String _token = 'tok-0123456789abcdef0123456789abcdef';

/// Drive `runMobileReconnect` with one refusal and report what happened to the
/// stored pairing and to the `invalid` verdict the session leg reads.
Future<({bool wiped, bool invalid, String? code})> _refuse({
  required bool ackLevel,
  required bool lagOpen,
}) async {
  final FakeSocketTransport transport = FakeSocketTransport();
  final InMemoryTokenStorage storage = InMemoryTokenStorage();
  await storage.addOrUpdatePairing(
    const MobileSession(token: _token, endpoint: 'https://srvjp.example'),
  );
  if (ackLevel) {
    transport.ackQueue.add(<String, Object?>{'error': 'AUTH_TOKEN_INVALID'});
  } else {
    // No ack at all: the middleware refused the handshake, so the frame never
    // went out and the server's answer is on `lastConnectError`.
    transport.failEmits = true;
    transport.setLastConnectError('AUTH_TOKEN_INVALID');
    transport.pushStatus(SocketStatus.error);
  }
  bool invalid = false;
  String? code;
  await runMobileReconnect(
    transport: transport,
    tokenStorage: storage,
    token: _token,
    timeout: const Duration(seconds: 1),
    surfaceTransientFailure: false,
    suspectedReplicaLag: () => lagOpen,
    onAccepted: (_) => fail('this refusal must not be read as an admission'),
    onRejected: (bool _, bool inv, String? err, int? ignoredBudget) {
      invalid = inv;
      code = err;
    },
  );
  final List<MobileSession> left = await storage.readPairings();
  return (wiped: left.isEmpty, invalid: invalid, code: code);
}

void main() {
  group('ReplicaLagWindow', () {
    test('closed until something opens it — a phone tapping a month-old '
        'pairing gets today\'s behaviour with no window at all', () {
      final ReplicaLagWindow w = ReplicaLagWindow();
      expect(w.open, isFalse);
      expect(w.openedAt, isNull);
    });

    test('🔴 open for kReplicaLagWindow after a pair, then shut', () {
      DateTime now = DateTime.utc(2026, 9, 1, 12);
      final ReplicaLagWindow w = ReplicaLagWindow(clock: () => now);
      w.notePaired();
      expect(w.open, isTrue);
      now = now.add(kReplicaLagWindow - const Duration(seconds: 1));
      expect(w.open, isTrue, reason: 'positive control: still inside');
      now = now.add(const Duration(seconds: 2));
      expect(w.open, isFalse,
          reason: 'past the window an AUTH_TOKEN_INVALID is a verdict again — '
              'this must NOT become a blanket 「never delete a pairing」');
    });

    test('a hop re-opens it for a token minted long ago', () {
      DateTime now = DateTime.utc(2026, 9, 1, 12);
      final ReplicaLagWindow w = ReplicaLagWindow(clock: () => now);
      w.notePaired();
      now = now.add(const Duration(days: 30));
      expect(w.open, isFalse, reason: 'positive control');
      w.noteNodeHop();
      expect(w.open, isTrue,
          reason: 'the node we are moving to may never have seen this token, '
              'however old it is');
    });

    test('an accepted admission closes it as a FACT', () {
      final DateTime now = DateTime.utc(2026, 9, 1, 12);
      final ReplicaLagWindow w = ReplicaLagWindow(clock: () => now);
      w.notePaired();
      w.close();
      expect(w.open, isFalse,
          reason: 'being in the room proves this node knows the token, so '
              'nothing is left to blame on replication');
    });
  });

  group('the wipe', () {
    test('🔴 ACK-LEVEL refusal inside the window: the pairing SURVIVES and the '
        'ladder is not stopped', () async {
      final ({bool wiped, bool invalid, String? code}) r =
          await _refuse(ackLevel: true, lagOpen: true);
      expect(r.wiped, isFalse,
          reason: 'the pairing the user completed seconds ago was deleted by a '
              'replica that had not pulled it yet');
      expect(r.invalid, isFalse,
          reason: '`invalid` is what sets PttSession._authValid=false, and that '
              'STOPS the reconnect ladder. Keeping the token while stopping '
              'everything that could re-present it is the same defect, quieter');
      expect(r.code, 'AUTH_TOKEN_INVALID',
          reason: 'the server\'s own answer is still reported verbatim — what '
              'is suppressed is the deletion, never the refusal');
    });

    test('🔴 HANDSHAKE-LEVEL refusal inside the window: same', () async {
      final ({bool wiped, bool invalid, String? code}) r =
          await _refuse(ackLevel: false, lagOpen: true);
      expect(r.wiped, isFalse);
      expect(r.invalid, isFalse);
      expect(r.code, isNull,
          reason: 'there was no ack, so there is no server code to quote — '
              '「we did not get an answer」 and 「the server said X」 must not '
              'read alike (ReconnectRefusal.code exists for this)');
    });

    test('🔴 REVERSE DIRECTION — ACK-LEVEL outside the window still wipes, '
        'exactly as today', () async {
      final ({bool wiped, bool invalid, String? code}) r =
          await _refuse(ackLevel: true, lagOpen: false);
      expect(r.wiped, isTrue,
          reason: 'a genuinely revoked phone must still clear its dead row, or '
              'the instance list keeps a pairing that can never work');
      expect(r.invalid, isTrue);
    });

    test('🔴 REVERSE DIRECTION — HANDSHAKE-LEVEL outside the window still wipes',
        () async {
      final ({bool wiped, bool invalid, String? code}) r =
          await _refuse(ackLevel: false, lagOpen: false);
      expect(r.wiped, isTrue);
      expect(r.invalid, isTrue);
    });

    test('a refusal that is NOT about the token is untouched by any of this',
        () async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final InMemoryTokenStorage storage = InMemoryTokenStorage();
      await storage.addOrUpdatePairing(
        const MobileSession(token: _token, endpoint: 'https://srvjp.example'),
      );
      transport.ackQueue.add(<String, Object?>{
        'error': 'PC_BUSY',
        'retry_after_ms': 8000,
      });
      bool invalid = true;
      int? budget;
      await runMobileReconnect(
        transport: transport,
        tokenStorage: storage,
        token: _token,
        timeout: const Duration(seconds: 1),
        surfaceTransientFailure: false,
        // Open, deliberately: a window about token freshness must not change
        // the reading of a code that is about occupancy.
        suspectedReplicaLag: () => true,
        onAccepted: (_) => fail('refused'),
        onRejected: (bool _, bool inv, String? ignoredCode, int? ms) {
          invalid = inv;
          budget = ms;
        },
      );
      expect(invalid, isFalse);
      expect(budget, 8000, reason: 'the server\'s budget still comes through');
      expect((await storage.readPairings()), hasLength(1));
    });
  });

  // ── the wiring: does PRODUCTION actually ask the window? ───────────────────
  //
  // 🔴 Required separately for the reason CLAUDE.md's anti-façade ① states: the
  // group above would stay green with `suspectedReplicaLag: () => false`
  // hard-wired at the one production call site, i.e. with the whole feature
  // switched off.
  group('wired into the session', () {
    PttSession session(FakeSocketTransport transport) {
      transport.connectSucceeds = true;
      final PttSession s = newTestSession(transport: transport);
      // No real network in the endpoint probe: this measures the refusal
      // reading, not address selection.
      s.healthReader = (Uri url, Duration timeout) async => HealthReading.offline;
      return s;
    }

    test('🔴 a token refused seconds after PAIRING survives, and the phone '
        'schedules its own re-ask', () async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final PttSession s = session(transport);
      addTearDown(s.dispose);
      await s.tokenStorage.addOrUpdatePairing(
        const MobileSession(token: _token, endpoint: 'http://192.0.2.5:55889'),
      );
      // What `PttSession.pair` does on a validated ack.
      s.reconnect.lagWindow.notePaired();
      transport.ackQueue.add(<String, Object?>{'error': 'AUTH_TOKEN_INVALID'});

      expect(
        await s.resumePairing(
          const MobileSession(token: _token, endpoint: 'http://192.0.2.5:55889'),
        ),
        isFalse,
        reason: 'positive control: the reconnect really was refused',
      );
      expect((await s.tokenStorage.readPairings()), hasLength(1),
          reason: 'production is not asking the window');
      expect(s.paired.value, isFalse,
          reason: 'we are genuinely not in the room and must not claim to be');
      expect(s.holdOutArmed, isTrue,
          reason: 'the socket stays up on this path, so the reconnect ladder '
              'will never fire — without this timer NOTHING asks again and the '
              'suppression just hides the failure');
    });

    test('🔴 REVERSE DIRECTION — with no window open the same refusal wipes',
        () async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final PttSession s = session(transport);
      addTearDown(s.dispose);
      await s.tokenStorage.addOrUpdatePairing(
        const MobileSession(token: _token, endpoint: 'http://192.0.2.5:55889'),
      );
      transport.ackQueue.add(<String, Object?>{'error': 'AUTH_TOKEN_INVALID'});

      expect(
        await s.resumePairing(
          const MobileSession(token: _token, endpoint: 'http://192.0.2.5:55889'),
        ),
        isFalse,
      );
      expect((await s.tokenStorage.readPairings()), isEmpty,
          reason: 'today\'s behaviour must be unchanged outside the window');
      expect(s.holdOutArmed, isFalse,
          reason: 'a really dead token wants a human, not a timer');
    });

    test('an accepted reconnect closes the window, so a LATER revocation is '
        'not suppressed', () async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final PttSession s = session(transport);
      addTearDown(s.dispose);
      await s.tokenStorage.addOrUpdatePairing(
        const MobileSession(token: _token, endpoint: 'http://192.0.2.5:55889'),
      );
      s.reconnect.lagWindow.notePaired();
      transport.ackQueue.addAll(<Object?>[
        <String, Object?>{'ok': true, 'pc_id': 'pc-1'},
      ]);
      expect(
        await s.resumePairing(
          const MobileSession(token: _token, endpoint: 'http://192.0.2.5:55889'),
        ),
        isTrue,
      );
      expect(s.reconnect.lagWindow.open, isFalse,
          reason: 'we were admitted, so this node demonstrably knows the token');
    });
  });
}
