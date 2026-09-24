/**
 * Package entrypoint for direct directory discovery.
 *
 * OpenCode resolves a plugin directory through its entry file, so this
 * module re-exports the unified plugin from `./src/index.ts`. It holds
 * no hook logic. The npm/Git package entry is `./src/index.ts` (see
 * `main` in package.json); this root file exists so a cloned working
 * copy also loads as a local plugin directory during development.
 */

export { default } from "./src/index.ts";
