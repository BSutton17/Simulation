import { test } from "node:test";
import assert from "node:assert/strict";
import { KINGDOM_IDS } from "../src/data/kingdoms.js";
import {
  POPULATION_V1,
  SEED_POOLS,
  allCombinations,
  allDuelPairings,
  compare,
  comparabilityProblem,
  coverageOf,
  coverageSampler,
  evaluate,
  hashParameterSet,
  orderedPairings,
  placementStats,
  poolsDisjoint,
  rate,
  reportText,
  seatProfiles,
  seedsFor,
  spreadOf,
  toJson,
  wilson,
  type EvaluationResult,
} from "../simulation/src/evaluation/index.js";

/**
 * Balance evaluation system (Step 4).
 *
 * The evaluator is a measuring instrument, so these tests are mostly about the
 * properties that make a measurement trustworthy: reproducibility, disjoint
 * seed pools, honest sample sizes, and a refusal to compare readings taken
 * against different engines.
 */

/**
 * The smallest evaluation that still exercises the population aggregate: one
 * matchup over all 36 ordered pairings. Kept deliberately lean because most
 * tests below run several evaluations and each match is a full game.
 */
const smallConfig = () => ({
  balanceConfigId: "test",
  pool: "validation" as const,
  duel: { enabled: true, seedsPerPairing: 1, pairings: allDuelPairings().slice(0, 1) },
  ffa4: { enabled: false },
  ffa7: { enabled: false },
  now: () => "1970-01-01T00:00:00.000Z",
});

/** Adds the free-for-all formats, for the tests that need them. */
const ffaConfig = () => ({
  ...smallConfig(),
  ffa4: { enabled: true, seedsPerPairing: 1, compositions: 1 },
});

// --- population -------------------------------------------------------------

test("the strategy population is versioned and covers the shipped profiles", () => {
  assert.ok(POPULATION_V1.version.length > 0);
  assert.equal(POPULATION_V1.profiles.length, 6);
  for (const id of ["aggressive", "defensive", "economic", "opportunistic", "balanced", "random"]) {
    assert.ok(
      POPULATION_V1.profiles.some((p) => p.id === id),
      `population is missing "${id}"`,
    );
  }
});

test("pairings are ORDERED and include mirrors", () => {
  const pairings = orderedPairings(POPULATION_V1);
  // n^2, not the n(n+1)/2 of unordered combinations: A-vs-B differs from B-vs-A
  // because the controllers, seat order and RNG streams all differ.
  assert.equal(pairings.length, 36);
  assert.ok(pairings.some((p) => p.key === "aggressive/defensive"));
  assert.ok(pairings.some((p) => p.key === "defensive/aggressive"));
  assert.equal(pairings.filter((p) => p.mirror).length, 6);
});

test("FFA seats alternate the pairing's strategies", () => {
  const pairing = { a: "aggressive", b: "defensive", key: "x", mirror: false };
  assert.deepEqual(seatProfiles(pairing, 2), ["aggressive", "defensive"]);
  assert.deepEqual(seatProfiles(pairing, 4), [
    "aggressive", "defensive", "aggressive", "defensive",
  ]);
});

// --- seeds ------------------------------------------------------------------

test("seed pools never overlap", () => {
  // Training and validation sharing a seed would let an optimizer search
  // against the dice it is later judged on.
  assert.ok(
    poolsDisjoint(["fire-vs-water", "ice-vs-earth"], ["balanced/balanced", "aggressive/random"], 12),
  );
});

test("seeds are deterministic in every input", () => {
  const a = seedsFor("training", "fire-vs-water", "balanced/balanced", 5);
  const b = seedsFor("training", "fire-vs-water", "balanced/balanced", 5);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, seedsFor("validation", "fire-vs-water", "balanced/balanced", 5));
  assert.notDeepEqual(a, seedsFor("training", "ice-vs-earth", "balanced/balanced", 5));
  assert.notDeepEqual(a, seedsFor("training", "fire-vs-water", "aggressive/random", 5));
  assert.equal(new Set(a).size, a.length, "seeds within one unit must be distinct");
});

test("all three pools exist", () => {
  assert.deepEqual([...SEED_POOLS], ["training", "validation", "final"]);
});

// --- statistics -------------------------------------------------------------

