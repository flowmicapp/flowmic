// VERBATIM MOVE out of chat_flow_composer.dart (800-line cap) — the 「+」
// button and the panel it opens (`_plusButtonRouted` / `_openPlusPanelRouted`).
// Card CR-12-F needed one more argument in `_openPlusPanelRouted` and the
// composer file stood at 800/800. The two functions are byte-for-byte what they
// were there, their section comment included; same `Routed` contract as
// chat_flow_composer.dart's header.

part of 'chat_flow_page.dart';

// ── 「+」 panel (T-3b ②③) ─────────────────────────────────────────────────
// PA-1 / SUP-8: 38 → 44. The compose-band contract §2-2 had deliberately left
// this at 38 (「owner didn't name it」); Plan A′'s component spec puts every
// dock touch target on the one [kComposeTouchTarget] ruler, and the 38px
// rationale comment was already retired (b1d07803).
//
// WP8 VF-2: the face is the mock's `.rbt{width:44px;height:44px;
// border-radius:13px;background:var(--chipbg);font-size:20px;color:var(--sub)}`
// — a filled chip with NO border. The border is a delete, not an oversight: in
// the mock the bordered thing on this row is the hint strip beside it, and
// giving both an outline made the two read as one control split in half.
Widget _plusButtonRouted(
  _ChatFlowPageState s,
  BuildContext context,
  AppStrings strings,
) => InkWell(
  key: const ValueKey<String>('compose.plus'),
  onTap: () => _openPlusPanelRouted(s, context, strings),
  borderRadius: BorderRadius.circular(13),
  child: Container(
    width: kComposeTouchTarget,
    height: kComposeTouchTarget,
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: FlowMicDockColors.chipbg,
      borderRadius: BorderRadius.circular(13),
    ),
    child: Icon(Icons.add, size: 20, color: FlowMicDockColors.sub),
  ),
);

Future<void> _openPlusPanelRouted(
  _ChatFlowPageState s,
  BuildContext context,
  AppStrings strings,
) {
  return showPlusPanel(
    context,
    favorites: s.controller.favorites,
    strings: strings,
    buffer: s.controller.buffer,
    // §6.2-6: cloud ⇒ no PC focus. Favorites' tap-to-send (点选即发) stays
    // inert; the album-picture picker still opens (local noted save — owner
    // 2026-07-31), with honest copy.
    noPcTarget: s.controller.destination.isFixed,
    // Tap-to-send (点选即发) goes through ChatController.sendFavorite → the
    // SAME ManualDelivery.deliverText path as ➤. There is no second emission
    // route.
    onSend: s.controller.sendFavorite,
    onFeedback: (String message) => s._toast(context, message),
    // R6 T-4 album picture. Failures land on the BANNER (persistent, dismissible),
    // not the 2-second toast — a delivery that did not happen must not be
    // something the user can miss by looking away.
    onPickImage: (bool original) async {
      await s.controller.sendImage(original: original);
    },
    imageSending: s.controller.imageSend.isSending,
    // owner 2026-08-01: "original image" (原图) is LAN-only. Read from the
    // controller so the panel and the send apply the SAME expression; the
    // send re-reads the channel afterwards, which is the answer that binds.
    originalBlock: s.controller.imageSend.originalBlock,
    // W2.5-E: "save into the current buffer" (存入当前缓冲) must not bank a
    // half-streamed compose result. SAME source of truth as ➤ —
    // `ChatController.isAiComposing` (chat_controller.dart:551 →
    // `aiCompose.isRunning`), which is the term `canSend` ends in. Not a
    // second bool computed here: two values answering 「AI 在跑吗」("is the
    // AI still running") is how they drift apart.
    //
    // 🔴 This gates the SAVE only. Tap-to-send (点选即发) above (`onSend:`
    // `s.controller.sendFavorite`) is untouched on purpose — see plus_panel's
    // `_saveButton` doc for why the delivery half must not inherit this term.
    aiComposing: s.controller.isAiComposing,
    // REQ-12-09 09-A/09-B — the light-record (轻记录) tab's read, built over
    // the SAME persistence `historySource` already threads for the chat list,
    // so 「这台手机上有哪些行」("which rows exist on this phone") has one
    // answer whichever surface asks.
    // 🔴 It is NOT built from the cloud leg's `BlindStoreTimelineBridge`, and
    // that is deliberate: main.dart only constructs that inside
    // `if (cloudState != null)`, so on the shared_preferences fallback the tab
    // would silently disappear while the rows are still on disk — the exact lie
    // design §3-3 state B forbids. Null here means storage was never wired at
    // all (test shapes), and then no tab is drawn rather than an empty one.
    lightRecords: s.widget.historySource == null
        ? null
        : LightRecordQuery(persistence: s.widget.historySource!),
    liveArticleId: s.controller.session.recordingArticleId, // Card P2-9
    backfill: s.controller.backfill.progress, // CR-8 — read-only, one owner.
    isSignedIn: s.widget.isSignedIn,
    onSignIn: s.widget.onSignIn,
    // REQ-12-09 09-F/09-J — the ticked things, delivered through the SAME two
    // legs everything else on this panel uses (`ManualDelivery.deliverText` and
    // `ImageSendController`). A tear-off, not a closure that re-derives
    // anything: the panel supplies WHAT, the controller owns HOW MANY messages
    // that becomes, and there is exactly one implementation of that rule.
    onSendSelection: s.controller.sendPlusSelection,
    // 09-G — 「这一行的原图字节还在吗」("are this row's original image bytes
    // still there"), answered by the ROW's own door (`pathFor(clientId)`),
    // the same one viewing the full image (点开大图) uses on the timeline
    // (`chat_flow_page` → `rowImageBytes`). Not a second notion of 「有没有图」
    // ("is there an image or not"): if these two could ever disagree, the
    // tick box would offer a send that viewing the full image says has
    // nothing behind it.
    imageSendable: (TimelineEntry e) async =>
        await s.controller.rowImages.pathFor(e.clientId) != null,
    // CR-12-F — the 「with times」 chip's memory: the SAME device-local prefs
    // the send policy and the translate target live in.
    prefs: s.controller.localPrefs,
  );
}
