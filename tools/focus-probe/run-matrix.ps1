<#
  SPEC-REF: docs/strategy/2026-08-02-f1b-universal-focus-probe-matrix.md
  🔴 NOT PRODUCT. Spike driver.

  One target app, three passes, four scenarios each. What each pass exists for:

    pass 1 「base」  — TWO probes at once, one HIGH-integrity and one MEDIUM. Run
                      concurrently on purpose: sequential runs would compare two
                      different page instances and 「the columns differ」 could then
                      mean 「the app changed」 instead of 「the token mattered」.
    pass 2 「attach」 — one MEDIUM probe that does AttachThreadInput first. Must be a
                      SEPARATE launch: attaching MERGES the two input queues, so an
                      attaching probe can change what a non-attaching one sees.
    pass 3 「uia」    — one MEDIUM probe that also asks UIA for the focused element.
                      Must be a SEPARATE launch: Chromium builds its a11y surface
                      (and, historically, its system caret) only once an AT client
                      asks — a probe that queries UIA in the same pass can
                      MANUFACTURE the caret it is measuring.

  🔴 The TARGET is always launched at MEDIUM integrity, because that is what the
  owner's apps are and what the product will be reading. Launching it from this
  elevated dev shell would produce a high-integrity target and a matrix about a
  configuration nobody runs.

  Usage:
    pwsh -NoProfile -File tools/focus-probe/run-matrix.ps1 -Target chrome
    pwsh -NoProfile -File tools/focus-probe/run-matrix.ps1 -Target winforms -Passes base
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('chrome', 'chrome-a11y', 'edge', '360', 'winforms', 'explorer')]
  [string]$Target,
  [string]$OutDir = "$env:TEMP\flowmic-f1b",
  [int]$Seconds = 82,
  [ValidateSet('base', 'attach', 'uia', 'all')] [string]$Passes = 'all',
  [switch]$KeepOpen
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$probe = Join-Path $here 'focus-probe.ps1'
$page = Join-Path $here 'scenario-page.html'
$winforms = Join-Path $here 'scenario-winforms.ps1'
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force $OutDir | Out-Null }

$pageUrl = 'file:///' + ($page -replace '\\', '/')

