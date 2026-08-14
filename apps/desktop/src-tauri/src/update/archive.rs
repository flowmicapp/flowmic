// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §4.5 (what about the
//     portable edition)
//   scripts/pack-portable.mjs — the producer of the archives inspected here
//
// Verify the SHAPE of a downloaded portable archive before anybody unpacks it.
//
// ── WHY THIS EXISTS, AND WHY IT TAKES THE EXPECTATION AS AN ARGUMENT ────────
//
// 🔴 **The one `portable-zip` kind covers two different internal shapes**, and
// this is a fact about what we ship TODAY, not a hypothetical future drift
// [measured 2026-08-08, dev-pc-a, by the release-chain lane]:
//
//   | archive                                  | top-level entry |
//   |------------------------------------------|-----------------|
//   | `FlowMic-<ver>-portable-windows-x64.zip`  | `FlowMic-portable/` (a plain dir) |
//   | `FlowMic-<ver>-macos-arm64.zip`           | `FlowMic.app/` (a bundle dir)     |
//
// `scripts/build-update-manifest.mjs` says the same thing in its own comment
// (「不许假设顶层目录名对所有 portable-zip 都一样」— "must not assume the
// top-level directory name is the same for every portable-zip") — the ruling was that
// `platform` says how to swap and `kind` says it is a replace-in-place package,
// so no second `kind` was minted for macOS.
//
// ⇒ Any code that unpacks one of these while ASSUMING a root name is already
// wrong on one of the two platforms we ship. So this function does not know a
// root name: **the caller must state what it expects, and we check.** A comment
// saying「don't assume the layout」cannot stop the next person from assuming it;
// a required parameter can.
//
// ── AND WHY THE EXPECTATION IS NOT A CONSTANT IN THIS FILE ──────────────────
//
// The release-chain lane found the trap first and it is worth repeating: a test
// asserting `top_level == PORTABLE_DIR_NAME` is **self-referential** — move the
// constant and both sides move together, the test stays green, and the shipped
// package changes under every consumer's feet.
//
// > An assertion has to be expensive enough that breaking it costs something.
// > A test that moves whenever the thing it guards moves is not a guard.
//
// So there is no root-name constant here at all. The tests below use LITERAL
// names for both platforms, which is what makes them cost something.
//
// ⚠️ **Extraction itself is NOT here** — it is UP-3b's, along with the in-place
// swap. This module answers only「是不是我以为的那个形状」("is this the shape I
// think it is"), which is the question that has to be settled BEFORE anything
// is written to disk.

use std::collections::BTreeSet;
use std::path::Path;

use crate::portable::zip::{ZipError, ZipReader};

use super::failure::UpdateFailure;

/// What the archive actually contains at its top level.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveShape {
    /// Every distinct first path segment, sorted. A well-formed portable bundle
    /// has exactly one.
    pub roots: Vec<String>,
    /// Entry names the zip reader REFUSED as unsafe (absolute paths, `..`
    /// segments, backslashes, drive letters).
    ///
    /// 🔴 Carried rather than dropped, for the reason `portable::zip` states
    /// about its own `refused` list: an archive containing a traversal attempt
    /// is something the user must be told about, not something to quietly skip.
    /// A non-empty list here fails verification outright.
    pub refused: Vec<String>,
    /// How many safe entries the archive holds.
    pub entries: usize,
}

/// Read an archive's top-level shape WITHOUT extracting anything.
///
/// Only the central directory is parsed, so this works regardless of how the
/// entries are compressed — `portable::zip::ZipReader` can only *decompress*
/// STORE, but it can *enumerate* anything, and enumeration is all that is
/// needed to answer this question.
pub fn read_shape(archive: &Path) -> Result<ArchiveShape, UpdateFailure> {
    let reader = ZipReader::open(archive).map_err(|e| UpdateFailure::ArchiveUnreadable {
        detail: match e {
            ZipError::NotAZip => "not_a_zip".to_string(),
            ZipError::Corrupt(what) => format!("corrupt:{what}"),
            ZipError::Io(_) => "io".to_string(),
            // These two cannot arise from `open`, but naming them beats a
            // wildcard that would silently absorb a future variant.
            ZipError::Compressed(_) => "compressed".to_string(),
            ZipError::UnsafeName(_) | ZipError::NoSuchEntry(_) => "entry".to_string(),
        },
    })?;

    let mut roots: BTreeSet<String> = BTreeSet::new();
    for e in reader.entries() {
        // First path segment. `entry_name_is_safe` has already refused absolute
        // names, backslashes and `..` segments, so a leading empty segment is
        // not reachable here — but taking the first NON-empty one costs nothing
        // and does not depend on that guarantee holding forever.
        if let Some(first) = e.name.split('/').find(|s| !s.is_empty()) {
            roots.insert(first.to_string());
        }
    }
    Ok(ArchiveShape {
        roots: roots.into_iter().collect(),
        refused: reader.refused_names().to_vec(),
        entries: reader.entries().len(),
    })
}

/// Verify that `archive` unpacks to exactly one top-level directory named
/// `expected_root`.
///
/// 🔴 `expected_root` is a REQUIRED argument and this module holds no default
/// for it. That is the entire design: a caller cannot reach the bytes without
/// first saying what shape it believes they have, so「I assumed the layout」is
/// not expressible through this API — only「I expected X and got Y」, which is a
/// nameable failure with both halves in it.
///
/// Refuses, each with its own sentence:
///   • an unreadable / non-zip file,
///   • an archive containing an unsafe entry name (traversal),
///   • zero roots (an empty archive),
///   • more than one root (a bundle that would scatter files into the parent),
///   • one root that is not the expected one.
pub fn verify_root(archive: &Path, expected_root: &str) -> Result<ArchiveShape, UpdateFailure> {
    let shape = read_shape(archive)?;
    if !shape.refused.is_empty() {
        return Err(UpdateFailure::ArchiveUnsafeEntry { names: shape.refused.clone() });
    }
    if shape.roots.len() != 1 || shape.roots[0] != expected_root {
        return Err(UpdateFailure::ArchiveLayoutUnexpected {
            expected: expected_root.to_string(),
            found: shape.roots.clone(),
        });
    }
    Ok(shape)
}

#[cfg(test)]
#[path = "archive_tests.rs"]
mod tests;
