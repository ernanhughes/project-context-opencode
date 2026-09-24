#!/usr/bin/env pwsh
# compiler-smoke.ps1 — live compile -> inject -> observe proof.
#
# Proves the complete chain with exactly one trivial model request:
#   explicit request/candidates/policy
#   -> compileContext() -> ContextBundle -> renderBundleText()
#   -> transport envelope -> existing runtime injection
#   -> independent observer capture -> pure reconciliation
#
# Usage:
#   .\scripts\compiler-smoke.ps1 -Model "opencode-go/muse-spark-1.3-contributor"
#
# Exit codes: 0 PASS, 1 FAIL (fail closed), 2 UNSUPPORTED environment.
# The model reply text is diagnostic only; proof is the reconciled
# receipt in compiler-canary.json. Restores all environment variables
# and leaves ordinary OpenCode configuration untouched.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Model,

  [string]$PluginId = "project-context"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)

$ManagedEnv = @(
  "PROJECT_CONTEXT_CAPTURE",
  "PROJECT_CONTEXT_SPOOL_DIR",
  "PROJECT_CONTEXT_RUNTIME",
  "PROJECT_CONTEXT_RUNTIME_BLOCK",
  "PROJECT_CONTEXT_RUNTIME_TRACE_DIR"
)

function Fail([string]$message) {
  Write-Host ""
  Write-Host "COMPILER-SMOKE FAIL: $message" -ForegroundColor Red
  exit 1
}

function Unsupported([string]$message) {
  Write-Host ""
  Write-Host "COMPILER-SMOKE UNSUPPORTED: $message" -ForegroundColor Yellow
  exit 2
}

# --- preconditions -------------------------------------------------

$opencodeCmd = (where.exe opencode.cmd 2>$null | Select-Object -First 1)
if (-not $opencodeCmd) {
  $opencodeCmd = (Get-Command "opencode.cmd" -ErrorAction SilentlyContinue).Source
}
if (-not $opencodeCmd) { Fail "opencode.cmd is not on PATH." }

$pluginList = (& $opencodeCmd plugin list 2>&1 | Out-String)
if ($pluginList -notmatch [regex]::Escape($PluginId)) {
  Fail ("plugin '$PluginId' not in `opencode plugin list`. Install first:`n" +
    "  opencode plugin add github:ernanhughes/project-context-opencode")
}
Write-Host "plugin '$PluginId' is installed." -ForegroundColor Green

$nodeCmd = (Get-Command "node" -ErrorAction SilentlyContinue).Source
if (-not $nodeCmd) { Fail "node is not on PATH." }

# Compiler identity from the installed dependency (no magic hashes).
$compilerVersion = "unknown"
$compilerRevision = "unknown"
$installedPkgPath = Join-Path $RepoRoot "node_modules/project-context-compiler/package.json"
if (Test-Path -LiteralPath $installedPkgPath) {
  $compilerVersion = (Get-Content -LiteralPath $installedPkgPath -Raw |
    ConvertFrom-Json).version
}
$lockRaw = Get-Content -LiteralPath (Join-Path $RepoRoot "package-lock.json") -Raw |
  ConvertFrom-Json
$lockSpec = $lockRaw.packages."node_modules/project-context-compiler".version
if ($lockSpec -match '#([0-9a-f]{40})') { $compilerRevision = $Matches[1] }
if ($compilerVersion -eq "unknown" -or $compilerRevision -eq "unknown") {
  Fail "cannot determine pinned compiler identity from package-lock.json."
}
Write-Host "compiler: project-context-compiler version=$compilerVersion revision=$compilerRevision"

# --- isolated workspace --------------------------------------------

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$rand = -join ((48..57) + (65..90) | Get-Random -Count 8 | ForEach-Object { [char]$_ })
$uid = "$stamp-$rand"
$workRoot = Join-Path ([System.IO.Path]::GetTempPath()) "pc-csmoke-$stamp-$rand"
$spoolDir = Join-Path $workRoot "spool"
$traceDir = Join-Path $workRoot "trace"
$runDir = Join-Path $workRoot "repo"
$blockDir = Join-Path $workRoot "blockdir"
$stdoutPath = Join-Path $workRoot "model-stdout.txt"
$stderrPath = Join-Path $workRoot "model-stderr.txt"
$evidencePath = Join-Path $workRoot "evidence.json"
$receiptPath = Join-Path $workRoot "receipt.json"
$canaryPath = Join-Path $workRoot "compiler-canary.json"

New-Item -ItemType Directory -Force -Path $spoolDir, $traceDir, $runDir, $blockDir | Out-Null
Set-Content -LiteralPath (Join-Path $runDir "README.md") -Value "# compiler smoke throwaway`n" -Encoding utf8

