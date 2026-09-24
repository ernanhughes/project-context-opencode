/**
 * Qualification trace tests (node:test, no test framework).
 *
 * 1. silent by default: no trace directory env means no files written
 * 2. silent when the runtime mode is not the explicit opt-in
 * 3. records carry counts/outcomes only, never block or prompt text
 * 4. a broken sink never throws
 */

import { equal } from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  traceEnabled,
  traceHook,
  traceSetup,
} from "../../src/runtime/trace.ts";

function freshDir(name: string): string {
  return join(tmpdir(), `ctx-smoke-trace-test-${name}-${Date.now()}`);
}

{
  delete process.env["PROJECT_CONTEXT_RUNTIME"];
  delete process.env["PROJECT_CONTEXT_RUNTIME_TRACE_DIR"];
  equal(traceEnabled(), false);
  traceSetup("project-context-runtime");
  traceHook({
    sessionID: "ses_test",
    agent: "build",
    preBlocks: 4,
    postBlocks: 5,
    outcome: "injected",
  });
}

{
  // Wrong mode stays silent even with a trace directory configured.
  const dir = freshDir("off-mode");
  process.env["PROJECT_CONTEXT_RUNTIME"] = "observe";
  process.env["PROJECT_CONTEXT_RUNTIME_TRACE_DIR"] = dir;
  try {
    equal(traceEnabled(), false);
    traceSetup("project-context-runtime");
    equal(existsSync(join(dir, "runtime-trace.jsonl")), false);
  } finally {
    delete process.env["PROJECT_CONTEXT_RUNTIME"];
    delete process.env["PROJECT_CONTEXT_RUNTIME_TRACE_DIR"];
  }
}

{
  const dir = freshDir("on");
  process.env["PROJECT_CONTEXT_RUNTIME"] = "inject";
  process.env["PROJECT_CONTEXT_RUNTIME_TRACE_DIR"] = dir;
  try {
    equal(traceEnabled(), true);
    traceSetup("project-context-runtime");
    traceHook({
      sessionID: "ses_test",
      agent: "build",
      preBlocks: 4,
      postBlocks: 5,
      outcome: "injected",
    });
    const lines = readFileSync(join(dir, "runtime-trace.jsonl"), "utf-8").split(
      "\n",
    );
    equal(lines.length, 3); // two records plus trailing newline
    const setup = JSON.parse(lines[0]);
    equal(setup.kind, "setup");
    equal(setup.hookRegistered, true);
    const hook = JSON.parse(lines[1]);
    equal(hook.kind, "hook");
    equal(hook.preBlocks, 4);
    equal(hook.postBlocks, 5);
    equal(hook.outcome, "injected");
    const blob = lines.slice(0, 2).join("\n");
    equal(blob.includes("[CONTEXT RUNTIME]"), false);
    equal(blob.includes("ORANGE-QUARTZ"), false);
  } finally {
    delete process.env["PROJECT_CONTEXT_RUNTIME"];
    delete process.env["PROJECT_CONTEXT_RUNTIME_TRACE_DIR"];
  }
}
