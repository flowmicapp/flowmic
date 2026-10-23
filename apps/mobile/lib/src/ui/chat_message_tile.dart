// SPEC-REF:
//   docs/ui-design/demo/mobile.html (.card.msg: meta row = mode badge + time +
//     status pill; .txt; .src 原文("original text") line; .editd-mark corner
//     overlay; the live
//     transcribing row with the blinking cursor)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 A/D
//
// One chat-flow row. The committed tile renders the delivery-face badge +
// optional inline edited mark + optional original-text source line; the live
// tile renders
// the in-flight interim with a "转录中"("transcribing") pill. Long-press opens
// the context menu.
// M2: an un-landed PC-bound text row also carries an inline resend beside the pill.
// owner 2026-07-31: a row that HAS been re-sent also shows 「上次重发 <时刻>」
// ("last resent <time>") next
// to its original time — both instants, never one replacing the other.
//
// N2 / RV-43 §4: the badge is keyed on [DeliveryFace] (window B3-2b: SEVEN faces
// over four statuses, window B4-5: EIGHT — it said 「five」 until B3-2b, corrected
// rather than re-typed), so queued / delivering / undelivered / no-focus-not-injected / delivery-refused read
// differently — see status_badge.dart.

import 'dart:typed_data' show Uint8List;

import 'package:flutter/widgets.dart';

import '../session/compose_gate.dart' show ComposeSendFailure;
import '../session/image_thumbnail.dart' show decodedThumbnail;
import '../session/pending_recovery.dart' show recordedAtMsFromId;
import '../settings/app_strings.dart' show AppStrings;
import '../signaling/wire_payloads.dart' show FlowMode;
import '../timeline/entry_metrics.dart'
    show entryWordCount, formatEntryDuration, textWordCount;
import '../timeline/timeline_entry.dart';
import '../session/usage_counters.dart';
import 'chat_control_tile.dart';
import 'chat_message_meta.dart';
import 'status_badge.dart';
import 'time_label.dart';
import 'tokens.dart';

// 800-line cap (this file stood at 799/800): the live-draft row moved out
// VERBATIM. See that file's header for why it is a `part` and not a library.
part 'live_draft_tile.dart';
part 'chat_message_tile_meta_tail.dart';
// 800-line cap again (card fix-015 took this file to 841/800): the reason-copy
// family — 「这一行说不说『为什么』，说哪一句，说在哪一格」("whether this row says
// 'why', which sentence it says, and in which slot it says it") — moved out
// VERBATIM. Same
// `part` reasoning as above; the new file's header states the seam and says
// plainly that it is a size cut, not a layering claim.
part 'chat_row_reason.dart';
// 800-line cap: provenance and metrics helpers moved out VERBATIM.
part 'chat_message_tile_helpers.dart';

class ChatMessageTile extends StatelessWidget {
  const ChatMessageTile({
    super.key,
    required this.entry,
    required this.strings,
    this.onLongPress,
    this.polishSkippedLabel,
    this.polishSkippedShortLabel,
    this.polishNeedsAction = false,
    this.isFavorite = false,
    this.onZoom,
    this.instanceChip,
    this.onRetry,
    this.onSelectToggle,
    this.selected = false,
    required this.queued,
    this.owed = false,
    required this.canResendImage,
  });

  final TimelineEntry entry;

  /// 🔴 Card FB-7 multi-select — non-null ⇒ THIS ROW IS IN SELECTION MODE: a single tap
  /// toggles it instead of doing nothing.
  ///
  /// Nullable rather than a `bool selectionMode` + separate callback because the
  /// two would be able to disagree (mode on, nobody listening = a tap that
  /// silently does nothing, i.e. the exact façade shape this repo keeps being
  /// burned by). One value, one question: 「有没有人接这一下点击」("is there
  /// anyone catching this tap").
  ///
  /// ⚠️ The host is expected to pass `onLongPress: null` and `onZoom: null`
  /// while this is non-null. That is NOT enforced here, deliberately — a tile
  /// cannot police its host's argument list, and pretending to would be a
  /// comment asserting someone else's behaviour (anti-façade ④). It IS pinned by
  /// a test instead: `selection_wire_test.dart` asserts the production page
  /// hands over null for both in selection mode.
  final VoidCallback? onSelectToggle;

  /// Whether this row is currently ticked. Meaningless (and never rendered)
  /// unless [onSelectToggle] is non-null.
  final bool selected;

