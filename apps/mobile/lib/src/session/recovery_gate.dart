// Card RC-1a - THE THREE-TIER SERVER GATE (audit A7-3, owner ruling O-10).
//
// SPEC-REF:
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-threshold.md
//     (O-10 = conditional compatibility, three classes)
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     A7-3 (THE single source of the classification), A5-3 (settled_unverified)
//   docs/rebuild/04-PROTOCOL-SPEC.md 3.3-a (c) - the capability bit names
//   apps/mobile/lib/src/signaling/server_capabilities.dart - the parsed ack
//
// WHAT THIS DECIDES, AND WHAT IT DOES NOT
//
// It decides whether a recovery attempt may be STARTED against the server we
// happen to be talking to, and whether anything it produces may license a
// delete. It decides nothing about a particular recording (that is
// recovery_settle.dart) and nothing about when to try again (recovery_backoff
// .dart). One question each - A6-1's own rule, applied one level up.
//
// WHY FAIL-CLOSED IS NOT PARANOIA HERE. `AudioStartSchema` is not `.strict()`
// on either side (audit E38/E37), so an old relay STRIPS the eight identifiers
// and finalises as if they had never been sent. The result looks like a
// success and has none of the protection: no idempotent operation, no coverage
// receipt, and - because the same relay does not know `attempt_kind` either -
// a re-transcription it may bill and fan out as an ordinary live recording.
// "Send anyway and hope" is the one outcome the audit singles out as worse
// than doing nothing.

import 'package:flutter/foundation.dart';

import '../signaling/server_capabilities.dart';

/// What a server's advertised capabilities buy this phone.
enum RecoveryTier {
  /// NOT A CLASS AT ALL - no server has answered yet.
  ///
  /// 🔴 IT IS NOT TIER C, AND CONFLATING THE TWO IS THE DEFECT THIS VALUE
  /// EXISTS TO CLOSE. A7-3 C means "the ack arrived and the bits are absent",
  /// which is a statement about a server and is PERSISTED and rendered. "We
  /// have not asked anybody" is not a statement about anything; writing it onto
  /// a recording puts a sentence on screen - "This server version cannot
  /// recover audio safely" - that nothing on this phone can back (R11).
  ///
  /// MEASURED 2026-09-06 (drill D-2, the phone's own diag): the recovery sweep
  /// ran at 05:01:45.078 with `caps_known=false`, and the ack carrying the
  /// capabilities landed at 05:01:46.394 - 1.3 s later. The verdict was never
  /// re-taken, so the screen kept that sentence for minutes against a server
  /// advertising all three bits.
  ///
  /// Nothing starts, nothing is written, and the pass simply ends. The sweep
  /// runs again on the next `DeliveryLinkUp` edge, which is by construction
  /// after an ack has been parsed.
  undetermined,

  /// A7-3 A. Everything is negotiated; recovery runs and its bytes may be
  /// deleted once recovery_settle.dart's three conditions hold.
  full,

  /// A7-3 B. A server whose `delivery:'none'` behaviour has been VERIFIED by
  /// evidence outside the wire. Recovery runs, but nothing it produces may
  /// delete a byte and every result is marked `settled_unverified`.
  recoverKeepBytes,

  /// A7-3 C. Anything else: zero `audio:start`, zero injection, zero deletes,
  /// and a persistent `awaiting_server_capability` state the UI can read.
  awaitingServerCapability;

  /// May this tier put an `audio:start` on the wire at all?
  bool get mayStart =>
      this != RecoveryTier.awaitingServerCapability &&
      this != RecoveryTier.undetermined;

  /// Is this a verdict ABOUT a server, as opposed to the absence of one? Only a
  /// verdict may be persisted onto a recording or turned into a sentence.
  bool get isVerdict => this != RecoveryTier.undetermined;

  /// May a successful attempt on this tier ever license a delete? Tier B says
  /// no on its own, before any per-recording judgement is made.
  bool get mayDeleteBytes => this == RecoveryTier.full;
}

/// A7-3 B - "this old server has been verified safe by evidence we hold
/// OUTSIDE the wire".
///
/// THE DEFAULT ANSWERS FALSE, AND THAT IS THE WHOLE IMPLEMENTATION. A version
/// matrix invented here would be a trust root asserted by the thing being
/// trusted, which is exactly what A7-3 rejects ("`schema_ver` existing is not
/// a safety proof"). So the seam exists, the default refuses, and what would
/// have to change is written down instead of guessed:
///
///   1. a MEASURED run against that relay build showing `delivery:'none'`
///      produces no injection and no PC fan-out (the audit's P0-D, which has
///      not been run);
///   2. a way to identify that build that the build itself cannot forge -
///      today there is none, so a matrix keyed on a self-reported version
///      string would not satisfy (1) even if (1) existed;
///   3. an owner ruling that the resulting compatibility is wanted, since
///      O-10 authorises conditional compatibility but explicitly does NOT
///      authorise double billing.
///
/// Until all three exist this stays a class with one `false` in it. It is
/// injectable so a test can prove tier B behaves correctly when something does
/// answer true - which is the only thing that keeps the branch honest.
abstract class LegacyServerVerifier {
  const LegacyServerVerifier();

