/**
 * Transport envelope: compiler output vs transport envelope stay
 * distinct. The envelope adds metadata AROUND the exact
 * `renderBundleText()` bytes; the rendered section is recoverable
 * byte-for-byte for reconciliation.
 *
 * Layout:
 *
 * [CONTEXT RUNTIME]
 * compiler: project-context-compiler
 * compiler_version: <version>
 * compiler_revision: <sha|unknown>
 * request_id: <...>
 * policy_version: <...>
 * bundle_id: <...>
 * bundle_hash: <...>
 * bundle_tokens: <...>
 * marker: PROJECT_CONTEXT_COMPILE_CANARY_<uid>
 * --- compiled context begins ---
 * <EXACT renderBundleText(bundle) BYTES>
 * --- compiled context ends ---
 * [/CONTEXT RUNTIME]
 */

import { BLOCK_CLOSE, BLOCK_OPEN } from "../runtime/blocks.ts";

export const ENVELOPE_BEGIN = "--- compiled context begins ---";
export const ENVELOPE_END = "--- compiled context ends ---";
export const MARKER_PREFIX = "PROJECT_CONTEXT_COMPILE_CANARY_";

export type EnvelopeMeta = {
  compiler: string;
  compilerVersion: string;
  compilerRevision: string;
  requestId: string;
  policyVersion: string;
  bundleId: string;
  bundleHash: string;
  bundleTokens: number;
  marker: string;
};

export function buildMarker(uid: string): string {
  if (!uid || !/^[A-Za-z0-9-]+$/.test(uid)) {
    throw new Error("marker uid must be non-empty [A-Za-z0-9-]");
  }
  return `${MARKER_PREFIX}${uid}`;
}

export function wrapRendered(input: {
  rendered: string;
  meta: EnvelopeMeta;
}): string {
  const head = [
    BLOCK_OPEN,
    `compiler: ${input.meta.compiler}`,
    `compiler_version: ${input.meta.compilerVersion}`,
    `compiler_revision: ${input.meta.compilerRevision}`,
    `request_id: ${input.meta.requestId}`,
    `policy_version: ${input.meta.policyVersion}`,
    `bundle_id: ${input.meta.bundleId}`,
    `bundle_hash: ${input.meta.bundleHash}`,
    `bundle_tokens: ${input.meta.bundleTokens}`,
    `marker: ${input.meta.marker}`,
    ENVELOPE_BEGIN,
  ].join("\n");
  // String concatenation (not line-join) around the payload so the
  // embedded render bytes survive untouched, whatever they contain.
  return `${head}\n${input.rendered}${ENVELOPE_END}\n${BLOCK_CLOSE}`;
}

export function parseEnvelope(block: string): EnvelopeMeta | null {
  const lines = block.split("\n");
  if (lines[0] !== BLOCK_OPEN) return null;
  const beginAt = lines.indexOf(ENVELOPE_BEGIN);
  if (beginAt < 0) return null;
  const meta: Record<string, string> = {};
  for (const line of lines.slice(1, beginAt)) {
    const at = line.indexOf(":");
    if (at < 0) continue;
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const required = [
    "compiler",
    "compiler_version",
    "compiler_revision",
    "request_id",
    "policy_version",
    "bundle_id",
    "bundle_hash",
    "bundle_tokens",
    "marker",
  ];
  for (const key of required) {
    if (!meta[key]) return null;
  }
  const tokens = Number(meta["bundle_tokens"]);
  if (!Number.isInteger(tokens)) return null;
  return {
    compiler: meta["compiler"] as string,
    compilerVersion: meta["compiler_version"] as string,
    compilerRevision: meta["compiler_revision"] as string,
    requestId: meta["request_id"] as string,
    policyVersion: meta["policy_version"] as string,
    bundleId: meta["bundle_id"] as string,
    bundleHash: meta["bundle_hash"] as string,
    bundleTokens: tokens,
    marker: meta["marker"] as string,
  };
}

/** Recover the exact rendered bytes embedded in the envelope.
 * Fail-closed: if the payload itself contained the reserved END
 * marker, extraction yields a prefix that will not match the
 * expected render, so reconciliation fails rather than passes. */
export function extractRendered(block: string): string | null {
  const begin = block.indexOf(ENVELOPE_BEGIN);
  if (begin < 0) return null;
  const payloadStart = begin + ENVELOPE_BEGIN.length + 1; // skip one newline
  const end = block.indexOf(ENVELOPE_END, payloadStart);
  if (end < 0 || end < payloadStart) return null;
  return block.slice(payloadStart, end);
}
