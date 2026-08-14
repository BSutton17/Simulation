import { test } from "node:test";
import assert from "node:assert/strict";
import { KINGDOM_IDS } from "../src/data/kingdoms.js";
import { KINGDOM_ABILITIES } from "../src/data/kingdomAbilities.js";
import {
  WEIGHT_PRESETS,
  abilityCoverage,
  compareCoverage,
  coverageText,
  type CoverageCheckpoint,
  scoreFitness,
  syntheticEvaluation,
  totalAbilities,
  type SyntheticSpec,
} from "../simulation/src/fitness/index.js";
import { runSimulation } from "../simulation/src/index.js";
import { buildSchema, searchable } from "../simulation/src/search/index.js";

/**
 * The search objective (Step 9) and the ability-coverage health check.
 *
 * Step 8 measured the problem these tests exist to prevent: the capped verdict
 * pinned every candidate to 0.6000, so CMA-ES had no gradient and burned
 * 114,588 matches learning nothing. The fix separates what a human reads from
 * what a search climbs — without changing what counts as balanced.
 */

const spec = (
  id: string,
  duel: number,
  ffa4: number,
  ffa7: number,
  extra: Partial<SyntheticSpec> = {},
): SyntheticSpec => ({ id, duelImbalance: duel, ffa4Imbalance: ffa4, ffa7Imbalance: ffa7, ...extra });

const score = (s: SyntheticSpec) =>
  scoreFitness(syntheticEvaluation(s), { weights: WEIGHT_PRESETS.designerPriority });

// --- the objective ------------------------------------------------------------

test("the search objective is the penalised score without the cap", () => {
  const f = score(spec("base", 0.5, 0.5, 0.5));
  assert.ok(
    Math.abs(f.searchObjective - (f.weightedScore - f.penalty)) < 1e-9,
    "searchObjective must be weightedScore minus penalty",
  );
  // The penalty is still fully applied — this is not a weaker definition of
  // balance, only a continuous one.
  if (f.violations.length > 0) assert.ok(f.penalty > 0);
});

test("the objective stays continuous exactly where the verdict flattens", () => {
  // This is the Step 8 failure, reproduced as a regression test: several
  // clearly different games, all capped to the same verdict.
  //
  // The imbalance is deliberately MILD with a single forced outlier, which is
  // the shape the real baseline has: healthy enough that the uncapped score
  // sits above the cap, so the cap is what flattens them. Pile on enough
  // imbalance and the score sinks below the cap on its own, at which point
  // nothing is being capped and the effect disappears.
  const games = [
    score(spec("a", 0.1, 0.1, 0.1, { duelOutlier: { kingdom: "dark", winRate: 0.02 } })),
    score(spec("b", 0.2, 0.15, 0.15, { duelOutlier: { kingdom: "dark", winRate: 0.05 } })),
    score(spec("c", 0.3, 0.2, 0.2, { duelOutlier: { kingdom: "dark", winRate: 0.08 } })),
  ];
  for (const g of games) assert.ok(g.capped, "each game must actually be capped");
  const verdicts = new Set(games.map((g) => g.overall.toFixed(6)));
  const objectives = new Set(games.map((g) => g.searchObjective.toFixed(6)));
  assert.equal(verdicts.size, 1, "all three should hit the same cap — that is the point");
  assert.ok(
    objectives.size > 1,
    "the search objective must distinguish games the verdict cannot",
  );
});

test("fixing violations raises the objective monotonically", () => {
  // Progressively less broken games, all still violating something.
  const worst = score(spec("worst", 0.95, 0.95, 0.95));
  const middle = score(spec("middle", 0.7, 0.7, 0.7));
  const best = score(spec("best", 0.45, 0.45, 0.45));
  assert.ok(
    best.searchObjective > middle.searchObjective,
    `${best.searchObjective} should beat ${middle.searchObjective}`,
  );
  assert.ok(middle.searchObjective > worst.searchObjective);
  // Fewer violations should also mean a smaller penalty.
  assert.ok(best.violations.length <= worst.violations.length);
});

