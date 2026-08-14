// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.5 (interface
//     wording:
//     the 「queued」 face + the 「N still undelivered」 banner), §1.2 (four
//     identities, four questions)
//   docs/decisions/2026-07-31-queue-destination-is-a-machine-not-a-connection.md
//
// Window B4-7 — pure relocation, no edits, plus one named addition.
//
// 🔴 EVERYTHING IN THIS FILE WAS `delivery_outbox.dart`'s `_pending` /
// `_queuedEntryIds` / `_resendableImageEntryIds` / `_refreshDerived`, moved out
// VERBATIM for the 800-line src cap. **The ONE addition is named below (RV-91's
// per-instance bucketing); any other difference in the diff is a bug.**
//
// ── WHY THIS IS A SEPARATE OBJECT AND NOT THREE FIELDS ───────────────────────
//
// The reason `_refreshDerived` gave for taking ONE `loadPending()` still holds
// and is now structural: a count and a set taken from two separate reads can
// disagree, and 「N still undelivered」 disagreeing with which rows say 「queued」
// is a bug
// nobody would think to look for. Here they are computed in one pass over one
// list and published as one immutable value, so they cannot be half-updated.

import 'package:meta/meta.dart';

import 'machine_key.dart';
import 'outbox_item.dart';

/// Everything the UI reads synchronously about the queue, from ONE load.
@immutable
class OutboxPendingView {
  const OutboxPendingView._({
    required this.totalCount,
    required Map<String, int> byInstance,
    required this.unaddressedCount,
    required this.queuedEntryIds,
    required this.owedEntryIds,
    required this.resendableImageEntryIds,
  }) : _byInstance = byInstance;

  static const OutboxPendingView empty = OutboxPendingView._(
    totalCount: 0,
    byInstance: <String, int>{},
    unaddressedCount: 0,
    queuedEntryIds: <String>{},
    owedEntryIds: <String>{},
    resendableImageEntryIds: <String>{},
  );

  /// One pass over the pending items — see this file's header for why one.
  factory OutboxPendingView.of(List<OutboxItem> pending) {
    final Map<String, int> byInstance = <String, int>{};
    final Set<String> queued = <String>{};
    final Set<String> owed = <String>{};
    final Set<String> resendable = <String>{};
    int unaddressed = 0;
    for (final OutboxItem item in pending) {
      // 🔴 RV-91 — THE ONE ADDITION IN THIS MOVE.
      //
      // The bucket key is the pairing the delivery was enqueued on
      // ([OutboxItem.destinationPairingIdentity] = `MobileSession
      // .connectionIdentity`, `channel|instance:…`) — the SAME string
      // `TimelineStore` stamps on a row as `spokenToInstanceId`, because both
      // are read off `PttSession.connectedInstanceId` in the same breath.
      //
      // ⚠️⚠️ Correction (Card F2, 2026-08-05) — **THE PARAGRAPH ABOVE DESCRIBES THE OLD
      // KEY AND IS KEPT AS HISTORY, not rewritten** (anti-façade ④). It was TRUE
      // when written; ruling ④ (2026-08-04) re-judged two channels of ONE computer
      // from 「different instances」 to 「one session surface」, and the key moved
      // with the screen. The key is now [scopeKeyFor] — `machine:<uid>` when the
      // item knows its machine, `instance:<identity>` otherwise — and the second
      // half of the sentence still holds and is now STRUCTURAL: the chat screen
      // buckets through the same [scopeKeyFor], from the same two values.
      //
      // Both inputs are already frozen on the item (`dest_machine_uid`,
      // `dest_pairing_identity`), so this needs no queue schema change and no
      // re-read of the pairing list: the bucket a delivery belongs to is decided
      // by what it was addressed to, not by what the phone is connected to now.
      final String? scope = scopeKeyFor(
        machineUid: item.destinationMachineUid,
        pairingIdentity: item.destinationPairingIdentity,
      );
      if (scope == null) {
        unaddressed++;
      } else {
        byInstance[scope] = (byInstance[scope] ?? 0) + 1;
      }
      if (item.state == OutboxDeliveryState.queued) {
        queued.addAll(item.coveredEntryIds);
      }
      // 🔴 Card F7 — 「this row's delivery is not finished yet, whether it is on
      // disk or on the wire right now」.
      //
      // [OutboxItem.isPending] = queued OR inflight, i.e. the queue's own
      // definition of 「still owed」. Deliberately WIDER than [queued] above, and the
      // extra state is the whole point: an item that is `inflight` has a frame
      // out with an answer outstanding, and minting a SECOND delivery for that
      // row is how the same sentence gets typed twice when the first answer
      // arrives late.
      if (item.isPending) {
        owed.addAll(item.coveredEntryIds);
      }
      // 🔴 RV-93 — TWO CLAUSES, AND THE FIRST ONE IS THE GATE.
      //
      // `isPending` = 「this delivery has not succeeded yet」 (queued/inflight;
      // never `delivered`,
      // never a terminal `refused`). It is the whole of owner's rule now that a
      // delivered picture KEEPS its bytes:「delete on delivery success」 was revoked 2026-08-01,
      // so the old single clause (`hasImageBytes`) became vacuously true and would
      // hand a resend button to a picture that already landed — the one outcome owner
      // has explicitly ruled against.
      //
      // `hasImageBytes` stays as the second clause, doing the ONLY job it can
      // still do: keep the button off a picture whose file is genuinely gone, so
      // it can never be a control that does nothing when pressed (R8).
      //
      // ⚠️ THE FIRST CLAUSE LOOKS REDUNDANT AND IS KEPT ON PURPOSE. Today the
      // input is `OutboxStore.loadPending()`, i.e. queued+inflight only, so
      // `isPending` is true for every item in this loop. That is a property of the
      // CALLER, not of this rule — and it is exactly the kind of accidental
      // safety that stops being true the day someone passes `loadAll()` here for a
      // 「delivered ones are shown too」 feature. Written out, the rule survives that change; left
      // implicit, the button comes back with nothing to grep.
      if (item.isPending && item.hasImageBytes) {
        resendable.addAll(item.coveredEntryIds);
      }
    }
    return OutboxPendingView._(
      totalCount: pending.length,
      byInstance: Map<String, int>.unmodifiable(byInstance),
      unaddressedCount: unaddressed,
      queuedEntryIds: Set<String>.unmodifiable(queued),
      owedEntryIds: Set<String>.unmodifiable(owed),
      resendableImageEntryIds: Set<String>.unmodifiable(resendable),
    );
  }

