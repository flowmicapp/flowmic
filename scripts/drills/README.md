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

---

## `desktop-uia-probe.ps1` — read and drive the desktop UI from outside the app

**What it is for:** asserting what is ACTUALLY on the desktop's screen during a
real-device session, with timestamps. The main window is a WebView2, so its own
interface is a UIA tree — element names, rectangles, and presence/absence over
time are all readable, and `InvokePattern` can press a control the way a user
would.

**Why it cannot be a unit test:** it is the instrument, not the test. It exists
so that a device-line claim like 「the QR modal closes by itself after a new
phone pairs」 is three measured timestamps rather than a recollection.

**Two things that look like failures and are not** (both cost real time before
they were written down — see the script header): `TreeWalker` stops at the
WebView2 host, so only `FindAll(Descendants)` reaches the page; and the FIRST
query is expected to come back nearly empty, because WebView2 enables its
accessibility provider lazily on that very request. Ask twice.

**What it cannot see:** paint. A control it reports as present can still be
invisible to a human — that is `button-skin-door.test.ts`'s job, and the reason
that fence is separate.

### Run it

```powershell
pwsh -File scripts\drills\desktop-uia-probe.ps1 -Action list
pwsh -File scripts\drills\desktop-uia-probe.ps1 -Action list  -Match 添加手机 -Type Button
pwsh -File scripts\drills\desktop-uia-probe.ps1 -Action click -Match 添加手机 -Type Button -Exact
```

### Reading it

`Type | Name | x,y,WxH`, in document order, plus a `TOTAL=` line that also
reports how many elements were scanned — a scan count near 30 means you are
looking at the host chrome and should ask again.

⚠️ `-Index` is document order and it RE-ORDERS after every list mutation. Re-list
between two removals instead of reusing an index; on 2026-08-26 a reused index
deleted the wrong pairing. And `-Match "关闭"` matches the window's own close
button — pass `-Type` and check the rect before clicking.

### The phone half

`uiautomator dump` returns no text for a Flutter app (no semantics tree unless
an accessibility service is running), so the phone's channel is screenshots:
`adb exec-out screencap -p > shot.png`. Two more measured traps: a Chinese IME
rewrites `adb shell input text` (typing `https://…` produced 「还天天平时:、、」)
— switch to `com.android.inputmethod.latin/.LatinIME` for the duration and set
it back; and screencap sampling at ~1s intervals is too coarse to catch a
transient confirmation banner.
