// SPEC-REF:
//   docs/decisions/2026-07-31-queue-destination-is-a-machine-not-a-connection.md
//     (Gate 2 ruling: the destination is the 「machine」, pc_id is merely its
//     alias on a given channel)
//   docs/decisions/2026-07-31-owner-two-channels-transit-not-storage.md ④
//     (🔴 owner iron rule 「cross-wiring IDs is absolutely forbidden」: the
//     delivery id ↔ target PC id must correspond)
//   apps/mobile/lib/src/auth/token_storage.dart (MobileSession.pcMachineUid —
//     「the SAME value on the LAN pairing and the relay pairing to one computer」)
//
// ── 🔴 THE NO-CROSSTALK RED LINE, AS A PURE FUNCTION ─────────────────────────
//
// WHY THIS FILE EXISTS AT ALL. A queued delivery outlives the connection it was
// made on. When it finally drains, SOMETHING has to answer 「which PC does
// this item get delivered to」— and owner's iron rule forbids the obvious
// answer (「deliver it to whichever one is connected right now」),
// because after a reconnect 「the one connected right now」 may be a
// different computer and the
// user's sentence would be typed into a stranger's window.
//
// WHY `pc_id` CANNOT BE FROZEN AND REPLAYED (窗口B3-2a real-device
// measurement, the finding that
// sent this card back for a ruling). `pc_id` is NOT a property of a computer. It
// is `pc_devices.id`, minted `randomUUID()` per SERVER (server-core
// room/registry.ts), and the two channels are two independent databases — the
// LAN sidecar's own sqlite and the cloud deployment's. One computer therefore
// has TWO different `pc_id`s, one per channel, and the phone stores them as two
// separate pairings with two separate tokens (token_storage.dart's own comment:
// 「two servers, two tokens, two mobile_pairings rows」).
//   ⇒ Freezing the enqueue-time `pc_id` and replaying it on the other channel
//     does not merely fail — it fails AS A CROSSTALK REFUSAL. The server compares
//     it against this connection's token binding (relay.handler.ts `targetPcId
//     != auth.deviceId`, inject-routes.ts `!== pc.id`) and answers
//     INJECT_PC_MISMATCH. The user would be shown 「cross-wired IDs were
//     blocked」 about a
//     delivery in which not one id was crossed. That is this repo's #1 bug shape
//     (one value answering two questions) wearing the red line's own uniform.
//
// SO: **the destination is the MACHINE** (`pc_machine_uid` — the one identity
// that is byte-identical across both channels, stamped by the desktop itself),
// and `pc_id` is merely what that machine is CALLED on a given channel.
//
// ── WHY THIS IS A VERIFICATION, NOT A RE-DERIVATION ──────────────────────────
//
// This is the part that keeps the iron rule intact, and it is worth reading
// twice
// before anyone 「simplifies」 it. The resolver does NOT search the pairing list for
// 「a pairing that reaches machine X」 and then send on it. It asks a strictly
// narrower question about the connection the phone is ALREADY on:
//
//     「is the other end of my current connection the machine this delivery
//     was frozen to?」
//
// If yes, the address is read off THAT SAME connection — which is exactly the
// value the server will compare against, because the server's side of the
// comparison is the token binding of this very connection. If no, the item does
// not drain. At no point is a destination chosen; the frozen machine uid is the
// only destination there ever was, and this code can only ever agree or refuse.
//
// ⇒ There is structurally no branch in which a delivery reaches a machine other
//   than the one frozen at enqueue. That is a stronger guarantee than 「we look
//   it up carefully」, and it is why this function returns a REFUSAL rather than
//   a fallback: `null` has no meaning here and is not accepted.

import '../auth/token_storage.dart';
import 'instance_probe.dart';

