#!/usr/bin/env bash
# smoke.sh — first-class liveness check for project-context-opencode.
# Bash twin of scripts/smoke.ps1; see that file for the contract.
#
# Usage:
#   ./scripts/smoke.sh "opencode/muse-spark-1.3-contributor-free"
#
# Exit codes: 0 PASS, 1 FAIL (fail closed), 2 UNSUPPORTED environment.
set -euo pipefail

MODEL="${1:?Usage: smoke.sh <provider/model[#variant]>}"
PLUGIN_ID="${PLUGIN_ID:-project-context}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

fail() { echo ""; echo "SMOKE FAIL: $1" >&2; exit 1; }
unsupported() { echo ""; echo "SMOKE UNSUPPORTED: $1" >&2; exit 2; }

command -v opencode >/dev/null 2>&1 || fail "opencode is not on PATH."
opencode plugin list | grep -qF "$PLUGIN_ID" \
  || fail "plugin '$PLUGIN_ID' not in opencode plugin list. Install first: opencode plugin add github:ernanhughes/project-context-opencode"
echo "plugin '$PLUGIN_ID' is installed."

STAMP="$(date +%Y%m%d-%H%M%S)"
RAND="$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
MARKER="SMOKE-PROBE-$STAMP-$RAND"
WORK_ROOT="${TMPDIR:-/tmp}/pc-smoke-$STAMP-$RAND"
SPOOL_DIR="$WORK_ROOT/spool"
TRACE_DIR="$WORK_ROOT/trace"
RUN_DIR="$WORK_ROOT/repo"
BLOCK_PATH="$WORK_ROOT/runtime-block.txt"
STDOUT_PATH="$WORK_ROOT/model-stdout.txt"
STDERR_PATH="$WORK_ROOT/model-stderr.txt"
mkdir -p "$SPOOL_DIR" "$TRACE_DIR" "$RUN_DIR"
printf '# smoke throwaway\n' > "$RUN_DIR/README.md"
printf '[CONTEXT RUNTIME]\n[SMOKE CONSTRAINT]\nFor this synthetic liveness probe only,\nthe marker value is %s.\n[/CONTEXT RUNTIME]' "$MARKER" > "$BLOCK_PATH"

echo "marker   : $MARKER"
echo "spool    : $SPOOL_DIR"
echo "trace    : $TRACE_DIR"
echo "model    : $MODEL"

export PROJECT_CONTEXT_CAPTURE=1
export PROJECT_CONTEXT_SPOOL_DIR="$SPOOL_DIR"
export PROJECT_CONTEXT_RUNTIME=inject
export PROJECT_CONTEXT_RUNTIME_BLOCK="$BLOCK_PATH"
export PROJECT_CONTEXT_RUNTIME_TRACE_DIR="$TRACE_DIR"

EXIT_CODE=0
(
  cd "$RUN_DIR"
  # --standalone: a private server inherits this child-only probe
  # environment. The shared background service would NOT see
  # process-scoped variables, so hooks would silently stay disabled.
  opencode run --standalone --model "$MODEL" --title "pc-smoke-$RAND" \
    "Reply with exactly the word READY and nothing else." \
    >"$STDOUT_PATH" 2>"$STDERR_PATH"
) || EXIT_CODE=$?

unset PROJECT_CONTEXT_CAPTURE PROJECT_CONTEXT_SPOOL_DIR
unset PROJECT_CONTEXT_RUNTIME PROJECT_CONTEXT_RUNTIME_BLOCK PROJECT_CONTEXT_RUNTIME_TRACE_DIR

if [ "$EXIT_CODE" -ne 0 ]; then
  if grep -qiE 'model.*not found|unknown model|provider.*not|unauthori|authenticat|no auth|api key|invalid.*model|could not resolve' "$STDERR_PATH"; then
    unsupported "model '$MODEL' is not usable here (exit $EXIT_CODE). No inference was attempted. Details in $STDERR_PATH"
  fi
  fail "model request exited $EXIT_CODE. See $STDERR_PATH"
fi
echo "model request exited 0."

TRACE_FILE="$TRACE_DIR/runtime-trace.jsonl"
[ -f "$TRACE_FILE" ] || fail "no runtime trace at $TRACE_FILE. The runtime hook never executed."
python3 - "$TRACE_FILE" "$MARKER" <<'EOF'
import json, sys
trace_file = sys.argv[1]
hooks = [json.loads(l) for l in open(trace_file, encoding="utf-8") if l.strip()]
hooks = [h for h in hooks if h.get("kind") == "hook"]
good = [h for h in hooks if h.get("outcome") == "injected"
        and h.get("postBlocks", -99) - h.get("preBlocks", -100) == 1]
