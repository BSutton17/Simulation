import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { captureProvenance } from "../simulation/src/evaluation/provenance.js";
import { identityMismatches, type CheckpointIdentity } from "../simulation/src/search/index.js";

/**
 * Engine identity must describe the ENGINE, not this repository.
 *
 * A balance reading is only valid for the engine that produced it, so the
 * checkpoint guard refuses to resume across an engine change. That guard is
 * only as good as the value it is fed.
 *
 * It was fed the wrong one. `tsc` emits JavaScript and nothing else, so
 * `engine-source.json` — read at runtime rather than imported — never reached
 * `dist/`. Under tsx provenance found the marker; under the compiled build it
 * found nothing and fell back to `git rev-parse HEAD`, stamping every reading
 * with the SIMULATION repository's commit.
 *
 * The result was that any commit here at all invalidated an in-flight
 * multi-session run. It cost a production session at generation 1, and it was
 * hard to spot because the guard's refusal looked exactly like the guard
 * working. These tests exist so it cannot come back.
 */

const MARKER_PATH = "simulation/engine-source.json";

function marker(): { engineSha: string; engineDirty: boolean } {
  assert.ok(existsSync(MARKER_PATH), `${MARKER_PATH} is missing — the engine has no recorded identity`);
  return JSON.parse(readFileSync(MARKER_PATH, "utf8"));
}

function repoHead(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

test("provenance reports the vendored engine, not this repository", () => {
  const { engineSha } = marker();
  const provenance = captureProvenance({
    balanceConfigId: "provenance-test",
    strategyPopulationVersion: "v1",
  });

  assert.equal(provenance.engineSha, engineSha, "provenance ignored the vendored marker");

  // The specific failure: falling back to this repository's own commit.
  assert.notEqual(
    provenance.engineSha,
    repoHead(),
    "engine identity is tracking the Simulation repository's HEAD, so every " +
      "commit here would invalidate an in-flight run",
  );
});

test("an unrelated commit here cannot change the engine identity", () => {
  // Stated as a property rather than by making a commit: the reported identity
  // is a function of the marker file alone, so anything that does not touch the
  // marker cannot move it. The previous behaviour failed this by construction —
  // it was a function of HEAD.
  const before = captureProvenance({ balanceConfigId: "a", strategyPopulationVersion: "v1" });
  const after = captureProvenance({ balanceConfigId: "b", strategyPopulationVersion: "v1" });

  assert.equal(before.engineSha, after.engineSha);
  assert.equal(before.engineSha, marker().engineSha);
  assert.equal(before.engineDirty, marker().engineDirty);
});

test("the compiled build carries the marker it reads at runtime", () => {
  // dist/ is gitignored, so a fresh clone has none until `npm run build`. When
  // it does exist, the asset must be beside the emitted modules — its absence
  // there is the exact bug this file is about.
  if (!existsSync("dist")) return;

  assert.ok(
    existsSync("dist/simulation/engine-source.json"),
    "dist/ was built without engine-source.json — compiled runs would fall back " +
      "to this repository's commit. Check `npm run build` still runs scripts/copyAssets.mjs.",
  );

  const built = JSON.parse(readFileSync("dist/simulation/engine-source.json", "utf8"));
  assert.equal(built.engineSha, marker().engineSha, "the copied marker is stale");
});

test("the build definition copies runtime assets", () => {
  // Guards the case where dist/ does not exist to be inspected: if the build
  // stops copying assets, this fails even on a clean checkout.
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.match(
    pkg.scripts.build ?? "",
    /copyAssets/,
    "the build no longer copies runtime assets into dist",
  );
  assert.ok(existsSync("scripts/copyAssets.mjs"), "the asset copier is missing");
  assert.match(
    readFileSync("scripts/copyAssets.mjs", "utf8"),
    /engine-source\.json/,
    "the asset copier no longer handles the engine identity marker",
  );
});

test("a genuine engine change still refuses to resume", () => {
  // The fix must not weaken the guard. Same identity resumes; a different
  // engine does not.
  const base: CheckpointIdentity = {
    engineSha: marker().engineSha,
    engineDirty: false,
    schemaVersion: "v1",
    catalogHash: "f8f4ea6b",
    fitnessVersion: "v1",
    optimizerVersion: "v1",
    weightsName: "designerPriority",
    seed: 20260813,
    generations: 20,
    populationSize: 8,
    sigma: 0.2,
    promote: 1,
    tiersHash: "bbcd40d2",
  };

  assert.deepEqual(identityMismatches(base, base), [], "an identical engine should resume");

  const upstreamMoved = { ...base, engineSha: "0000000000000000000000000000000000000000" };
  const mismatches = identityMismatches(base, upstreamMoved);
  assert.ok(mismatches.some((m) => m.startsWith("engineSha")), "a real engine change must be refused");

  // A dirty working tree is a different engine too — the SHA alone does not
  // identify the code that ran.
  assert.ok(
    identityMismatches(base, { ...base, engineDirty: true }).some((m) => m.startsWith("engineDirty")),
    "an uncommitted engine change must be refused",
  );
});