  /// window B3-2b — 「这一行的投递还躺在队列里吗」("is this row's delivery still
  /// sitting in the queue") (`DeliveryOutbox.queuedEntryIds`).
  ///
  /// REQUIRED, not defaulted: false is a real claim (「它已经上路了」("it's
  /// already on its way")), and a
  /// friendly default would put that claim on every call site that forgot —
  /// which is precisely the 「投递中」("delivering")-for-a-frame-that-never-left
  /// bug the field
  /// exists to end. Passed straight to [deliveryFaceOf]; the tile does not
  /// interpret it.
  final bool queued;

  /// NR-279 — 「does the queue still owe this row」, queued OR inflight
  /// (`DeliveryOutbox.owedEntryIds`). Passed to [deliveryFaceOf], where it only
  /// selects `DeliveryFace.noAnswerYet`; see that parameter's doc for why the
  /// false default is bounded (it renders like today's ✗).
  final bool owed;

  /// 🔴 「这张图还能不能重发」("can this picture still be resent")
  /// (`DeliveryOutbox.resendableImageEntryIds`).
  ///
  /// ⚠️⚠️ Correction (RV-93). It used to mean 「压缩副本还在手机上吗」("is the
  /// compressed copy still on the phone"), and that WAS the
  /// whole rule while a delivered picture's bytes were deleted (owner ①). owner
  /// revoked that on 2026-08-01 (「投递成功即删，改为存下来」("delete on
  /// successful delivery, changed to keep it")): the bytes are now
  /// permanent, so 「字节还在」("the bytes are still there") is true for every
  /// picture and cannot gate anything.
  /// The set now means **not delivered yet AND bytes present** — the state clause
  /// is the gate, the byte clause only keeps R8 (no button that cannot work).
  ///
  /// Also required, and for a sharper reason than [queued]: defaulting it to
  /// false would silently restore the old blanket 「图片一律不给重发」("pictures
  /// categorically get no resend"), i.e. the
  /// gate this card was sent to remove, with nothing to grep.
  final bool canResendImage;

  /// V2-17: the mode badge's word comes from the catalogue, so the row needs the
  /// catalogue. Required rather than defaulted — see [ModeBadge.strings].
  final AppStrings strings;
  final void Function(TimelineEntry entry)? onLongPress;

  /// M2: the resend affordance on an UN-LANDED row, rendered inline beside the
  /// status pill. The caller supplies the delivery path (window B3-2b:
  /// `ChatController.resendEntry`, which dispatches text→`reInject` /
  /// picture→`resendImage`); the tile only gates WHEN it shows.
  ///
  /// ⚠️ That gate USED to read 「failed status, PC-bound, non-image — the same
  /// judgement the context menu makes」. Two thirds of that is now false and the
  /// sentence is kept as a correction: undelivered offers it too (RV-43), a picture
  /// offers it when its bytes survive ([canResendImage]), and a TERMINAL refusal
  /// never offers it at all (RV-67). The long-press menu has NOT caught up on
  /// pictures — logged as a gap, not silently implied.
  final void Function(TimelineEntry entry)? onRetry;

  /// V2-06b (Requirement ④ hard requirement ①): the full-history attribution
  /// chip — 「这条是对谁说的」("who this entry was spoken to").
  /// Rendered as the row's TOP line, a first-class citizen on the row itself,
  /// never tucked into a detail view: with several instances' rows interleaved,
  /// an unlabelled row is unreadable. Null on the chat page, where every
  /// visible row already belongs to the one connected instance and a chip
  /// would just repeat the header. The caller owns the chip's copy + colours.
  final Widget? instanceChip;

  /// owner 2026-07-27 double-tap full-screen preview. Given the
  /// ALREADY-DECODED preview bytes (so
  /// opening the viewer costs no second decode) and the ROW itself. Null ⇒
  /// double-tap does nothing, which is what a host that offers no viewer should
  /// do rather than pretending.
  ///
  /// 🔴 RV-93 — it hands over the ENTRY, not the caption it used to pass. The
  /// viewer now opens size B (the picture that was really delivered), and only the
  /// row can say which picture that is (`rowImageBytes(images, entry)` keys off
  /// `entry.clientId`). Passing a caption string would have forced the host to
  /// re-find the row from a piece of its display text — a lookup by the one
  /// field the user is allowed to edit.
  final void Function(TimelineEntry entry, Uint8List thumb)? onZoom;

  /// F-5 「与历史精确匹配显示 ⭐」("show ⭐ on an exact match against history"):
  /// this row's text is saved as a favourite.
  /// Rendered inline in the meta row rather than as a corner overlay (where the
  /// demo draws `.fav`) because the two existing overlays — edited + polish-
  /// skipped — already own the top-right corner and can both be present at
  /// once; a third would land on top of them.
  final bool isFavorite;

