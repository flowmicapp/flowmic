#!/usr/bin/env bash
# L-3/L-4: compile one named native acceptance test before taking desktop focus.
# Example: CARGO_TARGET_DIR=/mnt/f/.../target TMPDIR=/mnt/f/.../tmp bash scripts/linux-input-native-smoke.sh linux_paste_real_gtk_buffer_delayed_target_and_restore
set -euo pipefail
: "${CARGO_TARGET_DIR:?set a build directory on the repository volume}"
: "${TMPDIR:?set a temporary directory on the repository volume}"
filter=${1:?pass one explicit native test name}
case "$filter" in
  linux_clipboard_real_gtk_round_trip_and_new_owner_survives|linux_clipboard_same_xid_new_copy_is_not_replaced) export FLOWMIC_GTK_CLIPBOARD_ONLY=1 ;;
  linux_paste_real_gtk_buffer_delayed_target_and_restore|linux_keys_real_gtk_six_keys_preserve_modifiers_and_target|linux_submission_real_xerror_after_keys_is_uncertain_without_duplicate) unset FLOWMIC_GTK_CLIPBOARD_ONLY ;;
  *) echo 'Expected one exact Linux native acceptance test name' >&2; exit 2 ;;
esac
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root/apps/desktop/src-tauri"
mkdir -p "$CARGO_TARGET_DIR/acceptance"
gcc -Wall -Wextra -Werror src/inject/linux/gtk_peer.c -o "$CARGO_TARGET_DIR/acceptance/gtk-peer" $(pkg-config --cflags --libs gtk+-3.0)
export FLOWMIC_LINUX_GTK_PEER="$CARGO_TARGET_DIR/acceptance/gtk-peer"
export GDK_BACKEND=x11
cargo test --offline --lib "$filter" --no-run
cargo test --offline --lib "$filter" -- --ignored --nocapture
