import { test } from "node:test";
import assert from "node:assert/strict";
import { KINGDOM_IDS } from "../src/data/kingdoms.js";
import type { KingdomId } from "../src/data/kingdoms.js";
import {
  SAMPLERS,
  allCombinations,
  compositionSpace,
  coverageOf,
  coverageQuality,
  coverageSampler,
  diagnosticSampler,
  evaluate,
  exhaustiveSampler,
  planCompositions,
  randomSampler,
  samplerFor,
  samplerSeed,
  stratifiedSampler,
  toJson,
  type EvaluationConfig,
} from "../simulation/src/evaluation/index.js";

/**
 * FFA composition sampling (Step 6).
 *
 * The properties that matter: a sample must be reproducible, must not depend on
 * how the evaluation is executed, and must observe every kingdom well enough
 * that its numbers mean something. Coverage of the composition space is almost
 * irrelevant by comparison — any affordable 7-seat sample touches under 1% of
 * C(16,7).
 */

const SEATS = [4, 7] as const;
const NAMES = ["random", "coverage", "stratified", "diagnostic"] as const;

test("the sampler registry is complete and versioned", () => {
  for (const name of [...NAMES, "exhaustive"]) {
    const sampler = SAMPLERS[name];
    assert.ok(sampler, `missing sampler "${name}"`);
    assert.equal(sampler.name, name);
    assert.ok(Number.isInteger(sampler.version) && sampler.version >= 1);
    assert.ok(sampler.description.length > 0);
  }
  assert.equal(samplerFor("coverage").version, coverageSampler.version);
});

test("composition space matches the kingdom roster", () => {
  assert.equal(compositionSpace(2), 120); // C(16,2)
  assert.equal(compositionSpace(4), 1820); // C(16,4)
  assert.equal(compositionSpace(7), 11440); // C(16,7)
  assert.equal(allCombinations(4).length, compositionSpace(4));
});

for (const name of NAMES) {
  test(`${name} sampler is deterministic in its seed`, () => {
    const sampler = SAMPLERS[name]!;
    for (const seats of SEATS) {
      const a = sampler.sample(seats, 40, 1234);
      const b = sampler.sample(seats, 40, 1234);
      assert.deepEqual(a, b, `${name} must replay identically`);
      const c = sampler.sample(seats, 40, 5678);
      assert.notDeepEqual(a, c, `${name} must respond to its seed`);
    }
  });

  test(`${name} sampler produces well-formed compositions`, () => {
    const sampler = SAMPLERS[name]!;
    for (const seats of SEATS) {
      const compositions = sampler.sample(seats, 30, 99);
      assert.equal(compositions.length, 30);
      for (const composition of compositions) {
        assert.equal(composition.length, seats, "wrong seat count");
        assert.equal(
          new Set(composition).size,
          seats,
          "a kingdom must not appear twice in one composition",
        );
        for (const k of composition) {
          assert.ok(
            (KINGDOM_IDS as readonly string[]).includes(k),
            `unknown kingdom ${k}`,
          );
        }
        // Canonical order keeps composition keys stable across samplers.
        assert.deepEqual(composition, [...composition].sort());
      }
    }
  });

  test(`${name} sampler observes every kingdom`, () => {
    // A kingdom that never appears has no FFA reading at all, which is worse
    // than a noisy one because it is silently absent rather than uncertain.
    const counts = coverageOf(SAMPLERS[name]!.sample(4, 60, 7));
    for (const kingdom of KINGDOM_IDS) {
      assert.ok((counts[kingdom] ?? 0) > 0, `${name} never sampled ${kingdom}`);
    }
  });
}

test("coverage-balanced sampling beats random on representation", () => {
  // The whole reason coverage sampling exists: uniform random leaves some
  // kingdoms materially under-observed at realistic budgets.
  const budget = 100;
  const balanced = coverageQuality(coverageSampler.sample(4, budget, 42), 4);
  const uniform = coverageQuality(randomSampler.sample(4, budget, 42), 4);
  assert.ok(
    balanced.max - balanced.min <= 1,
    `coverage spread should be ≤1, got ${balanced.min}-${balanced.max}`,
  );
  assert.ok(
    balanced.stdDev < uniform.stdDev,
    `coverage (σ=${balanced.stdDev.toFixed(2)}) should be more even than random (σ=${uniform.stdDev.toFixed(2)})`,
  );
});

test("stratified sampling spreads co-occurrence, not just appearances", () => {
  // Equal appearances still permit a lopsided sample: a kingdom can appear the
  // right number of times while always facing the same neighbours.
  const budget = 100;
  const strat = coverageQuality(stratifiedSampler.sample(4, budget, 42), 4);
  assert.ok(strat.max - strat.min <= 2, "appearances should stay near-balanced");
  assert.equal(
    strat.pairsSeen,
    strat.pairsPossible,
    "stratified should reach every kingdom pairing at this budget",
  );
});

