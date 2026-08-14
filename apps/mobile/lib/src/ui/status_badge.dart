// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 D (five-state:
//     ✓injected green / ⏳cached amber / ✗failed red / 📥noted slate; ✎edited
//     is an ORTHOGONAL corner overlay, not a fifth flat colour)
//   docs/ui-design/demo/mobile.html (.st / .dot / .mbadge / .editd-mark; the
//     b1/b2/b3 mode badges map realtime/translate/organize → brand/teal/amber)
//
// The badge widgets. Material icons stand in for the demo's inline SVGs. The
// colour for each status is drawn from the frozen token table — a reviewer can
// check ✓/✗ against the demo per row.
//
// T-5b-mobile: [connDotMeta] is the SEPARATE connection-dot mapping (green /
// amber / red / slate). It must NEVER be folded into [deliveryFaceMeta] —
// delivery state and transport state are different ontologies.
//
// N2 / RV-43 §4: the pill is keyed on [DeliveryFace], not [EntryStatus]. Four
// statuses, EIGHT faces — `cached` alone shows "pending · queued" / "pending ·
// delivering" / "pending" / "undelivered · refused" (待投递 · 排队中 / 待投递 ·
// 投递中 / 待投递 / 未投递 · 投递被拒) depending on where the delivery actually is.
// See [deliveryFaceOf].
//
// 🔴 Card L7 / owner 2026-08-02 — **the first word of every face is now one of
// the three delivery-segment states** (delivered / pending / undelivered —
// 已投递 / 待投递 / 未投递), docs/rebuild/15 §2.0 + §2.5. All the phone can see
// is "did it reach the PC or not"; the truth of injection lives on the PC's
// timeline, and the phone's row does not stamp the PC's verdict for it.
// The old distinctions (queued vs delivering, refused vs failed) **are all
// kept in the second half of the sentence** — each was paid for in its own
// lesson, and collapsing them to three words would recreate two old defects
// at once. The vocabulary table lives in chat_strings.dart.
//
// ⚠️ That count said FIVE until window-B3-2b, then SEVEN until window-B4-5.
// Corrected rather than quietly re-typed: it is the kind of line the next
// reader trusts instead of counting, and the enum is one `git grep` away from
// settling it either way.
//
// 🔴 window-B4-5 / owner 2026-08-01 — "delivery" (手机→PC) (phone→PC) and
// "injection" (PC→焦点输入框) (PC→focused input) are two different words;
// previously `INJECT_NO_TEXT_TARGET` (the PC had nowhere to type) was folded
// into the generic ✗ failed bucket, and all the user read was a raw English
// code. [DeliveryFace.noFocus] splits it out, saying the owner's own words
// 「无焦点未注入」("no focus, not injected") — see that face's definition and
// [_isNoFocusReason].
//
// ⚠️ This section used to add one more line here — 「/ 📥 未投递」("/ 📥
// undelivered") — i.e. claiming this code also gets folded into
// `undelivered`. **That does not hold, verified by the lead's own audit**:
// 15册 §3.2 once described it this way (`mode:'cached'`), but measured,
// `inject/pipeline.rs` Stage 1b settles it as `mode: InjectMode::SendInput`,
// and the server therefore maps it to `status:'failed'` — in production it
// only ever lands on ✗, never on 📥. Changed to state only the half that
// genuinely happens, rather than treating a document's description as the
// code's actual behaviour (anti-façade ④).

// Hide Flutter's AsyncSnapshot ConnectionState — same clash chat_flow_page has.
import 'package:flutter/widgets.dart' hide ConnectionState;
import 'package:flutter/material.dart' show Icons, Tooltip;

import '../session/outbox_inject_authorship.dart'
    show isPcInjectionVerdictCode;
import '../session/outbox_inject_origin.dart'
    show kInjectDeferredNotAutoinjected;
import '../session/outbox_item.dart' show isTerminalRefusalCode;
import '../settings/app_strings.dart';
import '../signaling/state_machine.dart' show ConnectionState;
import '../signaling/wire_payloads.dart' show FlowMode;
import '../timeline/timeline_entry.dart';
import 'tokens.dart';

/// (dot/text colour, glyph icon, label) for a delivery face.
class StatusMeta {
  final Color color;
  final IconData? icon;
  final String glyph;
  final String label;
  const StatusMeta(this.color, this.icon, this.glyph, this.label);
}

/// N2 / RV-43 §4 — **WHAT THE ROW SAYS**, as opposed to [EntryStatus], which is
/// what the delivery truth IS.
///
/// Five faces over four statuses, because `cached` legitimately has two: a row
/// still waiting for a verdict and a row a verdict settled as 「没投递，可补投」
/// ("not delivered, can be deferred-re-delivered") are the same delivery
/// truth and completely different news. Rendering both from one `EntryStatus`
/// value is the failure this enum exists to make impossible — the switch
/// below is exhaustive, so nobody can add a face and forget its copy.
///
/// Deliberately NOT a field on [TimelineEntry] and NOT a fifth [EntryStatus]:
/// this is a presentation projection (RV-43 adds no state and no protocol
/// field), and it is computed from the row by [deliveryFaceOf].
/// window-B3-2b widened this to SEVEN, window-B4-5 to EIGHT. Every addition is
/// a projection of a fact the row (or its queue item) already carried — none
/// adds a field, a status or a protocol key, which is the test docs/rebuild/15
/// §2.1 sets for admitting one. [noFocus] reads the SAME `failureReason` string
/// [refused] already reads; it does not add a new source of truth, only a new
/// named slice of the one that exists.
enum DeliveryFace {
  injected,
  queued,
  delivering,
  undelivered,
  refused,
  failed,
  noted,

