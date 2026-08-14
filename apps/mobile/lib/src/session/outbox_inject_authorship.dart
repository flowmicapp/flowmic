// SPEC-REF:
//   packages/protocol/src/inject-verdict-authorship.ts  ← **the single source
//     of truth; this file is its mirror**
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0.1 / §2.6
//   docs/decisions/2026-08-02-delivery-vs-injection-terminology-contract.md
//   CLAUDE.md red line: one value answers only one question / no silent
//     failure (banned both directions)
//
// ── card F2 (owner's iron rule 「the transcribed message's status must
//    always be correct」) ─────────────────────────────────────────────────
//
// Book 15 §2.0.1's very first line already stated the rule correctly:
//   「**DELIVERED** ← received the receipt for the PC-side **DELIVERY**
//     segment (not the injection receipt). `ok:true` is its strongest form;
//     **`ok:false` but ANSWERED BY THE PC ITSELF** (e.g.
//     `INJECT_NO_TEXT_TARGET`) equally proves the **delivery segment
//     succeeded**.」
// **The code never once implemented that line.** `outboxSettle` only
// receives `ok + code`, so 「the PC's own answer of 'received it, didn't
// inject it'」 falls into the retryable else ⇒ the item goes back to
// `queued` ⇒ the row shows 「pending delivery」, while that message **is,
// at this very moment, on the PC's timeline**. This file is that rule's
// predicate form.
//
// 🔴 **WHY THE CRITERION IS 'THE CODE' AND NOT `inject:result.mode`**
// (disproven by measurement once already; written down so nobody re-does it):
//   `mode` answers 「which delivery path was used」, not authorship, and
//   **it cannot decide it in EITHER direction**——
//     · a refusal answered ON BEHALF OF the server ALSO carries
//       `mode:'cached'` (`relay.handler.ts`'s `answerReject` and that
//       `INJECT_NOT_IN_ROOM` `socket.emit('inject:result', …)`), identical
//       to the PC's own `INJECT_FOCUS_LOST` (`inject/pipeline.rs`
//       `stage1_focus` / `error_codes::INJECT_FOCUS_LOST`);
//     · the PC's ADMISSION refusal carries `mode:'sendinput'`
//       (`socket/client.rs`'s `build_inject_result(false, "sendinput",
//       Some(error_codes::INJECT_NOT_PRIMARY), …)`), identical to
//       `INJECT_NO_TEXT_TARGET`, and the two have OPPOSITE authorship.
//   ⇒ Judging authorship off `mode` is this repo's #1 bug shape (one value
//   answering two questions). **`mode` is therefore deliberately NOT
//   threaded into `settle`**: a parameter that gets in but can't answer this
//   question only invites the next person to make it answer anyway.
//
// 🔴 **WHY THE PHONE'S COPY IS A 'MIRROR' AND NOT A SECOND LIST**: across
//   languages there is no shared symbol, so the constraint is enforced BY A
//   MACHINE — `apps/mobile/test/inject_verdict_authorship_mirror_test.dart`
//   **reads that TS source file** and checks this file against it verbatim.
//   Same technique as `desktop_error_codes_are_a_subset_of_the_protocol_ssot`
//   in `apps/desktop/src-tauri/src/error_codes.rs` (an existing precedent in
//   this repo). ⚠️ To add a code, **change the TS one first**, then this one
//   — otherwise the mirror test goes red on the spot.

// Only for [transientVerdictEarnsAnotherAttempt]'s `nextOrigin` argument. The
// judgement 「whether this frame counts as live」 itself is NOT re-implemented here — it stays in
// `outbox_inject_origin.dart`, which states 「ONE FUNCTION, N CALL SITES — not N
// judgements」 as its own reason for existing. This file only consumes its answer.
import '../signaling/wire_payloads.dart' show InjectOrigin;

