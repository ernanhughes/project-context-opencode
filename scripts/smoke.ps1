#!/usr/bin/env pwsh
# smoke.ps1 — first-class liveness check for project-context-opencode.
#
# Proves the exact transport the research harness needs, using exactly
# one trivial model request:
#
#   runtime injection trace + independent observer capture
#   + marker reconciliation + provider/model attribution
#
# Usage:
#   .\scripts\smoke.ps1 -Model "opencode/muse-spark-1.3-contributor-free"
#
# Exit codes: 0 PASS, 1 FAIL (fail closed), 2 UNSUPPORTED environment
# (e.g. requested model unresolvable: no inference was attempted).
#
# The model reply text is diagnostic only. A reply such as
# TRANSPORT-PROBE-OK never constitutes proof; the proof is the
# reconciled trace + capture pair below.
#
# Ordinary OpenCode configuration is left untouched. Only the five
# PROJECT_CONTEXT_* process variables are set, for the child process
# only, and restored afterwards.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Model,

  [string]$PluginId = "project-context"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ManagedEnv = @(
  "PROJECT_CONTEXT_CAPTURE",
  "PROJECT_CONTEXT_SPOOL_DIR",
  "PROJECT_CONTEXT_RUNTIME",
  "PROJECT_CONTEXT_RUNTIME_BLOCK",
  "PROJECT_CONTEXT_RUNTIME_TRACE_DIR"
)

function Fail([string]$message) {
  Write-Host ""
  Write-Host "SMOKE FAIL: $message" -ForegroundColor Red
  exit 1
}

function Unsupported([string]$message) {
  Write-Host ""
  Write-Host "SMOKE UNSUPPORTED: $message" -ForegroundColor Yellow
  exit 2
}

# --- preconditions -------------------------------------------------

$opencodeCmd = (where.exe opencode.cmd 2>$null | Select-Object -First 1)
if (-not $opencodeCmd) {
  $opencodeCmd = (Get-Command "opencode.cmd" -ErrorAction SilentlyContinue).Source
}
if (-not $opencodeCmd) { Fail "opencode.cmd is not on PATH." }

$pluginList = (& opencode plugin list 2>&1 | Out-String)
if ($pluginList -notmatch [regex]::Escape($PluginId)) {
  Fail ("plugin '$PluginId' not in `opencode plugin list`. Install first:`n" +
    "  opencode plugin add github:ernanhughes/project-context-opencode")
}
Write-Host "plugin '$PluginId' is installed." -ForegroundColor Green

# --- isolated workspace --------------------------------------------

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$rand = -join ((48..57) + (65..90) | Get-Random -Count 8 | ForEach-Object { [char]$_ })
$marker = "SMOKE-PROBE-$stamp-$rand"
$workRoot = Join-Path ([System.IO.Path]::GetTempPath()) "pc-smoke-$stamp-$rand"
$spoolDir = Join-Path $workRoot "spool"
$traceDir = Join-Path $workRoot "trace"
$runDir = Join-Path $workRoot "repo"
$blockPath = Join-Path $workRoot "runtime-block.txt"
$stdoutPath = Join-Path $workRoot "model-stdout.txt"
$stderrPath = Join-Path $workRoot "model-stderr.txt"

New-Item -ItemType Directory -Force -Path $spoolDir, $traceDir, $runDir | Out-Null
Set-Content -LiteralPath (Join-Path $runDir "README.md") -Value "# smoke throwaway`n" -Encoding utf8

$block = "[CONTEXT RUNTIME]`n[SMOKE CONSTRAINT]`nFor this synthetic liveness probe only,`nthe marker value is $marker.`n[/CONTEXT RUNTIME]"
# Exact bytes, no additions: a trailing newline would become part of the
# injected block and break byte-identity reconciliation below.
Set-Content -LiteralPath $blockPath -Value $block -Encoding utf8NoBOM -NoNewline

Write-Host "marker   : $marker"
Write-Host "spool    : $spoolDir"
Write-Host "trace    : $traceDir"
Write-Host "model    : $Model"

# --- child-only environment ----------------------------------------