test("worsening the game lowers the objective", () => {
  const before = score(spec("before", 0.4, 0.4, 0.4));
  const after = score(spec("after", 0.8, 0.8, 0.8));
  assert.ok(after.searchObjective < before.searchObjective);
});

test("the capped verdict remains authoritative and unchanged", () => {
  // Mild imbalance plus one forced outlier: good enough that the uncapped score
  // clears the cap, so the cap is doing the work.
  const violating = score(
    spec("violating", 0.15, 0.1, 0.1, { duelOutlier: { kingdom: "dark", winRate: 0.03 } }),
  );
  assert.ok(violating.violations.length > 0);
  assert.ok(violating.capped, "a violating candidate must still be capped");
  assert.ok(
    violating.overall <= 0.6 + 1e-9,
    "the verdict must not exceed the violation cap",
  );
  // A promising direction is not the same as an acceptable game.
  assert.ok(
    violating.searchObjective > violating.overall,
    "the objective may exceed the verdict; that is the whole point",
  );
});

test("a clean game scores identically under both", () => {
  // With nothing violated there is no cap and no penalty, so the two must agree
  // — otherwise the objective would be a different metric rather than the same
  // one with the discontinuity removed.
  const clean = score(spec("clean", 0.05, 0.05, 0.05));
  assert.equal(clean.violations.length, 0);
  assert.equal(clean.capped, false);
  assert.ok(Math.abs(clean.overall - clean.searchObjective) < 1e-9);
});

test("the objective is bounded and deterministic", () => {
  for (const imbalance of [0, 0.5, 1]) {
    const f = score(spec(`b-${imbalance}`, imbalance, imbalance, imbalance));
    assert.ok(f.searchObjective >= 0 && f.searchObjective <= 1);
    const again = score(spec(`b-${imbalance}`, imbalance, imbalance, imbalance));
    assert.equal(f.searchObjective, again.searchObjective);
  }
});

test("the optimizer still cannot reach the fitness rules", () => {
  // Changing the search signal must not have opened a door to the thresholds.
  const forbidden = [
    "duelwinratebound", "ffafirstfloorratio", "ffalastceilingratio",
    "violationcap", "penaltyperviolation", "catastrophicformat", "weight",
  ];
  for (const p of searchable(buildSchema())) {
    for (const f of forbidden) {
      assert.ok(!p.id.toLowerCase().includes(f), `${p.id} exposes a fitness rule`);
    }
  }
});

// --- ability coverage -----------------------------------------------------------

test("the ability catalogue is the expected size", () => {
  const total = totalAbilities();
  const counted = KINGDOM_IDS.reduce(
    (n, k) => n + KINGDOM_ABILITIES[k].filter((a) => a.kind !== "passive").length,
    0,
  );
  assert.equal(total, counted);
  assert.equal(total, 80, "16 kingdoms x 5 activatable abilities");
});

test("coverage is measured from real match telemetry", () => {
  // Derived from telemetry the evaluator already collects, so a checkpoint is
  // effectively free on any run that has telemetry enabled.
  const result = runSimulation({
    matches: 4,
    seed: "coverage-test",
    players: [{ kingdomId: "water" }, { kingdomId: "fire" }],
    telemetry: true,
  });
  const report = abilityCoverage(result.records.map((r) => r.telemetry!));
  assert.equal(report.total, 80);
  assert.equal(report.matches, 4);
  assert.ok(report.used > 0 && report.used < report.total);
  assert.ok(report.fraction > 0 && report.fraction < 1);

  // Only the two kingdoms that played can have used anything.
  for (const k of report.byKingdom) {
    if (k.kingdomId !== "water" && k.kingdomId !== "fire") {
      assert.equal(k.used, 0, `${k.kingdomId} never played but shows usage`);
    }
  }
  const water = report.byKingdom.find((k) => k.kingdomId === "water")!;
  assert.ok(water.used > 0, "water played and should have cast something");
  assert.equal(water.total, 5);
});

