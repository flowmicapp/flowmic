// SPEC-REF: see manual_delivery.dart's header — this file holds that class's
//   collaborator interface and nothing else.
//
// ── WHY THIS FILE EXISTS: THE 800-LINE CAP, AND NOTHING ELSE ─────────────────
//
// `verify:lint` 8/9 (`file-size.mjs`, SRC_MAX = 800) went red when 窗口B3-2a
// added a correction block to manual_delivery.dart (816 > 800). The desktop side had
// just been split for the same gate; this is the Dart equivalent, done the way
// the repo already does it (a collaborator interface in its own file, re-
// exported so no import anywhere has to change).
//
// 🔴 **NOTHING WAS CHANGED. THIS IS A MOVE.** [ManualDeliveryHost] and
// [LanImageIngress] are byte-for-byte what they were at the top of
// manual_delivery.dart, doc comments included — no member added, removed,
// renamed or re-typed. manual_delivery.dart `export`s this file, so every
// existing `import 'manual_delivery.dart'` keeps resolving both names exactly as
// before (image_send_controller.dart and chat_controller.dart are the callers).
//
// Stated explicitly because a split is the easiest place to smuggle a change
// into: if a future reader diffs these declarations against the git history and
// finds a difference, that difference is a BUG, not an intention.

import '../signaling/wire_payloads.dart';
import '../timeline/timeline_store.dart';
import '../timeline/timeline_sync.dart';
import 'delivery_outbox.dart';

/// What a manual delivery needs from its host. ChatController implements it in
/// a handful of lines; keeping it an interface is what lets this class be
/// exercised without a session or a socket.
abstract class ManualDeliveryHost {
  /// The composer's enable gate (link up).
  bool get canCompose;

  /// True when there is no PC focus window to inject into (cloud instance).
  bool get noPcTarget;

  /// The mode a manual row is recorded under (F-2361).
  FlowMode get mode;

  TimelineStore get store;
  TimelineSyncGate get syncGate;

  /// RCA-v3: force the transport down so the reconnect ladder rebuilds it.
  /// Called only after an acked probe has ALREADY proven the link dead — a
  /// healthy link is never kicked.
  Future<void> kickLink();

  /// Wait for the transport to report connected again, bounded. False = the
  /// ladder could not bring it back inside [timeout].
  Future<bool> awaitLinkUp(Duration timeout);

  /// RCA-v3: the LAN http delivery ingress, or null when the live channel is
  /// not a measured-standalone server (cloud relay keeps the socket path).
  /// Endpoint/token are the SAME ones the socket dials with — nothing new to
  /// configure, nowhere new for the bytes to go.
  LanImageIngress? get lanImageIngress;

  /// owner 2026-07-27: the label of the PC currently being spoken to, stamped
  /// onto a row when its delivery succeeds. Null on a cloud instance (there is
  /// no PC) and before pairing.
  String? get pcDisplayName;

  /// 卡 M / 🔴 owner 2026-07-31 iron rule (cross-wiring IDs is absolutely
  /// forbidden): the `pc_id` every
  /// inject:request this delivery emits must be addressed to
  /// (`inject:request.target_pc_id`). Null on a cloud instance (there is no
  /// PC) and whenever the session has not yet learned one — see
  /// `PttSession.pcId`'s doc for when that is possible. NEVER a guessed or
  /// sentinel value: a null here means the frame OMITS the field, not that it
  /// carries a made-up one.
  String? get targetPcId;

  /// 窗口B3-2a — the persistent delivery queue. Every delivery lands here on
  /// disk BEFORE any emit; the emit is one attempt.
  DeliveryOutbox get outbox;

  /// 🔴 RV-97 (b) —— 「**which instance does this transcript screen belong to
  /// right now**」 (`PttSession.connectedInstanceId`). **This is the same
  /// scope RV-91 used**, not a second way of splitting things: 「N items
  /// still not delivered」 buckets by it, and the image-failure banner must
  /// also bucket by it, or two things on the same screen give different
  /// answers to 「whose message is this」.
  ///
  /// ⚠️ **Must not be swapped for [targetPcId]**. That value answers 「which
  /// PC does this frame get delivered to」, and the SAME PC is **two
  /// different `pc_id`s** across the two channels, and it is still null on a
  /// cloud instance — treating it as the screen scope is exactly this repo's
  /// #1 shape (one value answering two questions).
  ///
  /// Null is a genuine value (cloud instance / not yet joined), and **must
  /// not be treated as 「matches everything」**: see the equality criterion in
  /// `ImageSendController.failure`.
  String? get deliveryInstanceId;

  /// Request a repaint.
  void deliveryNotify();
}

/// Where the LAN http image ingress dials (RCA-v3). Both fields come from the
/// live session (reconnect coordinator) — never stored separately.
class LanImageIngress {
  const LanImageIngress({
    required this.endpoint,
    required this.token,
    this.pin,
  });
  final String endpoint;
  final String token;

  /// D2LAN-B3 — this pairing's pinned LAN TLS fingerprint, or null when the
  /// pairing is not pinned. Read off the live session like the other two, never
  /// stored separately: a pin that could go stale relative to the endpoint it
  /// belongs to would be a second answer to 「who this leg must verify」.
  final String? pin;
}
