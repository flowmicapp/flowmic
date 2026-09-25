#!/usr/bin/env python3
"""Exercise production Rust focus source against two separate GTK processes."""
import json
import os
import pathlib
import subprocess
import time

root = pathlib.Path(__file__).resolve().parents[1]
out = root / ".local/linux-focus"
out.mkdir(parents=True, exist_ok=True)
probe = pathlib.Path(os.environ.get("CARGO_TARGET_DIR", str(root / ".local/linux-target"))) / "debug/examples/linux_focus_probe"
env = dict(os.environ, GDK_BACKEND="x11")
children = []
streams = []


def start_target(label, backend="x11"):
    stream = (out / f"{label}.stderr").open("w")
    streams.append(stream)
    log = out / f"{label}.jsonl"
    log.unlink(missing_ok=True)
    child = subprocess.Popen(["python3", str(root / "scripts/linux-focus-target.py"),
                              "--title", label, "--seconds", "25", "--output", str(log),
                              "--x", "650" if label.endswith("B") else "40"],
                             env=dict(env, GDK_BACKEND=backend), stdout=stream, stderr=stream)
    children.append(child)
    return child


def xid(title):
    return subprocess.check_output(["xdotool", "search", "--name", f"^{title}$"], text=True).strip().splitlines()[-1]


try:
    start_target("FlowMic-L5-A")
    time.sleep(1)
    first = xid("FlowMic-L5-A")
    probe_log = (out / "focus-source.jsonl").open("w")
    streams.append(probe_log)
    observer = subprocess.Popen([str(probe), "12"], env=env, stdout=probe_log, stderr=subprocess.STDOUT)
    children.append(observer)
    time.sleep(1)
    start_target("FlowMic-L5-B")
    time.sleep(1)
    second = xid("FlowMic-L5-B")
    activation = []
    for target, title in [(first, "FlowMic-L5-A"), (second, "FlowMic-L5-B"), (first, "FlowMic-L5-A")]:
        # WSLg's host owns activation. This is the independent user focus action;
        # the Rust call below must read and recognize the resulting native focus.
        subprocess.run(["python3", str(root / "scripts/linux-focus-activate.py"), title, target],
                       env=env, check=True)
        time.sleep(0.5)
        result = subprocess.run([str(probe), "activate", target], env=env, text=True, capture_output=True)
        activation.append({"id": target, "returncode": result.returncode, "stdout": result.stdout})
        assert result.returncode == 0, activation[-1]
        assert f'"foreground":[{target},' in result.stdout, activation[-1]
        time.sleep(0.6)
    probe_log.flush()
    observed = (out / "focus-source.jsonl").read_text()
    for subscriber in [1, 2]:
        for title in ["FlowMic-L5-A", "FlowMic-L5-B"]:
            assert any(f'"subscriber":{subscriber}' in line and title in line for line in observed.splitlines()), (subscriber, title)
    # An invalid/destroyed XID must be a refusal, never Xlib process termination.
    bad = subprocess.run([str(probe), "activate", "4294967294"], env=env, text=True, capture_output=True)
    assert bad.returncode == 2, bad
    start_target("FlowMic-L5-Wayland", "wayland")
    time.sleep(1.5)
    subprocess.run(["python3", str(root / "scripts/linux-focus-activate.py"), "FlowMic-L5-Wayland", "0"],
                   env=env, check=True)
    time.sleep(0.5)
    native = subprocess.run([str(probe), "1"], env=dict(env, GDK_BACKEND="wayland"), text=True, capture_output=True)
    assert '"backend":"Wayland"' in native.stdout, native.stdout
    assert '"foreground":null' in native.stdout, native.stdout
    x11_while_native = subprocess.run([str(probe), "1"], env=env, text=True, capture_output=True)
    assert '"foreground":null' in x11_while_native.stdout, x11_while_native.stdout
    assert all('"hwnd":0' in line for line in x11_while_native.stdout.splitlines() if '"hwnd"' in line), x11_while_native.stdout
    native_samples = [json.loads(line) for line in (out / "FlowMic-L5-Wayland.jsonl").read_text().splitlines()]
    assert any(sample["backend"] == "GdkWaylandDisplay" and sample["active"] for sample in native_samples), native_samples
    (out / "x11-while-native.jsonl").write_text(x11_while_native.stdout)
    observer.wait(timeout=15)
    probe_log.flush()
    evidence = (out / "focus-source.jsonl").read_text()
    for subscriber in [1, 2]:
        for title in ["FlowMic-L5-A", "FlowMic-L5-B"]:
            assert any(f'"subscriber":{subscriber}' in line and title in line for line in evidence.splitlines()), (subscriber, title)
    summary = {"gate": "linux-focus-live", "first_xid": first, "second_xid": second,
               "activation": activation, "invalid_window_exit": bad.returncode,
               "wayland_probe": native.stdout, "two_subscribers_two_real_targets": True,
               "x11_while_native": x11_while_native.stdout}
    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
finally:
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=5)
    for stream in streams:
        stream.close()