test("usage bands separate reachable from understood", () => {
  // An ability cast once in hundreds of matches is reachable, not a staple;
  // reporting them identically would overstate how much of the game the
  // evaluator actually observes.
  const result = runSimulation({
    matches: 4, seed: "bands", players: [{ kingdomId: "nature" }, { kingdomId: "ice" }],
    telemetry: true,
  });
  const report = abilityCoverage(result.records.map((r) => r.telemetry!));
  for (const a of report.abilities) {
    if (a.casts === 0) assert.equal(a.band, "never");
    else assert.notEqual(a.band, "never");
  }
  assert.ok(report.abilities.some((a) => a.band === "never"), "expected unused abilities");
});

const checkpoint = (used: number, over: Partial<CoverageCheckpoint> = {}): CoverageCheckpoint => ({
  used,
  total: 80,
  matches: 400,
  balanceConfigHash: "base",
  seedLabel: "cov",
  ...over,
});

test("a coverage regression is flagged, not silently accepted", () => {
  assert.equal(compareCoverage(checkpoint(63), checkpoint(63)).regression, null);
  assert.equal(
    compareCoverage(checkpoint(63), checkpoint(61)).regression,
    null,
    "small drift is tolerated",
  );
  const drop = compareCoverage(checkpoint(63), checkpoint(52));
  assert.ok(drop.regression?.includes("regression"), `expected a warning, got ${drop.regression}`);
});

test("coverage readings taken under different conditions are not compared", () => {
  // This is the Step 10 smoke-test mistake: a baseline reading held up against
  // a reading taken under a candidate's parameters, reported as a -5 regression.
  const across = compareCoverage(checkpoint(66, { balanceConfigHash: "cand" }), checkpoint(61));
  assert.equal(across.comparable, false);
  assert.equal(across.regression, null, "must not claim a regression across balance configs");
  assert.equal(across.delta, null);
  assert.match(across.caveat ?? "", /different balance/);

  const seeds = compareCoverage(checkpoint(66, { seedLabel: "other" }), checkpoint(61));
  assert.equal(seeds.comparable, false);
  assert.match(seeds.caveat ?? "", /different seeds/);
});

test("a thin sample cannot support a regression claim", () => {
  const thin = { matches: 24 };
  const drop = compareCoverage(checkpoint(66, thin), checkpoint(52, thin));
  assert.equal(drop.regression, null, "24 matches cannot establish a coverage regression");
  assert.match(drop.caveat ?? "", /too thin/);
  assert.equal(drop.delta, -14, "the delta is still reported, just not as a verdict");

  // The same drop on an adequate sample IS a regression.
  assert.ok(compareCoverage(checkpoint(66), checkpoint(52)).regression);
});

test("coverage never reaches the fitness score", () => {
  // Rewarding coverage directly would let the optimizer buy a better score by
  // making abilities cheap enough to spam, trading balance for a diagnostic.
  const f = score(spec("x", 0.4, 0.4, 0.4));
  const serialised = JSON.stringify(f);
  for (const term of ["coverage", "abilityCoverage", "abilitiesUsed"]) {
    assert.ok(!serialised.includes(term), `fitness leaked "${term}"`);
  }
});

test("the coverage report reads as a diagnostic", () => {
  const result = runSimulation({
    matches: 2, seed: "text", players: [{ kingdomId: "joker" }, { kingdomId: "dark" }],
    telemetry: true,
  });
  const report = abilityCoverage(result.records.map((r) => r.telemetry!));
  const text = coverageText(report);
  assert.ok(text.includes("diagnostic, never part of fitness"));
  assert.ok(text.includes("By kingdom"));
  assert.ok(text.includes("Usage bands"));
  // A two-match sample must say so rather than present its total as a finding.
  assert.match(text, /below the \d+ needed for a stable count/);
});
