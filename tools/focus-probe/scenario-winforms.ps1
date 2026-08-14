<#
  SPEC-REF: docs/strategy/2026-08-02-f1b-universal-focus-probe-matrix.md
  🔴 NOT PRODUCT. Spike instrument.

  The CLASSIC WIN32 ground-truth control for the F1b matrix.

  scenario-page.html gives the four scenarios inside a Chromium renderer, where
  「is there a caret」 is whatever Blink decided to tell the OS. This file gives the
  same four scenarios in plain Win32 EDIT controls, where the answer is not a matter
  of opinion: an EDIT with focus owns a real system caret, a Button does not. If a
  criterion cannot separate the four scenarios HERE, it cannot separate them
  anywhere; if it separates them here but not in Chromium, that difference is
  exactly the 「普适度」 the report has to price.

  Run with Windows PowerShell (STA):
    powershell.exe -STA -NoProfile -File tools/focus-probe/scenario-winforms.ps1
#>
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$PHASES = @('none', 'input', 'button', 'readonly')
$DWELL_MS = 9000
$ROUNDS = 2

$form = New-Object System.Windows.Forms.Form
$form.Text = 'FLOWMICPROBE PHASE:boot'
$form.Size = New-Object System.Drawing.Size(760, 420)
$form.StartPosition = 'CenterScreen'

$lbl = New-Object System.Windows.Forms.Label
$lbl.Text = 'boot'; $lbl.Font = New-Object System.Drawing.Font('Segoe UI', 28, [System.Drawing.FontStyle]::Bold)
$lbl.SetBounds(20, 15, 700, 60)

$txt = New-Object System.Windows.Forms.TextBox
$txt.SetBounds(20, 90, 700, 32); $txt.Font = New-Object System.Drawing.Font('Segoe UI', 14)
$txt.Text = ''

$btn = New-Object System.Windows.Forms.Button
$btn.SetBounds(20, 140, 700, 40); $btn.Text = 'button (focusable, not a text field)'

$ro = New-Object System.Windows.Forms.TextBox
$ro.SetBounds(20, 200, 700, 90); $ro.Multiline = $true; $ro.ReadOnly = $true
$ro.Font = New-Object System.Drawing.Font('Segoe UI', 14)
$ro.Text = 'readonly EDIT control'

$note = New-Object System.Windows.Forms.Label
$note.SetBounds(20, 300, 700, 40)
$note.Text = 'FlowMic F1b focus probe — 请勿输入，窗口会自己切换焦点'

$form.Controls.AddRange(@($lbl, $txt, $btn, $ro, $note))

$script:i = 0
$total = $PHASES.Count * $ROUNDS
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $DWELL_MS

$apply = {
  if ($script:i -ge $total) {
    $form.Text = 'FLOWMICPROBE PHASE:done'; $lbl.Text = 'done'
    $form.ActiveControl = $null; $timer.Stop(); return
  }
  $name = $PHASES[$script:i % $PHASES.Count]
  # Title FIRST — a sample taken mid-change must not carry the phase it is leaving.
  $form.Text = "FLOWMICPROBE PHASE:$name"
  $lbl.Text = $name
  switch ($name) {
    'none' { $form.ActiveControl = $null }
    'input' { $txt.Focus() | Out-Null }
    'button' { $btn.Focus() | Out-Null }
    'readonly' { $ro.Focus() | Out-Null }
  }
  $script:i++
}

$timer.Add_Tick($apply)
# 🔴 Start on ACTIVATION, not on Shown: focusing a control in a window that is not
# active does not produce an OS caret, so an early start would measure nothing.
$script:started = $false
$form.Text = 'FLOWMICPROBE PHASE:waiting'
$start = {
  if ($script:started) { return }
  $script:started = $true
  $form.ActiveControl = $null
  & $apply
  $timer.Start()
}
$form.Add_Activated($start)
# 🔴 Fallback: this machine's session can have NO foreground window at all (measured
# 2026-08-02 — RDP session Active but GetForegroundWindow()==0 and
# SetForegroundWindow() refuses). Waiting for activation forever would produce an
# empty matrix and no information. Starting anyway turns the run into a different,
# still useful experiment: 「does focusing a control produce a caret when the window
# is NOT the foreground one?」 — and this WinForms target, with real EDIT controls,
# is the control that says whether that experiment can see anything at all.
$boot = New-Object System.Windows.Forms.Timer
$boot.Interval = 3000
$boot.Add_Tick({ $boot.Stop(); & $start })
$form.Add_Shown({ $form.Activate(); $boot.Start() })
[System.Windows.Forms.Application]::Run($form)
