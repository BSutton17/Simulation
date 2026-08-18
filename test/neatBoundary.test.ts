import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findByExtension } from "../scripts/lib/findFiles.mjs";

/**
 * The layering, enforced by reading the source.
 *
 *   neat/      generic algorithm — knows nothing about Elementals
 *   training/  the only layer permitted to know both
 *   ai/        runtime and gameplay controller
 *
 * `neat/` staying clean is not tidiness. It is what makes the XOR benchmark
 * possible: an algorithm that could only be exercised through the game would
 * have to be debugged through hour-long training runs. It is also what lets the
 * eventual distributed trainer reuse the CMA-ES coordinator, which has no
 * notion of a game either.
 */

function sources(dir: string): { name: string; text: string }[] {
  return findByExtension(dir, ".ts").map((path: string) => ({
    name: path.replace(/\\/g, "/").split("/").pop()!,
    text: readFileSync(path, "utf8"),
  }));
}

function importLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^\s*(import|export)\s.*\sfrom\s+"/.test(line));
}

test("neat/ imports nothing from the game engine", () => {
  const offenders: string[] = [];
  for (const file of sources("simulation/src/neat")) {
    for (const line of importLines(file.text)) {
      if (/from\s+"[^"]*\/src\/(match|engine|data)\//.test(line)) {
        offenders.push(`${file.name}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "NEAT reached into the game — it must stay generic");
});

test("neat/ imports nothing from the AI runtime or the rest of the simulator", () => {
  const offenders: string[] = [];
  for (const file of sources("simulation/src/neat")) {
    for (const line of importLines(file.text)) {
      const match = /from\s+"(\.[^"]*)"/.exec(line);
      if (!match) continue;
      const specifier = match[1]!;
      // Only siblings inside neat/ are allowed.
      if (!specifier.startsWith("./")) {
        offenders.push(`${file.name}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "neat/ may only import from itself; the adapter belongs in training/",
  );
});

test("neat/ never calls Math.random", () => {
  // Every structural decision flows through the seeded stream. One unseeded
  // call makes a run unreproducible while still looking perfectly healthy.
  const offenders: string[] = [];
  for (const file of sources("simulation/src/neat")) {
    for (const line of file.text.split("\n")) {
      if (line.trim().startsWith("*") || line.trim().startsWith("//")) continue;
      if (line.includes("Math.random")) offenders.push(`${file.name}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("training/ is the layer that knows both", () => {
  // The converse check: if nothing in training/ imported both, the adapter
  // would have leaked somewhere it should not be.
  const files = sources("simulation/src/training");
  const knowsNeat = files.some((f) => /from\s+"\.\.\/neat\//.test(f.text));
  const knowsGame = files.some((f) => /from\s+"[^"]*\/src\/(match|engine|data)\//.test(f.text));
  const knowsRuntime = files.some((f) => /from\s+"\.\.\/ai\//.test(f.text));
  assert.ok(knowsNeat, "training/ should import NEAT");
  assert.ok(knowsGame, "training/ should import the game");
  assert.ok(knowsRuntime, "training/ should import the AI runtime");
});

test("the AI runtime does not import NEAT", () => {
  // The runtime must stay usable with any network — a hand-built fixture, a
  // random draw, a loaded model — so it cannot depend on the algorithm that
  // happens to produce one.
  const offenders: string[] = [];
  for (const file of sources("simulation/src/ai")) {
    for (const line of importLines(file.text)) {
      if (/from\s+"\.\.\/neat\//.test(line)) offenders.push(`${file.name}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});
