#!/usr/bin/env python3
"""Build a native capsule probe with the real Linux window overlay and existing UI assets."""
import argparse
import json
import os
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--overlay", required=True)
parser.add_argument("--dist", required=True)
parser.add_argument("--negative-focusable", action="store_true")
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[1]
out = root / ".local/linux-focus/capsule"
out.mkdir(parents=True, exist_ok=True)
config = json.loads(pathlib.Path(args.overlay).read_text())
if args.negative_focusable:
    capsule = next(window for window in config["app"]["windows"] if window["label"] == "capsule")
    del capsule["focusable"]
config["build"] = {"devUrl": "http://127.0.0.1:1423", "frontendDist": str(pathlib.Path(args.dist).resolve())}
# The probe never spawns a sidecar or produces a distributable package. Omitting
# resources here is explicit, confined to this probe, and not packaging evidence.
config["bundle"] = {"resources": [], "active": False}
label = "negative" if args.negative_focusable else "positive"
(out / f"{label}-config.json").write_text(json.dumps(config, indent=2))
env = dict(os.environ, TAURI_CONFIG=json.dumps(config))
for key, directory in [("CARGO_HOME", "cargo-home"), ("CARGO_TARGET_DIR", "linux-target"), ("TMPDIR", "tmp")]:
    env.setdefault(key, str(root / ".local" / directory))
    pathlib.Path(env[key]).mkdir(parents=True, exist_ok=True)
command = ["cargo", "build", "--features", "app", "--example", "linux_capsule_probe", "--offline"]
with (out / f"{label}-build.log").open("w") as log:
    result = subprocess.run(command, cwd=root / "apps/desktop/src-tauri", env=env, stdout=log, stderr=subprocess.STDOUT)
print(f"linux-capsule-build {label}: exit={result.returncode}; log={out / (label + '-build.log')}")
raise SystemExit(result.returncode)
