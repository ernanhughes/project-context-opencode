/**
 * Runtime block helper tests (node:test, no test framework).
 * Run: npm test (requires devDependencies; hook shape unverified live).
 *
 * 1. marker scan finds marked blocks and ignores plain ones
 * 2. exact search matches byte-identical text only
 * 3. non-array system yields no blocks
 * 4. non-text blocks are skipped
 */

import { deepEqual, equal } from "node:assert/strict";
import {
  findExactBlock,
  findRuntimeBlocks,
  systemTexts,
} from "../../src/runtime/blocks.ts";

{
  const system = [
    { type: "text", text: "You are a test assistant." },
    { type: "text", text: "[CONTEXT RUNTIME]\n[X]\nbody\n[/CONTEXT RUNTIME]" },
    { type: "text", text: "Follow project rules." },
  ];
  deepEqual(findRuntimeBlocks(system), [1]);
  equal(
    findExactBlock(system, "[CONTEXT RUNTIME]\n[X]\nbody\n[/CONTEXT RUNTIME]"),
    1,
  );
  equal(
    findExactBlock(system, "[CONTEXT RUNTIME]\n[Y]\nbody\n[/CONTEXT RUNTIME]"),
    -1,
  );
}

{
  deepEqual(findRuntimeBlocks(null), []);
  deepEqual(findRuntimeBlocks("system"), []);
  deepEqual(
    systemTexts([
      { type: "tool", id: 7 },
      { type: "text", text: "hi" },
    ]),
    ["hi"],
  );
  deepEqual(findRuntimeBlocks([]), []);
}
