#!/usr/bin/env bash
# compiler-smoke.sh — live compile -> inject -> observe proof.
# Bash twin of scripts/compiler-smoke.ps1; see that file for the contract.
#
# Usage:
#   ./scripts/compiler-smoke.sh "opencode-go/muse-spark-1.3-contributor"
#
# Exit codes: 0 PASS, 1 FAIL (fail closed), 2 UNSUPPORTED environment.
# NOTE: this twin is syntax-reviewed but its live run is exercised
# via the PowerShell script; report discrepancies if you run it.
set -euo pipefail

MODEL="${1:?Usage: compiler-smoke.sh <provider/model[#variant]>}"
PLUGIN_ID="${PLUGIN_ID:-project-context}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

fail() { echo ""; echo "COMPILER-SMOKE FAIL: $1" >&2; exit 1; }
unsupported() { echo ""; echo "COMPILER-SMOKE UNSUPPORTED: $1" >&2; exit 2; }

command -v opencode >/dev/null 2>&1 || fail "opencode is not on PATH."
command -v node >/dev/null 2>&1 || fail "node is not on PATH."
opencode plugin list | grep -qF "$PLUGIN_ID" \
  || fail "plugin '$PLUGIN_ID' not in opencode plugin list."
echo "plugin '$PLUGIN_ID' is installed."

COMPILER_VERSION="$(node -p "require('$REPO_ROOT/node_modules/project-context-compiler/package.json').version" 2>/dev/null || echo unknown)"
COMPILER_REVISION="$(grep -oE '[0-9a-f]{40}' "$REPO_ROOT/package-lock.json" | head -n 1)"
[ -n "$COMPILER_VERSION" ] && [ -n "$COMPILER_REVISION" ] \
  || fail "cannot determine pinned compiler identity from package-lock.json."
echo "compiler: project-context-compiler version=$COMPILER_VERSION revision=$COMPILER_REVISION"

STAMP="$(date +%Y%m%d-%H%M%S)"
RAND="$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
UID_="${STAMP}-${RAND}"
WORK_ROOT="${TMPDIR:-/tmp}/pc-csmoke-$STAMP-$RAND"
SPOOL_DIR="$WORK_ROOT/spool"
TRACE_DIR="$WORK_ROOT/trace"
RUN_DIR="$WORK_ROOT/repo"
BLOCK_DIR="$WORK_ROOT/blockdir"
STDOUT_PATH="$WORK_ROOT/model-stdout.txt"
STDERR_PATH="$WORK_ROOT/model-stderr.txt"
EVIDENCE_PATH="$WORK_ROOT/evidence.json"
RECEIPT_PATH="$WORK_ROOT/receipt.json"
CANARY_PATH="$WORK_ROOT/compiler-canary.json"
REQUEST_PATH="$WORK_ROOT/request.json"
CANDIDATES_PATH="$WORK_ROOT/candidates.json"
POLICY_PATH="$WORK_ROOT/policy.json"
mkdir -p "$SPOOL_DIR" "$TRACE_DIR" "$RUN_DIR" "$BLOCK_DIR"
printf '# compiler smoke throwaway\n' > "$RUN_DIR/README.md"

node -e "
const fs = require('fs');
fs.writeFileSync(process.argv[1], JSON.stringify({
    request_id: 'compiler-smoke-req',
    task_id: 'compiler transport smoke',
    usable_token_budget: 500,
    created_at: '2026-09-25T00:00:00.000Z',
    active_scope: 'smoke',
    policy_version: 'compiler-policy-v1',
}));
fs.writeFileSync(process.argv[2], JSON.stringify({ candidates: [{
    candidate_id: 'smoke-context',
    content_identity: 'smoke-context',
    representation_id: 'full',
    form_rank: 3, min_rank: 0,
    source_kind: 'synthetic', source_ref: 'smoke',
    kind: 'evidence', content: 'smoke compiled content',
    token_count: 20, token_source: 'fixture-declared-counts',
    requirement: 'MANDATORY', order_role: 'evidence',
    scope_eligible: true, freshness_eligible: true,
    authority_eligible: true,
}]}));
" "$REQUEST_PATH" "$CANDIDATES_PATH"
if [ -f "$REPO_ROOT/../project-context-compiler/conformance/compiler-v1/compiler-policy-v1.json" ]; then
  cp "$REPO_ROOT/../project-context-compiler/conformance/compiler-v1/compiler-policy-v1.json" "$POLICY_PATH"
