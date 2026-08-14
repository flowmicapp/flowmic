// FlowMic desktop binary. Only built under the `app` feature (see Cargo.toml
// [[bin]] required-features) — the injection/socket/focus core is exercised by
// `cargo test` and the golden_inject example without the Tauri toolchain.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    flowmic_desktop_lib::run();
}
