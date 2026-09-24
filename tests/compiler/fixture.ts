/**
 * Shared synthetic compile fixture for composition tests (no test()
 * registrations here, so it can be imported freely).
 */

import {
  defaultPolicy,
  type CompilerPolicy,
  type ContextCandidate,
  type ContextRequest,
} from "project-context-compiler/core";
import {
  compileTransport,
  type CompileTransportOk,
} from "../../src/compiler/compose.ts";

export function tinyRequest(budget = 500): ContextRequest {
  return {
    requestId: "smoke-req",
    taskId: "compiler transport smoke",
    usableTokenBudget: budget,
    createdAt: "2026-09-24T00:00:00.000Z",
    activeScope: "smoke",
    requiredIds: [],
    policyVersion: "compiler-policy-v1",
  };
}

export function tinyCandidate(): ContextCandidate {
  return {
    candidateId: "smoke-context",
    contentIdentity: "smoke-context",
    representationId: "full",
    formRank: 3,
    minRank: 0,
    sourceKind: "synthetic",
    sourceRef: "smoke",
    kind: "evidence",
    content: "smoke compiled content",
    tokenCount: 20,
    tokenSource: "fixture-declared-counts",
    requirement: "MANDATORY",
    orderRole: "evidence",
    scopeEligible: true,
    scopeReason: "",
    freshnessEligible: true,
    freshnessReason: "",
    authorityEligible: true,
    authorityReason: "",
    dependsOn: [],
    groupId: null,
    groupRequired: false,
    coverageKeys: [],
    relevance: 0.5,
    isDefaultForm: true,
  };
}

export function tinyPolicy(): CompilerPolicy {
  return defaultPolicy();
}

export const TEST_IDENTITY = {
  packageVersion: "0.2.2",
  revision: "test-revision",
};

export function composeTiny(uid: string, budget = 500): CompileTransportOk {
  const out = compileTransport({
    request: tinyRequest(budget),
    candidates: [tinyCandidate()],
    policy: tinyPolicy(),
    markerUid: uid,
    compiler: TEST_IDENTITY,
  });
  if (!out.ok) throw new Error(`expected success: ${JSON.stringify(out)}`);
  return out;
}
