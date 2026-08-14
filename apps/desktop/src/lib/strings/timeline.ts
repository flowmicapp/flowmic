// String catalogue shard: timeline page (filters / empty state / row actions /
// source text / images / status badges). Merged and exported by ../strings.ts.
// V2-07.8a: per-locale catalogue (zh-CN baseline + en).
//
// Red-line wording cross-reference (en must state facts, must not promise
// something that hasn't happened):
//   未注入 · 已缓存 → "Not injected · buffered" — NOT "pending delivery":
//   this tile answers **segment ② (PC → focused window)**, while "pending
//   delivery" is a segment-① word.
//
// 🔴 Card L7 / owner 2026-08-02 — `st_cached` is now the ONE definition of
// this state across the **entire desktop app**: the capsule's `cap_cached`
// (lib/strings/capsule.ts) **references** it instead of writing its own copy.
// Previously the two places each wrote their own wording (here "未注入 ·
// 已缓存" / "Not injected · buffered", the capsule "未投递" / "not
// delivered") — the same machine, the same state, two different words on two
// screens, drifted for an entire version with nobody noticing. See
// docs/rebuild/15 §2.0 / §2.5c.
//
// ⚠️ This block used to also say "'pending delivery' is a promise that was
// never actually kept" — **that was true in 0.1.x, it no longer is**: since
// 0.2.33 the phone has had a persistent outbound queue (written to disk
// before sending, resumed on reconnect after a drop), so owner on 2026-08-02
// brought "pending delivery" back — **but only on the phone side**. The
// red line's spirit is unchanged (never promise something no mechanism
// fulfills); only that one specific wording mapping was swapped out. **This
// side is still not allowed to say "pending delivery"** — not because it's
// an empty promise here, but because it's a segment-① word.
import { getLocale, type UiLocale } from './locale';
import { shardCatalogue } from './shard';
import type { TlBatchMsg, TlMetricsMsg, TlRetentionMsg } from './contract';
import {
  TL_BATCH_MSG_BY_LOCALE,
  TL_METRICS_MSG_BY_LOCALE,
  TL_RETENTION_MSG_BY_LOCALE,
} from './generated/msg.g';