  /// 🔴 window-B4-5 / owner's 2026-08-01 ruling — "delivery" is phone→PC,
  /// "injection" is PC→focused input field (「投递」是手机→PC，「注入」是
  /// PC→焦点输入框). This is the PC saying, BY NAME, that it tried the
  /// injection half and there was nowhere to type:
  /// `failureReason == 'INJECT_NO_TEXT_TARGET'` (`target_probe.rs`
  /// `refusal_for(FocusInputState.NotInput)`, the ONLY producer of that code —
  /// Stage 1b of `inject/pipeline.rs`, "nothing focused, or a menu is up").
  /// See [_isNoFocusReason] for why this is deliberately NOT folded into
  /// [undelivered] or [failed].
  noFocus,

  /// 🔴 Card L7 × Card L8 (owner 2026-08-02) — **this is an automatic
  /// deferred re-delivery where the PC deliberately did NOT inject**
  /// (`INJECT_DEFERRED_NOT_AUTOINJECTED`, docs/rebuild/15 §2.5e / §X.4).
  ///
  /// **It must be its own face, and the reason is a fact on the queue's
  /// side**: this code makes the queue item settle as **`delivered`
  /// (terminal, `delivery_outbox_settle.dart`)** — **nothing will ever
  /// re-deliver it**. Yet it arrives carrying `mode:'cached'`, landing on
  /// `cached + cachedByVerdict` ⇒ if not split out, it would fall into
  /// [undelivered], whose word is **「待投递」("pending delivery")** (i.e. the
  /// queue still owes it and will send it again). 🔴 **That is precisely the
  /// literal shape of the CLAUDE.md red line: a waiting-to-be-delivered
  /// promise with no mechanism behind it.**
  ///
  /// 📌 Same family as [noFocus], same source of judgement (both only read the
  /// `failureReason` string already sitting on the row, adding no new field —
  /// the yardstick 15 册 §2.1 sets for "may a Nth face exist"). The two have
  /// **opposite user actions**, so they must not be merged: `noFocus` ⇒
  /// **click into an input field and resend, and it lands**; this face ⇒
  /// **doing anything to the window is useless**, the message is already on
  /// the PC's timeline, and the re-inject action must be pressed **on that
  /// end**.
  deferredNotInjected,

  /// 🔴 Card F2 (owner's 2026-08-02 iron rule, "a transcribed message's
  /// status must be correct") — **the PC received it and personally answered
  /// the injection segment, and that answer was "did not get injected"**
  /// (`INJECT_FOCUS_LOST` / `INJECT_CLIPBOARD_FAIL` / `INJECT_IMAGE_UNSUPPORTED`
  /// / `INJECT_TARGET_INVALID` / `INJECT_SENDINPUT_FAIL` — judged by
  /// [_isPcInjectionVerdict], single source of truth in
  /// `packages/protocol/src/inject-verdict-authorship.ts`).
  ///
  /// 🔴 **The reason it exists is a real ledger entry**: the owner hit, on a
  /// real device, "spoke while focus was on FlowMic's own window ⇒ the PC
  /// minted a row, and the phone showed 'pending delivery' regardless." That
  /// `INJECT_FOCUS_LOST` lands on `cached + cachedByVerdict`, falling into
  /// [undelivered], whose word is **「待投递」("pending delivery")** (i.e. the
  /// queue still owes it and will send it again). **This card has already
  /// settled the queue side of it as `delivered` (terminal)** ⇒ nothing will
  /// ever re-deliver it ⇒ saying "pending delivery" is the literal shape of
  /// the CLAUDE.md red line: **a waiting-to-be-delivered promise with no
  /// mechanism behind it**.
  ///
  /// 📌 Same family as [noFocus] / [deferredNotInjected] (all only read the
  /// `failureReason` string already sitting on the row, adding no new field —
  /// the yardstick 15 册 §2.1 sets for "may a Nth face exist"). The
  /// relationship among the three: **those two are named special cases, this
  /// one is the rest of the family**:
  ///   · [noFocus] ⇒ "click into an input field and resend, and it lands"
  ///     (owner's own exact words from 2026-08-01);
  ///   · [deferredNotInjected] ⇒ "deliberately not injected, doing anything
  ///     to the window is useless";
  ///   · this one ⇒ "the PC tried, and it didn't work", with the named code
  ///     printed alongside the row (multiple codes share one face ⇒ the code
  ///     is the only thing that can say WHICH one, the same argument as ✗/⛔).
  ///
  /// ⚠️ **Do not confuse this with [deferredNotInjected]** (the two names read
  /// alike): that one's cause is **policy** (this is a deferred re-delivery,
  /// deliberately not injected), this one's cause is **the live scene** (the
  /// window/clipboard/image did not cooperate).
  ///
  /// ⚠️ `INJECT_NOT_PRIMARY` is **NOT** in this face: it too is spoken by the
  /// PC itself, but it speaks to the **admission layer** — owner's 2026-08-02
  /// ruling: when occupied, the row = "pending delivery" (15 册 §3.2, the
  /// "PC busy" row).
  deliveredNotInjected,
}

