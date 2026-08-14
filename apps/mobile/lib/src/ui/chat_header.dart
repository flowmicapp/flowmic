// SPEC-REF:
//   docs/ui-design/demo/mobile.html (frame 2 `.devhead`)
//   docs/rebuild/08-MOBILE-SPEC.md §2
//
// The chat screen's header: TWO rows.
//   row 1 「who's on the other end」 back ← / connection dot / PC name (takes
//     all remaining width)
//   row 2 「how it's connected, where it injects to」 PC-offline chip / channel chip / destination badge / ⚙
//
// 🔴 WHY TWO ROWS (owner's 2026-08-03 real-device session: 「the PC instance
// name at the top is unreadable, which leaves me not knowing which PC I'm
// currently messaging — I'd need to exit to find out」) — **this is the SAME
// spot's THIRD occurrence**:
// v0.2.1: owner said 「only the first 3 letters showed」 (the culprit was
// `Spacer` splitting the remaining width evenly with the name), this time
// it's the destination badge not participating in flex and claiming its
// intrinsic width first. The first two times both re-distributed width
// **inside the same row**, so a third occurrence was always coming. This
// time the math was done first, and the conclusion is: **a single row
// physically does not have room**:
//
//   360dp narrow screen, 14 padding each side ⇒ 332 available
//   three ≥40dp tap targets (← / connection dot / ⚙, V2-04's hard requirement) = 120
//   「dev-pc-a」's measured intrinsic width at 13.5pt w600           = 202.5
//   120 + 202.5 = 322.5, only 9.5 left out of 332 ⇒ **neither the channel
//   chip nor the destination badge fit at all**
//
// ⇒ No amount of flex tweaking does anything but decide 「who gets
// sacrificed」. So identity gets its own row and takes the full remaining
// width; channel and destination sink to the second row. The cost is the
// header growing from 50 tall to ~82, **a deliberate trade-off, not an
// oversight**.
// Those three numbers are pinned by a test
// (chat_header_name_not_starved_widget_test.dart) — change the font size and
// it goes red — **it is not remembered by this comment alone** (anti-façade
// ④: a comment asserting another place's behaviour goes stale).
//
// Split out of chat_flow_page.dart for the 800-line source cap. It is a pure
// render of controller state — every value comes from `controller`, nothing is
// computed here that anyone else needs — so the move carries no logic with it.

import 'package:flutter/material.dart' hide ConnectionState;

import '../session/chat_controller.dart';
import '../session/instance_probe.dart';
import '../session/pc_presence.dart';
import '../settings/app_strings.dart';
import '../signaling/album_away.dart';
import '../signaling/state_machine.dart';
import 'connection_diagnostics_sheet.dart';
import 'destination_badge.dart';
import 'status_badge.dart';
import 'tokens.dart';

class ChatHeader extends StatelessWidget {
  const ChatHeader({
    super.key,
    required this.controller,
    required this.strings,
    required this.deviceNameOverride,
    this.isCloudInstance = false,
    required this.onBack,
    required this.onOpenSettings,
    this.onClearHistory,
    this.hasUpdate = false,
  });

  final ChatController controller;
  final AppStrings strings;

  /// Phone-local alias for the paired PC, when there is one. Never written back
  /// into the ack truth — see ChatFlowPage.deviceNameOverride.
  final String? deviceNameOverride;

  /// Whether the peer is the virtual cloud light-record instance (as opposed to a real
  /// PC, however it is reached). Sourced from the PAIRING
  /// (`ConnectionsController.activePairingIsCloudInstance`), never from the
  /// destination lock.
  final bool isCloudInstance;

  /// `null` hides the back affordance (the home-rooted variant).
  final VoidCallback? onBack;
  final VoidCallback? onOpenSettings;

