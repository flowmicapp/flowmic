// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0.1
//     (phone's three states ↔ queue/receipt mapping: 「`ok:false` 但**是 PC 自己作答的**……
//      同样证明 **投递这一段成功了**」("`ok:false` but **it was answered by the PC
//      itself**……equally proves **this delivery segment succeeded**"))
//   docs/decisions/2026-08-02-delivery-vs-injection-terminology-contract.md (the two-segment terminology)
//   CLAUDE.md red line: one value answers only one question / no silent failure (banned in both directions)
//
// ── The single question this table answers: **who made a given `inject:result` verdict, and at which layer** ──
//
// Card F2 (M4, owner's iron rule 「转录消息的状态一定要对」("the status of a transcribed
// message must be correct")). 15 册 §2.0.1 already wrote the rule correctly —
// **the implementation never implemented that line**: the phone's `outboxSettle` only
// receives `ok + code`, so 「the PC's own answer of 'received but not injected'」 and
// 「never delivered at all」 are **physically indistinguishable** at the settlement layer,
// and a message the PC has already minted a row for shows as 「待投递」("pending delivery")
// on the phone. This table is the patch for that gap.
//
// 🔴 Why the criterion is a **code**, and not `inject:result.mode` (this alternative was
//   disproven by measurement once, and is written down for good):
//   `mode` answers 「用了哪条投递路径」("which delivery path was used") (sendinput/clipboard/cached),
//   **it does not answer who authored the verdict**.
//   Relay-authored refusals also stamp `mode:'cached'` —
//   `apps/server-core/src/socket/handlers/relay.handler.ts` `answerReject`
//   (`socket.emit('inject:result', { ok:false, mode:'cached', error, …})`)
//   and the inline `INJECT_NOT_IN_ROOM` emit in the same file. PC-side
//   `INJECT_FOCUS_LOST` is likewise `cached`
//   (`apps/desktop/src-tauri/src/inject/pipeline.rs` `stage1_focus`
//   → `error_codes::INJECT_FOCUS_LOST`).
//   ⇒ **the same `mode` value has two authors** — using it to judge authorship is this
//   repo's #1 bug shape (one value answering two questions).
//   The reverse also fails: PC admission refuses with `mode:'sendinput'`
//   (`apps/desktop/src-tauri/src/socket/client.rs`, the `wire::build_inject_result`
//   call whose `error` argument is `error_codes::INJECT_NOT_PRIMARY` and whose
//   mode argument is the literal `"sendinput"`), same `mode` as
//   `INJECT_NO_TEXT_TARGET`, but authorship differs (see below).
//   **`mode` cannot name the author in either direction.**
//
// 🔴 Why not add a new `authored_by` field instead: **unknown keys get stripped in
//   transit by zod** (the `duration_ms` lesson, which L8 wrote down for good at
//   `error-codes.ts` `INJECT_DEFERRED_NOT_AUTOINJECTED`), while `error` is a known key
//   of `InjectResultSchema` ⇒ a criterion built on the code **does not depend on the
//   relay's version**. This is the same reason L8 chose 「加一个码」("add a code") over
//   「加一个字段」("add a field") back then.
//
// 🔴 Guards (「漏声明见红」("missing a declaration goes red"), not left to memory):
//   ① **Compile time** — [INJECT_VERDICT_AUTHORSHIP] uses `satisfies Record<ErrorCode, …>`,
//      so adding an `ERROR_CODES` entry without declaring its authorship here ⇒
//      `pnpm verify:types` goes red immediately;
//   ② **Run time** — `packages/protocol/test/inject-verdict-authorship.test.ts` asserts
//      full coverage + the three named sets equal byte-for-byte (changing a set must be
//      a **deliberate** edit);
//   ③ **Cross-language** — the phone-side mirror
//      `apps/mobile/lib/src/session/outbox_inject_authorship.dart` is checked against
//      **this file** by `apps/mobile/test/inject_verdict_authorship_mirror_test.dart`
//      (the same technique as `apps/desktop/src-tauri/src/error_codes.rs`'s
//      `desktop_error_codes_are_a_subset_of_the_protocol_ssot`: cross-language mirrors
//      are kept aligned by reading the source file, not by a human comparing them).

import type { ErrorCode } from './error-codes';

/**
 * Who made this `inject:result` verdict, and **at which layer** it was made.
 *
 * The three values that 「会出现在 `inject:result` 上」("appear on `inject:result`") are
 * deliberately split into three, not two: `pc-admission` and `pc-injection` are both
 * spoken by the PC itself, but **mean opposite things for the queue** (see each one's
 * own doc).
 */