/// The one place a row is turned into the word it shows.
///
/// 🔴 ORDER IS THE CONTRACT (docs/rebuild/15 §2.5): first match wins, and
/// `refused` MUST be tested before `undelivered`. Reversed, a crosstalk refusal
/// — the red line actually firing — is announced as 「未投递，留着可以补投」
/// ("undelivered, kept for deferred re-delivery") with a button that can only
/// be refused again.
///
/// [queued] answers 「这一行的投递还躺在队列里、一个字节都没上过路吗」("is this
/// row's delivery still sitting in the queue, with not a single byte having
/// gone out yet") and comes from `DeliveryOutbox.queuedEntryIds`. It is
/// REQUIRED, not defaulted to false: a friendly default here would silently
/// reproduce the exact bug this parameter exists to fix (a row that never
/// left the phone rendering 「投递中」("delivering")), and it would do so at
/// whichever call site forgot — 13 册 §7 F1 ② in its purest form.
///
/// ⚠️ Correction (card F12, 2026-08-04) — **THE SECOND HALF OF THAT SENTENCE
/// IS FALSE AND IS KEPT AS HISTORY.** The set is `state == queued`, which a
/// delivery also re-enters after a retryable refusal comes back
/// (`settle_requeued`), so 「一个字节都没上过路」("not a single byte has gone
/// out yet") stopped being true the day the queue could requeue — long before
/// this card. Corrected rather than rewritten (anti-façade ④): a comment that
/// argues for a design is itself a greppable claim, and this one is now
/// LOAD-BEARING in a second place. The true reading, and the only one anything
/// depends on: **「队列现在还欠着这一行吗」("does the queue still owe this
/// row")**.
DeliveryFace deliveryFaceOf(TimelineEntry entry, {required bool queued}) {
  switch (entry.status) {
    case EntryStatus.injected:
      return DeliveryFace.injected;
    case EntryStatus.cached:
      // 🔴 RV-67 — a TERMINAL refusal is not 「未投递」("undelivered").
      //
      // The server answers a crosstalk / unaddressed refusal with
      // `mode:'cached'` (relay.handler.ts `answerReject`), which
      // `applyInjectResult` correctly reads as 「判决说没投」("the verdict says
      // it was not delivered") — so without this clause a red-line accident
      // lands on exactly the same face as a benign wait. They are not the
      // same news: one can be re-sent and one can never be, and the copy for
      // the second literally promises 「留着可以补投」("kept for deferred
      // re-delivery").
      if (_isRefused(entry)) return DeliveryFace.refused;
      // 🔴 window-B4-5 — see [_isNoFocusReason].
      //
      // ⚠️ Lead's own audit (2026-08-01): **today, production cannot reach
      // here.** Following the chain verified in the comment below the `failed`
      // branch, `inject/pipeline.rs` settles `INJECT_NO_TEXT_TARGET` as
      // `mode: InjectMode::SendInput` ⇒ `failed`, and it never lands on this
      // `cached` branch. **This arm is defense-in-depth, not a fix for a live
      // defect** — the reason it exists is that [DeliveryFace]'s judgement
      // should go by the CONTENT of `failureReason`, not by which status
      // bucket it happens to land in today (RV-67's precedent for `refused`
      // is the same argument), in case some future path genuinely puts this
      // code on the wire with `mode:'cached'` (the protocol itself allows it,
      // current code simply does not produce it) — then the face will not get
      // the wrong answer just because "the bucket is wrong." B3-7's rule is
      // the mirror image: **defense-in-depth must not read like a fix for a
      // live bug**, so this must say explicitly "cannot be reached", or the
      // next reader will assume it runs every day.
      //
      // GUARDED by `cachedByVerdict` regardless of reachability: this status
      // also holds a row still AWAITING a verdict (delivering, 投递中), and
      // `failureReason` cannot be cleared by `copyWith` (a resend leaves the
      // OLD code sitting on the row while it waits for a fresh one) — asking
      // this without the guard would misread a waiting row as a settled one,
      // the exact stale-code hazard `chat_message_tile.dart` already documents
      // for `failed`/`refused`.
      if (entry.cachedByVerdict && _isNoFocusReason(entry)) {
        return DeliveryFace.noFocus;
      }
      // 🔴 Card L7 × Card L8 — **THIS is the branch production actually
      // takes** for `INJECT_DEFERRED_NOT_AUTOINJECTED` (the relay maps
      // `ok:false, mode:'cached'` to `status:'cached'`, and
      // `applyInjectResult` sets `cachedByVerdict`). Same `cachedByVerdict`
      // guard as `noFocus` and for the same stale-code reason. Tested BEFORE
      // [undelivered] because that face's word is now 「待投递」("pending
      // delivery") and this row will never be re-sent by anyone.
      if (entry.cachedByVerdict && _isDeferredNotInjectedReason(entry)) {
        return DeliveryFace.deferredNotInjected;
      }
      // 🔴 Card F2 — **the case this card fixes goes through here**
      // (`INJECT_FOCUS_LOST` + `mode:'cached'`). Must be tested before
      // [DeliveryFace.undelivered]: that face's word is "pending delivery",
      // while the queue has already settled this one as terminal `delivered`
      // — nothing will ever re-deliver it.
      //
      // ⚠️ Must ALSO be tested AFTER the two branches above, and this order is
      // now a CONTRACT: `INJECT_NO_TEXT_TARGET` and
      // `INJECT_DEFERRED_NOT_AUTOINJECTED` are both members of
      // [kPcInjectionVerdictCodes] (the same family) — putting this one first
      // would swallow the two named faces that were each paid for with a real
      // lesson.
      //
      // Same `cachedByVerdict` guard, same stale-code reason (see the
      // [noFocus] paragraph above).
      if (entry.cachedByVerdict && _isPcInjectionVerdict(entry)) {
        return DeliveryFace.deliveredNotInjected;
      }
      if (entry.cachedByVerdict) return DeliveryFace.undelivered;
      // Nothing has been handed to the PC and nothing is coming back yet. If the
      // delivery is still sitting in the queue, say THAT — 「投递中」("delivering")
      // would be a claim about a frame that does not exist.
      return queued ? DeliveryFace.queued : DeliveryFace.delivering;
    case EntryStatus.failed:
      // Same test on this branch too, and for the same reason: a terminal code
      // can arrive on a row that settled ✗ (a local settle, then a late verdict
      // carrying the named refusal). 「未成功」("unsuccessful") invites a
      // retry; this one must not.
      if (_isRefused(entry)) return DeliveryFace.refused;
      // 🔴 window-B4-5 — THIS is where `INJECT_NO_TEXT_TARGET` actually lands in
      // production, not the `cached` branch above. `target_probe.rs
      // refusal_for` feeds `mode: InjectMode::SendInput` (never `Cached`) into
      // the outcome (`pipeline.rs` Stage 1b; asserted in
      // `pipeline_tests.rs::text_into_a_proven_non_input_focus_is_refused_by_name`,
      // "non-cached → server maps to failed"), and RV-43's own design table
      // (`2026-07-30-inject-state-narrowing-design.md` §1) names this exact
      // code as the example of `failed`. No `cachedByVerdict` guard is needed
      // here: `failed` is never an "awaiting a fresh verdict" state — the only
      // way back to waiting is `markReinjecting`, which forces `status` to
      // `cached` — so a `failed` row's `failureReason` is always this
      // attempt's own, never a stale carry-over.
      if (_isNoFocusReason(entry)) return DeliveryFace.noFocus;
      // Card L7 × Card L8 — defense-in-depth, mirroring the `cached` branch
      // above. **Today, cannot be reached here** (`deferred_outcome` always
      // sends `mode:'cached'`); the reason it's written out shares its origin
      // with RV-67's argument for `refused`: the face should be judged by the
      // CONTENT of `failureReason`, not by which status bucket it happens to
      // land in today. B3-7's rule stands as before: **defense-in-depth must
      // not read like a fix for a live bug**.
      if (_isDeferredNotInjectedReason(entry)) {
        return DeliveryFace.deferredNotInjected;
      }
      // 🔴 Card F2 — deliberately the **same predicate** as the `cached`
      // branch: the queue side (`delivery_outbox_settle.dart`) uses it to
      // decide "still owed or not," the UI uses it to decide which word to
      // say. If the two judged independently, you'd get "the queue says it's
      // delivered, the row says undelivered" — the exact divergence 15 册
      // §2.1/§2.2 repeatedly warns against, and [_isRefused] reusing
      // `isTerminalRefusalCode` is precisely the same precedent.
      //
      // This arm **is reachable in production** (unlike the L8
      // defense-in-depth arm above): `INJECT_CLIPBOARD_FAIL` /
      // `INJECT_IMAGE_UNSUPPORTED` / `INJECT_TARGET_INVALID` all carry a
      // non-`cached` mode ⇒ the row lands on `failed`, and they are all
      // injection-segment verdicts spoken by the PC itself ⇒ the first word
      // must be "delivered."
      //
      // No `cachedByVerdict` guard needed, for exactly the same reason as
      // [noFocus]'s paragraph on this branch: `failed` is never an "awaiting
      // a new verdict" state.
      if (_isPcInjectionVerdict(entry)) {
        return DeliveryFace.deliveredNotInjected;
      }
      // ── 🔴 Card F12 (M4-15) — A ROW THE QUEUE STILL OWES MUST NOT WEAR A
      //    TERMINAL WORD ───────────────────────────────────────────────────────
      //
      // The symptom, registered in M4 after the root cause was guessed wrong
      // TWICE: an `INJECT_PC_OFFLINE` picture row showed 「未投递」("undelivered")
      // — a terminal face — while the queue took the retryable branch for the
      // very same code, left the item `queued`, and re-sent it on every room
      // join. **Two layers, opposite claims about one message.**
      //
      // 🔴 The only honest source for 「这一行该不该说『待投递』」("should this
      // row say 'pending delivery'") is the queue, and it is already in
      // hand: [queued] comes from `DeliveryOutbox
      // .queuedEntryIds` — the rows covered by items still in `state == queued`,
      // i.e. exactly what the queue kept after judging the code with
      // `isTerminalRefusalCode`. This reads its ANSWER rather than keeping a
      // second copy of its rule, which is one notch stronger than [_isRefused]
      // (that one re-uses the predicate).
      //
      // ⚠️ THE FIX IS NOT A `wireMode` ON `image_send_http`: `INJECT_PC_OFFLINE`
      // has no remote verdict at all, so its mode is genuinely null (M4 handoff
      // §4 M4-15 says so verbatim). Inventing a `'cached'` there is the same sin
      // as the fabricated default card F11 ③ removed.
      //
      // ⚠️ AND IT IS NOT A CODE TABLE IN `applyInjectResult`: that layer does not
      // hold the fact 「队列还欠不欠」("does the queue still owe it or not")
      // (R11's first question), and sorting by code would call `LINK_DOWN` /
      // `PC_UNREACHABLE` rows 「待投递」("pending delivery") too — rows with
      // NO queue item behind them, i.e. the red line in its own words, a
      // waiting-to-be-delivered promise with no mechanism behind it
      // (一个没有机制兑现的等待承诺).
      //
      // 🔴🔴 2026-08-04, lead's own reversal — **the conclusion of the entire
      // paragraph above was overturned by owner's ruling ⑩, and card F12
      // (M4-15) itself has since been superseded by that ruling.** The
      // original text is kept because its analysis is not wrong — what's
      // wrong is the conclusion it was serving; deleting it would let the
      // next person redo the same "fix" all over again.
      //
      // Ruling ⑩'s original text (`docs/rebuild/15` §2.0.1-c, owner
      // 2026-08-04, "I choose undelivered"):
      //   「那张表的三个词回答的是**这一行现在是什么**，而行的 `EntryStatus`
      //    就是这一行自己的判决。**一条已经判了失败的行说『待投递』，等于让
      //    队列的状态去覆盖行自己的判决——两个不同的问题共用一个答案，正是
      //    本仓的头号缺陷形状。** 用户在这一行上该做的动作也是『重发』，不是『等』。」
      //   ("The three words in that table answer **what this row currently
      //   is**, and the row's own `EntryStatus` IS this row's own verdict.
      //   **A row already judged as failed saying 'pending delivery' means
      //   letting the queue's state override the row's own verdict — two
      //   different questions sharing one answer, exactly this repo's
      //   headline defect shape.** The action the user should take on this
      //   row is also 'resend', not 'wait'.")
      //   And it **explicitly** says this is not a contradiction: 「横幅数的是
      //   队列…所以这条投递**同时**出现在『未投递的行』和『还有 N 条待投递』里
      //   **并不矛盾**，两句话各自都是真的。」("The banner counts the queue…
      //   so this one delivery appearing **simultaneously** in 'the
      //   undelivered rows' and 'N items still pending' is **not** a
      //   contradiction, each of the two sentences is independently true.")
      //
      //   ⇒ The "row and queue each say something different" that M4-15
      //   describes **is not a defect, it is the target state after the
      //   ruling.** Timeline: M4-15 was raised 2026-08-02, ruling ⑩ came down
      //   2026-08-04 — **the ruling came later.** Task book F7 (following
      //   ruling ⑩'s "the code as it stands is correct") and F12 (following
      //   M4-15's call to change the display) **contradict each other and
      //   nobody ever reconciled them** — this paragraph IS the
      //   reconciliation: **take the ruling, not the old card.**
      //   ⚠️ The side effect also confirms which way the tradeoff goes: with
      //   that clause added, this kind of row **loses its "resend" button**
      //   (`retryableFace` does not include `queued`), while ruling ⑩ states
      //   explicitly that resend is what the user should do.
      return DeliveryFace.failed;
    case EntryStatus.noted:
      return DeliveryFace.noted;
  }
}