function Get-TargetSpec {
  param([string]$t, [string]$profileDir)
  switch ($t) {
    'chrome' { @{ exe = 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'; a = "--user-data-dir=`"$profileDir`" --no-first-run --no-default-browser-check --new-window `"$pageUrl`"" } }
    # Same browser, accessibility forced on. The discriminator for 「Chromium reports
    # no caret」 vs 「Chromium reports no caret UNTIL an AT client shows up」 — the two
    # have completely different consequences for a product that must not depend on
    # whether a screen reader happens to be running on the user's machine.
    'chrome-a11y' { @{ exe = 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'; a = "--user-data-dir=`"$profileDir`" --no-first-run --no-default-browser-check --force-renderer-accessibility --new-window `"$pageUrl`"" } }
    'edge' { @{ exe = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'; a = "--user-data-dir=`"$profileDir`" --no-first-run --no-default-browser-check --new-window `"$pageUrl`"" } }
    '360' { @{ exe = "$env:LOCALAPPDATA\360ChromeX\Chrome\Application\360ChromeX.exe"; a = "--user-data-dir=`"$profileDir`" --no-first-run --no-default-browser-check --new-window `"$pageUrl`"" } }
    'winforms' { @{ exe = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'; a = "-STA -NoProfile -File `"$winforms`"" } }
    'explorer' { @{ exe = 'C:\Windows\explorer.exe'; a = "`"$env:USERPROFILE\Documents`"" } }
  }
}

function Start-Target {
  param([hashtable]$spec)
  if (-not (Test-Path $spec.exe)) { throw "target exe not found: $($spec.exe)" }
  # Launch through the probe's -Mode launch so the child inherits a MEDIUM token.
  # `-ExeArgs:<value>` (colon form) because the value itself starts with a dash —
  # the space form would let the child binder eat `-STA` as one of its own params.
  $out = & pwsh -NoProfile -File $probe -Mode launch -DropToMedium -Exe $spec.exe "-ExeArgs:$($spec.a)"
  $out | Write-Host
  $line = $out | Where-Object { $_ -match 'LAUNCHED_PID=(\d+)' }
  if ($line -match 'LAUNCHED_PID=(\d+)') { return [int]$Matches[1] }
  return 0
}

function Stop-Target {
  param([int]$launchedPid)
  # ONLY the process this script started. Nothing the owner opened is ever touched.
  if ($launchedPid -le 0) { return }
  try {
    $p = Get-Process -Id $launchedPid -ErrorAction Stop
    $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$launchedPid" -ErrorAction SilentlyContinue
    $p.CloseMainWindow() | Out-Null
    Start-Sleep -Milliseconds 1500
    if (-not $p.HasExited) { Stop-Process -Id $launchedPid -Force -ErrorAction SilentlyContinue }
    foreach ($k in $kids) { Stop-Process -Id $k.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch { }
}

function Invoke-Pass {
  param([string]$name, [string[]]$probeSets)
  $profileDir = Join-Path $OutDir "profile-$Target-$name"
  if (Test-Path $profileDir) { Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue }
  $spec = Get-TargetSpec -t $Target -profileDir $profileDir

  Write-Host "=== $Target / pass=$name ==="
  $launchedPid = Start-Target -spec $spec

  # Try to make the scenario window the foreground one. On a session that HAS a
  # foreground, this is the production geometry and probes read GetForegroundWindow.
  # On this machine it fails (see -Follow below) and every sample says so.
  $activated = $false
  for ($k = 0; $k -lt 8; $k++) {
    Start-Sleep -Seconds 1
    $r = & pwsh -NoProfile -File $probe -Mode activate -RequireTitle 'FLOWMICPROBE' 2>&1
    if ("$r" -match 'fg=FLOWMICPROBE') { $activated = $true; Write-Host "    activated after $($k+1)s (production geometry)" ; break }
  }
  if (-not $activated) {
    Write-Host "    ⚠️ could not activate — falling back to -Follow (read the SCENARIO thread, not the foreground one)."
    Write-Host "       Every sample is stamped followed=true. See the report's validity section."
  }

  $jobs = @()
  foreach ($ps in $probeSets) {
    $cfg = $ps -split ';'
    $tag = $cfg[0]
    # NOT `$args` — that is an automatic variable inside a function.
    $pargs = @('-NoProfile', '-File', $probe, '-Mode', 'watch', '-Seconds', "$Seconds",
      '-IntervalMs', '200', '-Quiet', '-RequireTitle', 'FLOWMICPROBE',
      '-Label', "$Target/$tag", '-Json', (Join-Path $OutDir "$Target-$name-$tag.jsonl"))
    if (-not $activated) { $pargs += '-Follow' }
    if ($cfg -contains 'medium') { $pargs += '-DropToMedium' }
    if ($cfg -contains 'attach') { $pargs += '-Attach' }
    if ($cfg -contains 'uia') { $pargs += @('-Uia', 'focused') }
    Write-Host "    probe[$tag]: pwsh $($pargs -join ' ')"
    $jobs += Start-Process -FilePath 'pwsh' -ArgumentList $pargs -PassThru -WindowStyle Hidden `
      -RedirectStandardError (Join-Path $OutDir "$Target-$name-$tag.err.txt")
  }
  foreach ($j in $jobs) { $j.WaitForExit() }
  if (-not $KeepOpen) { Stop-Target -launchedPid $launchedPid }
}

# Remember who had the foreground so it can be handed back — this machine belongs to
# the owner, and the spike is a guest on it.
$prevFg = 0
$fgLine = & pwsh -NoProfile -File $probe -Mode fgnow
if ("$fgLine" -match 'hwnd=(-?\d+)') { $prevFg = [long]$Matches[1] }
Write-Host "# foreground before the spike: $fgLine"

if ($Passes -in @('base', 'all')) { Invoke-Pass -name 'base' -probeSets @('high', 'medium;medium') }
if ($Passes -in @('attach', 'all')) { Invoke-Pass -name 'attach' -probeSets @('mediumattach;medium;attach') }
if ($Passes -in @('uia', 'all')) { Invoke-Pass -name 'uia' -probeSets @('mediumuia;medium;uia') }

if ($prevFg -ne 0) {
  & pwsh -NoProfile -File $probe -Mode foreground -Hwnd $prevFg | Write-Host
}

Write-Host ''
Write-Host "=== SUMMARY ($Target) ==="
Get-ChildItem $OutDir -Filter "$Target-*.jsonl" | Sort-Object Name | ForEach-Object {
  Write-Host "--- $($_.Name)"
  & pwsh -NoProfile -File $probe -Mode summarize -Json $_.FullName
}
