import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
// Plain ESM helper, shared with scripts/test.mjs so discovery cannot drift
// between the runner and the guard that checks it.
import { findByExtension } from "../scripts/lib/findFiles.mjs";

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

/**
 * Whether a specifier names a Node builtin.
 *
 * The `node:` prefix is definitionally a builtin, and testing the prefix rather
 * than consulting `builtinModules` matters: `node:test` is absent from
 * `builtinModules` on Node 20 but present on Node 24, because it is reachable
 * only via the prefix. A membership check therefore passes on the development
 * machine and then condemns every single test file on Kaggle for importing a
 * package that does not exist.
 */
function isBuiltin(spec: string): boolean {
  return spec.startsWith("node:") || BUILTIN.has(spec);
}

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
    ...findByExtension("src", ".ts"),
    ...findByExtension("simulation/src", ".ts", ".mjs"),
    ...findByExtension("test", ".ts"),
    ...findByExtension("scripts", ".mjs"),
  ] as string[];
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
      if (isBuiltin(spec)) continue;
      const name = packageOf(spec);
      if (isBuiltin(name) || AVAILABLE.has(name)) continue;
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
  const stray = (findByExtension("src", ".ts") as string[]).filter((f) => !ALLOWED_DIRS.test(f));
  assert.deepEqual(stray, [], "unexpected engine directories were exported");
});

/**
 * The version floor for Node APIs, loaded from data rather than declared here.
 *
 * The check below scans every .ts and .mjs file for these patterns, so a
 * denylist written in TypeScript would match itself and report the guard as its
 * own violation. JSON is not scanned.
 *
 * The runner is developed on Node 24 and deployed to Kaggle's Node 20.19, so
 * "it works on my machine" proves very little. `fs.globSync` arrived in Node 22
 * and was used by both the test runner and this file; on Kaggle it threw at
 * module load, before a single test ran, with a message naming neither the
 * version nor the cause.
 */
const API_FLOOR = JSON.parse(
  readFileSync("scripts/lib/nodeApiFloor.json", "utf8"),
) as { apis: { api: string; since: string; pattern: string }[] };

/** Lowest Node version package.json promises to run on. */
function declaredMinimum(): [number, number] {
  const range = (pkg as { engines?: { node?: string } }).engines?.node ?? "";
  const m = /(\d+)(?:\.(\d+))?/.exec(range);
  assert.ok(m, `package.json engines.node is missing or unparseable: "${range}"`);
  return [Number(m[1]), Number(m[2] ?? 0)];
}

test("no source file uses an API newer than the declared minimum Node version", () => {
  const [minMajor, minMinor] = declaredMinimum();
  const offences: string[] = [];

  for (const file of sourceFiles()) {
    const text = stripComments(readFileSync(file, "utf8"));
    for (const entry of API_FLOOR.apis) {
      const [major, minor] = entry.since.split(".").map(Number) as [number, number];
      const newerThanFloor = major > minMajor || (major === minMajor && minor > minMinor);
      if (!newerThanFloor) continue;
      if (new RegExp(entry.pattern).test(text)) {
        offences.push(
          `${file} uses ${entry.api} (Node ${major}.${minor}+, floor is ${minMajor}.${minMinor})`,
        );
      }
    }
  }
  assert.ok(API_FLOOR.apis.length > 0, "the API floor list is empty — the guard would pass vacuously");

  assert.deepEqual(
    offences,
    [],
    "these would throw on the oldest supported Node, which is what Kaggle runs:\n  " +
      offences.join("\n  "),
  );
});

test("the declared Node floor is old enough for the deployment target", () => {
  // Kaggle's image is the constraint that matters. Raising the floor above it
  // would make the repository unrunnable there while every local check passed.
  const [major] = declaredMinimum();
  assert.ok(major <= 20, `engines.node requires Node ${major}, but Kaggle runs Node 20`);
});

test("no test references a fixture that was not exported", () => {
  // config.test.ts and errorHandling.test.ts pointed at test/fixtures/*.ts by
  // STRING, not by import, so no dependency analysis could see it and the
  // export left the fixtures behind. The tests then failed on Kaggle for a
  // reason that looked nothing like the actual cause.
  const dangling: string[] = [];
  for (const file of findByExtension("test", ".ts") as string[]) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/["'](test\/[a-zA-Z0-9_./-]+\.(?:ts|json))["']/g)) {
      const target = m[1]!;
      if (!existsSync(target)) dangling.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(dangling, [], "referenced files are missing from this repository:\n  " + dangling.join("\n  "));
});