/// Whether this row's named reason is one retrying cannot fix.
///
/// Reads `isTerminalRefusalCode` — the SAME predicate the queue settles items
/// by (outbox_item.dart), deliberately not a second list. Two lists is how the
/// pill and the queue would come to disagree about whether something is over.
bool _isRefused(TimelineEntry entry) {
  final String? code = entry.failureReason;
  return code != null && code.isNotEmpty && isTerminalRefusalCode(code);
}

/// 🔴 window-B4-5 — whether this row's named reason is the desktop's Stage-1b
/// 「没有可输入的位置」("no place available for input") refusal
/// (`INJECT_NO_TEXT_TARGET`), as opposed to any other
/// non-terminal reason (`LINK_DOWN`, `INJECT_NO_RESULT`, …) that also settles a
/// row `undelivered`/`failed`.
///
/// A raw string literal on purpose, matching how [isTerminalRefusalCode] itself
/// compares against `'INJECT_PC_MISMATCH'` etc.: the phone has no shared
/// cross-language constant with the protocol/desktop code that mints this
/// string (`packages/protocol/src/error-codes.ts` `INJECT_NO_TEXT_TARGET`;
/// production sole source `apps/desktop/src-tauri/src/inject/target_probe.rs`
/// `refusal_for`), so a Dart-side constant here would be a second name for the
/// one the wire actually carries, not a shared one.
///
/// NOT a second predicate that could disagree with [_isRefused] about whether
/// something is OVER: `INJECT_NO_TEXT_TARGET` is deliberately absent from
/// [isTerminalRefusalCode] (retrying it after the user taps into a field can
/// genuinely succeed), so this only ever fires on a row [_isRefused] already
/// said no to.
bool _isNoFocusReason(TimelineEntry entry) =>
    entry.failureReason == 'INJECT_NO_TEXT_TARGET';

