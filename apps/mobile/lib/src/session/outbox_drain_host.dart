// 800-line cap (window B3-2b): [OutboxDrainHost] moved VERBATIM out of
// delivery_outbox.dart for the same reason [OutboxDrainReport] was — that file
// sat exactly on the cap, and the queue's user-visible surface had to be added
// without deleting a word of the reasoning already there.
//
// 🔴 NOTHING WAS CHANGED. Same members, same order, same docs.
// `delivery_outbox.dart` re-exports this file, so every existing import keeps
// resolving and the move is invisible to `ChatController` (its implementor) and
// to every test double. **Any diff here beyond 「moved」 is a bug.**
//
// It is also the right seam: this is the queue's REQUIREMENT on the app — the
// four things it needs someone else to do — whereas delivery_outbox.dart is the
// queue's own behaviour. They are read at different times by different people.

import 'dart:typed_data';

import '../signaling/wire_payloads.dart' show InjectOrigin;
import 'outbox_destination.dart';
import 'outbox_item.dart';

/// What the queue needs from the app to actually deliver something.
///
/// Every member is required and none may be given a friendly empty default
/// (Book 13 §7 F1 ②) — a queue wired to a no-op sender would report a perfectly
/// healthy drain while delivering nothing, which is the exact failure this file
/// exists to make impossible.
abstract class OutboxDrainHost {
  /// The connection the phone is on RIGHT NOW. Read fresh on every attempt —
  /// never cached across a drain, because the whole point of the address check
  /// is that this can change under us.
  LiveConnection get liveConnection;

  /// design doc §3.3 — an ACKED round trip (`heartbeat`, criterion `ok == true`),
  /// with one kick-and-recover inside. Never 「emit 过」("was emitted"): on this
  /// handset a socket
  /// can be dead for 30 s without the client knowing, and a drain into that
  /// window would mark every item inflight and lose them all at once.
  Future<bool> ensureLink();

  /// design doc §3.5 / A-1 — re-seed the destination (focus seed, kickLink recovery)
  /// BEFORE anything drains. Order matters and is not cosmetic: drain-then-seed
  /// sends the whole queue out with an empty target and the PC answers 「没有可
  /// 注入的目标」("no injectable target") for every one — a mass failure
  /// manufactured by the fix itself.
  Future<void> reseedDestination();

  /// Put ONE item on the wire, addressed to [targetPcId]. Returns whether the
  /// frame left the device (false ⇒ the item goes back to `queued`).
  ///
  /// The implementation builds the `inject:request` from the item's OWN frozen
  /// fields — its `request_id`, its `created_at`, and the [targetPcId] this
  /// queue resolved — and arms the existing row-level watchdog. It must not
  /// re-mint or re-derive any of them.
  ///
  /// 🔴 [imageBytes] IS PUSHED, NOT PULLED, AND THE ASYMMETRY IS THE POINT.
  /// `source:'image'` and `image_b64`/`image_mime` are bound BOTH ways by
  /// `InjectRequestSchema`'s superRefine and by `InjectRequestPayload`'s own
  /// constructor assert — so a host that fetches the bytes itself has a branch
  /// where it builds an image frame without them (debug: assert; release:
  /// `INJECT_FRAME_INVALID`, TERMINAL ⇒ the picture is lost for good). Pushing
  /// guarantees the pairing before the item is ever marked `inflight`: non-null
  /// for every image item, null for every text one. An image item whose bytes
  /// are gone never reaches here — the queue settles it
  /// `refused('OUTBOX_IMAGE_BYTES_GONE')` first.
  /// 🔴 [origin] IS PUSHED FOR THE SAME REASON [imageBytes] IS (L8, 2026-08-02).
  /// 「这一帧算不算现场」("whether this frame counts as live") is decided ONCE by
  /// the queue, from the item's frozen
  /// `created_at` and this attempt's own instant plus whether the user pressed
  /// something — see outbox_inject_origin.dart. A host that computed it itself
  /// would be a SECOND judgement of a rule whose whole safety is that there is one,
  /// and it would be the judgement made at a slightly different moment.
  Future<bool> send(
    OutboxItem item,
    String targetPcId, {
    required InjectOrigin origin,
    Uint8List? imageBytes,
  });

  /// Something the UI renders changed (pending count, an item's state).
  void onOutboxChanged();
}

