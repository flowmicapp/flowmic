// The HAND-WRITTEN type contracts the generated catalogue implements.
//
// WHY THIS FILE EXISTS. The strings became data (i18n/desktop/<code>.json) and
// the tables became generated code (./generated/*.g.ts), but the SHAPES stayed
// authored — an interface is a decision about what the product says, and the
// reasoning beside each one is the record of that decision. Generating them
// would have thrown the reasoning away and put nothing in its place.
//
// 🔴 IT IMPORTS NOTHING FROM ./generated. That direction is the whole point:
// the generated modules import THIS file, so the graph stays acyclic (the
// `circular` lint counts a type-only import as an edge, and it is right to —
// see its header). Anything added here must keep that property.
//
// The bodies below moved VERBATIM out of capsule.ts / settings.ts / timeline.ts
// when the per-locale blocks became data; only the corrections marked 🔴 are new.

import { INJECT_VERDICT_AUTHORSHIP } from '@flowmic/protocol';

/** 🔴 EVERY CODE THE PC ITSELF AUTHORS ON AN `inject:result`, derived from the
 *  protocol's authorship table — NOT a second list (the derivation is the point).
 *
 *  ── WHY THIS TYPE EXISTS ────────────────────────────────────────────────────
 *  Nothing bound the protocol's code registry to this table, and the result was
 *  measured, not hypothetical: FOUR of the ten `pc-injection` codes had no sentence
 *  here — `INJECT_NO_TEXT_TARGET`, `INJECT_IMAGE_UNSUPPORTED`, and the two macOS
 *  codes registered as 63/64 (`INJECT_SECURE_INPUT_ACTIVE`, `INJECT_NO_ACCESSIBILITY`).
 *  Their user-visible consequence is a POINTER TO NOWHERE, which is precisely the
 *  defect lib/inject-provenance.ts documents itself as existing to remove:
 *    · a `failed` code with no entry ⇒ the capsule's ✗ face falls back to
 *      `cap_reason_unknown` = 「详见时间线」, and the timeline's tooltip answers only
 *      for `injected` / `cached` rows ⇒ the capsule points at a surface that is silent;
 *    · a `cached` code outside CACHED_CAUSE_CODES ⇒ 📥 draws no line at all.
 *  🔴 And it landed hardest on `INJECT_NO_ACCESSIBILITY`, the ONE failure on this
 *  path the user can fix themselves, on the very machine showing the empty tooltip.
 *
 *  ⇒ The table is now typed by this union, so a newly registered `pc-injection`
 *  code cannot typecheck until someone writes its PC sentence. That is worth more
 *  than the four sentences: CLAUDE.md records the same structural gap for the
 *  phone's table with the note 「下一个新码会以同样的方式变成用户屏幕上的裸标识符，
 *  而所有门禁全绿」("the next new code will turn into a bare identifier on the
 *  user's screen the same way, and every gate will still be green"). This
 *  closes it for THIS end (the phone's remains open).
 *
 *  🔴 ENFORCED IN THE PIPELINE since GATE-1 (第七册 §2.1): `verify:delivery` in the
 *  root package.json runs `verify:types:desktop` (`vue-tsc --noEmit`, with
 *  `--fail-if-no-match` so a renamed package cannot silently pass). Its POSITION is
 *  load-bearing, not stylistic — it runs AFTER `pnpm golden`, the one step that
 *  rebuilds protocol's `dist` every run (since 0.2.29), because the desktop
 *  typechecks against `dist`, not `src`. MEASURED 2026-08-07: a probe code added
 *  as `pc-injection` gave `vue-tsc` EXIT=0 with the code sitting right there, and
 *  only after rebuilding `dist` did it fail with TS2741 naming all four locale
 *  tables (CLAUDE.md's 「陈旧的 dist 会双向骗人」("a stale dist lies in both
 *  directions") on the DESKTOP end). 🔴 Move the
 *  desktop typecheck before golden and this guard reopens without a single test
 *  going red — that reordering must carry its own build step.
 *  🔴 There is deliberately NO escape hatch. If some future code truly needs no PC
 *  sentence, adding one costs a line and a reason — and having to write the reason
 *  is the whole mechanism. */
export type PcInjectionCode = {
  [K in keyof typeof INJECT_VERDICT_AUTHORSHIP]:
    (typeof INJECT_VERDICT_AUTHORSHIP)[K] extends 'pc-injection' ? K : never;
}[keyof typeof INJECT_VERDICT_AUTHORSHIP];

