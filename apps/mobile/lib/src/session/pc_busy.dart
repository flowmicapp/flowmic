// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.5d
//     (this PC is occupied by another phone — a state-type banner + the row =
//     pending delivery)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.5.1 / G-20
//     (banners are bucketed per instance)
//   docs/decisions/2026-08-02-delivery-vs-injection-terminology-contract.md §6
//   CLAUDE.md memory flowmic-transient-notice-lifecycle (a notice's lifecycle
//     must match the fact's lifecycle)
//
// 🔴 Card L7 / owner's 2026-08-02 ruling #5 — 「已经有一台手机连入这台 PC」
// ("a phone is already connected to this PC").
//
// The gist of owner's own words: 「两台手机同时连到一台 PC，先连的那台没退出时，第
// 二台看起来能连进去、能进转录界面——但要提醒它：已经有一台手机连入这台 PC，你只能
// 先记录，等待那台连接的手机退出后，你才能够把这些信息投递到 PC。**当前的表现是直
// 接显示未投递，没有显示其他。**」 ("when two phones connect to one PC at the same
// time, and the first one hasn't disconnected, the second phone LOOKS like it
// can connect and get into the transcription screen — but it needs to be told:
// a phone is already connected to this PC, you can only record for now, and
// once that connected phone disconnects you'll be able to deliver this content
// to the PC. **What it currently does is just show 'undelivered', with nothing
// else shown.**")
//
// ── Occupancy is keyed by MACHINE, not by channel/room [verified 2026-08-02,
//    from reading the code] ────────────────────────────────────────────────
// The gate is the desktop's `Admission` (apps/desktop/src-tauri/src/socket/admission.rs)
// — **one copy per process**, its session shared via Arc across both channels;
// the file header states verbatim that *a second phone (**on EITHER channel**)
// is REFUSED*, while the server structurally CANNOT make that judgment (the two
// channels are two servers invisible to each other). ⇒ two phones connecting to
// the same PC over two **different channels** ALSO counts as occupancy, so the
// banner saying 「另一台手机连着这台电脑」 ("another phone is connected to THIS
// COMPUTER") is true; saying 「这条通道被占了」 ("this channel is occupied")
// would be false.
//
// ── Why it is its own value, rather than derived from a delivery failure ─────
// `INJECT_NOT_IN_ROOM` / `INJECT_PC_OFFLINE` have plenty of OTHER causes
// (disconnected, PC powered off, room not built yet). Using them as the
// occupancy verdict would also pop up 「另一台手机占着」 ("another phone has it")
// on a plain disconnect — one value answering two questions, this repo's #1 bug
// shape. **The only valid verdict is the server's own NAMED `PC_BUSY`**
// (apps/server-core/src/socket/handlers/mobile.handler.ts, on `mobile:reconnect`'s ack).
//
// ⚠️ This code used to be **dropped on the floor by the phone**: `ReconnectRejected`
// only carried two bools, with nowhere to hold it. Same shape as the 15 册 §1.4
// line 「`pc_online` 一直就在 ack 上，而手机把它扔在地上」 ("`pc_online` was on
// the ack the whole time, and the phone dropped it on the floor"):
// **it's not a missing field, it's a missing reader.**

import 'package:flutter/foundation.dart';

/// 「另一台手机正连着这台电脑」 ("another phone is currently connected to this
/// computer"), and **which transcription screen this fact belongs to**.
///
/// Same shape as `PcPresenceTracker` (session/pc_presence.dart): a small
/// privately-held object, **with exactly one writer**, and the host
/// (`PttSession`) only forwards. The two fields live together rather than
/// being scattered across `PttSession` individually because they **must live
/// and die together** — a `true` that still carries a stale instance id would
/// paint the banner onto someone else's screen.
class PcBusyTracker {
  final ValueNotifier<bool> _busy = ValueNotifier<bool>(false);

  /// Card L7 / G-20 — the bucket key = `PttSession.connectedInstanceId`, **the
  /// exact same key, verbatim**, as `DeliveryOutbox.pendingCountFor`: the
  /// banner hangs off one particular pairing's transcription page, while
  /// `ChatController` is a singleton that outlives any single instance.
  ///
  /// ⚠️⚠️ CORRECTION (card F2, 2026-08-05) — **THE KEY NAMED ABOVE IS NO LONGER THE ONE
  /// PASSED IN; the sentence is kept as history, not rewritten** (anti-façade ④).
  /// Ruling ④ merged the two channels of one computer into ONE session surface, so
  /// the key is now `SessionScope.key` (`machine:<uid>`, falling back to
  /// `instance:<identity>` — session/machine_key.dart). The load-bearing half of
  /// the sentence — **the same key as `DeliveryOutbox.pendingCountFor`** — is
  /// still true and is now structural: both go through `scopeKeyFor`.
  /// This tracker itself is unchanged: it compares whatever string it is given,
  /// which is why the key could move without touching the rule.
  String? _instanceId;

  /// For the UI's repaint subscription (`ChatController`'s constructor does addListener).
  ValueListenable<bool> get listenable => _busy;

  /// The raw value — **diagnostic use only**. The UI always goes through
  /// [isOnScreen]: an un-bucketed boolean painted onto a screen isolated by
  /// instance is exactly the RV-91 defect itself.
  bool get raw => _busy.value;

  /// Whether THIS screen ([currentInstanceId]) should show the occupancy
  /// banner right now.
  ///
  /// ⚠️ `null == null` evaluating to true is **deliberate**: two cloud
  /// instances both have no instance id, and in that case **keeping it
  /// visible** is more honest than hiding it (15 册 §2.5.1 already nails down
  /// this exact case).
  bool isOnScreen(String? currentInstanceId) =>
      _busy.value && _instanceId == currentInstanceId;

  /// **The one writer's entry point.** [instanceId] is 「学到这件事的那一刻，人
  /// 在哪块屏幕上」 ("which screen the user was on at the instant this fact was
  /// learned") — the scope is read at the moment the fact is PRODUCED, not the
  /// moment it is DISPLAYED (15 册 §2.5.1's fourth rule).
  ///
  /// 🔴 When `busy == false`, [_instanceId] is cleared along with it: leaving
  /// a stale, unused id behind would mean that, for the instant before the
  /// next `true`, there are two answers at once.
  ///
  /// ⚠️ 「到点再问一次」 ("ask again when the time comes") **does NOT live
  /// here** (`session/hold_out_retry.dart`). It used to live in this class,
  /// with the verdict written as 「busy 才起表」 ("only start the timer when
  /// busy"), so `PAIR_RELEASED` (which carries the same budget, but **should
  /// not** paint this banner) went through the clear-banner branch and took
  /// the timer down with it — leaving the phone permanently stuck outside the
  /// door. **The banner asks 「画不画」 ("show it or not"); that separate timer
  /// asks 「什么时候再问」 ("when to ask again"); two questions, two owners.**
  void note({required bool busy, String? instanceId}) {
    _instanceId = busy ? instanceId : null;
    if (_busy.value != busy) _busy.value = busy;
  }

  void dispose() => _busy.dispose();
}
