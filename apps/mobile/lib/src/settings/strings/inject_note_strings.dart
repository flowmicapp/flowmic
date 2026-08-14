// AppStrings copy-catalogue shard: the two PER-ERROR-CODE note tables that turn
// an `inject:result` verdict into one human sentence.
// The only public entry point is still ../app_strings.dart (AppStrings composes
// this mixin with `with`; `_t` is declared here as a signature only and
// implemented by AppStrings — not one character of copy changed).
//
// 🔴 WHY THESE TWO LIVE TOGETHER IN THEIR OWN SHARD (structural split only,
// zero behaviour change — the 0.2.52 `chat_transient_banner_timers.dart`
// precedent: move a cohesive family VERBATIM rather than delete evidence).
//
// They are two of the THREE tables `chat_message_tile.dart` `_humanNoteFor`
// composes, and the third — `cloudImageRelayErrorNote` — has always lived in a
// different shard (`image_strings.dart`). So this file does not invent an
// arrangement; it makes the family's home consistent with where a third of it
// already was.
//
// 🔴 THE TWO MUST STAY TWO FUNCTIONS, and that is a red line rather than a
// style choice — the full argument is in `deliveryRefusalNote`'s own doc below
// (「named as split from injectVerdictNote into two separate functions, not
// merged into one」): one covers
// PC-authored INJECTION-segment verdicts (the frame reached the PC and it tried),
// the other covers relay-authored DELIVERY-segment refusals (no PC ever saw it).
// delivery ≠ injection (docs/rebuild/15 §2.0). Merging them would let one code produce
// two answers.
//
// ⚠️ WHICH TABLE A NEW CODE BELONGS IN IS NOT A JUDGEMENT CALL ANY MORE:
// `test/error_code_copy_binding_test.dart` derives it from
// `packages/protocol/src/inject-verdict-authorship.ts`
// (`pc-injection` ⇒ injectVerdictNote, `relay` ⇒ deliveryRefusalNote /
// cloudImageRelayErrorNote) and fails, naming the code AND the table, when a
// reachable code has no copy or has it in the wrong segment's table.
part of '../app_strings.dart';

