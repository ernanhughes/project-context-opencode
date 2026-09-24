/**
 * Pure reconciliation tests, including every fail-closed negative.
 * The happy path here mirrors what the live smoke must reproduce.
 */

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { reconcileCompiledTransport } from "../../src/compiler/reconcile.ts";
import type { ReconcileInput } from "../../src/compiler/schema.ts";
import { composeTiny } from "./fixture.ts";

const MARKER = "PROJECT_CONTEXT_COMPILE_CANARY_LIVE-1";

function happyEvidence() {
  const out = composeTiny("LIVE-1");
  const systemTexts = [
    "base instruction one",
    "base instruction two",
    out.block,
  ];
  const input: ReconcileInput = {
    compilation: {
      success: true,
      requestId: out.result.requestId,
      policyVersion: out.result.policyVersion,
      bundleId: out.result.bundleId,
      bundleHash: out.result.bundleHash,
      bundleTokens: out.result.bundleTokens,
    },
    renderedBundle: out.rendered,
    runtimeBlock: out.block,
    runtime: { outcome: "injected", preBlocks: 2, postBlocks: 3 },
    observer: {
      sessionId: "ses_test",
      sequence: 1,
      systemTexts,
      model: { provider_id: "p", id: "m", variant: null },
    },
    expectedMarker: MARKER,
    requestedModel: { provider: "p", id: "m" },
  };
  return { out, input };
}

test("happy path reconciles PASS", () => {
  const { out, input } = happyEvidence();
  const receipt = reconcileCompiledTransport(input);
  deepStrictEqual(receipt.failures, []);
  equal(receipt.status, "PASS");
  equal(receipt.bundle_id, out.result.bundleId);
  equal(receipt.bundle_hash, out.result.bundleHash);
  equal(receipt.compiler_render_hash, out.renderedHash);
  equal(receipt.runtime_block_hash, out.blockHash);
  equal(receipt.runtime_outcome, "injected");
  equal(receipt.marker_count, 1);
  equal(receipt.compiler_render_present, true);
  equal(receipt.runtime_block_present, true);
  equal(receipt.model_match, true);
});

test("compile failure is not transport failure", () => {
  const { input } = happyEvidence();
  const receipt = reconcileCompiledTransport({
    ...input,
    compilation: { ...input.compilation, success: false },
  });
  equal(receipt.status, "FAIL");
  ok(receipt.failures.some((f) => f.includes("compilation did not succeed")));
});

test("tampered bundle hash fails", () => {
  const { input } = happyEvidence();
  const receipt = reconcileCompiledTransport({
    ...input,
    compilation: { ...input.compilation, bundleHash: "0".repeat(64) },
  });
  equal(receipt.status, "FAIL");
  ok(receipt.failures.some((f) => f.includes("bundle_hash")));
});

test("modified rendered bundle fails", () => {
  const { input } = happyEvidence();
  const receipt = reconcileCompiledTransport({
    ...input,
    renderedBundle: input.renderedBundle + "tampered",
  });
  equal(receipt.status, "FAIL");
  ok(
    receipt.failures.some((f) =>
      f.includes("observed compiler render differs"),
    ),
  );
});

test("missing marker fails", () => {
  const { input } = happyEvidence();
  const receipt = reconcileCompiledTransport({
    ...input,
    expectedMarker: "NOPE",
  });
  equal(receipt.status, "FAIL");
  ok(receipt.failures.some((f) => f.includes("marker")));
});

test("duplicate marker fails", () => {
  const { out, input } = happyEvidence();
  const receipt = reconcileCompiledTransport({
    ...input,
    observer: input.observer && {
      ...input.observer,
      systemTexts: [...input.observer.systemTexts, out.block],
    },
  });
  equal(receipt.status, "FAIL");
  ok(
    receipt.failures.some((f) => f.includes("exactly once")),
    JSON.stringify(receipt.failures),
  );
});

test("wrong bundle ID fails", () => {
  const { input } = happyEvidence();
  const receipt = reconcileCompiledTransport({
    ...input,
    compilation: { ...input.compilation, bundleId: "other-bundle" },
  });
  equal(receipt.status, "FAIL");
  ok(receipt.failures.some((f) => f.includes("bundle_id")));
});

test("wrong policy version fails", () => {
  const { input } = happyEvidence();
  const receipt = reconcileCompiledTransport({
    ...input,
    compilation: { ...input.compilation, policyVersion: "other-policy" },
  });
  equal(receipt.status, "FAIL");
  ok(receipt.failures.some((f) => f.includes("policy_version")));
});

test("missing observer payload fails", () => {
  const { input } = happyEvidence();
  const receipt = reconcileCompiledTransport({ ...input, observer: null });
  equal(receipt.status, "FAIL");
  ok(receipt.failures.some((f) => f.includes("observer wrote no record")));
});

test("altered observed render fails", () => {
  const { out, input } = happyEvidence();
  const altered = out.block.replace(
    "smoke compiled content",
    "changed content",
  );
  const receipt = reconcileCompiledTransport({
    ...input,
    observer: input.observer && {
      ...input.observer,
      systemTexts: ["base", altered],
    },
  });
  equal(receipt.status, "FAIL");
  ok(
    receipt.failures.some(
      (f) => f.includes("never captured") || f.includes("differs"),
    ),
  );
});

test("runtime outcome other than injected fails", () => {
  const { input } = happyEvidence();
  const receipt = reconcileCompiledTransport({
    ...input,
    runtime: { outcome: "noop_idempotent", preBlocks: 3, postBlocks: 3 },
  });
  equal(receipt.status, "FAIL");
  ok(receipt.failures.some((f) => f.includes("not injected")));
});

test("unchanged postBlocks fails", () => {
  const { input } = happyEvidence();
  const receipt = reconcileCompiledTransport({
    ...input,
    runtime: { outcome: "injected", preBlocks: 3, postBlocks: 3 },
  });
  equal(receipt.status, "FAIL");
  ok(receipt.failures.some((f) => f.includes("not 1")));
});

test("missing runtime evidence fails", () => {
  const { input } = happyEvidence();
  const receipt = reconcileCompiledTransport({ ...input, runtime: null });
  equal(receipt.status, "FAIL");
  ok(receipt.failures.some((f) => f.includes("never executed")));
});

test("wrong requested/observed model fails", () => {
  const { input } = happyEvidence();
  const receipt = reconcileCompiledTransport({
    ...input,
    requestedModel: { provider: "other", id: "model" },
  });
  equal(receipt.status, "FAIL");
  equal(receipt.model_match, false);
});

test("absent model identity is recorded, not faked", () => {
  const { input } = happyEvidence();
  const receipt = reconcileCompiledTransport({
    ...input,
    requestedModel: null,
    observer: input.observer && { ...input.observer, model: null },
  });
  equal(receipt.status, "PASS");
  equal(receipt.model_match, null);
});