export const TIMELINE_KEYS = [
  // timeline
  // `tl_refresh` (the text on the "Refresh" button) was removed in 0.2.27
  // along with the button itself: the `history:list` it triggered was
  // hitting a server that **no longer stores transcripts** (owner's
  // architecture ruling), so from that moment on all it could ever fetch
  // back was "nothing". Rows now live on this machine — there is no
  // "elsewhere" to re-read from — so this isn't a rewording, it's the
  // absence of the action.
  'timeline_title',
  'filter_all',
  'filter_realtime',
  'filter_translate',
  'filter_organize',
  /** GA-20: the fifth chip REDESIGN §5.2 always listed. Image rows were
   *  renderable from the day T-4 landed; only the way to isolate them was
   *  missing. */
  'filter_image',
  'empty_timeline',
  /** owner 2026-07-27: a page that blanked because something threw must SAY so —
   *  a white rectangle reads as "no data" and that is a silent failure (red line). */
  'crash_banner',
  /** owner 2026-07-31 ③: local storage refused the write (quota / privacy
   *  mode). The timeline is now solely owned by this machine, so this
   *  message MUST fire: these rows on screen never made it to disk, and
   *  "looks like everything's fine" is the worst kind of failure. */
  'tl_store_write_failed',
  'op_copy',
  // owner 2026-07-27: on a picture row the same button copies the PICTURE. It
  // says "preview image" because that is what this end has — the original was pasted on
  // arrival and kept nowhere.
  'op_copy_image',
  'op_copy_failed',
  'tl_sender_tip',
  'tl_zoom_hint',
  'tl_zoom_close',
  'op_reinject',
  'op_makeup',
  'op_edit',
  'op_delete',
  'op_save',
  'op_cancel',
  'copied',
  'tl_confirm_delete',
  'tl_confirm_yes',
  'tl_show_source',
  'tl_hide_source',
  'tl_source_label',
  // R6 T-4 image pipeline: the row marker for an entry this PC delivered as a picture.
  // A chip, not a thumbnail — the PC never receives a retained copy of the image
  // (the bytes are pasted into the target app and dropped), so drawing a preview
  // would be inventing something we do not have.
  'tl_image_chip',
  // ── REQ-12-13 remote key-press row (owner P0 2026-08-12; contract docs/rebuild/15 §2.0-e) ──
  //
  // 🔴 **The row's wording is composed here, not composed in Rust.** The end
  // that mints the row writes only two structured fields (`control_kind` /
  // `control_outcome`), because ① a sentence hardcoded at mint time would be
  // **stuck forever in the language of that moment** (the row is persisted,
  // and the user might later change the UI language — the exact same lesson
  // that makes lib/status.ts use a getter instead of a snapshot), and ②
  // `output_text` is **the field re-injection reads from**, and a key-press
  // row must never be re-injected: that would actually type the word
  // "clear" into the user's document.
  // ⇒ There being no printable text on the row is a structural guarantee,
  // not a convention.
  'tl_control_chip',
  'ck_enter',
  'ck_backspace',
  'ck_undo',
  'ck_clear',
  'ck_tab',
  'ck_space',
  // An extra sentence about the result only appears when it **didn't get
  // sent**: the "did get sent" case is already answered by the status badge
  // (已送入 / "input sent"), so saying it again would just repeat the same
  // fact twice. Each sentence names **the precondition that failed to
  // hold**, because "why didn't this happen" is the only question this row
  // needs to answer (the same standard as ChordExit::line).
  'co_no_target',
  'co_foreground_refused',
  'co_os_refused',
  'co_send_failed',
  'co_not_primary',
  // ── 0.2.27: four sentences down to one ──
  // This used to also hold tl_fail_edit / tl_fail_delete / tl_fail_refresh —
  // three variants of "the server didn't confirm; this channel will retry
  // after reconnecting." Once the cloud stopped storing transcripts (owner's
  // architecture ruling), edit and delete became local-only writes and
  // refresh stopped existing at all — those three sentences could never
  // render again. **Leaving behind copy that can never render is a façade
  // at the copy layer** (a rule W2 already established), so this is a
  // deletion, not a rewording.
  //
  // Deferred delivery is the only action left that can still fail, and what
  // it fails at is "typing", not "syncing": this machine failed to carry out
  // the injection (no resident session available), so nothing got typed.
  // This sentence deliberately says nothing about a server — there's no
  // server left on this path — and deliberately promises no retry: deferred
  // delivery types into "whatever window currently has focus", and an
  // automatic retry a few minutes later would type into a window the user
  // never chose.
  // ⚠️ "Tried, but it didn't land" does NOT go through this sentence: that
  // is a real inject:result (ok:false), and it marks this row as
  // 未注入 · 已缓存 / 未注入 ("not injected · buffered" / "not injected") as
  // usual (before 2026-08-07 this was "injection failed"; owner removed
  // that wording — see st_failed), spoken for by that row itself (card L7:
  // the original text said "未注入／未投递" — "not injected / not
  // delivered" — but this side speaks segment ② exclusively, and a
  // segment-① word should never appear here).
  'tl_fail_inject',
  /** The ✕ on that row. "Got it", not "Cancel" — it only puts the message
   *  away, it does not attempt a deferred delivery again; calling it
   *  "Cancel" would be one more small lie. */
  'tl_fail_dismiss',
  // ── V2-18 multi-select + batch copy (owner 2026-07-28 ①②③) ──
  /** the page-head toggle that ENTERS selection mode. */
  'tl_select',
  /** the same toggle while selecting; leaves the mode. */
  'tl_select_done',
  /** selects every row in the current filtered view. */
  'tl_sel_all',
  /** empties the whole selection. */
  'tl_sel_none',
  /** the bar's one primary action. */
  'tl_sel_copy',
  // status badges (five states + edited overlay)
  //
  // 🔴 owner 2026-08-07 甲-3 — docs/decisions/2026-08-07-owner-inject-status-wording-
  // evidence-and-window-title.md. The `status` ENUM still has exactly four values
  // (the five-state red line untouched); what splits three ways is the WORD, and it splits on
  // ③evidence (`focus_evidence`), composed in exactly one place: lib/status.ts.
  'st_injected',
  /** 甲-3's WEAK half: the input reached the keyboard focus, and where it landed
   *  was NOT confirmed. Absent evidence lands here too — "we never asked" may never be
   *  rendered as "confirmed" (R11). Never a segment-① word: this end speaks injection only
   *  (docs/rebuild/15 §2.0), so it is "input sent" and never "delivered". */
  'st_delivered',
  'st_cached',
  /** 🔴 owner 2026-08-07 DELETED the word "injection failed" (verbatim: don't show
   *  "injection failed", don't make the user think an error occurred — much of the
   *  time the cause is external). None of the five codes that
   *  land on this face is FlowMic erring, and the user's action is the same as for
   *  `cached` (`status.ts` canReinject already includes `failed`). The row keeps its
   *  ✗ glyph and its red class — only the word is neutral now. */
  'st_failed',
  'st_noted',
  /** ③evidence, the parenthetical half of 甲-3. THE BRACKETS ARE PART OF THE
   *  STRING on purpose: zh/ja take full-width （）with no leading space, en/ko take
   *  ASCII parens WITH one — per-locale punctuation is exactly what a shared
   *  composition cannot get right, and the same reason TL_BATCH_MSG is a function
   *  catalogue. Pinned verbatim per locale by lib/inject-evidence-face.test.ts. */
  'ev_confirmed',
  'ev_unconfirmed',
  'edited',
  'to',
] as const;