export type InjectVerdictAuthor =
  /**
   * **The PC reached the injection stage and rendered a verdict** (success, cached, or
   * injection failure all count).
   *
   * ⇒ 🔴 **Segment ①（phone→PC delivery）is finished and succeeded**: the frame reached
   * that PC; `row_transit::mint_row` mints the row (the call site is the
   * `inject:request` handler in `apps/desktop/src-tauri/src/socket/client.rs`, and
   * the sole result-producing expression handed to it is `run_inject(...)` —
   * row and receipt come from that one expression, neither can appear alone).
   * ⚠️ NAMED BY SYMBOL, NOT BY LINE (IJ-01, 2026-08-07). This used to cite
   * `client.rs:588` / `:593`, and an ordinary six-line edit in that file's
   * admission branch turned someone else's change into this file's gate failure.
   * Same lesson `target_pc_id` records in protocol-schemas-inject.ts: 「a citation
   * that rots is worse than none, because it sends the next reader to a line that
   * now says something else」.
   * The outbox must NOT re-send it — that would be 15 册's "a wait with no mechanism".
   */
  | 'pc-injection'
  /**
   * **The PC received this frame, but refused it at the admission layer** — it never
   * reached the injection stage.
   *
   * Today this is only `INJECT_NOT_PRIMARY` (this PC is currently held by another phone).
   * ⇒ 🔴 **Still owed**: owner's 2026-08-02 ruling 「被占用时行=待投递，绝不显示未投递」
   * ("while occupied, the row = pending delivery, never show 'not delivered'"), and
   * 15 册 §3.2's 「PC 忙」("PC busy") row likewise states these three codes **are never
   * terminal**. Follows the existing retryable path.
   *
   * ⚠️ Its difference from `pc-injection` is **not** 「谁说的」("who said it"), but
   * **which segment it speaks about** — that is the entire reason this type has three
   * values, not two.
   */
  | 'pc-admission'
  /**
   * **Answered on the relay's behalf**: this frame **never reached any PC**. Follows
   * the existing refused / retry logic (`isTerminalRefusalCode` decides which of these
   * are terminal).
   */
  | 'relay'
  /** This code never rides `inject:result` (login/pairing/engine/billing/timeline…). */
  | 'none';

/**
 * 🔴 The full table. **Every `ERROR_CODES` key must appear here exactly once** —
 * `satisfies` guarantees a missing one fails to compile (guard ①).
 *
 * ⚠️ Authorship **must be decided by the production emit site, never copied from a
 * comment**. Every `pc-*` / `relay` entry below is labelled with the emit site
 * (file:line) it was grepped to on 2026-08-02; re-grep before changing an authorship.
 */
