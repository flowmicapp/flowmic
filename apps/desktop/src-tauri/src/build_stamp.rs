//! Card SC-5 — the commit this exe was built from, as a string IN the exe.
//!
//! build.rs turns the `FLOWMIC_BUILD_SHA` environment variable into a
//! `cargo:rustc-env` of the same name (its header carries the full reasoning and
//! the four legal values); this module is the only place that reads it, and the
//! only place the on-disk literal is spelled.
//!
//! ── TWO READERS, ON PURPOSE ────────────────────────────────────────────────
//!
//! 1. **A running copy**, through its own forensic log: the startup line names
//!    the version AND this stamp, so a machine that is behaving strangely can
//!    answer "which commit is this" from its own log rather than from anyone's
//!    memory of what they installed. `FileVersion=` could only ever answer
//!    "which release" — and the measured hazard is two builds of the SAME
//!    version made from different commits, which is exactly what a version
//!    cannot distinguish.
//!
//! 2. **scripts/publish.mjs GATE 0f**, WITHOUT running the exe, by scanning its
//!    bytes for [`STAMP`]. That is the reason the stamp is a prefixed literal
//!    and not a bare sha: a byte scan for a bare 40-hex could only answer "is
//!    the right sha in here", never "is this build stamped at all", and those
//!    two questions have different fixes (rebuild from the right commit vs.
//!    build through the stamping script). Same shape as the APK self-update
//!    marker, for the same reason its header gives.
//!
//! ⚠️ `STAMP` must stay a `const` built with `concat!` — a value assembled at
//! runtime would not be a single literal in the string table, and the byte scan
//! would find nothing in a perfectly good exe.

/// The literal compiled into the binary: `flowmic-build-sha:<value>`.
///
/// The prefix is duplicated in scripts/build-stamp/require-clean-sha.mjs
/// (`STAMP_PREFIX`) because the two sides are in different languages and cannot
/// import one another. `build_stamp_tests.rs` reads that file and asserts the
/// two spellings are the same string, so the pair cannot drift silently.
pub const STAMP: &str = concat!("flowmic-build-sha:", env!("FLOWMIC_BUILD_SHA"));

/// The value alone (`<sha40>`, `dirty-<sha40>`, `nogit`, or `unstamped-dev`).
pub const BUILD_SHA: &str = env!("FLOWMIC_BUILD_SHA");

/// Whether this build carries a commit id at all. Used only by the startup line
/// to say so out loud: a developer build is not an error, but a build that
/// cannot say where it came from must not look like one that can.
pub fn is_stamped() -> bool {
    BUILD_SHA.len() == 40 && BUILD_SHA.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}

/// The sentence the startup forensic line carries.
pub fn startup_line() -> String {
    format!(
        "FlowMic {} — {}{}",
        env!("CARGO_PKG_VERSION"),
        STAMP,
        if is_stamped() { "" } else { " (NOT a release build: this copy cannot name its commit)" }
    )
}

#[cfg(test)]
#[path = "build_stamp_tests.rs"]
mod tests;