// [LiveConnection.channel] is part of this file's public shape, so the type
// travels with it. Re-exported rather than left to every caller to import
// separately: a caller that can build a `LiveConnection` must be able to say
// which channel it is on, and the one that cannot name the type would reach for
// the pairing-identity prefix instead — the judge this file bans by name below.
export 'instance_probe.dart' show ServerChannel;

/// The frozen destination of one queued delivery.
///
/// Both identities are captured at ENQUEUE time and are immutable for the life
/// of the item. They answer different questions and neither can substitute for
/// the other — see [enqueuedPcId] for the one that is deliberately inert.
class OutboxDestination {
  const OutboxDestination({
    required this.machineUid,
    required this.pairingIdentity,
    required this.enqueuedPcId,
  });

  /// 🔴 THE REAL DESTINATION: `pc_machine_uid`, the physical computer.
  ///
  /// Null ONLY for a pairing made before 0.2.4 (the column did not exist) or for
  /// the virtual cloud instance (not a machine at all). A null here is an
  /// honest
  /// 「this item doesn't know which machine it's going to」 and forces the
  /// legacy branch below — it is
  /// never filled in with a guess, because a guessed machine identity is the one
  /// value in this file that could actually cross a delivery.
  final String? machineUid;

  /// The pairing this delivery was enqueued on
  /// ([MobileSession.connectionIdentity], `channel|instance:…`).
  ///
  /// The ONLY addressing evidence a legacy (uid-less) item has, and the reason
  /// such an item can still be delivered safely: same pairing ⇒ provably the
  /// same server row ⇒ the same computer.
  final String? pairingIdentity;

  /// AUDIT ONLY — the `pc_id` this machine was called on the channel the item
  /// was enqueued on.
  ///
  /// ⚠️ **This field is deliberately never used to address anything.** It is
  /// kept because a crosstalk regression is only diagnosable if the forensic
  /// trail can show 「at enqueue time it was called X, and at drain time we
  /// stamped Y」, and because the
  /// acceptance regression asserts on exactly that pair. Any future code that
  /// reads this to build a frame has reintroduced the bug this whole file
  /// exists to make impossible — the drain address comes from the LIVE
  /// connection (see [resolveOutboxTarget]) or the item does not drain.
  final String? enqueuedPcId;

  @override
  bool operator ==(Object other) =>
      other is OutboxDestination &&
      other.machineUid == machineUid &&
      other.pairingIdentity == pairingIdentity &&
      other.enqueuedPcId == enqueuedPcId;

  @override
  int get hashCode => Object.hash(machineUid, pairingIdentity, enqueuedPcId);
}

/// What the phone knows about the connection it is on RIGHT NOW.
///
/// Every field comes from the live pairing/reconnect ack (PttSession), i.e. from
/// the same three server admission sites that mint the values the server will
/// later compare against. Nothing here is derived, cached across connections, or
/// defaulted.
class LiveConnection {
  const LiveConnection({
    required this.machineUid,
    required this.pairingIdentity,
    required this.pcId,
    required this.channel,
  });

  /// `pc_machine_uid` of the computer at the other end of THIS connection.
  final String? machineUid;

  /// [MobileSession.connectionIdentity] of the pairing this connection uses.
  final String? pairingIdentity;

  /// The `pc_id` THIS connection's token is bound to — the exact value the
  /// server compares `target_pc_id` against.
  final String? pcId;

