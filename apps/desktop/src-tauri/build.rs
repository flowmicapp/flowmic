// Tauri context codegen runs only for the `app` feature build. The lean
// `cargo test` / `cargo run --example golden_inject` builds (no `app`
// feature) skip it entirely so they never need tauri.conf resources / icons.
fn main() {
    stamp_build_sha();
    if std::env::var_os("CARGO_FEATURE_APP").is_some() {
        tauri_build::build();
    }
}

/// Card SC-5 — compile the commit this exe was built from INTO the exe.
///
/// ── WHY (risk R1 of the ship-chain redesign) ────────────────────────────────
///
/// The release chain now starts `tauri build` at t=0, in parallel with the
/// gate, in a warm worktree with a warm `target/`. Nothing in the old chain
/// could tell whether the exe being staged came from the commit the gate
/// receipt names: a build started one commit early, a warm target that no-ops,
/// a lane merged mid-flight — each ships bytes the receipt does not describe
/// and each looks exactly like a correct round. server-core, stt-cloud and the
/// web dist already stamp their commit; the exe and the APK did not.
///
/// The value arrives as the `FLOWMIC_BUILD_SHA` environment variable, resolved
/// by ONE rule in scripts/build-stamp/require-clean-sha.mjs and delivered by
/// scripts/build-stamp/with-build-sha.mjs (which `pnpm --filter @flowmic/desktop
/// tauri:build` goes through). scripts/publish.mjs GATE 0f then reads the
/// staged exe BYTES and refuses when the stamp is not the receipt sha — a
/// content check, not a claim that the build went through our script.
///
/// ── THE THREE VALUES, AND WHY `unstamped-dev` IS NOT AN ERROR HERE ──────────
///
///   `<sha40>`        a clean checkout   -> publishable
///   `dirty-<sha40>`  FLOWMIC_ALLOW_DIRTY_BUILD=1 -> GATE 0f refuses by name
///   `nogit`          FLOWMIC_BUILD_ALLOW_NO_GIT=1 -> GATE 0f refuses by name
///   `unstamped-dev`  the variable was not set at all
///
/// A plain `cargo check`, `cargo test`, `cargo clippy` or an IDE build has no
/// business consulting git, and failing them would make the stamp a tax on
/// every developer action rather than a gate on releases. Those builds are not
/// artifacts. So an absent variable stamps `unstamped-dev` — a value that is
/// perfectly fine to run and that publish refuses BY NAME, which puts the
/// refusal at the only moment where it is fatal.
///
/// 🔴 A MALFORMED value PANICS instead of being stamped. The failure it guards
/// against is a wiring mistake (a Makefile that interpolated nothing, a shell
/// that ate the value): stamping whatever arrived would put a lie in the
/// binary, and a lie is worse than a stopped build — GATE 0f would then be
/// comparing two strings neither of which describes a commit.
///
/// `rerun-if-env-changed` is load-bearing, not hygiene: without it a warm
/// `target/` would keep the PREVIOUS commit stamp compiled in while everything
/// else rebuilt, which is precisely risk R1 reproduced by the very mechanism
/// meant to catch it.
fn stamp_build_sha() {
    println!("cargo:rerun-if-env-changed=FLOWMIC_BUILD_SHA");

    let raw = std::env::var("FLOWMIC_BUILD_SHA").unwrap_or_default();
    let value = if raw.is_empty() { "unstamped-dev".to_string() } else { raw };

    let ok = value == "unstamped-dev"
        || value == "nogit"
        || is_sha40(&value)
        || value.strip_prefix("dirty-").is_some_and(is_sha40);
    if !ok {
        panic!(
            "FLOWMIC_BUILD_SHA={value:?} is not a value this build knows how to stamp. \
             Expected a 40-character commit id, `dirty-<sha40>`, `nogit`, or the variable \
             unset (which stamps `unstamped-dev`). It is produced by \
             scripts/build-stamp/require-clean-sha.mjs and delivered by \
             scripts/build-stamp/with-build-sha.mjs; a value in any other shape means the \
             wiring dropped or mangled it, and stamping it would put a lie in the binary \
             that scripts/publish.mjs GATE 0f would then compare against the gate receipt."
        );
    }

    println!("cargo:rustc-env=FLOWMIC_BUILD_SHA={value}");
}

fn is_sha40(s: &str) -> bool {
    // Lowercase hex only, deliberately: `git rev-parse` emits lowercase, and
    // `is_ascii_hexdigit` would also accept an uppercase spelling that no part
    // of this chain produces — GATE 0f compares these strings byte for byte.
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}
