/**
 * Runtime hook behaviour tests (node:test, no test framework).
 * Run: npm test
 *
 * 1. disabled by default: zero hooks, zero trace output
 * 2. enabled injection appends exactly one block and traces injected
 * 3. missing block variable / missing file: error_load_block, untouched
 * 4. malformed block (markers absent): refused, untouched
 * 5. unsupported event shape: error_unsupported_shape, untouched
 * 6. identical block is idempotent (noop_idempotent, length unchanged)
 * 7. conflicting block fails loudly (failed_conflict, no stacking)
 * 8. trace records counts/outcomes only, never block text
 * 9. no partial mutation on any error path
 */

import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  loadBlock,
  registerRuntimeHook,
  runtimeEnabled,
} from "../../src/runtime/hook.ts";

type HookFn = (event: Record<string, unknown>) => Promise<void> | void;

const ENVS = [
  "PROJECT_CONTEXT_RUNTIME",
  "PROJECT_CONTEXT_RUNTIME_BLOCK",
  "PROJECT_CONTEXT_RUNTIME_TRACE_DIR",
];

function savedEnv(): Record<string, string | undefined> {
  const prev: Record<string, string | undefined> = {};
  for (const key of ENVS) {
    prev[key] = process.env[key];
    delete process.env[key];
  }
  return prev;
}

function restoreEnv(prev: Record<string, string | undefined>): void {
  for (const key of ENVS) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
}

function fakeSession() {
  const handlers: HookFn[] = [];
  return {
    handlers,
    ctx: {
      session: {
        hook: async (_name: string, callback: HookFn) => {
          handlers.push(callback);
          return { dispose: async () => {} };
        },
      },
    },
  };
}

function goodBlock(marker = "MARKER-1"): string {
  return `[CONTEXT RUNTIME]\n[TEST]\n${marker}\n[/CONTEXT RUNTIME]`;
}

function sampleEvent() {
  return {
    sessionID: "ses-rt-1",
    agent: "build",
    model: { providerID: "p", id: "m" },
    system: [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ],
    messages: [],
    tools: {},
    options: {},
  };
}