// Notes that were recorded against a TRANSLATION rather than against the
// key itself. Carried across verbatim (only the language tag is new): they
// explain a rendering choice in one language, and the block they lived in
// is now a data file that cannot hold them.
// [en] REQ-12-13 — the remote key row. See the zh block for why the face is composed
// [en] here and never stored on the row.
// [en] 0.2.27: one sentence where there were four. The edit / delete / refresh lines
// [en] went with the uplink they described (see the zh_CN block). What is left states a
// [en] fact about TYPING, never about syncing, and promises no retry.
// [en] 「Dismiss」, not 「Cancel」: it only puts the line away; nothing is re-sent.
// [en] 甲-3 weak half. NOT "Delivered"/"Sent" on their own: both are segment-①
// [en] words in English and this window speaks segment ② only (docs/rebuild/15
// [en] §2.0 — the same rule that keeps st_cached off "pending delivery"). "Input
// [en] sent" names what actually happened: the keystrokes/paste went to the
// [en] keyboard focus, and nothing confirmed where they landed.
// [en] A statement of fact, not a promise: the text was NOT delivered and IS
// [en] held locally. "Pending delivery" would claim a retry nobody scheduled.
// [en] owner 2026-08-07: the word "failed" is gone in every locale. Same stem as
// [en] st_cached so the two read as one family, the way zh 未注入 / 未注入 · 已缓存 do.
// [en] ASCII parens WITH a leading space (zh/ja take full-width and none).
// [ja] REQ-12-13 — リモートキーの行。文面をここで組む理由は zh ブロック参照。
// [ja] 0.2.27：4 文が 1 文に。編集／削除／更新の 3 文は、それが説明していたアップリンク
// [ja] と一緒に削除しました（zh_CN ブロック参照）。残る 1 文は「入力」についての事実だけ
// [ja] を述べ、再試行は約束しません。
// [ja] 「閉じる」。「キャンセル」ではない——この行を片付けるだけで、再追送はしません。
// [ja] 甲-3 weak half. 「送信」 is banned here — it is the segment-① word the capsule
// [ja] guard already bans (未送信 / 送信中), so this says 入力 (what was performed on
// [ja] the window) rather than transmission.
// [ja] owner 2026-08-07 — 「失敗」 must not appear (design §6-2 ⑤ flags ja/ko as the
// [ja] likeliest place to leave it behind). Same stem as st_cached.
// [ko] REQ-12-13 — 원격 키 행. 문구를 여기서 조합하는 이유는 zh 블록 참조.
// [ko] 0.2.27: 네 문장이 한 문장으로. 수정／삭제／새로고침 문장은 그것이 설명하던
// [ko] 업링크와 함께 삭제했습니다(zh_CN 블록 참조). 남은 한 문장은 '입력'에 대한 사실만
// [ko] 말하고 재시도를 약속하지 않습니다.
// [ko] 「닫기」. 「취소」가 아닙니다 — 이 줄만 치울 뿐 다시 보내지는 않습니다.
// [ko] 甲-3 weak half. 「전송」 is banned here for the same reason ja avoids 送信 —
// [ko] it is the segment-① word (미전송 / 전송 중). 입력 is what happened to the window.
// [ko] owner 2026-08-07 — 「실패」 must not appear. Same stem as st_cached.
// [ko] ASCII parens WITH a leading space, like en.

