/**
 * Combined mechanism tests: deliberate runtime-before-observer ordering
 * through the unified package setup (node:test, no test framework).
 * Run: npm test
 *
 * The fake session preserves registration order and replays every
 * "context" callback against the same event object in order, which is
 * the OpenCode contract this package relies on.
 *
 * 1. setup registers the runtime hook before the observer hooks
 * 2. runtime enabled + observer enabled: observer sees the marker
 *    exactly once, last, byte-identical, same session as the trace
 * 3. runtime disabled + observer enabled: untouched context captured
 * 4. capture disabled does not prevent runtime injection
 * 5. both disabled: zero hooks, zero side effects
 * 6. observer never mutates the event, even post-injection
 */

import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import plugin from "../src/index.ts";

type HookFn = (event: Record<string, unknown>) => Promise<void> | void;

const ENVS = [
  "PROJECT_CONTEXT_CAPTURE",
  "PROJECT_CONTEXT_SPOOL_DIR",
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

function fakeHost() {
  const order: string[] = [];
  const handlers = new Map<string, HookFn[]>();
  return {
    order,
    handlers,
    ctx: {
      app: { version: "2.0.16" },
      model: {
        list: async () => ({ data: [] }),
      },
      session: {
        hook: async (name: string, callback: HookFn) => {
          order.push(name);
          const list = handlers.get(name) ?? [];
          list.push(callback);
          handlers.set(name, list);
          return { dispose: async () => {} };
        },
      },
    },
  };
}

/** Replay every "context" callback in registration order, like OpenCode. */
async function dispatchContext(
  handlers: Map<string, HookFn[]>,
  event: Record<string, unknown>,
): Promise<void> {
  for (const fn of handlers.get("context") ?? []) await fn(event);
}

function sampleEvent() {
  return {
    sessionID: "ses-combined-1",
    agent: "build",
    model: { providerID: "p", id: "m" },
    system: [{ type: "text", text: "base instruction" }],
    messages: [{ role: "user", content: "hi" }],
    tools: {},
    options: {},
  };
}

function enableBoth(
  spool: string,
  blockPath: string,
  traceDir: string,
  runtime = true,
  capture = true,
): void {
  if (capture) {
    process.env["PROJECT_CONTEXT_CAPTURE"] = "1";
    process.env["PROJECT_CONTEXT_SPOOL_DIR"] = spool;
  }
  if (runtime) {
    process.env["PROJECT_CONTEXT_RUNTIME"] = "inject";
    process.env["PROJECT_CONTEXT_RUNTIME_BLOCK"] = blockPath;
    process.env["PROJECT_CONTEXT_RUNTIME_TRACE_DIR"] = traceDir;
  }
}

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readCaptures(spool: string): Array<Record<string, unknown>> {
  const day = new Date().toISOString().slice(0, 10);
  return readFileSync(join(spool, day, "captures.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

function readHooks(traceDir: string): Array<Record<string, unknown>> {
  return readFileSync(join(traceDir, "runtime-trace.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((r: Record<string, unknown>) => r["kind"] === "hook");
}

test("setup registers runtime before observer, in code", async () => {
  const prev = savedEnv();
  const dir = tmpDir("pc-combined-");
  try {
    const spool = join(dir, "spool");
    const blockPath = join(dir, "block.txt");
    const traceDir = join(dir, "trace");
    writeFileSync(
      blockPath,
      "[CONTEXT RUNTIME]\nX\n[/CONTEXT RUNTIME]",
      "utf-8",
    );
    enableBoth(spool, blockPath, traceDir);
    const { order, ctx } = fakeHost();
    await plugin.setup(ctx as never);
    // One runtime context hook first, then the three observer hooks.
    deepEqual(order, ["context", "context", "compaction", "generate"]);
  } finally {
    restoreEnv(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("observer sees the runtime marker exactly once, post-mutation", async () => {
  const prev = savedEnv();
  const dir = tmpDir("pc-combined-");
  try {
    const spool = join(dir, "spool");
    const blockPath = join(dir, "block.txt");
    const traceDir = join(dir, "trace");
    const marker = `COMBINED-MARKER-${Date.now()}`;
    const block = `[CONTEXT RUNTIME]\n[SMOKE]\n${marker}\n[/CONTEXT RUNTIME]`;
    writeFileSync(blockPath, block, "utf-8");
    enableBoth(spool, blockPath, traceDir);
    const { handlers, ctx } = fakeHost();
    await plugin.setup(ctx as never);
    const event = sampleEvent();
    await dispatchContext(handlers, event);
    // Runtime trace: one injection, single-block growth.
    const hooks = readHooks(traceDir);
    equal(hooks.length, 1);
    deepEqual(
      [hooks[0]!["preBlocks"], hooks[0]!["postBlocks"], hooks[0]!["outcome"]],
      [1, 2, "injected"],
    );
    // Observer capture: marker exactly once, last, byte-identical.
    const captures = readCaptures(spool);
    equal(captures.length, 1);
    const system = captures[0]!["system"] as Array<{ text: string }>;
    equal(system.length, 2);
    const hits = system.filter((b) => b.text.includes(marker));
    equal(hits.length, 1);
    equal(system[system.length - 1]!.text, block);
    // Same invocation/session reconciliation.
    equal(captures[0]!["session_id"], hooks[0]!["sessionID"]);
    equal(captures[0]!["session_id"], "ses-combined-1");
  } finally {
    restoreEnv(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime disabled: observer captures the untouched context", async () => {
  const prev = savedEnv();
  const dir = tmpDir("pc-combined-");
  try {
    const spool = join(dir, "spool");
    const blockPath = join(dir, "block.txt");
    const traceDir = join(dir, "trace");
    writeFileSync(
      blockPath,
      "[CONTEXT RUNTIME]\nX\n[/CONTEXT RUNTIME]",
      "utf-8",
    );
    enableBoth(spool, blockPath, traceDir, false, true);
    const { order, handlers, ctx } = fakeHost();
    await plugin.setup(ctx as never);
    deepEqual(order, ["context", "compaction", "generate"]);
    const event = sampleEvent();
    await dispatchContext(handlers, event);
    const captures = readCaptures(spool);
    equal(captures.length, 1);
    deepEqual(captures[0]!["system"], [
      { type: "text", text: "base instruction" },
    ]);
  } finally {
    restoreEnv(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture disabled does not prevent runtime injection", async () => {
  const prev = savedEnv();
  const dir = tmpDir("pc-combined-");
  try {
    const spool = join(dir, "spool");
    const blockPath = join(dir, "block.txt");
    const traceDir = join(dir, "trace");
    writeFileSync(
      blockPath,
      "[CONTEXT RUNTIME]\nY\n[/CONTEXT RUNTIME]",
      "utf-8",
    );
    enableBoth(spool, blockPath, traceDir, true, false);
    const { order, handlers, ctx } = fakeHost();
    await plugin.setup(ctx as never);
    deepEqual(order, ["context"]);
    const event = sampleEvent();
    await dispatchContext(handlers, event);
    equal((event.system as unknown[]).length, 2);
    const hooks = readHooks(traceDir);
    equal(hooks[0]!["outcome"], "injected");
  } finally {
    restoreEnv(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("both disabled: no hooks, no side effects", async () => {
  const prev = savedEnv();
  const dir = tmpDir("pc-combined-");
  try {
    const { order, ctx } = fakeHost();
    await plugin.setup(ctx as never);
    deepEqual(order, []);
    ok(true);
  } finally {
    restoreEnv(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("observer never mutates the event, even post-injection", async () => {
  const prev = savedEnv();
  const dir = tmpDir("pc-combined-");
  try {
    const spool = join(dir, "spool");
    const blockPath = join(dir, "block.txt");
    const traceDir = join(dir, "trace");
    writeFileSync(
      blockPath,
      "[CONTEXT RUNTIME]\nZ\n[/CONTEXT RUNTIME]",
      "utf-8",
    );
    enableBoth(spool, blockPath, traceDir);
    const { handlers, ctx } = fakeHost();
    await plugin.setup(ctx as never);
    // Dispatch through the runtime hook alone, snapshot, then replay
    // the observer hook alone: the observer must change nothing.
    const runtimeOnly = handlers.get("context")![0]!;
    const event = sampleEvent();
    await runtimeOnly(event);
    const afterRuntime = JSON.stringify(event);
    const observerOnly = handlers.get("context")![1]!;
    await observerOnly(event);
    equal(JSON.stringify(event), afterRuntime);
  } finally {
    restoreEnv(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});