export const INJECT_VERDICT_AUTHORSHIP = {
  // ── does not ride inject:result ─────────────────────────────────────────────
  AUTH_TOKEN_INVALID: 'none',
  AUTH_TOKEN_EXPIRED: 'none',
  AUTH_LOGIN_FAILED: 'none',
  AUTH_USE_REST_LOGIN: 'none',
  REGISTER_RATE_LIMITED: 'none',
  PAIR_INVALID_CODE: 'none',
  PAIR_INVALID_PAYLOAD: 'none',
  PAIR_EXPIRED_CODE: 'none',
  PAIR_PC_OFFLINE: 'none',
  PC_MOBILE_SLOT_BUSY: 'none',
  PAIR_NOT_CONNECTED: 'none',
  PAIR_RATE_LIMITED: 'none',
  PAIR_RELEASED: 'none',
  // 0.2.66 · PCID addressing. Both ride the `mobile:pair` ack, never
  // `inject:result` — producers are apps/server-core/src/room/registry.ts
  // `resolvePcForPair` (the saas branch), surfaced through
  // apps/server-core/src/socket/handlers/mobile.handler.ts's pair catch.
  PAIR_PCID_REQUIRED: 'none',
  PAIR_PCID_UNKNOWN: 'none',
  // ⚠️ `PC_BUSY` rides the `mobile:reconnect` ack, **not** `inject:result`
  // (`apps/server-core/src/socket/handlers/mobile.handler.ts`). Its siblings on the
  // delivery surface are `INJECT_NOT_PRIMARY` (direct desktop refusal) and
  // `INJECT_NOT_IN_ROOM` (after being kicked from the room).
  PC_BUSY: 'none',
  STT_CONFIG_MISSING: 'none',
  STT_ENGINE_AUTH_FAIL: 'none',
  STT_ENGINE_RATE_LIMITED: 'none',
  STT_ENGINE_TIMEOUT: 'none',
  STT_NETWORK_DROP: 'none',
  STT_PROBE_FAIL: 'none',
  STT_PROBE_SCHEME_MISMATCH: 'none',
  STT_HARD_LIMIT_REACHED: 'none',
  LLM_TIMEOUT: 'none',
  LLM_AUTH_FAIL: 'none',
  LLM_RATE_LIMITED: 'none',
  LLM_PROBE_FAIL: 'none',
  LLM_INVALID_MODEL: 'none',
  /**
   * Error code 62 (owner-approved 2026-08-07). The reason for `'none'` here is the
   * same as the entries above, but **differs** from the `INJECT_TAURI_MISSING` entry,
   * and the distinction is worth a line: it is `'none'` **not because it has no
   * producer** (it has one, a newly built runtime-output gate), but because **it is
   * simply not on the injection surface at all** — it only rides `compose:error`,
   * never appears on `inject:result`, so it says **not a single word** about
   * 「段①（手机→PC 投递）成没成功」("did segment ① (phone→PC delivery) succeed"). ⇒ If
   * the phone used it to judge 「已投递·未注入」("delivered but not injected"), that
   * would be invented out of nothing; `injectVerdictAuthorOf` returning `'none'` for
   * it is exactly what blocks that.
   */
  COMPOSE_OUTPUT_REJECTED: 'none',
  /**
   * Error code 69, 「账号被限制使用」("account restricted from use") (Card A2-3,
   * 2026-08-12).
   *
   * The reason for `'none'` here **has the same shape as** `COMPOSE_OUTPUT_REJECTED`,
   * but needs to be pinned down harder: today it only rides the saas console REST 403
   * (`http/console-routes.ts` `refuseRestricted`), **never appears on `inject:result`**
   * ⇒ it says not a single word about 「段①（手机→PC 投递）成没成功」("did segment ①
   * (phone→PC delivery) succeed"). If the phone used it to judge 「已投递·未注入」
   * ("delivered but not injected"), that would be invented out of nothing.
   *
   * 🔴 **This line is a statement about today, and it exists because it was
   * 「刻意推迟」("deliberately deferred"), not because it is inherent.** Unlike
   * `LAN_CERT_PIN_MISMATCH` (which physically cannot come back), this code **could
   * plausibly** land on the delivery surface someday — the design doc §3.4 argued that
   * the delivery surface is today's only path that can put a sentence in front of the
   * phone user. Not doing it this round is the window lead's ruling, on the grounds
   * that path requires moving both the phone's **closed set**
   * `kPcInjectionVerdictCodes` and the terminal-state table `isTerminalRefusalCode` at
   * once, and **a code the closed set does not recognise ⇒ judged 「这一项还欠着」("this
   * item is still owed") ⇒ the UI says 「待投递」("pending delivery") forever and never
   * converges** — a verbatim replay of the 0.2.48 P0.
   *
   * 🔴 **The day this is actually done, three places must move in the same commit —
   * missing the second one recreates that same P0**:
   *   ① this line changes to `'relay'` (the relay itself refused it — the frame never
   *      reached a PC ⇒ the delivery segment is **not** finished)
   *      — **never** `pc-injection` (that would tell the queue 「送到了」("it arrived"),
   *      when it didn't);
   *   ② the phone's `outbox_inject_authorship.dart` mirror set (`inject_verdict_
   *      authorship_mirror_test.dart` reads this file byte-for-byte and will go red on
   *      its own);
   *   ③ the phone's `outbox_item.dart` `isTerminalRefusalCode` must accept it —
   *      **the reason is precisely** the owner's 「不提供申诉通道」("no appeal channel is
   *      provided"): a retry can never succeed, so if it does not join the terminal
   *      group ⇒ every reconnect resends it again, forever.
   *      ⚠️ The cost must be written down explicitly: terminal means **once the
   *      restriction is lifted it does not auto-redeliver** — the user has to say it
   *      again.
   */
  ACCOUNT_RESTRICTED: 'none',

  // ── 🔴 2026-08-10 · the four new codes owner approved (ruling group #5), all `'none'` ──────
  //
  // Card fix-019 only does the registration surface — **today none of the four codes
  // has a producer** (the producers are fix-020…fix-024 respectively). This table's
  // rule is 「归属必须由**生产发射点**决定，不许照抄注释」("authorship must be decided by
  // the **production emit site**, never copied from a comment") — with no emit site to
  // read, the only honest answer is **to record today's fact**: **none of these four
  // codes appear on any `inject:result`.**
  //
  // ⚠️ `'none'` in this table **does not mean** 「它永远不可能上注入面」("it can never
  // land on the injection surface"), it means 「它不走 `inject:result`」("it does not
  // ride `inject:result`") (see the fourth member of the `InjectVerdictAuthor` type).
  // Three of the codes are inherently this way, the fourth is undecided — the two need
  // to be said separately, hence entry-by-entry below.
  /**
   * The registration email is malformed (Card fix-023). It rides the REST
   * registration endpoint's response, same family as `AUTH_LOGIN_FAILED` /
   * `REGISTER_RATE_LIMITED` — **registration happens before pairing**, at which point
   * there is not even a room yet, let alone an `inject:request` to answer.
   */
  REGISTER_EMAIL_INVALID: 'none',
  /**
   * LAN certificate pinning mismatch (Card fix-024). **It never even crosses the
   * wire**: the verdict is made by the phone itself at the TLS handshake layer
   * (`lan_pinning.dart`), at which point that connection was never established at all
   * ⇒ there is no frame that could carry it back.
   * ⚠️ Precisely because of that, its user-visible copy is rendered by **the phone's
   * own string table**, not the inline-note pipeline this table serves — don't add a
   * `case` to `deliveryRefusalNote` for it just because 「它是个协议码」("it's a
   * protocol code"): that table only answers delivery-segment verdicts the relay
   * itself refused, and this one doesn't involve the relay at all.
   */
  LAN_CERT_PIN_MISMATCH: 'none',
  /**
   * No engine ever heard this audio (Card fix-022). It rides `stt:error`, the same
   * path as the `STT_NETWORK_DROP` it replaces ⇒ `'none'`, same as the rest of the
   * `STT_*` family. It says **not a single word** about 「手机→PC 这一段投递成没成功」
   * ("did the phone→PC delivery segment succeed"), for exactly the same reason as
   * `COMPOSE_OUTPUT_REJECTED` above: it is not on the injection surface.
   */
  STT_NO_ENGINE_REACHED: 'none',
  /**
   * 🔴 **This is the only one of the four with real doubt attached, so its reasoning
   * has to be spelled out in full.**
   *
   * The image reached the PC, and the PC failed to save it to disk (Card fix-021).
   * **Today it being `'none'` is a statement about today**: a repo-wide grep for this
   * name only hits `error-codes.ts`, this line, and
   * `packages/protocol/test/approved-codes-2026-08-10.test.ts` — **nothing emits it
   * anywhere**, let alone puts it on `inject:result`.
   *
   * ⚠️ And fix-019 also **has no authority** to decide on fix-021's behalf which line
   * it will eventually ride: that card's own text says 「先找到真正的边界」("first find
   * the real boundary"), 「如果诚实的修法要动你不拥有的文件，就停下来上报」("if the honest
   * fix requires touching a file you don't own, stop and escalate"), and the two owned
   * paths it lists (`inject/image_ops.rs` / `inject/row_image.rs`) **do not exist in
   * today's tree** (the real location is `socket/row_image.rs`, whose sole caller is
   * `socket/row_transit.rs`'s `mint_row`) ⇒ the emit site is not yet determined, and
   * **guessing one here would just swap 「照抄注释」("copying from a comment") for
   * 「照抄卡片」("copying from a card")**.
   *
   * 🔴 **So this line is a falsifiable assertion, not a default value**, and it has a
   * guard: the approved-codes test **pins** all four of these lines as `'none'`. The
   * moment fix-021 puts this code on `inject:result`, that assertion goes red
   * immediately and whoever reads it lands here — rather than waiting for someone to
   * see a row that permanently reads 「待投递」("pending delivery") on a real device.
   *
   * 🔴 **On the day this line changes, three places must move in the same commit**
   * (missing the second one is a verbatim replay of the 0.2.48 P0):
   *   ① this line changes to `'pc-injection'` — the criterion is 「谁、在哪一层作出裁决」
   *      ("who, and at which layer, made the verdict"), and the save-to-disk happens
   *      **after admission, inside the PC's own process** (`mint_row` and `run_inject`
   *      come from the same expression), so the frame demonstrably reached that
   *      machine ⇒ segment ① (delivery) is finished and succeeded, and the queue
   *      **must not** re-send it; **never** `pc-admission` (that value means 「它从没跑
   *      注入段」("it never reached the injection stage"), which would be false here);
   *   ② `apps/mobile/lib/src/session/outbox_inject_authorship.dart`'s
   *      `kPcInjectionVerdictCodes` — **it is a closed set**; an unrecognised code
   *      falls into `outboxSettle`'s retryable `else` ⇒ the item goes back to
   *      `queued` ⇒ the row **permanently reads 「待投递」("pending delivery")**, while
   *      the message is sitting right there on the user's PC;
   *   ③ `injectVerdictNote`'s four-language human copy (`inject_note_strings.dart`) —
   *      `error_code_copy_binding_test.dart` will demand it by name, because
   *      `author != 'none'` is exactly its reachability predicate.
   * ⚠️ Conversely: **as long as this line stays `'none'`, not one character of those
   * three places may change** — writing copy for a code that can never reach the UI
   * is building a façade on the copy surface (that test's fourth assertion exists to
   * go red for exactly this).
   */
  PC_IMAGE_STORE_FAILED: 'none',

  // ── PC-authored injection-segment verdict ⇒ delivery segment done (success) ─
  // Every emit lives under apps/desktop/src-tauri/src and reaches `inject:result`
  // via `wire::build_inject_result` (`socket/client.rs` — two
  // `socket.emit(events::INJECT_RESULT, …)` call sites: the pipeline one that
  // ships `minted.result`, and the admission one that ships `refused`).
  //
  // ⚠️ ANCHORS ARE SYMBOLS, NOT LINE NUMBERS (DOC-HYG, 2026-08-09
  // [measured·dev-pc-b]). Measured before removal: every `:NNN` in this block
  // had rotted, by 2 to 176 lines. One had rotted PAST THE FILE IT NAMED
  // (`INJECT_CLIPBOARD_FAIL`, below) and one past its SYMBOL into the neighbouring
  // function (`INJECT_SELF_WINDOW_NO_INPUT`). Do not restore line numbers here:
  // nothing reddens when they go stale, and the reader who follows one lands in
  // unrelated code believing they have read the emit.
  /** `inject/pipeline.rs` `inject_text_with_probe` → `error_codes::INJECT_TARGET_INVALID` (over `INJECT_TEXT_MAX_CHARS`; keyboard never touched). */
  INJECT_TARGET_INVALID: 'pc-injection',
  /** `inject/target_probe.rs` `refusal_for` (Stage 1b's sole producer, `mode:'sendinput'`). */
  INJECT_NO_TEXT_TARGET: 'pc-injection',
  /** `inject/sendinput_outcome.rs` `map_sendinput_outcome`, the `Err(send_err)` arm → `error_codes::INJECT_SENDINPUT_FAIL` (the only production emit; that file's other mentions are its header comment, a doc comment on the mapping, and one test assertion). */
  INJECT_SENDINPUT_FAIL: 'pc-injection',
  /**
   * `inject/clipboard_outcome.rs` → `error_codes::INJECT_CLIPBOARD_FAIL`, from
   * `map_image_outcome` (two arms — the offer dropped unrendered, RV-39/F-4, and
   * the paste error) and from `map_clipboard_outcome` (the text path);
   * `inject/clipboard_paste.rs` `ClipboardFallbackClient::paste_text` carries the
   * doc comment naming the code («a restore failure always wins»), not an emit.
   * 🔴 DRIFT ON RECORD (DOC-HYG, 2026-08-09 [measured·dev-pc-b]): this entry
   * used to read 「`inject/pipeline.rs` … at :560 (image path) and :656
   * (`run_clipboard`)」. `pipeline.rs` emits this code NOWHERE today — a repo-wide
   * grep for `error_codes::INJECT_CLIPBOARD_FAIL` does not name that file at all,
   * and its only remaining mention there is one header-comment line. The citation
   * had rotted past its file, which is why the replacement is a symbol and not a
   * corrected number.
   */
  INJECT_CLIPBOARD_FAIL: 'pc-injection',
  /** `inject/pipeline.rs` `inject_image_with_probe` → `error_codes::INJECT_IMAGE_UNSUPPORTED` (image decode failure); `inject/image.rs` `ImageError::reason` carries a doc comment on the code, not an emit. */
  INJECT_IMAGE_UNSUPPORTED: 'pc-injection',
  /** `inject/pipeline.rs` `stage1_focus` → `error_codes::INJECT_FOCUS_LOST` (two arms). */
  INJECT_FOCUS_LOST: 'pc-injection',
  /**
   * Defined at `inject/preflight.rs` `deferred_outcome` →
   * `error_codes::INJECT_DEFERRED_NOT_AUTOINJECTED`
   * (call site: the `inject::deferred_outcome(req.origin)` gate in
   * `socket/inject_ops.rs`).
   * 📌 **This is the precedent for this whole table**: L8 already carved out a
   * dedicated 「结算成 delivered」("settle as delivered") branch for it in
   * `delivery_outbox_settle.dart`, with a rationale that is, word for word, this
   * table's rule. What this card does is **turn that one hardcoded special case into
   * a decidable rule**, instead of continuing to add one case per code.
   */
  INJECT_DEFERRED_NOT_AUTOINJECTED: 'pc-injection',
  /**
   * `inject/preflight.rs` `self_window_no_input` builds the outcome carrying
   * `error_codes::INJECT_SELF_WINDOW_NO_INPUT`; its sole production caller is
   * `self_window_stage0` in the same file, on the `SelfFocusVerdict::
   * OwnWindowNoInput` arm (owner 2026-08-02 F1a reverse ruling — third cause of
   * `cached`).
   * 🔴 **`pc-injection` is the least doubtful entry in this table**: the verdict is
   * made by the PC **inside its own process** — the foreground window IS FlowMic
   * itself (`GetForegroundWindow` + `GetCurrentProcessId`), and the WebView states
   * outright where its DOM focus is (`inject/self_focus.rs`). **The frame obviously
   * reached the PC**, it is sitting in that machine's memory; only the injection
   * stage failed to happen.
   * ⚠️ To the phone it is **the same class** as `INJECT_FOCUS_LOST` (both are the
   * PC's own answer ⇒ delivery segment finished), and what needs to stay separate
   * between them is the wording on **the PC's own two UI surfaces**, not the
   * authorship in this table.
   */
  INJECT_SELF_WINDOW_NO_INPUT: 'pc-injection',
  /**
   * Error code 63 (owner-approved 2026-08-07). macOS secure event input is on.
   * Emitted by `inject/preflight.rs` `synthetic_input_verdict` (the `facts
   * .secure_event_input` arm), reached from `inject/pipeline.rs`
   * `synthetic_input_preflight()` on the text path AND the image path.
   */
  INJECT_SECURE_INPUT_ACTIVE: 'pc-injection',
  /**
   * Error code 64 (owner-approved 2026-08-07). No macOS Accessibility grant.
   * Same producer, the `!facts.accessibility_trusted` arm, checked FIRST.
   *
   * ── 🔴 WHY BOTH 63 AND 64 GET THE SAME ANSWER HERE ──────────────────────────
   * The decision doc's step 2 asked for them to be declared DIFFERENTLY, because
   * owner's table gives them opposite QUEUE semantics (63 transient/retryable,
   * 64 standing/terminal). They are nevertheless the same value in THIS table,
   * and the reason is what this table is for.
   *
   * This field answers ONE question — 「谁、在哪一层作出了这份裁决」("who, and at which
   * layer, made this verdict"). Read off the
   * producer rather than assumed: `synthetic_input_preflight()` is called from
   * INSIDE the pipeline (`inject/pipeline.rs`, text path and image path), i.e.
   * after admission, in the PC's own process, from two OS reads. So for both
   * codes the answer to this table's question is the same answer, and it is
   * `pc-injection`. Declaring either one `pc-admission` to buy queue semantics
   * would be FALSE — that value means 「它从没跑注入段」("it never reached the
   * injection stage") (see its doc above) — and
   * would make one field answer two questions, this repo's #1 bug shape, in the
   * table whose entire job is one meaning per key.
   *
   * ⇒ 🔴 **Segment ① (phone→PC delivery) SUCCEEDED for both.** Both stamp
   * `mode: InjectMode::Cached` with `ok:false`, and `row_transit::mint_row` mints
   * the PC's timeline row from the same expression that produced the verdict
   * (`socket/client.rs`) — the frame is demonstrably on that machine. The outbox
   * must NOT re-send either one.
   *
   * ── 🔴 OWNER'S 63-IS-RETRYABLE RULING IS **NOT** IMPLEMENTED HERE. OPEN. ────
   * This is registered as an open account rather than quietly absorbed, because
   * the gap is a MISSING DIMENSION and not a judgement call.
   *
   * owner 2026-08-07 ruled 63 transient ⇒ 「下一次排空应当再试」("the next drain should
   * retry") and 64 standing ⇒ 「不许无限重投」("unlimited resends are not allowed").
   * This table cannot carry that, and the reason is structural:
   * its members are defined by WHICH SEGMENT the verdict speaks about (see
   * `pc-admission`'s own doc: its difference from `pc-injection` is not 「谁说的」
   * ("who said it"), but which segment it speaks about). The queue consequence
   * FOLLOWS from the segment; it is not the
   * encoded question. Both 63 and 64 were authored at the same segment, so the
   * only way to give them different values here is to make one value ALSO answer
   * 「队列还欠不欠」("does the queue still owe this") — one value, two questions.
   * ⇒ Per the window lead's 2026-08-07 rule, this half is STOPPED and reported
   * rather than resolved by inventing a member. What is landed is the half that
   * is not in dispute: both codes converge the queue (the failure being prevented
   * is permanently 「待投递」("pending delivery") from a closed set that does not
   * recognise the code).
   *
   * ── WHAT DOES CARRY THE DISTINCTION TODAY ──────────────────────────────────
   * The copy, which is where it changes what anybody does: 64 names 「系统设置 ▸
   * 隐私与安全性 ▸ 辅助功能」("System Settings ▸ Privacy & Security ▸ Accessibility"),
   * 63 names leaving the secure field. `apps/mobile`
   * `injectVerdictNote()` carries the four-language form and a test pins that the
   * two sentences give DIFFERENT and CORRECT instructions. ⚠️ That is NOT a
   * substitute for the ruling above — copy tells the user what to do; it does not
   * decide what the queue does.
   *
   * 🔴 AND THE EVIDENCE THE STOPPED HALF WILL NEED, so it is not re-derived:
   *   · `refused` (the `isTerminalRefusalCode` road) means 「投递失败（未投递）」
   *     ("delivery failed (not delivered)") —
   *     `outbox_item.dart`'s own doc and `delivery_outbox_settle.dart`'s
   *     「不是 refused：refused 的意思是投递失败（未投递），在这里是假的」("not refused:
   *     refused means delivery failed (not delivered), which would be false here").
   *     Putting a `cached` code there makes the phone say 「未投递」("not delivered")
   *     about a frame that reached the PC — R11 and the 投递 ≠ 注入 ("delivery ≠
   *     injection") contract, both violated, to buy a word;
   *   · the retryable `else` road (「下一次排空应当再试」) does not retry a DELIVERY,
   *     because the delivery is already done. It re-sends a frame the PC already
   *     has, and since a `Cached` outcome is deliberately never entered into the
   *     dedup table (`socket/inject_ops.rs` guards `record` with `mode != Cached`)
   *     the pipeline runs again.
   *
   *     🔴 CORRECTION (fix-018, 2026-08-10 — measured, and it reverses the
   *     conclusion this bullet was drawing). The original sentence continued
   *     「…and mints a SECOND timeline row on the user's PC — once per drain, for
   *     as long as the condition holds」. **That is false for this path**, and it
   *     was the main argument against ever implementing owner's 63/64 split.
   *     The outbox re-sends under its FROZEN `request_id`, and `row_id`
   *     (`socket/row_transit.rs`) returns `format!("req:{rid}")` — a DERIVED id
   *     whose own doc states it exists so a replay of the same delivery
   *     「upserts the same row instead of adding a second one」. So a queue-driven
   *     re-send updates one row; it does not accumulate rows.
   *     The claim IS true of 重发("resend") / `manual_delivery`, which mint a fresh
   *     `request_id` — see the paragraph below, which is unaffected.
   *     ⇒ The cost that made an automatic retry look unacceptable does not
   *     exist. `fix-018` implements the ruled split on that basis, bounded by
   *     the live-delivery window rather than by row accumulation.
   * The mechanism that DOES retry an injection-stage refusal is 重发 / 重新注入
   * ("resend" / "re-inject"), which is user-initiated and mints a fresh
   * `request_id`. It already works for both codes: `deliveryFaceOf` puts a
   * `pc-injection` `cached` verdict on `DeliveryFace.deliveredNotInjected`, which is
   * in `retryableFace` ⇒ the row renders the 重发("resend") button.
   */
  INJECT_NO_ACCESSIBILITY: 'pc-injection',

  // ── PC-authored admission refusal ⇒ still owed ────────────────────────────
  /**
   * `socket/client.rs`, the `wire::build_inject_result` call whose `error`
   * argument is `error_codes::INJECT_NOT_PRIMARY` (`gate.open()` false ⇒ refuse
   * before `run_inject`; the result is bound as `refused`).
   * 🔴 **Deliberately not `pc-injection`**: owner 2026-08-02「被占用时……只能先记录等它退出」
   * ("while occupied……can only be recorded and wait for it to free up");
   * 15 册 §3.2「PC 忙」("PC busy") says these three codes stay out of
   * `isTerminalRefusalCode`.
   * ⚠️ It ALSO mints a row (the `row_transit::mint_row` call on that same
   * `refused` value — ruling two, 「拒收也是一个结果，所以也是一行」("a refusal is also
   * an outcome, so it is also a row")) — so 「is there a row
   * on the PC」 cannot be the delivery-done predicate; **author + layer** is.
   */
  INJECT_NOT_PRIMARY: 'pc-admission',

  // ── Relay-authored: no PC ever saw this frame ─────────────────────────────
  // Same anchor discipline as the PC block above: the socket leg is named by its
  // `answerReject('<CODE>')` call, the HTTP leg by its `error: '<CODE>'` response
  // — both grep to the emit itself and both survive the file being re-ordered.
  /** `relay.handler.ts` `answerReject('INJECT_FRAME_TOO_LARGE'|…)` / the two `error: 'INJECT_FRAME_TOO_LARGE'` responses in `http/inject-routes.ts` (the 413 carrying `max_bytes`, and the oversize arm of the parse ternary). */
  INJECT_FRAME_TOO_LARGE: 'relay',
  /** `relay.handler.ts` `answerReject(…|'INJECT_FRAME_INVALID')` / the `error: 'INJECT_FRAME_INVALID'` responses in `http/inject-routes.ts` (body unreadable, body not JSON, the parse ternary, `'this route carries source=image only'`, `'request_id required on the http ingress'`). */
  INJECT_FRAME_INVALID: 'relay',
  /** `relay.handler.ts` `answerReject('INJECT_PC_OFFLINE')` / `error: 'INJECT_PC_OFFLINE'` in `http/inject-routes.ts`. */
  INJECT_PC_OFFLINE: 'relay',
  /** `relay.handler.ts`, the inline `socket.emit('inject:result', …)` carrying `error: 'INJECT_NOT_IN_ROOM'` (no auth / not in room — usual landing after being kicked). */
  INJECT_NOT_IN_ROOM: 'relay',
  /** `error: 'INJECT_SERVER_BUSY'` in `http/inject-routes.ts` (the HTTP image ingress only, ledger full). */
  INJECT_SERVER_BUSY: 'relay',
  /** `relay.handler.ts` `answerReject('INJECT_PC_MISMATCH')` / `error: 'INJECT_PC_MISMATCH'` in `http/inject-routes.ts` (the never-cross-wire-IDs red line). */
  INJECT_PC_MISMATCH: 'relay',
  /** `relay.handler.ts` `answerReject('INJECT_PC_UNSPECIFIED')` / `error: 'INJECT_PC_UNSPECIFIED'` in `http/inject-routes.ts`. */
  INJECT_PC_UNSPECIFIED: 'relay',
  /** `socket/cloud-image-policy.ts`, the `error: 'INJECT_CLOUD_IMAGE_TOO_LARGE'` verdict → `relay.handler.ts` `answerReject`. */
  INJECT_CLOUD_IMAGE_TOO_LARGE: 'relay',
  /** `socket/cloud-image-policy.ts`, the `error: 'INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED'` verdict → same as above. */
  INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED: 'relay',

  /**
   * ⚠️ **Zero producers** (2026-08-02 repo-wide grep: `INJECT_TAURI_MISSING` only hits
   * `error-codes.ts`'s own line here, no second occurrence outside `docs/`). `'none'`
   * is **honestly recording today's fact**, not a judgement of which category it
   * 「should」 belong to. ⇒ It is the third instance of the `INJECT_NO_RECEIPT` /
   * `CLOUD_SESSION_NO_HISTORY` documented precedent (a user-visible string with no
   * producer should be retired along with its producer); **removing a code touches
   * the count guard and is the window lead's call to make** — this card only records
   * the account, it does not act on it.
   */
  INJECT_TAURI_MISSING: 'none',

  CONTROL_UNKNOWN_KIND: 'none',
  SETTINGS_SYNC_FAIL: 'none',
  SETTINGS_SCHEMA_INVALID: 'none',
  QUOTA_EXCEEDED: 'none',
  PLAN_UPGRADE_REQUIRED: 'none',
  PCS_LIMIT_EXCEEDED: 'none',
  MOBILES_LIMIT_EXCEEDED: 'none',
  ADMIN_ONLY: 'none',
  TIMELINE_BLOB_REJECTED: 'none',
  TIMELINE_WEB_READ_ONLY: 'none',
  TIMELINE_GRANT_REQUIRED: 'none',
  WEB_EVENT_NOT_ALLOWED: 'none',
  TIMELINE_RATE_LIMITED: 'none',
  HISTORY_SYNC_RETIRED: 'none',
  PASSWORD_RESET_INVALID: 'none',
} as const satisfies Record<ErrorCode, InjectVerdictAuthor>;

