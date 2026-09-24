/**
 * Pure reconciliation of compiled transport evidence. No model
 * calls, no filesystem access. Fail-closed: every mismatch appends
 * to `failures` and forces status FAIL.
 *
 * Three byte domains, kept distinct:
 * A. compiler render bytes (renderBundleText output)
 * B. runtime block bytes (envelope + render bytes)
 * C. observer-captured system block text
 *
 * Proven: A embedded unchanged in B, B injected exactly once,
 * C contains B exactly once. NOT proven: provider-wire identity.
 */

import { sha256Hex } from "./compose.ts";
import { extractRendered, parseEnvelope } from "./envelope.ts";
import type { CompiledTransportReceipt, ReconcileInput } from "./schema.ts";

export function reconcileCompiledTransport(
  input: ReconcileInput,
): CompiledTransportReceipt {
  const failures: string[] = [];
  const fail = (message: string): void => {
    failures.push(message);
  };

  const compilerRenderHash = sha256Hex(input.renderedBundle);
  const runtimeBlockHash = sha256Hex(input.runtimeBlock);

  // Compilation must have succeeded; otherwise no transport was legal.
  if (!input.compilation.success) {
    fail("compilation did not succeed; transport must not have been attempted");
  }
  if (!input.compilation.bundleId || !input.compilation.bundleHash) {
    fail("compilation lacks bundle identity");
  }

  // Runtime evidence.
  let runtimeOutcome: string | null = null;
  if (!input.runtime) {
    fail("runtime hook never executed");
  } else {
    runtimeOutcome = input.runtime.outcome;
    if (input.runtime.outcome !== "injected") {
      fail(`runtime outcome is ${input.runtime.outcome}, not injected`);
    }
    if (input.runtime.postBlocks - input.runtime.preBlocks !== 1) {
      fail(
        `postBlocks - preBlocks = ${input.runtime.postBlocks - input.runtime.preBlocks}, not 1`,
      );
    }
  }

  // Envelope integrity against the compilation evidence.
  const meta = parseEnvelope(input.runtimeBlock);
  if (!meta) {
    fail("runtime block envelope malformed");
  } else {
    if (meta.bundleId !== input.compilation.bundleId) {
      fail(
        `envelope bundle_id ${meta.bundleId} != compiled ${input.compilation.bundleId}`,
      );
    }
    if (meta.bundleHash !== input.compilation.bundleHash) {
      fail(`envelope bundle_hash != compiled bundle_hash`);
    }
    if (meta.requestId !== input.compilation.requestId) {
      fail(
        `envelope request_id ${meta.requestId} != compiled ${input.compilation.requestId}`,
      );
    }
    if (meta.policyVersion !== input.compilation.policyVersion) {
      fail(`envelope policy_version != compiled policy_version`);
    }
    if (meta.marker !== input.expectedMarker) {
      fail(`envelope marker != expected marker`);
    }
  }

  // Observer evidence.
  let markerCount = 0;
  let runtimeBlockPresent = false;
  let compilerRenderPresent = false;
  let observerSession: string | null = null;
  let observerSequence: number | null = null;
  if (!input.observer) {
    fail("observer wrote no record");
  } else {
    observerSession = input.observer.sessionId;
    observerSequence = input.observer.sequence;
    const blockHits = input.observer.systemTexts.filter(
      (text) => text === input.runtimeBlock,
    );
    runtimeBlockPresent = blockHits.length === 1;
    if (blockHits.length === 0) {
      fail("observer never captured the runtime block");
    } else if (blockHits.length > 1) {
      fail(
        `runtime block observed ${blockHits.length} times, not exactly once`,
      );
    } else {
      const recovered = extractRendered(blockHits[0] as string);
      compilerRenderPresent = recovered === input.renderedBundle;
      if (!compilerRenderPresent) {
        fail("observed compiler render differs from emitted render");
      }
    }
    markerCount = input.observer.systemTexts.reduce(
      (sum, text) => sum + text.split(input.expectedMarker).length - 1,
      0,
    );
    if (markerCount !== 1) {
      fail(`marker occurrences = ${markerCount}, not exactly once`);
    }
  }

  // Model attribution: mismatch fails; absence is recorded, not faked.
  const requested =
    input.requestedModel !== null && input.requestedModel !== undefined
      ? `${input.requestedModel.provider}/${input.requestedModel.id}`
      : null;
  const observed =
    input.observer?.model?.provider_id && input.observer?.model?.id
      ? `${input.observer.model.provider_id}/${input.observer.model.id}`
      : null;
  let modelMatch: boolean | null = null;
  if (requested !== null && observed !== null) {
    modelMatch = requested === observed;
    if (!modelMatch) {
      fail(`requested model ${requested} != observed ${observed}`);
    }
  }

  return {
    status: failures.length === 0 ? "PASS" : "FAIL",
    request_id: input.compilation.requestId,
    policy_version: input.compilation.policyVersion,
    bundle_id: input.compilation.bundleId,
    bundle_hash: input.compilation.bundleHash,
    compiler_render_hash: compilerRenderHash,
    runtime_block_hash: runtimeBlockHash,
    runtime_outcome: runtimeOutcome,
    observer_session_id: observerSession,
    observer_sequence: observerSequence,
    compiler_render_present: compilerRenderPresent,
    runtime_block_present: runtimeBlockPresent,
    marker_count: markerCount,
    requested_model: requested,
    observed_model: observed,
    model_match: modelMatch,
    failures,
  };
}