  /// True only for a server this phone has independent evidence about.
  bool isVerifiedSafeLegacy(ServerCapabilities caps);
}

/// The production instance. See [LegacyServerVerifier] for what would have to
/// be true before anything else is.
class DenyAllLegacyServerVerifier extends LegacyServerVerifier {
  const DenyAllLegacyServerVerifier();

  @override
  bool isVerifiedSafeLegacy(ServerCapabilities caps) => false;
}

/// The tier decision, plus enough of its inputs to explain itself in a log.
@immutable
class RecoveryGateVerdict {
  const RecoveryGateVerdict({
    required this.tier,
    required this.capabilitiesKnown,
    required this.ackSeen,
    required this.coverageReceipt,
    required this.deliveryNoneSafe,
    required this.idempotentOperation,
    required this.metered,
  });

  final RecoveryTier tier;

  /// Did the ack carry a `capabilities` key at all? A server that said
  /// "none of these" and a relay that stripped the key are both refused, but
  /// only one of them is a statement, and a diagnostic that cannot tell them
  /// apart cannot explain itself later.
  final bool capabilitiesKnown;

  /// Did ANY pair / reconnect ack arrive? False is [RecoveryTier.undetermined]
  /// and nothing else - it is the difference between a server that answered
  /// badly and no server at all.
  final bool ackSeen;

  final bool coverageReceipt;
  final bool deliveryNoneSafe;
  final bool idempotentOperation;

  /// Whether this server bills (SaaS / relay) as opposed to a standalone
  /// desktop sidecar. Only a metered server needs `recovery.idempotent_
  /// operation`: on a standalone there is no account to charge twice.
  final bool metered;

  Map<String, Object?> toDiag() => <String, Object?>{
        'tier': tier.name,
        'caps_known': capabilitiesKnown,
        'ack_seen': ackSeen,
        'coverage_receipt': coverageReceipt,
        'delivery_none_safe': deliveryNoneSafe,
        'idempotent_operation': idempotentOperation,
        'metered': metered,
      };

  @override
  String toString() => 'RecoveryGateVerdict(${toDiag()})';
}

/// A7-3, in one function.
///
/// CALLER: `RecoveryJournalLeg` (session/recovery_journal_leg.dart), once per
/// sweep - not once per recording, because the answer is about the SERVER and
/// re-asking per recording would invite two recordings in one sweep to get two
/// answers from one ack.
RecoveryGateVerdict evaluateRecoveryGate({
  required ServerCapabilities caps,
  required bool metered,
  LegacyServerVerifier verifier = const DenyAllLegacyServerVerifier(),
}) {
  final bool receipt = caps.has(kCapabilityCoverageReceipt);
  final bool noneSafe = caps.has(kCapabilityDeliveryNoneSafe);
  final bool idempotent = caps.has(kCapabilityIdempotentOperation);
  // Tier A. `recovery.idempotent_operation` is required ONLY where an account
  // can be charged: A7-3 names the metered case, and demanding it of a
  // standalone sidecar would suspend recovery on the one deployment that has
  // no billing risk at all.
  final bool tierA = receipt && noneSafe && (!metered || idempotent);
  // 🔴 ASKED FIRST, BECAUSE "NOBODY HAS ANSWERED" IS NOT AN ANSWER.
  // `ServerCapabilities.ackSeen` is the question "has any server answered on
  // this connection". A7-3 C - "this server cannot do it" - is a verdict, and a
  // verdict needs somebody to have spoken; an ack that arrived WITHOUT the
  // capabilities key has spoken and lands on C below. See
  // [RecoveryTier.undetermined] for the measurement.
  final RecoveryTier tier = !caps.ackSeen
      ? RecoveryTier.undetermined
      : tierA
          ? RecoveryTier.full
          : verifier.isVerifiedSafeLegacy(caps)
              ? RecoveryTier.recoverKeepBytes
              : RecoveryTier.awaitingServerCapability;
  return RecoveryGateVerdict(
    tier: tier,
    capabilitiesKnown: caps.known,
    ackSeen: caps.ackSeen,
    coverageReceipt: receipt,
    deliveryNoneSafe: noneSafe,
    idempotentOperation: idempotent,
    metered: metered,
  );
}