/** Authorship lookup. An unknown code (a new code this end doesn't recognise / a
 *  phone-local code) ⇒ `null`, **not a guess**. */
export function injectVerdictAuthorOf(code: string): InjectVerdictAuthor | null {
  return (INJECT_VERDICT_AUTHORSHIP as Record<string, InjectVerdictAuthor>)[code] ?? null;
}

/**
 * 🔴 **「这份 `ok:false` 的裁决证明投递这一段成功了吗」**("does this `ok:false` verdict
 * prove this delivery segment succeeded") —— the predicate form of 15 册 §2.0.1's first
 * line.
 *
 * ⚠️ **An unknown code is always false** — this is a deliberately chosen failure
 * direction: judging an unrecognised code as 「已投递」("delivered") would be
 * 「没做成的事说成做成了」("claiming something that didn't happen, happened") (the second
 * direction of red line R2). Judging it false only reverts to today's behaviour
 * (back to `queued`, the queue keeps owing it), which is boundedly and visibly bad.
 */
export function isPcInjectionVerdictCode(code: string): boolean {
  return injectVerdictAuthorOf(code) === 'pc-injection';
}

/** Derived views, for tests and docs to reference (**not a second list** — both are
 *  computed from the table above). */
export const PC_INJECTION_VERDICT_CODES: readonly ErrorCode[] = (
  Object.keys(INJECT_VERDICT_AUTHORSHIP) as ErrorCode[]
).filter((c) => INJECT_VERDICT_AUTHORSHIP[c] === 'pc-injection');

export const PC_ADMISSION_REFUSAL_CODES: readonly ErrorCode[] = (
  Object.keys(INJECT_VERDICT_AUTHORSHIP) as ErrorCode[]
).filter((c) => INJECT_VERDICT_AUTHORSHIP[c] === 'pc-admission');

export const RELAY_AUTHORED_INJECT_RESULT_CODES: readonly ErrorCode[] = (
  Object.keys(INJECT_VERDICT_AUTHORSHIP) as ErrorCode[]
).filter((c) => INJECT_VERDICT_AUTHORSHIP[c] === 'relay');