test("confidence intervals distinguish small samples from large ones", () => {
  const small = rate(45, 100);
  const large = rate(4500, 10000);
  assert.equal(small.rate.toFixed(2), large.rate.toFixed(2));
  const smallWidth = small.ci95[1] - small.ci95[0];
  const largeWidth = large.ci95[1] - large.ci95[0];
  assert.ok(
    smallWidth > largeWidth * 5,
    `expected the 100-match interval to be far wider: ${smallWidth} vs ${largeWidth}`,
  );
});

test("the interval stays meaningful at the extremes", () => {
  // A normal approximation collapses to zero width at 0/n; Wilson does not,
  // and 0-win matchups are exactly what balance evaluation must describe.
  const [low, high] = wilson(0, 108);
  assert.equal(low, 0);
  assert.ok(high > 0 && high < 0.05, `expected a small positive upper bound, got ${high}`);
  const [lo2, hi2] = wilson(108, 108);
  assert.ok(lo2 > 0.95 && lo2 < 1);
  assert.ok(hi2 >= 1 - 1e-9, `upper bound should reach 1, got ${hi2}`);
});

test("placement stats summarise a distribution", () => {
  const s = placementStats([1, 1, 2, 4, 4], 4);
  assert.equal(s.matches, 5);
  assert.equal(s.average, (1 + 1 + 2 + 4 + 4) / 5);
  assert.deepEqual(s.distribution, [2, 1, 0, 2]);
  assert.equal(s.first.count, 2);
  assert.equal(s.last.count, 2);
});

test("spread captures profile disagreement", () => {
  const s = spreadOf([0, 0.5, 1]);
  assert.equal(s.min, 0);
  assert.equal(s.max, 1);
  assert.equal(s.spread, 1);
  assert.equal(s.mean, 0.5);
  assert.equal(s.samples, 3);
});

// --- samplers ---------------------------------------------------------------

test("combination counts match the kingdom roster", () => {
  assert.equal(allDuelPairings().length, 120); // C(16,2)
  assert.equal(allCombinations(4).length, 1820); // C(16,4)
  assert.equal(allCombinations(7).length, 11440); // C(16,7)
});

test("the coverage sampler keeps kingdom appearances balanced", () => {
  const compositions = coverageSampler.sample(4, 32, 1234);
  assert.equal(compositions.length, 32);
  const counts = Object.values(coverageOf(compositions));
  assert.equal(counts.length, KINGDOM_IDS.length);
  // Uniform random sampling routinely starves a kingdom at this sample size,
  // which shows up downstream as a kingdom whose FFA numbers are noise.
  assert.ok(
    Math.max(...counts) - Math.min(...counts) <= 1,
    `appearances should differ by at most one, got ${Math.min(...counts)}–${Math.max(...counts)}`,
  );
});

test("samplers are deterministic in their seed", () => {
  assert.deepEqual(coverageSampler.sample(7, 10, 99), coverageSampler.sample(7, 10, 99));
  assert.notDeepEqual(coverageSampler.sample(7, 10, 99), coverageSampler.sample(7, 10, 100));
});

// --- evaluation -------------------------------------------------------------

test("an evaluation aggregates over the whole strategy population", async () => {
  const result = await evaluate(ffaConfig());
  const pairings = orderedPairings(POPULATION_V1).length;

  assert.equal(result.duel!.matchups.length, 1);
  for (const m of result.duel!.matchups) {
    // The aggregate must be pooled over every ordered pairing — the entire
    // point of the population metric.
    assert.equal(m.aggregate.total, pairings);
    assert.equal(Object.keys(m.byPairing).length, pairings);
    assert.ok(m.profileSpread.samples === pairings);
  }
  assert.ok(result.ffa4!.matches > 0);
  assert.equal(result.ffa7, null);
  assert.equal(result.population.version, POPULATION_V1.version);
});

test("evaluation is reproducible: same inputs, identical reading", async () => {
  const a = await evaluate(smallConfig());
  const b = await evaluate(smallConfig());
  // Everything except wall-clock duration must match byte for byte.
  const strip = (r: EvaluationResult) =>
    JSON.parse(toJson(r), (key, value) => (key === "durationMs" ? 0 : value));
  assert.deepEqual(strip(a), strip(b));
});

