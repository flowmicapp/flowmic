// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.2 (sys:ping S→C {nonce} / sys:pong C→S
//     {nonce, ok} liveness probe — renamed from legacy _health-ping/_health-pong
//     in the WP-R0-1 rename window)
//   docs/rebuild/08-MOBILE-SPEC.md §4 (a PC reconnect pings each room mobile;
//     a valid ping is mobile-reachable proof the PC is back online)
//
// Reply sys:pong to a server sys:ping and report whether the ping is a valid
// PC-liveness signal (a non-empty nonce). When true the caller clears a stuck
// "Awaiting PC connection" — a PC reconnect sys-pings each room mobile, so a
// ping proves the PC is reachable while this socket stays connected.
//
// Ported from legacy signaling/health_handler.dart (the presence debouncer is a
// later UI card; this card ports only the ping→pong reply). Event names are the
// generated FlowMicEvents constants.

import '../../generated/flowmic_events.g.dart';
import 'socket_core.dart';
import 'wire_payloads.dart';

/// Reply sys:pong to a server sys:ping. Returns true when the ping carries a
/// valid (non-empty) nonce — the signal that clears a stuck awaiting-PC header.
bool handleSysPing({
  required SocketTransport transport,
  required Map<String, Object?> data,
}) {
  final Object? nonce = data['nonce'];
  if (nonce is! String || nonce.isEmpty) return false; // schema-gated upstream
  try {
    transport.emit(
      FlowMicEvents.sysPong,
      SysPongPayload(nonce: nonce).toJson(),
    );
  } on Object {
    // Transport closed mid-reply — the PC re-probes on its next reconnect; the
    // liveness fact (PC is reachable) still holds for the caller's clear.
  }
  return true;
}
