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

import 'dart:async';

import '../audio/audio_capture.dart';
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

  /// Notifies the composition root the pairing was dropped (e.g. to route back
  /// to the pair screen). Called once per drain.
  final void Function()? onDrained;

  bool _draining = false;

  /// Drain both subsystems. Order matters:
  ///   1. SESSION first — fence audio + reset the FSM so no further chunk is
  ///      captured or emitted the instant authority is gone;
  ///   2. PAIRING next — stop the reconnect ladder (no storm on a dead token),
  ///      delete the active token from secure storage, drop the transport.
  Future<void> drain() async {
    if (_draining) return;
    _draining = true;
    // 1. SESSION drain.
    audio.fenceAndStop();
    stateMachine.onAuthExpired();
    // 2. PAIRING drain.
    final String? owner = reconnect.token;
    await reconnect.stop();
    if (owner != null && owner.isNotEmpty) {
      await tokenStorage.removeByToken(owner);
    }
    await transport.disconnect();
    onDrained?.call();
    _draining = false;
  }
}