  /// WP-R4-6 ⑦: non-null ⇒ show the transient polish-skipped mark (own line below the meta row, NR-122b).
  /// Label is resolved by the caller from AppStrings (explicit locale).
  final String? polishSkippedLabel;

  /// CARD-UI: the same fact in fewer words (`PolishBadge.shortLabel`), shown
  /// only when [polishSkippedLabel] does not fit the second meta line; the
  /// mark then keeps the full label as its tooltip and semantics label.
  /// Null ⇒ the full label is always used.
  final String? polishSkippedShortLabel;

  /// UI-1: true ⇒ the polish mark is amber (user can fix it in model settings,
  /// `PolishBadge.needsUserFix`); false ⇒ calm neutral chip.
  final bool polishNeedsAction;

  @override
  Widget build(BuildContext context) {
    // 🔴 REQ-12-13 — A REMOTE KEY PRESS IS NOT A DELIVERY, so it leaves before any
    // of this file's machinery runs (contract Book 15 §2.0-e). Everything below —
    // the status pill, resend, the failure code, 「→ PC → window」,
    // duration/word-count — answers a
    // question about a DELIVERY, and this row has not made one: it records that a
    // keypress frame left the device, which is the whole of what this end can prove.
    //
    // 🔴 THE FORK IS BEFORE `deliveryFaceOf`, DELIBERATELY. `TimelineEntry.status`
    // on a control row normally starts as a structural filler; ChatControlTile
    // reads only its independent uncertain outcome. The message-delivery face
    // function must never be asked about it. Putting the fork here keeps those
    // two vocabularies structurally separate.
    if (entry.isControl) {
      return ChatControlTile(
        entry: entry,
        strings: strings,
        onLongPress: onLongPress,
      );
    }
    // N2: resolved once. The pill, the resend colour and the retry gate all have to
    // agree about which face this row is showing, and three independent
    // re-derivations is how they would stop agreeing.
    final DeliveryFace face =
        deliveryFaceOf(entry, queued: queued, owed: owed);
    final StatusMeta faceMeta = deliveryFaceMeta(face, strings);
    // Resend is offered on all three un-landed faces, for the same reason: the
    // words did not arrive and re-sending them is the remedy. Undelivered means
    // 「留着可以补投」("kept so it can be backfilled") (RV-43 §1) — offering no
    // way to backfill would make that copy a
    // claim about a capability the UI withholds. A cloud row has no PC to send
    // to, so it stays out (same gate the long-press menu applies).
    //
    // 🔴 RV-67 — `DeliveryFace.refused` IS ABSENT FROM THIS LIST, AND THAT IS
    // THE POINT OF THE FACE. A terminal refusal cannot produce a different
    // answer on a resend (isTerminalRefusalCode), so a button here would be
    // 「一个改变不了任何东西的控件」("a control that changes nothing") — R8, which
    // this repo has already been caught
    // by three times — and worse than that: for `INJECT_PC_MISMATCH` it would be
    // an invitation to retry a RED-LINE alarm until it happens to land.
    //
    // 🔴 window B4-5 — `DeliveryFace.noFocus` IS IN THIS LIST, and that is a real
    // R8 claim to check, not an inherited one: pressing resend re-runs the exact
    // same pipeline (`inject/pipeline.rs` Stage 1) against whatever window is
    // ACTUALLY focused at the moment the user taps the button — not the frozen
    // moment the original attempt failed. A user who reads 「无焦点未注入」("no
    // focus, not injected"),
    // clicks into a field, and then taps resend gets a DIFFERENT outcome than the
    // one that produced this row, which is exactly the property R8 asks for.
    // This is also why `INJECT_NO_TEXT_TARGET` is deliberately absent from
    // `isTerminalRefusalCode` (outbox_item.dart) — retrying it is not retrying
    // a bug, it is retrying a precondition that can genuinely change.
    //
    // 🔴 IMAGES ARE NO LONGER BLANKET-EXCLUDED (owner 2026-07-31, two-segment model).
    // They are admitted exactly when [canResendImage] says so.
    //
    // ⚠️⚠️ Correction (RV-93): the sentence that stood here — 「a DELIVERED
    // picture's
    // bytes are released (owner ①), so [canResendImage] is false there and the
    // affordance disappears with the file」 — described a mechanism owner has
    // since revoked (「投递成功即删，改为存下来」("delete on successful delivery,
    // changed to keep it")). The bytes no longer disappear.
    // A delivered picture is kept out of the button by TWO independent facts now,
    // and both are worth knowing because either alone would be enough:
    //   ① its face is `injected`, which is not in `retryableFace` below; and
    //   ② `resendableImageEntryIds` requires the item to be un-delivered.
    // `noFocus` never applies to a picture row regardless (CLAUDE.md: 「
    // INJECT_NO_TEXT_TARGET 自 0.2.9 起只用于文字，图片路径不再据此拒绝」("since
    // 0.2.9 INJECT_NO_TEXT_TARGET is only used for text; the picture path no
    // longer refuses on it")), so the
    // `entry.isImage ? canResendImage : true` gate below is unreachable for it
    // on the false side — stated rather than silently relied on.
    // 🔴 Card L7 × Card L8 — `deferredNotInjected` is DELIBERATELY ABSENT.
    // R8: on the phone, 「resend」 hands the same entry back to the queue, and
    // **the next drain is by definition another backfill delivery** ⇒
    // it is bound to get back the exact same code. That is a button that
    // cannot do anything. This entry's remedy lives on **the other end**:
    // 「re-inject」 on the PC timeline. (For the same reason it is also absent
    // from `explainNoImageResend` — that sentence says
    // 「delivered successfully, no need to resend」, while the fact here is
    // 「delivery succeeded, but it has not landed on screen yet」.)
    // 🔴 Card F2 — `deliveredNotInjected` IS IN THIS LIST, using `noFocus`'s
    // **already-verified R8 argument**, not an inherited one: pressing
    // 「resend」 is a `live` delivery, and the PC will re-run Stage 1
    // (`inject/pipeline.rs`) against whatever window is **actually** focused
    // **at the moment it is pressed**, so a user who clicks into the input
    // box and then presses gets a **different result** — which is exactly
    // the property R8 requires.
    // (Contrast with why `deferredNotInjected` is not in the list: that
    // entry's next drain is by definition another backfill delivery,
    // bound to get back the same code ⇒ a button that cannot do anything.
    // The difference between the two is **the cause**, not **the first
    // word**.)
    //
    // ⚠️ A picture row is still blocked by `canResendImage` (the queue item is
    // already terminal ⇒ `isPending` is false), and
    // `explainNoImageResend` only recognizes `injected` ⇒ a 「delivered · not
    // injected」 picture on the phone
    // **has neither a button nor that explanation**. This is the same gap L8
    // already logged in `error-codes.ts`
    // (a backfilled picture has no 「inject it now」 landing point on either
    // end), this card has not widened it, nor closed it.
    //
    // 🔴🔴 Correction (Card fix-015, 2026-08-10, MEASURED on this tree). **The second
    // half of the paragraph above is FALSE and is kept as history.** The button
    // clause is exact; 「也没有那句解释」("nor that explanation") is not. A picture row on
    // `deliveredNotInjected` DOES print a full-width sentence — [_reasonNoteFor]
    // has never been gated on `isImage`, and `_faceSpeaksReason` speaks
    // unconditionally on that face. Probed before writing this card: a picture
    // row on `INJECT_SECURE_INPUT_ACTIVE` rendered pill 「⤓ 已投递 · 未注入」
    // ("⤓ delivered · not injected") plus
    // `entry.reasonNote.*` carrying the generic sentence.
    //
    // 🔴 The real defect was worse than the silence this paragraph described:
    // that sentence ends 「…到电脑上离开密码框，再重发。」("…go to the PC and leave
    // the password field, then resend.") — an imperative naming a
    // control that exists on NEITHER end for a picture (no resend here, and
    // `TimelinePage.vue` `rowCanReinject` = `entry_type !== 'image' && …` on the
    // PC). Silence tells the user nothing; that told them to press something
    // that is not there. Now fixed for those two codes by the picture variant in
    // [_reasonNoteFor]; the underlying L8 gap (no 「paste it now」 affordance on
    // either end) is UNCHANGED and still open — this card explains it, it does
    // not close it.
    final bool retryableFace =
        face == DeliveryFace.failed ||
        // NR-279 — resend stays safe here (same queue item and request id).
        face == DeliveryFace.noAnswerYet ||
        face == DeliveryFace.undelivered ||
        face == DeliveryFace.noFocus ||
        face == DeliveryFace.deliveredNotInjected ||
        face == DeliveryFace.injectionUncertain;
    // CARD-UI (MAIN 2026-10-14): two questions, two values. [canResend] —
    // can this row be resent at all; [resendShown] — is the inline Resend
    // drawn now. They differ in selection mode only: a tap there must toggle
    // the selection (FB-7 / NR-3 take the row's gestures in that mode), so the
    // inline Resend is not drawn, while the row stays resendable the moment
    // the mode ends (the reason sentence below keys on [canResend]).
    final bool canResend =
        onRetry != null &&
        retryableFace &&
        (entry.isImage ? canResendImage : true) &&
        entry.origin != 'cloud';
    final bool resendShown = canResend && onSelectToggle == null;
    // The 「PC → window」 text of the meta's PC region (moved here unchanged
    // by CARD-UI, with its notes):
    // owner 2026-07-27:「手机这一端也应该有这样的一个信息，这样的话
    // 用户可以知道我这条信息到哪里去了」("this side, the phone, should
    // also have a piece of information like this, so the user can
    // know where this message of mine went"). The PC timeline has always
    // shown 「→ 窗口名」("→ window name"); the phone received
    // inject_target on the wire
    // and stored it, then dropped it on the floor at render time.
    // Flexible + ellipsis: a window title can be very long, and this
    // row must never wrap or push the badges out.
    // owner 2026-07-27:「手机端要有 PC端实例名 → 目标 的信息」("the phone
    // side should have PC-instance-name → target information")— the
    // phone
    // knows which phone it is, so the row shows the OTHER two legs.
    // 🔴 Card L7 / owner 2026-08-02「PC 名称要显示」("the PC name must
    // be shown"): this slot can now name a destination for every
    // row (not only rows that landed) — see [_provenance].
    Widget? provenanceText(String? p) => (p == null || p.isEmpty)
        ? null
        : Text(
            p,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: FlowMicColors.teal, fontSize: 10.5),
          );

