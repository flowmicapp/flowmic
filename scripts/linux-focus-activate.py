#!/usr/bin/env python3
"""Independent desktop activation: native X11 or an explicitly configured host driver."""
import json
import os
import subprocess
import sys

title, xid = sys.argv[1:3]
configured = os.environ.get("FLOWMIC_FOCUS_ACTIVATE_ARGV")
if configured:
    command = json.loads(configured)
    assert isinstance(command, list) and command and all(isinstance(arg, str) for arg in command)
    command = [arg.replace("{title}", title).replace("{xid}", xid) for arg in command]
else:
    assert not os.environ.get("WSL_DISTRO_NAME"), "WSLg requires FLOWMIC_FOCUS_ACTIVATE_ARGV: JSON argv for its host activation driver, with {title}/{xid} placeholders"
    assert xid != "0", "native Wayland activation requires FLOWMIC_FOCUS_ACTIVATE_ARGV"
    command = ["xdotool", "windowactivate", "--sync", xid]
result = subprocess.run(command, text=True, capture_output=True, timeout=10)
print(result.stdout, end="")
print(result.stderr, end="", file=sys.stderr)
assert result.returncode == 0, f"independent desktop activation failed: {result.returncode}"
assert "False" not in result.stdout, "host activation driver refused the window"
