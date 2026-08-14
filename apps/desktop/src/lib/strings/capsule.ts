// S string catalogue shard: capsule HUD (target / session / injection not
// completed / STT diagnostics / online status).
// Merged and exported by ../strings.ts.
// V2-07.8a/8b: per-locale catalogue (zh-CN baseline + en/ja/ko).
//
// 🔴 卡 L7 / owner 2026-08-02 — two-segment terminology (docs/rebuild/15 §2.0):
//   ① phone → PC        = **delivery** (delivered / pending delivery / undelivered)
//   ② PC → focus window = **injection** (injected / delivered / not injected · cached / not injected)
// The capsule runs on the PC, and every face it shows speaks segment ②
// ⇒ **not a single segment-① word is allowed to appear here**.
//
// ⚠️ Line ② above changed on 2026-08-07 (IJ-02): the original text was
// 「注入成功 / 未注入 · 已缓存 / 注入失败」. Owner made two rulings that day —
// **delete 「注入失败」** (`st_failed` is now「未注入」), **split「已注入」into
// two words by ③-evidence** (`st_injected` / `st_delivered`).
// Ruling doc = docs/decisions/2026-08-07-owner-inject-status-wording-evidence-and-window-title.md.
//
// ⚠️ This paragraph used to say 「the capsule says the SAME four delivery faces as the phone
// (✓ 已注入 / ⏳ 投递中 / 📥 未投递 / ✗ 未成功) …… matching mobile's
// statusInjected / statusDelivering / statusUndelivered / statusFailed」.
// **That sentence — 「与手机词表对齐」("aligned with the phone's word list") —
// is itself the defect; the original text is kept as a correction record**:
// for the sake of matching glyphs on both ends, it moved the phone side's
// (segment ①) word onto the PC side (segment ②) — so a frame that **had
// unmistakably already reached the PC** (otherwise this PC would have no
// way to know about this utterance) was reported by the capsule as「未投递」.
// Owner hit this on a real device on 2026-08-02 and ruled on the spot to
// split the two segments. **The two ends now deliberately no longer share a
// word list**: the phone speaks delivery, the PC speaks injection.
//
// `noted` is intentionally absent here (capsule never surfaces record-only).
import { getLocale } from './locale';
// 🔴 Same-origin, not a copy (docs/rebuild/15 §2.5c): `cap_cached` and the
// timeline's `st_cached` describe **the same state**; previously the two
// were each written independently and drifted apart for a whole version
// with nobody noticing. Copying an identical string today will just drift
// apart again tomorrow ⇒ the only enforceable fix is a **reference**.
// Guard = apps/desktop/src/capsule/capsule-timeline-one-word.test.ts (exact
// match across all four languages).
//
// 🔴 2026-08-07 (IJ-02 §C-3) — **of the rule above, only `cap_cached` had
// actually followed it**; the other two were 「假同源」("fake same-origin"):
//   · `cap_injected` used to be the standalone literal '已注入', which was
//     **only coincidentally equal** to `st_injected` ⇒ whoever changed the
//     wording would only touch one of them, the other wouldn't follow, and
//     both would still look correct;
//   · `cap_inject_failed` used to be '未成功', while `st_failed` was
//     '注入失败' ⇒ **the same event described by two different words on two
//     PC surfaces — exactly the violated state 15 册 §2.5c was written
//     against** (this particular case isn't in the design doc; it was found
//     during W9's real-device testing).
// Both have since been changed to **references**. The guard needs both
// halves: `===` asserts value equality, and a source-grep asserts
// 「是引用不是抄一份」("it's a reference, not a copy") — pasting in a literal
// that happens to be equal today is the only thing the latter will catch.
//
// 🔴 Correction (2026-08-14, nine-locale migration): the line above,
// 「源码 grep 断『是引用不是抄一份』」("a source-grep asserts 'it's a reference,
// not a copy'"), is talking about the `cap_injected:
// TIMELINE_STRINGS['zh-CN'].st_injected` that used to be written in this
// file — those four lines **are no longer here**; the original text is
// kept because it records how this rule came to be. The reference
// relationship is now **data**: those four keys in
// `i18n/desktop/leaves.json` carry `sameAs`, and **their value must not
// appear in any language's data file** (the generator will reject it); the
// generated output resolves per language into `S_XX_OWN.st_injected`.
// ⇒ "copying a string" went from "a guard turns red" to "there's nowhere
// left to write a second copy," and nine languages each writing their own
// copy is exactly the shape most likely to bring it back. The guard itself
// hasn't gotten weaker: the assertion moved from grepping this file to
// grepping that data.
import { shardCatalogue } from './shard';
import { INJECT_FAIL_REASON_BY_LOCALE } from './generated/catalogue.g';

