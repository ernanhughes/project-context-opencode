/**
 * Observer hook registration (read-only side of the package).
 *
 * READ-ONLY. The session context hooks below copy the assembled
 * model-request context out and append it to a local spool. No hook
 * mutates its event.
 *
 * What this observes (one record per observed model request):
 * - session.hook("context"): assembled system/messages/tools/options
 *   plus session/agent/model identity, immediately before the agent
 *   model request proceeds. Primary agent-loop scope.
 * - session.hook("compaction"): checkpoint-summary request. Recorded
 *   with request_kind "compaction", filtered from primary timelines by
 *   default. event.result is NEVER set (no intervention).
 * - session.hook("generate"): transient generate calls, recorded with
 *   request_kind "generate", filtered from primary timelines by
 *   default.
 *
 * Capture stage: `opencode.v2.model_context` — the OpenCode V2 semantic
 * model-request context. This is NOT the byte-for-byte provider HTTP
 * request: protocol/provider lowering happens after this hook, and
 * provider-added material, wire representation, and cache decisions
 * remain unobserved. Reports state this explicitly.
 *
 * Activation: registers nothing unless PROJECT_CONTEXT_CAPTURE=1.
 * An empty spool therefore proves nothing about model activity; it
 * most likely means capture was never enabled in the process that
 * served the request. The smoke test makes this prerequisite
 * explicit instead of hidden.
 */

import {
  appendRecord,
  buildRecord,
  captureEnabled,
  copyBlock,
  defaultSpoolDir,
  newCaptureId,
  nowIso,
} from "./capture.ts";
import { SequenceStore } from "./sequence.ts";
import type { ModelLimits, ModelRef, RequestKind } from "./schema.ts";

type Env = Record<string, string | undefined>;

export type SessionContextEvent = {
  sessionID: string;
  agent: string;
  model: { providerID: string; id: string; variant?: string };
  system: unknown;
  messages: unknown;
  tools: Record<string, { description: string; input: unknown }>;
  options: Record<string, unknown>;
};

type ModelInfo = {
  id?: string;
  modelID?: string;
  providerID?: string;
  limit?: { context?: number; input?: number; output?: number };
};
type ModelList = { data?: ModelInfo[] } | ModelInfo[];

export type ObserverPluginContext = {
  app: { version: string };
  model: {
    list: () => Promise<ModelList>;
  };
  session: {
    hook: (
      name: "context" | "compaction" | "generate",
      callback: (event: SessionContextEvent) => void | Promise<void>,
    ) => Promise<{ dispose: () => Promise<void> }>;
  };
};

export function toModelRef(raw: unknown): ModelRef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const providerID = obj["providerID"];
  const id = obj["id"] ?? obj["modelID"];
  const variant = obj["variant"];
  if (typeof providerID !== "string" && typeof id !== "string") return null;
  return {
    provider_id: typeof providerID === "string" ? providerID : null,
    id: typeof id === "string" ? id : null,
    variant: typeof variant === "string" ? variant : null,
  };
}

async function readModelLimits(
  ctx: ObserverPluginContext,
  model: { providerID: string; id: string },
): Promise<ModelLimits | null> {
  try {
    const listed = await ctx.model.list();
    const rows = Array.isArray(listed) ? listed : (listed?.data ?? []);
    const info = rows.find(
      (m) =>
        m.providerID === model.providerID && (m.modelID ?? m.id) === model.id,
    );
    const context = info?.limit?.context;
    const input = info?.limit?.input;
    const output = info?.limit?.output;
    if (
      typeof context !== "number" &&
      typeof input !== "number" &&
      typeof output !== "number"
    )
      return null;
    return {
      context: typeof context === "number" ? context : null,
      input: typeof input === "number" ? input : null,
      output: typeof output === "number" ? output : null,
      source: "ctx.model.list",
    };
  } catch {
    // Model metadata unavailable at capture time: UNAVAILABLE is
    // correct. Never hard-code capacities, never infer from names.
    return null;
  }
}

/**
 * Register the observer hooks. No-op (zero hooks) unless capture is
 * explicitly enabled. Must be called AFTER the runtime hook
 * registration so captures observe the post-intervention context.
 */
export async function registerObserverHooks(
  ctx: ObserverPluginContext,
  env: Env = process.env as Env,
): Promise<void> {
  if (!captureEnabled(env)) return;

  // Sequence numbers survive a harness restart (see sequence.ts). Reserved before the
  // record is appended, so a crash leaves a detectable gap and never a reused number.
  const sequences = new SequenceStore(defaultSpoolDir(env));

  const capture = async (kind: RequestKind, event: SessionContextEvent) => {
    // READ-ONLY: copy blocks out first; the event is never written.
    const system = copyBlock(event.system);
    const messages = copyBlock(event.messages);
    const tools = copyBlock(event.tools) as Record<string, unknown>;
    const options = copyBlock(event.options) as Record<string, unknown>;
    const serializeStart = performance.now();
    const capturedAt = nowIso();
    const sessionID =
      typeof event.sessionID === "string" ? event.sessionID : null;
    const model = toModelRef(event.model);
    const limits =
      model && model.provider_id && model.id
        ? await readModelLimits(ctx, {
            providerID: model.provider_id,
            id: model.id,
          })
        : null;
    const record = buildRecord({
      request_kind: kind,
      session_id: sessionID,
      invocation_sequence: sequences.next(sessionID).sequence,
      agent: typeof event.agent === "string" ? event.agent : null,
      model,
      model_limits: limits,
      system,
      messages,
      tools,
      options,
      captured_at: capturedAt,
      capture_id: newCaptureId(),
      opencode_version:
        typeof ctx.app.version === "string" ? ctx.app.version : undefined,
    });
    const serializeMs = performance.now() - serializeStart;
    const writeMs = appendRecord(defaultSpoolDir(env), record);
    record.timings_ms = {
      serialize: serializeMs,
      write: writeMs,
      total: serializeMs + writeMs,
    };
  };

  await ctx.session.hook("context", (event) => capture("context", event));
  await ctx.session.hook("compaction", (event) => capture("compaction", event));
  await ctx.session.hook("generate", (event) => capture("generate", event));
}
