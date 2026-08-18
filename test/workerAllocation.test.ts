import { test } from "node:test";
import assert from "node:assert/strict";
import { identityMismatches, type ExperimentIdentity } from "../simulation/src/distributed/protocol.js";
import { assertWorkerMatches } from "../simulation/src/distributed/worker.js";
import { localIdentity } from "../simulation/src/distributed/identity.js";

/**
 * A worker must adopt the experiment's allocation, not guess it.
 *
 * The live failure: a coordinator created a v2 experiment, a freshly cloned
 * worker computed `localIdentity()` — which defaults to v1, because nothing
 * had told it otherwise — and `assertWorkerMatches` refused it for a field the
 * worker had no way to know.
 *
 * The mistake was putting a RUN setting into a BUILD fingerprint. Every other
 * field in ExperimentIdentity answers "is this worker the same code as the
 * coordinator?", and a worker can only be wrong about those by being built from
 * a different commit. Allocation is chosen by the coordinator per experiment
 * and read from Supabase at startup.
 */

const base = (): ExperimentIdentity => ({
  engineSha: "abc123", schemaVersion: "v2", catalogHash: "cat-1",
  seed: 20260813, populationSize: 19, sigma: 0.2, scope: "expanded",
  fitnessVersion: "f1", weightsName: "designerPriority", allocation: "v1",
});

function clientFor(remote: ExperimentIdentity) {
  return { experimentIdentity: async () => remote } as never;
}

test("a v1-default worker is accepted by a v2 experiment", async () => {
  // The exact live failure. A fresh clone defaults to v1; the experiment is v2;
  // the worker is correctly built and must be allowed to work.
  const worker = { ...base(), allocation: "v1" };
  const experiment = { ...base(), allocation: "v2" };
  assert.deepEqual(identityMismatches(worker, experiment), []);
  await assertWorkerMatches(clientFor(experiment), "exp-1", worker);
});

test("localIdentity's default no longer blocks a v2 experiment", async () => {
  // Proves it against the real identity the launcher builds, not a fixture.
  const worker = localIdentity();
  assert.equal(worker.allocation, "v1", "the default really is v1");
  await assertWorkerMatches(clientFor({ ...worker, allocation: "v2" }), "exp-1", worker);
});

test("a genuine build difference is still refused, and named", async () => {
  // The check must not have been weakened. Every non-allocation field still
  // refuses, because those can only differ by being a different commit.
  for (const field of ["engineSha", "schemaVersion", "catalogHash", "seed",
                       "populationSize", "sigma", "scope", "fitnessVersion", "weightsName"] as const) {
    const experiment = { ...base() } as Record<string, unknown>;
    experiment[field] = typeof experiment[field] === "number"
      ? (experiment[field] as number) + 1 : "different";
    const mismatches = identityMismatches(base(), experiment as ExperimentIdentity);
    assert.equal(mismatches.length, 1, `${field} must still be compared`);
    assert.match(mismatches[0]!, new RegExp(field));
    await assert.rejects(
      () => assertWorkerMatches(clientFor(experiment as ExperimentIdentity), "exp-1", base()),
      /does not match experiment/,
      `${field} drift must still refuse`,
    );
  }
});

test("an allocation this build cannot implement is refused loudly", async () => {
  // The hazard that actually matters. Evaluating on the wrong match-budget
  // split returns plausible scores measured on a different instrument, and
  // nothing downstream would notice — so guessing is worse than stopping.
  const experiment = { ...base(), allocation: "v9" };
  await assert.rejects(
    () => assertWorkerMatches(clientFor(experiment), "exp-1", base()),
    /does not implement/,
  );
});

test("a restarted worker re-derives the allocation from the experiment", async () => {
  // A Kaggle worker restart is a fresh clone with no memory. It must reach the
  // same answer purely from the experiment row, which is what makes restart
  // require nothing but re-running the notebook.
  // Derived from the real local identity, so the only difference under test is
  // the allocation — not engineSha, which a fixture would get wrong.
  const experiment = { ...localIdentity(), allocation: "v2" };
  for (let restart = 0; restart < 3; restart++) {
    const freshClone = localIdentity();
    assert.equal(freshClone.allocation, "v1", "a fresh clone always starts at the default");
    await assertWorkerMatches(clientFor(experiment), "exp-1", freshClone);
  }
});