$requestPath = Join-Path $workRoot "request.json"
$candidatesPath = Join-Path $workRoot "candidates.json"
$policyPath = Join-Path $workRoot "policy.json"

Set-Content -LiteralPath $requestPath -Value (@{
    request_id          = "compiler-smoke-req"
    task_id             = "compiler transport smoke"
    usable_token_budget = 500
    created_at          = (Get-Date).ToUniversalTime().ToString("o")
    active_scope        = "smoke"
    policy_version      = "compiler-policy-v1"
  } | ConvertTo-Json -Depth 4) -Encoding utf8NoBOM

Set-Content -LiteralPath $candidatesPath -Value (@{
    candidates = @(
      @{
        candidate_id       = "smoke-context"
        content_identity   = "smoke-context"
        representation_id  = "full"
        form_rank          = 3
        min_rank           = 0
        source_kind        = "synthetic"
        source_ref         = "smoke"
        kind               = "evidence"
        content            = "smoke compiled content"
        token_count        = 20
        token_source       = "fixture-declared-counts"
        requirement        = "MANDATORY"
        order_role         = "evidence"
        scope_eligible     = $true
        scope_reason       = ""
        freshness_eligible = $true
        freshness_reason   = ""
        authority_eligible = $true
        authority_reason   = ""
        depends_on         = @()
        group_id           = $null
        group_required     = $false
        coverage_keys      = @()
        relevance          = 0.5
        is_default_form    = $true
      }
    )
  } | ConvertTo-Json -Depth 6) -Encoding utf8NoBOM

Copy-Item -LiteralPath (Join-Path $RepoRoot "..\project-context-compiler\conformance\compiler-v1\compiler-policy-v1.json") `
  -Destination $policyPath -ErrorAction SilentlyContinue
if (-not (Test-Path -LiteralPath $policyPath)) {
  # Fallback: canonical v1 policy bytes (no network).
  Set-Content -LiteralPath $policyPath -Value (@{
      schema_version             = "project_context.compiler_policy.v1"
      policy_version             = "compiler-policy-v1"
      min_discretionary_relevance = 0.3
      mandatory_form             = "cheapest"
      order_roles                = @("instruction", "task", "state", "evidence", "support", "tool")
      repair                     = "drop-last-discretionary"
    } | ConvertTo-Json -Depth 4) -Encoding utf8NoBOM
}

# --- offline composition (no inference) ------------------------------

$harness = Join-Path $RepoRoot "scripts/compiler-harness.ts"
& $nodeCmd $harness compose `
  --request $requestPath `
  --candidates $candidatesPath `
  --policy $policyPath `
  --uid $uid `
  --compiler-version $compilerVersion `
  --compiler-revision $compilerRevision `
  --block-out $blockDir `
  --evidence-out $evidencePath
if ($LASTEXITCODE -ne 0) { Fail "offline composition failed (compile or validation)." }

$evidence = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json
$blockPath = $evidence.blockPath
Write-Host ("compiled : bundle={0} hash={1} tokens={2}" -f `
    $evidence.compilation.bundleId, $evidence.compilation.bundleHash, $evidence.compilation.bundleTokens)
Write-Host "marker   : $($evidence.expectedMarker)"
Write-Host "model    : $Model"

# --- child-only environment ------------------------------------------

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
    -ArgumentList @("run", "--standalone", "--model", $Model, "--title", "pc-csmoke-$rand",
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

# --- pure reconciliation -----------------------------------------------

$traceFile = Join-Path $traceDir "runtime-trace.jsonl"
& $nodeCmd $harness reconcile `
  --evidence $evidencePath `
  --trace $traceFile `
  --spool $spoolDir `
  --requested-model $Model `
  --receipt-out $receiptPath `
  --canary-out $canaryPath
$reconcileCode = $LASTEXITCODE

$receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
Write-Host ("runtime    : outcome={0} session={1}" -f $receipt.runtime_outcome, $receipt.observer_session_id)
Write-Host ("observer   : session={0} seq={1} systemBlocks=?" -f $receipt.observer_session_id, $receipt.observer_sequence)
Write-Host ("observed   : {0} (match={1})" -f $receipt.observed_model, $receipt.model_match)
Write-Host ("render hash: {0}" -f $receipt.compiler_render_hash)
Write-Host ("block hash : {0}" -f $receipt.runtime_block_hash)

if ($reconcileCode -ne 0 -or $receipt.status -ne "PASS") {
  Fail ("reconciliation $($receipt.status): $($receipt.failures -join '; ')")
}

Write-Host ""
Write-Host "COMPILER-SMOKE PASS" -ForegroundColor Green
Write-Host "  compiled bytes == injected bytes == observed bytes."
Write-Host "  workRoot: $workRoot"
Write-Host "  canary  : $canaryPath"
exit 0
