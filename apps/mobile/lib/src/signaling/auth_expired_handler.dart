// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §4 (auth handshake AUTH_TOKEN_INVALID stops
//     reconnect + deletes the local session)
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D4 (coupling-edge: distributed
//     lifecycle events must drain every coupled subsystem, or a zombie survives)
//   R2/R3 task card WP-R3-1: "auth:expired must drain (AUTH expiry must
//     drain PAIRING+SESSION — the coupling-edge lesson)"
//     (「auth:expired 排干（AUTH 过期须排干 PAIRING+SESSION——耦合边教训）」)
//   packages/protocol/src/protocol-schemas-auth.ts (AuthExpiredSchema {} )
//
// auth:expired couples TWO subsystems: the PAIRING layer (reconnect ladder +
// stored token) and the live SESSION layer (audio capture + PTT FSM). Draining
// only one leaves a zombie:
//   - drain SESSION only  → the reconnect ladder keeps storming a dead token;
//   - drain PAIRING only  → audio keeps capturing / the FSM stays RECORDING with
//     nowhere to deliver, and the next PTT-up emits into a closed session.
// So this handler drains BOTH, in one atomic step, on every auth:expired.
//
// 🔴 Card E-M (2026-10-10, docs/rebuild/18 §2.6, P-2) — 「drain PAIRING」 means
// the SOCKET side (ladder + transport), and the stored pairing token only when
// it belongs to the account. auth:expired is an ACCOUNT credential lapsing
// (server `socket/handlers/auth-expiry.ts` is its only emitter). The relay
// still admits a real computer's pairing token after that kick (design
// docs/strategy/2026-10-10-login-renewal-design.md §1 R6), so deleting it made
// the user re-pair a computer nobody had unpaired. The cloud-instance pairing
// (`channel == 'saas'`, written only by `ptt_pair.dart`
// `entry.payload.cloudInstance ? 'saas' : 'standalone'`) is a virtual PC
// minted for THIS account, and still goes with it.

import 'dart:async';

import '../audio/audio_capture.dart';
import '../audio/retained_audio_manifest.dart' show JournalInterrupt;
import '../auth/token_storage.dart';
import 'reconnect.dart';
import 'socket_core.dart';
import 'state_machine.dart';

/// Drains PAIRING + SESSION on auth:expired (and on an AUTH_TOKEN_INVALID
/// handshake reject, which is the same coupling edge reached from the reconnect
/// path). Idempotent: draining an already-drained handler is a no-op.
class AuthExpiredHandler {
  AuthExpiredHandler({
    required this.transport,
    required this.stateMachine,
    required this.audio,
    required this.reconnect,
    required this.tokenStorage,
    this.onDrained,
  });

  final SocketTransport transport;
  final FlowmicStateMachine stateMachine;
  final AudioCapture audio;
  final ReconnectCoordinator reconnect;
  final TokenStorage tokenStorage;

  /// Notifies the composition root the session was drained (e.g. to route back
  /// to the pair screen). Called once per drain, with the account credential
  /// this socket's handshake presented ([presentedJwt]) — null when it
  /// presented none that this phone knows of.
  final void Function(String? refusedJwt)? onDrained;

  /// Card E-M — the account JWT the CURRENT socket's handshake carried, set by
  /// the dial that carried it (`ptt_pair.dart`, cloud-instance admission). It
  /// is what an `auth:expired` on this socket refused, so the login layer can
  /// apply 「sign out only if the refused credential is the one stored」. A
  /// later dial without a JWT (the reconnect ladder carries only the pairing
  /// token) gets no expiry watchdog on the relay, so a stale value here is
  /// never read for it.
  String? presentedJwt;

  bool _draining = false;

  /// Drain both subsystems. Order matters:
  ///   1. SESSION first — fence audio + reset the FSM so no further chunk is
  ///      captured or emitted the instant authority is gone;
  ///   2. PAIRING next — stop the reconnect ladder (no storm on a dead token),
  ///      delete the active token from secure storage, drop the transport.
  Future<void> drain() async {
    if (_draining) return;
    _draining = true;
    // P2-7 (2026-09-02 audit) — WITHOUT THE `finally` BELOW, any throw in the
    // body (a storage error from `removeByToken`, a transport error from
    // `disconnect`) left `_draining` latched `true` forever: the guard above
    // then makes every LATER `auth:expired` — including a legitimate,
    // unrelated one — a silent no-op for the rest of the session's life. That
    // is the exact shape this class's own header warns about (「a zombie
    // survives」), just moved from "a subsystem was never drained" to "no
    // subsystem is ever drained again".
    try {
      // 1. SESSION drain.
      // Card LS-4: capture authority is gone, which is not the user throwing
      // words away — named, and NOT tombstoned, so the bytes stay recoverable.
      audio.fenceAndStop(reason: JournalInterrupt.authDrained);
      stateMachine.onAuthExpired();
      // 2. PAIRING drain — the socket side always; the stored token only for
      // the account-bound cloud-instance pairing (card E-M, header).
      final String? owner = reconnect.token;
      await reconnect.stop();
      if (owner != null && owner.isNotEmpty && await _accountBound(owner)) {
        await tokenStorage.removeByToken(owner);
      }
      await transport.disconnect();
      final String? refused = presentedJwt;
      presentedJwt = null;
      onDrained?.call(refused);
    } finally {
      _draining = false;
    }
  }

  /// Whether the stored pairing behind [token] belongs to the ACCOUNT (the
  /// cloud instance) rather than to a real computer. A token with no stored
  /// row has nothing to keep, so it answers true and the removal is the same
  /// no-op it always was.
  Future<bool> _accountBound(String token) async {
    for (final MobileSession p in await tokenStorage.readPairings()) {
      if (p.token == token) return p.channel == 'saas';
    }
    return true;
  }
}