export const CAPSULE_KEYS = [
  // capsule
  'cap_target_none',
  /** GA-25: the header「→ 目标」slot when there is no injectable foreground (our
   *  own window / the shell desktop / a titleless window). Same em-dash the phone
   *  header uses (B4「→ —」) — never a fabricated destination. */
  'cap_target_dash',
  'cap_locked',
  // 🔴 Referenced, not copied (see file header). This green face and the
  // timeline's ✓ describe the same state.
  'cap_injected',
  /** 🔴 甲-3's weak tier, the other half of the green face (owner 2026-08-07).
   *
   *  **Why the capsule must split too**: this face and the timeline row are
   *  describing **the same `inject:result`**. Splitting only in the
   *  timeline would produce 「胶囊说已注入、时间线说已送入」("the capsule says
   *  injected, the timeline says delivered") — **exactly the shape of
   *  0.2.1's 「两处各写各的」("each side writes its own") defect**, and
   *  exactly why this file and capsule-timeline-one-word.test.ts exist
   *  (15 册 §2.5c). ⚠️ This particular case isn't in the design doc — it
   *  was found when W9 landed.
   *
   *  ⚠️ The capsule does **not** follow along with the ③-evidence
   *  parenthetical: this card is a CSS fixed-height row
   *  (lib/capsule-morph.ts `CAPSULE_HEIGHT.just_injected` is an exact
   *  value, not an estimate), and that parenthetical half belongs to the
   *  **durable surface** — the timeline row states the full sentence.
   *  **The word must match; the level of detail can differ** — §2.5c
   *  governs 「同一个状态两处不许两个词」("the same state must not get two
   *  different words on two surfaces"). */
  'cap_delivered',
  /** ⏳ — still speaking this sentence / still waiting on `inject:result`.
   *
   *  🔴 卡 L7: the old word was 「投递中」("delivering"), which is the
   *  segment-① (phone→PC) word, while the stage this face covers is
   *  **waiting on the PC's own injection verdict** — the frame had already
   *  reached the PC long before this (the capsule runs on this very PC; it
   *  raises this face from its own `audio:start`). This is the second
   *  instance of **the same mistake** as `cap_cached`, corrected together
   *  under 15 册 §2.5c. Distinct from cap_cached (📥 the verdict has already
   *  said it didn't get injected). */
  'cap_delivering',
  'cap_image_open',
  'cap_chars',
  'cap_secs',
  'cap_seg',
  /** Default capsule session label when the paired-mobile directory cannot name
   *  exactly one online phone (zero, or ≥2 — naming one of several is a guess).
   *  See capsule/controller.ts `deriveSessionTitle`; 卡 D-a corrected this doc,
   *  which used to cite an `audio:start.device_label` that does not exist. */
  'cap_session_default',
  'cap_reconnect',
  'cap_diag',
  'cap_settings',
  'cap_dismiss',
  // owner 2026-07-27: the × is refused mid-utterance, and says so rather than
  // looking broken.
  'cap_dismiss_busy',
  // capsule inject flash (R6-R1 / RV-43 §4 — no silent failure)
  // ✗ — the premise did not hold or the action did not go through.
  //
  // 🔴 Referenced, not copied. Previously this was the standalone literal
  // '未成功' while the timeline said '注入失败' — one thing, two words,
  // 15 册 §2.5c violated (see file header). Owner then removed 「失败」
  // ("failure") entirely on 2026-08-07 ⇒ both sides are now `st_failed`,
  // one definition.
  'cap_inject_failed',
  // 📥 — inject:result{mode:'cached'}: this PC received it, but couldn't
  // inject it into the focus window; the content stays on the timeline and
  // can be injected again.
  //
  // 🔴 卡 L7 — the old value was the literal '未投递', which is a
  // **segment-①** word, while this is segment ②: the frame has already
  // reached this PC (otherwise this face wouldn't appear at all). The
  // correct word already exists on this same machine — it's `st_cached` ⇒
  // **reference it, never copy it again** (15 册 §2.5c).
  'cap_cached',
  'cap_reason_unknown',
  // capsule STT diagnostic row (R6-R2 — honest engine status, no fake green)
  'cap_stt_label',
  'cap_stt_unknown',
  'cap_stt_ready',
  'cap_stt_reconnecting',
  'cap_stt_failed',
  'cap_phone_present',
  'cap_online',
  'cap_offline',
  'cap_socket',
  'cap_socket_ok',
  'cap_socket_down',
] as const;