export const TIMELINE_STRINGS = shardCatalogue(TIMELINE_KEYS);

/** Mode → badge symbol + css class + tooltip (V2-17: the ①②③ numerals were
 *  replaced by icons — realtime sound wave / translate bidirectional arrow / organize list).
 *  `icon` is a name in Icon.vue's ICONS table; the capsule imports that same
 *  component, so its future mode mark should read this map rather than
 *  re-listing literals. The label doubles as the row's title= tooltip — an
 *  icon alone is just a new kind of riddle without a queryable word.
 *
 *  V2-07.8a: `label` is a GETTER that reads the CURRENT locale's filter label,
 *  so the tooltip follows a language switch with no call-site change. The read
 *  goes through getLocale() (a Vue ref), which is what makes templates that
 *  render it re-render. */
export const MODE_BADGE: Record<string, { icon: string; cls: string; label: string }> = {
  realtime: { icon: 'waveform', cls: 'b1', get label() { return TIMELINE_STRINGS[getLocale()].filter_realtime; } },
  translate: { icon: 'swap', cls: 'b2', get label() { return TIMELINE_STRINGS[getLocale()].filter_translate; } },
  organize: { icon: 'list', cls: 'b3', get label() { return TIMELINE_STRINGS[getLocale()].filter_organize; } },
};


/** V2-18 count-bearing messages (owner ②③). They are FUNCTIONS, not word
 *  fragments: word order is per-locale, so a composed sentence lives in exactly
 *  one place. V2-07.8a: the public shape is unchanged — each function dispatches
 *  to the CURRENT locale's implementation (getLocale() is a ref, so templates
 *  calling these re-render on a switch). */
export const TL_BATCH_MSG: TlBatchMsg = {
  selCount: (n) => TL_BATCH_MSG_BY_LOCALE[getLocale()].selCount(n),
  selImgHint: (selected, images) => TL_BATCH_MSG_BY_LOCALE[getLocale()].selImgHint(selected, images),
  copiedWithSkip: (copied, skipped) => TL_BATCH_MSG_BY_LOCALE[getLocale()].copiedWithSkip(copied, skipped),
  copied: (n) => TL_BATCH_MSG_BY_LOCALE[getLocale()].copied(n),
  nothingToCopy: (selected) => TL_BATCH_MSG_BY_LOCALE[getLocale()].nothingToCopy(selected),
};

/** Test/guard surface (locale-parity.test.ts): the raw per-locale function
 *  tables, so the key-parity guard covers the count-bearing messages too. */
export const TL_BATCH_MSG_CATALOGUES = TL_BATCH_MSG_BY_LOCALE;


/** owner 2026-07-31 ② retention copy. Same dispatch shape as TL_BATCH_MSG: each
 *  call reads the CURRENT locale (getLocale() is a ref, so templates re-render). */
export const TL_RETENTION_MSG: TlRetentionMsg = {
  keptNote: (kept, when) => TL_RETENTION_MSG_BY_LOCALE[getLocale()].keptNote(kept, when),
  searchNoneTrimmed: (kept, when) =>
    TL_RETENTION_MSG_BY_LOCALE[getLocale()].searchNoneTrimmed(kept, when),
};

/** Test/guard surface (locale-parity.test.ts). */
export const TL_RETENTION_MSG_CATALOGUES = TL_RETENTION_MSG_BY_LOCALE;


/** owner 2026-08-01 §4-2 ⑧ copy. Same dispatch shape as TL_BATCH_MSG/TL_RETENTION_MSG. */
export const TL_METRICS_MSG: TlMetricsMsg = {
  wordCount: (n) => TL_METRICS_MSG_BY_LOCALE[getLocale()].wordCount(n),
};

/** Test/guard surface — NOT registered in lib/strings/locale-parity.test.ts (that file
 *  is shared infrastructure outside this lane's file ownership); parity across the
 *  four locales is asserted directly in main-window/timeline-search.test.ts instead. */
export const TL_METRICS_MSG_CATALOGUES = TL_METRICS_MSG_BY_LOCALE;
