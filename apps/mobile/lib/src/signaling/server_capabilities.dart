// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (c) — the `capabilities` array on
//     the `mobile:pair` / `mobile:reconnect` acks (the SSOT for the bit names)
//   packages/protocol/src/recovery-protocol.ts — the emitting side
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft §A7-3
//
// Card PR-1's phone half: what the server we just reached says it can do.
//
// 🔴 THERE IS NO CONSUMER YET, AND THAT IS THE CARD, NOT AN OVERSIGHT.
// Card RC-1 is the recovery queue that reads these bits and fails CLOSED without
// them (no `audio:start`, no injection, no deletion, and a sentence on screen
// saying the audio is still here). Landing the parse first means RC-1 arrives as
// a decision layer over a fact that is already flowing, instead of as a wire
// change and a policy change in one commit.
//
// ⚠️ It is registered against the anti-façade rule rather than in spite of it: a
// capability that is parsed and never read is exactly the shape this repo keeps
// deleting. The difference here is that the reader is a named card and the state
// is read-only with one writer — if RC-1 does not land, this should be removed,
// not left sitting.

import 'package:flutter/foundation.dart';

/// The server says it stamps a coverage receipt on the terminal `stt:final`.
const String kCapabilityCoverageReceipt = 'recovery.coverage_receipt';

/// The server's `attempt_kind` / `delivery:'none'` semantics match ours.
const String kCapabilityDeliveryNoneSafe = 'recovery.delivery_none_safe';

/// Persistent `operation_id` idempotency: a re-send of the same operation does
/// not charge the account twice, and one whose binding changed is refused.
///
/// 🔴 IT DOES NOT MEAN THE SERVER KEPT THE RESULT. Ruling O-9 (乙) set result
/// caching aside, so a re-send is recognised again — what the bit promises is the
/// bill, not the transcript. Absence must still be read as "we do not know",
/// never as "the server cannot": a relay that strips the key and one that has no
/// registry look identical from here.
///
/// ⚠️ This doc used to say "no server advertises it today". Relays from
/// 2026-09-06 (card PR-2) do.
const String kCapabilityIdempotentOperation = 'recovery.idempotent_operation';

/// What one ack said, as an immutable set.
///
/// 🔴 `unknown` IS NOT `empty`, and merging them is the mistake this class
/// exists to prevent. An ack that carried no `capabilities` key came from a
/// server that predates card PR-1 OR from a relay that stripped it — either way
/// we learned nothing. An ack that carried an EMPTY array is a server saying
/// "none of these" on purpose. The fail-closed rule (§A7-3) treats both as
/// "do not start a recovery", but only one of them is a statement, and a later
/// diagnostic that cannot tell them apart is a diagnostic that cannot explain
/// itself.
@immutable
class ServerCapabilities {
  const ServerCapabilities._(this.bits, this.known, this.ackSeen);

  /// No ack has been read yet, or the last one carried no `capabilities` key.
  const ServerCapabilities.unknown()
      : bits = const <String>{},
        known = false,
        ackSeen = false;

  /// An ack arrived and carried no `capabilities` key - an older server, or a
  /// relay that stripped it. 🔴 A STATEMENT, unlike [unknown].
  const ServerCapabilities.ackWithoutCapabilities()
      : bits = const <String>{},
        known = false,
        ackSeen = true;

  final Set<String> bits;

  /// Did the ack actually carry the key? See the class doc.
  final bool known;

  /// Has ANY pair / reconnect ack been read on this connection?
  ///
  /// 🔴 THE THIRD STATE THE CLASS DOC ALREADY DESCRIBED AND DID NOT
  /// EXPOSE. [known] is false in two situations the doc itself calls different -
  /// "nobody has answered yet" and "a server answered without the key" - and
  /// `recovery_gate.dart` was reading the first as if it were the second,
  /// telling the user their server could not recover audio safely 1.3 s before
  /// that server said it could (see [RecoveryTier.undetermined] for the
  /// measurement). A verdict about a server may only be taken once one has
  /// spoken.
  final bool ackSeen;

  /// True only when the ack said so. An unknown ack answers false for every bit,
  /// which is the fail-closed direction and the only safe default here.
  bool has(String bit) => bits.contains(bit);

  bool get coverageReceipt => has(kCapabilityCoverageReceipt);
  bool get deliveryNoneSafe => has(kCapabilityDeliveryNoneSafe);

  @override
  String toString() =>
      known ? 'ServerCapabilities(${(bits.toList()..sort()).join(',')})' : (ackSeen ? 'ServerCapabilities(ack, no capabilities key)' : 'ServerCapabilities(unknown)');
}

/// Read the `capabilities` array off a pair / reconnect ack.
///
/// TOLERANT BY DESIGN, in the one direction that is safe: a non-list, a list
/// with non-string members, empty strings and duplicates are all filtered out
/// rather than thrown on, because a malformed capability list must never break a
/// pairing that is otherwise fine. What it will NOT do is invent a bit — an
/// entry has to arrive as a non-empty string to be in the set.
///
/// ⚠️ Unrecognised names are KEPT. Recognition happens at the point of use; a
/// parser that dropped everything it did not know would silently discard the
/// evidence that a newer server was talking to an older phone.
ServerCapabilities parseServerCapabilities(Object? ack) {
  if (ack is! Map) return const ServerCapabilities.unknown();
  final Object? raw = ack['capabilities'];
  // An ack WAS read; it just did not carry a usable list. See [ackSeen].
  if (raw is! List) return const ServerCapabilities.ackWithoutCapabilities();
  final Set<String> bits = <String>{
    for (final Object? e in raw)
      if (e is String && e.isNotEmpty) e,
  };
  return ServerCapabilities._(Set<String>.unmodifiable(bits), true, true);
}
