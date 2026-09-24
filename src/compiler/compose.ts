/**
 * Composition: explicit compiler inputs -> compileContext() ->
 * validated bundle -> renderBundleText() -> transport envelope.
 *
 * ONE compiler implementation (imported, never vendored). On
 * CompileFailure this module produces no transport block: callers
 * must STOP (transport attempted: false).
 */

import {
  compileContext,
  renderBundleText,
  validateBundle,
  type CompilationResult,
  type CompilerPolicy,
  type ContextBundle,
  type ContextCandidate,
  type ContextRequest,
} from "project-context-compiler/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { buildMarker, wrapRendered, type EnvelopeMeta } from "./envelope.ts";

export const COMPILER_PACKAGE = "project-context-compiler";

export type CompilerIdentity = {
  packageVersion: string;
  revision: string;
};

export type CompileTransportInput = {
  request: ContextRequest;
  candidates: ContextCandidate[];
  policy: CompilerPolicy;
  markerUid: string;
  compiler: CompilerIdentity;
};

export type CompileTransportOk = {
  ok: true;
  bundle: ContextBundle;
  result: CompilationResult;
  rendered: string;
  renderedHash: string;
  block: string;
  blockHash: string;
  meta: EnvelopeMeta;
};

export type CompileTransportFail = {
  ok: false;
  failure: CompilationResult["failure"];
  validationProblems: string[];
};

export type CompileTransportOutput = CompileTransportOk | CompileTransportFail;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

export function compileTransport(
  input: CompileTransportInput,
): CompileTransportOutput {
  const output = compileContext(input.request, input.candidates, input.policy);
  if (!output.result.success || !output.bundle) {
    return {
      ok: false,
      failure: output.result.failure,
      validationProblems: [],
    };
  }
  const problems = validateBundle(
    output.bundle,
    input.request,
    input.candidates,
    input.policy,
  );
  if (problems.length > 0) {
    return {
      ok: false,
      failure: output.result.failure,
      validationProblems: problems,
    };
  }
  const rendered = renderBundleText(output.bundle);
  const meta: EnvelopeMeta = {
    compiler: COMPILER_PACKAGE,
    compilerVersion: input.compiler.packageVersion,
    compilerRevision: input.compiler.revision,
    requestId: output.result.requestId,
    policyVersion: output.result.policyVersion,
    bundleId: output.result.bundleId as string,
    bundleHash: output.result.bundleHash as string,
    bundleTokens: output.result.bundleTokens as number,
    marker: buildMarker(input.markerUid),
  };
  const block = wrapRendered({ rendered, meta });
  return {
    ok: true,
    bundle: output.bundle,
    result: output.result,
    rendered,
    renderedHash: sha256Hex(rendered),
    block,
    blockHash: sha256Hex(block),
    meta,
  };
}

/** Harness helper: write the transport block for the existing
 * runtime file boundary. Returns the block file path. */
export function writeTransportBlock(dir: string, block: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "compiled-block.txt");
  writeFileSync(path, block, "utf-8");
  return path;
}
