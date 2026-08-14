// SPEC-REF:
//   🔴 docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md (FPR v1 — behaviour contract,
//      same tier as 04/05/07/08/15; change discipline: revise the doc first,
//      then the implementation and tests)
//   docs/strategy/2026-08-01-data-asset-lifecycle-design.md §1 (inventory-layer
//      ruling: export / statistics / clear share the same traversal)
//   docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md (the cloud stores no
//      transcripts ⇒ export is the only cross-device / backup path; both ends
//      need import and export)
//
// Portable record format FPR v1 — the DESKTOP half, file layer.
//
// ── THE SPLIT, AND WHY IT IS HERE ───────────────────────────────────────────
//
// The timeline rows live in the WebView's localStorage; the row PICTURES live on
// this side (socket/row_image.rs). So the work is split by WHERE THE BYTES ARE,
// not by language preference:
//
//   frontend (src/lib/portable/)   the inventory over the rows, the FPR line
//                                  shaping, the four import outcomes, the copy.
//   here                           the zip container, the picture bytes, the
//                                  file dialog, and nothing else.
//
// 🔴 THE FORMAT HAS EXACTLY ONE AUTHOR. Nothing in this module parses or edits a
// record line — they arrive finished and are written verbatim, and they come
// back as strings. A second shaper on this side would be the repo's #1 bug
// shape (one thing, two answers) applied to a file other tools will read.
//
// ── TWO-END SAMENESS (doc 16 §1 ruling 4) ──────────────────────────────────────
// owner rejected 「电脑给文件夹、手机给 zip」 ("the computer gives a folder, the
// phone gives a zip") for a stated reason: two shapes
// mean a future reader has to know two formats. The container written here is
// the container the phone writes — same members, same header line, same
// attachment naming. Anything that would make them differ belongs in the
// document first.

/// The zip container (STORE-only) + the §3 path-traversal guard.
pub mod zip;

/// Reading and writing the archive: `records.jsonl`, `README.txt`, `att/`, and
/// the picture bytes on either side of them.
pub mod archive;

/// Where the user says the file goes / comes from (§7-2 the user actively picks the destination).
pub mod dialog;

/// The Tauri IPC surface. Behind the `app` feature like every other command
/// module, so `cargo test` keeps exercising the layers above without wry.
#[cfg(feature = "app")]
pub mod commands;
