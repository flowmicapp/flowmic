// SPEC-REF:
//   docs/decisions/2026-08-01-image-two-sizes-both-ends.md (owner: 「点开之后也是
//     显示可以用的那个传过来的图」("When you click to open it, it should also show
//     the same usable picture that was transmitted"))
//   apps/desktop/src-tauri/src/socket/row_image.rs (the store itself, and why the
//     bytes cannot live on the row)
//   apps/desktop/src/lib/timeline-store.ts (`evict` — the only caller of the drop)
//
// The two doors between the WebView and the delivered pictures on disk.
//
// Deliberately THIN: neither command decides anything. `row_image` owns the rules
// (what may be stored, where, and that nothing expires on its own); these are the
// IPC surface, because the page cannot read the filesystem and the store cannot
// reach the page.
//
// ⚠️ WHY THE PAGE DRIVES THE DELETE. The obvious alternative — a sweep in Rust
// that keeps the newest N pictures — was rejected: the row list is trimmed by
// `TimelineStore` (a byte budget AND a row count, whichever binds first), so a
// second, independent bound here would drift out of step with it and produce the
// one state that must not exist — a row on screen whose 点开大图 ("click to open
// the full picture") opens nothing.
// One bound, one owner: the row goes, the picture goes with it.

use crate::socket::row_image;

/// The delivered picture for one row, as a `data:` URL, or `None` when the row has
/// none (a transcript, a pre-RV-93 row, or one whose write failed).
///
/// `None` is a NORMAL answer and the page renders the thumbnail instead — it must
/// never be reported as an error, because 「只有小图」("only has the thumbnail") is a smaller picture, not a
/// broken one. Single-word parameter, like every other command on this boundary,
/// so no camelCase↔snake_case mapping is ever involved.
#[tauri::command]
pub fn timeline_image(id: String) -> Option<String> {
    row_image::data_url(&id)
}

/// Remove the pictures of rows the timeline has just trimmed. Returns how many
/// files were really removed, so the caller can record it — a one-way discard
/// nobody can observe is the silent-failure shape even when the discard is right.
///
/// Ids that have no picture are a no-op (every transcript row is one), so the
/// caller may pass the whole evicted batch without filtering.
#[tauri::command]
pub fn timeline_images_drop(ids: Vec<String>) -> usize {
    row_image::drop_ids(&ids)
}