/// 🔴 **A VERDICT THE PC ITSELF REACHED BY RUNNING THE INJECTION SEGMENT**
/// (success / cached / injection-failed all count).
///
/// Receiving ANY of these ⇒ **segment ① (phone → PC delivery) has already
/// completed, and succeeded**: this frame reached that machine, and the PC
/// minted its row for it (`socket/client.rs`'s
/// `row_transit::mint_row(…, run_inject(…))` — the row and the receipt are
/// produced by the same expression). The queue **must not** deliver it
/// again.
///
/// ⚠️ **`INJECT_NOT_PRIMARY` is deliberately NOT here**: it is likewise
/// spoken by the PC itself, but it speaks at the **ADMISSION layer**
/// (`client.rs`'s `build_inject_result(false, "sendinput",
/// Some(error_codes::INJECT_NOT_PRIMARY), …)`, `gate.open()` is false, it
/// never entered `run_inject`). owner's 2026-08-02 ruling for when it is
/// occupied says 「can only record it and wait for it to free up」 ⇒ row =
/// pending delivery, the queue **still owes it**. Folding it in here would
/// be one set answering two questions.
const Set<String> kPcInjectionVerdictCodes = <String>{
  'INJECT_TARGET_INVALID',
  'INJECT_NO_TEXT_TARGET',
  'INJECT_SENDINPUT_FAIL',
  'INJECT_CLIPBOARD_FAIL',
  'INJECT_IMAGE_UNSUPPORTED',
  'INJECT_FOCUS_LOST',
  // 📌 L8 already carved out a special case for it (「settle as
  // delivered」, delivery_outbox_settle.dart), and its reasoning is, word
  // for word, this set's own rule. What this card does is turn that special
  // case into a decidable rule.
  'INJECT_DEFERRED_NOT_AUTOINJECTED',
  // 🔴 2026-08-02 F1a (the other half of owner's ruling 「FlowMic's own
  // input box must be injectable」): the foreground is FlowMic's own window,
  // but no input box is focused. **This is the least questionable entry in
  // the whole table** — the verdict was reached by the PC **inside its own
  // process**, and the frame plainly reached this machine.
  // ⚠️ It is the first addition to this file caught by the **mirror guard**:
  // another lane changed the protocol-side table first, and
  // `test/inject_verdict_authorship_mirror_test.dart` went red on the spot,
  // which is how this line came to exist.
  'INJECT_SELF_WINDOW_NO_INPUT',
  // 🔴 2026-08-07 MAC-05 (owner approved error codes 63/64): on macOS the
  // system **silently swallows** synthesized keystrokes in two situations —
  // Secure Input is active (63), Accessibility permission was not granted
  // (64). Both are emitted from the same function
  // (`inject/preflight.rs` `synthetic_input_verdict`), called by
  // `inject/pipeline.rs`'s `synthetic_input_preflight()` on **both the text
  // and image paths** ⇒ both happen after admission, inside the PC's own
  // process, `mode:'cached'`, and the PC has already minted its row for it.
  // **The delivery segment succeeded.**
  //
  // 🔴 **What would happen if they were NOT here is this card's entire
  // reason for existing**: this is a **closed set**, an unrecognised code
  // falls into `outboxSettle`'s retryable `else` ⇒ the item goes back to
  // `queued` ⇒ the row **shows 'pending delivery' forever**, the banner
  // counts it forever, while the message is, at this very moment, on the
  // user's PC. That is a word-for-word replay of the 0.2.48 P0.
  //
  // ⚠️ **owner also ruled on something this file does not implement**: 63 is
  // transient (retryable), 64 is standing (terminal). That distinction does
  // not belong here, because this set answers 「did the delivery segment
  // complete」, and for both codes the answer is **the same**. See the long
  // note on `INJECT_NO_ACCESSIBILITY` on the protocol side for the details:
  // that half **is a matter of stopping and reporting, not of being done**.
  //
  // ✅ Correction (card fix-018): that half is landed now — see
  // [kTransientInjectionVerdictCodes] below. It did NOT move either code out of
  // this set, and it must not: segment ① finished for both, which is what THIS set
  // answers. The ruling is a SECOND dimension, declared separately.
  'INJECT_SECURE_INPUT_ACTIVE',
  'INJECT_NO_ACCESSIBILITY',
};

// ── SECOND DIMENSION — 「will the cause of this refusal clear by itself?」 ────
//
// 🔴 A DIFFERENT QUESTION FROM THE SET ABOVE, AND KEEPING THEM APART IS THE
// WHOLE DESIGN. [kPcInjectionVerdictCodes] answers 「did segment ① (phone →
// PC) complete」, and for 63 and 64 that answer is the SAME (yes, both — same producer, same
// `mode: Cached`, the PC minted its row for both). owner 2026-08-07 nevertheless
// ruled OPPOSITE queue semantics for them
// (`docs/decisions/2026-08-07-owner-grants-mac-injection-refusal-codes-63-64.md`):
//
//   · 63 `INJECT_SECURE_INPUT_ACTIVE` — TRANSIENT: 「retryable; the next drain should try again」
//   · 64 `INJECT_NO_ACCESSIBILITY`    — STANDING:  「terminal; no unlimited re-delivery」
//
// That ruling could not be carried by the authorship value, and the protocol
// side states the correct shape in as many words (the long note on
// `INJECT_NO_ACCESSIBILITY` in `inject-verdict-authorship.ts`): 「what's
// needed is **another, separately named dimension** to answer 'will the
// cause of this refusal go away on its own', **not a fourth authorship
// value**」.
// This is that dimension.
//
// ⚠️ NO CROSS-LANGUAGE MIRROR GUARD EXISTS FOR THIS SET, unlike the two above
// (`inject_verdict_authorship_mirror_test.dart` reads the TS file and compares
// verbatim). There is nothing to mirror: the TS table encodes AUTHORSHIP only,
// and this dimension has no machine-readable form over there — its source is a
// ruling in a decision doc. **Said out loud rather than left to be discovered:
// a second list with no guard is exactly the drift shape that guard was built
// for.** Reported as an open account by card fix-018 rather than fixed here,
// because declaring it on the TS side is a protocol-surface change (a
// human-review gate).

