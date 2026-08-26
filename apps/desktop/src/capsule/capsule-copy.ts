// V2-19 — capsule strip per-row COPY (owner 2026-08-01,
// `docs/strategy/2026-08-01-data-asset-lifecycle-design.md` §4b-7):
// "each row in the capsule's history list gets a 'copy' button — when
// injection doesn't succeed, the user copies it directly for themselves".
//
// Pure logic only, extracted so it is unit-testable without mounting the SFC
// (batch-copy.ts / timeline-filter.ts precedent). The actual write and the
// transient per-row icon-swap state stay in CapsuleApp.vue.
//
// ⚠️ 2026-08-02 escalation (coordinator-mandated, NOT the browser path any
// more): the capsule's copy does NOT call `navigator.clipboard.writeText`
// like main-window/TimelinePage.vue's `copy()` does. The capsule's whole
// window carries WS_EX_NOACTIVATE (`configure_capsule_window`,
// src-tauri/src/shell/mod.rs) so a click never steals the user's real input
// focus — which means its WebView2 document may never register as "focused"
// in Chromium's sense either, and the Async Clipboard API requires
// `document.hasFocus()`. A button that could reject on every click regardless
// of what the user does is a façade (R8), so the write goes through a NEW
// Tauri command (`capsule_copy_text`, src-tauri/src/shell/clipboard_copy.rs)
// that calls the OS clipboard API natively (Win32 `SetClipboardData` on
// Windows; NSPasteboard on macOS since B3 2026-08-11) — APIs with no concept
// of "document focus" at all, so it is structurally immune to that hazard
// rather than merely likely to avoid it. See that file's header for the full
// reasoning and why it does not touch the injection path's clipboard
// snapshot/restore logic. The call itself goes through `capsule.copyText`
// (lib/bridge.ts) — the SAME single Tauri-IPC funnel every other command in
// this app uses (RV-97: a funnel with a second entry point is not a funnel);
// CapsuleApp.vue never imports the Tauri JS API package directly.

import type { RecentLine } from './controller';

/** The exact clipboard payload for a row's copy button — the SAME string
 *  `.rtext` already renders (`<span class="rtext" ...>{{ l.text }}</span>`,
 *  CapsuleApp.vue), never a re-derived or reformatted one. This is what
 *  "what gets copied shares one source with what the row renders"
 *  (复制的内容与行渲染同源) means literally: one binding (`l.text`), read
 *  twice — once to paint the row, once to copy it — never two fields
 *  answering "what does this row display" (the "one value answers two
 *  questions" shape this repo hunts). */
export function copyPayload(l: Pick<RecentLine, 'text'>): string {
  return l.text;
}

/** Whether a row's copy control should even appear.
 *
 *  Deliberately NOT keyed on `entryType === 'image'`: `.rtext` renders `l.text`
 *  UNCONDITIONALLY for every row (no `v-if` gates it in CapsuleApp.vue, image
 *  rows included) — an image row that carries a caption (row_transit.rs
 *  `row_face`, `entry_caption`) shows that caption in exactly the same span a
 *  transcript row shows its text, so it copies the same way. The only rows
 *  this omits are the ones whose rendered text is EMPTY — overwhelmingly an
 *  un-captioned image (`output_text` is empty precisely when the phone sent
 *  neither a transcript nor a caption). That is the R8 judgment call for
 *  image rows: not a special case, just the same「missing field is OMITTED,
 *  never back-filled」rule (V2-15 red line) every other cell on this row already
 *  follows — no button ever claims to have copied nothing. */
/** 🔴 REWRITTEN 2026-08-26 (owner). The previous round hid the copy button on an
 *  uncaptioned picture, and the round before that let it copy the size label.
 *  Both were wrong in the same way: they treated a picture row as a text row
 *  with an awkward string in it.
 *
 *  owner's ruling: a row has TWO controls — copy and re-inject — and they mean
 *  the same thing on every row. On a picture row, copy copies the PICTURE.
 *  「没必要就为图片这一行再增加一个特别的一个操作」.
 *
 *  So this gate answers 「is there anything on this row worth taking」, and
 *  `copyLine` decides WHICH thing. The two questions used to be one.
 */
export function canCopyLine(l: Pick<RecentLine, 'text' | 'entryType' | 'fullImage' | 'thumb'>): boolean {
  // A picture row is answered by the PICTURE alone. Its `.rtext` is a generated
  // descriptor when there is no caption, and that string is exactly what two
  // earlier rounds put on the clipboard — so it may not keep the button alive
  // either. No bytes left ⇒ nothing to take ⇒ no button (R8: a control that can
  // only fail is a façade). `copyLine` in CapsuleApp.vue routes the click.
  if (l.entryType === 'image') return rowHasPicture(l);
  return l.text.trim() !== '';
}

/** Does this row still hold a picture we could put on the clipboard — the
 *  original kept on disk, or the 256 px preview the strip already carries? */
export function rowHasPicture(l: Pick<RecentLine, 'entryType' | 'fullImage' | 'thumb'>): boolean {
  return l.entryType === 'image' && (l.fullImage === true || l.thumb !== null);
}