else
  node -e "
const fs = require('fs');
fs.writeFileSync(process.argv[1], JSON.stringify({
    schema_version: 'project_context.compiler_policy.v1',
    policy_version: 'compiler-policy-v1',
    min_discretionary_relevance: 0.3,
    mandatory_form: 'cheapest',
    order_roles: ['instruction', 'task', 'state', 'evidence', 'support', 'tool'],
    repair: 'drop-last-discretionary',
}));
" "$POLICY_PATH"
fi

HARNESS="$REPO_ROOT/scripts/compiler-harness.ts"
node "$HARNESS" compose \
  --request "$REQUEST_PATH" \
  --candidates "$CANDIDATES_PATH" \
  --policy "$POLICY_PATH" \
  --uid "$UID_" \
  --compiler-version "$COMPILER_VERSION" \
  --compiler-revision "$COMPILER_REVISION" \
  --block-out "$BLOCK_DIR" \
  --evidence-out "$EVIDENCE_PATH" \
  || fail "offline composition failed (compile or validation)."

BLOCK_PATH="$(node -p "JSON.parse(require('fs').readFileSync('$EVIDENCE_PATH','utf8')).blockPath")"
MARKER="PROJECT_CONTEXT_COMPILE_CANARY_$UID_"
echo "model    : $MODEL"

export PROJECT_CONTEXT_CAPTURE=1
export PROJECT_CONTEXT_SPOOL_DIR="$SPOOL_DIR"
export PROJECT_CONTEXT_RUNTIME=inject
export PROJECT_CONTEXT_RUNTIME_BLOCK="$BLOCK_PATH"
export PROJECT_CONTEXT_RUNTIME_TRACE_DIR="$TRACE_DIR"

EXIT_CODE=0
(
  cd "$RUN_DIR"
  opencode run --standalone --model "$MODEL" --title "pc-csmoke-$RAND" \
    "Reply with exactly the word READY and nothing else." \
    >"$STDOUT_PATH" 2>"$STDERR_PATH"
) || EXIT_CODE=$?

unset PROJECT_CONTEXT_CAPTURE PROJECT_CONTEXT_SPOOL_DIR
unset PROJECT_CONTEXT_RUNTIME PROJECT_CONTEXT_RUNTIME_BLOCK PROJECT_CONTEXT_RUNTIME_TRACE_DIR

if [ "$EXIT_CODE" -ne 0 ]; then
  if grep -qiE 'model.*not found|unknown model|provider.*not|unauthori|authenticat|no auth|api key|invalid.*model|could not resolve' "$STDERR_PATH"; then
    unsupported "model '$MODEL' is not usable here (exit $EXIT_CODE). No inference was attempted."
  fi
  fail "model request exited $EXIT_CODE. See $STDERR_PATH"
fi
echo "model request exited 0."

TRACE_FILE="$TRACE_DIR/runtime-trace.jsonl"
node "$HARNESS" reconcile \
  --evidence "$EVIDENCE_PATH" \
  --trace "$TRACE_FILE" \
  --spool "$SPOOL_DIR" \
  --requested-model "$MODEL" \
  --receipt-out "$RECEIPT_PATH" \
  --canary-out "$CANARY_PATH" \
  || fail "reconciliation FAIL (see $RECEIPT_PATH)."

echo ""
echo "COMPILER-SMOKE PASS"
echo "  compiled bytes == injected bytes == observed bytes."
echo "  workRoot: $WORK_ROOT"
echo "  canary  : $CANARY_PATH"