/// 🔴 Injection-stage refusals whose CAUSE goes away on its own, i.e. the same
/// frame aimed at the same target can legitimately succeed a moment later
/// without the user having to go and change anything.
///
/// Exactly one member today, and that is not an oversight — **it is the one code
/// owner ruled on.** Adding a member here is a RULING, not a refactor: it grants
/// automatic re-delivery of a frame the PC has already received and answered, so
/// the question to answer first is not 「does this code look transient」 but
/// 「who ruled on it, and in which document」. (`INJECT_FOCUS_LOST` is the
/// obvious candidate and is deliberately absent: nobody has ruled on it, and
/// card fix-018 was explicitly scoped to these two codes.)
///
/// ⚠️ `INJECT_NO_ACCESSIBILITY` (64) IS DELIBERATELY NOT HERE. Its cause does
/// eventually clear — but only when the user walks to System Settings ▸
/// Privacy & Security ▸ Accessibility and grants the permission, and at that
/// instant they are standing at the machine and can press resend. Retrying
/// it automatically in the meantime is 「hitting the same wall on every
/// reconnect」 — owner's own words for the thing to prevent — and it buys
/// nothing, because nothing about waiting changes the answer.
const Set<String> kTransientInjectionVerdictCodes = <String>{
  'INJECT_SECURE_INPUT_ACTIVE',
};

/// 「will the cause of this refusal go away on its own」 — the question above, as a predicate.
///
/// ⚠️ Unknown codes are false, the same failure direction the authorship
/// predicate takes and for a sharper reason: a wrong `true` here re-sends a
/// frame the PC already has, on a schedule nobody asked for.
bool isTransientInjectionVerdictCode(String? code) =>
    code != null && kTransientInjectionVerdictCodes.contains(code);

/// How many DRAIN ATTEMPTS of one item a transient verdict may ride.
///
/// 2 ⇒ exactly ONE automatic re-attempt: the first attempt earns the retry, the
/// second one's verdict settles regardless of what it says.
const int kTransientVerdictAttemptCap = 2;

/// 🔴 THE BOUND — 「does this transient verdict still deserve one more delivery attempt」.
///
/// Two clauses. Each one alone is insufficient, and neither is a number somebody
/// liked the look of.
///
/// ① **[nextOrigin] must still be [InjectOrigin.live].** An automatic
///    re-delivery is stamped by `outboxInjectOrigin` off the item's FROZEN
///    `created_at` (gate 3 — a drain never re-stamps it), so once the utterance is
///    older than `kLiveDeliveryWindow` the stamp is `deferred`, and at that point
///    **the PC withholds the injection by design** (owner 2026-08-02 「a
///    deferred message must not auto-inject」; its answer is
///    `INJECT_DEFERRED_NOT_AUTOINJECTED`). Outside that window a retry
///    therefore cannot inject anything at all — all it can do is replace one
///    honest verdict (「Secure Input is blocking it」) with a vaguer one
///    (「this is a deferred delivery, not auto-injected」).
///    ⇒ The threshold is not this file's invention: it is the very threshold the
///    PC's auto-inject gate is keyed to, read from the ONE function that owns it,
///    so the queue can never re-send a frame the PC has already promised to
///    withhold.
///    ⇒ 🔴 AND IT IS WHAT MAKES 「unlimited retry」 STRUCTURALLY IMPOSSIBLE rather than
///    merely unlikely: `created_at` is frozen, so this clause falls false on the
///    wall clock no matter how many verdicts arrive or how long secure input
///    stays on.
///
/// ② **[attempts] < [kTransientVerdictAttemptCap].** Clause ① bounds the retry
///    in TIME; a reconnect flap can still drain repeatedly inside that window, so
///    this bounds it in COUNT. One automatic re-attempt, then stop.
///    ⚠️ SAID OUT LOUD BECAUSE IT IS IMPRECISE: `attempts` counts drain attempts
///    of this item, **not** secure-input verdicts — there is no per-code counter
///    on `OutboxItem` and this card did not add one. An item that already spent
///    an attempt on a wire failure therefore gets no automatic retry at all. That
///    direction is deliberate: it can only ever stop EARLIER, and stopping early
///    lands in a terminal the user can read (`delivered` + the code + the row's
///    `injectVerdictNote` sentence), whereas stopping late is the 「no
///    unlimited re-delivery」 owner ruled against.
///
/// ⚠️ WHAT THIS DOES NOT DECIDE: the user's own resend. That press is `live`
/// unconditionally (`OutboxOriginRequest.userRequested`, 「ignoring the
/// clock」), reaches the
/// wire through its own entry points, and remains the way to retry a refusal this
/// predicate has stopped retrying — for BOTH codes. Nothing here narrows it.
bool transientVerdictEarnsAnotherAttempt({
  required String? code,
  required InjectOrigin nextOrigin,
  required int attempts,
}) =>
    isTransientInjectionVerdictCode(code) &&
    nextOrigin == InjectOrigin.live &&
    attempts < kTransientVerdictAttemptCap;

