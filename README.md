# project-context-opencode

The canonical OpenCode integration for
[Project Context](https://github.com/ernanhughes/project-context):
a small empirical instrument for context engineering.

```text
observe model context
+ optionally inject controlled context
+ verify what reached the OpenCode model-context boundary
```

One installable package, two separately-testable mechanisms with
explicit opt-ins and safe defaults:

| Mechanism    | Effect                                           | Enable                                        |
| ------------ | ------------------------------------------------ | --------------------------------------------- |
| OBSERVER     | copies model context read-only to a local spool  | `PROJECT_CONTEXT_CAPTURE=1`                   |
| INTERVENTION | appends one controlled block to the system array | `PROJECT_CONTEXT_RUNTIME=inject` + block file |

Both are **off** unless explicitly enabled. Installing this package
changes nothing about ordinary OpenCode behaviour.

## Installation

Requires OpenCode 2.x (V2 plugin API; live-tested against 2.0.16 —
see "Compatibility").

```powershell
opencode plugin add github:ernanhughes/project-context-opencode
opencode plugin list
opencode plugin check
opencode plugin update
```

No manual copying of `.ts` files into `~/.config/opencode/plugins/`
is needed. (A root `index.ts` re-export exists so a local clone also
loads as a plain plugin directory during development.)

Verify installation without spending any inference:

```powershell
.\scripts\load-check.ps1
```

This proves the package resolves, the plugin loads, setup executes,
and hooks register per configuration — without a model call. It does
not prove live execution; that is the smoke test below.

## Capture (observer)

PowerShell:

```powershell
$env:PROJECT_CONTEXT_CAPTURE = "1"
$env:PROJECT_CONTEXT_SPOOL_DIR = "$env:TEMP\pc-captures"  # optional; see default below
```

Bash:

```bash
export PROJECT_CONTEXT_CAPTURE=1
export PROJECT_CONTEXT_SPOOL_DIR=/tmp/pc-captures  # optional
```

Default spool: `~/.local/share/project-context/captures` (never inside
a repository). Each observed model request appends one JSONL record
(`project_context.opencode_capture.v2`) carrying session identity,
agent, provider/model identity, request kind, system, messages, tools,
options, model limits where the API yields them, capture timestamp,
capture ID, persistent invocation sequence, and timings.

Activation is easy to miss and the failure is silent: **an empty
spool proves nothing about model activity** — it most likely means
`PROJECT_CONTEXT_CAPTURE=1` was absent from the OpenCode server
process environment. If captures are missing, check the flag first.
The smoke test makes this prerequisite explicit.

## Intervention (runtime)

PowerShell:

```powershell
$env:PROJECT_CONTEXT_RUNTIME = "inject"
$env:PROJECT_CONTEXT_RUNTIME_BLOCK = "C:\path\to\rendered-block.txt"
$env:PROJECT_CONTEXT_RUNTIME_TRACE_DIR = "C:\path\to\trace-dir"  # optional but recommended
```

Bash:

```bash
export PROJECT_CONTEXT_RUNTIME=inject
export PROJECT_CONTEXT_RUNTIME_BLOCK=/path/to/rendered-block.txt
export PROJECT_CONTEXT_RUNTIME_TRACE_DIR=/path/to/trace-dir
```

`PROJECT_CONTEXT_RUNTIME_BLOCK` is a **path to a UTF-8 file** holding
the rendered block — never the block text itself. The file must
contain the runtime markers (`[CONTEXT RUNTIME]` …
`[/CONTEXT RUNTIME]`); anything else is refused without mutation.

Safety behaviour: intervention disabled by default; the system array
is assembled first and assigned once (errors never partially write);
an identical pre-existing block is an idempotent no-op; a differing
pre-existing block fails loudly instead of stacking. Trace outcomes:

```text
injected | noop_idempotent | failed_conflict
| error_load_block | error_unsupported_shape
```

The trace records counts, outcomes, and session identity only — never
block or prompt text.

## Smoke test (liveness)

Correct files and successful plugin loading do **not** prove the
instrumentation is live. Run one trivial request with a
caller-specified model:

```powershell
.\scripts\smoke.ps1 -Model "opencode/muse-spark-1.3-contributor-free"
```

```bash
./scripts/smoke.sh "opencode/muse-spark-1.3-contributor-free"
```

The script creates an isolated spool, trace dir, and block file with
a unique marker; enables both mechanisms for the child process only;
makes exactly one request; then requires:

- trace shows `injected` with `postBlocks = preBlocks + 1`;
- the observer captured a record for the same session with the marker
  exactly once, last in the system array, byte-identical;
- requested provider/model equals the observed provider/model.

Exit codes: `0` PASS, `1` FAIL (fail closed), `2` UNSUPPORTED (e.g.
the model is unresolvable here — no inference attempted). The model
reply text is diagnostic only; proof is trace + capture +
reconciliation, never what the model said.

## Safety

- Captured model context can contain sensitive project/session
  material. It stays local unless you move it. Never commit a spool.
- The observer never mutates the context event (pinned by tests).
- The runtime injects nothing unless explicitly enabled, and only
  from the named block file.

## Observation boundary

```text
OpenCode model-context observation != provider-wire capture
```

This package sees the assembled context at OpenCode's
`session.hook("context")` boundary. Protocol/provider lowering
happens afterwards; provider-added material, the wire
representation, and cache decisions remain unobserved. The runtime
proof is likewise at the hook boundary, not byte-for-byte provider
payload identity. Keep provider-wire claims out of downstream
reports.

## Ordering

The research use case needs runtime mutation _before_ observer
capture so the observer independently sees the post-intervention
context. Both mechanisms live in one `setup`, which registers the
runtime hook first and the observer hooks second — in code, not via
directory names. Combined tests pin the order and the consequence:
with runtime enabled the capture must contain the marker exactly
once; with runtime disabled the capture must equal the untouched
context.

## Compatibility

- Host: OpenCode major version 2 (V2 plugin API). Setup fails
  clearly on anything else; there is no compatibility layer and no
  exact-version pin.
- Live-tested against: OpenCode **2.0.16** (see evidence notes in
  the Project Context repository).
- Each capture records the actual host version in
  `opencode_version`; the smoke test reports the observed
  provider/model identity.

## Semantic boundaries

A PASS at one layer is not a PASS at another:

```text
installation → plugin load → hook registration
→ runtime injection → observer capture
→ provider/model attribution → behavioural experiment
```

`load-check` covers the first three without inference. `smoke`
covers injection, capture, and attribution with one live request.
Behavioural claims belong to Project Context experiments, never to
this package.

## Relationship to Project Context

This repository is the OpenCode adapter/integration. Experiments,
research harness, data model, and book evidence live in
[ernanhughes/project-context](https://github.com/ernanhughes/project-context),
which consumes this package as its OpenCode transport dependency.
For experiments it is enough to record the package version, the Git
commit, the OpenCode version, the requested and observed
provider/model, and the liveness result — no hand-maintained
file-hash tables.

## Develop

```bash
npm install
npm run typecheck
npm test
npm run lint
```

Runtime code (`src/`) stays dependency-free (node builtins only) and
uses erasable TypeScript so it runs identically under OpenCode and
plain node. Tests use the built-in runner, no framework; live-model
tests are never part of CI.

## Licence

Apache-2.0. See `LICENSE`.
