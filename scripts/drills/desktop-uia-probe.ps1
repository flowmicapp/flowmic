# desktop-uia-probe.ps1 — read and drive the desktop UI from outside the app.
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
# FlowMic's main window is a WebView2, so ITS OWN INTERFACE IS A UIA TREE
# (measured 2026-08-03, M5). That means a real-device session can assert on
# what is actually on screen — element names, positions, and whether a control
# is still there a second later — instead of eyeballing screenshots. Used on
# 2026-08-26 to verify card PAIR-SUCCESS end to end: the QR modal was still up
# at T+1.1s, gone at T+2.3s, and the newly paired phone was in the list at
# T+3.8s. No screenshot comparison could have produced those three timestamps.
#
# ── 🔴 TWO THINGS THAT LOOK LIKE FAILURES AND ARE NOT ───────────────────────
#
# 1. TreeWalker STOPS at the WebView2 host: walking children reports about two
#    elements for the whole page. Only FindAll(Descendants) crosses into the
#    document. M5 wrote that down; this script is the version that remembers.
#
# 2. THE FIRST QUERY IS SUPPOSED TO COME BACK NEARLY EMPTY. WebView2 enables
#    its accessibility provider lazily, ON the first UIA request — so query one
#    returns the host chrome (~28 elements) and query two returns the page
#    (~109). Measured 2026-08-26. Reading run one as 「the tree is not
#    reachable」 is the trap: ask twice before concluding anything.
#
# ── WHAT IT CANNOT DO ───────────────────────────────────────────────────────
# It sees the desktop only. The phone half of any cross-device claim needs adb
# (`uiautomator dump` is useless on Flutter — no semantics unless an
# accessibility service is running — so screenshots are the phone's channel).
#
# It cannot see PAINT: a control it reports as present may still be invisible
# to a human (that is the button-skin door's territory, and the reason that
# door is a separate static fence).
#
# ⚠️ `-Match "关闭"` matches the WINDOW's close button as well as any in-page
# 「关闭」. That cost one accidental window close on 2026-08-26. Pass -Type and
# check the rect before clicking by index; -Index is document order and it
# RE-ORDERS after every list mutation, so re-list between two removals rather
# than reusing an index (that cost one wrong pairing being deleted).
#
# Usage:
#   pwsh -File scripts/drills/desktop-uia-probe.ps1 -Action list
#   pwsh -File scripts/drills/desktop-uia-probe.ps1 -Action list -Match 添加手机 -Type Button
#   pwsh -File scripts/drills/desktop-uia-probe.ps1 -Action click -Match 添加手机 -Type Button -Exact

param(
  [string]$Action = "list",        # list | click | find
  [string]$Match = "",             # substring of the element Name
  [string]$Window = "FlowMic",     # top-level window name (exact)
  [int]$Index = 0,                 # which match to act on
  [string]$Type = "",              # restrict to a ControlType, e.g. Button
  [switch]$Exact                   # Name must equal -Match, not contain it
)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

function Get-Root([string]$title) {
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $title)
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  # A WebView2 host: TreeWalker stops outside it, so the whole page is only
  # reachable with FindAll(Descendants) -- measured 2026-08-03 (M5).
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}

$win = Get-Root $Window
if ($null -eq $win) { Write-Output "WINDOW-NOT-FOUND: $Window"; exit 2 }

$all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)

$rows = @()
foreach ($e in $all) {
  $n = ""
  try { $n = $e.Current.Name } catch {}
  if ($n -eq "") { continue }
  if ($Match -ne "") {
    if ($Exact) { if ($n -ne $Match) { continue } }
    elseif ($n -notlike "*$Match*") { continue }
  }
  if ($Type -ne "" -and ($e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', '') -ne $Type) { continue }
  $r = $e.Current.BoundingRectangle
  # An off-screen / not-yet-laid-out element reports an infinite rect; casting
  # that to int throws. Say "offscreen" rather than crash the whole scan.
  $rect = "offscreen"
  if (-not ([double]::IsInfinity($r.X) -or [double]::IsInfinity($r.Width))) {
    $rect = "$([int]$r.X),$([int]$r.Y),$([int]$r.Width)x$([int]$r.Height)"
  }
  $rows += [pscustomobject]@{
    Name = $n
    Type = $e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
    Rect = $rect
    El   = $e
  }
}

if ($Action -eq "list" -or $Action -eq "find") {
  $rows | ForEach-Object { Write-Output ("{0} | {1} | {2}" -f $_.Type, $_.Name, $_.Rect) }
  Write-Output "TOTAL=$($rows.Count) (scanned $($all.Count) elements)"
  exit 0
}

if ($Action -eq "click") {
  if ($rows.Count -eq 0) { Write-Output "NO-MATCH: $Match"; exit 3 }
  $t = $rows[$Index]
  $inv = $null
  try { $inv = $t.El.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) } catch {}
  if ($null -ne $inv) {
    $inv.Invoke()
    Write-Output "INVOKED: $($t.Name)"
  } else {
    # No InvokePattern (a plain div with a click handler): click its centre.
    $r = $t.El.Current.BoundingRectangle
    $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
    Add-Type @"
using System;using System.Runtime.InteropServices;
public class M{
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,IntPtr e);
}
"@ -ErrorAction SilentlyContinue
    [M]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 150
    [M]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
    [M]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
    Write-Output "CLICKED-AT: $($t.Name) @ $x,$y"
  }
  exit 0
}