  /// REQ-12-02 (owner 2026-08-12): 「转录界面增加一键清空历史记录按钮，与设置按钮
  /// 摆一起」("add a one-tap clear-history button to the transcription
  /// screen, placed together with the settings button"). `null` hides it — the home-rooted variant and the widget tests that
  /// do not supply it keep the pre-existing two-control row byte-for-byte.
  ///
  /// 🔴 IT OPENS THE EXISTING CLEAR SHEET, IT DOES NOT CLEAR. Two rules force
  /// that and they point the same way:
  ///   ① owner 2026-07-27 「所有删除…都要二次确认」("every deletion… needs a
  ///      confirmation dialog") — a literal one-tap wipe is
  ///      not a UX preference this card gets to make, it is a banned shape. So
  ///      「一键」("one tap") means one tap to the clear surface, not one tap to gone.
  ///   ② Book 15 G-21: 「删一行＝删掉它的全部字节」("deleting a row = deleting
  ///      all of its bytes"). `showStatsClearSheet` is the
  ///      one path that already honours it — its own D7 note records that
  ///      preview and delete run the SAME predicate over the SAME whole-table
  ///      source, after a defect where this sheet promised a whole-database
  ///      clear and the store deleted one screenful. A second 「clear」 written
  ///      here would be that defect's third act.
  /// ⇒ this is a NAVIGATION callback. The verb stays where it already works.
  final VoidCallback? onClearHistory;

  /// UP-2 —— the small dot on the gear when a new version is available
  /// (design §5.1's 「notification surface」).
  ///
  /// The one source of truth is `UpdateController.hasUpdate`; this only
  /// paints that fact.
  ///
  /// 🔴 **It must be a zero-width Stack overlay, never an extra cell inside
  /// the Row.** This row's width has already been calculated right up to the
  /// margin (see the ⚙ comment below: giving up 40px at 360dp is exactly the
  /// 「dev-pc-a fits / doesn't fit」 boundary), and the header has been bitten
  /// by this exact shape **three times**. Overlaid on the EXISTING 40dp tap
  /// target ⇒ the layout width **does not change by a single pixel**.
  ///
  /// ⚠️ It **does not pop up in the face, does not steal focus** (owner's own
  /// words on the card: 「不弹脸上」"doesn't pop up in your face"): a dot,
  /// nothing else.
  final bool hasUpdate;

