import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { Cmaes, buildSchema, makeCandidate, baseVector, vectorToParameters,
  type Candidate, type CandidateEvaluation } from "../simulation/src/search/index.js";
import { distributedEvaluator, formatStatus } from "../simulation/src/distributed/coordinator.js";
import { credentialsFor } from "../simulation/src/distributed/client.js";
import type { JobRecord, ResultRecord } from "../simulation/src/distributed/protocol.js";

/**
 * The distributed queue, exercised end to end against an in-memory stand-in for
 * Supabase.
 *
 * The stand-in implements the same contract the SQL functions do — atomic
 * claim, lease expiry, idempotent submission, hash checking — so the
 * coordinator and the ordering logic run unmodified. What it cannot prove is
 * that Postgres behaves as described; FOR UPDATE SKIP LOCKED needs a real
 * database, and that check belongs in a run against the live project.
 */

/** A queue that behaves like the schema's functions. */
class FakeQueue {
  jobs: (JobRecord & { status: string; workerId: string | null; leaseExpiresAt: number | null })[] = [];
  results: ResultRecord[] = [];
  generation = 0;
  claims = 0;

  async publishJobs(jobs: Omit<JobRecord, "id">[]): Promise<void> {
    for (const job of jobs) {
      // The uniqueness constraint: republishing a generation is a no-op.
      const exists = this.jobs.some(
        (j) => j.generationNumber === job.generationNumber &&
               j.candidateIndex === job.candidateIndex && j.tier === job.tier,
      );
      if (!exists) {
        this.jobs.push({ ...job, id: `job-${job.generationNumber}-${job.candidateIndex}`,
          status: "pending", workerId: null, leaseExpiresAt: null });
      }
    }
  }

  async setCurrentGeneration(_id: string, generation: number): Promise<void> {
    this.generation = generation;
  }

  /** The claim_job contract: one job, atomically, expired leases reclaimable. */
  async claimJob(_e: string, generation: number, workerId: string, leaseMinutes = 30) {
    this.claims += 1;
    const now = Date.now();
    const job = this.jobs
      .filter((j) => j.generationNumber === generation &&
        (j.status === "pending" || (j.status === "running" && (j.leaseExpiresAt ?? 0) < now)))
      .sort((a, b) => a.candidateIndex - b.candidateIndex)[0];
    if (!job) return null;
    job.status = "running";
    job.workerId = workerId;
    job.leaseExpiresAt = now + leaseMinutes * 60_000;
    return job;
  }

  /** The submit_result contract: hash-checked, idempotent, late answers dropped. */
  async submitResult(job: JobRecord, workerId: string, payload: {
    fitness: unknown | null; failure: string | null; durationMs: number; matches: number;
  }): Promise<boolean> {
    const target = this.jobs.find((j) => j.id === job.id);
    if (!target) throw new Error(`unknown job ${job.id}`);
    if (target.candidateHash !== job.candidateHash) throw new Error("candidate hash mismatch");
    if (target.status === "complete") return false;
    target.status = "complete";
    this.results.push({
      jobId: job.id, generationNumber: target.generationNumber,
      candidateIndex: target.candidateIndex, candidateHash: target.candidateHash,
      fitness: payload.fitness, failure: payload.failure,
      durationMs: payload.durationMs, matches: payload.matches,
    });
    return true;
  }

  async resultsFor(_e: string, generation: number) {
    return this.results.filter((r) => r.generationNumber === generation);
  }

  async progress(_e: string, generation: number) {
    const mine = this.jobs.filter((j) => j.generationNumber === generation);
    return {
      total: mine.length,
      pending: mine.filter((j) => j.status === "pending").length,
      running: mine.filter((j) => j.status === "running").length,
      complete: mine.filter((j) => j.status === "complete").length,
      failed: 0,
    };
  }

  async activeWorkers(): Promise<number> { return 3; }
  async renewLease(): Promise<boolean> { return true; }
  async registerWorker(): Promise<void> {}
  async currentGeneration(): Promise<number> { return this.generation; }
}

const schema = buildSchema({ scope: "expanded" });
const POPULATION = 6;

