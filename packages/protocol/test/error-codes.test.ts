import { describe, it, expect } from 'vitest';
import { ERROR_CODES, ERROR_CODE_LIST, getErrorMessage, type ErrorCode } from '../src/error-codes';
import { CLOUD_IMAGE_BYTES_MAX, CLOUD_IMAGE_QUOTA_MAX } from '../src/constants';

// Legacy @flowmic/shared shipped exactly 43 codes (verified by moving them
// 1:1). +1: PAIR_RATE_LIMITED (WP-R23-1 additive, 4-digit-code brute-force
// guard). +1: CLOUD_SESSION_NO_HISTORY (WP-R4-1 additive, cloud-session
// plaintext-history gate). +1: PASSWORD_RESET_INVALID (R5-WEB WP-W1 additive,
// console password-reset token failure). +1: PAIR_RELEASED (GA-08 additive, the
// PC-initiated 「断开」 reconnect-suppression verdict). +2 (GA-28/GA-29 additive,
// the two-channel capsule arbitration): PC_BUSY (a second phone is refused
// because another one holds the capsule — deliberately NOT PAIR_RELEASED, which
// claims an operator pressed disconnect) and INJECT_NOT_PRIMARY (an inject that raced
// the refusal, reported instead of dropped). The i18n redline (06/11): every code
// carries a non-empty zh-CN AND en message.
// 49 → 50: owner 2026-07-27 authorised INJECT_NO_TEXT_TARGET. A focused WINDOW
// is not a focused INPUT, and the desktop had no honest code for that verdict —
// it reported 「已注入」 for keystrokes that were swallowed.
// 50 → 53: owner 2026-07-29「按最优选择修复」. The three server-side inject
// verdicts that used to be silent drops (zod reject over the image cap, zod
// reject for any other malformed frame, and relay finding no PC in the room)
// now carry honest codes on a server-authored inject:result:
// INJECT_FRAME_TOO_LARGE / INJECT_FRAME_INVALID / INJECT_PC_OFFLINE.
// 53 → 54: 2026-07-30 (image-transit RCA-v3) INJECT_NOT_IN_ROOM — the relay's auth/room
// guard was the one remaining SILENT drop (a buffered post-reconnect flush
// lands there before re-registration); it now answers instead of vanishing.
// 54 → 55: 2026-07-30 (RV-04) INJECT_SERVER_BUSY — the http image ingress
// refuses to relay a frame whose verdict it could not report (request_id ledger
// full). It first reused PC_BUSY, which made a user-visible string false: that
// code says 「另一台手机占用了这台电脑，请先在那台手机上退出转录页」 and the phone
// renders exactly that, while the fact is 「服务器这一刻接不下」 — no other phone,
// nothing to leave. A rare path is not a licence to say something untrue.
// 55 → 56: 2026-07-30 (owner real-device, 0.2.19 re-verification) INJECT_NO_RECEIPT — the desktop's
// read-back `Unreadable` verdict had NO code at all, so the capsule rendered it as
// 「未注入 · 已缓存」 while the text was visibly sitting in the browser's input box.
// 56 → 55: 2026-07-30, LATER THE SAME DAY — INJECT_NO_RECEIPT REMOVED (card N1).
// It lasted one release because it was a patch on the wrong layer: it existed to
// give a nicer sentence to the read-back's 「读不回来」 verdict, and owner then ruled
// the whole read-back away (`injected` = 「已送到键盘焦点，且当时焦点处于可输入状态」 —
// docs/decisions/2026-07-30-injected-means-delivered-to-keyboard-focus.md). No
// branch can emit it now. A user-facing string with no producer is a façade on the
// protocol face — this repo's headline bug class — so it goes with its producer
// rather than lingering as a code someone will one day 「reuse」 for a different
// question. Removals are as legitimate as additions here; the guard is a guard
// against DRIFT, not a ratchet.
// 55 → 56: 2026-07-31 (window A, owner's no-cloud-sync architecture ruling) HISTORY_SYNC_RETIRED —
// the server stops storing transcripts and `transcript_history` is dropped, but the
// four history:* handlers STAY, purely so a client still running 0.2.26 hears why its
// frame did nothing. An unregistered event is silently dropped, and silence is the red
// line. Reusing a neighbour was considered and rejected in both directions:
// SETTINGS_SYNC_FAIL promises 「已保存本地」 (now permanently false) AND is the very code
// the phone decodes into 「对方删了这一行」, so reuse would delete the user's local row to
// report a server-side retirement; CLOUD_SESSION_NO_HISTORY blames the session type,
// which stops being the reason once EVERY session is barred. Same lesson as the 0.2.18
// PC_BUSY reuse: a code is a sentence, and half-true sentences cost more than a code.
// 56 → 55: 2026-07-31, SAME ROUND — CLOUD_SESSION_NO_HISTORY REMOVED. It had exactly
// one producer, the cloud-session gate that refused history:create for a 「云端实例」
// pairing, and this round's retirement swallowed that gate: no session of ANY type
// writes server history now, so the sentence "云端会话不在服务器保存历史记录" stopped
// being the reason and started being a code with zero producers while the phone still
// rendered it. Second time this exact call has been made (INJECT_NO_RECEIPT above),
// and the reasoning is the same one written there: a user-facing string with no
// producer is a façade on the protocol face, and the harm is that someone reuses it
// later for a different question. NET FOR THE ROUND: 55 → 56 → 55 — one code retired,
// one added, the catalog the same size. The guard is against DRIFT, not a ratchet.
// 55 → 56: 2026-07-31 (卡 P, owner's iron rule 「投递 id 与目标 PC 的 id 必须对应，不能串」)
// INJECT_PC_MISMATCH — the frame named a target PC that is not the PC on this
// connection, so it is REFUSED rather than re-routed. Reuse of INJECT_TARGET_INVALID
// was considered and rejected: that code answers 「这个目标窗口/这一行有问题」 (its one
// producer is the desktop pipeline, and its sentence sends the user to fix the window
// in front of them), while this one answers 「你要送的那台不是这台」 — nothing is wrong
// with the target and nothing the user does to it helps. Same lesson as the 0.2.18
// PC_BUSY reuse: a code is a sentence.
// ⚠️ It is added with ZERO producers — the server-side check is 卡 S, one card later
// in the same wave. That is the opposite case from the two removals above (codes that
// OUTLIVED their producer); the rule that keeps it honest is written at the code
// itself: if the wave ships without that check, this code is removed with it.
// 56 → 57: 2026-07-31 (window B3, 0.2.33) INJECT_PC_UNSPECIFIED — the frame named NO
// target PC. That was a KNOWN compatibility gap until this round (a 0.2.28 phone
// could not stamp `target_pc_id`, so the two ingresses forwarded an address-less
// frame unchecked and merely logged it); 0.2.32 senders stamp it on all four
// emission paths, so absence became a protocol violation and the gap closed as a
// NAMED refusal. Two calls were made here and both are the same lesson:
//   · not `required` in the schema — that kills the frame at the zod boundary and
//     the sender hears 「发送的数据不符合协议」, an anonymous verdict about a frame
//     whose ONE problem is nameable. Parse it, then refuse it by name (the
//     HISTORY_SYNC_RETIRED precedent: retire a tolerance out loud, never by making
//     the old shape unparseable);
//   · not a second branch into INJECT_PC_MISMATCH — that code says 「你要送的那台
//     不是这台」 about a sender that HAS an address, and has no imperative because
//     there is nothing for the user to do. This one says 「你没说要送给哪台」 and
//     its whole point is the imperative (update the phone). Reusing it would claim
//     a target the frame never named. A code is a sentence — 0.2.18 PC_BUSY.
// ⚠️ Unlike INJECT_PC_MISMATCH, this code ships WITH its producers: both ingresses
// emit it in the same round (relay.handler.ts, http/inject-routes.ts), pinned by
// apps/server-core/test/relay-pc-target.test.ts + inject-image-upload.test.ts.
// 57 → 59: 2026-08-01 (RV-87, owner「服务器统一拦客户端」+「限制到 200 张」)
// INJECT_CLOUD_IMAGE_TOO_LARGE + INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED — the relay
// channel's two image refusals. TWO codes rather than one 「云端拒收了这张图」,
// because the actions differ: too-large is fixed by switching to the LAN and never by waiting;
// over-quota is fixed by waiting and never by choosing another picture. Neither
// reuses a neighbour, and both rejections were deliberate:
//   · INJECT_FRAME_TOO_LARGE says 「图片数据超过上限，电脑侧未接收」 — a statement
//     about the WIRE cap, true on BOTH channels, so it would send a relay user off
//     to find a smaller picture when the LAN would carry the one they have;
//   · QUOTA_EXCEEDED says 「本月套餐用量已达上限」 and exists so that PAYING RAISES
//     IT (billing/quota-guard, plan STT/LLM budget). This ceiling is anti-abuse and
//     no plan raises it — reusing it would show an upgrade prompt to a user for whom
//     upgrading changes nothing.
// Both ship WITH their producer in the same round (server-core
// billing/cloud-image-policy.ts → socket/handlers/relay.handler.ts), pinned by
// apps/server-core/test/cloud-image-policy.test.ts + relay-cloud-image.test.ts and
// by verify/golden/g15-cloud-image-policy.mjs over a real saas server.
// 59 → 60: 2026-08-02 (owner ruling 「补投的消息不许自动注入」, L8)
// INJECT_DEFERRED_NOT_AUTOINJECTED — the PC received the frame, had a live focused
// window, and deliberately did not type it because `inject_origin:'deferred'` said
// no user was expecting it. NOT a failure: 投递成功 + 未注入·已缓存, which is the
// 投递/注入 two-segment split at its sharpest.
// Neither neighbour would do, and the rejections are the usual test (does it send
// the user somewhere different?):
//   · INJECT_FOCUS_LOST is the OTHER cause of `cached` and its action is 「点进输入
//     框」 — which does nothing here, because the refusal is a policy about WHO
//     asked, not about the window. 15 册 requires the two causes to stay apart;
//   · INJECT_NOT_PRIMARY blames another phone's session; nothing is occupied here.
// It is a CODE and not a new additive field on inject:result on purpose: `error` is
// a known key of InjectResultSchema, so a relay older than this round forwards it
// verbatim, whereas an unknown key is stripped in flight — and the phone's outbox
// terminal decision must not depend on a deploy.
// 60 → 61: 2026-08-02 (owner F1a reversal ruling 「FlowMic 自家输入框必须能注入」)
// INJECT_SELF_WINDOW_NO_INPUT — the window in front of the user is FlowMic's own and
// nothing in it holds an editable focus. `cached`'s THIRD cause, and the first one
// whose judgement is PRECISE: our own window is our own process, so the WebView can
// say which element has DOM focus and the 2026-07-30 cross-process boundary
// (「判不了就打字」) does not apply to it.
// The same round makes the POSITIVE case work — a caret in a FlowMic input box is
// typed into like any other target, with `injected` meaning exactly what it means
// everywhere else (injected must never be allowed two meanings).
// Neither neighbour would do, by the usual test (does it send the user somewhere
// different?):
//   · INJECT_FOCUS_LOST cannot NAME the window it failed to reach; this one names it
//     and it is on screen. Its advice 「点进一个输入框」 is about an app we could not
//     identify, and here we can;
//   · INJECT_DEFERRED_NOT_AUTOINJECTED means 「对窗口做什么都没用」. This one is fixed
//     by the window — the exact opposite instruction (15 册 §2.5e-4);
//   · INJECT_NO_TEXT_TARGET rides mode:'sendinput' ⇒ status `failed`, and owner's
//     ruling for this case is 未注入 · 已缓存.
// ZERO wire-shape change and NO relay redeploy: `error` is a known key of
// InjectResultSchema, so every relay forwards the string untouched.
// 61 → 62: 2026-08-07 (owner approved, docs/decisions/2026-08-07-owner-grants-error-
// code-62-compose-output-rejected.md) COMPOSE_OUTPUT_REJECTED — W2.5 added a runtime
// output guard for translate/organize, and refusing to deliver a model's output is a
// fact no existing code could state truthfully: the model responded, the key was
// fine, nothing timed out, and the output was not empty.
// Neither neighbour would do, by the usual test (does it send the user somewhere
// different?):
//   · LLM_INVALID_MODEL 「指定的模型不可用」 sends the user to configure a model that is
//     already configured and working — it names a fault that does not exist. It is the
//     worst available reuse, not the best;
//   · COMPOSE_EMPTY_OUTPUT already owns a TRUE sentence for a different fact
//     (「AI 返回了空结果」 — 🔴 CORRECTED 2026-08-07: this used to quote 「AI 什么
//     都没返回」, which is not the real string; the real one lives in
//     apps/mobile/lib/src/settings/strings/compose_strings.dart under
//     `case 'COMPOSE_EMPTY_OUTPUT'` (symbol anchor, not a line number: IT-50).
//     Also note
//     COMPOSE_EMPTY_OUTPUT is a mobile-local code, not a key of ERROR_CODES);
//     reusing it trades a true sentence for a false one.
// ZERO wire-shape change and NO relay redeploy: `ComposeErrorSchema.code` is
// `NonEmpty`, not a closed enum, so the frame shape is untouched and `whitelist=54`
// does not move.
// 62 → 64: 2026-08-07 (owner approved, docs/decisions/2026-08-07-owner-grants-mac-
// injection-refusal-codes-63-64.md) INJECT_SECURE_INPUT_ACTIVE (63) and
// INJECT_NO_ACCESSIBILITY (64) — the two macOS conditions under which the window
// server silently swallows a synthetic keystroke. Both are produced by
// `apps/desktop/src-tauri/src/inject/preflight.rs` `synthetic_input_verdict`,
// reached from `inject/pipeline.rs` `synthetic_input_preflight()` on BOTH the text
// and the image path, and both stamp `mode:'cached'` — the delivery SUCCEEDED and
// only the injection was withheld, so neither sentence may read as 「没送到」.
// Neither could borrow a neighbour, and the reason is stronger than vagueness —
// every candidate is FALSE here: INJECT_NO_TEXT_TARGET (a password field IS
// editable and IS focused), INJECT_CLIPBOARD_FAIL (the pasteboard write succeeds;
// the ⌘V after it is what vanishes), INJECT_FOCUS_LOST (the focus is exactly where
// we want it), INJECT_TARGET_INVALID (merely vague, but already spoken for by the
// length cap ⇒ one code, two questions).
// The two are not folded into each other either, by the usual test (does it send
// the user somewhere different?): 63 is undone by leaving a field, 64 only in
// System Settings and it holds for every app until then — which is also why
// `synthetic_input_verdict` checks 64 first.
// ⚠️ 64's NAME IS SHORT ON PURPOSE: the phone truncates a raw code at 28 chars
// (`chat_message_tile.dart` `_truncateFailureReason`), and the originally drafted
// `INJECT_ACCESSIBILITY_NOT_GRANTED` is 32 ⇒ 「INJECT_ACCESSIBILITY_NOT_GRA…」, a
// verbatim repeat of the 0.2.53 release cause, on the one failure a user can fix.
// ZERO wire-shape change and NO relay redeploy for either: `error` is a KNOWN key
// of InjectResultSchema, so every relay forwards the string untouched.
// `whitelist=54` is untouched — no event was added, removed or renamed.
// 64 → 68: 2026-08-10 (owner approved group #5, docs/decisions/2026-08-10-owner-ruling-
// requests-from-lan-window.md) REGISTER_EMAIL_INVALID (65),
// LAN_CERT_PIN_MISMATCH (66), STT_NO_ENGINE_REACHED (67) and
// PC_IMAGE_STORE_FAILED (68). Each is argued at its own registration site; the
// one-line form of why none could borrow a neighbour, by the usual test (does it
// send the user somewhere different?):
//   · SETTINGS_SCHEMA_INVALID 「设置内容不合法」 answers a settings question to
//     somebody who is registering — a true fact in a false sentence, pointing at
//     a screen they are not on;
//   · every 「连不上」 wording sends a pin mismatch to network troubleshooting,
//     when the network is fine and the only cure is pairing again;
//   · STT_NETWORK_DROP 「网络中断」 sends 「我说的话去哪了」 to a WiFi check that is
//     working perfectly (and STT_CONFIG_MISSING answers a configuration question
//     for a case where an engine WAS configured);
//   · INJECT_IMAGE_UNSUPPORTED blames the PICTURE when the picture is fine and
//     the disk is not — and it is an INJECTION sentence for a STORAGE fact.
// ⚠️ ALL FOUR SHIP WITH ZERO PRODUCERS, which is the opposite of the two removals
// above and the same case as INJECT_PC_MISMATCH: the producers are carded
// (fix-020…fix-024) and depend on the registration. The rule INJECT_PC_MISMATCH
// wrote down applies unchanged — if the wave ships without a code's producer,
// that code goes with it. Their zero-producer state and the ≤28-character name
// constraint are pinned by test/approved-codes-2026-08-10.test.ts.
// ZERO wire-shape change for the four codes (`error` is a known key of
// InjectResultSchema; `SttErrorSchema.code` is `NonEmpty`), and `whitelist=54` is
// untouched. The same round widens `AudioAutoStoppedSchema.reason` by one value —
// a payload field, not an event, and the one non-purely-additive part of the
// round, argued at the value itself.
// 🔴 68 → 69 on 2026-08-12 (card A2-3): `ACCOUNT_RESTRICTED`. Owner approved
// adding a code for 「限制使用」 (owner-web-rulings/latest.md:71 + the design's §8
// gate 2); the lead ruled the NAME on 2026-08-12 [owner ratification pending],
// against the superseded ban design's `ACCOUNT_SUSPENDED` — 「suspend」 is the
// English of the word owner called too authoritative, and a code name is
// user-visible copy. The argument lives at the entry in src/error-codes.ts.
// ⚠️ This number is the RUNTIME guard; `verify:lint i18n-error-keys` counts the
// same table by a DIFFERENT means (it reads the file) and must report 69 too.
// Two instruments, one fact — that is the point of not deriving one from the
// other, and CLAUDE.md's own note on this number going stale four times in a
// row is why neither of them is a sentence in a document.
// 🔴 69 → 71 on 2026-08-14 (0.2.66 PCID addressing): `PAIR_PCID_REQUIRED` and
// `PAIR_PCID_UNKNOWN`. Owner approved both on 2026-08-14 (§13 of
// docs/strategy/2026-08-14-0266-cloud-pcid-pairing-design.md; ruling recorded at
// docs/decisions/2026-08-14-owner-cloud-pairing-requires-pcid.md). The argument
// for why neither could borrow PAIR_INVALID_PAYLOAD or PAIR_INVALID_CODE lives at
// the entries themselves in src/error-codes.ts — the short form is that both
// neighbours make a claim about the CODE, while these two are about ADDRESSING,
// and the actions they name are different.
// ⚠️ Both names are ≤28 characters (18 and 17) — the phone's raw-code slot; see
// approved-codes-2026-08-10.test.ts for why that is a product constraint and not
// a naming preference.
// 🔴 71 → 72 on 2026-08-17 (WP-2 card C1): `STT_POOL_NO_ROUTE`. Owner approved
// minting it (task book §3-2). The platform's STT pool was consulted, refused to
// select a route, and nothing else covered the language — a fact no existing code
// could state truthfully. The full argument lives at the entry in
// src/error-codes.ts; the short form is the usual test (does it send the user
// somewhere different?):
//   · STT_CONFIG_MISSING 「该语言尚未配置识别引擎」 is FALSE on the relay — engines
//     ARE configured — and it hands the user a task on a surface they do not own;
//   · STT_NO_ENGINE_REACHED is for 「a route WAS selected and the audio reached
//     none of them」, so its 「say it again」 advice re-runs the same refusal here.
// ⚠️ Name is 17 characters, inside the phone's 28-char raw-code slot.
// ZERO wire-shape change (`SttErrorSchema.code` is `NonEmpty`, not a closed enum)
// and `whitelist=54` is untouched.
const EXPECTED_ERROR_CODE_COUNT = 73;

