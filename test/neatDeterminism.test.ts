import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ELEMENTALS_SHAPE,
  buildSlate,
  train,
  trainingConfig,
  type TrainingConfig,
} from "../simulation/src/training/index.js";
import { Population, withConfig } from "../simulation/src/neat/index.js";

/**
 * Resume equivalence.
 *
 * The property that makes long training survivable: a run interrupted at
 * generation K and resumed must produce EXACTLY the run that was never
 * interrupted. Not similar fitness — identical state.
 *
 * Similar-fitness is the assertion that lets a broken resume through. Evolution
 * is a feedback loop, so a resume that silently reseeds its RNG, loses its
 * innovation counter, or drops species history still produces plausible numbers
 * and a completely different search. By the time that shows up, it has cost
 * hours of compute and every result taken since.
 */

/** Cheap enough to run in the suite, real enough to exercise the whole loop. */
function config(overrides: Partial<TrainingConfig> = {}): TrainingConfig {
  return trainingConfig({
    // Self-play is the default, and resume equivalence must hold for it — the
    // Hall of Fame is part of the environment, so a resume that lost it would
    // silently play different matches.
    mode: "selfPlay",
    selfPlay: {
      formats: ["duel"],
      roundsPerFormat: 1,
      hallOfFameShare: 0.5,
      maxTicks: 1_500,
    },
    validateEvery: 0,
    generations: 4,
    checkpointEvery: 1,
    neat: withConfig({
      populationSize: 6,
      activation: "tanh",
      initialConnectivity: 0.25,
      // Guarantee structural change inside four generations, so the test covers
      // innovation-counter restoration rather than weights alone.
      addNodeRate: 0.5,
      addConnectionRate: 0.5,
    }),
    slate: {
      ...trainingConfig().slate,
      formats: ["duel"],
      kingdomsPerGenome: 1,
      opponents: ["balanced"],
      seatRotations: 1,
      maxTicks: 1_500,
    },
    ...overrides,
  });
}

/**
 * The comparable state of a finished run.
 *
 * The population snapshot is the whole evolutionary state — genomes, species,
 * innovation registry, RNG position, counters, threshold — so comparing it
 * compares everything that determines what happens next.
 */
function fingerprint(snapshot: unknown): string {
  return JSON.stringify(snapshot);
}

test("a resumed run is byte-identical to an uninterrupted one", () => {
  const dir = mkdtempSync(join(tmpdir(), "neat-determinism-"));
  try {
    const N = 4;
    const K = 2;

    // A: straight through, no checkpoint involved.
    const pathA = join(dir, "a.json");
    const runA = train({ config: config(), checkpointPath: pathA });
    assert.equal(runA.generations, N);
    const stateA = JSON.parse(readFileSync(pathA, "utf8")) as { population: unknown };

    // B: stop at K, then resume to N from the checkpoint on disk.
    const pathB = join(dir, "b.json");
    const partial = train({ config: config({ generations: K }), checkpointPath: pathB });
    assert.equal(partial.generations, K);

    const resumed = train({ config: config(), checkpointPath: pathB, resume: true });
    assert.equal(resumed.resumedFrom, K, "should have resumed rather than restarted");
    assert.equal(resumed.checkpointRejected, null);
    assert.equal(resumed.history.length, N, "history must span the whole run");

    const stateB = JSON.parse(readFileSync(pathB, "utf8")) as { population: unknown };

    assert.equal(
      fingerprint(stateB.population),
      fingerprint(stateA.population),
      "resumed evolutionary state diverged from the uninterrupted run",
    );
    assert.equal(resumed.bestFitness, runA.bestFitness);
    assert.equal(resumed.best.id, runA.best.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the per-generation record matches across interruption", () => {
  const dir = mkdtempSync(join(tmpdir(), "neat-determinism-"));
  try {
    const pathA = join(dir, "a.json");
    const runA = train({ config: config(), checkpointPath: pathA });

    const pathB = join(dir, "b.json");
    train({ config: config({ generations: 2 }), checkpointPath: pathB });
    const runB = train({ config: config(), checkpointPath: pathB, resume: true });

    // Timings differ between runs; everything that describes the SEARCH must not.
    const comparable = (h: typeof runA.history) =>
      h.map(({ durationMs, ...rest }) => {
        void durationMs;
        return rest;
      });
    assert.deepEqual(comparable(runB.history), comparable(runA.history));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evolution is reproducible from a seed without any checkpoint", () => {
  // The weaker property the one above depends on: if plain evolution were not
  // reproducible, resume equivalence could not be either.
  const run = () => {
    const result = train({ config: config({ generations: 2 }) });
    return result.history.map((h) => `${h.best}|${h.mean}|${h.species}|${h.meanConnections}`);
  };
  assert.deepEqual(run(), run());
});

test("a different seed produces a different search", () => {
  // Guards against the reproducibility tests passing because nothing varies.
  const fingerprintFor = (seed: number): string => {
    const result = train({ config: config({ generations: 2, seed }) });
    return result.history.map((h) => `${h.best}|${h.meanConnections}`).join(";");
  };
  assert.notEqual(fingerprintFor(101), fingerprintFor(202));
});

test("the slate a generation runs is reproducible from the run seed", () => {
  const c = config();
  const first = buildSlate(3, c.slate, c.kingdoms, c.seed, c.balanceConfigId);
  const again = buildSlate(3, c.slate, c.kingdoms, c.seed, c.balanceConfigId);
  assert.deepEqual(first, again);
  assert.equal(first.hash, again.hash);
});

test("restoring a population snapshot preserves every evolutionary counter", () => {
  // Restore is the mechanism the resume test relies on; this isolates it so a
  // failure says which half broke.
  const c = config();
  const population = new Population(ELEMENTALS_SHAPE, c.neat, c.seed);
  const rng = { value: 0.5 };
  for (let i = 0; i < 3; i++) {
    population.tell(population.ask().map((_, index) => (index * 7) % 13 * rng.value));
  }
  const before = population.snapshot();
  const restored = Population.restore(JSON.parse(JSON.stringify(before)), c.neat);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.snapshot())), JSON.parse(JSON.stringify(before)));

  // …and it continues identically.
  const continueFrom = (p: Population): string => {
    p.tell(p.ask().map((_, i) => i));
    return JSON.stringify(p.snapshot());
  };
  const originalNext = continueFrom(Population.restore(JSON.parse(JSON.stringify(before)), c.neat));
  const restoredNext = continueFrom(restored);
  assert.equal(restoredNext, originalNext);
});