test("the diagnostic sampler is driven by context, never by hardcoded kingdoms", () => {
  // Which kingdoms look extreme is a property of the balance configuration
  // under test — a Balance AI candidate may make an entirely different set
  // extreme, so nothing may be baked in.
  const neutral = diagnosticSampler.sample(4, 60, 11);
  const unweighted = coverageSampler.sample(4, 60, 11);
  assert.deepEqual(
    neutral,
    unweighted,
    "with no context the diagnostic sampler must degrade to coverage sampling",
  );

  const focus: KingdomId = "dark";
  const weighted = diagnosticSampler.sample(4, 60, 11, { priority: { [focus]: 4 } });
  const before = coverageOf(neutral)[focus] ?? 0;
  const after = coverageOf(weighted)[focus] ?? 0;
  assert.ok(after > before, `expected ${focus} to be sampled more (${before} → ${after})`);
  // Everyone else must still be observed — a focused sample is not a blind one.
  for (const kingdom of KINGDOM_IDS) {
    assert.ok((coverageOf(weighted)[kingdom] ?? 0) > 0, `${kingdom} was starved`);
  }
});

test("exhaustive sampling enumerates the space when the budget allows", () => {
  const all = exhaustiveSampler.sample(4, 5000, samplerSeed("validation", 4));
  assert.equal(all.length, compositionSpace(4));
  assert.equal(new Set(all.map((c) => c.join(","))).size, all.length);
});

// --- integration with the evaluator ----------------------------------------

const samplerConfig = (sampler: string, workers: number): EvaluationConfig => ({
  balanceConfigId: `sampler-${sampler}`,
  pool: "validation",
  workers,
  duel: { enabled: false },
  ffa4: { enabled: true, seedsPerPairing: 1, compositions: 2, sampler },
  ffa7: { enabled: false },
  now: () => "1970-01-01T00:00:00.000Z",
});

test("the planned sample is independent of worker count", () => {
  // Sampling happens during planning, so execution can never perturb it.
  for (const sampler of NAMES) {
    const cfg = { enabled: true, compositions: 12, sampler };
    const a = planCompositions(4, cfg, "validation");
    const b = planCompositions(4, cfg, "validation");
    assert.deepEqual(a, b);
    // A different pool must draw a different sample, or the pools are not
    // independent evidence.
    assert.notDeepEqual(a, planCompositions(4, cfg, "final"));
  }
});

test("sampler identity and coverage are recorded in the reading", async () => {
  const result = await evaluate(samplerConfig("stratified", 2));
  const ffa = result.ffa4!;
  assert.equal(ffa.sampler, "stratified");
  assert.equal(ffa.samplerVersion, stratifiedSampler.version);
  assert.ok(ffa.coverageQuality.space === compositionSpace(4));
  assert.ok(ffa.coverageQuality.compositions === 2);
  // Reproducing a sample later requires knowing exactly what was sampled.
  assert.equal(ffa.compositions.length, 2);
  const parsed = JSON.parse(toJson(result));
  assert.equal(parsed.ffa4.samplerVersion, stratifiedSampler.version);
});

test("seat occupancy is reported so rotation can be checked", async () => {
  const result = await evaluate({
    ...samplerConfig("coverage", 2),
    ffa4: { enabled: true, seedsPerPairing: 1, compositions: 4, sampler: "coverage" },
  });
  const seats = result.ffa4!.seats_;
  assert.ok(Object.keys(seats).length > 0);
  for (const [kingdom, stats] of Object.entries(seats)) {
    assert.equal(stats.appearances.length, 4, `${kingdom}: wrong seat vector`);
    assert.equal(stats.meanPlacement.length, 4);
    const total = stats.appearances.reduce((a, b) => a + b, 0);
    assert.ok(total > 0, `${kingdom} never played`);
    // Rotation should spread a kingdom across seats rather than pinning it.
    assert.ok(
      stats.appearances.filter((n) => n > 0).length > 1,
      `${kingdom} only ever occupied one seat`,
    );
  }
});

test("changing sampler changes the reading, and worker count does not", async () => {
  const coverage4 = await evaluate(samplerConfig("coverage", 4));
  const coverage1 = await evaluate(samplerConfig("coverage", 1));
  const strip = (r: unknown) =>
    JSON.stringify(
      JSON.parse(toJson(r as never), (k, v) =>
        k === "durationMs" ? 0 : k === "execution" ? undefined : v,
      ),
    );
  assert.equal(strip(coverage4), strip(coverage1), "worker count must not matter");

  const stratified = await evaluate(samplerConfig("stratified", 4));
  assert.notEqual(
    JSON.stringify(stratified.ffa4!.compositions),
    JSON.stringify(coverage4.ffa4!.compositions),
    "different samplers should choose different compositions",
  );
});
