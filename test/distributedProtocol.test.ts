import { test } from "node:test";
import assert from "node:assert/strict";
import {
  identityMismatches, jobsForGeneration, orderResults, makeWorkerId, backoffMs,
  ProtocolError, type ExperimentIdentity, type ResultRecord,
} from "../simulation/src/distributed/protocol.js";
import { identityFingerprint } from "../simulation/src/distributed/client.js";
import { buildSchema, makeCandidate, baseVector, vectorToParameters,
  type Candidate, type CandidateEvaluation } from "../simulation/src/search/index.js";

/**
 * The distributed protocol's correctness properties.
 *
 * Distribution has one way to invalidate the science: pairing a score with the
 * wrong candidate. `cma.tell` reads that correspondence from array position
 * alone, so a mispairing completes without error and produces a run that looks
 * healthy and means nothing. These tests cover each way that could happen.
 */

const schema = buildSchema({ scope: "expanded" });

function candidates(count: number): Candidate[] {
  const base = baseVector(schema);
  return Array.from({ length: count }, (_, index) => {
    const vector = base.map((x, i) => Math.min(1, Math.max(0, x + (index + 1) * 0.01 * ((i % 3) + 1))));
    return makeCandidate({
      schema, vector, parameters: vectorToParameters(schema, vector),
      generation: 0, index, optimizer: "cmaes",
    });
  });
}

const resultFor = (c: Candidate, index: number, generation = 0): ResultRecord => ({
  jobId: `job-${index}`, generationNumber: generation, candidateIndex: index,
  candidateHash: c.hash, fitness: { searchObjective: 0.5 + index / 100 },
  failure: null, durationMs: 1000, matches: 1656,
});

const toEvaluation = (candidate: Candidate): CandidateEvaluation => ({
  candidate, tier: "screen", fitness: null, failure: null, durationMs: 1, cached: false,
});

const IDENTITY: ExperimentIdentity = {
  engineSha: "36d9ce3eb0fc106c7b0a5ec8c00bcf06dee9431f",
  schemaVersion: "v2", catalogHash: "f8f4ea6b", seed: 20260813,
  populationSize: 19, sigma: 0.2, scope: "expanded",
  fitnessVersion: "v1", weightsName: "designerPriority",
};

test("a worker with a different build is rejected, and told which field", () => {
  assert.deepEqual(identityMismatches(IDENTITY, IDENTITY), []);
  for (const [field, value] of [
    ["engineSha", "other"], ["schemaVersion", "v1"], ["catalogHash", "aaaa"],
    ["seed", 1], ["populationSize", 8], ["sigma", 0.3],
    ["scope", "curated"], ["fitnessVersion", "v2"], ["weightsName", "equal"],
  ] as const) {
    const mismatches = identityMismatches({ ...IDENTITY, [field]: value }, IDENTITY);
    assert.equal(mismatches.length, 1, `${field} was not checked`);
    assert.match(mismatches[0]!, new RegExp(`^${field}:`), "the message should name the field");
  }
});

test("publishing a generation is repeatable", () => {
  // A coordinator restart must produce the identical job set, so the table's
  // uniqueness constraint de-duplicates rather than the run forking.
  const pop = candidates(5);
  const a = jobsForGeneration("exp-1", 3, pop, "screen");
  const b = jobsForGeneration("exp-1", 3, pop, "screen");
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((j) => j.candidateIndex), [0, 1, 2, 3, 4]);
  assert.ok(a.every((j) => j.generationNumber === 3 && j.tier === "screen"));
});

test("results are restored to candidate order however they arrive", () => {
  const pop = candidates(6);
  const arrived = pop.map((c, i) => resultFor(c, i));
  // Completion order is arbitrary — fast candidates finish first.
  const shuffled = [arrived[4]!, arrived[0]!, arrived[3]!, arrived[5]!, arrived[1]!, arrived[2]!];

  const ordered = orderResults(pop, shuffled, 0, toEvaluation);
  assert.deepEqual(ordered.map((e) => e.candidate.hash), pop.map((c) => c.hash));
});

test("a missing result stops the generation rather than shrinking it", () => {
  // Without this, tell() would receive a short population and the strategy
  // would learn from a subset while reporting success.
  const pop = candidates(5);
  const partial = pop.slice(0, 4).map((c, i) => resultFor(c, i));
  assert.throws(
    () => orderResults(pop, partial, 0, toEvaluation),
    (e: Error) => e instanceof ProtocolError && /incomplete.*candidate\(s\) 4/.test(e.message),
  );
});

test("a result for the wrong candidate is refused", () => {
  const pop = candidates(4);
  const results = pop.map((c, i) => resultFor(c, i));
  results[2]!.candidateHash = "deadbeef"; // answered a different candidate
  assert.throws(
    () => orderResults(pop, results, 0, toEvaluation),
    (e: Error) => e instanceof ProtocolError && /candidate 2 hash mismatch/.test(e.message),
  );
});

