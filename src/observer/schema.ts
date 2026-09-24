/**
 * V2 bridge schema shared with the Project Context debugger ingester.
 * V1 records are historical and must never be emitted here; the
 * Python reader rejects them loudly, never coerced.
 */

export const BRIDGE_SCHEMA_V2 = "project_context.opencode_capture.v2";

/** Tracks the unified package version (see package.json). */
export const ADAPTER_VERSION = "0.1.0";

/**
 * V2 observation boundary: the OpenCode V2 semantic model-request
 * context observed at the session context hook immediately before the
 * agent model request proceeds. NOT the byte-for-byte provider HTTP
 * request, NOT provider-added material, NOT the provider cache
 * decision.
 */
export const CAPTURE_STAGE_V2 = "opencode.v2.model_context";

export type RequestKind = "context" | "compaction" | "generate" | "title";

export type ModelRef = {
  provider_id: string | null;
  id: string | null;
  variant: string | null;
};

export type ModelLimits = {
  context: number | null;
  input?: number | null;
  output: number | null;
  source: string | null;
};

export type BridgeRecord = {
  schema: string;
  capture_id: string;
  captured_at: string;
  capture_stage: string;
  request_kind: RequestKind;
  session_id: string | null;
  invocation_sequence: number;
  agent: string | null;
  model: ModelRef | null;
  model_limits: ModelLimits | null;
  system: unknown;
  messages: unknown;
  tools: Record<string, unknown>;
  options: Record<string, unknown>;
  adapter_version: string;
  opencode_version: string;
  plugin_api_version: string;
  observer_position: string;
  integrity: { sha256: string };
  timings_ms: { serialize: number; write: number; total: number };
  evidence_class: "opencode_capture";
};

export function validateBridgeRecord(record: unknown): string[] {
  const errors: string[] = [];
  if (typeof record !== "object" || record === null) {
    return ["record is not an object"];
  }
  const rec = record as Record<string, unknown>;
  if (rec["schema"] !== BRIDGE_SCHEMA_V2) {
    if (rec["schema"] === "project_context.opencode_capture.v1") {
      return ["unsupported schema: V1 capture retired; re-capture under V2"];
    }
    errors.push(`unsupported schema: ${String(rec["schema"])}`);
    return errors;
  }
  for (const key of [
    "capture_id",
    "captured_at",
    "capture_stage",
    "request_kind",
    "session_id",
    "invocation_sequence",
    "agent",
    "model",
    "system",
    "messages",
    "tools",
    "options",
    "integrity",
  ]) {
    if (!(key in rec)) errors.push(`missing key: ${key}`);
  }
  if ("system" in rec && !Array.isArray(rec["system"])) {
    errors.push("system is not a list");
  }
  if ("messages" in rec && !Array.isArray(rec["messages"])) {
    errors.push("messages is not a list");
  }
  if (
    "tools" in rec &&
    (typeof rec["tools"] !== "object" || rec["tools"] === null)
  ) {
    errors.push("tools is not an object");
  }
  if (
    "options" in rec &&
    (typeof rec["options"] !== "object" || rec["options"] === null)
  ) {
    errors.push("options is not an object");
  }
  return errors;
}