test("baseline versus baseline shows no difference", async () => {
  const a = await evaluate(smallConfig());
  const b = await evaluate(smallConfig());
  const diff = compare(a, b);
  assert.equal(diff.incomparable, null);
  for (const d of Object.values(diff.duel!.kingdoms)) {
    assert.equal(d.deltaPp, 0);
    assert.equal(d.separated, false);
  }
  assert.equal(diff.duel!.significant.length, 0);
});

test("a candidate configuration is evaluated through the same path", async () => {
  const baseline = await evaluate(smallConfig());
  // A deliberately large change, purely to prove the plumbing carries it.
  const candidate = await evaluate({
    ...smallConfig(),
    balanceConfigId: "candidate",
    balance: { "castle.startingHp": 4000 },
  });
  assert.equal(candidate.provenance.balanceConfigId, "candidate");
  assert.notEqual(candidate.provenance.balanceConfigHash, "baseline");
  // Shorter castles end matches sooner; the reading should notice something.
  assert.notEqual(
    candidate.totals.ticks,
    baseline.totals.ticks,
    "a materially different balance should produce a different reading",
  );
  const diff = compare(baseline, candidate);
  assert.equal(diff.incomparable, null);
  assert.equal(diff.duel!.matchups.length, baseline.duel!.matchups.length);
});

test("production balance data is never mutated by an evaluation", async () => {
  const before = await evaluate(smallConfig());
  await evaluate({ ...smallConfig(), balance: { "castle.startingHp": 1234 } });
  const after = await evaluate(smallConfig());
  assert.equal(
    before.provenance.balanceBaselineHash,
    after.provenance.balanceBaselineHash,
  );
  assert.equal(before.totals.ticks, after.totals.ticks);
});

// --- provenance -------------------------------------------------------------

test("every reading records the engine it was taken against", async () => {
  const result = await evaluate(smallConfig());
  const p = result.provenance;
  assert.ok(p.engineSha.length > 0);
  assert.ok(p.balanceBaselineHash.length > 0);
  assert.equal(p.kingdomCount, KINGDOM_IDS.length);
  assert.equal(p.strategyPopulationVersion, POPULATION_V1.version);
  assert.equal(typeof p.engineDirty, "boolean");
});

test("readings from different engines refuse to be compared", async () => {
  const a = await evaluate(smallConfig());
  const b = await evaluate(smallConfig());
  const stale = {
    ...b,
    provenance: { ...b.provenance, engineSha: "0000000000000000000000000000000000000000" },
  };
  const diff = compare(a, stale);
  assert.ok(
    diff.incomparable && diff.incomparable.includes("engine"),
    `expected a refusal naming the engine, got ${diff.incomparable}`,
  );
});

test("parameter sets hash stably and order-independently", () => {
  assert.equal(hashParameterSet(null), "baseline");
  assert.equal(hashParameterSet({}), "baseline");
  assert.equal(
    hashParameterSet({ a: 1, b: 2 }),
    hashParameterSet({ b: 2, a: 1 }),
  );
  assert.notEqual(hashParameterSet({ a: 1 }), hashParameterSet({ a: 2 }));
});

test("comparability ignores the configuration under test", async () => {
  const a = await evaluate(smallConfig());
  const b = await evaluate({ ...smallConfig(), balanceConfigId: "other" });
  // Different candidate, same engine and population — comparison is the whole
  // point, so this must be allowed.
  assert.equal(comparabilityProblem(a.provenance, b.provenance), null);
});

// --- output -----------------------------------------------------------------

test("the reading serialises to JSON an optimizer can consume", async () => {
  const result = await evaluate(ffaConfig());
  const parsed = JSON.parse(toJson(result)) as EvaluationResult;
  assert.equal(parsed.provenance.balanceConfigId, "test");
  assert.equal(parsed.duel!.matchups.length, result.duel!.matchups.length);
  assert.ok(parsed.duel!.matchups[0]!.aggregate.ci95.length === 2);
  assert.ok(parsed.ffa4!.coverage);
});

test("the human report describes without judging", async () => {
  const text = reportText(await evaluate(smallConfig()));
  assert.ok(text.includes("BALANCE EVALUATION"));
  assert.ok(text.includes("Observed win rate by kingdom"));
  // Neutral language is a deliberate contract: the evaluator has no access to
  // design intent, so it must not label anything a problem.
  for (const banned of ["overpowered", "underpowered", "broken", "nerf", "buff "]) {
    assert.ok(
      !text.toLowerCase().includes(banned),
      `report should avoid the judgement word "${banned}"`,
    );
  }
});
