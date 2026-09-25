#!/usr/bin/env python3
"""Run the same named cargo test against a real GTK window, broken then restored."""
import hashlib
import os
import pathlib
import subprocess
import time

root = pathlib.Path(__file__).resolve().parents[1]
source = root / "apps/desktop/src-tauri/src/focus/linux.rs"
out = root / ".local/linux-focus/cargo-negative"
out.mkdir(parents=True, exist_ok=True)
original = source.read_bytes()
needle = "if window == 0 || pid_with(connection, window) == Some(std::process::id())"
assert original.decode().count(needle) == 1
env = dict(os.environ, GDK_BACKEND="x11")
for key, directory in [("CARGO_HOME", "cargo-home"), ("CARGO_TARGET_DIR", "linux-target"), ("TMPDIR", "tmp")]:
    env.setdefault(key, str(root / ".local" / directory))
    pathlib.Path(env[key]).mkdir(parents=True, exist_ok=True)
title = "FlowMic-L5-Cargo"
gtk_log = out / "gtk.jsonl"
gtk_log.unlink(missing_ok=True)
target = subprocess.Popen(["python3", str(root / "scripts/linux-focus-target.py"),
                           "--title", title, "--seconds", "600", "--output", str(gtk_log)], env=env)
command = ["cargo", "test", "--lib", "linux_focus_tracks_real_external_window", "--", "--ignored", "--nocapture"]


def run(label):
    # Finish compilation before the independent user activation so unrelated
    # desktop activity during a rebuild cannot invalidate the focus fixture.
    with (out / f"{label}-build.log").open("w") as build_log:
        subprocess.run(command[:4] + ["--no-run"], cwd=root / "apps/desktop/src-tauri",
                       env=env, stdout=build_log, stderr=subprocess.STDOUT, check=True)
    subprocess.run(["python3", str(root / "scripts/linux-focus-activate.py"), title, env["FLOWMIC_FOCUS_XID"]],
                   env=env, check=True, capture_output=True)
    time.sleep(0.5)
    result = subprocess.run(command, cwd=root / "apps/desktop/src-tauri", env=env, text=True, capture_output=True)
    (out / f"{label}.log").write_text("COMMAND: " + " ".join(command) + "\n" + result.stdout + result.stderr)
    return result


try:
    time.sleep(1.5)
    xid = subprocess.check_output(["xdotool", "search", "--name", f"^{title}$"], text=True).strip().splitlines()[-1]
    env.update(FLOWMIC_FOCUS_XID=xid, FLOWMIC_FOCUS_TITLE=title, FLOWMIC_FOCUS_GTK_LOG=str(gtk_log))
    source.write_bytes(original.decode().replace(needle, needle.replace("window == 0", "window != 0")).encode())
    try:
        red = run("red")
        assert red.returncode != 0 and "test result: FAILED" in red.stdout
        assert "production external target" in red.stderr, red.stdout + red.stderr
    finally:
        source.write_bytes(original)
    green = run("green")
    assert green.returncode == 0, green.stdout + green.stderr
    assert source.read_bytes() == original
    print("named cargo live GTK RED/restore/GREEN; sha256=" + hashlib.sha256(original).hexdigest())
finally:
    source.write_bytes(original)
    target.terminate()
    target.wait(timeout=5)