test("a duplicate submission is harmless, but two different jobs are not", () => {
  const pop = candidates(3);
  const results = pop.map((c, i) => resultFor(c, i));

  // The same job answered twice — expected after a lease reclaim, and both
  // answers agree because evaluation is deterministic.
  const withDuplicate = [...results, { ...results[1]! }];
  assert.doesNotThrow(() => orderResults(pop, withDuplicate, 0, toEvaluation));

  // Two DIFFERENT jobs claiming the same candidate means the queue is broken.
  const conflicting = [...results, { ...results[1]!, jobId: "job-other" }];
  assert.throws(
    () => orderResults(pop, conflicting, 0, toEvaluation),
    (e: Error) => e instanceof ProtocolError && /two results for candidate 1/.test(e.message),
  );
});

test("a late result from an earlier generation cannot leak forward", () => {
  // A job reclaimed near a generation boundary can produce an answer after the
  // coordinator has moved on. It must not be counted toward the new one.
  const pop = candidates(3);
  const results = pop.map((c, i) => resultFor(c, i, 1));
  results[0]!.generationNumber = 0;
  assert.throws(
    () => orderResults(pop, results, 1, toEvaluation),
    (e: Error) => e instanceof ProtocolError && /another generation/.test(e.message),
  );
});

test("worker ids do not collide", () => {
  // Two Kaggle notebooks from the same template share a hostname and can share
  // a pid; colliding ids would corrupt each other's lease bookkeeping.
  const ids = new Set(Array.from({ length: 500 }, () => makeWorkerId("kaggle")));
  assert.equal(ids.size, 500);
  assert.match([...ids][0]!, /^kaggle-\d+-[a-z0-9]+-[a-z0-9]+$/);
});

test("polling backs off when there is no work, and recovers immediately", () => {
  assert.equal(backoffMs(0), 5_000);
  assert.ok(backoffMs(3) > backoffMs(1), "should grow while idle");
  assert.equal(backoffMs(50), 60_000, "should stop at the ceiling");
  // Evaluations take minutes; a one-second poll would spend the request budget
  // for nothing.
  assert.ok(backoffMs(0) >= 5_000, "the floor should not be aggressive");
});

/**
 * A name is not an identity.
 *
 * `ensureExperiment` looked up by name alone and returned whatever it found, so
 * a coordinator on a new ability catalog resumed a run built on the old one.
 * The contradiction surfaced later, in a WORKER refusing its first batch, by
 * which point the coordinator had already adopted the old run's generation
 * counter. These pin the fingerprint that keeps the two apart.
 */
test("the fingerprint changes when the game configuration changes", () => {
  const base: ExperimentIdentity = {
    engineSha: "abc123", schemaVersion: "v3", catalogHash: "f8f4ea6b", seed: 20260813,
    populationSize: 8, sigma: 0.2, scope: "full", fitnessVersion: "v2",
    weightsName: "default", allocation: "v2",
  };
  const same = identityFingerprint(base);
  assert.equal(identityFingerprint({ ...base }), same, "identical identities must agree");

  // The exact failure that started this: the catalog moved underneath the name.
  assert.notEqual(
    identityFingerprint({ ...base, catalogHash: "e1370e21" }),
    same,
    "a new ability catalog must not share an experiment with the old one",
  );
  for (const field of ["engineSha", "schemaVersion", "scope", "fitnessVersion", "weightsName", "allocation"] as const) {
    assert.notEqual(
      identityFingerprint({ ...base, [field]: "CHANGED" }),
      same,
      `${field} must change the fingerprint`,
    );
  }
});

test("the fingerprint ignores what a person legitimately varies by name", () => {
  // Seed, population and sigma are how someone runs two comparable searches on
  // purpose. Folding them in would give every parameter tweak its own
  // experiment and defeat resuming entirely.
  const base: ExperimentIdentity = {
    engineSha: "abc123", schemaVersion: "v3", catalogHash: "f8f4ea6b", seed: 1,
    populationSize: 8, sigma: 0.2, scope: "full", fitnessVersion: "v2",
    weightsName: "default", allocation: "v2",
  };
  const same = identityFingerprint(base);
  assert.equal(identityFingerprint({ ...base, seed: 999 }), same);
  assert.equal(identityFingerprint({ ...base, populationSize: 32 }), same);
  assert.equal(identityFingerprint({ ...base, sigma: 0.9 }), same);
});

test("the fingerprint is stable, so a restart rejoins its own run", () => {
  // Derived from the identity rather than a clock or a random value: every
  // coordinator restart on the same build must land on the same experiment, or
  // a restart forks the run — the very thing name-based lookup protected.
  const identity: ExperimentIdentity = {
    engineSha: "36d9ce3eb0", schemaVersion: "v3", catalogHash: "e1370e21", seed: 20260819,
    populationSize: 8, sigma: 0.2, scope: "full", fitnessVersion: "v2",
    weightsName: "default", allocation: "v2",
  };
  const first = identityFingerprint(identity);
  assert.equal(first, identityFingerprint(identity));
  assert.match(first, /^[0-9a-f]{8}$/, "must be a short stable hex suffix");
});