    // 🔴 window B3-9 / Book 15 G-11 — 「有的图能重发、有的不能，没人说为什么」
    // ("some pictures can be resent and some can't, and nobody says why").
    //
    // ⚠️⚠️ Correction (RV-93) — THE GATE AND THE REASON BOTH CHANGED. It read
    // `entry.isImage && face == injected && !canResendImage`, and the third
    // clause was doing real work: 「已投递 ⇒ 字节已被释放 ⇒ 没得重发」("delivered ⇒
    // bytes released ⇒ no resend possible"). owner
    // revoked 「投递成功即删」("delete on successful delivery"), so the bytes ARE
    // still there and `!canResendImage`
    // is now true for a different reason (the item is delivered) — the same
    // boolean, a different meaning. Keeping it would have been this repo's #1 bug
    // shape hiding in a UI gate, and the sentence it rendered (「原件已投递并清理」
    // — "the original was delivered and cleaned up")
    // would have become a plain lie about the user's storage.
    //
    // ⇒ ONE clause, one question: 「这一行已经投递成功了吗」("has this row already
    // been delivered successfully"). The sentence it shows
    // now says the honest reason — it landed, so there is nothing to re-send —
    // see `AppStrings.imageResendUnavailableNote`. Still mutually exclusive with
    // [canResend] by construction: `injected` is never in `retryableFace`.
    final bool explainNoImageResend =
        entry.isImage && face == DeliveryFace.injected;
    // 🔴 Card FB-7 — the ticked state is carried by the card BORDER as well as the
    // glyph. One channel is not enough: the glyph is 14 px in a meta row that
    // already carries six chips, and a user scanning a list of a dozen rows for
    // 「which ones did I tick」 reads shape long before they read a small icon.
    // (Same reasoning as the channel-visual-identity note in CLAUDE.md: never
    // colour alone,
    // and never one small mark alone either.)
    final bool selectable = onSelectToggle != null;
    final Widget body = Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
      decoration: _cardDecoration(
        border: selectable && selected ? FlowMicColors.brand : null,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // CARD-UI (owner 2026-10-14): the meta is TWO never-wrapping lines
          // (chat_message_meta.dart has the why and the placement rules).
          // Line 1 = delivery state · PC instance; the PC instance is the
          // ONLY part of line 1 that gives way (ellipsized, possibly to
          // nothing). Line 2 = time · duration and character count · polish
          // mark (its short wording only when the full one does not fit),
          // then one optional ellipsized tail (resent time / reason / picture
          // note). Those facts are fixed: always in full. The selection tick,
          // mode badge, Resend, edited mark and star are optional: whole, on
          // whichever line has room (tick and mode before the delivery state
          // when line 1 holds them), Resend and the edited mark falling back
          // to their icon forms only when neither line can hold the word. This
          // must not become a `Wrap` again: a Wrap moves a whole long PC name
          // to its own run, which is the three-line card the owner
          // photographed. The NR-122b note that stood here (the meta row was
          // a Wrap) is superseded.
          MetaLines(
            children: <Widget>[
              // The tick leads the meta row so every row's mark sits at the same
              // x — a column of ticks is scannable, a tick that moves with the
              // mode badge's width is not. Absent entirely outside selection
              // mode (no placeholder: 「a field that always renders is a field
              // that tells you nothing」, this file's own words).
              //
              // A glyph, not an `Icon`: `Icons` lives in material.dart and this
              // file deliberately imports only widgets.dart — the SAME call this
              // file already made for the ⭐ below, quoted there verbatim
              // (「one star is not worth dragging the whole Material layer in」).
              //
              // CARD-UI: optional and leading — first on line 1, or first on
              // line 2 on a card whose delivery state fills line 1 (the
              // card's border still marks the selection, FB-7).
              if (selectable) ...<Widget>[
                MetaOptional(
                  leads: true,
                  child: Text(
                    selected ? '☑' : '☐',
                    key: ValueKey<String>(
                      'entry.select.${selected ? 'on' : 'off'}.${entry.id}',
                    ),
                    style: TextStyle(
                      color: selected ? FlowMicColors.brand : FlowMicColors.t3,
                      fontSize: 14,
                    ),
                  ),
                ),
              ],
              // CARD-UI: the mode badge is not one of the always-in-full facts,
              // so it is optional — before the delivery state while line 1
              // has room for both, otherwise on line 2.
              MetaOptional(child: ModeBadge(entry.mode, strings: strings)),
              StatusPill(face, strings: strings),
              // M2: an un-landed PC-bound text row carries its own resend right
              // where the news is announced — the retry must be discoverable at
              // the row, not buried in the long-press menu. Underlined text in
              // the FACE's colour (N2: red for ✗, amber for 📥 — a red resend
              // on an
              // amber pill would call undelivered a failure in the one channel
              // the pill
              // just took care not to), the same affordance language the banner
              // slot's _TextButtonlet speaks.
              // CARD-UI: optional — beside the pill when line 1 has room,
              // otherwise on line 2; the icon form only when neither line can
              // hold the word.
              if (resendShown) ...<Widget>[
                MetaOptional(
                  // A 48 dp hit area around the small icon (C4).
                  compact: MetaTapTarget(
                    child: ResendIcon(
                      key: ValueKey<String>('entry.resend.icon.${entry.id}'),
                      label: strings.resendAction,
                      color: faceMeta.color,
                      onTap: () => onRetry!(entry),
                    ),
                  ),
                  child: Semantics(
                    button: true,
                    label: strings.resendAction,
                    child: GestureDetector(
                      key: ValueKey<String>('entry.resend.${entry.id}'),
                      behavior: HitTestBehavior.opaque,
                      onTap: () => onRetry!(entry),
                      child: Text(
                        strings.resendAction,
                        style: TextStyle(
                          color: faceMeta.color,
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          decoration: TextDecoration.underline,
                          decorationColor: faceMeta.color,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
              // V2-06b + owner 2026-07-27: WHO this row went to. One flexible
              // region holds both the history page's attribution chip (it used
              // to be a line of its own above the meta) and 「PC → window」; it
              // is the only thing on line 1 that shrinks.
              MetaFlexible(
                // The history page's chip has a fixed icon and padding (31 px);
                // 96 px leaves it room for about eight characters of the name.
                minWidth: instanceChip != null ? 96 : 12,
                // The history page lists every computer's rows: there the chip
                // says WHICH computer a row went to (owner 2026-07-27 hard
                // requirement ①) and is never hidden — it moves to the next
                // line instead. The chat page is one computer's flow, so there
                // the name may give way entirely.
                keep: instanceChip != null,
                // owner 2026-07-27 / Card L7: 「PC → window」 — see [_provenance].
                // CARD-UI (C6): on the history page the chip goes first and
                // keeps its natural width; 「→ window」 gets what is left
                // (MetaPriorityRow), and the chip's name is not repeated in it.
                child: instanceChip != null
                    ? MetaPriorityRow(
                        first: instanceChip!,
                        second: provenanceText(
                          _provenance(entry, chipNamesPc: true),
                        ),
                      )
                    : Row(
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          if (provenanceText(_provenance(entry))
                              case final Widget t?)
                            Flexible(child: t),
                        ],
                      ),
              ),
              const MetaLineBreak(),
              // CARD-UI: the time leads line 2. On line 1 a past year's
              // 「2025/12/31 23:59」 left the delivery state no room on the
              // history page.
              Text(
                timelineTimeLabel(entry.createdAt),
                style: TextStyle(color: FlowMicColors.t3, fontSize: 10.5),
              ),
              // §4b-8 per-row display of transcription duration + word count
              // — see [_metricsLabel]. CARD-UI: fixed, never cut.
              if (_metricsLabel(entry, strings)
                  case final String m?) ...<Widget>[
                Text(
                  m,
                  style: TextStyle(color: FlowMicColors.t3, fontSize: 10.5),
                ),
              ],
              // NR-122b: the polish-skipped mark lives in normal flow (it used
              // to be a Positioned corner overlay that painted over the status
              // / resend link / provenance). CARD-UI: fixed, on line 2 after
              // the count.
              if (polishSkippedLabel case final String full?)
                switch (polishSkippedShortLabel) {
                  final String short? => MetaShortenable(
                    short: PolishSkippedMark(
                      label: short,
                      fullLabel: full,
                      needsAction: polishNeedsAction,
                      // In selection mode a tap toggles the row (C3).
                      tapShowsFull: !selectable,
                    ),
                    child: PolishSkippedMark(
                      label: full,
                      needsAction: polishNeedsAction,
                    ),
                  ),
                  null => PolishSkippedMark(
                    label: full,
                    needsAction: polishNeedsAction,
                  ),
                },
              // Inline, not a corner overlay: a Positioned chip at top-right
              // covered the provenance / metrics / last-delivery time on the
              // same row. The mark is orthogonal to the status pill (colour
              // still stands); it just has to share the row instead of sitting
              // on top of it.
              if (entry.edited) ...<Widget>[
                MetaOptional(
                  // A 48 dp hit area around the small icon (C4).
                  compact: MetaTapTarget(
                    child: EditedMark(
                      key: ValueKey<String>('entry.edited.icon.${entry.id}'),
                      label: strings.editedMark,
                      compact: true,
                      // In selection mode a tap toggles the row (C3).
                      tapShowsLabel: !selectable,
                    ),
                  ),
                  child: EditedMark(label: strings.editedMark),
                ),
              ],
              if (isFavorite) ...<Widget>[
                // A glyph, not an Icon: this file deliberately imports only
                // widgets.dart (no Material), and one star is not worth
                // dragging the whole Material layer in.
                MetaOptional(
                  child: Text(
                    '★',
                    style: TextStyle(color: FlowMicColors.amber, fontSize: 11),
                  ),
                ),
              ],
              // CARD-UI: facts, never cut — on line 2 when they fit, else on
              // the overflow line (chat_message_meta.dart `MetaFact`).
              ..._metaTail(
                entry: entry,
                strings: strings,
                face: face,
                explainNoImageResend: explainNoImageResend,
              ),
            ],
          ),
          const SizedBox(height: 3),
          // owner 2026-07-27: a picture row shows the picture. The descriptor
          // stays beneath as the caption — and stands alone when there is no
          // preview, so a row without one degrades to what it always was.
          // owner 2026-07-27 「疯狂闪烁」("frantic flickering"): the bytes come
          // from decodedThumbnail,
          // which returns the SAME Uint8List for the same base64. That identity
          // is load-bearing — MemoryImage compares its bytes by reference, so a
          // fresh decode per build made every stt:interim re-decode the picture.
          // gaplessPlayback is the belt: if a reload ever does happen, the last
          // frame stays up instead of flashing to empty.
          if (decodedThumbnail(entry.thumbB64)
              case final Uint8List png?) ...<Widget>[
            // owner 2026-07-27 double-tap full-screen preview. onDoubleTap
            // only — a single tap must
            // stay free for the row itself, and long-press still opens the
            // context menu.
            GestureDetector(
              onDoubleTap: onZoom == null ? null : () => onZoom!(entry, png),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Image.memory(
                  png,
                  width: 180,
                  fit: BoxFit.contain,
                  gaplessPlayback: true,
                  // A thumbnail that will not decode must not take the row with
                  // it: fall back to the caption alone.
                  errorBuilder: (_, _, _) => const SizedBox.shrink(),
                ),
              ),
            ),
            const SizedBox(height: 4),
          ],
          // NR-137 round 2 (MAIN 2026-10-02) — a note the user's Re-transcribe
          // made from a kept recording says so, above its words, so it is
          // never read as a second copy of that recording's earlier rows.
          if (entry.retranscribedFrom case final String source) ...<Widget>[
            Text(
              switch (recordedAtMsFromId(source)) {
                final int ms => strings.retranscribedNoteMarker(
                    timelineTimeLabel(
                        DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true))),
                null => strings.retranscribedNoteMarkerUndated,
              },
              key: ValueKey<String>('entry.retranscribedMarker.${entry.id}'),
              style: TextStyle(color: FlowMicColors.t3, fontSize: 11),
            ),
            const SizedBox(height: 2),
          ],
          Text(
            entry.displayText,
            style: TextStyle(
              color: FlowMicColors.t1,
              fontSize: kTranscriptBodySize,
            ),
          ),
          // 🔴 Card M6-1 (0.2.53) — 「凭什么说没注入」("what grounds is there for
          // saying it wasn't injected")'s full sentence, filling the whole
          // line. See [_reasonNoteFor].
          // Placed **after** the body text: let the user first recognize
          // which sentence it is, then read what happened to it.
          //
          // 🔴 Card fix-015 — `canResend` is handed over rather than re-derived:
          // the sentence must not name an action this row does not offer.
          // CARD-UI (MAIN 2026-10-14): it keys on whether the row CAN be
          // resent, not on whether the inline link is drawn this instant — in
          // selection mode the link is hidden but the action is still the
          // row's, one tap away once the mode ends. The picture variant
          // is deliberately rendered HERE (full width, maxLines 5) and NOT in the
          // meta-row slot `explainNoImageResend` occupies — that slot is
          // `Flexible(maxLines: 1, ellipsis)` in a row already carrying six chips,
          // i.e. the exact geometry that clipped a sentence to 「INJ…」 in 0.2.53.
          if (_reasonNoteFor(
                face,
                entry,
                strings,
                hasResendAffordance: canResend,
              )
              case final String note?) ...<Widget>[
            const SizedBox(height: 3),
            Text(
              note,
              key: ValueKey<String>('entry.reasonNote.${entry.id}'),
              // Five lines is the **ceiling for pathological content**, not a
              // layout target: on a real device with a real font the longest
              // sentence (the English one, 108 characters) only takes two
              // lines at 411dp. It exists purely so that some long essay
              // someone writes in the future cannot swallow the whole card.
              //
              // ⚠️ Correction (Card fix-015): 「the English one, 108
              // characters」 **is now stale**, the original text is kept
              // — it was true when written. Today the longest sentence on
              // this face is the picture row's
              // `INJECT_NO_ACCESSIBILITY`, **218 characters**, because it has
              // to spell out the entire authorization path.
              // The conclusion is unchanged (five lines is still a ceiling,
              // not a target), but **the margin is much smaller than this
              // sentence would have you believe**:
              // the criterion is no longer 「only takes two lines」, it is
              // `image_verdict_affordance_test.dart`'s
              // real measurement under Ahem (`didExceedMaxLines` == false).
              // ⚠️ That is a measure in the **conservative** direction:
              // Ahem not clipping ⇒ a real device definitely will not clip
              // either, but the reverse does not hold — do not use it to
              // argue how many lines it takes on a real device.
              maxLines: 5,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: FlowMicColors.t3, fontSize: 11.5),
            ),
          ],
          if (entry.showsSourceLine) ...<Widget>[
            const SizedBox(height: 2),
            Container(
              margin: const EdgeInsets.only(top: 2),
              padding: const EdgeInsets.only(left: 8),
              decoration: BoxDecoration(
                border: Border(
                  left: BorderSide(color: FlowMicColors.line, width: 2),
                ),
              ),
              child: Text(
                strings.sourceLine(entry.sourceText ?? ''),
                style: TextStyle(color: FlowMicColors.t2, fontSize: 11.5),
              ),
            ),
          ],
        ],
      ),
    );

    // Edited is inline in the meta row and polish-skipped is a normal-flow line
    // below it (NR-122b), so nothing is drawn over the card body any more.
    final Widget card = body;

    return GestureDetector(
      // 🔴 Card FB-7 — a single tap toggles the tick, and ONLY in selection mode.
      // Outside it this stays null, which is what keeps the promise made a few
      // hundred lines up beside the image's `onDoubleTap`: 「a single tap must
      // stay free for the row itself」. It is free until a mode the user
      // explicitly entered claims it, and it is released again on exit.
      onTap: onSelectToggle,
      // R-UX-09: M7 in the review argued swipe actions could speed this up but
      // was parked as optional. This counter is what decides whether it is worth
      // reopening — the long-press menu being the ONLY path is only a problem if
      // the path is actually walked.
      onLongPress: onLongPress == null
          ? null
          : () {
              countUsage(UsageEvent.entryMenu);
              onLongPress!(entry);
            },
      child: card,
    );
  }
}
