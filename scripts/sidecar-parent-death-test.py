#!/usr/bin/env python3
"""Build the sidecar + `cargo build --example sidecar_parent`, then run on Unix.

The same exit/port assertions must FAIL with --mode unguarded (reverse control).
All process cleanup is by PID returned from processes this harness starts.
"""
import argparse
import os
import re
import select
import signal
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path


def alive(pid):
    state = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")


def listening(port):
    with socket.socket() as sock:
        sock.settimeout(0.2)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def wait_for(check, seconds=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.05)
    return check()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--server", required=True)
    parser.add_argument("--mode", choices=["guarded", "pipe-only", "kernel-only", "unguarded", "reclaim", "refuse", "live-owner"], default="guarded")
    args = parser.parse_args()
    children, parents = [], []
    with tempfile.TemporaryDirectory(prefix="nr136-") as scratch:
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]

        def start(mode, home, server=None, executable=None):
            parent = subprocess.Popen([executable or args.parent, mode, args.node, server or args.server, str(port), str(home)],
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            parents.append(parent)
            assert select.select([parent.stdout], [], [], 25)[0], "parent readiness timeout"
            match = re.search(r"NR136 pid=(\d+)", parent.stdout.readline())
            assert match, "parent failed to spawn sidecar"
            child = int(match.group(1))
            children.append(child)
            assert wait_for(lambda: listening(port)), "sidecar never listened"
            return parent, child

        try:
            if args.mode == "live-owner":
                desktop = Path(scratch) / "flowmic-desktop"
                shutil.copy2(args.parent, desktop)
                parent, child = start("unguarded", Path(scratch) / "live", executable=str(desktop))
                attempt = subprocess.Popen([args.parent, "reclaim", args.node, args.server, str(port), str(Path(scratch) / "new")],
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                parents.append(attempt)
                assert attempt.wait(timeout=25) != 0, "live desktop sidecar was replaced"
                assert parent.poll() is None and alive(child) and listening(port), "live owner sidecar was killed"
                print(f"PASS preserved live desktop owner: owner={parent.pid} sidecar={child} port={port}", flush=True)
                return
            if args.mode == "refuse":
                foreign = Path(scratch) / "foreign.js"
                foreign.write_text("require('node:http').createServer((q,r)=>r.end('foreign')).listen(Number(process.argv.at(-1)), '127.0.0.1');")
                parent, child = start("unguarded", Path(scratch) / "foreign-home", str(foreign))
                parent.kill()
                parent.wait(timeout=5)
                attempt = subprocess.Popen([args.parent, "reclaim", args.node, args.server, str(port), str(Path(scratch) / "new")],
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                parents.append(attempt)
                assert attempt.wait(timeout=25) != 0, "unrelated listener was killed/adopted"
                assert alive(child) and listening(port), "unrelated orphan was killed"
                print(f"PASS refused unrelated orphan: pid={child} port={port}", flush=True)
                return
            mode = "unguarded" if args.mode == "reclaim" else args.mode
            parent, child = start(mode, Path(scratch) / "old")
            time.sleep(2)
            assert parent.poll() is None and alive(child) and listening(port), "backstop fired during normal operation"
            print(f"PASS normal survival: mode={mode} parent={parent.pid} sidecar={child} port={port}", flush=True)
            parent.kill()  # SIGKILL, bypasses every graceful desktop exit path.
            parent.wait(timeout=5)
            if args.mode == "reclaim":
                assert alive(child) and listening(port), "legacy control did not leave an orphan"
                parent, replacement = start("reclaim", Path(scratch) / "new")
                assert replacement != child and not alive(child), "stale sidecar was adopted or survived"
                print(f"PASS verified stale orphan reclaimed: old={child} new={replacement} port={port}", flush=True)
                child = replacement
                parent.kill()
                parent.wait(timeout=5)
            started = time.monotonic()
            assert wait_for(lambda: not alive(child) and not listening(port), 3), \
                "FAIL sidecar survived parent SIGKILL or retained its port after 3 seconds"
            # A bind proves release independently of HTTP health/probe behavior.
            with socket.socket() as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind(("127.0.0.1", port))
            print(f"PASS SIGKILL: mode={args.mode} sidecar exited + port freed in {time.monotonic()-started:.3f}s (<3s)", flush=True)
        finally:
            for parent in parents:
                if parent.poll() is None:
                    parent.kill()
                parent.wait(timeout=5)
            for child in children:
                if alive(child):
                    os.kill(child, signal.SIGKILL)


if __name__ == "__main__":
    main()
