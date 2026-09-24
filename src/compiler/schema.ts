/**
 * Compiled-transport receipt and evidence types.
 *
 * Four distinct evidence records stay distinct:
 * CompilationResult / DecisionTrace (compiler), runtime trace
 * (transport), observer record (independent capture), and this
 * receipt, which references and reconciles them without merging.
 */

export type RuntimeEvidence = {
  outcome: string;
  preBlocks: number;
  postBlocks: number;
} | null;

export type ObserverModel = {
  provider_id: string | null;
  id: string | null;
  variant: string | null;
} | null;

export type ObserverEvidence = {
  sessionId: string | null;
  sequence: number | null;
  systemTexts: string[];
  model: ObserverModel;
} | null;

export type RequestedModel = {
  provider: string;
  id: string;
} | null;

export type ReconcileInput = {
  compilation: {
    success: boolean;
    requestId: string;
    policyVersion: string;
    bundleId: string | null;
    bundleHash: string | null;
    bundleTokens: number | null;
  };
  renderedBundle: string;
  runtimeBlock: string;
  runtime: RuntimeEvidence;
  observer: ObserverEvidence;
  expectedMarker: string;
  requestedModel: RequestedModel;
};

export type CompiledTransportReceipt = {
  status: "PASS" | "FAIL";
  request_id: string;
  policy_version: string;
  bundle_id: string | null;
  bundle_hash: string | null;
  compiler_render_hash: string;
  runtime_block_hash: string;
  runtime_outcome: string | null;
  observer_session_id: string | null;
  observer_sequence: number | null;
  compiler_render_present: boolean;
  runtime_block_present: boolean;
  marker_count: number;
  requested_model: string | null;
  observed_model: string | null;
  model_match: boolean | null;
  failures: string[];
};