/** Count/compose-bearing settings messages (V2-07.8a hardcoded-value extraction). FUNCTIONS per
 *  locale — same culture as TL_BATCH_MSG: word order is per-locale, so a
 *  composed sentence lives in exactly one place. */
export interface SettingsMsg {
  /** zh `超过 40 字符` / en `Over 40 characters` — ScenarioCard term reject. */
  termTooLong(n: number): string;
  /** zh `已达 20 条上限` / en `Already at the 20-term cap`. */
  termsAtCap(n: number): string;
  /** zh `每条 ≤40 字符` / en `≤40 chars each` — the cap note under Custom Terms (自定义术语). */
  termsCapNote(n: number): string;
  /** zh `3 / 300 条` / en `3 / 300` — dictionary usage under Personal Dictionary (个人词典). */
  dictCount(n: number, cap: number): string;
  /** zh `别名：甲、乙` / en `Aliases: alpha, beta` — label + locale separator. */
  dictAliases(aliases: string[]): string;
}

/** The per-locale shape of the V2-18 batch messages. Both locales implement
 *  the SAME interface — a missing message is a compile error here and a
 *  printed key name in locale-parity.test.ts there. */
export interface TlBatchMsg {
  selCount(n: number): string;
  selImgHint(selected: number, images: number): string;
  copiedWithSkip(copied: number, skipped: number): string;
  copied(n: number): string;
  nothingToCopy(selected: number): string;
}

// 🔴 CORRECTION (2026-08-14, the English-fallback ruling). The sentence above
// says a missing message is 「a compile error here」. That was true while every
// locale hand-wrote its own block under `Record<UiLocale, TlBatchMsg>`. It is
// no longer: owner ruled that a missing translation falls back to English
// (packages/protocol/src/locales.ts, BASE_UI_LOCALE), so the generator emits an
// untranslated arm as an INHERITED English one and nothing fails to compile.
// Kept rather than rewritten — it records what the guard used to be, and the
// replacement is named: coverage is measured per language into
// i18n/desktop/coverage.json. Silent to the user, never silent to us.

// ── owner 2026-07-31 ②: 「被裁掉的行去哪了」("where did the trimmed rows go")
// must have an answer stated ────────────────────────────────────────────────
//
// The timeline is no longer a cache of server-side rows; it is the local
// machine's owner (decision docs/decisions/2026-07-31-no-cloud-sync-for-
// phone-pc.md). An owner must have a boundary — unbounded would blow up
// browser storage — and having a boundary means owing the user a sentence
// about it. **"The user thinks all their history is there, when it's
// actually already been trimmed" is the storage-surface variant of this
// repo's #1 bug shape**, so these two sentences aren't decoration:
//
//   · keptNote           = the everyday sentence (only appears once
//                          something has actually been trimmed):
//                          「现在存着 N 条，X 之前的已经从这台电脑清掉了」
//                          ("N entries are currently stored; everything
//                          before X has already been cleared from this
//                          computer");
//   · searchNoneTrimmed  = the sentence for when a search finds nothing.
//                          Without it, "no matching entries" is only half
//                          true — the range that was searched is only what
//                          this machine still has; the trimmed portion never
//                          entered the search at all.
//
// Both sentences report **facts** (how many entries remain, where the
// boundary sits), not policy (what the cap is in entries/bytes): policy
// changes across versions, while these two numbers are things the user can
// check against their own memory. Both are functions rather than strings,
// for the same reason as TL_BATCH_MSG — word order differs per locale, so a
// composed sentence can live in exactly one place.
export interface TlRetentionMsg {
  /** `kept` entries remain; everything before `when` is gone (`when` is
   *  formatted by the page with formatTimelineLabel). */
  keptNote(kept: number, when: string): string;
  /** "No matches" + the scope statement above, composed into one sentence. */
  searchNoneTrimmed(kept: number, when: string): string;
}

// ── owner 2026-08-01 §4-2 ⑧: per-entry word count ──────────────────────────
//
// 「逐条显示转录时长 + 字数」("show per-entry transcription duration + word
// count") — this card only does the word count (duration has no data
// source; see the header of lib/entry-metrics.ts). The algorithm itself
// (the mixed CJK/Latin counting rule) also lives in entry-metrics.ts; this
// is just its copy wrapper — for the same reason as TL_BATCH_MSG /
// TL_RETENTION_MSG, it's a function rather than a string: ja/ko's counter
// words have a different word order than zh/en, so a composed sentence can
// live in exactly one place.
export interface TlMetricsMsg {
  /** 「128 字」/「128 words」— the copy wrapper for entry-metrics.ts's `rowWordCount`. */
  wordCount(n: number): string;
}
