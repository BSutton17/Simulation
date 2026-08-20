import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOCATION_V1, ALLOCATION_V2, ALLOCATIONS, DEFAULT_ALLOCATION,
  allocationFor, tierFor, isAllocationVersion,
  SCREEN_TIER, FULL_TIER, VALIDATION_TIER, buildSchema, searchable,
} from "../simulation/src/search/index.js";
import { planEvaluation, balancedDuelPairings } from "../simulation/src/evaluation/index.js";
import { WEIGHT_PRESETS } from "../simulation/src/fitness/index.js";
import { localIdentity } from "../simulation/src/distributed/identity.js";

/**
 * Balance V3's match-budget split.
 *
 * v1 spent 69.6% of the SCREEN budget on duels for 15% of the fitness weight
 * and 13.0% on 7-FFA for 35%, which put 7-FFA below its own sampling noise.
 * SCREEN is the tier that matters: `cma.tell` runs on screening scores, so the
 * full tier could be perfectly allocated and the search would not notice.
 */

const WEIGHTS = { duel: 0.15, ffa4: 0.5, ffa7: 0.35 } as const;

/** Counts a tier the way the evaluator will actually run it. */
function counts(tier: typeof SCREEN_TIER) {
  const cfg = {
    duel: {
      enabled: true, seedsPerPairing: tier.duelSeeds,
      pairings: tier.duelPairings ? balancedDuelPairings(tier.duelPairings) : undefined,
    },
    ffa4: { enabled: true, seedsPerPairing: tier.ffaSeeds, compositions: tier.ffa4Compositions, sampler: tier.sampler },
    ffa7: { enabled: true, seedsPerPairing: tier.ffaSeeds, compositions: tier.ffa7Compositions, sampler: tier.sampler },
  };
  const by = { duel: 0, ffa4: 0, ffa7: 0 };
  for (const job of planEvaluation(cfg)) by[job.format as keyof typeof by]++;
  return { ...by, total: by.duel + by.ffa4 + by.ffa7 };
}

test("v2 hits the intended per-format budget", () => {
  const full = counts(ALLOCATION_V2.full);
  assert.equal(full.duel, 1008);
  assert.equal(full.ffa4, 2016);
  assert.equal(full.ffa7, 3600);
  assert.equal(full.total, 6624);

  const screen = counts(ALLOCATION_V2.screen);
  assert.equal(screen.duel, 504);
  assert.equal(screen.ffa4, 1008);
  assert.equal(screen.ffa7, 1800);
  assert.equal(screen.total, 3312);
});

test("compute share tracks fitness weight instead of inverting it", () => {
  // The defect: share/weight was 4.64x for duels and 0.37x for 7-FFA. Anything
  // near 1.0 means compute follows importance. 7-FFA is deliberately above 1
  // because its placement statistic carries the most variance per match.
  for (const tier of [ALLOCATION_V2.screen, ALLOCATION_V2.full, ALLOCATION_V2.validation]) {
    const c = counts(tier);
    assert.ok(Math.abs(c.duel / c.total - WEIGHTS.duel) < 0.02, "duel share should sit near its weight");
    assert.ok(c.ffa7 / c.total > WEIGHTS.ffa7, "7-FFA should be over-sampled relative to weight");
    assert.ok(c.ffa7 / c.total > c.duel / c.total, "7-FFA must outrank duels in compute");
  }

  // And the inversion really was there in v1, or this test proves nothing.
  const v1 = counts(ALLOCATION_V1.screen);
  assert.ok(v1.duel / v1.total > 0.6, "v1 screen really did spend most of its budget on duels");
  assert.ok(v1.ffa7 / v1.total < 0.15, "v1 screen really did starve 7-FFA");
});

test("SCREEN — the tier the optimizer learns from — is the one that grew", () => {
  // Fixing FULL alone would leave the search exactly as biased as before.
  const before = counts(ALLOCATION_V1.screen);
  const after = counts(ALLOCATION_V2.screen);
  assert.ok(after.total > before.total, "screen budget must rise, not just be re-split");
  assert.ok(after.ffa7 / before.ffa7 >= 8, "7-FFA screening depth must rise substantially");
});