/// 🔴 Card L7 × Card L8 — 「这一条是自动补投，PC 刻意没有注入」("this one is an
/// automatic deferred re-delivery, and the PC deliberately did not inject it")
/// (`INJECT_DEFERRED_NOT_AUTOINJECTED`).
///
/// Unlike [_isNoFocusReason], **this one uses a SHARED constant**
/// (`session/outbox_inject_origin.dart` `kInjectDeferredNotAutoinjected`,
/// already built by card L8 and consumed on the queue side) — not yet another
/// second name on the Dart side.
bool _isDeferredNotInjectedReason(TimelineEntry entry) =>
    entry.failureReason == kInjectDeferredNotAutoinjected;

/// 🔴 Card F2 —— 「这一行的具名码，是 **PC 亲自跑到注入段之后**给出的裁决吗」
/// ("is this row's named code a verdict the PC gave **after it personally
/// ran the injection segment**").
///
/// Fully isomorphic to [_isRefused]: **reads the SAME predicate the queue
/// uses for settlement** (`session/outbox_inject_authorship.dart`
/// `isPcInjectionVerdictCode`, which is itself a mirror of
/// `packages/protocol/src/inject-verdict-authorship.ts`, verified against
/// that TS source file by `test/inject_verdict_authorship_mirror_test.dart`)
/// — **deliberately not a second list**. Two lists is exactly how the badge
/// and the queue would start to disagree about 「这一条还欠不欠」("is this one
/// still owed or not").
///
/// ⚠️ It is **also true** for `INJECT_NO_TEXT_TARGET` and
/// `INJECT_DEFERRED_NOT_AUTOINJECTED` (both are members of this same family),
/// so the two named branches in [deliveryFaceOf] must be tested BEFORE this
/// one — that order is a contract, not a coincidence, and it is written down
/// in both places.
bool _isPcInjectionVerdict(TimelineEntry entry) =>
    isPcInjectionVerdictCode(entry.failureReason);

