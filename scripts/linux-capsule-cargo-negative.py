#!/usr/bin/env python3
"""Remove the measured compositor refusal, witness real focus loss, restore and pass."""
import argparse
import hashlib
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--overlay", required=True)
parser.add_argument("--dist", required=True)
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[1]
source = root / "apps/desktop/src-tauri/src/shell/capsule_style.rs"
original = source.read_bytes()
needle = "if let Some(reason) = suppression {"
assert original.decode().count(needle) == 1
build = ["python3", str(root / "scripts/linux-capsule-build.py"), "--overlay", args.overlay, "--dist", args.dist]
live = ["python3", str(root / "scripts/linux-capsule-live.py"), "--backend", "x11", "--dist", args.dist, "--expect-suppressed"]
try:
    source.write_bytes(original.decode().replace(needle, "if let Some(reason) = suppression.filter(|_| false) {").encode())
    subprocess.run(build, check=True)
    red = subprocess.run(live + ["--label", "suppression-red"])
    log = (root / ".local/linux-focus/capsule/suppression-red/test.log").read_text()
    assert red.returncode != 0 and "test result: FAILED" in log
    assert "capsule stole focus" in log or "external GTK focus was lost" in log, log
finally:
    source.write_bytes(original)
subprocess.run(build, check=True)
subprocess.run(live + ["--label", "suppression-green"], check=True)
assert source.read_bytes() == original
print("same named Cargo test: actual focus loss RED; exact source restore; GREEN; sha256=" + hashlib.sha256(original).hexdigest())