function enableRuntime(blockPath: string, traceDir?: string): void {
  process.env["PROJECT_CONTEXT_RUNTIME"] = "inject";
  process.env["PROJECT_CONTEXT_RUNTIME_BLOCK"] = blockPath;
  if (traceDir !== undefined)
    process.env["PROJECT_CONTEXT_RUNTIME_TRACE_DIR"] = traceDir;
  else delete process.env["PROJECT_CONTEXT_RUNTIME_TRACE_DIR"];
}

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function traceLines(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, "runtime-trace.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

test("runtime is disabled by default", async () => {
  const prev = savedEnv();
  try {
    equal(runtimeEnabled(), false);
    equal(runtimeEnabled({}), false);
    equal(runtimeEnabled({ PROJECT_CONTEXT_RUNTIME: "observe" }), false);
    equal(runtimeEnabled({ PROJECT_CONTEXT_RUNTIME: "inject" }), true);
    const { handlers, ctx } = fakeSession();
    await registerRuntimeHook(ctx as never);
    equal(handlers.length, 0);
  } finally {
    restoreEnv(prev);
  }
});

test("enabled injection appends exactly one block", async () => {
  const prev = savedEnv();
  const dir = tmpDir("rt-hook-");
  try {
    const blockPath = join(dir, "block.txt");
    const traceDir = join(dir, "trace");
    writeFileSync(blockPath, goodBlock("ALPHA"), "utf-8");
    enableRuntime(blockPath, traceDir);
    const { handlers, ctx } = fakeSession();
    await registerRuntimeHook(ctx as never);
    equal(handlers.length, 1);
    const event = sampleEvent();
    await handlers[0]!(event);
    const system = event.system as Array<{ text: string }>;
    equal(system.length, 3);
    equal(system[2]!.text, goodBlock("ALPHA"));
    const hooks = traceLines(traceDir).filter((r) => r["kind"] === "hook");
    equal(hooks.length, 1);
    deepEqual(
      [hooks[0]!["preBlocks"], hooks[0]!["postBlocks"], hooks[0]!["outcome"]],
      [2, 3, "injected"],
    );
  } finally {
    restoreEnv(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing block variable fails closed without mutation", async () => {
  const prev = savedEnv();
  const dir = tmpDir("rt-hook-");
  try {
    const traceDir = join(dir, "trace");
    process.env["PROJECT_CONTEXT_RUNTIME"] = "inject";
    delete process.env["PROJECT_CONTEXT_RUNTIME_BLOCK"];
    process.env["PROJECT_CONTEXT_RUNTIME_TRACE_DIR"] = traceDir;
    const { handlers, ctx } = fakeSession();
    await registerRuntimeHook(ctx as never);
    const event = sampleEvent();
    const before = JSON.stringify(event);
    let message = "";
    try {
      await handlers[0]!(event);
    } catch (error) {
      message = String(error);
    }
    ok(message.includes("PROJECT_CONTEXT_RUNTIME_BLOCK"));
    equal(JSON.stringify(event), before);
    const hooks = traceLines(traceDir).filter((r) => r["kind"] === "hook");
    equal(hooks[0]!["outcome"], "error_load_block");
  } finally {
    restoreEnv(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing block file fails closed without mutation", async () => {
  const prev = savedEnv();
  const dir = tmpDir("rt-hook-");
  try {
    enableRuntime(join(dir, "absent.txt"), join(dir, "trace"));
    const { handlers, ctx } = fakeSession();
    await registerRuntimeHook(ctx as never);
    const event = sampleEvent();
    const before = JSON.stringify(event);
    let threw = false;
    try {
      await handlers[0]!(event);
    } catch {
      threw = true;
    }
    ok(threw);
    equal(JSON.stringify(event), before);
  } finally {
    restoreEnv(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed block without markers is refused", () => {
  let message = "";
  try {
    loadBlock("whatever", () => "plain text, no markers");
  } catch (error) {
    message = String(error);
  }
  ok(message.includes("runtime markers"));
  try {
    loadBlock("whatever", () => "[CONTEXT RUNTIME]\nopen only");
  } catch (error) {
    message = String(error);
  }
  ok(message.includes("runtime markers"));
  equal(
    loadBlock("whatever", () => goodBlock("X")),
    goodBlock("X"),
  );
});

test("unsupported event shape fails closed without mutation", async () => {
  const prev = savedEnv();
  const dir = tmpDir("rt-hook-");
  try {
    const blockPath = join(dir, "block.txt");
    const traceDir = join(dir, "trace");
    writeFileSync(blockPath, goodBlock(), "utf-8");
    enableRuntime(blockPath, traceDir);
    const { handlers, ctx } = fakeSession();
    await registerRuntimeHook(ctx as never);
    const event = { ...sampleEvent(), system: "not-a-list" };
    const before = JSON.stringify(event);
    let message = "";
    try {
      await handlers[0]!(event);
    } catch (error) {
      message = String(error);
    }
    ok(message.includes("unsupported request shape"));
    equal(JSON.stringify(event), before);
    const hooks = traceLines(traceDir).filter((r) => r["kind"] === "hook");
    equal(hooks[0]!["outcome"], "error_unsupported_shape");
  } finally {
    restoreEnv(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("identical block is idempotent", async () => {
  const prev = savedEnv();
  const dir = tmpDir("rt-hook-");
  try {
    const blockPath = join(dir, "block.txt");
    const traceDir = join(dir, "trace");
    writeFileSync(blockPath, goodBlock("SAME"), "utf-8");
    enableRuntime(blockPath, traceDir);
    const { handlers, ctx } = fakeSession();
    await registerRuntimeHook(ctx as never);
    const event = sampleEvent();
    await handlers[0]!(event);
    equal((event.system as unknown[]).length, 3);
    await handlers[0]!(event);
    equal((event.system as unknown[]).length, 3);
    const outcomes = traceLines(traceDir)
      .filter((r) => r["kind"] === "hook")
      .map((r) => r["outcome"]);
    deepEqual(outcomes, ["injected", "noop_idempotent"]);
  } finally {
    restoreEnv(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conflicting block fails loudly without stacking", async () => {
  const prev = savedEnv();
  const dir = tmpDir("rt-hook-");
  try {
    const blockPath = join(dir, "block.txt");
    const traceDir = join(dir, "trace");
    writeFileSync(blockPath, goodBlock("NEW"), "utf-8");
    enableRuntime(blockPath, traceDir);
    const { handlers, ctx } = fakeSession();
    await registerRuntimeHook(ctx as never);
    const event = {
      ...sampleEvent(),
      system: [
        { type: "text", text: "plain" },
        { type: "text", text: goodBlock("OLD") },
      ],
    };
    const before = JSON.stringify(event);
    const beforeLen = (event.system as unknown[]).length;
    let message = "";
    try {
      await handlers[0]!(event);
    } catch (error) {
      message = String(error);
    }
    ok(message.includes("injection_conflict"));
    // No stacking: length unchanged, old block intact, new text absent.
    equal((event.system as unknown[]).length, beforeLen);
    equal(JSON.stringify(event), before);
    const hooks = traceLines(traceDir).filter((r) => r["kind"] === "hook");
    equal(hooks[0]!["outcome"], "failed_conflict");
  } finally {
    restoreEnv(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trace records counts and outcomes only, never block text", async () => {
  const prev = savedEnv();
  const dir = tmpDir("rt-hook-");
  try {
    const blockPath = join(dir, "block.txt");
    const traceDir = join(dir, "trace");
    writeFileSync(blockPath, goodBlock("SECRET-MARKER-ZZZ"), "utf-8");
    enableRuntime(blockPath, traceDir);
    const { handlers, ctx } = fakeSession();
    await registerRuntimeHook(ctx as never);
    await handlers[0]!(sampleEvent());
    const blob = readFileSync(join(traceDir, "runtime-trace.jsonl"), "utf-8");
    ok(!blob.includes("SECRET-MARKER-ZZZ"));
    ok(!blob.includes("[CONTEXT RUNTIME]"));
  } finally {
    restoreEnv(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});