/// Pure map: [DeliveryFace] → (colour, glyph/icon, label). Labels come from
/// [AppStrings] (explicit locale, never OS locale) — V2-07.7 finished the
/// migration [connDotMeta] / [modeBadgeMeta] had already established in this
/// file; the noted face reuses [AppStrings.recordOnly], the ONE translation of
/// the term.
///
/// The glyphs and words are RV-43 §4's three-end table: the PC timeline row and
/// the capsule say the same five things, so a message reads identically wherever
/// the user happens to be looking.
///
/// ⚠️⚠️ Correction (card L7, 2026-08-02). This paragraph originally read: "the
/// desktop capsule's `cap_cached` …… still say the old undifferentiated
/// 未投递/未成功 for the same event —— **because RV-43 §4's whole point was
/// one word across ends**. Closing that gap is desktop-side work this card's
/// scope excludes."
///
/// **That "gap" was not an unfinished fix — the premise itself was wrong**:
/// owner's 2026-08-02 ruling states the two ends are **not talking about the
/// same thing** — the phone can only ever see 「到没到 PC」("did it reach the
/// PC or not") (segment ①), only the PC knows 「有没有注进焦点窗口」("did it
/// get injected into the focused window or not") (segment ②). RV-43 §4's
/// pursuit of "one word across both ends" was exactly the force pushing the
/// capsule into saying 「未投递」("undelivered") (while running on the PC,
/// where that very frame had plainly already arrived). ⇒ **the two ends now
/// deliberately say their own separate half**; 「一个状态一个词」("one status,
/// one word") is guaranteed **within each end, from a shared source** (the
/// desktop's `cap_cached` now references `st_cached`, see
/// apps/desktop/src/lib/strings/capsule.ts). docs/rebuild/15 §2.0/§2.5c.
StatusMeta deliveryFaceMeta(DeliveryFace face, AppStrings strings) {
  switch (face) {
    case DeliveryFace.injected:
      return StatusMeta(FlowMicColors.green, null, '✓', strings.statusInjected);
    case DeliveryFace.queued:
      // window-B3-2b: on disk, never on the wire. Shares the amber with
      // "delivering" (投递中) — both are "still owed, not settled against
      // you" — and is told apart by the two channels the user actually reads:
      // a distinct glyph (📤, a frame waiting to go out) and a distinct word.
      // NOT slate/grey: nothing here is inert, the queue is actively going to
      // deliver it.
      return StatusMeta(FlowMicColors.amber, null, '📤', strings.statusQueued);
    case DeliveryFace.delivering:
      // The row is on its way and no verdict has come back. Amber = in flight,
      // the same amber the PC's ⏳ uses.
      return StatusMeta(
        FlowMicColors.amber,
        null,
        '⏳',
        strings.statusDelivering,
      );
    case DeliveryFace.undelivered:
      // 🔴 Card L7 (owner 2026-08-02) —— THE WORD ON THIS FACE IS NOW
      // 「待投递」("pending delivery").
      //
      // ⚠️ This paragraph originally read: "owner 2026-07-27: 'change all
      // pending-delivery text to undelivered or not-injected' — and RV-43 §1
      // gives 未投递 ('undelivered') its own meaning at last." **That
      // 2026-07-27 ruling's
      // premise has since lapsed**: at the time the phone had no queue at
      // all, so "pending delivery" was a promise nobody honoured; since
      // 0.2.33 there is a persistent send queue ⇒ it became a statement of
      // fact, and owner personally reinstated it on 2026-08-02.
      //
      // A row that reaches this face has a code that **is definitely not a
      // terminal code** (terminal ones were already caught by `_isRefused` in
      // the branch above) ⇒ the queue item goes back to `queued`, and the
      // next drain will send it regardless. It is **still in the queue**, not
      // given up on. The instance owner ran into: another phone occupying
      // this PC (15 册 §2.5d).
      //
      // Distinct glyph AND distinct word from "pending · delivering"; sharing
      // the amber is deliberate (both are 「not settled against you」), the
      // distinction is carried by the two channels the user actually reads.
      return StatusMeta(
        FlowMicColors.amber,
        null,
        '📥',
        strings.statusUndelivered,
      );
    case DeliveryFace.refused:
      // window-B3-2b / RV-67. RED, like ✗ — P-2's rule "red = a fault needing
      // intervention" (红=故障需介入), and a delivery the other end declined
      // by name is exactly that. It is NOT amber: amber says 「还没跟你算账」
      // ("not yet settled with you"), and this one is settled and will not
      // move again.
      //
      // A DIFFERENT GLYPH from ✗ on purpose. Sharing the colour with "failed"
      // (未成功) is right (both are over, both are bad news); sharing the
      // glyph would erase the distinction the whole face exists for —
      // "failed" invites the resend (重发) button next to it, this one is
      // accompanied by no button at all (chat_message_tile).
      return StatusMeta(FlowMicColors.red, null, '⛔', strings.statusRefused);
    case DeliveryFace.failed:
      return StatusMeta(FlowMicColors.red, null, '✗', strings.statusFailed);
    case DeliveryFace.noFocus:
      // 🔴 window-B4-5 / owner 2026-08-01. RED, same family as "failed"
      // (未成功) — this IS a failed-shaped fact (RV-43's own design table
      // names this exact code as the `failed` example), just one owner wants
      // named rather than left as a bare code. NOT amber: nothing here is
      // still owed an answer, the PC already answered.
      //
      // A DIFFERENT glyph from both ✗ and ⛔ for the same reason RV-67 gave ⛔
      // its own glyph: sharing one would erase the one thing this face exists
      // to say — 「焦点」("focus"), not a generic failure. 🚫 reads as 「no
      // place here」 rather than 「something broke」.
      //
      // 🔴 Unlike [failed]/[refused], the raw code is NOT also printed next to
      // this word (chat_message_tile.dart's reason-line condition deliberately
      // excludes `noFocus`): those two words cover MULTIPLE possible codes each
      // and need the code to disambiguate WHICH one; `INJECT_NO_TEXT_TARGET` is
      // the ONLY code this face is for, so the word already says the whole
      // thing the code would — printing both would be the same fact twice.
      return StatusMeta(FlowMicColors.red, null, '🚫', strings.statusNoFocus);
    case DeliveryFace.deferredNotInjected:
      // 🔴 Card L7 × Card L8. **SLATE, not red and not amber**, and the colour is the
      // argument:
      //   · NOT red — nothing malfunctioned and nothing was lost. The frame
      //     reached the PC, the row is on its timeline, the PC deliberately chose
      //     not to type it. Painting that as a fault would be the mirror of the
      //     defect this card fixes (a good outcome reported as a bad one);
      //   · NOT amber — amber means 「还没跟你算账」("not yet settled with
      //     you"), and this IS settled: the queue item is `delivered`
      //     (terminal) and nobody will send it again;
      //   · SLATE is the repo's existing 「settled, inert, not a fault」
      //     colour — the same one `noted` uses, and for the same reason.
      // ⏸ (paused) rather than any of the seven glyphs already in use: the
      // whole point is 「有意为之的暂停」("a deliberate pause"), not a failure
      // and not a wait.
      return StatusMeta(
        FlowMicColors.slate,
        null,
        '⏸',
        strings.statusDeferredNotInjected,
      );
    case DeliveryFace.deliveredNotInjected:
      // 🔴 Card F2. **AMBER, not red and not slate**, and the colour is the argument:
      //   · NOT red — segment ① succeeded, and this is the most common way
      //     that happens (focus was not in an input field). Red = 「故障需介入」
      //     ("a fault needing intervention") (P-2), and there is no fault here;
      //   · NOT slate — slate is the 「有意为之、就这样了」("deliberate, and
      //     that's the end of it") colour [deferredNotInjected] uses. This one
      //     **the user CAN act on**: click into an input field and resend, and
      //     it lands, so it is not inert;
      //   · AMBER = 「还有一步可做，但没跟你算账」("one more step is possible,
      //     but it isn't settled with you yet") — same family of fact as
      //     [noFocus] (the PC answered, it did not get injected, the user can
      //     try again), except [noFocus] has the owner's own exact words and
      //     the owner's personally chosen red, and this card is not touching
      //     that one.
      // The three amber glyphs ⏳/📤/📥 are already taken, all carrying the
      // "still owed" meaning; this one uses ⤓ (landed, but did not go in),
      // visually distinct from all three at a glance.
      return StatusMeta(
        FlowMicColors.amber,
        null,
        '⤓',
        strings.statusDeliveredNotInjected,
      );
    case DeliveryFace.noted:
      return StatusMeta(
        FlowMicColors.slate,
        Icons.inbox_outlined,
        '',
        strings.recordOnly,
      );
  }
}

