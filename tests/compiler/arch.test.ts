/**
 * Architecture boundary tests for the composition layer:
 * - composition may import project-context-compiler/core
 * - runtime must NOT implement compiler admission
 * - observer must NOT import the compiler
 * - compiler sources must NOT be copied into this repo
 */

import { equal, ok } from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function srcFiles(dir: string): string[] {
  return readdirSync(join(root, "src", dir)).filter((f) => f.endsWith(".ts"));
}

test("no vendored compiler sources", () => {
  for (const name of [
    "engine.ts",
    "domain.ts",
    "policy.ts",
    "bundle.ts",
    "render.ts",
  ]) {
    equal(existsSync(join(root, "src", "compiler", name)), false, name);
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
    dependencies: Record<string, string>;
  };
  ok(pkg.dependencies["project-context-compiler"], "declared dependency");
});

test("composition imports only the canonical core entry", () => {
  for (const file of srcFiles("compiler")) {
    const text = readFileSync(join(root, "src", "compiler", file), "utf-8");
    ok(!text.includes("project-context-compiler/src/"), `${file}: deep import`);
    ok(
      !text.includes("project-context-compiler/dist/"),
      `${file}: deep import`,
    );
  }
});

test("composition contains no admission logic", () => {
  const forbidden = [
    "admitBand",
    "admitGreedy",
    "closeOutAlternatives",
    "marginalFor",
    "hardGate",
    "effectiveBand",
    "REQUIRED_INELIGIBLE",
    "UNSATISFIED_DEPENDENCY",
  ];
  for (const file of srcFiles("compiler")) {
    const text = readFileSync(join(root, "src", "compiler", file), "utf-8");
    for (const token of forbidden) {
      equal(text.includes(token), false, `${file} contains ${token}`);
    }
  }
});

test("runtime implements no admission and imports no compiler", () => {
  for (const file of srcFiles("runtime")) {
    const text = readFileSync(join(root, "src", "runtime", file), "utf-8");
    ok(!text.includes("project-context-compiler"), `${file}`);
    ok(!text.includes("compileContext"), `${file}`);
  }
});

test("observer stays independent of the compiler", () => {
  for (const file of srcFiles("observer")) {
    const text = readFileSync(join(root, "src", "observer", file), "utf-8");
    ok(!text.includes("project-context-compiler"), `${file}`);
    ok(!text.includes("compileContext"), `${file}`);
  }
});