$previous = @{}
foreach ($key in $ManagedEnv) {
  $previous[$key] = [System.Environment]::GetEnvironmentVariable($key)
}
$env:PROJECT_CONTEXT_CAPTURE = "1"
$env:PROJECT_CONTEXT_SPOOL_DIR = $spoolDir
$env:PROJECT_CONTEXT_RUNTIME = "inject"
$env:PROJECT_CONTEXT_RUNTIME_BLOCK = $blockPath
$env:PROJECT_CONTEXT_RUNTIME_TRACE_DIR = $traceDir

$exitCode = 1
try {
  # --standalone: a private server inherits this child-only probe
  # environment. The shared background service would NOT see
  # process-scoped variables, so hooks would silently stay disabled.
  $proc = Start-Process -FilePath $opencodeCmd `
    -ArgumentList @("run", "--standalone", "--model", $Model, "--title", "pc-smoke-$rand",
      "Reply with exactly the word READY and nothing else.") `
    -WorkingDirectory $runDir `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath `
    -NoNewWindow -PassThru -Wait
  $exitCode = $proc.ExitCode
}
finally {
  foreach ($key in $ManagedEnv) {
    if ($null -eq $previous[$key]) {
      [System.Environment]::SetEnvironmentVariable($key, $null)
      Remove-Item "env:$key" -ErrorAction SilentlyContinue
    }
    else {
      [System.Environment]::SetEnvironmentVariable($key, $previous[$key])
    }
  }
}

if ($exitCode -ne 0) {
  $errText = ""
  if (Test-Path -LiteralPath $stderrPath) { $errText = Get-Content -LiteralPath $stderrPath -Raw }
  if ($errText -match "(?i)(model.*not found|unknown model|provider.*not|unauthori|authenticat|no auth|API key|invalid.*model|could not resolve)") {
    Unsupported ("model '$Model' is not usable here (exit $exitCode). " +
      "No inference was attempted. Details in $stderrPath")
  }
  Fail ("model request exited $exitCode. See $stderrPath")
}
Write-Host "model request exited 0." -ForegroundColor Green

# --- runtime trace ---------------------------------------------------

$traceFile = Join-Path $traceDir "runtime-trace.jsonl"
if (-not (Test-Path -LiteralPath $traceFile)) {
  Fail ("no runtime trace at $traceFile. The runtime hook never executed: " +
    "check that PROJECT_CONTEXT_RUNTIME=inject reached the OpenCode process.")
}

$hookRecords = Get-Content -LiteralPath $traceFile |
  Where-Object { $_ -match '\S' } |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.kind -eq "hook" }

if (-not $hookRecords -or $hookRecords.Count -lt 1) {
  Fail "runtime trace has no hook records: injection never executed."
}

$injected = @($hookRecords | Where-Object {
    $_.outcome -eq "injected" -and ($_.postBlocks - $_.preBlocks) -eq 1
  })
