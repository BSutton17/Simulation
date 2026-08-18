import { test } from "node:test";
import assert from "node:assert/strict";
import { distributedEvaluator } from "../simulation/src/distributed/coordinator.js";
import type { Candidate } from "../simulation/src/search/index.js";

/**
 * The generation index belongs to the search loop, not to the evaluator.
 *
 * `distributedEvaluator` used to keep `let generation = 0` and increment it per
 * call. That is correct only in a process that starts at generation 0 and never
 * restarts. A coordinator resuming at generation 13 published its candidates as
 * generation 0, where the uniqueness constraint silently matched them to the
 * rows generation 0 had already written — so the restart consumed stale results
 * instead of evaluating the population it had just drawn.
 *
 * These tests pin the contract that makes a restart safe: whatever generation
 * the caller names is the generation that reaches the queue.
 */

interface Published { generation: number; hashes: string[] }

function fakeClient(published: Published[]) {
  return {
    async publishJobs(jobs: { generationNumber: number; candidateHash: string }[]) {
      published.push({
        generation: jobs[0]!.generationNumber,
        hashes: jobs.map((j) => j.candidateHash),
      });
    },
    async setCurrentGeneration() {},
    async progress(_e: string, _g: number) {
      const last = published[published.length - 1]!;
      return { total: last.hashes.length, pending: 0, running: 0, complete: last.hashes.length, failed: 0 };
    },
    async resultsFor(_e: string, generation: number) {
      const batch = published.filter((p) => p.generation === generation).at(-1)!;
      return batch.hashes.map((hash, i) => ({
        jobId: `job-${generation}-${i}`, generationNumber: generation,
        candidateIndex: i, candidateHash: hash,
        fitness: { searchObjective: 0.5, verdictScore: 0.5, provenance: { totalMatches: 1 } },
        failure: null, durationMs: 1, matches: 1,
      }));
    },
    async activeWorkers() { return 1; },
  };
}

const candidates = (n: number, tag: string): Candidate[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${tag}-${i}`, hash: `${tag}hash${i}`, parameters: { "ability.zap.cost": 100 + i },
  })) as unknown as Candidate[];

test("the generation the caller names is the generation published", async () => {
  const published: Published[] = [];
  const evaluate = distributedEvaluator({
    client: fakeClient(published) as never, experimentId: "exp", pollMs: 1,
  });

  await evaluate(candidates(3, "a"), "screen", 13);
  assert.equal(published[0]!.generation, 13, "a resumed coordinator must publish generation 13, not 0");
});

test("a restarted evaluator does not begin again at zero", async () => {
  // The regression, stated directly: build a fresh evaluator (a new process),
  // hand it generation 13, and it must not renumber to 0.
  const published: Published[] = [];
  const first = distributedEvaluator({ client: fakeClient(published) as never, experimentId: "exp", pollMs: 1 });
  await first(candidates(2, "g0"), "screen", 0);
  await first(candidates(2, "g1"), "screen", 1);

  const afterRestart = distributedEvaluator({ client: fakeClient(published) as never, experimentId: "exp", pollMs: 1 });
  await afterRestart(candidates(2, "g2"), "screen", 2);

  assert.deepEqual(published.map((p) => p.generation), [0, 1, 2]);
});

test("evaluating the same generation twice republishes that same generation", async () => {
  // A coordinator killed mid-generation re-publishes on restart. Publishing is
  // idempotent at the database level, so the requirement here is only that it
  // addresses the same generation rather than advancing past it.
  const published: Published[] = [];
  const evaluate = distributedEvaluator({
    client: fakeClient(published) as never, experimentId: "exp", pollMs: 1,
  });

  await evaluate(candidates(2, "x"), "screen", 7);
  await evaluate(candidates(2, "x"), "screen", 7);

  assert.deepEqual(published.map((p) => p.generation), [7, 7]);
  assert.deepEqual(published[0]!.hashes, published[1]!.hashes, "same population, same hashes");
});

test("results are matched to the generation asked for", async () => {
  const published: Published[] = [];
  const evaluate = distributedEvaluator({
    client: fakeClient(published) as never, experimentId: "exp", pollMs: 1,
  });

  const pop = candidates(3, "z");
  const out = await evaluate(pop, "screen", 41);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((e) => e.candidate.hash), pop.map((c) => c.hash),
    "order must correspond, since order is the candidate-to-score mapping");
});
