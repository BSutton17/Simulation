import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findByExtension } from "../scripts/lib/findFiles.mjs";
import { FORBIDDEN_FIELDS } from "../simulation/src/ai/index.js";

/**
 * The information boundary, enforced structurally.
 *
 * This is the layer that catches what types and behavioural tests cannot: the
 * next person wiring `match` into the encoder "just for one feature". It is
 * modelled on `test/boundary.test.ts`, which already guards the repository's
 * export boundary the same way — by reading the source and asserting on its
 * imports rather than trusting review.
 *
 * The rule: reading the simulation is a privilege held by exactly two modules,
 * and it is visible in the import graph. Everything downstream of
 * `knowledge.ts` consumes `PlayerKnowledge` and has no route to the engine at
 * all, so a leak has to be introduced HERE, deliberately, and this test fails
 * when it is.
 */

const AI_DIR = "simulation/src/ai";

/** Modules genuinely required to touch the simulation, and why. */
const ALLOWED = new Map([
  ["knowledge.ts", "applies the visibility rule — the one authorized reader"],
  ["controller.ts", "issues engine commands — the one authorized writer"],
  // baseline.ts is the pre-existing heuristic factory, which reaches the engine
  // only through personality.ts; it is listed so the exemption is deliberate.
  ["baseline.ts", "re-exports the heuristic controller, unchanged"],
]);

/** Import specifiers that reach authoritative game state. */
const ENGINE_IMPORT = /from\s+"[^"]*\/src\/(match|engine)\//;

function aiSources(): { name: string; path: string; text: string }[] {
  return findByExtension(AI_DIR, ".ts").map((path: string) => ({
    name: path.replace(/\\/g, "/").split("/").pop()!,
    path,
    text: readFileSync(path, "utf8"),
  }));
}

test("only the authorized modules import match or engine state", () => {
  const offenders: string[] = [];
  for (const file of aiSources()) {
    if (ALLOWED.has(file.name)) continue;
    for (const line of file.text.split("\n")) {
      if (ENGINE_IMPORT.test(line)) {
        offenders.push(`${file.name}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a module outside the authorized set reached into the simulation. " +
      "If it genuinely needs state, it belongs in knowledge.ts instead — " +
      "widening this list defeats the boundary it exists to enforce.",
  );
});

test("the authorized set stays small and deliberate", () => {
  // A guard on the guard: silently adding names to ALLOWED would make the test
  // above pass while the boundary dissolves.
  assert.equal(ALLOWED.size, 3, "the authorized reader/writer set changed");
  assert.ok(ALLOWED.has("knowledge.ts"));
  assert.ok(ALLOWED.has("controller.ts"));
});

test("no module in ai/ names a forbidden field", () => {
  // Enemy gold, cooldowns, upgrades and meters have no representation in
  // PlayerKnowledge. This catches someone reaching for them through a raw
  // PlayerState that slipped in via an allowed module.
  const forbidden = FORBIDDEN_FIELDS.map((f) => f.split(".")[1]!).filter(
    (f) => f !== "modifiers" && f !== "attackJournal",
  );
  const offenders: string[] = [];
  for (const file of aiSources()) {
    // knowledge.ts legitimately mentions these while deciding NOT to expose
    // them, and its comments name them for the reader.
    if (file.name === "knowledge.ts" || file.name === "visibility.ts") continue;
    for (const field of forbidden) {
      const pattern = new RegExp(`enemy\\.${field}\\b|\\.economy\\.currency\\b`);
      for (const line of file.text.split("\n")) {
        if (line.trim().startsWith("*") || line.trim().startsWith("//")) continue;
        if (pattern.test(line)) offenders.push(`${file.name}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("visibility.ts depends on nothing", () => {
  // The specification of the boundary must be readable on its own. A table that
  // imports the engine is a table that can be computed, and a computed rule is
  // one nobody reviews.
  const file = aiSources().find((f) => f.name === "visibility.ts");
  assert.ok(file, "visibility.ts is missing");
  const imports = file.text.split("\n").filter((l) => /^\s*import\s/.test(l));
  assert.deepEqual(imports, [], "visibility.ts must remain dependency-free");
});