test("v1 is preserved byte-identical so old runs stay reproducible", () => {
  assert.deepEqual(ALLOCATION_V1.screen, SCREEN_TIER);
  assert.deepEqual(ALLOCATION_V1.full, FULL_TIER);
  assert.deepEqual(ALLOCATION_V1.validation, VALIDATION_TIER);
  assert.equal(counts(ALLOCATION_V1.screen).total, 1656);
  assert.equal(counts(ALLOCATION_V1.full).total, 5760);
  assert.equal(counts(ALLOCATION_V1.validation).total, 21816);
});

test("nothing changes for callers that do not opt in", () => {
  assert.equal(DEFAULT_ALLOCATION, "v1");
  assert.equal(localIdentity().allocation, "v1");
  assert.equal(localIdentity({ allocation: "v2" }).allocation, "v2");
});

test("allocation is deterministic — same name, same plan, every time", () => {
  for (const version of ["v1", "v2"] as const) {
    for (const tier of ["screen", "full", "validation"] as const) {
      const a = counts(tierFor(version, tier));
      const b = counts(tierFor(version, tier));
      assert.deepEqual(a, b);
    }
  }
  // Identical job ids in identical order, not merely identical counts.
  const plan = (n: number) => planEvaluation({
    duel: { enabled: true, seedsPerPairing: 1, pairings: balancedDuelPairings(n) },
    ffa4: { enabled: true, seedsPerPairing: 1, compositions: 28, sampler: "coverage" },
    ffa7: { enabled: true, seedsPerPairing: 1, compositions: 50, sampler: "coverage" },
  }).map((j) => j.id);
  assert.deepEqual(plan(14), plan(14));
});

test("an unknown allocation name fails loudly instead of falling back", () => {
  // A typo in a notebook environment variable must not quietly run v1 and
  // produce numbers nobody can attribute.
  assert.throws(() => allocationFor("v3"), /unknown allocation/);
  assert.throws(() => allocationFor(""), /unknown allocation/);
  assert.ok(isAllocationVersion("v2"));
  assert.ok(!isAllocationVersion("v3"));
  assert.deepEqual(Object.keys(ALLOCATIONS).sort(), ["v1", "v2"]);
});

test("fitness weights are untouched by this change", () => {
  assert.deepEqual(WEIGHT_PRESETS.designerPriority, { ffa4: 0.5, ffa7: 0.35, duel: 0.15 });
});

test("the ability-only search space is 180 dimensions", () => {
  const v2 = buildSchema({ scope: "expanded" });
  assert.equal(v2.version, "v2");
  // 180, not 181: balance v4 removed Poison Apple's permanent-duration
  // sentinel, which was a dimension that could not change the game.
  assert.equal(searchable(v2).length, 180);
  assert.ok(searchable(v2).every((p) => p.id.startsWith("ability.")), "abilities only");
  // The 20 curated passive/system dials must not have crept back in.
  for (const id of ["castle.repairCost", "shield.cost", "passive.nature.0.pct", "economy.incomePerCitizen"]) {
    assert.ok(!searchable(v2).some((p) => p.id === id), `${id} must not be searched`);
  }
});

test("poisonApple's permanent-duration sentinel is no longer searched", () => {
  // Was reported-not-fixed while the v2 allocation experiment needed a stable
  // search space. Balance v4 fixes it: the base is MAX_SAFE_INTEGER, meaning
  // "permanent", so every value in a +/-40% band around it is equally permanent
  // and the search was spending a whole dimension on a number that cannot
  // change the game. It surfaced as 7018891676581419 in one candidate and the
  // literal string "default" in another.
  const dials = searchable(buildSchema({ scope: "expanded" }));
  assert.ok(
    !dials.some((p) => p.id === "ability.poisonApple.effects.0.durationTicks"),
    "the sentinel must not be a search dimension",
  );
  // Its real dials are still searched — only the sentinel is excluded.
  assert.ok(dials.some((p) => p.id === "ability.poisonApple.cost"));
  assert.ok(dials.some((p) => p.id === "ability.poisonApple.cooldownTicks"));
  // And nothing else sentinel-valued crept in.
  assert.equal(dials.filter((p) => p.base >= 2 ** 40).length, 0);
});
