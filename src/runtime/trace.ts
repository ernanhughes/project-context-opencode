/**
 * Opt-in qualification trace for the intervention runtime.
 *
 * Silent by default. JSONL records are written only when BOTH
 * `PROJECT_CONTEXT_RUNTIME=inject` and `PROJECT_CONTEXT_RUNTIME_TRACE_DIR`
 * (a directory) are set, so ordinary sessions never emit trace output.
 *
 * Records carry counts, outcomes, and session identity only — never
 * block text, prompt content, or model output. Trace files are
 * qualification-local (never committed) and exist solely to
 * distinguish "plugin loaded but mutation failed" from "plugin never
 * executed". A broken trace sink never breaks injection.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type HookOutcome =
  | "injected"
  | "noop_idempotent"
  | "failed_conflict"
  | "error_load_block"
  | "error_unsupported_shape";

export type HookTrace = {
  sessionID: string | null;
  agent: string | null;
  preBlocks: number;
  postBlocks: number;
  outcome: HookOutcome;
};

const TRACE_FILE = "runtime-trace.jsonl";

export function traceDir(): string | null {
  if (process.env["PROJECT_CONTEXT_RUNTIME"] !== "inject") return null;
  const dir = process.env["PROJECT_CONTEXT_RUNTIME_TRACE_DIR"];
  if (!dir) return null;
  return dir;
}

export function traceEnabled(): boolean {
  return traceDir() !== null;
}

function write(record: Record<string, unknown>): void {
  const dir = traceDir();
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, TRACE_FILE),
      JSON.stringify({ v: 1, ...record, at: new Date().toISOString() }) + "\n",
      "utf-8",
    );
  } catch {
    // Trace must never break injection.
  }
}

export function traceSetup(plugin: string): void {
  write({ kind: "setup", plugin, hookRegistered: true });
}

export function traceHook(input: HookTrace): void {
  write({ kind: "hook", ...input });
}
