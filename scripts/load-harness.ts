/**
 * Zero-inference registration harness for scripts/load-check.
 * Run: node scripts/load-harness.ts (no build, no model, no network).
 *
 * Drives the real plugin setup against a fake host and asserts the
 * hook-registration matrix, including runtime-before-observer order.
 * Exits non-zero on any mismatch.
 */

import plugin from "../src/index.ts";

type HookFn = (event: Record<string, unknown>) => void | Promise<void>;

const ENVS = [
  "PROJECT_CONTEXT_CAPTURE",
  "PROJECT_CONTEXT_SPOOL_DIR",
  "PROJECT_CONTEXT_RUNTIME",
  "PROJECT_CONTEXT_RUNTIME_BLOCK",
  "PROJECT_CONTEXT_RUNTIME_TRACE_DIR",
];

function clearEnv(): void {
  for (const key of ENVS) delete process.env[key];
}

function fakeHost(version: unknown = "2.0.16") {
  const order: string[] = [];
  return {
    order,
    ctx: {
      app: { version },
      model: {
        list: async () => ({ data: [] }),
      },
      session: {
        hook: async (name: string, _callback: HookFn) => {
          order.push(name);
          return { dispose: async () => {} };
        },
      },
    },
  };
}

function check(name: string, actual: string[], expected: string[]): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`MISMATCH ${name}: got ${a}, want ${e}`);
    process.exitCode = 1;
  } else {
    console.log(`ok ${name}: ${a}`);
  }
}

async function main(): Promise<void> {
  // Both disabled: no hooks.
  clearEnv();
  {
    const { order, ctx } = fakeHost();
    await plugin.setup(ctx as never);
    check("both-disabled", order, []);
  }
  // Capture only.
  clearEnv();
  process.env["PROJECT_CONTEXT_CAPTURE"] = "1";
  {
    const { order, ctx } = fakeHost();
    await plugin.setup(ctx as never);
    check("capture-only", order, ["context", "compaction", "generate"]);
  }
  // Runtime only.
  clearEnv();
  process.env["PROJECT_CONTEXT_RUNTIME"] = "inject";
  process.env["PROJECT_CONTEXT_RUNTIME_BLOCK"] = "C:/nonexistent-block.txt";
  {
    const { order, ctx } = fakeHost();
    await plugin.setup(ctx as never);
    check("runtime-only", order, ["context"]);
  }
  // Both: runtime first, then observer.
  clearEnv();
  process.env["PROJECT_CONTEXT_CAPTURE"] = "1";
  process.env["PROJECT_CONTEXT_RUNTIME"] = "inject";
  process.env["PROJECT_CONTEXT_RUNTIME_BLOCK"] = "C:/nonexistent-block.txt";
  {
    const { order, ctx } = fakeHost();
    await plugin.setup(ctx as never);
    check("both-enabled", order, [
      "context",
      "context",
      "compaction",
      "generate",
    ]);
  }
  // Incompatible host fails clearly.
  clearEnv();
  {
    const { ctx } = fakeHost("1.0.0");
    let threw = false;
    try {
      await plugin.setup(ctx as never);
    } catch {
      threw = true;
    }
    if (!threw) {
      console.error("MISMATCH bad-version: setup should have thrown");
      process.exitCode = 1;
    } else {
      console.log("ok bad-version: setup threw clearly");
    }
  }
  clearEnv();
}

await main();
