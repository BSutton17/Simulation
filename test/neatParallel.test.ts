import assert from "node:assert/strict";
import test from "node:test";
import { withConfig } from "../simulation/src/neat/index.js";
import { trainingConfig } from "../simulation/src/training/config.js";
import { train, type GenerationRecord } from "../simulation/src/training/trainer.js";
import { DEFAULT_SELF_PLAY } from "../simulation/src/training/selfPlay.js";
import { createRunner, defaultWorkerCount } from "../simulation/src/training/parallel/runner.js";
import { buildValidationSlate } from "../simulation/src/training/slate.js";
import { DEFAULT_FITNESS } from "../simulation/src/training/fitness.js";
import { Population } from "../simulation/src/neat/index.js";
import { ELEMENTALS_SHAPE } from "../simulation/src/training/matchEvaluator.js";

/**
 * DETERMINISTIC EQUIVALENCE — the acceptance criterion for the worker pool.
 *
 * The pool exists purely to make training faster. It is therefore correct only
 * if it changes nothing else, and "nothing else" has to mean bit-for-bit: a
 * parallel run that agreed to three decimal places would still be a different
 * experiment, and the whole reason for measuring validation to four is that the
 * effects being chased are around 0.05.
 *
 * The subtle failure these guard is not a wrong match — matches are independent
 * and seeded — but a wrong ORDER. `aggregate()` sums floating-point scores, and
 * floating-point addition is not associative, so results summed as they happen
 * to finish differ in the low bits from results summed in slate order.
 */

const SMALL = (workers: number) =>
  trainingConfig({
    mode: "selfPlay",
    generations: 3,
    validateEvery: 1,
    validationCandidates: 3,
    benchmarkEvery: 2,
    workers,
    kingdoms: ["water", "fire", "earth"],
    neat: withConfig({ populationSize: 8, normalizeBySize: false }),
    selfPlay: {
      ...DEFAULT_SELF_PLAY,
      formats: ["duel", "ffa4"],
      roundsPerFormat: 1,
      hallOfFameShare: 0.25,
      maxTicks: 900,
    },
    slate: { ...trainingConfig().slate, formats: ["duel"], kingdomsPerGenome: 1, maxTicks: 900 },
  });

/** Everything a generation is allowed to differ in: nothing. */
const shape = (r: GenerationRecord) => ({
  generation: r.generation,
  best: r.best,
  mean: r.mean,
  worst: r.worst,
  species: r.species,
  meanNodes: r.meanNodes,
  meanConnections: r.meanConnections,
  diversity: r.diversity,
  bestFingerprint: r.bestFingerprint,
  bestGenomeId: r.bestGenomeId,
  wins: r.wins,
  losses: r.losses,
  draws: r.draws,
  timeouts: r.timeouts,
  meanPlacement: r.meanPlacement,
  damageDealt: r.damageDealt,
  casts: r.casts,
  validationFitness: r.validationFitness,
  validationMean: r.validationMean,
  championId: r.championId,
  championValidation: r.championValidation,
  benchmark: r.benchmark,
});

test("a parallel run is bit-for-bit identical to a serial one", async () => {
  const serial = await train({ config: SMALL(1) });
  const parallel = await train({ config: SMALL(4) });

  assert.deepStrictEqual(
    parallel.history.map(shape),
    serial.history.map(shape),
    "the worker pool changed the run",
  );
  assert.equal(parallel.bestValidation, serial.bestValidation);
  assert.equal(parallel.best.id, serial.best.id);
  assert.deepStrictEqual(parallel.best.connections, serial.best.connections);
});

test("the worker count does not change the answer", async () => {
  // Two different degrees of parallelism, so an equivalence that held only for
  // one particular batching would be caught.
  const two = await train({ config: SMALL(2) });
  const five = await train({ config: SMALL(5) });
  assert.deepStrictEqual(five.history.map(shape), two.history.map(shape));
});

test("a single candidate scores identically however the slate is split", async () => {
  // The narrow version of the same claim, isolated from evolution: one genome,
  // one frozen slate, evaluated serially and across workers.
  const genome = new Population(ELEMENTALS_SHAPE, withConfig({ populationSize: 2 }), 11).ask()[0]!;
  const slate = buildValidationSlate(["water", "fire"], "baseline", { maxTicks: 900 });

  const serial = createRunner(1);
  const parallel = createRunner(4);
  try {
    const a = await serial.evaluate({ kind: "genome", genome, name: "g" }, slate, DEFAULT_FITNESS);
    const b = await parallel.evaluate({ kind: "genome", genome, name: "g" }, slate, DEFAULT_FITNESS);
    // Exact equality, not approximate: see the header on why.
    assert.equal(b.fitness, a.fitness);
    assert.equal(b.matches, a.matches);
    assert.equal(b.wins, a.wins);
    assert.equal(b.totalDamageDealt, a.totalDamageDealt);
    assert.deepStrictEqual(
      b.scenarios.map((s) => [s.scenarioId, s.score]),
      a.scenarios.map((s) => [s.scenarioId, s.score]),
      "scenarios came back in a different order",
    );
  } finally {
    await serial.close();
    await parallel.close();
  }
});

test("one worker means the in-process path, not a pool of one", async () => {
  // The serial path is the code that ran before the pool existed, so it must
  // stay reachable exactly rather than be re-implemented by a single worker.
  const runner = createRunner(1);
  assert.equal(runner.workers, 1);
  await runner.close();
});

test("the default worker count respects the measured knee", async () => {
  const workers = defaultWorkerCount();
  assert.ok(workers >= 1, "must always be able to run");
  assert.ok(workers <= 16, "capped so a huge host does not thrash");
});