  /// 🔴 WHICH CHANNEL this connection is — the MEASURED answer.
  ///
  /// Forwarded from `PttSession.serverChannel`, which is `/api/health.mode`
  /// read off the endpoint this session is actually connected to
  /// (`'standalone' ⇒ lan`, `'saas' ⇒ cloudRelay`). It is the SAME value the
  /// picture panel and `image_send_controller` already decide 「whether the
  /// original image can be sent this time」 from, so the queue cannot
  /// disagree with the control the user saw.
  ///
  /// ⚠️ IT IS DELIBERATELY **NOT** DERIVED FROM [pairingIdentity], even though
  /// that string begins with a channel word (`saas|instance:…` /
  /// `standalone|instance:…`). That word is `MobileSession.channel`, and it is
  /// written by one of two judges that instance_probe.dart's own header records
  /// as WRONG: `entry.payload.cloudInstance` (「is the other end that virtual
  /// cloud instance」 — a
  /// real PC reached THROUGH the relay answers `false`) or, for a row that never
  /// carried one, `_inferChannel`'s literal match on `flowmic.app` (a
  /// self-hosted relay answers `standalone`). Reading the channel off that
  /// prefix would rebuild the 0.2.1 defect owner reported —「the connection I
  /// established by scanning the PC-side cloud-relay QR code shows as local
  /// LAN」— this time in the code that decides
  /// whether an ORIGINAL picture crosses the relay.
  ///
  /// Null = 「the probe didn't get an answer this time」, never back-filled
  /// with a guess. What null MEANS
  /// is the POLICY's business, not this field's — see
  /// outbox_cloud_image_policy.dart (fail-closed: unknown counts as cloud).
  final ServerChannel? channel;
}

/// Why a queued item did not go out on the current connection.
///
/// Every value is a REASON, not a fallback. The drain's contract is that an
/// item it will not send stays `queued` and says so out loud; none of these may
/// ever be handled by 「then just send it to whichever one is current」.
///
/// ⚠️ Correction (卡 B4-17). This doc used to read 「Why a queued item could not be
/// ADDRESSED on the current connection」, and the enum is still NAMED for that.
/// Both were true of every value until [cloudImageOverCap], which is not an
/// addressing failure at all. The enum was deliberately neither renamed nor
/// split: the question its two consumers actually ask — `outbox.item_held` and
/// [OutboxDrainReport.held] — has always been 「why is this item still in the
/// queue」, and that
/// is ONE question with one answer per item. 「cannot be sent」 and 「should
/// not be sent」 are kept
/// apart by being two VALUES, which is what the caller reads; giving them two
/// TYPES would only move the seam without adding a fact.
enum OutboxAddressRefusal {
  /// Not connected / the session has not learned who it is talking to yet.
  /// Transient by nature — the item waits.
  noConnection,

  /// 🔴 The frozen machine is NOT the machine at the other end of this
  /// connection. The item waits for a connection to its OWN computer.
  ///
  /// This is the red line doing its job, and it is the branch a crosstalk bug
  /// would have to get past. It is NOT an error and NOT a refusal of the
  /// delivery — the item is still perfectly deliverable, just not from here.
  differentMachine,

  /// A legacy (uid-less) item, and this is not the pairing it was enqueued on.
  /// Without a machine identity, same-pairing is the only safe proof of same-
  /// computer, so the item waits for that pairing rather than guessing.
  legacyPairingMismatch,

  /// The connection is up and leads to the right machine, but reported no
  /// `pc_id` (a pre-0.2.4 pairing that has not completed one reconnect
  /// round-trip). There is no address to stamp and one must not be invented;
  /// this heals itself on the next successful reconnect.
  addressUnknown,

  /// 🔴 owner 2026-08-01 cloud image policy (doc 15 §1.1 / §6 G-14): this delivery is a
  /// picture over `kCloudImageBytesMax`, and this connection is the cloud relay
  /// (or cannot be PROVEN not to be). Held, not refused — the picture is
  /// perfectly deliverable, just not over this channel.
  ///
  /// The whole argument, including why the bytes are not re-compressed and why
  /// unknown counts as cloud, is in outbox_cloud_image_policy.dart.
  cloudImageOverCap,
}

/// The outcome of addressing one queued item on the current connection.
///
/// A sum type rather than `String?` on purpose: `null` would make 「cannot be
/// sent」
/// and 「sent but with no address」 the same value, and this file's entire
/// job is to keep
/// two questions from sharing one answer.
sealed class OutboxAddress {
  const OutboxAddress();
}

