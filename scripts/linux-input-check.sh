#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_HOME="${CARGO_HOME:-$PWD/.local/cargo-home}"
export TMPDIR="${TMPDIR:-$PWD/.local/tmp}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/.local/linux-target}"
mkdir -p "$CARGO_HOME" "$TMPDIR" "$CARGO_TARGET_DIR"
cd apps/desktop/src-tauri
cargo clippy --lib --offline -- -D warnings
cargo test --lib linux_session::tests --offline
cargo build --example linux_focus_probe --offline
