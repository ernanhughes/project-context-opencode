/**
 * Project Context OpenCode integration — single installable package.
 *
 * Two mechanisms, one package, deliberate ordering:
 *
 * - INTERVENTION (`src/runtime/`): mutates the assembled model context
 *   if and only if PROJECT_CONTEXT_RUNTIME=inject. Disabled by default.
 * - OBSERVER (`src/observer/`): copies the assembled model context out
 *   to a local spool if and only if PROJECT_CONTEXT_CAPTURE=1.
 *   Read-only; never mutates the event. Disabled by default.
 *
 * Ordering: the runtime hook is registered BEFORE the observer hooks,
 * in this setup function. OpenCode runs hooks in registration order,
 * so the observer captures the post-intervention context. The combined
 * tests pin this: with runtime enabled, the observer record must
 * contain the injected marker exactly once; with runtime disabled,
 * the observer must capture the untouched context.
 *
 * Observation boundary: this observes the OpenCode model-context hook
 * boundary, NOT the byte-for-byte provider HTTP request. Provider
 * lowering happens after this hook; provider-added material, wire
 * representation, and cache decisions remain unobserved.
 */

import { Plugin } from "@opencode/plugin";
import { assertCompatibleVersion, assertHookApi } from "./observer/capture.ts";
import { registerObserverHooks } from "./observer/hooks.ts";
import { registerRuntimeHook } from "./runtime/hook.ts";

export const PLUGIN_ID = "project-context";

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    assertCompatibleVersion(
      (ctx as unknown as { app: { version: string } }).app.version,
    );
    assertHookApi(ctx);
    // Deliberate order, not directory-name luck: intervention first,
    // observation second, so the observer sees the final context.
    await registerRuntimeHook(ctx);
    await registerObserverHooks(ctx);
  },
});