/// 🔴 **THE PC RECEIVED THIS FRAME, BUT REFUSED IT AT THE ADMISSION LAYER**
/// — it never ran the injection segment.
///
/// Today only `INJECT_NOT_PRIMARY`: the desktop-side call in
/// `socket/client.rs`'s `wire::build_inject_result` carrying
/// `error_codes::INJECT_NOT_PRIMARY` — `gate.open()` is false, refused
/// outright, never enters `run_inject`.
///
/// ⚠️ **Line numbers are deliberately NOT written here** (fixed 2026-08-07).
/// The original text said `client.rs:535-542`, and today that call site is
/// at :528-535 — it did not move, the comment above it grew a few lines and
/// pushed it down. **Line numbers rot, symbol names do not**:
/// `wire::build_inject_result` and `INJECT_NOT_PRIMARY` are both grep-able
/// strings, and the day they change is the day this sentence's own subject
/// changes.
/// 🔴 The next person **must not** casually 「add the line numbers back」 —
/// putting them back reinstalls the rot that was just fixed. (The machine
/// version of the same rule = `verify/lint/coordinate-anchors.mjs`; its own
/// file header likewise writes its two coordinates in words rather than
/// numbers, for the exact same reason.)
///
/// 🔴 **Its purpose is 「which word the row should say」, not 「does the
/// queue still owe it」** — on the queue side it already falls into the
/// retryable branch and does not need this set. The **row** side needs it,
/// because the row used to judge 「not delivered vs. pending delivery」 off
/// `inject:result.mode`, and the desktop's `mode` for this code is
/// **fabricated** (see below).
///
/// owner's 2026-08-02 ruling: when occupied by another phone, 「can only
/// record it and wait for it to free up」 ⇒ row = **pending delivery**,
/// **never display 'not delivered'** (Book 15 §3.2's 'PC busy' row: none of
/// these three codes are terminal).
const Set<String> kPcAdmissionRefusalCodes = <String>{
  'INJECT_NOT_PRIMARY',
};

/// 🔴 「was this verdict reached by the PC at the **ADMISSION layer**」 (⇒
/// the frame reached the PC, but it wasn't admitted, and the queue still owes
/// it).
///
/// ⚠️ **WHY THIS CANNOT BE ASKED VIA `inject:result.mode`** (card F2
/// addendum, measured 2026-08-02): the desktop **fabricates a `mode` out of
/// thin air** for this code — `socket/client.rs`'s
/// `build_inject_result(false, "sendinput", Some(error_codes::INJECT_NOT_PRIMARY), …)`
/// carries `"sendinput"`, and it **never pressed a single key**; that
/// comment itself says 「none of the three modes describe 'nothing was
/// attempted'… so any value that isn't `cached` is a fine choice」. So the
/// phone's `timeline_store.applyInjectResult` `wireMode == 'cached'`
/// criterion reads a **made-up value**, counts it as `failed` ⇒ the row
/// shows 「**not delivered** · unsuccessful」, **exactly the opposite of
/// owner's ruling that same day**.
/// ⇒ **A fabricated value must not be used as a criterion.** The criterion
/// is replaced with 「who reached this verdict, at which layer」.
bool isPcAdmissionRefusalCode(String? code) =>
    code != null && kPcAdmissionRefusalCodes.contains(code);

/// 🔴 「does this `ok:false` verdict prove the **delivery** segment
/// succeeded」.
///
/// ⚠️ **An unrecognised code is always false** — the failure direction is
/// deliberately chosen: judging it true = claiming something got done when
/// it didn't (red-line R2's second direction, and irreversible); judging it
/// false just falls back to today's behaviour — the item keeps being owed,
/// the UI keeps saying 「pending delivery」, limited and visible damage.
///
/// The phone's own local codes (`LINK_DOWN` / `WIRE_EMIT_FAILED` /
/// `INJECT_NO_RESULT` / `OUTBOX_*`) naturally fall on the 「false」 side, and
/// that is correct: **no PC ever spoke for them**.
bool isPcInjectionVerdictCode(String? code) =>
    code != null && kPcInjectionVerdictCodes.contains(code);
