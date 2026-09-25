#!/usr/bin/env python3
"""Named Cargo acceptance of the rebuilt real capsule against independent GTK state."""
import argparse
import json
import os
import pathlib
import resource
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("--backend", choices=["x11", "wayland"], required=True)
parser.add_argument("--dist", required=True)
parser.add_argument("--label", required=True)
parser.add_argument("--expect-suppressed", action="store_true")
args = parser.parse_args()
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
root = pathlib.Path(__file__).resolve().parents[1]
out = root / ".local/linux-focus/capsule" / args.label
out.mkdir(parents=True, exist_ok=True)
dist = pathlib.Path(args.dist).resolve()
assert (dist / "capsule.html").is_file(), "real built capsule assets required"
env = dict(os.environ, GDK_BACKEND=args.backend)
for key, directory in [("CARGO_HOME", "cargo-home"), ("CARGO_TARGET_DIR", "linux-target"), ("TMPDIR", "tmp")]:
    env.setdefault(key, str(root / ".local" / directory))
    pathlib.Path(env[key]).mkdir(parents=True, exist_ok=True)
probe = pathlib.Path(env["CARGO_TARGET_DIR"]) / "debug/examples/linux_capsule_probe"
assert probe.is_file(), "rebuild the real capsule probe first"
command = ["cargo", "test", "--test", "linux_capsule_live", "linux_capsule_preserves_real_external_focus"]
with (out / "test-build.log").open("w") as log:
    subprocess.run(command + ["--no-run"], cwd=root / "apps/desktop/src-tauri", env=env,
                   stdout=log, stderr=subprocess.STDOUT, check=True)
# Keep the preinstalled toolchain readable after HOME changes for the actual
# desktop processes. Every app/config/cache/runtime write stays on the test disk.
env.setdefault("RUSTUP_HOME", str(pathlib.Path.home() / ".rustup"))
wayland_display = env.get("WAYLAND_DISPLAY")
if wayland_display and not pathlib.Path(wayland_display).is_absolute():
    assert env.get("XDG_RUNTIME_DIR"), "relative Wayland display needs its original runtime directory"
    env["WAYLAND_DISPLAY"] = str(pathlib.Path(env["XDG_RUNTIME_DIR"]) / wayland_display)
for key, directory in [("HOME", "home"), ("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"),
                       ("XDG_STATE_HOME", "state"), ("XDG_CACHE_HOME", "cache")]:
    env[key] = str(out / directory)
    pathlib.Path(env[key]).mkdir(parents=True, exist_ok=True)
runtime = pathlib.Path(env["TMPDIR"]) / ("flowmic-capsule-" + args.label)
runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
runtime.chmod(0o700)
env["XDG_RUNTIME_DIR"] = str(runtime)
(out / "environment.json").write_text(json.dumps({key: env.get(key) for key in [
    "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
    "CARGO_HOME", "CARGO_TARGET_DIR", "TMPDIR", "GDK_BACKEND", "WAYLAND_DISPLAY",
]}, indent=2))
children = []
streams = []
try:
    server_log = (out / "assets-server.log").open("w")
    streams.append(server_log)
    server = subprocess.Popen(["python3", "-m", "http.server", "1423", "--bind", "127.0.0.1", "--directory", str(dist)],
                              env=env, stdout=server_log, stderr=subprocess.STDOUT)
    children.append(server)
    time.sleep(0.5)
    assert server.poll() is None, "probe asset server could not bind; existing service is not accepted as evidence"
    title = "FlowMic-L6-Target"
    gtk_log = out / "gtk.jsonl"
    gtk_log.unlink(missing_ok=True)
    target_log = (out / "gtk.stderr").open("w")
    streams.append(target_log)
    target = subprocess.Popen(["python3", str(root / "scripts/linux-focus-target.py"), "--title", title,
                               "--seconds", "60", "--output", str(gtk_log)], env=env,
                              stdout=target_log, stderr=subprocess.STDOUT)
    children.append(target)
    time.sleep(1.5)
    xid = "0"
    if args.backend == "x11":
        xid = subprocess.check_output(["xdotool", "search", "--name", f"^{title}$"], text=True).strip().splitlines()[-1]
    subprocess.run(["python3", str(root / "scripts/linux-focus-activate.py"), title, xid], env=env, check=True)
    time.sleep(0.5)
    forensic = out / "window-forensics.log"
    forensic.unlink(missing_ok=True)
    env.update(FLOWMIC_FOCUS_GTK_LOG=str(gtk_log), FLOWMIC_FOCUS_XID=xid, FLOWMIC_CAPSULE_PROBE=str(probe), FLOWMIC_CAPSULE_SCREENSHOT=str(out / "capsule.png"), FLOWMIC_FORENSIC_PATH=str(forensic),
               FLOWMIC_CAPSULE_EXPECT_VISIBLE="0" if args.expect_suppressed else "1",
               FLOWMIC_CAPSULE_BACKEND="X11" if args.backend == "x11" else "Wayland")
    command += ["--", "--ignored", "--nocapture"]
    result = subprocess.run(command, cwd=root / "apps/desktop/src-tauri", env=env, text=True, capture_output=True, timeout=120)
    (out / "test.log").write_text("COMMAND: " + " ".join(command) + "\n" + result.stdout + result.stderr)
    print(f"{args.label}: cargo exit={result.returncode}; evidence={out}")
    raise SystemExit(result.returncode)
finally:
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=5)
    for stream in streams:
        stream.close()
