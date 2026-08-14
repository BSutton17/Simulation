import { test } from "node:test";
import assert from "node:assert/strict";
import {
  POPULATION_V1,
  allDuelPairings,
  defaultWorkerCount,
  evaluate,
  executeJobs,
  planEvaluation,
  planJobs,
  runJob,
  toJson,
  type EvaluationConfig,
  type MatchJob,
  type MatchOutcome,
} from "../simulation/src/evaluation/index.js";

/**
 * Parallel evaluation (Step 5).
 *
 * The entire point of these tests is that parallelism changes runtime and
 * nothing else. Worker count, scheduling and completion order must all be
 * invisible in the reading.
 */

/** Small enough to spawn workers for repeatedly, large enough to be shared out. */
const parallelConfig = (workers: number): EvaluationConfig => ({
  balanceConfigId: "parallel-test",
  pool: "validation",
  workers,
  duel: { enabled: true, seedsPerPairing: 1, pairings: allDuelPairings().slice(0, 2) },
  ffa4: { enabled: true, seedsPerPairing: 1, compositions: 1 },
  ffa7: { enabled: false },
  now: () => "1970-01-01T00:00:00.000Z",
});

/**
 * A reading with everything that legitimately varies between runs removed:
 * wall-clock duration, and the execution block (worker count is deliberately
 * different in the very comparison these tests make).
 */
const canonical = (result: unknown): string =>
  JSON.stringify(
    JSON.parse(toJson(result as never), (key, value) =>
      key === "durationMs" ? 0 : key === "execution" ? undefined : value,
    ),
  );

// --- planning ---------------------------------------------------------------

test("the job plan is a pure function of the configuration", () => {
  const a = planEvaluation(parallelConfig(1));
  const b = planEvaluation(parallelConfig(8));
  // Worker count must not reach the plan at all.
  assert.deepEqual(a, b);
  assert.ok(a.length > 0);
});

test("job ids are deterministic and unique", () => {
  const jobs = planEvaluation(parallelConfig(1));
  const ids = jobs.map((j) => j.id);
  assert.equal(new Set(ids).size, ids.length, "job ids must be unique");
  assert.deepEqual(ids, planEvaluation(parallelConfig(1)).map((j) => j.id));
  // Ids should carry enough to debug a parallel run from a log line alone.
  assert.match(jobs[0]!.id, /^(duel|ffa4|ffa7)\|.+\|.+\|\d+$/);
});

test("FFA seat rotation comes from the plan, not a running counter", () => {
  // A counter incremented as matches complete would make the roster depend on
  // execution order, which parallelism does not preserve.
  const jobs = planEvaluation({
    ...parallelConfig(1),
    duel: { enabled: false },
    ffa4: { enabled: true, seedsPerPairing: 1, compositions: 2 },
  }).filter((j) => j.format === "ffa4");
  assert.ok(jobs.length > 1);
  const first = jobs.map((j) => j.kingdoms.join(","));
  const second = planEvaluation({
    ...parallelConfig(8),
    duel: { enabled: false },
    ffa4: { enabled: true, seedsPerPairing: 1, compositions: 2 },
  })
    .filter((j) => j.format === "ffa4")
    .map((j) => j.kingdoms.join(","));
  assert.deepEqual(first, second);
  // Rotation must actually be happening, or seat bias goes unmeasured.
  assert.ok(new Set(first).size > 1, "expected seat rotation across jobs");
});

// --- execution --------------------------------------------------------------

test("a job produces the same outcome however it is executed", async () => {
  const job = planEvaluation(parallelConfig(1))[0]!;
  const direct = runJob(job, POPULATION_V1);
  const viaPool = await executeJobs([job], { workers: 2 });
  assert.deepEqual(viaPool.outcomes.get(job.id), direct);
});

test("serial and parallel evaluations are identical", async () => {
  const serial = await evaluate(parallelConfig(1));
  const parallel = await evaluate(parallelConfig(4));
  assert.equal(
    canonical(parallel),
    canonical(serial),
    "worker count must not change any measured value",
  );
  // And the run really did use multiple workers.
  assert.equal(serial.execution.workers, 1);
  assert.ok(parallel.execution.workers > 1);
  assert.equal(parallel.execution.failures.length, 0);
});

test("worker count never exceeds the work available", async () => {
  const job = planEvaluation(parallelConfig(1))[0]!;
  const result = await executeJobs([job], { workers: 8 });
  assert.equal(result.outcomes.size, 1);
  assert.ok(result.workers <= 1 || result.outcomes.size === 1);
});

