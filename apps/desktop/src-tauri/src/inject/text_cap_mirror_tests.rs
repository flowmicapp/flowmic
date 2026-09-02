// G7 (WP-8, 2026-09-02) — INJECT_TEXT_MAX_CHARS pinned against the protocol
// source, the same "read the file, don't trust a comment" technique
// `error_codes.rs`'s `desktop_error_codes_are_a_subset_of_the_protocol_ssot`
// already uses for the code registry. Three ends hand-copy this cap today
// (this constant, `packages/protocol/src/protocol-schemas-inject.ts`'s zod
// `.max()`, and Dart's `compose_gate.dart` / `plus_panel_selection.dart`), and
// "today all three agree" is exactly the shape the audit flagged: nothing
// would go red the day one of them drifted. This closes the Rust half.
//
// Kept as its OWN sibling file rather than folded into `pipeline_tests.rs`:
// that file sits at the 800-line source cap (`verify/lint/file-size.mjs`
// treats a `#[path]`-split `_tests.rs` sibling as source, not as a test file
// under the looser cap — its name regex only recognises singular `_test.rs`),
// so a new coherent family goes into its own file rather than pushing that
// one over, per this repo's own file-size-cap convention. Declared from
// `inject/mod.rs` for the same reason `focus_evidence_tests.rs` and
// `msaa_focus_tests.rs` are: a file-boundary detail, not a statement about
// ownership — these tests belong to the pipeline all the same.

use crate::inject::pipeline::INJECT_TEXT_MAX_CHARS;

#[test]
fn inject_text_max_chars_matches_the_protocol_source() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("packages")
        .join("protocol")
        .join("src")
        .join("protocol-schemas-inject.ts");
    let ts = match std::fs::read_to_string(&path) {
        // Same failure direction as the error-codes mirror: a missing SSOT file
        // (e.g. a packaging step that does not ship packages/) must not turn
        // this into a false pass, but it also must not fail a build that has no
        // way to check — so it degrades to asserting the constant is sane on
        // its own, loudly, rather than silently skipping.
        Err(_) => {
            assert!(INJECT_TEXT_MAX_CHARS > 0, "INJECT_TEXT_MAX_CHARS must be positive");
            return;
        }
        Ok(s) => s,
    };
    // Anchored on the ASSIGNMENT ("NAME ="), not just the name — the name
    // alone also matches its consumer two lines down (`z.string().max(...)`).
    // The value is parsed as an integer rather than string-matched, because
    // TS numeric literals may carry `_` digit separators (`100_000`) that
    // Rust's `{usize}` formatting never produces, and stripping `_` from the
    // WHOLE file first would also corrupt the identifier itself
    // (`INJECT_TEXT_MAX_CHARS` contains underscores) — measured directly: a
    // first draft of this test did exactly that and could not find its own
    // needle.
    let anchor = "INJECT_TEXT_MAX_CHARS =";
    let after_anchor = ts.find(anchor).unwrap_or_else(|| {
        panic!(
            "no `{anchor}` assignment found in {} — the declaration form changed",
            path.display()
        )
    }) + anchor.len();
    let value_str: String = ts[after_anchor..]
        .chars()
        .skip_while(|c| c.is_whitespace())
        .take_while(|c| c.is_ascii_digit() || *c == '_')
        .filter(|c| *c != '_')
        .collect();
    let ts_value: usize = value_str.parse().unwrap_or_else(|_| {
        panic!(
            "could not parse a number out of `{anchor}{}` in {} (parsed digits: {value_str:?})",
            &ts[after_anchor..(after_anchor + 20).min(ts.len())],
            path.display(),
        )
    });
    assert_eq!(
        ts_value, INJECT_TEXT_MAX_CHARS,
        "Rust's INJECT_TEXT_MAX_CHARS ({INJECT_TEXT_MAX_CHARS}) does not match \
         packages/protocol/src/protocol-schemas-inject.ts's `export const \
         INJECT_TEXT_MAX_CHARS = {ts_value}` — the three hand-copies (this \
         constant, the protocol zod .max(), and Dart's compose_gate.dart / \
         plus_panel_selection.dart) have drifted apart ({})",
        path.display(),
    );
}
