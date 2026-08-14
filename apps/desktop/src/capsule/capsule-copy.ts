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
export function canCopyLine(l: Pick<RecentLine, 'text'>): boolean {
  return l.text.trim() !== '';
}