mixin InjectNoteStrings on AppStringsLeaves {

  /// 🔴 卡 M6-1 (0.2.53) —— verdicts the PC answered in its own words on the
  /// **injection segment**, one human sentence per code.
  ///
  /// The origin is an actual real-device screenshot, not a deduction: on a
  /// 0.2.52 tablet, one row read 「⤓ delivered · not injected · INJ… resend
  /// → H… 1 character」 — [_reasonLineFor] stuffed the bare code into that
  /// meta row that already had six cells, and `Flexible + ellipsis` clipped
  /// `INJECT_SELF_WINDOW_NO_INPUT` down to **three letters**. The status word
  /// was correct, and 「what grounds justify saying so」 was unreadable to
  /// the user (CLAUDE.md R11).
  ///
  /// 🔴 **This whole family of defect is inherently invisible to the entire
  /// test suite**: `cloud_image_error_copy_test.dart`
  /// itself says, right there, 「Text widget's own data, not the
  /// rendered/clipped glyphs, so this
  /// still matches even though the row's Flexible+ellipsis would visually truncate」
  /// — the assertion tests `Text.data`, while what the user sees is **whatever
  /// characters survive layout**. ⇒ This card also adds a
  /// **measurement-type** test (`inject_verdict_note_test.dart`, asserting the
  /// render width is not clipped), the same technique the two-line top-bar
  /// card used.
  ///
  /// 🔴 **Written by 「code」, not by 「face」**. The doc for
  /// [statusDeliveredNotInjected] above lists five
  /// codes, and after checking back against the code, that list turned out
  /// to be **a stale truth** (anti-façade ④): in `inject/pipeline.rs`
  /// and `sendinput_outcome.rs`, only `INJECT_FOCUS_LOST` and
  /// `INJECT_SELF_WINDOW_NO_INPUT` are `InjectMode::Cached`; the other four
  /// are all non-cached
  /// ⇒ the server maps them to `failed` ⇒ they land on the ✗ face. Keying on
  /// the code gets the right face regardless.
  ///
  /// 🔴 **These are the phone side's own words, not a copy-paste of the
  /// `ERROR_CODES` set** ([_reasonLineFor] clause ③ already established this
  /// rule): that set is written for **someone standing in front of the
  /// computer** to read (「click into FlowMic's input field」),
  /// while the reader here is holding the phone with the computer elsewhere
  /// ⇒ the action must be phrased as 「go to the computer and …」.
  ///
  /// ⚠️ The first two entries are **deliberately worded differently**, per
  /// `error_codes.rs`'s explicit constraint (「the two
  /// situations must not answer with the same code」，`pipeline_tests.rs`
  /// `stage0_runs_before_stage1_…` supplies its positive control): one
  /// **cannot say** which window it is
  /// (no target was acquired at all), the other **can say** (it's FlowMic
  /// itself, right there).
  ///
  /// Returning `null` = this code has no human sentence, and the caller
  /// **as before** falls back to the bare identifier — no sentence may be
  /// invented for an unrecognized code.
  String? injectVerdictNote(String code) {
    switch (code) {
      // inject/pipeline.rs Stage 1: no target window was acquired at all (no
      // locked/live target, or SetForegroundWindow was refused) ⇒ cannot say which window.
      case 'INJECT_FOCUS_LOST':
        return _lfInjectVerdictNote_INJECT_FOCUS_LOST;
      // inject/self_focus.rs (owner 2026-08-02 F1a reversal ruling, error
      // code 61): focus is on FlowMic's own window, but not resting on an
      // input-capable element ⇒ the window CAN be named, it's right there.
      case 'INJECT_SELF_WINDOW_NO_INPUT':
        return _lfInjectVerdictNote_INJECT_SELF_WINDOW_NO_INPUT;
      // pipeline.rs: judged invalid before any keystroke lands; the known
      // cause is text exceeding INJECT_TEXT_MAX_CHARS
      // (rejected outright, never silently truncated). Wording gives an example, not a sole cause.
      case 'INJECT_TARGET_INVALID':
        return _lfInjectVerdictNote_INJECT_TARGET_INVALID;
      // sendinput_outcome.rs: **the call itself** failed (returned 0 or a
      // hard Win32 error).
      // ⚠️ Since 2026-07-30 it is no longer a measurement of the target
      // along the lines of 「read back and nothing changed」,
      // so this sentence only speaks to the call, not on behalf of the target program.
      case 'INJECT_SENDINPUT_FAIL':
        return _lfInjectVerdictNote_INJECT_SENDINPUT_FAIL;
      // A Win32 error at some step of the clipboard fallback path, or the
      // user's clipboard failed to restore.
      case 'INJECT_CLIPBOARD_FAIL':
        return _lfInjectVerdictNote_INJECT_CLIPBOARD_FAIL;
      // image.rs: exceeds the protocol limit / malformed base64 / bytes
      // contradict the mime type / the system decoder
      // refused. Rejected **before switching focus or writing the clipboard** ⇒ no empty paste can occur.
      case 'INJECT_IMAGE_UNSUPPORTED':
        return _lfInjectVerdictNote_INJECT_IMAGE_UNSUPPORTED;
      // ── MAC-05 · error codes 63/64 (owner-approved 2026-08-07) ───────────────
      // Both are emitted from `inject/preflight.rs`'s
      // `synthetic_input_verdict`. Both are
      // `mode:'cached'` ⇒ the capsule on the row already says 「delivered ·
      // not injected」, so these two sentences
      // **must not be read as 「not delivered」 even by one character**: they
      // only explain 「why it wasn't typed in」.
      //
      // ⚠️ The two sentences deliberately give **opposite actions**, which
      // is exactly why owner split them into two codes:
      // for 63, leaving the password field fixes it; for 64, it will never
      // be fixed without going to System Settings. Telling a 64 user to
      // 「leave the password field」 would send them looking for a password field that doesn't exist.
      case 'INJECT_SECURE_INPUT_ACTIVE':
        return _lfInjectVerdictNote_INJECT_SECURE_INPUT_ACTIVE;
      // 🔴 **The one and only failure on this entire path that the user can
      // fix themselves**, so this sentence must spell out 「where to go and
      // what to tap」
      // in full, rather than just saying 「no permission」 — stating only the cause turns a solvable problem into an unsolvable one.
      case 'INJECT_NO_ACCESSIBILITY':
        return _lfInjectVerdictNote_INJECT_NO_ACCESSIBILITY;
      default:
        return null;
    }
  }

  /// 🔴 卡 U5 —— refusals the relay itself answered on the **delivery
  /// segment**, one human sentence per code.
  ///
  /// [measured] Of the 61 protocol error codes, about 53 have only one fate
  /// on the phone today: `_reasonLineFor`
  /// truncates the bare identifier to 28 characters and stuffs it into the
  /// meta row. This family is the four among them that **land on the ✗/⛔
  /// face, and until now were unrecognized even by [injectVerdictNote]** —
  /// `relay.handler.ts`'s
  /// `answerReject` emits them when it rejects a frame in place **before it
  /// ever reaches the PC**, and `mode:'cached'` always
  /// accompanies them (see the `answerReject` implementation at
  /// relay.handler.ts lines 128-135, and the comments above each of
  /// `INJECT_PC_MISMATCH`/`INJECT_PC_UNSPECIFIED`'s call sites, which state
  /// verbatim 「the
  /// server answers a crosstalk / unaddressed refusal with mode:'cached'」).
  /// `isTerminalRefusalCode` (outbox_item.dart) judges all four as terminal ⇒
  /// `deliveryFaceOf` lands on [DeliveryFace.refused] (⛔ not delivered ·
  /// delivery refused), and this face
  /// already speaks 「why」 unconditionally (`_faceSpeaksReason`), except all
  /// four codes had no human sentence to speak
  /// — until this card.
  ///
  /// ⚠️ **Correction (卡 G-16-a) — 「four」 and 「all judged terminal」 in the
  /// paragraph above no longer cover the entirety of this table's
  /// membership. The original text is kept, not deleted**: it was true when
  /// written, and remains true, verbatim, of the four codes it named
  /// today; what is false is only the **universality** of the inference
  /// 「this table ⇒ terminal ⇒ ⛔」.
  ///
  /// The fifth member, `INJECT_PC_OFFLINE`, is this table's **only
  /// non-terminal member**:
  /// `isTerminalRefusalCode` returns **false** for it, and that function's
  /// own doc states verbatim that this is deliberate
  /// (「every one of them is 「not right now」, and owner's ruling is that
  /// those wait,
  /// however long it takes」) ⇒ the item goes back to `queued` (the
  /// retryable `else` at the end of `delivery_outbox_settle.dart`), and the
  /// next drain on rejoining the room will send it again.
  /// 🔴 **This is the mechanism that honors the half-promise made in this
  /// function's fifth sentence** — what the red line bans is 「a wait with
  /// no mechanism to honor it」, not the sentence itself. The assertion
  /// pinning it directly asks `isTerminalRefusalCode`
  /// (test/pc_offline_note_test.dart group ①), so the instant that predicate
  /// changes, this sentence goes red on the spot.
  ///
  /// 🔴 **The segment hasn't changed, only the terminality has**: it is
  /// likewise answered by the relay in its own words, and the frame
  /// likewise never reached the PC
  /// (`inject-verdict-authorship.ts`'s `INJECT_PC_OFFLINE: 'relay'`; the
  /// emission sites are
  /// `relay.handler.ts`'s `answerReject('INJECT_PC_OFFLINE', …)` and
  /// `inject-routes.ts`'s `error: 'INJECT_PC_OFFLINE'`) ⇒ delivery segment ⇒
  /// belongs in this table,
  /// and **must never** enter [injectVerdictNote] (the reason is the 「split
  /// naming」 paragraph below, applying word for word;
  /// that table today is entirely clean of it).
  ///
  /// ⚠️ **The face it lands on is therefore not ⛔ but two possible faces**,
  /// and the criterion is whether the frame carries `mode`, not the code
  /// (both legs are verified in test/pc_offline_note_test.dart group ②):
  ///   · **the socket leg** — `answerReject` sends `mode:'cached'` ⇒ row
  ///     `cached + cachedByVerdict` ⇒ [DeliveryFace.undelivered] (「pending
  ///     delivery」). 🔴 **This face previously
  ///     said nothing about it at all** (`_faceSpeaksReason` only lets it
  ///     speak when there is a non-empty human sentence) ⇒ the user reads
  ///     「pending delivery」 + a 「resend」 button + **zero explanation**,
  ///     the same argument as 卡 B4-12.
  ///   · **the HTTP image leg** — `image_send_http.dart`'s `pcOffline`
  ///     branch does not pass `wireMode`
  ///     (M4-15's ruling forbids fabricating a `'cached'` there) ⇒ row
  ///     `failed` ⇒ ✗, previously showing the bare identifier.
  ///
  /// 🔴 **Why this entry doesn't copy the SSOT verbatim**: `error-codes.ts`'s
  /// `INJECT_PC_OFFLINE.zh_CN`
  /// now reads 「电脑不在线，这一条未送达。」(the computer is offline, this
  /// item was not delivered.) (DOC-HYG `b20092f` already replaced the
  /// original 「未注入」 (not injected) — that was a delivery-segment code
  /// carrying an injection-segment word, now corrected, so the SSOT and this
  /// file are consistent from now on
  /// in 「no injection-segment words appear」). **This file still writes a
  /// separate sentence**, and the reason has changed, it's no longer 「the
  /// SSOT used the wrong word」: the phone's sentence
  /// adds an extra promise, 「the next reconnect will send it again」, and
  /// the SSOT deliberately does not write that promise — the SSOT's other
  /// consumers don't have a queue that honors it (the F-1 red line), only
  /// the phone's leg does (see the mechanism comment on the case below).
  /// ⚠️ The protocol surface belongs to owner, and there is zero protocol
  /// change here — this only explains **why the phone's sentence differs
  /// from the SSOT**.
  ///
  /// 🔴 **Named as split from [injectVerdictNote] into two separate
  /// functions, not merged into one**: that function's
  /// six covered codes are all **injection-segment verdicts the PC answered
  /// in its own words** (the frame did reach the PC, and the PC tried
  /// before refusing);
  /// the four here are all **delivery-segment verdicts from the
  /// relay/protocol layer** (the frame never reached the PC at all, and the
  /// PC never took part in the
  /// verdict). The red line across the two segments' terminology is 「one
  /// word may not span both segments at once」 (doc 13 §2.0), and the
  /// function names follow that
  /// split; callers chain them with `??`, so no single code can ever produce two answers at once.
  ///
  /// 🔴 **Wording aligns sentence-for-sentence with the protocol SSOT**
  /// (`packages/protocol/src/error-codes.ts`'s
  /// `INJECT_FRAME_TOO_LARGE` / `INJECT_FRAME_INVALID` / `INJECT_PC_MISMATCH` /
  /// `INJECT_PC_UNSPECIFIED` `zh_CN`/`en`), rather than starting a separate
  /// set of words — that copy's own
  /// comment says 「ONLY THE PHONE EVER SEES IT」, meaning it was already
  /// written for a phone reader,
  /// and this only fits it into this file's first-person reader viewpoint of
  /// 「go to the computer and …」 (the same rule laid down by
  /// [injectVerdictNote]'s doc, in the paragraph 「**these are the phone
  /// side's own words, not a copy-paste of the `ERROR_CODES` set**」),
  /// inventing no separate set of facts.
  /// ⚠️ The previous sentence originally read 「document line 549」 — **that
  /// line number was already stale the moment it was written**:
  /// these two functions lived in `chat_strings.dart` at the time, and after
  /// being moved into this file, line 549 doesn't even exist
  /// (this file is under 400 lines). **Use a symbolic anchor, not a line
  /// number**: a section heading gets changed along with the rule it
  /// describes, a line number does not.
  ///
  /// 🔴 **MISMATCH only states the fact, gives no instruction at all**: the
  /// protocol side's own words are 「state the fact, add no
  /// imperative the product cannot honour」 — this frame's destination is a
  /// different computer, this device can do
  /// nothing about it, and saying 「please retry」 would be an empty promise
  /// this product cannot honour. **UNSPECIFIED is the opposite, it keeps
  /// the one action that is genuinely real and actionable**: the action the
  /// protocol side names is 「update the phone app」, which this product
  /// **really can** accomplish, so the sentence keeps it.
  ///
  /// ⚠️ **Does not cover `kOutboxImageBytesGone` / `kOutboxOverflow`**: those
  /// two are the phone queue's
  /// own terminal states (they were never protocol codes to begin with —
  /// see the top comment of outbox_failure_text.dart), and already have
  /// their own human sentences (`outboxTerminalMessage`), going through
  /// banner_queue.dart's entirely separate
  /// presentation path, not this inline note. Wiring another copy in here
  /// would mean two places each judging 「what this is」 on their own.
  ///
  /// ⚠️ **Does not invent an entry point the phone app doesn't have**: these
  /// four sentences only state facts that have already happened (+
  /// UNSPECIFIED's one genuine update action), and none of them show any
  /// 「go into settings and…」-style UI this App does not have.
  ///
  /// Returning `null` = this code has no human sentence, and the caller
  /// **as before** falls back to the bare identifier — no sentence may be
  /// invented for an unrecognized code (the same rule as [injectVerdictNote],
  /// verified in test/delivery_refusal_note_test.dart).
  String? deliveryRefusalNote(String code) {
    switch (code) {
      // relay.handler.ts: image_b64 exceeds the relay's frame byte limit, the PC never received it.
      case 'INJECT_FRAME_TOO_LARGE':
        return _lfDeliveryRefusalNote_INJECT_FRAME_TOO_LARGE;
      // relay.handler.ts: zod validation failed (the frame doesn't match the protocol shape), the PC never received it.
      case 'INJECT_FRAME_INVALID':
        return _lfDeliveryRefusalNote_INJECT_FRAME_INVALID;
      // relay.handler.ts `answerReject('INJECT_PC_MISMATCH', …)`: target_pc_id
      // points to a PC other than the one on this connection. States the
      // fact only — see this function's doc, the 「gives no instruction」 paragraph.
      case 'INJECT_PC_MISMATCH':
        return _lfDeliveryRefusalNote_INJECT_PC_MISMATCH;
      // relay.handler.ts `answerReject('INJECT_PC_UNSPECIFIED', …)` (the
      // `targetPcId === undefined` branch): the frame carries no
      // target_pc_id at all (only phones older than 0.2.32 do this).
      // The one genuinely real and actionable action is to update the phone
      // app — see this function's doc, the 「keeps the one real action」 paragraph.
      //
      // ⚠️ The two entries above originally carried line numbers (`215-219` /
      // `252-257`), now changed to symbolic anchors. This is not formatting
      // perfectionism: **the very passage being cited is itself the
      // precedent** — relay.handler.ts's `targetPcId ===
      // undefined` branch states verbatim 「named by SYMBOL because the line
      // numbers this
      // used to carry drifted within one window」. A drifted line number
      // will not make any gate turn red,
      // and the reader will flip to an unrelated piece of code following
      // it, and think they've understood it.
      case 'INJECT_PC_UNSPECIFIED':
        return _lfDeliveryRefusalNote_INJECT_PC_UNSPECIFIED;
      // ── 卡 G-16-a —— this table's **only non-terminal member** (the full
      // reasoning is in this function's doc's correction block) ──
      //
      // relay.handler.ts `answerReject('INJECT_PC_OFFLINE', …)` / the
      // same-named `error` in inject-routes.ts:
      // there's no PC in the room, the frame is rejected in place, the PC never received it.
      //
      // 🔴 **Not one injection-segment word may appear**, even though the
      // protocol SSOT's sentence carries 「not injected」: this segment
      // only answers 「did it get delivered」. The PC is offline ⇒ it never
      // even tried, and saying 「not injected」 on its behalf would be
      // answering for a party that never took part in the verdict.
      //
      // 🔴 **The second sentence is a promise, so it must have a
      // mechanism** (CLAUDE.md red line: no naming a wait with no
      // mechanism to honor it 「pending…」). The mechanism is in hand,
      // greppable, and pinned by a test:
      // `isTerminalRefusalCode` returns false for this code ⇒
      // `outboxSettle` takes the retryable `else` at the end,
      // the item goes back to `queued` ⇒ the next drain on rejoining the room will send it again
      // (since 0.2.52 the drain hangs off `PttSession.roomJoins`, which has
      // been honored on a real device).
      //
      // 🔴 **And the subject must be 「this phone」, not 「the computer」 —
      // otherwise it's a verbatim repeat of F-1.**
      // The first draft read 「will automatically send again once the
      // **computer** comes back online」, while the mechanism the previous
      // paragraph honors is
      // **a different edge**: `roomJoins`'s two writers (`pair()`
      // succeeding / `onAccepted`) both say
      // 「**this phone** entered the room」; 「the computer came back」
      // triggers nothing — `PcPresence`'s only consumer,
      // `chat_notices.onPcPresenceChangedRouted`, `return`s on the very
      // first line of its `online` branch.
      // ⇒ On the cloud leg (relay never drops, the phone stays in the room
      // the whole time), that row would stay stuck **indefinitely** at
      // 「pending delivery · will auto-
      // resend」. The full argument and the four-language criteria are in
      // test/pc_offline_note_test.dart on the
      // 「trigger edge of the promise」 test (including a measured reverse control).
      //
      // ⚠️ Deliberately **does not write** an imperative sentence like
      // 「please wait」: owner's ruling ⑩ makes it clear
      // that the action the user should take on this row is **resend**, not
      // waiting (`retryableFace` includes both
      // `failed` and `undelivered`, and the button is present on both
      // faces). This only states **what the queue will
      // do**, it does not command the user to do anything — the two don't
      // conflict, ruling ⑩ itself named them as simultaneously true.
      case 'INJECT_PC_OFFLINE':
        return _lfDeliveryRefusalNote_INJECT_PC_OFFLINE;
      // ── Card G-16-b · the defect the registry↔copy binding gate NAMED ──────
      //
      // Found by `test/error_code_copy_binding_test.dart`, not by a person
      // reading the tables: this code rides `inject:result`, reaches a face
      // that always speaks, and had no copy — so it rendered as the bare
      // string 「· INJECT_SERVER_BUSY」. The 0.2.53 shape, exactly as the 62→64
      // window predicted it would recur.
      //
      // PRODUCER — ONE, and it is the HTTP image ingress: server-core
      // `inject-routes.ts`, the `attempt.kind === 'overloaded'` arm (the
      // request_id waiter table is momentarily full, ~64 concurrent uploads).
      // It answers HTTP 200 with `{ok:false, error:'INJECT_SERVER_BUSY'}`, and
      // its own comment calls it 「a retryable SERVER refusal」.
      //
      // 🔴 WHY THE FACE SPEAKS (and therefore why this copy is required):
      // `image_send_http.dart`'s `serverRefused` arm calls `applyInjectResult`
      // WITHOUT a `wireMode` ⇒ the row settles `EntryStatus.failed` ⇒ ✗, and
      // `_faceSpeaksReason` speaks unconditionally on `failed`.
      //
      // 🔴 WHY THE IMPERATIVE IS ALLOWED HERE — the mechanism was verified,
      // not assumed (R11: a sentence must answer 「what grounds justify
      // saying so」), and it is
      // BOTH halves, because for a picture the resend button needs both:
      //   ① the face — `failed` is in `retryableFace` ⇒ the button renders
      //      (owner ruling ⑩: on this row the user's action IS resend);
      //   ② the item — `canResendImage` requires the queue item to be still
      //      pending (`OutboxPendingView.resendableImageEntryIds` ⇒
      //      `OutboxItem.isPending` ⇒ `!isTerminal`). It IS pending, and for a
      //      precise reason: the `serverRefused` arm is the only refusal arm on
      //      that leg that never calls `settleQueued`, so the item is never
      //      settled terminal. The affordance the sentence names therefore
      //      exists in both layers.
      //
      // 🔴 WHY IT DOES **NOT** PROMISE AN AUTOMATIC RETRY, although one exists
      // in a narrow sense. Leaving the item unsettled means the 45 s local
      // watchdog (`outboxArmItemWatchdog`, `kOutboxInflightTimeout`) eventually
      // returns it to `queued` — but a queued item still needs a DRAIN, and
      // since 0.2.52 the drain edge is `PttSession.roomJoins`. On a connection
      // that never drops, that edge does not fire, so 「will auto-resend」 would be a
      // wait with no mechanism to honour it on the very leg that produces this
      // code — the F-1 red line, verbatim. The neighbour above may promise it
      // because its promise is pinned to that exact edge and was cashed on a
      // real device; this one is not, so it states the fact and names the
      // action the user can actually take.
      //
      // ⚠️ NOT ONE INJECTION-SEGMENT WORD (delivery ≠ injection, doc 15
      // §2.0): the frame never
      // reached a PC, so 「not injected」 would answer for a machine that never judged
      // it. Same discipline as `INJECT_PC_OFFLINE` above.
      case 'INJECT_SERVER_BUSY':
        return _lfDeliveryRefusalNote_INJECT_SERVER_BUSY;
      default:
        return null;
    }
  }
}
