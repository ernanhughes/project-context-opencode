#!/usr/bin/env pwsh
# load-check.ps1 — zero-inference installation/load qualification.
#
# Establishes without executing any model request:
#   1. the package is installed and visible to OpenCode plugin management
#   2. the plugin entrypoint resolves to a file on disk
#   3. setup executes against a fake host and registers the expected hooks
#      for each configuration (ordering included)
#   4. an intentionally invalid model is rejected before inference and
#      leaves no captures behind
#
# What this does NOT prove: live hook execution, mutation, or capture.
# Those require scripts/smoke.ps1 with a real model. A PASS here is not
# a PASS there; see README "Semantic boundaries".
#
# Usage: .\scripts\load-check.ps1

[CmdletBinding()]
param(
  [string]$PluginId = "project-context"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)

function Fail([string]$message) {
  Write-Host ""
  Write-Host "LOAD-CHECK FAIL: $message" -ForegroundColor Red
  exit 1
}

$opencode = Get-Command "opencode" -ErrorAction SilentlyContinue
if (-not $opencode) { Fail "opencode is not on PATH." }

# 1. installed and visible ------------------------------------------------
$pluginList = (& opencode plugin list 2>&1 | Out-String)
if ($pluginList -notmatch [regex]::Escape($PluginId)) {
  Fail ("plugin '$PluginId' not in `opencode plugin list`. Install first:`n" +
    "  opencode plugin add github:ernanhughes/project-context-opencode")
}
Write-Host "1. plugin '$PluginId' visible via plugin management." -ForegroundColor Green

# 2. entrypoint resolves ---------------------------------------------------
$entry = Join-Path $RepoRoot "src/index.ts"
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
  Fail "package entrypoint missing: $entry"
}
$rootEntry = Join-Path $RepoRoot "index.ts"
if (-not (Test-Path -LiteralPath $rootEntry -PathType Leaf)) {
  Fail "root discovery entrypoint missing: $rootEntry"
}
Write-Host "2. package entrypoints resolve." -ForegroundColor Green

# 3. setup executes; hooks register per configuration ----------------------
$harness = & node $checkScript 2>&1
$harnessExit = $LASTEXITCODE
Write-Host $harness
if ($harnessExit -ne 0) { Fail "registration harness failed (exit $harnessExit)." }
Write-Host "3. setup executes; hook registration matrix holds." -ForegroundColor Green

# 4. invalid model rejected before inference, spool untouched ---------------
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$rand = -join ((48..57) + (65..90) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$workRoot = Join-Path ([System.IO.Path]::GetTempPath()) "pc-load-$stamp-$rand"
$spoolDir = Join-Path $workRoot "spool"
$runDir = Join-Path $workRoot "repo"
New-Item -ItemType Directory -Force -Path $spoolDir, $runDir | Out-Null
Set-Content -LiteralPath (Join-Path $runDir "README.md") -Value "# load throwaway`n" -Encoding utf8

$prevCapture = $env:PROJECT_CONTEXT_CAPTURE
$prevSpool = $env:PROJECT_CONTEXT_SPOOL_DIR
$env:PROJECT_CONTEXT_CAPTURE = "1"
$env:PROJECT_CONTEXT_SPOOL_DIR = $spoolDir
try {
  $out = & $opencode.Source run --model "invalid-provider-xyz/invalid-model-xyz" "hi" 2>&1
  $code = $LASTEXITCODE
}
finally {
  if ($null -eq $prevCapture) { Remove-Item "env:PROJECT_CONTEXT_CAPTURE" -ErrorAction SilentlyContinue } else { $env:PROJECT_CONTEXT_CAPTURE = $prevCapture }
  if ($null -eq $prevSpool) { Remove-Item "env:PROJECT_CONTEXT_SPOOL_DIR" -ErrorAction SilentlyContinue } else { $env:PROJECT_CONTEXT_SPOOL_DIR = $prevSpool }
}
if ($code -eq 0) { Fail "invalid model unexpectedly succeeded (exit 0)." }
$spoolFiles = Get-ChildItem -LiteralPath $spoolDir -Recurse -File -ErrorAction SilentlyContinue
if ($spoolFiles -and $spoolFiles.Count -gt 0) {
  Fail "spool written without a model request; capture boundary unclear."
}
Write-Host "4. invalid model rejected (exit $code); no captures, no inference." -ForegroundColor Green

Write-Host ""
Write-Host "LOAD-CHECK PASS (zero inference; live behaviour still needs smoke)." -ForegroundColor Green
exit 0