describe('error-code catalog guard', () => {
  it(`holds exactly ${EXPECTED_ERROR_CODE_COUNT} codes`, () => {
    expect(ERROR_CODE_LIST.length).toBe(EXPECTED_ERROR_CODE_COUNT);
    expect(Object.keys(ERROR_CODES).length).toBe(EXPECTED_ERROR_CODE_COUNT);
  });

  it('every code has a non-empty zh-CN AND en message', () => {
    for (const code of ERROR_CODE_LIST) {
      const entry = ERROR_CODES[code];
      expect(entry.zh_CN.trim().length, `${code} zh_CN`).toBeGreaterThan(0);
      expect(entry.en.trim().length, `${code} en`).toBeGreaterThan(0);
    }
  });

  // RV-87. A refusal that quotes a number is only honest while that number is the
  // one the server refuses at. These two sentences hard-code 「1 MB」 and 「200 张」
  // (they must — an ERROR_CODES entry is a static string, and the alternative,
  // dropping the numbers, would leave the user unable to tell how much to shrink
  // or how long to wait). So the drift is caught here instead of in production.
  it('🔴 the cloud-image refusals quote the limits they are actually enforced at', () => {
    // 1 MiB rendered the way the phone's 1024-based formatBytes renders it, which
    // is the number the user reads on their own row.
    const mib = CLOUD_IMAGE_BYTES_MAX / 1024 / 1024;
    expect(mib, 'CLOUD_IMAGE_BYTES_MAX is no longer a whole number of MiB — the copy says 「1 MB」').toBe(1);
    for (const locale of ['zh_CN', 'en'] as const) {
      expect(
        ERROR_CODES.INJECT_CLOUD_IMAGE_TOO_LARGE[locale],
        `${locale} copy must name ${mib} MB`,
      ).toContain(`${mib} MB`);
      expect(
        ERROR_CODES.INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED[locale],
        `${locale} copy must name ${CLOUD_IMAGE_QUOTA_MAX}`,
      ).toContain(String(CLOUD_IMAGE_QUOTA_MAX));
      // 24h is the lead's stated ASSUMPTION about owner's 「200 张」 (constants.ts
      // CLOUD_IMAGE_QUOTA_WINDOW_MS). If owner corrects it, this line is what
      // makes the copy change part of the same edit.
      expect(
        ERROR_CODES.INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED[locale],
        `${locale} copy must name the window`,
      ).toContain('24');
    }
  });

  it('getErrorMessage resolves both locales', () => {
    const sample: ErrorCode = 'AUTH_TOKEN_INVALID';
    expect(getErrorMessage(sample, 'zh-CN')).toBe(ERROR_CODES[sample].zh_CN);
    expect(getErrorMessage(sample, 'en')).toBe(ERROR_CODES[sample].en);
  });
});
