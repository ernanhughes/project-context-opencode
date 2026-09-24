/**
 * Offline composition tests: explicit inputs -> compileContext ->
 * validated bundle -> render -> envelope. No OpenCode, no inference.
 */

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadBlock } from "../../src/runtime/hook.ts";
import {
  compileTransport,
  writeTransportBlock,
} from "../../src/compiler/compose.ts";
import {
  ENVELOPE_BEGIN,
  ENVELOPE_END,
  extractRendered,
  parseEnvelope,
} from "../../src/compiler/envelope.ts";
import {
  TEST_IDENTITY,
  composeTiny,
  tinyCandidate,
  tinyPolicy,
  tinyRequest,
} from "./fixture.ts";

test("tiny compile succeeds with exactly one item", () => {
  const out = composeTiny("OFFLINE-1");
  equal(out.bundle.items.length, 1);
  equal(out.bundle.items[0]?.id, "smoke-context");
  ok(out.result.bundleHash);
  equal(out.meta.bundleId, out.result.bundleId);
  equal(out.meta.bundleHash, out.result.bundleHash);
});

test("envelope embeds the render bytes unchanged", () => {
  const out = composeTiny("OFFLINE-2");
  ok(out.block.includes("[CONTEXT RUNTIME]"));
  ok(out.block.includes("[/CONTEXT RUNTIME]"));
  equal(extractRendered(out.block), out.rendered);
  equal(out.block.split(out.rendered).length - 1, 1);
  const meta = parseEnvelope(out.block);
  ok(meta);
  equal(meta?.marker, "PROJECT_CONTEXT_COMPILE_CANARY_OFFLINE-2");
  equal(meta?.requestId, "smoke-req");
  equal(meta?.policyVersion, "compiler-policy-v1");
});

test("transport block satisfies the runtime loader", () => {
  const out = composeTiny("OFFLINE-3");
  const dir = mkdtempSync(join(tmpdir(), "cc-compose-"));
  const path = writeTransportBlock(dir, out.block);
  equal(readFileSync(path, "utf-8"), out.block);
  equal(loadBlock(path), out.block);
});

test("composition is deterministic", () => {
  const first = composeTiny("OFFLINE-4");
  const second = composeTiny("OFFLINE-4");
  equal(first.renderedHash, second.renderedHash);
  equal(first.blockHash, second.blockHash);
  deepStrictEqual(first.meta, second.meta);
});

test("expected CompileFailure yields no transport block", () => {
  const out = compileTransport({
    request: tinyRequest(1),
    candidates: [tinyCandidate()],
    policy: tinyPolicy(),
    markerUid: "OFFLINE-5",
    compiler: TEST_IDENTITY,
  });
  equal(out.ok, false);
  if (!out.ok) {
    equal(out.failure?.reason, "INSUFFICIENT_BUDGET");
  }
});

test("inputs are not mutated by composition", () => {
  const request = tinyRequest();
  const candidates = [tinyCandidate()];
  const before = JSON.stringify({ request, candidates });
  const out = compileTransport({
    request,
    candidates,
    policy: tinyPolicy(),
    markerUid: "OFFLINE-6",
    compiler: TEST_IDENTITY,
  });
  ok(out.ok);
  equal(JSON.stringify({ request, candidates }), before);
});

test("envelope delimiters are present", () => {
  const out = composeTiny("OFFLINE-7");
  ok(out.block.includes(ENVELOPE_BEGIN));
  ok(out.block.includes(ENVELOPE_END));
});