if not good:
    print(f"SMOKE FAIL: no successful injection in trace (outcomes: {[h.get('outcome') for h in hooks]})")
    sys.exit(1)
t = good[-1]
print(f"runtime    : outcome=injected preBlocks={t['preBlocks']} postBlocks={t['postBlocks']} session={t['sessionID']}")
print(f"TRACE_SESSION={t['sessionID']}")
EOF
[ $? -eq 0 ] || exit 1
TRACE_SESSION="$(python3 -c "import json; hs=[json.loads(l) for l in open('$TRACE_FILE',encoding='utf-8') if l.strip()]; hs=[h for h in hs if h.get('kind')=='hook' and h.get('outcome')=='injected']; print(hs[-1]['sessionID'])")"

DAY="$(date +%F)"
CAPTURE_FILE="$SPOOL_DIR/$DAY/captures.jsonl"
[ -f "$CAPTURE_FILE" ] || fail "no observer spool at $CAPTURE_FILE. Capture was not live for this request. An empty spool proves nothing about model activity."

SMOKE_RESULT="$(python3 - "$CAPTURE_FILE" "$TRACE_SESSION" "$MARKER" "$(cat "$BLOCK_PATH")" <<'EOF'
import json, sys
cap_file, trace_session, marker, block = sys.argv[1:5]
recs = [json.loads(l) for l in open(cap_file, encoding="utf-8") if l.strip()]
ctx = [r for r in recs if r.get("request_kind") == "context"]
matched = []
for r in ctx:
    texts = [b.get("text", "") for b in (r.get("system") or []) if isinstance(b, dict)]
    if sum(1 for t in texts if t == block) == 1 and sum(1 for t in texts if marker in t) == 1:
        matched.append(r)
if len(matched) != 1:
    print(f"SMOKE FAIL: expected exactly one context record with the marker once byte-identical; found {len(matched)} of {len(ctx)}.")
    sys.exit(1)
c = matched[0]
texts = [b.get("text", "") for b in (c.get("system") or []) if isinstance(b, dict)]
if not texts or texts[-1] != block:
    print("SMOKE FAIL: injected block is not last in the captured system array.")
    sys.exit(1)
if c.get("session_id") != trace_session:
    print(f"SMOKE FAIL: session mismatch: trace={trace_session} capture={c.get('session_id')}.")
    sys.exit(1)
m = c.get("model") or {}
print(f"observer   : session={c.get('session_id')} seq={c.get('invocation_sequence')} systemBlocks={len(texts)}")
print(f"OBSERVED={m.get('provider_id')}/{m.get('id')}#{m.get('variant') or ''}")
EOF
)"
STATUS=$?
echo "$SMOKE_RESULT"
[ $STATUS -eq 0 ] || exit 1

REQUESTED="${MODEL%%#*}"
OBSERVED="$(echo "$SMOKE_RESULT" | sed -n 's/^OBSERVED=//p' | sed 's/#.*$//')"
[ "$OBSERVED" = "$REQUESTED" ] || fail "requested model '$REQUESTED' != observed '$OBSERVED'. Failing closed."
echo "attribution: requested model = observed model."
PLUGIN_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
CAPTURE_OPENCODE_VERSION="$(python3 - "$CAPTURE_FILE" <<'EOF'
import json, sys
recs = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
ctx = [r for r in recs if r.get("request_kind") == "context"]
print(ctx[-1].get("opencode_version", "unknown"))
EOF
)"
CAPTURE_SEQ="$(python3 - "$CAPTURE_FILE" <<'EOF'
import json, sys
recs = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
ctx = [r for r in recs if r.get("request_kind") == "context"]
print(ctx[-1].get("invocation_sequence", 0))
EOF
)"
python3 - "$WORK_ROOT/canary.json" <<EOF
import json
canary = {
    "canary": "project-context transport liveness",
    "result": "PASS",
    "marker": "$MARKER",
    "session_id": "$TRACE_SESSION",
    "invocation_sequence": $CAPTURE_SEQ,
    "requested_model": "$REQUESTED",
    "observed": "$OBSERVED",
    "opencode_version": "$CAPTURE_OPENCODE_VERSION",
    "plugin_package": "project-context-opencode",
    "plugin_version": "0.1.0",
    "plugin_commit": "$PLUGIN_COMMIT",
}
open("$WORK_ROOT/canary.json", "w", encoding="utf-8").write(json.dumps(canary, indent=2))
EOF
echo ""
echo "SMOKE PASS"
echo "  marker reconciled exactly once, post-mutation, same session."
echo "  workRoot: $WORK_ROOT"
echo "  canary  : $WORK_ROOT/canary.json"