  /// Every pending delivery, whatever instance it belongs to.
  ///
  /// ⚠️ FORENSICS ONLY — its consumers are the two `diag` lines in
  /// `delivery_outbox.dart` (`outbox.loaded`). It must NEVER feed a banner:
  /// that is the RV-91 defect itself, and [countFor] is the surface answer.
  final int totalCount;

  final Map<String, int> _byInstance;

  /// Pending items that could not name the pairing they were enqueued on.
  ///
  /// Not reachable in production today — `PttSession.applyPairedIdentity` sets
  /// the machine uid and the connection identity together and
  /// `clearConnectedInstance()` clears them together, and an item with NEITHER
  /// is refused at the door (`_hasRedeemableDestination`). Counted into EVERY
  /// instance rather than into none anyway: an unattributable delivery that is
  /// shown on the wrong screen is a cosmetic error, one that is shown on NO
  /// screen is a silent failure, and red line R2 only cares about the second.
  final int unaddressedCount;

  /// 🔴 Rows whose delivery is ON DISK AND HAS NEVER BEEN ON THE WIRE.
  ///
  /// ⚠️⚠️ Correction (Card F12, 2026-08-04) — **THE LINE ABOVE IS FALSE AND IS KEPT AS
  /// HISTORY, not rewritten** (anti-façade ④). The membership test is
  /// `state == queued` and nothing else, and a delivery RE-ENTERS `queued` every
  /// time a retryable refusal comes back (`settle_requeued` in
  /// delivery_outbox_settle.dart) — so a row here may well have been on the wire
  /// several times. The claim was true only for the first attempt and went false
  /// the day the queue learned to requeue, which is before this doc was written.
  ///
  /// 🔴 WHAT IT REALLY ANSWERS, and what now depends on it: **「is the queue
  /// still owed this row right now」**. Card F12 made that the row's own predicate too — `deliveryFaceOf`
  /// reads this set so a row cannot say a terminal word (「undelivered」) about a
  /// delivery the queue is still retrying. Widening this set to non-`queued`
  /// states, or narrowing it to first attempts only, changes what the timeline
  /// SAYS, not just what a banner counts.
  ///
  /// The evidence behind the 「queued」 face (docs/rebuild/15 §2.5 row 5). Without
  /// it such a row renders 「delivering」, which is a claim about a frame that does
  /// not exist — the same shape owner already paid for once when 「pending
  /// delivery」 became
  /// 「not injected」. `queued` is NEVER rendered as 「sent」 (outbox_item.dart:17-20);
  /// this is the field that makes that rule non-vacuous.
  ///
  /// Entry ids, not request ids, because the UI holds rows: one item covers
  /// [OutboxItem.coveredEntryIds], all of which are equally not-yet-sent.
  final Set<String> queuedEntryIds;

  /// 🔴 Card F7 — Rows the queue STILL OWES A DELIVERY FOR, in any live state
  /// (`queued` OR `inflight`) ⇒ 「if resend is pressed again, would it become a
  /// second delivery」.
  ///
  /// Strictly a superset of [queuedEntryIds], and the difference is the only
  /// reason this exists: `inflight` means a frame is out with its answer
  /// outstanding. A resend that minted a NEW delivery in that window puts the same
  /// sentence on the PC twice the moment the first answer arrives late — the
  /// text twin of the picture hazard `outboxResendImage` was built for, whose
  /// gate ([resendableImageEntryIds]) is this same `isPending` test plus a byte
  /// check.
  ///
  /// ⚠️ NOT a second answer to 「should this say pending delivery」 — that is
  /// [queuedEntryIds], and
  /// the two must not be swapped. A row whose frame is in flight has a delivery
  /// ON THE WIRE, so 「queued」 would be false for it; a row whose resend must reuse
  /// the existing item includes exactly that case. Two questions, two sets.
  final Set<String> owedEntryIds;