function population(cma: Cmaes, generation: number): { vectors: number[][]; candidates: Candidate[] } {
  const vectors = cma.ask();
  return {
    vectors,
    candidates: vectors.map((vector, index) => makeCandidate({
      schema, vector, parameters: vectorToParameters(schema, vector),
      generation, index, optimizer: "cmaes",
    })),
  };
}

/** Deterministic stand-in for a real evaluation. */
const objectiveOf = (c: Candidate) =>
  0.5 + (parseInt(c.hash.slice(0, 6), 16) % 1000) / 10000;

const strategy = () => new Cmaes({
  dimension: baseVector(schema).length, mean: baseVector(schema),
  sigma: 0.2, populationSize: POPULATION, seed: 20260813,
});

test("distributed evaluation reaches the same CMA-ES state as local", async () => {
  // The gate. Distribution may change where a candidate is evaluated; it must
  // not change what the strategy learns.
  const local = strategy();
  const remote = strategy();
  const queue = new FakeQueue();
  const evaluateGeneration = distributedEvaluator({
    client: queue as never, experimentId: "exp", pollMs: 0,
  });

  for (let generation = 0; generation < 3; generation++) {
    const l = population(local, generation);
    local.tell(l.vectors, l.candidates.map(objectiveOf));

    const r = population(remote, generation);
    // Workers finish in arbitrary order — claim everything, then answer
    // back-to-front, which is the worst case for ordering.
    const claimed: JobRecord[] = [];
    await queue.publishJobs(r.candidates.map((c, index) => ({
      experimentId: "exp", generationNumber: generation, candidateIndex: index,
      candidateId: c.id, candidateHash: c.hash, tier: "screen" as const, parameters: c.parameters,
    })));
    for (;;) {
      const job = await queue.claimJob("exp", generation, "w1");
      if (!job) break;
      claimed.push(job);
    }
    for (const job of [...claimed].reverse()) {
      const candidate = r.candidates[job.candidateIndex]!;
      await queue.submitResult(job, "w1", {
        fitness: { searchObjective: objectiveOf(candidate) },
        failure: null, durationMs: 1, matches: 1,
      });
    }

    const ordered = await evaluateGeneration(r.candidates, "screen");
    remote.tell(r.vectors, ordered.map((e) =>
      (e.fitness as { searchObjective: number } | null)?.searchObjective ?? -1));
  }

  const a = local.snapshot();
  const b = remote.snapshot();
  assert.deepEqual(a.mean, b.mean, "mean diverged");
  assert.deepEqual(a.C, b.C, "covariance diverged");
  assert.deepEqual(a.pc, b.pc, "pc diverged");
  assert.deepEqual(a.ps, b.ps, "ps diverged");
  assert.equal(a.sigma, b.sigma, "sigma diverged");
  assert.equal(a.rngState, b.rngState, "RNG diverged");
  assert.equal(a.generation, b.generation);
});

test("two workers never receive the same job", async () => {
  const queue = new FakeQueue();
  const cma = strategy();
  const { candidates } = population(cma, 0);
  await queue.publishJobs(candidates.map((c, index) => ({
    experimentId: "exp", generationNumber: 0, candidateIndex: index,
    candidateId: c.id, candidateHash: c.hash, tier: "screen" as const, parameters: c.parameters,
  })));

  // Twelve workers polling at once is the production shape, not an edge case.
  const claims = await Promise.all(
    Array.from({ length: 12 }, (_, i) => queue.claimJob("exp", 0, `w${i}`)),
  );
  const handedOut = claims.filter((j): j is NonNullable<typeof j> => j !== null);
  const ids = handedOut.map((j) => j.id);
  assert.equal(new Set(ids).size, ids.length, "a job was handed to two workers");
  assert.equal(handedOut.length, POPULATION, "every job should have gone out exactly once");
});

