// Tauri context codegen runs only for the `app` feature build. The lean
// `cargo test` / `cargo run --example golden_inject` builds (no `app`
// feature) skip it entirely so they never need tauri.conf resources / icons.
fn main() {
    if std::env::var_os("CARGO_FEATURE_APP").is_some() {
        tauri_build::build();
    }
}
