// Card IMG-COPY (owner P0, 2026-08-25) — the capsule's copy-PICTURE call.
//
// SPEC-REF:
//   src-tauri/src/shell/clipboard_image.rs — the command (a forward write of the
//     row's original picture, thumbnail fallback; never the injection paste path)
//   lib/bridge.ts `capsule.copyText` — the TEXT sibling, same route, same reason
//   lib/bridge-os.ts — the precedent for a bridge sibling module: it goes through
//     `invokeVerbose` so bridge.ts stays the only module that calls `invoke`
//     (RV-97: a funnel with a second entry point is not a funnel), and bridge.ts
//     itself sits at the 800-line cap.
//
// Why native and not `navigator.clipboard.write`: the capsule window carries
// WS_EX_NOACTIVATE (never steals focus — a red line), and the Async Clipboard
// API requires `document.hasFocus()`. The main window keeps using the browser
// API for its own copy; whether it is ever refused there is reported, not
// assumed, by this card.
//
// The command answers which picture it wrote ("original" / "thumbnail") and
// records it in the forensic log; the strip's title already names the
// expectation from `RecentLine.fullImage`, so the page only needs ok / reason.

import { invokeVerbose } from './bridge';

/** Write the row's picture to the OS clipboard. `thumb` is the 256 px preview
 *  the strip already holds, used only when the row has no original on disk. A
 *  refused write carries its reason — the button shows ✗, never a silent no-op. */
export function copyRowImage(id: string, thumb: string | null): Promise<{ ok: true } | { ok: false; reason: string }> {
  return invokeVerbose('capsule_copy_image', { id, thumb });
}
