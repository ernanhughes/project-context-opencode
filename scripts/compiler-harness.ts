/**
 * Live-smoke harness for compiled transport. Orchestrated by
 * scripts/compiler-smoke.ps1; all logic stays in tested TS.
 *
 * compose:   explicit JSON inputs -> compileTransport -> block file
 *            + evidence JSON (no OpenCode, no inference).
 * reconcile: evidence + runtime trace + observer spool ->
 *            CompiledTransportReceipt + compiler-canary.json.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  candidateFromJSON,
  policyFromJSON,
  requestFromJSON,
} from "project-context-compiler/core";
import {
  compileTransport,
  writeTransportBlock,
} from "../src/compiler/compose.ts";
import { reconcileCompiledTransport } from "../src/compiler/reconcile.ts";
import type {
  ObserverEvidence,
  ReconcileInput,
} from "../src/compiler/schema.ts";

function readJSON(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function argValue(argv: string[], key: string): string | null {
  const index = argv.indexOf(key);
  if (index < 0 || index + 1 >= argv.length) return null;
  return argv[index + 1] as string;
}

function cmdCompose(argv: string[]): number {
  const requestPath = argValue(argv, "--request");
  const candidatesPath = argValue(argv, "--candidates");
  const policyPath = argValue(argv, "--policy");
  const uid = argValue(argv, "--uid");
  const version = argValue(argv, "--compiler-version") ?? "unknown";
  const revision = argValue(argv, "--compiler-revision") ?? "unknown";
  const blockOut = argValue(argv, "--block-out");
  const evidenceOut = argValue(argv, "--evidence-out");
  if (
    !requestPath ||
    !candidatesPath ||
    !policyPath ||
    !uid ||
    !blockOut ||
    !evidenceOut
  ) {
    console.error("compose: missing required arguments");
    return 2;
  }
  const request = requestFromJSON(readJSON(requestPath));
  const rawCandidates = readJSON(candidatesPath) as { candidates: unknown[] };
  const candidates = rawCandidates.candidates.map((c) => candidateFromJSON(c));
  const policy = policyFromJSON(readJSON(policyPath));
  const out = compileTransport({
    request,
    candidates,
    policy,
    markerUid: uid,
    compiler: { packageVersion: version, revision },
  });
  if (!out.ok) {
    console.error(
      `COMPILE_FAILURE: ${out.failure?.reason ?? "invalid bundle"}`,
    );
    return 1;
  }
  const blockPath = writeTransportBlock(blockOut, out.block);
  const evidence = {
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
    renderedHash: out.renderedHash,
    blockHash: out.blockHash,
    blockPath,
    expectedMarker: out.meta.marker,
    compiler: { packageVersion: version, revision },
  };
  writeFileSync(evidenceOut, JSON.stringify(evidence, null, 2) + "\n", "utf-8");
  console.log(`compiled ${out.result.bundleId} hash=${out.result.bundleHash}`);
  return 0;
}

type TraceLine = {
  kind?: string;
  outcome?: string;
  preBlocks?: number;
  postBlocks?: number;
  sessionID?: string | null;
};

function cmdReconcile(argv: string[]): number {
  const evidencePath = argValue(argv, "--evidence");
  const tracePath = argValue(argv, "--trace");
  const spoolDir = argValue(argv, "--spool");
  const requested = argValue(argv, "--requested-model");
  const receiptOut = argValue(argv, "--receipt-out");
  const canaryOut = argValue(argv, "--canary-out");
  if (!evidencePath || !tracePath || !spoolDir || !receiptOut || !canaryOut) {
    console.error("reconcile: missing required arguments");
    return 2;
  }
  const evidence = readJSON(evidencePath) as {
    compilation: ReconcileInput["compilation"];
    renderedBundle: string;
    runtimeBlock: string;
    expectedMarker: string;
    compiler: { packageVersion: string; revision: string };
  };
  const requestedModel = requested
    ? (() => {
        const clean = requested.split("#")[0] as string;
        const slash = clean.indexOf("/");
        if (slash < 0) return null;
        return {
          provider: clean.slice(0, slash),
          id: clean.slice(slash + 1),
        };
      })()
    : null;

  // Runtime evidence: latest hook record.
  let runtime: ReconcileInput["runtime"] = null;
  let hookSession: string | null = null;
  try {
    const lines = readFileSync(tracePath, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TraceLine)
      .filter((record) => record.kind === "hook");
    const last = lines[lines.length - 1];
    if (
      last &&
      typeof last.preBlocks === "number" &&
      typeof last.postBlocks === "number"
    ) {
      runtime = {
        outcome: String(last.outcome ?? "unknown"),
        preBlocks: last.preBlocks,
        postBlocks: last.postBlocks,
      };
      hookSession = typeof last.sessionID === "string" ? last.sessionID : null;
    }
  } catch {
    runtime = null;
  }

  // Observer evidence: context records from today's spool file.
  const day = new Date().toISOString().slice(0, 10);
  let observer: ObserverEvidence = null;
  let blockRecords = 0;
  try {
    const spoolFile = join(spoolDir, day, "captures.jsonl");
    const records = readFileSync(spoolFile, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record["request_kind"] === "context");
    const withBlock = records.filter((record) =>
      ((record["system"] ?? []) as Array<{ text?: string }>).some(
        (block) => block.text === evidence.runtimeBlock,
      ),
    );
    blockRecords = withBlock.length;
    // An agent loop may inject the same block across several requests
    // of one session. Pair the latest hook with the latest
    // block-containing record of the same session; marker-once is
    // still enforced within that record by the pure reconciler.
    const sameSession = withBlock.filter(
      (record) => !hookSession || record["session_id"] === hookSession,
    );
    const pool = sameSession.length > 0 ? sameSession : [];
    const chosen =
      pool.length > 0
        ? (pool[pool.length - 1] as Record<string, unknown>)
        : (records[records.length - 1] as Record<string, unknown> | undefined);
    if (chosen) {
      const system = (chosen["system"] ?? []) as Array<{ text?: string }>;
      const model = (chosen["model"] ?? null) as {
        provider_id?: string;
        id?: string;
        variant?: string;
      } | null;
      observer = {
        sessionId:
          typeof chosen["session_id"] === "string"
            ? (chosen["session_id"] as string)
            : null,
        sequence:
          typeof chosen["invocation_sequence"] === "number"
            ? (chosen["invocation_sequence"] as number)
            : null,
        systemTexts: system.map((block) => block.text ?? ""),
        model: model
          ? {
              provider_id: model.provider_id ?? null,
              id: model.id ?? null,
              variant: model.variant ?? null,
            }
          : null,
      };
    }
  } catch {
    observer = null;
  }

  const input: ReconcileInput = {
    compilation: evidence.compilation,
    renderedBundle: evidence.renderedBundle,
    runtimeBlock: evidence.runtimeBlock,
    runtime,
    observer,
    expectedMarker: evidence.expectedMarker,
    requestedModel,
  };
  const receipt = reconcileCompiledTransport(input);
  writeFileSync(receiptOut, JSON.stringify(receipt, null, 2) + "\n", "utf-8");
  const canary = {
    schema: "project_context.compile_canary.v1",
    status: receipt.status,
    compiler: evidence.compiler,
    request: {
      request_id: receipt.request_id,
      policy_version: receipt.policy_version,
    },
    compilation: {
      success: evidence.compilation.success,
      bundle_id: receipt.bundle_id,
      bundle_hash: receipt.bundle_hash,
      bundle_tokens: evidence.compilation.bundleTokens,
    },
    render: { rendered_hash: receipt.compiler_render_hash },
    transport: {
      runtime_block_hash: receipt.runtime_block_hash,
      runtime_outcome: receipt.runtime_outcome,
      pre_blocks: runtime?.preBlocks ?? null,
      post_blocks: runtime?.postBlocks ?? null,
    },
    observer: {
      session_id: receipt.observer_session_id,
      sequence: receipt.observer_sequence,
      observed_model: receipt.observed_model,
      marker_count: receipt.marker_count,
      block_records_total: blockRecords,
    },
    reconciliation: {
      compiler_render_exact: receipt.compiler_render_present,
      runtime_exact: receipt.runtime_block_present,
      bundle_id_match: !receipt.failures.some((f) => f.includes("bundle_id")),
      bundle_hash_match: !receipt.failures.some((f) =>
        f.includes("bundle_hash"),
      ),
      model_match: receipt.model_match,
    },
    failures: receipt.failures,
    completed_at: new Date().toISOString(),
  };
  writeFileSync(canaryOut, JSON.stringify(canary, null, 2) + "\n", "utf-8");
  console.log(`reconciliation: ${receipt.status}`);
  for (const failure of receipt.failures) console.log(`  - ${failure}`);
  return receipt.status === "PASS" ? 0 : 1;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const [command] = argv;
  if (command === "compose") return cmdCompose(argv);
  if (command === "reconcile") return cmdReconcile(argv);
  console.error("usage: compiler-harness.ts <compose|reconcile> ...");
  return 2;
}

process.exit(main());