/// Drain it, stamping [targetPcId] as `inject:request.target_pc_id`.
class OutboxAddressResolved extends OutboxAddress {
  const OutboxAddressResolved(this.targetPcId);

  /// Read off the LIVE connection — never off [OutboxDestination.enqueuedPcId].
  final String targetPcId;

  @override
  bool operator ==(Object other) =>
      other is OutboxAddressResolved && other.targetPcId == targetPcId;

  @override
  int get hashCode => targetPcId.hashCode;
}

/// Leave it `queued` and report [reason]. Never a fallback, never a drop.
class OutboxAddressRefused extends OutboxAddress {
  const OutboxAddressRefused(this.reason);

  final OutboxAddressRefusal reason;

  @override
  bool operator ==(Object other) =>
      other is OutboxAddressRefused && other.reason == reason;

  @override
  int get hashCode => reason.hashCode;
}

String? _clean(String? s) {
  final String t = (s ?? '').trim();
  return t.isEmpty ? null : t;
}

/// 🔴 Address one queued delivery on the current connection, or refuse.
///
/// See this file's header for why this is a verification rather than a lookup.
/// The two branches, in the order they are tested:
///
///   1. **The item knows its machine** (the normal case as of 0.2.4). It drains
///      IFF the live connection leads to that EXACT machine — string equality on
///      `pc_machine_uid`, no prefix matching, no normalisation beyond trimming,
///      no 「close enough counts」. The address stamped is the live connection's own
///      `pc_id`, which is the channel-local alias of that same machine.
///
///   2. **The item does not** (a pairing older than 0.2.4, or one whose ack never
///      carried a uid). Falling through to branch 1's equality test would compare
///      null to null and let a uid-less item drain onto ANY uid-less connection —
///      the crosstalk this file exists to prevent, arrived at by accident. So a
///      uid-less item is pinned to the pairing it was enqueued on, which is the
///      strongest proof of 「the same computer」 available without a machine identity.
///
/// ⚠️ There is deliberately no third branch. If neither the machine nor the
/// pairing can vouch for the destination, the item does not move.
OutboxAddress resolveOutboxTarget({
  required OutboxDestination destination,
  required LiveConnection connection,
}) {
  final String? livePairing = _clean(connection.pairingIdentity);
  final String? livePcId = _clean(connection.pcId);
  // Not connected to anything identifiable ⇒ there is nothing to verify against.
  // Checked first so the refusals below can assume a real connection and stay
  // about ADDRESSING rather than about connectivity.
  if (livePairing == null) {
    return const OutboxAddressRefused(OutboxAddressRefusal.noConnection);
  }

  final String? frozenMachine = _clean(destination.machineUid);
  if (frozenMachine != null) {
    final String? liveMachine = _clean(connection.machineUid);
    // 🔴 THE COMPARISON. Note what is NOT here: no fallback when `liveMachine`
    // is null. A connection that cannot say which machine it reaches cannot
    // vouch for a delivery addressed to a specific one, and 「unknown」 must not
    // be read as 「it's this one」 — that reading is precisely how a crosstalk ships.
    if (liveMachine == null || liveMachine != frozenMachine) {
      return const OutboxAddressRefused(OutboxAddressRefusal.differentMachine);
    }
    if (livePcId == null) {
      return const OutboxAddressRefused(OutboxAddressRefusal.addressUnknown);
    }
    return OutboxAddressResolved(livePcId);
  }

  // Legacy branch — see the doc comment above. The pairing identity is the whole
  // of the evidence, so it is compared exactly and nothing else is consulted.
  final String? frozenPairing = _clean(destination.pairingIdentity);
  if (frozenPairing == null || frozenPairing != livePairing) {
    return const OutboxAddressRefused(
      OutboxAddressRefusal.legacyPairingMismatch,
    );
  }
  if (livePcId == null) {
    return const OutboxAddressRefused(OutboxAddressRefusal.addressUnknown);
  }
  return OutboxAddressResolved(livePcId);
}
