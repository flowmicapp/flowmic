// AppStrings copy-catalogue shard: chat page back / return-to-bottom / banner slot.
// The one external entry point is still ../app_strings.dart (AppStrings composes
// this mixin via `with`;
// since 0.2.67 the copy leaves `_lf…` are implemented by the generated classes
// under l10n/, this shard only keeps the logic and the argumentative comments).
part of '../app_strings.dart';

mixin ChatStrings on AppStringsLeaves {

  // ── chat-flow back / stick-to-bottom (T-6b) ─────────────────────────────
  String get discardUnsentConfirm => _lfDiscardUnsentConfirm;
  String get discardUnsentAction => _lfDiscardUnsentAction;
  /// Back during PTT: stop via pttUp (keep path), stay on page — never silent drop.
  String get recordingStoppedKept => _lfRecordingStoppedKept;
  /// Floating affordance when the reversed chat list is scrolled away from
  /// offset 0 (visual bottom). Explicit locale only — never OS locale.
  String get backToBottom =>
      _lfBackToBottom;

  // ── banner slot (R6 T-5 / REDESIGN P-3 single slot + priority queue) ────────────────────
  /// Blocking: the transport is down, the PTT gate is closed. Buffered content
  /// is replayed on the reconnect edge (08 §4) — say so, never just "offline".
  /// owner 2026-07-26 ②: shown when the chat page gives up on a dead link and
  /// returns to the connections list.
  ///
  /// 🔴 Reworded 2026-08-19 with the rule it describes (owner ruling 4): the
  /// page now spends `kLinkRetryBudget` dial attempts before it
  /// leaves, so 「连接断了」 ("the connection dropped") was no longer the reason
  /// the user was moved — 「试了几次都没连上」 ("several tries and none
  /// connected") is. Deliberately WITHOUT the number: the budget is a constant
  /// in one place, and nine translations quoting it would each become a lie the
  /// day it changes (the precedent is the plan-tier copy, where a count in the
  /// copy outlived the count in the code).
  String get sessionLostToast => _lfSessionLostToast;
  String get bannerLinkDown => _lfBannerLinkDown;

  /// Degraded: the reconnect ladder is climbing; capture keeps running.
  String get bannerReconnecting => _lfBannerReconnecting;

  /// RV-60: degraded while THIS phone has the system photo picker open. Still
  /// says the link is down / will recover — never claims it stayed up. Kept
  /// apart from [bannerReconnecting] so the screen (not only the log) can tell
  /// 「the expected drop while picking a picture」 from 「the reconnect after a
  /// real drop」.
  String get bannerAlbumAway => _lfBannerAlbumAway;

  /// The 「N more」affordance on the single slot (P-3: at most one banner on
  /// screen, the rest stay ONE tap away — never dropped).
  String bannerMore(int n) =>
      _lfBannerMore(n);

  /// Title of the expanded all-banners sheet.
  String get bannerAllTitle => _lfBannerAllTitle;

  // ── RETIRED 0.2.27: the two C5 cross-device conflict sentences ─────────────
  //
  // `conflictSupersededByPeer` (「your edit this time was overridden by an
  // update from the other end」) and
  // `conflictDeletedByPeer` (「this one was already deleted on the other end」)
  // lived here. Both said the
  // SERVER's copy of a row had overruled this device, and both were produced by
  // one thing only — the `history:update` ack. owner's architecture ruling
  // (the cloud does not store transcripts)
  // retired that uplink, so there is no second writer of this phone's rows and
  // neither sentence can ever be true again.
  //
  // Deleted in all four languages rather than kept 「in case」: a string that can
  // never render is a façade on the copy face, and it is worse than dead code
  // because a translator will keep maintaining it. The two-facts-two-sentences
  // reasoning they were written for is preserved as design in
  // docs/strategy/2026-07-30-c5-conflict-criteria-design.md, which is where the
  // lightweight-record multi-device case will pick it up again.

  // ── mode names (V2-17) ────────────────────────────────────────────────────
  /// The three locked modes, by name.
  ///
  /// Added when the history row's ①②③ numerals became symbols: a symbol needs a
  /// word behind it (Semantics label + long-press Tooltip), and that word is
  /// user-visible copy, so it belongs here rather than as a literal inside the
  /// badge widget. Writing it in the widget would have quietly added three new
  /// untranslatable strings in the middle of the Chinese/English/Japanese/Korean i18n work.
  ///
  /// The set is FIXED at three — three locked modes, never a fourth.
  String modeLabel(FlowMode mode) {
    switch (mode) {
      case FlowMode.realtime:
        return _lfModeLabel__1;
      case FlowMode.translate:
        return _lfModeLabel__2;
      case FlowMode.organize:
        return _lfModeLabel__3;
    }
  }

  // ── M4: the mode-switch-clears-buffer confirmation — RETIRED along with its
  // one and only producer ────────────────────────────────────────────
  // `modeSwitchConfirmTitle` / `…Body` / `…Action`, three strings, used to live
  // here, serving the confirmation popup that appeared on a mode-chip tap.
  // FB-3 Plan A (owner D1, 2026-08-06) removed that popup
  // (a direct three-way choice needs no confirmation), so these three sentences
  // now have **zero producers**.
  //
  // By this repo's precedent they go wherever their producer goes (the
  // 0.2.27 `CLOUD_SESSION_NO_HISTORY` precedent:
  // 「a user-visible string with no producer must go wherever its producer
  // goes, it must not be kept around for someone to repurpose it for another
  // question someday」).
  //
  // 🔴 The thing they protected has **NOT** gone away along with them: switching
  // modes still clears the buffer (08 §2 red line),
  // only the protection's SHAPE changed from 「an after-the-fact popup」 to 「a
  // standing hint shown beforehand」 —
  // `AppStrings.composeModeSwitchClearsHint` (compose_strings.dart), rendered in
  // `_modeSwitchHint` (ui/compose_buffer_row.dart).

  // ── the destination term 「record only」 (V2-07.7) ──────────────────────────────────────────
  /// THE record-only term — the ONE place this word is translated. Six
  /// surfaces build on it (header badge, delivery status pill, PTT bar, cloud
  /// row, enter-cloud button, noted-sync settings rows), so the four-language
  /// pass translates it once instead of six times with six chances to drift.
  /// The consumers living in EARLIER mixins (settings / cloud / connection /
  /// recording) declare it abstract; the concrete impl sits here, later in the
  /// `with` order — same pattern as [PairingStrings.pairError].
  String get recordOnly => _lfRecordOnly;

  // ── the delivery-status row badge (N2 / RV-43 §4: deliveryFaceMeta's eight faces) ────────────────
  //
  // 🔴 Card L7 / owner 2026-08-02 — two segments of terminology (docs/rebuild/15 §2.0):
  //   ① phone → PC     = **delivery** (delivered / pending delivery / undelivered)
  //     ← **the phone's row only speaks to THIS segment**
  //   ② PC → focus window = **injection** (injected successfully / not
  //     injected · cached / injection failed)
  // owner verbatim: 「the phone-side history shows: delivered/pending
  // delivery/undelivered, **do not show "injected", because that state is
  // inherently open-ended**, the PC's name must be shown.」
  //
  // ⚠️ This section used to read 「the desktop (N3) says the same four — so
  // changing one here
  // without the other end re-opens the bug」. **That discipline of "both ends
  // say the same set of words" has been
  // overturned by owner on 2026-08-02, the original text is kept as a
  // correction record**: what the two ends say are **NOT the same thing**——
  // all the phone can see is 「did it reach the PC or not」, only the PC knows
  // 「was it injected into the focus window or not」. The result of sharing one
  // word table
  // was the capsule describing a frame that had **already reached the PC** as
  // 「undelivered」 (owner hit this on a real device).
  // Now the two ends **deliberately each speak to their own segment**, and what
  // RV-43 §4 is really guarding against (three different accounts of the same
  // event)
  // is guaranteed by 「each end has one single source internally」 (desktop side:
  // see lib/strings/capsule.ts → timeline.ts).
  //
  // 🔴 Why the six faces use the compound form 「tri-state word · original
  // word」 rather than collapsing into three words:
  // each face is a distinction that has already been paid for in tuition
  // (queued/delivering = Window B3-2b; delivery refused/unsuccessful = RV-67's
  // red line). Collapsing to three words would merge them back together ⇒
  // fixing one defect by recreating two old ones.
  // The compound form makes **the tri-state word the leading word** (the
  // classification owner wants, readable at a glance), **the old distinction
  // stays in the second half**.
  // The sentence pattern is the same as the desktop's existing 「not injected ·
  // cached」, not something invented this round.

  /// ✓ Segment ① succeeded: this frame **reached the PC** (`inject:result`'s
  /// `ok:true`).
  ///
  /// 🔴 Card L7 — the old word was 「injected」, owner ordered it changed on
  /// 2026-08-02, the reason being **that state is inherently
  /// open-ended**: `docs/decisions/2026-07-30-injected-means-delivered-to-
  /// keyboard-focus.md` already drew the line — the platform does not allow
  /// cross-process proof that the target app accepted those keystrokes.
  /// The new word **claims less, not more** — `ok:true` implies 「the frame
  /// reached the PC」, so it is always true.
  /// The truth of the injection lives on the **PC's timeline** (only that end
  /// can say it, and only that end does).
  String get statusInjected =>
      _lfStatusInjected;

  /// ⏳ The row's own delivery is still in flight: it was handed to the link and
  /// no verdict has come back. **Not** interchangeable with
  /// [statusUndelivered] — that is the whole point of N2. 「delivering」 rather than
  /// the old 「not injected」 because a row that may still land must not already be
  /// described as one that did not.
  ///
  /// ⚠️ Card L7 — the 「old "not injected"」 in the previous sentence was the
  /// **0.1.x rectification** (there was no queue at all back then,
  /// 「pending delivery」 was a promise nobody kept). **The premise has since
  /// changed**: from 0.2.33 the phone has a persistent send queue
  /// (four send sites flush to disk before sending, a dropped connection
  /// backfills on reconnect), and owner therefore brought back 「pending
  /// delivery」 on 2026-08-02. The **spirit** of the red line (must not promise
  /// something with no mechanism to make good on it) has not changed a bit;
  /// what changed is only that
  /// **specific wording mapping**. **Do not change the word back based on the
  /// previous sentence** — that would be using an expired premise as grounds.
  ///
  /// Card L7: the leading word changed to 「pending delivery」 from the tri-state
  /// set, the second half kept 「delivering」 — the distinction between the two
  /// is one Window B3-2b spent a whole defect to pull apart, must not be
  /// merged back.
  String get statusDelivering => _lfStatusDelivering;

  /// 📥 A verdict came back saying **this attempt** did not land — but **the
  /// queue still owes this delivery and will try again**.
  ///
  /// 🔴 Card L7 — **the single most central word-change this round, and the
  /// exact spot owner personally called out on 2026-08-02.**
  /// The old word was 「undelivered」. Per Book 15 §2.0.1's tri-state mapping,
  /// 「undelivered」 is a **terminal failure**
  /// (queue gave up / a named refusal / overflow), whereas **a row that can
  /// reach this face is guaranteed to NOT carry a terminal code**
  /// — a terminal code is already caught by the branch above
  /// (`_isRefused`) in `deliveryFaceOf` ⇒
  /// the queue item goes back to `queued`, and the next drain will send it
  /// again as usual. **It is 「still in the queue」, not 「given up」.**
  ///
  /// 🔴 These two things have **different** implications for what the user
  /// should do: pending delivery ⇒ **wait**; undelivered ⇒ **resend / check the
  /// network**.
  /// The instance owner hit: another phone occupying this PC (`PC_BUSY` /
  /// `INJECT_NOT_IN_ROOM`,
  /// neither is a terminal code) ⇒ the interface said 「undelivered」, while the
  /// queue was actually just waiting for the other phone to leave (Book 15 §2.5d).
  ///
  /// The resend button is still offered: the queue will send on its own, this
  /// button is just 「send it right now」, not the only way out.
  String get statusUndelivered => _lfStatusUndelivered;

  /// ✗ We know it did not succeed. RV-43 §1 narrowed this state to 「the
  /// precondition did not hold,
  /// or the action itself failed」, so the copy drops the word 「injection」: the
  /// commonest case now
  /// is a refusal in which not one key was ever sent, and calling that
  /// 「injection failed」 would describe an attempt that never happened. The CJK
  /// trio is
  /// the deliberate literal 未成功/미성공 (unsuccessful) for the same reason —
  /// 失败/失敗/실패 (failed)
  /// carries the same 「it was tried」 implication the zh copy just shed.
  ///
  /// Card L7: the leading word changed to 「undelivered」 from the tri-state
  /// set, the second half kept 「unsuccessful」 (`失败/失敗/실패`(failed) is still
  /// banned,
  /// reason as above).
  String get statusFailed => _lfStatusFailed;

  /// 📤 Window B3-2b — THE DELIVERY IS ON DISK AND HAS NEVER BEEN ON THE WIRE.
  ///
  /// Split out of [statusDelivering], which it used to be rendered as. That was
  /// the same class of untruth 「pending delivery」 → 「not injected」 already
  /// cost owner once: a
  /// row whose frame never left the handset was telling the user it was on its
  /// way. The two are not shades of one word — 「delivering」 means the PC has been
  /// handed it and owes an answer; this one means nobody has been handed
  /// anything and the queue will try again by itself.
  ///
  /// ⚠️ Card L7 — the 0.1.x rectification cited in the previous paragraph
  /// (「pending delivery」 → 「not injected」) **had its premise already
  /// expire**, see the matching note on [statusDelivering]: there was no queue
  /// back then, there is one now, and owner
  /// brought back 「pending delivery」 on 2026-08-02. **This face's own argument
  /// still holds** (「in the queue」 and
  /// 「on the way」 are two different things, must not be merged), only its
  /// wording is now 「pending delivery · queued」.
  ///
  /// ⚠️ NEVER 「sent」 (outbox_item.dart:17-20 states the ban; docs/rebuild/15
  /// §2.5 records that this string is what makes it non-vacuous). No resend
  /// affordance accompanies it either — there is nothing for the user to fix,
  /// and offering a button for work already scheduled is R8's shape.
  ///
  /// Card L7: the leading word changed to 「pending delivery」 from the
  /// tri-state set, the second half kept 「queued」 — the distinction between the
  /// two is exactly the reason this face
  /// exists (see above), merging them back would recreate this exact defect.
  String get statusQueued => _lfStatusQueued;

  /// ⛔ Window B3-2b / RV-67 — A TERMINAL REFUSAL. It will NOT be retried.
  ///
  /// The word exists because a red-line accident and a benign retry were
  /// reaching the user as the SAME face: the server answers a crosstalk refusal
  /// with `mode:'cached'` (relay.handler.ts `answerReject`), which the phone
  /// reads as 「undelivered, kept for later redelivery」 — 📥 plus a resend button
  /// that could only ever
  /// be refused again. Two different events must not read as one, and 「can be
  /// redelivered later」
  /// must not be said about something that can never be delivered.
  ///
  /// 「refused」 rather than 「failed」 on purpose: nothing malfunctioned. The other end
  /// looked at this delivery and declined it, by name — and the name is shown
  /// beside this word (chat_message_tile), because that is the part the user
  /// (or a log) can act on.
  ///
  /// Card L7: the leading word changed to 「undelivered」 from the tri-state set
  /// (**it IS a terminal failure**, Book 15 §2.0.1), the second half kept
  /// 「delivery refused」 — RV-67 requires 「a red-line incident」 and 「a benign
  /// retry」 to look distinguishable, and in the new word table that
  /// distinction is now firmer: a benign retry now says **pending delivery**,
  /// this one says **undelivered**.
  String get statusRefused => _lfStatusRefused;

  /// 🚫 Window B4-5 / owner's 2026-08-01 ruling, verbatim: 「delivery refers to
  /// phone-to-PC, injection is
  /// PC-to-focus-window; the former shows undelivered, the latter notes no
  /// focus / not injected」.
  ///
  /// zh IS owner's own phrase, verbatim — not a paraphrase. It answers a
  /// DIFFERENT question from [statusUndelivered]: that one says 「the
  /// phone→PC segment
  /// did not go through」 (still owed, can be re-sent once the link is back);
  /// this one says
  /// 「the PC→focus-window segment was tried, there was nowhere to type」
  /// (`INJECT_NO_TEXT_TARGET`,
  /// `target_probe.rs refusal_for` — the ONLY producer of this code) — a PC that
  /// is very much online and reachable, whose OWN act of typing had nowhere to
  /// land. Folding the two into one word is exactly the 「one value answering
  /// two questions」 shape
  /// CLAUDE.md names as this repo's #1 bug.
  ///
  /// ⚠️ Does NOT claim to know whether the injection attempt itself could ever
  /// have been proven to land — `docs/decisions/2026-07-30-injected-means-
  /// delivered-to-keyboard-focus.md` is why `injected` only ever claims 「reached
  /// the keyboard focus and the focus is capable of taking input」, never a
  /// target-side receipt. This word claims
  /// strictly less than that: only that the PC's OWN precondition check
  /// (whether there is a focus) came back negative, which is the one thing this
  /// platform lets the
  /// PC know before typing. Nothing here is a promise that the injection WOULD
  /// have landed had a field been focused — 「uncertainty」 owner names in the
  /// same
  /// ruling is real, and this word does not paper over it.
  ///
  /// 🔴 Card L7 — **the first half 「delivered」 was added, the second half is
  /// owner's 2026-08-01 verbatim original words, not one word
  /// changed**. Two owner rulings meet at this face (Book 15 §2.5 row 4):
  ///   · 08-01: 「the latter notes **no focus / not injected**」 ⇒ this sentence
  ///     must be present;
  ///   · 08-02: 「the phone-side history shows: delivered/pending
  ///     delivery/undelivered」 ⇒ which state this row belongs to must be made clear.
  /// This face's delivery state is **delivered**, and it is **the hardest kind
  /// of evidence there is**: this code is answered by the PC's own mouth
  /// (`target_probe.rs refusal_for`, Stage 1b), **the answer itself IS 「I
  /// received it」**.
  /// Filing it under 「undelivered」 is exactly the shape owner complained about
  /// on 2026-08-02.
  String get statusNoFocus => _lfStatusNoFocus;

  /// ⏸ 🔴 Card L7 × Card L8 (owner 2026-08-02) — **this row is an automatic
  /// backfill delivery, the PC deliberately did NOT inject it**
  /// (`INJECT_DEFERRED_NOT_AUTOINJECTED`; owner's own words 「a message backfilled
  /// to the PC, the PC side must not
  /// just inject it casually ... injection is a behaviour the user expects and
  /// anticipates」).
  ///
  /// The leading word is 「delivered」, and this face's evidence is the
  /// hardest there is: **answered by the PC's own mouth** — it read this frame,
  /// minted the row, then **chose** not to type.
  ///
  /// 🔴 **Why it cannot reuse [statusUndelivered] (「pending delivery」)**: this
  /// code settles the queue item
  /// to `delivered` (terminal) ⇒ **nothing will ever redeliver it**. Saying
  /// 「pending delivery」 would be
  /// CLAUDE.md's red line by its literal wording — **promising a wait that no
  /// mechanism makes good on**.
  ///
  /// 🔴 **Nor can it reuse [statusNoFocus]**: the two have **opposite** user
  /// actions. No focus ⇒ tap into the input field
  /// then resend and it lands; this one ⇒ nothing done to the window helps, the
  /// user must go to **the PC's timeline** and tap 「re-inject」.
  ///
  /// ⚠️ **This sentence carries no imperative and must never contain the words
  /// "failed" / "not delivered"**: the delivery succeeded. The wording matches
  /// `ERROR_CODES.INJECT_DEFERRED_NOT_AUTOINJECTED`'s own register (Card L8
  /// already pins this family-wide constraint in
  /// `packages/protocol/test/inject-origin.test.ts`).
  String get statusDeferredNotInjected => _lfStatusDeferredNotInjected;

  /// ⤓ 🔴 Card F2 (owner's iron rule, 2026-08-02, 「a transcribed message's
  /// status must always be right」) — **the PC received it and
  /// answered the injection segment with its own mouth, and the answer is 「it
  /// did not get injected」** (`INJECT_FOCUS_LOST` / `INJECT_CLIPBOARD_FAIL`
  /// / `INJECT_IMAGE_UNSUPPORTED` / `INJECT_TARGET_INVALID` / `INJECT_SENDINPUT_FAIL`).
  ///
  /// The leading word is 「delivered」, and the criterion is Book 15 §2.0.1's
  /// first row, **the one line that is written in stone**: as long as
  /// `ok:false` is
  /// **an answer the PC itself gave**, it proves segment ① succeeded — the PC
  /// minted a row for it, that message is right now on the user's
  /// computer screen.
  ///
  /// 🔴 **Why it cannot reuse [statusUndelivered] (「pending delivery」)**: this
  /// card settles this whole family of verdicts on the queue
  /// side to `delivered` (terminal) ⇒ **nothing will ever redeliver it**. Saying
  /// 「pending delivery」 would be
  /// CLAUDE.md's red line by its literal wording — **promising a wait that no
  /// mechanism makes good on**. What owner hit on a real device is exactly
  /// this face (speaking while the focus was on FlowMic's own window, the PC
  /// minted the row, the phone said 「pending delivery」 and never converged).
  ///
  /// 🔴 **Nor can it reuse [statusFailed] (「undelivered · unsuccessful」)**:
  /// that sentence's leading word is **undelivered**,
  /// while this frame plainly reached the PC — the same wrong direction, just
  /// half the sentence flipped.
  ///
  /// ⚠️ Together with [statusNoFocus] / [statusDeferredNotInjected] this is
  /// **the rest of the same family**: those two faces each serve exactly one
  /// code and have said all there is to say; this face covers multiple codes,
  /// so the row will **as usual print the named code**
  /// (`chat_message_tile.dart` `_reasonLineFor`, same argument as ✗/⛔).
  ///
  /// ⚠️ The second half uses 「not injected」 rather than 「injection failed」:
  /// this family contains both real failures (a clipboard error) and
  /// **cases where it was never attempted at all** (no usable focus), one word
  /// covering both can only say less.
  String get statusDeliveredNotInjected => _lfStatusDeliveredNotInjected;

  // ── the queue's observable surface (Window B3-2b) ──────────────────────────────────────────────

  /// 「N still pending delivery」 — owner's NON-BLOCKING observability.
  ///
  /// owner ruled the queue adds no interception step (「no matter how long it
  /// takes, everything must be delivered」) but the interface must let the user
  /// SEE how many are still owed. So
  /// this is an `info` banner that gates nothing and disappears on its own when
  /// the count reaches zero.
  ///
  /// 🔴 Card L7 — **only the word changed, the count did not** (Book 15
  /// §2.0.1). This sentence used to say 「N
  /// **undelivered**」, and what it has always counted is
  /// `DeliveryOutbox.pendingCountFor` ⇒
  /// `OutboxStore.loadPending()` ⇒ **queued + inflight**, i.e. those that are
  /// **「still in the queue」**.
  /// `delivery_outbox.dart`'s own comment already said 「would sit in the queue
  /// **being
  /// counted as "undelivered"**」 — **the comment described the actual fact
  /// correctly, the count was always right, the word was always what was wrong.**
  ///
  /// 🔴 The second clause is doing real work and must not be trimmed to save
  /// width: it states the promise the queue actually makes — and only that one
  /// (「once the connection is restored」, not 「right away」).
  String outboxPendingNotice(int count) => _lfOutboxPendingNotice(count);

  /// 🔴 fix-001 / owner 2026-08-11 — **the capsule only ever allows one phone,
  /// a second one is sent back to the connection list**
  /// (docs/rebuild/15 §2.5d, that section has been retired and the replacement
  /// rule is written in its place).
  ///
  /// owner's own words: 「when the capsule window appears, there **must be
  /// exactly one phone connected**, this was already a
  /// settled rule before, this is not allowed to happen again ... **it must be
  /// treated as an iron rule, a life-or-death line**.」
  ///
  /// 🔴 **This sentence REPLACES `pcBusyNotice` (deleted)**. That one was the
  /// user-facing half of owner's 2026-08-02 ruling,
  /// 「you can only record for now, and it will be delivered once that phone
  /// exits」, paired with a **standing banner**, with the phone **staying on the
  /// transcription page**. The 08-11 ruling overturned that whole shape: a
  /// second phone **is not allowed to be present at all**.
  /// ⇒ The banner has nowhere to stand (the very screen it lived on is being
  /// exited), so it is **deleted**, not kept —
  /// a banner that can never be drawn but is left in the code is a façade.
  ///
  /// 🔴 **R11: this sentence must be able to answer 「on what grounds does it
  /// say so」.** The criterion is the server's **named** answer `PC_BUSY`
  /// (the `mobile:reconnect` ack, `mobile.handler.ts`), **never** inferred
  /// backward from a delivery failure —
  /// `INJECT_NOT_IN_ROOM` has half a dozen other causes, using it as the
  /// criterion would also say 「another one is occupying it」 during a plain
  /// disconnect.
  ///
  /// 🔴 **「this computer」 rather than 「this channel」**: the occupancy gate is
  /// an `Admission` inside the desktop process
  /// (`socket/admission.rs`: *a second phone **on EITHER channel** is REFUSED*),
  /// the server has no structural way to make this determination (the two
  /// channels are two servers that cannot see each other) ⇒ occupancy is **per
  /// machine**,
  /// two phones going through two different channels to the same PC also counts
  /// as occupied. This sentence is therefore true.
  ///
  /// ⚠️ **Carries no imperative, does not rush the user into doing something
  /// they cannot do**: when that phone will exit is not decided by this one,
  /// so the sentence only states **what happened** and **where things stand
  /// now** (precedent = [sessionLostToast]).
  /// ⚠️ **A bare error code must never appear** (the 0.2.53 shape: `INJ…` was
  /// truncated to three letters).
  String get capsuleTakenNotice => _lfCapsuleTakenNotice;

  /// owner 2026-08-20 —「PC端主动断开了连接，请60秒后重新尝试连接」— the eject
  /// toast for a PC-initiated disconnect (`mobile:released`, revoked=false).
  /// [secs] is the SERVER's clamped budget read back from the cooldown, never a
  /// literal 60: an older relay's missing budget falls back to the ceiling
  /// inside [PcReleaseCooldown], so this sentence and the button it describes
  /// cannot disagree. Same statement-plus-returned-to-list shape as
  /// [capsuleTakenNotice]; carries no imperative beyond the one action that
  /// actually works (waiting).
  String pcReleasedNotice(int secs) => _lfPcReleasedNotice(secs);

  /// The eject toast for a LIVE revoke (`mobile:released`, revoked=true) —
  /// deliberately the SAME leaf the connect-refusal path renders for a dead
  /// token (`pairError__8`,「电脑上已取消这台手机的配对，请重新配对连接」).
  /// One fact, one sentence, on whichever path it surfaces — the byte-identical
  /// precedent is pairing_strings.dart's PAIR_RELEASED note. No countdown in
  /// it, because there is nothing to count down to: the row's token is gone and
  /// only a fresh scan brings it back.
  String get pcReleasedRevokedNotice => _lfPairError__8;

  /// The sentence for a terminal the QUEUE ITSELF decided.
  ///
  /// Exhaustive over [OutboxTerminal] on purpose (see its own doc): a third
  /// queue terminal cannot be added without this switch failing to compile,
  /// which is what stops one from shipping with no words for the user — a
  /// delivery that stops for good in silence is a silent failure wearing a code.
  ///
  /// The codes stay OUT of the protocol `ERROR_CODES` table; the reasoning is in
  /// outbox_failure_text.dart. The ban is on the table, not on the courtesy.
  String outboxTerminalMessage(OutboxTerminal terminal) => switch (terminal) {
    // Stage ③ of the two-tier picture model (owner 2026-07-31 ①: 「stop looking
    // for the original, just manage whatever copy is still around」).
    // Says the two things the user can act on: it will NOT retry, and the reason
    // is the picture itself, not the connection — so waiting will not help and
    // re-picking it will. No 「resend」 affordance may accompany this string; a
    // button that cannot do anything is worse than no button.
    OutboxTerminal.imageBytesGone => _lfOutboxTerminalMessage__1,
    // Overflow. 「discarded」 rather than 「send failed」: nothing was attempted
    // and failed,
    // the item was dropped to keep the queue inside its bound, and those are
    // different facts about what happened to the user's words.
    OutboxTerminal.overflow => _lfOutboxTerminalMessage__2,
  };

  /// The orthogonal ✎ corner overlay (§4.0 D) — NOT a fifth status colour.
  String get editedMark => _lfEditedMark;

  // ── the live draft row (LiveDraftTile) ─────────────────────────────────────────────
  String get liveNow => _lfLiveNow;
  String get liveTranscribing =>
      _lfLiveTranscribing;

  // ── per-entry duration + word count (§4b-8 / data-asset-lifecycle-design.md) ────────────────
  /// The word-count NUMBER comes from `entry_metrics.dart` `textWordCount`
  /// (the one implementation, per that file's header) — this string only
  /// wraps it for display, one language at a time. Duration is NOT
  /// interpolated here: `entry_metrics.dart` `formatEntryDuration` returns an
  /// already-numeric, locale-free label (same posture as time_label.dart), so
  /// there is nothing for this catalogue to translate about it.
  String entryWordCountLabel(int n) =>
      _lfEntryWordCountLabel(n);

  /// The original-text source line under a transformed row. The colon lives INSIDE the
  /// pattern (zh fullwidth, en halfwidth) so no caller hardcodes punctuation.
  String sourceLine(String source) =>
      _lfSourceLine(source);

  // ── entry long-press menu (entry_context_menu) ─────────────────────────────────────
  /// Deferred redelivery is offered only for PC-bound, non-image entries (the menu widget owns
  /// that gate; an image's stored text is a descriptor, not deliverable text).
  String get entryReInject => _lfEntryReInject;
  String get entryReInjectSub => _lfEntryReInjectSub;
  String get entryReprocess => _lfEntryReprocess;
  String get entryReprocessSub => _lfEntryReprocessSub;
  String get entryEdit => _lfEntryEdit;
  String get entryCopy => _lfEntryCopy;

  /// An image row copies the PICTURE — and says WHICH picture: only the
  /// bounded preview survives on this phone (see [ImageStrings.imagePreviewNote]).
  String get entryCopyPreview =>
      _lfEntryCopyPreview;

  /// WP3 C15 (owner 2026-08-17): 「copy the original text」 behind a
  /// translated/organized row. Offered only when the row has a source that
  /// differs from what is displayed (`TimelineEntry.showsSourceLine` — the
  /// row-local truth, NOT the session's current mode; the menu widget owns
  /// that gate and its reasoning). The sub-line says WHICH string the user
  /// will get, because right above it sits plain copy — two copy items with
  /// no distinction would force a guess.
  String get entryCopyOriginal => _lfEntryCopyOriginal;
  String get entryCopyOriginalSub => _lfEntryCopyOriginalSub;

  // ── the edit page (edit_entry_page) ────────────────────────────────────────────────
  String get editEntryTitle => _lfEditEntryTitle;

  /// The note quotes [editedMark] by interpolation so the mark and the
  /// sentence that explains it can never drift into two different words.
  String get editEntryNote => _lfEditEntryNote(editedMark);
  String get saveAndReInject =>
      _lfSaveAndReInject;

  // ⚠️ `injectVerdictNote` / `deliveryRefusalNote` LIVED HERE and were moved
  // VERBATIM to `inject_note_strings.dart` (file-size split, zero behaviour
  // change — this file had reached 848 lines against the 800 cap). Noted here
  // rather than moved silently: both are reached through `AppStrings`, so no
  // call site changed and nothing would otherwise tell the next reader where
  // 324 lines of per-code copy went. That file's header states why those two
  // tables are one family and why they must stay two functions.
}