  @override
  Widget build(BuildContext context) {
    // v0.2.6 — WHICH PEER this is, asked of the peer.
    //
    // This used to read `destination.isFixed`, i.e. 「whether the
    // destination toggle is locked」. That is a
    // CONSEQUENCE of talking to the cloud instance, not the fact itself, and it
    // outlives the session that set it: after one cloud light-record visit the lock stayed
    // on, so a real PC reached over the relay had its name replaced by
    // 「云端轻记录」("cloud light-record") in the header while its utterances were delivered as 「record only」
    // (owner 2026-07-29). One flag, two questions — the shape this repo keeps
    // paying for.
    final bool cloud = isCloudInstance;
    final String? override = deviceNameOverride;
    final String name = cloud
        ? strings.cloudInstance
        : (override != null && override.isNotEmpty
              ? override
              : (controller.session.connectedDeviceName.value.isNotEmpty
                    ? controller.session.connectedDeviceName.value
                    : 'FlowMic'));
    final ConnDotMeta dot = connDotMeta(
      controller.connection,
      strings,
      albumAway: AlbumAway.instance.isOpen,
      ladderReconnecting: controller.session.reconnect.reconnecting.value,
    );
    // The connection dot and the PC name ask the two halves of the same
    // question (「is it connected」 / 「who's on the other end」), and this
    // sheet answers both halves (`connection_diagnostics_sheet.dart` has
    // status, channel, endpoint, device name).
    // 🔴 owner 2026-08-03: the name can still get elided (a 50px row cannot
    // fit a long machine name + channel chip + focus window + three 40dp tap
    // targets), so the complete answer must be reachable in **one tap** — his
    // previous workaround was 「exit to the instance list and take another
    // look」, and that is what this screen owed him.
    void openDiagnostics() => showConnectionDiagnostics(
      context,
      connection: controller.connection,
      session: controller.session,
      destination: controller.destination,
      strings: strings,
    );
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: FlowMicColors.line)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // ── Row 1: who's on the other end ───────────────────────────────
          // The name **takes all remaining width here** — this row has no
          // second competitor besides the three tap targets; this is exactly
          // what the 「third time」 was meant to fix: the first two times
          // both re-distributed width within the same row, and
          // redistribution cannot solve 「the total doesn't fit」.
          Row(
            children: <Widget>[
              if (onBack != null)
                InkWell(
                  key: const ValueKey<String>('chat.back'),
                  onTap: onBack,
                  borderRadius: BorderRadius.circular(10),
                  // V2-04: ≥40dp tap target; the ICON stays 16 — only the invisible
                  // hit area grew.
                  child: SizedBox(
                    width: 40,
                    height: 40,
                    child: Center(
                      child: Icon(Icons.arrow_back_ios_new, size: 16, color: FlowMicColors.t2),
                    ),
                  ),
                ),
              InkWell(
                key: const ValueKey<String>('chat.connDot'),
                onTap: openDiagnostics,
                borderRadius: BorderRadius.circular(10),
                // V2-04: ≥40dp tap target around the 8px dot (was ~20px).
                child: SizedBox(
                  width: 40,
                  height: 40,
                  child: Center(
                    child: Tooltip(
                      message: dot.label,
                      child: Container(
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                          color: dot.color,
                          shape: BoxShape.circle,
                          // A soft same-colour halo: this dot is the screen's
                          // ONLY transport indicator, and a flat 8px dot did not
                          // read peripherally in a header this size. Size stays
                          // 8 (tests pin it); the halo inherits the state colour.
                          boxShadow: <BoxShadow>[
                            BoxShadow(
                              color: dot.color.withValues(alpha: 0.5),
                              blurRadius: 6,
                              spreadRadius: 1,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 2),
              // V2-04: the name MUST be able to shrink — a machine name long
              // enough will never fit at any width, and Flutter's response
              // to overflow is to paint yellow-black stripes on the header,
              // not an ellipsis. Ellipsis is still the **last resort**, not
              // the normal case: this row has no second competitor left.
              // 🔴 While the ellipsis is showing, the complete answer is
              // covered by 「tap the name → diagnostics sheet」 (openDiagnostics).
              Expanded(
                child: InkWell(
                  key: const ValueKey<String>('chat.deviceNameTap'),
                  onTap: openDiagnostics,
                  borderRadius: BorderRadius.circular(8),
                  child: SizedBox(
                    height: 40, // V2-04's same rule: ≥40dp tap target, font size unchanged.
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        name,
                        key: const ValueKey<String>('chat.deviceName'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: FlowMicColors.t1,
                          fontSize: 13.5,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
          // ── Row 2: how it's connected, where it injects to ─────────────
          // This whole row is **transient values**: the channel changes, the
          // PC can go offline, the focus window swaps every few seconds.
          // That is exactly the point of splitting them from identity onto
          // a separate row — however long a transient value gets, it can
          // never crowd out 「which computer am I talking to」.
          Row(
            children: <Widget>[
              // 🔴 RV-92 (owner's 2026-08-01 real-device session): 「in
              // cloud-relay mode, quitting the PC side still shows the
              // connected status, still shows the PC's instance name and
              // target window name」.
              //
              // Of those three statements, the connection dot and the
              // channel chip **did not lie** — the relay really is
              // connected, and the channel really is the cloud relay. What
              // lied is that **nothing said that PC was already gone**. So
              // what's added here is a separate, independent sentence, not a
              // change to what the connection dot means: the connection dot
              // answers 「is the transport up」, this sentence answers 「is
              // that PC there」. R4: one value answers only one question.
              //
              // Only appears when offline: unknown is not 「not there」,
              // drawing it anyway would just be a new lie; it does not
              // appear when online, because 「no warning」 is not itself a
              // statement. The cloud light-record instance has no PC, and
              // this never appears for it.
              if (!cloud)
                ValueListenableBuilder<PcPresence>(
                  valueListenable: controller.session.pcPresence,
                  builder: (BuildContext context, PcPresence p, Widget? child) =>
                      p == PcPresence.offline
                      ? Padding(
                          key: const ValueKey<String>('chat.pcOffline'),
                          padding: const EdgeInsets.only(right: 8),
                          child: _chipColored(
                            strings.pcOfflineChip,
                            FlowMicColors.red,
                            FlowMicColors.redSoft,
                          ),
                        )
                      : const SizedBox.shrink(),
                ),
              // v0.2.1: the chip now reports the LIVE TRANSPORT, read from the
              // server's own `/api/health.mode`, not from `destination.isFixed`
              // (「对端是不是虚拟云端实例」("whether the other end is a virtual
              // cloud instance") — a different question, and the reason a PC
              // reached through the relay was labelled 「本地局域网」("Local
              // LAN")). While the answer is
              // unknown the chip is ABSENT rather than guessed.
              // 2026-08-01: ChannelBadge (tokens.dart) — icon + colour together, the
              // ONE definition connections_page.dart and connection_diagnostics_sheet.dart
              // also consume now (this file used to draw its own copy via `_chip`).
              ValueListenableBuilder<ServerChannel?>(
                valueListenable: controller.session.serverChannel,
                builder: (BuildContext context, ServerChannel? ch, Widget? child) => switch (ch) {
                  ServerChannel.cloudRelay => ChannelBadge(label: strings.cloudRelay, cloud: true),
                  ServerChannel.lan => ChannelBadge(label: strings.localLan, cloud: false),
                  null => const SizedBox.shrink(),
                },
              ),
              // The badge participates in flex and can itself be elided
              // (`Flexible` in destination_badge.dart). This row has no
              // identity to squeeze, but it still must not overflow: the
              // focus-window title can be arbitrarily long.
              Expanded(
                child: Align(
                  alignment: Alignment.centerRight,
                  child: DestinationHeaderBadge(
                    recordOnly: controller.destination.isRecordOnly,
                    label: controller.destination.headerLabel(strings),
                    // The badge's own question — 「can this toggle be
                    // tapped」 — which IS
                    // `destination.isFixed`. The NAME above no longer reads it: that
                    // one asks 「who's on the other end」. Two questions, two sources.
                    fixed: controller.destination.isFixed,
                    connected: controller.connection == ConnectionState.connected,
                    onToggle: controller.destination.toggle,
                  ),
                ),
              ),
              // ⚙ moved down here from row 1 (owner 2026-08-03): every 40px
              // row 1 gives up, the machine name gets 40px more. At 360dp,
              // this is exactly the 「dev-pc-a fits / doesn't fit」 boundary
              // (202 → 250, and it needs 202.5) — **not a layout
              // preference, a calculated one**.
              // REQ-12-02 —— one-tap clear, placed to the gear's left
              // (owner 2026-08-12: 「placed together with the settings
              // button」).
              //
              // 🔴 It lands on **row 2**, so the header's width budget is
              // not reopened. That budget is about row 1: 360dp narrow
              // screen has 332px available, `dev-pc-a` alone needs 202.5px,
              // and that is exactly why the gear moved down from row 1 back
              // then (0.2.51, this same spot's third defect). This slot eats
              // into this row's `Expanded` destination badge's available
              // width — that badge is itself `Flexible` and can be elided,
              // while **the name cannot**.
              // ⚠️ Whoever wants to move it back to row 1 must first go read
              // how that 202.5px number was calculated.
              if (onClearHistory != null) ...<Widget>[
                const SizedBox(width: 2),
                InkWell(
                  key: const ValueKey<String>('chat.clearHistory'),
                  onTap: onClearHistory,
                  borderRadius: BorderRadius.circular(10),
                  // Same 40dp tap target as the gear (V2-04), same 18px icon:
                  // two controls sitting together that behaved differently
                  // under the thumb would read as one of them being broken.
                  child: Tooltip(
                    message: strings.clearTitle,
                    child: SizedBox(
                      width: 40,
                      height: 40,
                      child: Icon(
                        Icons.delete_sweep_outlined,
                        size: 18,
                        color: FlowMicColors.t2,
                      ),
                    ),
                  ),
                ),
              ],
              const SizedBox(width: 8),
              InkWell(
                key: const ValueKey<String>('chat.settings'),
                onTap: onOpenSettings,
                borderRadius: BorderRadius.circular(10),
                // V2-04: ≥40dp tap target (was ~34px); the icon stays 18.
                child: SizedBox(
                  width: 40,
                  height: 40,
                  // UP-2 badge dot: overlaid, occupies no layout slot. See [hasUpdate]'s doc.
                  child: Stack(
                    alignment: Alignment.center,
                    children: <Widget>[
                      Icon(Icons.settings_outlined, size: 18, color: FlowMicColors.t2),
                      if (hasUpdate)
                        Positioned(
                          top: 10,
                          right: 10,
                          child: Container(
                            key: const ValueKey<String>('chat.settings.updateDot'),
                            width: 7,
                            height: 7,
                            decoration: BoxDecoration(
                              color: FlowMicColors.brand,
                              shape: BoxShape.circle,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// The pcOffline red chip's shape. 2026-08-01: used to also back the transport
  /// chip (`_chip`, cloud/lan coloured) — that one is `ChannelBadge` now
  /// (tokens.dart), the ONE definition three screens share; this stays because
  /// RED here is a STATUS ("that PC is gone"), not a channel identity, and must
  /// not be pulled into the channel-colour token pair.
  Widget _chipColored(String label, Color fg, Color bg) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
    decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(99)),
    child: Text(
      label,
      style: TextStyle(color: fg, fontSize: 10, fontWeight: FontWeight.w600),
    ),
  );
}
