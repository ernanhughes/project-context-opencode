#!/usr/bin/env bash
# load-check.sh — zero-inference installation/load qualification.
# Bash twin of scripts/load-check.ps1; see that file for the contract.
set -euo pipefail

PLUGIN_ID="${PLUGIN_ID:-project-context}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

fail() { echo ""; echo "LOAD-CHECK FAIL: $1" >&2; exit 1; }

command -v opencode >/dev/null 2>&1 || fail "opencode is not on PATH."

opencode plugin list | grep -qF "$PLUGIN_ID" \
  || fail "plugin '$PLUGIN_ID' not in opencode plugin list."
echo "1. plugin '$PLUGIN_ID' visible via plugin management."

[ -f "$REPO_ROOT/src/index.ts" ] || fail "package entrypoint missing."
[ -f "$REPO_ROOT/index.ts" ] || fail "root discovery entrypoint missing."
echo "2. package entrypoints resolve."

node "$REPO_ROOT/scripts/load-harness.ts" || fail "registration harness failed."
echo "3. setup executes; hook registration matrix holds."

STAMP="$(date +%Y%m%d-%H%M%S)"
RAND="$(head -c3 /dev/urandom | od -An -tx1 | tr -d ' \n')"
WORK_ROOT="${TMPDIR:-/tmp}/pc-load-$STAMP-$RAND"
SPOOL_DIR="$WORK_ROOT/spool"
RUN_DIR="$WORK_ROOT/repo"
mkdir -p "$SPOOL_DIR" "$RUN_DIR"
printf '# load throwaway\n' > "$RUN_DIR/README.md"

export PROJECT_CONTEXT_CAPTURE=1
export PROJECT_CONTEXT_SPOOL_DIR="$SPOOL_DIR"
CODE=0
(cd "$RUN_DIR" && opencode run --model "invalid-provider-xyz/invalid-model-xyz" "hi" >/dev/null 2>&1) || CODE=$?
unset PROJECT_CONTEXT_CAPTURE PROJECT_CONTEXT_SPOOL_DIR

[ "$CODE" -ne 0 ] || fail "invalid model unexpectedly succeeded (exit 0)."
[ -z "$(find "$SPOOL_DIR" -type f 2>/dev/null)" ] || fail "spool written without a model request."
echo "4. invalid model rejected (exit $CODE); no captures, no inference."
echo ""
echo "LOAD-CHECK PASS (zero inference; live behaviour still needs smoke)."