test("an expired lease is reclaimable; a live one is not", async () => {
  const queue = new FakeQueue();
  const cma = strategy();
  const { candidates } = population(cma, 0);
  await queue.publishJobs([{
    experimentId: "exp", generationNumber: 0, candidateIndex: 0,
    candidateId: candidates[0]!.id, candidateHash: candidates[0]!.hash,
    tier: "screen", parameters: candidates[0]!.parameters,
  }]);

  const first = await queue.claimJob("exp", 0, "worker-a", 30);
  assert.ok(first);
  assert.equal(await queue.claimJob("exp", 0, "worker-b"), null, "a live lease was stolen");

  // The worker vanished. No monitor, no reaper — the lease simply lapses.
  queue.jobs[0]!.leaseExpiresAt = Date.now() - 1;
  const reclaimed = await queue.claimJob("exp", 0, "worker-b", 30);
  assert.ok(reclaimed, "an expired job should return to the pool");
  assert.equal(reclaimed.id, first.id);
});

test("a late answer from a reclaimed job cannot overwrite a good one", async () => {
  const queue = new FakeQueue();
  const cma = strategy();
  const { candidates } = population(cma, 0);
  await queue.publishJobs([{
    experimentId: "exp", generationNumber: 0, candidateIndex: 0,
    candidateId: candidates[0]!.id, candidateHash: candidates[0]!.hash,
    tier: "screen", parameters: candidates[0]!.parameters,
  }]);

  const job = (await queue.claimJob("exp", 0, "worker-a"))!;
  assert.equal(await queue.submitResult(job, "worker-b", {
    fitness: { searchObjective: 0.9 }, failure: null, durationMs: 1, matches: 1,
  }), true, "the first answer should be accepted");

  // worker-a's lease had expired and it finally finishes. Discarded, not an
  // error: evaluation is deterministic, so both answers agree anyway.
  assert.equal(await queue.submitResult(job, "worker-a", {
    fitness: { searchObjective: 0.1 }, failure: null, durationMs: 1, matches: 1,
  }), false, "a duplicate submission should be refused, not applied");
  assert.equal(queue.results.length, 1);
  assert.deepEqual(queue.results[0]!.fitness, { searchObjective: 0.9 });
});

test("a result answering the wrong candidate is rejected", async () => {
  const queue = new FakeQueue();
  const cma = strategy();
  const { candidates } = population(cma, 0);
  await queue.publishJobs([{
    experimentId: "exp", generationNumber: 0, candidateIndex: 0,
    candidateId: candidates[0]!.id, candidateHash: candidates[0]!.hash,
    tier: "screen", parameters: candidates[0]!.parameters,
  }]);
  const job = (await queue.claimJob("exp", 0, "w"))!;
  await assert.rejects(
    () => queue.submitResult({ ...job, candidateHash: "deadbeef" }, "w",
      { fitness: null, failure: null, durationMs: 1, matches: 1 }),
    /hash mismatch/,
  );
});

test("an unfinished generation never reaches tell()", async () => {
  const queue = new FakeQueue();
  const cma = strategy();
  const { candidates } = population(cma, 0);
  const evaluateGeneration = distributedEvaluator({
    client: queue as never, experimentId: "exp", pollMs: 1, generationTimeoutMs: 50,
  });
  // Nothing is ever answered, so the coordinator must give up rather than
  // proceed with a partial population.
  await assert.rejects(() => evaluateGeneration(candidates, "screen"), /did not finish/);
});

test("a worker never runs with the elevated key", () => {
  const saved = { ...process.env };
  try {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "publishable-key-value";
    process.env.SUPABASE_SECRET_KEY = "secret-key-value";

    // Even with the secret present in the environment, a worker takes the
    // publishable key. Only the coordinator is trusted with the other one.
    assert.equal(credentialsFor("worker").key, "publishable-key-value");
    assert.equal(credentialsFor("coordinator").key, "secret-key-value");

    delete process.env.SUPABASE_SECRET_KEY;
    assert.equal(credentialsFor("worker").key, "publishable-key-value",
      "a worker should not need the secret at all");
    assert.throws(() => credentialsFor("coordinator"), /SUPABASE_SECRET_KEY/);
  } finally {
    process.env = saved;
  }
});

