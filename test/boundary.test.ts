import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, globSync } from "node:fs";
import { builtinModules } from "node:module";
import { sep } from "node:path";

/**
 * The architectural boundary of this repository, enforced.
 *
 * This repo contains the simulator plus only the engine, data and match modules
 * it actually imports. It has no transport layer, no Socket.IO and no
 * production server, and it must stay that way: the whole reason it can run on
 * a bare cloud runner is that it needs nothing but Node.
 *
 * That property is easy to break by accident and expensive to discover late — a
 * single import added upstream and carried across by the next export turns into
 * a Kaggle run that dies at module load, an hour into a queue. These tests fail
 * here instead, in under a second.
 */

const ALLOWED_DIRS = /^(src\/(data|engine|match)\/|simulation\/|test\/|scripts\/)/;

const FORBIDDEN_PACKAGES = ["socket.io", "socket.io-client", "express", "ws"];

const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const AVAILABLE = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);

/** Comments are stripped first: prose that happens to read like an import
 *  ("decide what to run" from "run it") is not an import. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function specifiersOf(text: string): string[] {
  const src = stripComments(text);
  const out: string[] = [];
  const patterns = [
    /^[ \t]*import\s[^;]*?\sfrom\s*["']([^"']+)["']/gm,
    /^[ \t]*import\s*["']([^"']+)["']/gm,
    /^[ \t]*export\s[^;]*?\sfrom\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) out.push(m[1]!);
  }
  return out;
}

function sourceFiles(): string[] {
  return [
    ...globSync("src/**/*.ts"),
    ...globSync("simulation/src/**/*.{ts,mjs}"),
    ...globSync("test/**/*.ts"),
    ...globSync("scripts/**/*.mjs"),
  ].map((f) => f.split(sep).join("/"));
}

const packageOf = (spec: string): string =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;

test("nothing imports the transport layer or a server package", () => {
  const offences: string[] = [];
  for (const file of sourceFiles()) {
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      if (spec.includes("src/net")) offences.push(`${file} -> ${spec}`);
      if (FORBIDDEN_PACKAGES.includes(packageOf(spec))) offences.push(`${file} -> ${spec}`);
    }
  }
  assert.deepEqual(
    offences,
    [],
    "this repository has no transport layer; these imports cannot resolve here:\n  " +
      offences.join("\n  "),
  );
});

test("every bare import is satisfied by package.json", () => {
  const missing: string[] = [];
  for (const file of sourceFiles()) {
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) continue;
      if (BUILTIN.has(spec)) continue;
      const name = packageOf(spec);
      if (BUILTIN.has(name) || AVAILABLE.has(name)) continue;
      missing.push(`${file} -> ${name}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    "imports with no corresponding dependency — these fail at load on a clean clone:\n  " +
      missing.join("\n  "),
  );
});

test("the engine that came across stays inside data, engine and match", () => {
  const stray = globSync("src/**/*.ts")
    .map((f) => f.split(sep).join("/"))
    .filter((f) => !ALLOWED_DIRS.test(f));
  assert.deepEqual(stray, [], "unexpected engine directories were exported");
});

test("no test references a fixture that was not exported", () => {
  // config.test.ts and errorHandling.test.ts pointed at test/fixtures/*.ts by
  // STRING, not by import, so no dependency analysis could see it and the
  // export left the fixtures behind. The tests then failed on Kaggle for a
  // reason that looked nothing like the actual cause.
  const dangling: string[] = [];
  for (const file of globSync("test/**/*.ts").map((f) => f.split(sep).join("/"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/["'](test\/[a-zA-Z0-9_./-]+\.(?:ts|json))["']/g)) {
      const target = m[1]!;
      if (globSync(target).length === 0) dangling.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(dangling, [], "referenced files are missing from this repository:\n  " + dangling.join("\n  "));
});
