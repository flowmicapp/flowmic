param(
  [Parameter(Mandatory=$true)][string]$WebRoot,
  [Parameter(Mandatory=$true)][string]$WebsiteRoot,
  [string]$BaseWebRoot,
  [string]$Out = '.local/wv7-rig2',
  [switch]$Dry
)
$env:__COMPAT_LAYER = $null
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$env:FLOWMIC_EMB13_LIVE = '1'
$env:FLOWMIC_EMB13_DRY = $(if ($Dry) { '1' } else { '0' })
$env:FLOWMIC_EMB13_WV7 = '1'
$env:FLOWMIC_EMB13_WEB_ROOT = $WebRoot
$env:FLOWMIC_EMB13_WEBSITE_ROOT = $WebsiteRoot
$env:FLOWMIC_EMB13_SENTENCES = '2'
$env:FLOWMIC_EMB13_T4_RUNS = '5'
$env:FLOWMIC_EMB13_MAX_MINUTES = '20'
# Two budget rows per surface: one cold first click and one reused capture.
# The estimate reserves 15 streamed seconds per recording, as the rig does.
$plan = @(
  @{ Scenario='budget'; Surfaces='home,try,sdk'; Minutes=1.5 },
  @{ Scenario='escape-scoped'; Surfaces='home,try,sdk'; Minutes=4.5 },
  @{ Scenario='gestures'; Surfaces='home,try,sdk'; Minutes=5.25 },
  @{ Scenario='first-word'; Surfaces='home,try,sdk'; Minutes=5.25 },
  @{ Scenario='placement'; Surfaces='sdk'; Minutes=0.5 }
)
# Only use a base that reaches recording on one SDK press. The old chooser
# baseline cannot isolate first-word loss and must be reported as inapplicable.
if ($BaseWebRoot) { $plan += @{ Scenario='first-word'; Surfaces='sdk'; Minutes=1.75; Base=$true } }
$total = ($plan | Measure-Object -Property Minutes -Sum).Sum
if ($total -gt 20) { throw "Plan exceeds 20 minutes: $total" }
Write-Output "Planned transcription: $total minutes (estimate; not a billing guarantee)."
$failed = $false
foreach ($run in $plan) {
  $env:FLOWMIC_EMB13_WEB_ROOT = $(if ($run.Base) { $BaseWebRoot } else { $WebRoot })
  $env:FLOWMIC_EMB13_WV7_SCENARIO = $run.Scenario
  $env:FLOWMIC_EMB13_WV7_SURFACES = $run.Surfaces
  $label = "$(if ($run.Base) { 'base-' })$($run.Scenario)"
  $env:FLOWMIC_EMB13_WV7_OUT = Join-Path $Out $label
  node scripts/emb13-live-rig.mjs
  $code = $LASTEXITCODE
  if ($Dry -and $code -ne 0) { throw "DRY failed for $label" }
  if (!$Dry -and !$run.Base -and $code -ne 0) { $failed = $true }
  if ($run.Base) { Write-Output "Base exit=$code; inspect five first-word rows and reference before claiming a red control." }
}
if ($failed) { exit 1 }