  /// 🔴 Image rows that have NOT been delivered yet and still hold their bytes
  /// ⇒ 「can this row still be resent」.
  ///
  /// R8 makes this a HARD equality rather than a hint: the resend affordance's
  /// existence must be identical to this membership, in both directions —
  /// offered while it is false is a button that cannot work; withheld while it is
  /// true is a capability the UI silently denies.
  ///
  /// ⚠️⚠️ Correction (RV-93). This doc used to say the membership was 「compressed bytes
  /// still on disk」, derived from `imagePath`, 「cleared in exactly one place
  /// (`DeliveryOutbox._releaseBytes`)」. That method no longer exists and nothing
  /// clears the path: owner revoked 「delete on delivery success」 on 2026-08-01, so the bytes
  /// outlive the delivery and 「the bytes are still there」 stopped being able to
  /// answer 「can it still be
  /// resent」. The membership is now bytes AND **not yet delivered** — see the factory.
  final Set<String> resendableImageEntryIds;

  /// 🔴 How many deliveries THIS instance's transcript screen is still owed.
  ///
  /// owner 2026-08-01 (RV-91, verbatim):「this should not be shared across
  /// different instances, each instance's transcription
  /// screen's state should be isolated」.
  ///
  /// ⚠️ WHY THE SCOPE IS THE **INSTANCE** AND NOT THE **MACHINE**, when the
  /// queue's own DESTINATION is a machine (`pc_machine_uid`, and that ruling is
  /// untouched). Two different questions:
  ///   · 「where can this delivery go」 is about the machine — a delivery frozen for computer
  ///     A drains on ANY channel that reaches A, which is why
  ///     `resolveOutboxTarget` compares machine uids and this file does not;
  ///   · 「which conversation are you looking at right now」 is about the instance
  ///     — and **the screen this
  ///     banner sits on already answers it that way**: `chat_flow_page.dart`
  ///     renders `store.entriesForInstance(session.connectedInstanceId)`, whose
  ///     predicate (`timeline_store.dart`) is `spokenToInstanceId`, i.e. the
  ///     same `connectionIdentity` bucketed here.
  /// ⇒ Before this, the banner counted rows THAT VERY SCREEN REFUSES TO SHOW.
  /// It was the one thing on the page that was not instance-scoped.
  ///
  /// A null/blank [instanceId] answers 0, matching the same screen: with no
  /// connected instance it renders no rows at all, so there is no scope for a
  /// count to be about.
  ///
  /// ⚠️⚠️ Correction (Card F2, 2026-08-05) — **THE ARGUMENT ABOVE IS AN EXPIRED TRUTH,
  /// kept verbatim rather than deleted** (anti-façade ④: it was correct on the day
  /// it was written, and the record of why the scope was the instance is what
  /// stops the next card from re-litigating it). Ruling ④ (2026-08-04) re-judged
  /// ONE of its two clauses:
  ///   · 「where can this delivery go」 is about the machine — **UNCHANGED**, and
  ///     `resolveOutboxTarget` still owns it;
  ///   · 「which conversation are you looking at right now」 — the two channels
  ///     of ONE computer were re-judged
  ///     to be ONE conversation, so this question's answer is now the MACHINE
  ///     too, whenever there is a machine to name.
  /// ⇒ The last sentence of the block above ('the screen this banner sits on
  /// already answers it that way: `chat_flow_page.dart` renders
  /// `store.entriesForInstance(session.connectedInstanceId)`') is FALSE as of
  /// this card: that screen now renders `store.entriesForOwners(...)` over the
  /// machine's owner set. The banner follows it, exactly as RV-91 demanded —
  /// what changed is the screen, not the rule that the banner must match it.
  ///
  /// ⚠️ ISOLATION ACROSS DIFFERENT MACHINES IS UNTOUCHED. Two computers are two
  /// scopes, and two pairings that could not report a machine uid fall back to
  /// their own identities — 「could not be determined」 is never read as 「is the
  /// same one」 ([scopeKeyFor]).
  ///
  /// Takes the two frozen values rather than a pre-computed key so a caller
  /// cannot hand it a raw identity where a scope key is meant: the screen and
  /// the queue must go through the SAME [scopeKeyFor], or the banner counts a
  /// bucket the screen does not render — which is the RV-91 defect itself.
  int countFor({String? machineUid, String? pairingIdentity}) {
    // A screen with no identity has no scope — 「we don't know which screen you
    // are looking at」 must not be
    // answered with a machine's whole queue. (The FACTORY above deliberately
    // does allow a uid-only key: that is an ITEM naming where it is going, a
    // different question from a SCREEN naming what it is showing.)
    if ((pairingIdentity ?? '').trim().isEmpty) return 0;
    final String? key = scopeKeyFor(
      machineUid: machineUid,
      pairingIdentity: pairingIdentity,
    );
    if (key == null) return 0;
    return (_byInstance[key] ?? 0) + unaddressedCount;
  }
}