// Notes that were recorded against a TRANSLATION rather than against the
// key itself. Carried across verbatim (only the language tag is new): they
// explain a rendering choice in one language, and the block they lived in
// is now a data file that cannot hold them.
// [en] Referenced, not re-spelled — same one definition as the timeline's ✓.
// [en] 甲-3's weak half. Split HERE too, or the capsule and the timeline would say
// [en] two different words about one verdict — see the zh-CN block.
// [en] 卡 L7: was 'Delivering' — a segment-① word on a segment-② face. See zh-CN.
// [en] Unit suffixes (template: `{{ n }} {{ S.cap_chars }} · {{ s }} {{ S.cap_secs }}`).
// [en] Was the standalone literal 'Not successful' while the timeline said
// [en] 'Injection failed' — one thing, two words (15 册 §2.5c). Now referenced.
// [en] 卡 L7: was 'Not delivered' (segment ①). Same one definition as st_cached.
// [ja] Referenced, not re-spelled — same one definition as the timeline's ✓.
// [ja] 卡 L7: was 「送信中」(segment ①). See zh-CN.
// [ja] Was the standalone literal 「未成功」 while the timeline said 「注入失敗」.
// [ja] Now referenced — and 「失敗」 is gone from both (owner 2026-08-07).
// [ja] 卡 L7: was 「未送信」(segment ①). Same one definition as st_cached.
// [ko] Referenced, not re-spelled — same one definition as the timeline's ✓.
// [ko] 卡 L7: was 「전송 중」(segment ①). See zh-CN.
// [ko] Was the standalone literal 「미성공」 while the timeline said 「주입 실패」.
// [ko] Now referenced — and 「실패」 is gone from both (owner 2026-08-07).
// [ko] 卡 L7: was 「미전송」(segment ①). Same one definition as st_cached.

export const CAPSULE_STRINGS = shardCatalogue(CAPSULE_KEYS);

/** inject:result.error (INJECT_* code) → human reason for the capsule failure
 *  flash (R6-R1), per locale. The code is the wire truth (build_inject_result →
 *  `error`); an unmapped/absent code degrades to cap_reason_unknown, never a
 *  fake「已注入」. Shown on the ✗ face only (whose word is `cap_inject_failed`; it read
 *  「未成功」 until 2026-08-07 and now references `st_failed`) — 📥「未注入 · 已缓存」has no
 *  reason line (卡 L7: the parenthetical used to read 「未投递 / phone parity」,
 *  and BOTH halves were the bug — see this file's header). */
// 🔴 The union of codes the PC itself authors, and the long account of why the
// reason table is typed by it, moved to ./contract.ts VERBATIM when the strings
// became data — a type that the generated catalogue implements cannot live in a
// file that imports the generated catalogue (the `circular` lint counts a
// type-only import as an edge). Nothing about the guard changed.

/** 🔴 THE CAUSES OF `cached`, AS A SET THE UI CAN ASK ABOUT (docs/rebuild/15
 *  §2.5e-4). `cached` now has THREE of them and they mean different things to the
 *  user, so 「未注入 · 已缓存」 alone is a correct-but-silent status — exactly what
 *  owner hit on 2026-08-02 and asked to have explained.
 *
 *  ⚠️ THIS IS A LIST OF CAUSES, NOT A LIST OF FAILURES. The reason line these unlock
 *  rides the 📥 amber face, never the ✗ red one; nothing here went wrong, the
 *  delivery succeeded and only the injection had nowhere to land. `INJECT_FOCUS_LOST`
 *  is deliberately absent: 「未注入 · 已缓存」 + 「未找到输入焦点」 is the same sentence
 *  twice, which is the state 卡 L7 removed the reason line for in the first place. */