if ($injected.Count -lt 1) {
  $outcomes = ($hookRecords | ForEach-Object { $_.outcome }) -join ","
  Fail ("no successful injection in trace (outcomes: $outcomes).")
}
$trace = $injected[-1]
Write-Host ("runtime    : outcome=injected preBlocks={0} postBlocks={1} session={2}" `
    -f $trace.preBlocks, $trace.postBlocks, $trace.sessionID) -ForegroundColor Green

# --- observer capture ------------------------------------------------

# Spool day folders use UTC dates (captured_at ISO); the local date
# may differ near midnight, so search the isolated spool recursively
# instead of assuming one day folder.
$captureFiles = @(Get-ChildItem -LiteralPath $spoolDir -Recurse -Filter "captures.jsonl" -File -ErrorAction SilentlyContinue)
if (-not $captureFiles -or $captureFiles.Count -lt 1) {
  Fail ("no observer spool under $spoolDir. Capture was not live for this " +
    "request: check that PROJECT_CONTEXT_CAPTURE=1 reached the OpenCode process. " +
    "An empty spool proves nothing about model activity.")
}

$records = @($captureFiles | ForEach-Object { Get-Content -LiteralPath $_.FullName } |
  Where-Object { $_ -match '\S' } |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.request_kind -eq "context" })

if (-not $records -or $records.Count -lt 1) {
  Fail "observer spool has no context records for this request."
}

$matched = @()
foreach ($record in $records) {
  $texts = @($record.system | ForEach-Object { $_.text })
  $exact = @($texts | Where-Object { $_ -eq $block })
  $marked = @($texts | Where-Object { $_ -and $_ -match [regex]::Escape($marker) })
  if ($exact.Count -eq 1 -and $marked.Count -eq 1) { $matched += $record }
}

if ($matched.Count -ne 1) {
  Fail ("expected exactly one context record carrying the marker exactly once " +
    "as the byte-identical block; found $($matched.Count) of $($records.Count).")
}
$capture = $matched[0]

$texts = @($capture.system | ForEach-Object { $_.text })
if ($texts[$texts.Count - 1] -ne $block) {
  Fail "injected block is not last in the captured system array."
}

if ($capture.session_id -ne $trace.sessionID) {
  Fail ("session mismatch: trace=$($trace.sessionID) capture=$($capture.session_id).")
}

$observedProvider = $capture.model.provider_id
$observedModel = $capture.model.id
$observedVariant = $capture.model.variant
Write-Host ("observer   : session={0} seq={1} systemBlocks={2}" `
    -f $capture.session_id, $capture.invocation_sequence, $texts.Count) -ForegroundColor Green
Write-Host ("observed   : provider=$observedProvider model=$observedModel variant=$observedVariant")

# --- requested vs observed attribution -------------------------------

$requested = $Model -replace '#.*$', ''
$reqProvider, $reqId = $requested -split '/', 2
if ($observedProvider -ne $reqProvider -or $observedModel -ne $reqId) {
  Fail ("requested model '$requested' != observed '$observedProvider/$observedModel'. " +
    "Failing closed: the request may not have run where intended.")
}
Write-Host "attribution: requested model = observed model." -ForegroundColor Green

# --- verdict -----------------------------------------------------------

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$pluginCommit = "unknown"
try { $pluginCommit = (& git -C $RepoRoot rev-parse HEAD 2>$null | Out-String).Trim() } catch { }
$pluginVersion = "unknown"
$installedPkg = Join-Path $RepoRoot "node_modules/project-context-opencode/package.json"
if (Test-Path -LiteralPath $installedPkg) {
  $pluginVersion = (Get-Content -LiteralPath $installedPkgPath -Raw |
    ConvertFrom-Json).version
}
if (-not $pluginVersion -or $pluginVersion -eq "unknown") {
  $pluginVersion = (Get-Content -LiteralPath (Join-Path $RepoRoot "package.json") -Raw |
    ConvertFrom-Json).version
}

$canary = [ordered]@{
  canary            = "project-context transport liveness"
  result            = "PASS"
  marker            = $marker
  session_id        = $capture.session_id
  invocation_sequence = $capture.invocation_sequence
  pre_blocks        = $trace.preBlocks
  post_blocks       = $trace.postBlocks
  requested_model   = $requested
  observed_provider = $observedProvider
  observed_model    = $observedModel
  observed_variant  = $observedVariant
  opencode_version  = $capture.opencode_version
  plugin_package    = "project-context-opencode"
  plugin_version    = $pluginVersion
  plugin_commit     = $pluginCommit
  completed_at      = (Get-Date).ToUniversalTime().ToString("o")
}
$canary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $workRoot "canary.json") -Encoding utf8NoBOM

Write-Host ""
Write-Host "SMOKE PASS" -ForegroundColor Green
Write-Host "  marker reconciled exactly once, post-mutation, same session."
Write-Host "  workRoot: $workRoot"
Write-Host "  canary  : $(Join-Path $workRoot 'canary.json')"
Write-Host "  Harness use: pass this canary to the Project Context preflight"
Write-Host "  transport gate. Copy it to <project-context>/.local/transport-canary.json"
Write-Host "  (local-only, never committed) before any behavioural wave."
exit 0