/// Colour + AppStrings label for the chat-header connection dot (T-5b-mobile).
/// Four visual states; [ConnectionState] has five — connecting|reconnecting
/// share amber. Labels come from [AppStrings] (never OS locale).
class ConnDotMeta {
  final Color color;
  final String label;
  const ConnDotMeta(this.color, this.label);
}

/// Pure map: FSM [ConnectionState] → header-dot colour + copy.
///
/// | ConnectionState | colour | string |
/// |---|---|---|
/// | connected | green | [AppStrings.connConnected] |
/// | connecting / reconnecting | amber | connecting / recLinkDegraded |
/// | error | red | [AppStrings.connError] |
/// | disconnected | slate | [AppStrings.notConnected] |
///
/// RV-60: [albumAway] / [ladderReconnecting] softens a bare disconnected/error
/// into amber reconnecting copy — still not "connected", never a lie.
ConnDotMeta connDotMeta(
  ConnectionState state,
  AppStrings strings, {
  bool albumAway = false,
  bool ladderReconnecting = false,
}) {
  if (state == ConnectionState.connected) {
    return ConnDotMeta(FlowMicColors.green, strings.connConnected);
  }
  if (albumAway) {
    return ConnDotMeta(FlowMicColors.amber, strings.bannerAlbumAway);
  }
  if (state == ConnectionState.connecting ||
      state == ConnectionState.reconnecting ||
      ladderReconnecting) {
    return ConnDotMeta(
      FlowMicColors.amber,
      state == ConnectionState.connecting
          ? strings.connecting
          : strings.recLinkDegraded,
    );
  }
  switch (state) {
    case ConnectionState.error:
      return ConnDotMeta(FlowMicColors.red, strings.connError);
    case ConnectionState.disconnected:
      return ConnDotMeta(FlowMicColors.slate, strings.notConnected);
    case ConnectionState.connected:
    case ConnectionState.connecting:
    case ConnectionState.reconnecting:
      // Exhaustiveness — the early returns above already covered these.
      return ConnDotMeta(FlowMicColors.amber, strings.recLinkDegraded);
  }
}

/// (icon, label, fg, bg) for a history-row mode badge.
///
/// V2-17 replaced the ①②③ numerals with symbols. A numeral only says WHERE a
/// mode sits on the keyboard — the user had to memorise a mapping table to
/// read their own rows. The shape says WHAT the mode did:
///   realtime  → waveform (speech flowed straight through)
///   translate → swap arrows (two languages exchanged)
///   organize  → list (the utterance was structured into text)
/// Three shapes from three shape families (vertical bars / crossing arrows /
/// horizontal lines), so the silhouette alone tells them apart at 18×18.
///
/// The trio is FIXED — three locked modes, never a fourth — and mirrors the
/// desktop ICONS names waveform/swap/list (Icon.vue, also what the capsule
/// will reuse), so one record reads identically on both ends.
class ModeBadgeMeta {
  final IconData icon;