export const CACHED_CAUSE_CODES = new Set<string>([
  'INJECT_DEFERRED_NOT_AUTOINJECTED',
  'INJECT_SELF_WINDOW_NO_INPUT',
  // 🔴 The two macOS preflight codes (registered as 63/64). `inject/preflight.rs`
  // `synthetic_input_verdict` returns `InjectMode::Cached` for BOTH, with its own
  // reason spelled out: the delivery succeeded and only the injection did not happen,
  // and in both cases it is undone by something the user does OUTSIDE our window —
  // which is exactly what `cached` promises. So they belong on the 📥 face.
  //
  // They were registered in the protocol and never routed here, and the effect was
  // the 📥 face drawing NO line at all — 「未注入 · 已缓存」 and nothing else, for a
  // cause the badge cannot possibly convey. That is the same 15 册 §2.5e-4 gap F1a
  // closed for the first two, re-opened by codes added afterwards.
  // ⚠️ Unlike `INJECT_FOCUS_LOST` (deliberately absent — 「未注入 · 已缓存」+「未找到
  // 输入焦点」 is one sentence twice), neither of these is inferable from the badge.
  'INJECT_SECURE_INPUT_ACTIVE',
  'INJECT_NO_ACCESSIBILITY',
]);

/** V2-07.8a: same Record shape as before, but each entry is a GETTER reading
 *  the CURRENT locale — controller.ts's `INJECT_FAIL_REASON[code] ?? …` keeps
 *  working untouched and resolves at event time. */
export const INJECT_FAIL_REASON: Record<string, string> = {
  get INJECT_FOCUS_LOST() { return INJECT_FAIL_REASON_BY_LOCALE[getLocale()].INJECT_FOCUS_LOST!; },
  get INJECT_TARGET_INVALID() { return INJECT_FAIL_REASON_BY_LOCALE[getLocale()].INJECT_TARGET_INVALID!; },
  get INJECT_CLIPBOARD_FAIL() { return INJECT_FAIL_REASON_BY_LOCALE[getLocale()].INJECT_CLIPBOARD_FAIL!; },
  get INJECT_SENDINPUT_FAIL() { return INJECT_FAIL_REASON_BY_LOCALE[getLocale()].INJECT_SENDINPUT_FAIL!; },
  // 🔴 15 册 §2.5e-4 — the two NAMED causes of `cached`. ONE definition, read by both
  // PC surfaces (the capsule flash and the timeline row's status tooltip), which is
  // §2.5c's same-origin rule: 「PC 的界面（时间线 + 胶囊）……两处同源一份字符串」
  // ("the PC's surfaces (timeline + capsule) …… the two share one string of common origin").
  get INJECT_DEFERRED_NOT_AUTOINJECTED() { return INJECT_FAIL_REASON_BY_LOCALE[getLocale()].INJECT_DEFERRED_NOT_AUTOINJECTED!; },
  get INJECT_SELF_WINDOW_NO_INPUT() { return INJECT_FAIL_REASON_BY_LOCALE[getLocale()].INJECT_SELF_WINDOW_NO_INPUT!; },
  // The four codes that had a registry entry but no reader on this end. ⚠️ This
  // getter list is HAND-WRITTEN, so a catalogue row without a getter is copy
  // production can never reach — locale-parity.test.ts asserts the two agree.
  get INJECT_NO_TEXT_TARGET() { return INJECT_FAIL_REASON_BY_LOCALE[getLocale()].INJECT_NO_TEXT_TARGET!; },
  get INJECT_IMAGE_UNSUPPORTED() { return INJECT_FAIL_REASON_BY_LOCALE[getLocale()].INJECT_IMAGE_UNSUPPORTED!; },
  get INJECT_SECURE_INPUT_ACTIVE() { return INJECT_FAIL_REASON_BY_LOCALE[getLocale()].INJECT_SECURE_INPUT_ACTIVE!; },
  get INJECT_NO_ACCESSIBILITY() { return INJECT_FAIL_REASON_BY_LOCALE[getLocale()].INJECT_NO_ACCESSIBILITY!; },
};

/** Test/guard surface (locale-parity.test.ts): raw per-locale reason tables. */
export const INJECT_FAIL_REASON_CATALOGUES = INJECT_FAIL_REASON_BY_LOCALE;