test("the status line reports what an operator needs", () => {
  const line = formatStatus({
    generation: 4, total: 19, complete: 14, running: 5, pending: 0,
    failed: 0, workers: 6, elapsedMs: 600_000,
  });
  assert.match(line, /gen 4/);
  assert.match(line, /14\/19/);
  assert.match(line, /6 workers/);
  assert.match(line, /left/);
});

/**
 * How many worker notebooks are running is an operational choice, not part of
 * the experiment. The coordinator waits for its outstanding jobs and is
 * indifferent to who does them — including nobody, for a while.
 */
test("the coordinator is indifferent to how many workers exist", async () => {
  for (const workerCount of [0, 1, 2, 5, 6, 12]) {
    const queue = new FakeQueue();
    // activeWorkers only ever reaches the log line; if it reached the control
    // flow, a count of zero would break the run rather than pause it.
    queue.activeWorkers = async () => workerCount;

    const cma = strategy();
    const { candidates } = population(cma, 0);
    const evaluateGeneration = distributedEvaluator({
      client: queue as never, experimentId: "exp", pollMs: 0,
    });

    // Answer everything up front, so completion is the only thing gating.
    await queue.publishJobs(candidates.map((c, index) => ({
      experimentId: "exp", generationNumber: 0, candidateIndex: index,
      candidateId: c.id, candidateHash: c.hash, tier: "screen" as const, parameters: c.parameters,
    })));
    for (;;) {
      const job = await queue.claimJob("exp", 0, "w");
      if (!job) break;
      await queue.submitResult(job, "w", {
        fitness: { searchObjective: 0.5 }, failure: null, durationMs: 1, matches: 1,
      });
    }

    const ordered = await evaluateGeneration(candidates, "screen");
    assert.equal(ordered.length, candidates.length,
      `reported ${workerCount} workers and the generation did not complete`);
  }
});

test("a worker joining mid-generation is picked up", async () => {
  // Workers register whenever their notebook happens to start. A generation
  // already dispatched must still finish, with the late arrival doing its
  // share rather than being locked out.
  const queue = new FakeQueue();
  const cma = strategy();
  const { candidates } = population(cma, 0);
  const evaluateGeneration = distributedEvaluator({
    client: queue as never, experimentId: "exp", pollMs: 0,
  });

  await queue.publishJobs(candidates.map((c, index) => ({
    experimentId: "exp", generationNumber: 0, candidateIndex: index,
    candidateId: c.id, candidateHash: c.hash, tier: "screen" as const, parameters: c.parameters,
  })));

  // One worker takes the first two, then stalls.
  for (let i = 0; i < 2; i++) {
    const job = (await queue.claimJob("exp", 0, "early"))!;
    await queue.submitResult(job, "early", {
      fitness: { searchObjective: 0.4 }, failure: null, durationMs: 1, matches: 1,
    });
  }

  // A second notebook starts now and finishes the rest.
  for (;;) {
    const job = await queue.claimJob("exp", 0, "late-joiner");
    if (!job) break;
    await queue.submitResult(job, "late-joiner", {
      fitness: { searchObjective: 0.6 }, failure: null, durationMs: 1, matches: 1,
    });
  }

  const ordered = await evaluateGeneration(candidates, "screen");
  assert.equal(ordered.length, candidates.length);
  assert.deepEqual(ordered.map((e) => e.candidate.hash), candidates.map((c) => c.hash));
});

test("no worker count is hard-coded into the coordinator's control flow", () => {
  // Asserted against the source: the number of notebooks is operational, and a
  // coordinator that waited for a quorum would stall whenever Kaggle gave us
  // one fewer session than expected.
  const source = readFileSync("simulation/src/distributed/coordinator.ts", "utf8");
  const waitLoop = source.slice(source.indexOf("for (;;)"), source.indexOf("const results ="));
  assert.match(waitLoop, /progress\.complete >= candidates\.length/,
    "completion should be the only thing that ends the wait");
  assert.ok(
    !/workers\s*(===|!==|>=|<=|>|<)\s*\d/.test(waitLoop),
    "the wait loop compares a worker count against a number",
  );
});
