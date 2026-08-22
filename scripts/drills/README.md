# Manual drills (real desktop required)

These are NOT part of `pnpm verify:delivery` and never will be: each one needs a
live desktop, a real target application and a real clipboard, which is exactly
why the defects they cover were invisible to a suite of 700+ headless tests.
They belong to the device line — run them on a machine, read the output, and put
the result in the round's ledger with the machine name on it.

---

## `clipboard-race-drill.ps1` — the injected text must beat the clipboard restore

**What it catches:** the 2026-08-22 P0 — FlowMic pasting the user's OWN previous
clipboard into the target while reporting `injected`. Full findings:
`docs/strategy/2026-08-22-clipboard-restore-race-findings.md`.

**Why it cannot be a unit test:** the whole clipboard suite drives `Box<dyn Fn>`
fakes, so "the target read our bytes rather than the restored ones" is not a
claim any of them can make. The headless half of this guard is
`inject::readback::hold_rule_drill` (the exit rule); this is the other half.

### Run it

```powershell
# 1. Start the target. `#1200` blocks its renderer for 1200ms on Ctrl+V, which
#    is what a busy Electron editor (Cursor, Windsurf, VS Code) looks like.
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
    --app="file:///<abs-path>/scripts/drills/clipboard-race-target.html#1200" --new-window

# 2. Replay the SHIPPED-AS-OF-0.3.23 sequence. This is the RED half.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\drills\clipboard-race-drill.ps1 -Legacy

# 3. Restart the target (its title changes once it reports), then the fixed one.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\drills\clipboard-race-drill.ps1 -HoldMs 1500
```

### Reading it

The target reports what it ACTUALLY received through its own window title, so the
verdict is read with `GetWindowText` and no UI automation is involved.

```
-Legacy   → TARGET REPORTS: GOT[OLDCLIP-xxxx]len=48     ← the defect, reproduced
default   → TARGET REPORTS: GOT[INJECTED-yyyy]len=49    ← the fix, reproduced
```

`GOT[OLDCLIP…]` from the default run means the regression is back.

### Two things this rig gets right, because the first version got them wrong

- **It refuses to type into the wrong window.** `SetForegroundWindow` fails
  silently under the Windows foreground lock; the rig forces the foreground with
  `AttachThreadInput` and then HARD-VERIFIES it, aborting without sending a
  keystroke if the target is not in front. A rig that silently retargets produces
  something that looks like a measurement of the product and is not — M5 paid for
  that lesson by typing 12 characters into `CLAUDE.md`.
- **It restores the clipboard with a real `HGLOBAL`.** `Set-Clipboard` hands over
  OLE-owned data that evaporates when the PowerShell process exits, which
  destroys whatever the user had copied. (Found the hard way.)

### Requirements

Windows, Microsoft Edge (any Chromium works — change the exe), Windows PowerShell
5.1 for `UIAutomationClient`. Nothing is installed and nothing is left behind;
close the target window when done.