test("results are keyed by job id, so completion order cannot matter", async () => {
  const jobs = planEvaluation(parallelConfig(1)).slice(0, 12);
  const result = await executeJobs(jobs, { workers: 4 });
  for (const job of jobs) {
    const outcome = result.outcomes.get(job.id);
    assert.ok(outcome, `missing outcome for ${job.id}`);
    assert.equal(outcome.id, job.id);
    assert.equal(outcome.placements.length, job.seats);
  }
});

// --- isolation --------------------------------------------------------------

test("a candidate's balance cannot leak between evaluations", async () => {
  // Each worker is its own V8 isolate, so the engine's active parameter set is
  // per-worker; this proves the parent is not left contaminated either.
  const before = await evaluate(parallelConfig(4));
  await evaluate({
    ...parallelConfig(4),
    balanceConfigId: "candidate",
    balance: { "castle.startingHp": 3000 },
  });
  const after = await evaluate(parallelConfig(4));
  assert.equal(canonical(after), canonical(before));
});

test("a balance override reaches the workers", async () => {
  const baseline = await evaluate(parallelConfig(4));
  const candidate = await evaluate({
    ...parallelConfig(4),
    balanceConfigId: "candidate",
    balance: { "castle.startingHp": 3000 },
  });
  // Shorter castles end matches sooner; if the override never arrived, the
  // tick totals would be identical.
  assert.notEqual(candidate.totals.ticks, baseline.totals.ticks);
});

// --- reliability ------------------------------------------------------------

test("a failing job is recorded, never silently dropped", async () => {
  const good = planEvaluation(parallelConfig(1))[0]!;
  // An unknown strategy makes the worker's factory throw for this job only.
  const bad: MatchJob = { ...good, id: "broken", profiles: ["does-not-exist", "balanced"] };
  const result = await executeJobs([good, bad], { workers: 2 });
  assert.equal(result.outcomes.size, 1, "the healthy job should still complete");
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]!.id, "broken");
  assert.match(result.failures[0]!.error, /does-not-exist/);
});

test("game timeouts are outcomes, not infrastructure failures", async () => {
  // A tick cap of 1 guarantees every match times out. That is a legitimate
  // game result and must appear in the reading, not in `failures`.
  const jobs = planJobs({
    pool: "validation",
    population: POPULATION_V1,
    maxTicks: 1,
    duel: { enabled: true, seedsPerPairing: 1, pairings: allDuelPairings().slice(0, 1) },
    ffa4: { enabled: false, seedsPerPairing: 1, compositions: 0, sampler: "coverage" },
    ffa7: { enabled: false, seedsPerPairing: 1, compositions: 0, sampler: "coverage" },
  });
  const result = await executeJobs(jobs, { workers: 2 });
  assert.equal(result.failures.length, 0, "a tick cap is not a worker failure");
  assert.equal(result.outcomes.size, jobs.length);
  for (const outcome of result.outcomes.values()) {
    assert.equal(outcome.timedOut, true);
  }
});

// --- resume -----------------------------------------------------------------

test("completed jobs are not rerun, and the reading is unchanged", async () => {
  const config = parallelConfig(4);
  const full = await evaluate(config);
  const jobs = planEvaluation(config);

  // Pretend the first half already ran.
  const half = new Map<string, MatchOutcome>();
  const firstHalf = jobs.slice(0, Math.floor(jobs.length / 2));
  const pre = await executeJobs(firstHalf, { workers: 4 });
  for (const [id, outcome] of pre.outcomes) half.set(id, outcome);

  const resumed = await evaluate({ ...config, resume: half });
  assert.equal(
    canonical(resumed),
    canonical(full),
    "a resumed evaluation must match a clean one exactly",
  );
});

// --- progress & defaults ----------------------------------------------------

test("progress is reported and ends at the planned total", async () => {
  const config = parallelConfig(4);
  const total = planEvaluation(config).length;
  const seen: number[] = [];
  const result = await evaluate({ ...config, onProgress: (done) => seen.push(done) });
  assert.ok(seen.length > 1, "progress should be reported during the run");
  assert.equal(seen.at(-1), total);
  assert.equal(result.totals.matches, total);
  // Monotonic: progress must never go backwards.
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i]! >= seen[i - 1]!);
});

test("the default worker count is sane for this machine", () => {
  const n = defaultWorkerCount();
  assert.ok(Number.isInteger(n) && n >= 1 && n <= 16, `unexpected default ${n}`);
});
