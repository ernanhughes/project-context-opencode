/**
 * Entrypoint and package-shape tests (node:test, no test framework).
 *
 * 1. The root `index.ts` is a pure re-export of the unified plugin
 *    (no hook logic may move into the entrypoint).
 * 2. `src/index.ts` default-exports one `Plugin.define` plugin with
 *    the unified id and registers the runtime hook before the
 *    observer hooks (deliberate ordering lives in code).
 * 3. The observer and runtime modules stay dependency-separated:
 *    the observer never imports runtime code and vice versa.
 */

import { equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(testsDir, "..");

const rootIndex = readFileSync(join(rootDir, "index.ts"), "utf-8");
const srcIndex = readFileSync(join(rootDir, "src", "index.ts"), "utf-8");

{
  // The entrypoint is a pure re-export: no hook logic, no block logic.
  equal(
    rootIndex.includes('from "./src/index.ts"'),
    true,
    "root index.ts must import from ./src/index.ts",
  );
  match(rootIndex, /export\s*\{\s*default\s*\}/);
  equal(rootIndex.includes("session.hook"), false);
  equal(rootIndex.includes("event.system"), false);
}

{
  // One unified plugin; ordering is established in setup source order.
  match(srcIndex, /export\s+default\s+Plugin\.define\(/);
  match(srcIndex, /id:\s*PLUGIN_ID/);
  const runtimeAt = srcIndex.indexOf("await registerRuntimeHook");
  const observerAt = srcIndex.indexOf("await registerObserverHooks");
  ok(runtimeAt >= 0 && observerAt >= 0, "both mechanisms registered");
  ok(
    runtimeAt < observerAt,
    "runtime registration must precede observer registration",
  );
}

{
  // Module separation: observer code never touches runtime modules.
  const observerFiles = ["capture.ts", "hooks.ts", "schema.ts", "sequence.ts"];
  for (const file of observerFiles) {
    const blob = readFileSync(join(rootDir, "src", "observer", file), "utf-8");
    equal(blob.includes("runtime/"), false, `${file} must not import runtime`);
    equal(
      blob.includes("PROJECT_CONTEXT_RUNTIME"),
      false,
      `${file} must not reference runtime env`,
    );
  }
  const runtimeFiles = ["hook.ts", "blocks.ts", "trace.ts"];
  for (const file of runtimeFiles) {
    const blob = readFileSync(join(rootDir, "src", "runtime", file), "utf-8");
    equal(
      blob.includes("observer/"),
      false,
      `${file} must not import observer`,
    );
    equal(
      blob.includes("PROJECT_CONTEXT_CAPTURE"),
      false,
      `${file} must not reference observer env`,
    );
  }
}
