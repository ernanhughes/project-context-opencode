/**
 * Pure runtime-block helpers (no OpenCode dependency).
 *
 * The runtime block is one system text block delimited by stable
 * markers. Helpers detect, locate, and compare blocks so that
 * injection is idempotent and conflicts fail loudly instead of
 * stacking duplicate payloads.
 */

export const BLOCK_OPEN = "[CONTEXT RUNTIME]";
export const BLOCK_CLOSE = "[/CONTEXT RUNTIME]";

export function systemTexts(system: unknown): string[] {
  if (!Array.isArray(system)) return [];
  const out: string[] = [];
  for (const block of system) {
    if (
      typeof block === "object" &&
      block !== null &&
      typeof (block as Record<string, unknown>)["text"] === "string"
    ) {
      out.push((block as Record<string, unknown>)["text"] as string);
    }
  }
  return out;
}

/** Indices of system blocks carrying a runtime marker. */
export function findRuntimeBlocks(system: unknown): number[] {
  const hits: number[] = [];
  const texts = systemTexts(system);
  for (let i = 0; i < texts.length; i++) {
    if (texts[i].includes(BLOCK_OPEN)) hits.push(i);
  }
  return hits;
}

/** Index of the block byte-equal to the intended text, or -1. */
export function findExactBlock(system: unknown, text: string): number {
  const texts = systemTexts(system);
  for (let i = 0; i < texts.length; i++) {
    if (texts[i] === text) return i;
  }
  return -1;
}
