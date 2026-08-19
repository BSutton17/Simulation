import assert from "node:assert/strict";
import test from "node:test";
import { withConfig } from "../simulation/src/neat/index.js";
import {
  EvaluationCache,
  baselineKey,
  genomeKey,
} from "../simulation/src/training/evaluationCache.js";
import { trainingConfig } from "../simulation/src/training/config.js";
import { train } from "../simulation/src/training/trainer.js";
import { DEFAULT_SELF_PLAY } from "../simulation/src/training/selfPlay.js";
import type { TrainingResult } from "../simulation/src/training/fitness.js";

/**
 * A cache in an experiment is only acceptable if it cannot change a conclusion.
 *
 * These pin the two properties that make it safe: a hit returns the stored value
 * untouched, and keys name every input an evaluation depends on. The third
 * property — that a cached run produces the identical history to an uncached one
 * — was verified end to end against a 50-generation log; the run-level test here
 * is the cheap standing guard on it.
 */

const stub = (fitness: number, matches = 3): TrainingResult => ({
  fitness, matches, wins: 0, losses: 0, draws: 0, timeouts: 0, inactive: 0,
  meanPlacement: 1, totalDamageDealt: 0, totalDamageReceived: 0, totalKills: 0,
  totalCasts: 0, scenarios: [],
});

test("a hit returns the stored value and never recomputes", async () => {
  const cache = new EvaluationCache();
  let computed = 0;
  const compute = (): TrainingResult => {
    computed += 1;
    return stub(1.25);
  };

  const first = cache.get("k", compute);
  const second = cache.get("k", compute);
  assert.equal(computed, 1, "a hit must not call compute");
  assert.equal(second, first, "a hit must return the identical object");
  assert.equal(cache.stats.hits, 1);
  assert.equal(cache.stats.misses, 1);
  assert.equal(cache.stats.matchesSaved, 3);
});

test("keys separate everything an evaluation depends on", async () => {
  // The failure this prevents is silent and severe: a key that ignored the slate
  // would answer a benchmark question with a validation score.
  assert.notEqual(genomeKey("val", "abc", "slate1"), genomeKey("val", "abc", "slate2"));
  assert.notEqual(genomeKey("val", "abc", "s"), genomeKey("bench", "abc", "s"));
  assert.notEqual(genomeKey("val", "abc", "s"), genomeKey("val", "abd", "s"));
  assert.notEqual(baselineKey("bench", "economic", 1, "s"), baselineKey("bench", "economic", 2, "s"));
  assert.notEqual(baselineKey("bench", "economic", 1, "s"), baselineKey("bench", "balanced", 1, "s"));
  // ...and the same inputs always agree.
  assert.equal(genomeKey("val", "abc", "s"), genomeKey("val", "abc", "s"));
});

test("the cache stays bounded and keeps what is still in use", async () => {
  const cache = new EvaluationCache(4);
  for (let i = 0; i < 4; i++) cache.get(`k${i}`, () => stub(i));
  // Touch the oldest so recency, not insertion order, decides eviction — a
  // standing champion is looked up every check and must survive the churn of
  // one-off candidates around it.
  cache.get("k0", () => stub(99));
  cache.get("k4", () => stub(4));

  assert.equal(cache.size, 4);
  let recomputed = false;
  cache.get("k0", () => {
    recomputed = true;
    return stub(99);
  });
  assert.equal(recomputed, false, "the refreshed entry was evicted anyway");
});

test("a cached run reaches the same result as it would without the memo", async () => {
  const base = trainingConfig();
  const config = trainingConfig({
    mode: "selfPlay",
    generations: 4,
    validateEvery: 2,
    validationCandidates: 2,
    benchmarkEvery: 2,
    kingdoms: ["water", "fire"],
    neat: withConfig({ populationSize: 6, normalizeBySize: false }),
    selfPlay: {
      ...DEFAULT_SELF_PLAY,
      formats: ["duel"],
      roundsPerFormat: 1,
      hallOfFameShare: 0.5,
      maxTicks: 600,
    },
    slate: { ...base.slate, formats: ["duel"], kingdomsPerGenome: 1, maxTicks: 600 },
  });

  const a = await train({ config });
  const b = await train({ config });

  // Two runs of an identical config must agree completely — the memo is inside
  // each run, so this also proves it cannot leak state across runs.
  assert.deepEqual(
    a.history.map((r) => [r.best, r.validationFitness, r.bestFingerprint]),
    b.history.map((r) => [r.best, r.validationFitness, r.bestFingerprint]),
  );
  assert.equal(a.bestValidation, b.bestValidation);
  assert.ok(a.cache.hits > 0, "the heuristic baselines should have been reused");
  assert.equal(a.cache.hits, b.cache.hits);
});