  /// The badge's queryable word (Semantics label + long-press Tooltip). The
  /// 18×18 chip has no room for text, but an unexplained icon is just a new
  /// kind of numeral — the word must be askable.
  ///
  /// Resolved from [AppStrings], never written here: it is user-visible copy,
  /// and three literals baked into a widget mid-way through the
  /// Chinese/English/Japanese/Korean (中/英/日/韩) work would be three strings
  /// the language switch silently cannot reach.
  final String label;
  final Color fg;
  final Color bg;
  const ModeBadgeMeta(this.icon, this.label, this.fg, this.bg);
}

ModeBadgeMeta modeBadgeMeta(FlowMode mode, AppStrings strings) {
  switch (mode) {
    case FlowMode.realtime:
      // Not a const creation: FlowMicColors fields are static final.
      return ModeBadgeMeta(
        Icons.graphic_eq,
        strings.modeLabel(mode),
        FlowMicColors.brand,
        FlowMicColors.brandSoft,
      );
    case FlowMode.translate:
      return ModeBadgeMeta(
        Icons.swap_horiz,
        strings.modeLabel(mode),
        FlowMicColors.teal,
        FlowMicColors.tealSoft,
      );
    case FlowMode.organize:
      return ModeBadgeMeta(
        Icons.format_list_bulleted,
        strings.modeLabel(mode),
        FlowMicColors.amber,
        FlowMicColors.amberSoft,
      );
  }
}

/// The mode badge — colour + symbol encode the entry's mode (was ①②③).
class ModeBadge extends StatelessWidget {
  const ModeBadge(this.mode, {super.key, required this.strings});
  final FlowMode mode;

  /// Required, deliberately — no `AppStrings.of(AppLocale.zh)` fallback. A
  /// friendly default here would render Chinese to an English user and look
  /// like it worked (façade rule ②: a DI default is either the real thing or
  /// it throws).
  final AppStrings strings;

  @override
  Widget build(BuildContext context) {
    final ModeBadgeMeta m = modeBadgeMeta(mode, strings);
    // Two ways to ask "what does this symbol mean": a screen reader gets the
    // Semantics label, a long press raises the Tooltip. excludeFromSemantics
    // on the Tooltip keeps the explicit label the single source in the tree.
    return Semantics(
      label: m.label,
      child: Tooltip(
        message: m.label,
        excludeFromSemantics: true,
        child: Container(
          width: 18,
          height: 18,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: m.bg,
            borderRadius: BorderRadius.circular(6),
          ),
          child: Icon(m.icon, size: 11.5, color: m.fg),
        ),
      ),
    );
  }
}

/// Coloured status dot.
class StatusDot extends StatelessWidget {
  const StatusDot(this.color, {super.key, this.size = 8});
  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
  );
}

/// dot + glyph/icon + label — the delivery pill, one of [DeliveryFace]'s five.
///
/// N2: takes the FACE, not the [EntryStatus]. A pill that took the status could
/// not draw the "delivering" (投递中) / "undelivered" (未投递) distinction at
/// all, and a pill that took the whole row would decide the distinction in
/// two places.
class StatusPill extends StatelessWidget {
  const StatusPill(this.face, {super.key, required this.strings});
  final DeliveryFace face;

  /// Required, deliberately — see [ModeBadge.strings] (façade rule ②: a DI
  /// default is either the real thing or it throws).
  final AppStrings strings;

  @override
  Widget build(BuildContext context) {
    final StatusMeta m = deliveryFaceMeta(face, strings);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        StatusDot(m.color),
        const SizedBox(width: 7),
        if (m.icon != null) ...<Widget>[
          Icon(m.icon, size: 12, color: m.color),
          const SizedBox(width: 3),
        ],
        Text(
          m.glyph.isEmpty ? m.label : '${m.glyph} ${m.label}',
          style: TextStyle(
            color: m.color,
            fontSize: 12,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }
}

/// The ✎ "edited" (已编辑) corner overlay — orthogonal to status (§4.0 D). Neutral chip,
/// deliberately NOT a status colour, so the underlying delivery colour still
/// reads through the row. Label resolved by the caller from AppStrings
/// ([AppStrings.editedMark]) — same contract as [PolishSkippedMark.label].
class EditedMark extends StatelessWidget {
  const EditedMark({super.key, required this.label});
  final String label;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
    decoration: BoxDecoration(
      color: FlowMicColors.surface2,
      border: Border.all(color: FlowMicColors.line),
      borderRadius: BorderRadius.circular(7),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Icon(Icons.edit_outlined, size: 10, color: FlowMicColors.t2),
        const SizedBox(width: 3),
        Text(
          label,
          style: TextStyle(
            color: FlowMicColors.t2,
            fontSize: 9.5,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    ),
  );
}

/// WP-R4-6 ⑦: transient polish-skipped corner mark. Amber (attention, not
/// delivery failure) — orthogonal to the five-state status pill. Label comes
/// from AppStrings (explicit locale), never OS locale.
class PolishSkippedMark extends StatelessWidget {
  const PolishSkippedMark({super.key, required this.label});
  final String label;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
    decoration: BoxDecoration(
      color: FlowMicColors.amberSoft,
      border: Border.all(color: const Color(0x4DFBBF24)),
      borderRadius: BorderRadius.circular(7),
    ),
    child: Text(
      label,
      style: TextStyle(
        color: FlowMicColors.amber,
        fontSize: 9.5,
        fontWeight: FontWeight.w600,
      ),
    ),
  );
}
