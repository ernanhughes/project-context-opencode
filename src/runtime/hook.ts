/**
 * Intervention runtime for OpenCode V2 (intervention side of the package).
 *
 * EVIDENCE STATUS. The hook mutation contract below has been live-tested
 * against a real OpenCode invocation: assigning the assembled `system`
 * array inside `session.hook("context")` persists into the invocation
 * the independent observer records (single-block growth, marker
 * reconciled exactly once). What this proves is mutation at the
 * OpenCode model-context hook boundary — NOT byte-for-byte provider
 * HTTP payload identity, which remains unobserved.
 *
 * Opt-in only: without PROJECT_CONTEXT_RUNTIME=inject this module
 * registers no hooks and changes nothing. The rendered block is read
 * from the FILE named by PROJECT_CONTEXT_RUNTIME_BLOCK (a path, never
 * the block text itself).
 *
 * Fail-safe: the new system array is built first and assigned once;
 * any error leaves the event untouched (no partial writes). A
 * differing pre-existing runtime block refuses with an error instead
 * of stacking payloads; an identical block is a no-op.
 */

import {
  BLOCK_CLOSE,
  BLOCK_OPEN,
  findExactBlock,
  findRuntimeBlocks,
} from "./blocks.ts";
import { traceHook, traceSetup } from "./trace.ts";
import { readFileSync } from "node:fs";

export const RUNTIME_OPT_IN_ENV = "PROJECT_CONTEXT_RUNTIME";
export const RUNTIME_BLOCK_ENV = "PROJECT_CONTEXT_RUNTIME_BLOCK";
export const RUNTIME_TRACE_ENV = "PROJECT_CONTEXT_RUNTIME_TRACE_DIR";
export const RUNTIME_OPT_IN_VALUE = "inject";

export type SessionContextEvent = {
  sessionID: string;
  agent: string;
  model: { providerID: string; id: string; variant?: string };
  system: unknown;
  messages: unknown;
  tools: Record<string, { description: string; input: unknown }>;
  options: Record<string, unknown>;
};

export type RuntimePluginContext = {
  session: {
    hook: (
      name: "context",
      callback: (event: SessionContextEvent) => void | Promise<void>,
    ) => Promise<{ dispose: () => Promise<void> }>;
  };
};

type Env = Record<string, string | undefined>;

export function runtimeEnabled(env: Env = process.env as Env): boolean {
  return env[RUNTIME_OPT_IN_ENV] === RUNTIME_OPT_IN_VALUE;
}

export function loadBlock(
  path: string | undefined,
  read: (path: string) => string = (p) => readFileSync(p, "utf-8"),
): string {
  if (!path) throw new Error(`${RUNTIME_BLOCK_ENV} is not set`);
  const text = read(path);
  if (!text.includes(BLOCK_OPEN) || !text.includes(BLOCK_CLOSE)) {
    throw new Error("rendered block lacks runtime markers; refusing");
  }
  return text;
}

/**
 * Register the intervention hook. No-op (zero hooks) unless the
 * runtime is explicitly enabled. Must be called BEFORE the observer
 * hook registration so the observer captures post-intervention context.
 */
export async function registerRuntimeHook(
  ctx: RuntimePluginContext,
  env: Env = process.env as Env,
): Promise<void> {
  if (!runtimeEnabled(env)) return;
  const blockPath = env[RUNTIME_BLOCK_ENV];
  await ctx.session.hook("context", (_event) => {
    const event = _event;
    const sessionID =
      typeof event.sessionID === "string" ? event.sessionID : null;
    const agent = typeof event.agent === "string" ? event.agent : null;
    const preBlocks = Array.isArray(event.system) ? event.system.length : -1;
    const finish = (
      outcome: Parameters<typeof traceHook>[0]["outcome"],
      postBlocks: number,
    ): void => {
      traceHook({ sessionID, agent, preBlocks, postBlocks, outcome });
    };
    let text: string;
    try {
      text = loadBlock(blockPath);
    } catch (err) {
      finish("error_load_block", preBlocks);
      throw err;
    }
    if (!Array.isArray(event.system)) {
      finish("error_unsupported_shape", preBlocks);
      throw new Error("unsupported request shape: system is not an array");
    }
    const marked = findRuntimeBlocks(event.system);
    if (marked.length > 0) {
      if (findExactBlock(event.system, text) >= 0) {
        finish("noop_idempotent", preBlocks);
        return; // idempotent
      }
      finish("failed_conflict", preBlocks);
      throw new Error(
        "injection_conflict: a different runtime block is present",
      );
    }
    const next = [...event.system, { type: "text", text }];
    event.system = next;
    finish("injected", next.length);
  });
  // Reached only if hook registration completed: the setup record
  // therefore implies the hook is registered, not merely attempted.
  traceSetup("project-context-runtime");
}
