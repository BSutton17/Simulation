import { test } from "node:test";
import assert from "node:assert/strict";
import type { UsageSummary } from "../simulation/src/evaluation/evaluator.js";
import {
  FITNESS_VERSION,
  WEIGHT_PRESETS,
  compareFitness,
  distributionDivergence,
  fitnessText,
  normalisedDeviation,
  penalise,
  scoreFitness,
  syntheticEvaluation,
  type FormatWeights,
  type SyntheticSpec,
} from "../simulation/src/fitness/index.js";

/**
 * Balance fitness (Step 7).
 *
 * Fitness is the only place in the pipeline that holds an opinion, so these
 * tests are about whether that opinion is coherent: does it move the right way,
 * does it respect the stated format priority, and can a catastrophe in one
 * format be averaged away by excellence in another?
 *
 * Scenarios are synthetic on purpose. Proving "fitness rises as the game gets
 * fairer" needs a game whose fairness is known exactly, which no real
 * evaluation can provide.
 */

const spec = (
  id: string,
  duel: number,
  ffa4: number,
  ffa7: number,
  extra: Partial<SyntheticSpec> = {},
): SyntheticSpec => ({
  id,
  duelImbalance: duel,
  ffa4Imbalance: ffa4,
  ffa7Imbalance: ffa7,
  ...extra,
});

const score = (s: SyntheticSpec, weights?: FormatWeights) =>
  scoreFitness(syntheticEvaluation(s), {
    weights: weights ?? WEIGHT_PRESETS.designerPriority,
  });

const formatScore = (f: ReturnType<typeof score>, name: string) =>
  f.formats.find((x) => x.format === name)!.score;

// --- normalisation primitives -----------------------------------------------

test("deviation is normalised against the room available on each side", () => {
  // A first-place rate has far more room above fair share than below it, so
  // scaling by the wrong side would misreport the magnitude.
  const fair = 1 / 7;
  assert.equal(normalisedDeviation(fair, fair), 0);
  assert.equal(normalisedDeviation(0, fair), 1, "never winning is total");
  assert.equal(normalisedDeviation(1, fair), 1, "always winning is total");
  assert.ok(normalisedDeviation(0.5, 0.5) === 0);
  assert.ok(normalisedDeviation(0.75, 0.5) > 0 && normalisedDeviation(0.75, 0.5) < 1);
});

test("the dead band makes healthy asymmetry free", () => {
  // Elementals is not meant to be sixteen identical kingdoms.
  assert.equal(penalise(0.05, 0.1), 0, "inside the band costs nothing");
  assert.equal(penalise(0.1, 0.1), 0, "the boundary costs nothing");
  assert.ok(penalise(0.2, 0.1) > 0, "beyond the band costs something");
  assert.equal(penalise(1, 0.1), 1, "total imbalance is total penalty");
  // Linear beyond the band: quadratic left mid-range imbalance nearly free and
  // gave an optimizer no gradient to climb.
  const a = penalise(0.4, 0.1) - penalise(0.3, 0.1);
  const b = penalise(0.8, 0.1) - penalise(0.7, 0.1);
  assert.ok(Math.abs(a - b) < 1e-9, "growth should be linear beyond the band");
});

test("distribution divergence separates kingdoms with the same mean placement", () => {
  // The real baseline contains this exact case: Joker and Light both average
  // near the fair 4.0 at seven seats, but Joker takes first 18% of the time and
  // Light only 9.5%. Mean placement alone calls them equivalent.
  const uniform = [100, 100, 100, 100, 100, 100, 100];
  const swingy = [250, 60, 60, 60, 60, 60, 250];
  const central = [20, 80, 200, 300, 200, 80, 20];
  assert.ok(distributionDivergence(uniform) < 0.01);
  assert.ok(distributionDivergence(swingy) > distributionDivergence(uniform));
  assert.ok(distributionDivergence(central) > distributionDivergence(uniform));
});

// --- the six required behaviours --------------------------------------------

test("fitness falls monotonically as the game becomes less fair", () => {
  let previous = Infinity;
  for (const imbalance of [0, 0.15, 0.3, 0.5, 0.7, 1]) {
    const f = score(spec(`imb-${imbalance}`, imbalance, imbalance, imbalance));
    assert.ok(
      f.overall <= previous + 1e-9,
      `fitness rose from ${previous} to ${f.overall} at imbalance ${imbalance}`,
    );
    previous = f.overall;
  }
  // And the range is usable: a badly skewed game must be clearly separated
  // from a fair one, or an optimizer has nothing to climb.
  const fair = score(spec("fair", 0, 0, 0)).overall;
  const skewed = score(spec("skewed", 0.5, 0.5, 0.5)).overall;
  assert.ok(fair - skewed > 0.05, `too little separation: ${fair} vs ${skewed}`);
});

test("improving every format raises fitness; worsening every format lowers it", () => {
  const base = score(spec("base", 0.4, 0.4, 0.4));
  const better = score(spec("better", 0.2, 0.2, 0.2));
  const worse = score(spec("worse", 0.6, 0.6, 0.6));
  assert.ok(better.overall > base.overall);
  assert.ok(worse.overall < base.overall);
});

test("format priority is 4-FFA > 7-FFA > 1v1 under the calibrated weights", () => {
  // Weights alone do not express priority: the duel score is roughly 1.9x as
  // sensitive to the same imbalance, so 0.5/0.3/0.2 actually ranks 1v1 above
  // 7-FFA. The calibrated preset compensates.
  const base = score(spec("base", 0.4, 0.4, 0.4));
  const gain = (s: SyntheticSpec) => score(s).overall - base.overall;
  const g4 = gain(spec("g4", 0.4, 0.35, 0.4));
  const g7 = gain(spec("g7", 0.4, 0.4, 0.35));
  const gd = gain(spec("gd", 0.35, 0.4, 0.4));
  assert.ok(g4 > g7, `4-FFA (${g4}) should outrank 7-FFA (${g7})`);
  assert.ok(g7 > gd, `7-FFA (${g7}) should outrank 1v1 (${gd})`);
});

test("a catastrophe in one format cannot be hidden by excellence elsewhere", () => {
  const allFair = score(spec("all-fair", 0.05, 0.05, 0.05));
  assert.ok(allFair.overall > 0.95);
  assert.equal(allFair.violations.length, 0);

  // 1v1 carries the LOWEST weight, so weighted averaging alone would let this
  // through. The constraint system must not.
  const duelCatastrophe = score(
    spec("duel-catastrophe", 1, 0.05, 0.05, {
      duelOutlier: { kingdom: "dark", winRate: 0.02 },
    }),
  );
  assert.ok(duelCatastrophe.violations.length > 0, "should raise violations");
  assert.ok(
    duelCatastrophe.overall < 0.7,
    `catastrophic 1v1 still scored ${duelCatastrophe.overall}`,
  );
  assert.ok(duelCatastrophe.capped, "the constraint cap should engage");

  const ffaCatastrophe = score(
    spec("ffa-catastrophe", 0.05, 1, 0.05, {
      ffaOutlier: { format: "ffa4", kingdom: "dark", firstRate: 0.001 },
    }),
  );
  assert.ok(ffaCatastrophe.overall < 0.7);
  assert.ok(
    ffaCatastrophe.violations.some((v) => v.kind === "cannotWin"),
    "a kingdom that cannot win should be named explicitly",
  );
});

test("uncertainty is exposed rather than hidden", () => {
  // A score from 30 samples per kingdom must not present as being as
  // trustworthy as the same score from 3,000.
  const thin = score(spec("thin", 0.3, 0.3, 0.3, { samplesPerKingdom: 30 }));
  const thick = score(spec("thick", 0.3, 0.3, 0.3, { samplesPerKingdom: 3000 }));
  const width = (f: ReturnType<typeof score>) =>
    f.formats.find((x) => x.format === "ffa4")!.uncertaintyPp;
  assert.ok(
    width(thin) > width(thick) * 3,
    `thin sample should report far wider intervals: ${width(thin)} vs ${width(thick)}`,
  );
  assert.ok(thin.formats.every((f) => f.matches > 0), "sample counts must be present");
});

test("identical measurements produce identical fitness", () => {
  const a = score(spec("same", 0.3, 0.3, 0.3));
  const b = score(spec("same", 0.3, 0.3, 0.3));
  assert.equal(a.overall, b.overall);
  assert.deepEqual(
    a.formats.map((f) => f.score),
    b.formats.map((f) => f.score),
  );
});

// --- weights, transparency, provenance --------------------------------------

test("weights are configurable and change the ranking", () => {
  // Candidate A is better at 4-FFA; candidate B is better at 1v1.
  const a = syntheticEvaluation(spec("A", 0.6, 0.1, 0.35));
  const b = syntheticEvaluation(spec("B", 0.1, 0.6, 0.35));
  const under = (w: FormatWeights) =>
    scoreFitness(a, { weights: w }).overall - scoreFitness(b, { weights: w }).overall;
  assert.ok(
    under(WEIGHT_PRESETS.designerPriority!) > 0,
    "FFA-priority weights should prefer the candidate with better 4-FFA",
  );
  assert.ok(
    under({ ffa4: 0.1, ffa7: 0.1, duel: 0.8 }) < 0,
    "duel-heavy weights should prefer the other candidate",
  );
});

test("every score shows its working", () => {
  const f = score(spec("transparent", 0.4, 0.4, 0.4));
  assert.equal(f.formats.length, 3);
  for (const format of f.formats) {
    assert.ok(format.components.length > 0, `${format.format} has no components`);
    // Contribution must actually be score x weight, not an unexplained number.
    assert.ok(Math.abs(format.contribution - format.score * format.weight) < 1e-9);
    for (const c of format.components) {
      assert.ok(c.score >= 0 && c.score <= 1);
      assert.ok(c.fairness.count > 0);
    }
  }
  const text = fitnessText(f);
  assert.ok(text.includes("OVERALL"));
  assert.ok(text.includes("weighted score"));
  assert.ok(text.includes("Diagnostics"));
});

test("diagnostics are reported but never scored", () => {
  const f = score(spec("diag", 0.3, 0.3, 0.3));
  assert.ok(f.diagnostics.strategies.balanced, "strategy performance should be visible");
  assert.ok(f.diagnostics.seatPlacement.ffa7, "seat placement should be visible");
  assert.equal(typeof f.diagnostics.timeoutRate, "number");
  // Strategy dominance and seat effects are properties of the AI and the
  // engine, not of the balance configuration, so they must not move the score.
  const same = score(spec("diag", 0.3, 0.3, 0.3));
  assert.equal(f.overall, same.overall);
});

test("provenance records everything needed to reproduce a score", () => {
  const f = score(spec("prov", 0.3, 0.3, 0.3));
  const p = f.provenance;
  assert.equal(p.fitnessVersion, FITNESS_VERSION);
  assert.equal(p.weightsName, "designerPriority");
  assert.ok(p.engineSha.length > 0);
  assert.ok(p.balanceConfigId === "prov");
  assert.ok(p.totalMatches > 0);
  assert.ok(p.strategyPopulationVersion.length > 0);
  assert.equal(typeof p.engineDirty, "boolean");
});

// --- comparison --------------------------------------------------------------

test("comparison attributes the change to a format", () => {
  const baseline = score(spec("baseline", 0.4, 0.4, 0.4));
  const candidate = score(spec("candidate", 0.4, 0.2, 0.4));
  const c = compareFitness(baseline, candidate);
  assert.equal(c.incomparable, null);
  assert.ok(c.overall.delta > 0);
  const biggest = [...c.formats].sort(
    (x, y) => Math.abs(y.contributionDelta) - Math.abs(x.contributionDelta),
  )[0]!;
  assert.equal(biggest.format, "ffa4", "4-FFA drove the change and should be named");
});

test("scores from different fitness rules refuse to be compared", () => {
  const a = score(spec("a", 0.3, 0.3, 0.3));
  const b = score(spec("b", 0.3, 0.3, 0.3), WEIGHT_PRESETS.equal);
  const c = compareFitness(a, b);
  assert.ok(
    c.incomparable && c.incomparable.includes("weights"),
    `expected a refusal naming the weights, got ${c.incomparable}`,
  );
});

test("identical candidates compare as no change", () => {
  const a = score(spec("x", 0.3, 0.3, 0.3));
  const b = score(spec("x", 0.3, 0.3, 0.3));
  const c = compareFitness(a, b);
  assert.equal(c.overall.delta, 0);
  assert.equal(c.violationsAdded.length, 0);
  assert.equal(c.violationsResolved.length, 0);
  assert.equal(c.meaningful, false);
});

test("format scores are independent of the other formats", () => {
  // Wrecking 1v1 must not move the 4-FFA score; otherwise attribution lies.
  const a = score(spec("a", 0.1, 0.4, 0.4));
  const b = score(spec("b", 0.9, 0.4, 0.4));
  assert.ok(Math.abs(formatScore(a, "ffa4") - formatScore(b, "ffa4")) < 1e-9);
  assert.ok(formatScore(a, "duel") > formatScore(b, "duel"));
});

// ---------------------------------------------------------------------------
// Balance v4: usage terms
//
// The property that matters is not "usage raises the score" — it is that usage
// can NEVER be bought with fairness. v3 scored a materially fairer game in
// which sixteen abilities were never cast and no shield was ever purchased,
// because parity was the only thing measured and a dead ability cannot
// unbalance anything. These pin the shape that fixes it.
// ---------------------------------------------------------------------------

const healthyUsage = (over: Partial<UsageSummary> = {}): UsageSummary => ({
  abilities: {}, abilitiesUsed: 80, abilitiesTotal: 80,
  purchases: { shield: 200 }, shieldsPerMatch: 2, matches: 100, ...over,
});

test("v4: among equally balanced candidates, more usage wins", () => {
  const spec = { id: "fair", duelImbalance: 0.1, ffa4Imbalance: 0.1, ffa7Imbalance: 0.1 };
  const rich = scoreFitness(syntheticEvaluation({ ...spec, usage: healthyUsage() }));
  const poor = scoreFitness(
    syntheticEvaluation({ ...spec, usage: healthyUsage({ abilitiesUsed: 60, shieldsPerMatch: 0 }) }),
  );
  assert.ok(
    rich.searchObjective > poor.searchObjective,
    `usage did not break the tie: ${rich.searchObjective} vs ${poor.searchObjective}`,
  );
  // ...and the balance half is untouched by it.
  assert.equal(rich.weightedScore, poor.weightedScore);
});

test("v4: perfect usage cannot rescue a balance regression", () => {
  // The load-bearing test. A candidate that trades fairness for usage must lose
  // to one that did not, however complete its ability coverage.
  const floor = scoreFitness(
    syntheticEvaluation({ id: "incumbent", duelImbalance: 0.1, ffa4Imbalance: 0.1, ffa7Imbalance: 0.1 }),
  ).weightedScore;

  const honest = scoreFitness(
    syntheticEvaluation({
      id: "honest", duelImbalance: 0.1, ffa4Imbalance: 0.1, ffa7Imbalance: 0.1,
      usage: healthyUsage({ abilitiesUsed: 64, shieldsPerMatch: 1 }),
    }),
    { usage: { balanceFloor: floor } },
  );
  const cheat = scoreFitness(
    syntheticEvaluation({
      id: "cheat", duelImbalance: 0.5, ffa4Imbalance: 0.5, ffa7Imbalance: 0.5,
      usage: healthyUsage(),
    }),
    { usage: { balanceFloor: floor } },
  );

  assert.ok(
    cheat.violations.some((v) => v.kind === "balanceRegression"),
    "trading balance away must register as a violation",
  );
  assert.ok(
    honest.searchObjective > cheat.searchObjective,
    `perfect usage rescued a worse game: ${cheat.searchObjective} vs ${honest.searchObjective}`,
  );
});

test("v4: ability coverage saturates, so spam cannot substitute for reach", () => {
  const spec = { id: "s", duelImbalance: 0.2, ffa4Imbalance: 0.2, ffa7Imbalance: 0.2 };
  // A million casts spread over 60 abilities scores strictly worse than a
  // handful spread over all 80. Reach is the thing, not volume.
  const spam = scoreFitness(
    syntheticEvaluation({ ...spec, usage: healthyUsage({ abilitiesUsed: 60, abilities: { fireball: 1e6 } }) }),
  );
  const reach = scoreFitness(
    syntheticEvaluation({ ...spec, usage: healthyUsage({ abilitiesUsed: 80, abilities: { fireball: 10 } }) }),
  );
  assert.ok(reach.usage.coverage > spam.usage.coverage);
  assert.ok(reach.searchObjective > spam.searchObjective);
});

test("v4: shields are measured, and zero purchases is scored as such", () => {
  const spec = { id: "s", duelImbalance: 0.2, ffa4Imbalance: 0.2, ffa7Imbalance: 0.2 };
  const none = scoreFitness(
    syntheticEvaluation({ ...spec, usage: healthyUsage({ shieldsPerMatch: 0, purchases: {} }) }),
  );
  const some = scoreFitness(syntheticEvaluation({ ...spec, usage: healthyUsage() }));
  assert.equal(none.usage.shields, 0, "no shields bought must score zero on that term");
  assert.equal(some.usage.shields, 1, "hitting the target must score full marks");
  assert.ok(some.searchObjective > none.searchObjective);
});

test("v4: the objective stays inside [0,1] and strictly tracks balance", () => {
  // The first shape tried added usage ON TOP, so a fair game scored 1.15 and
  // clamped to 1.0 — every good candidate flattened to the same number and the
  // search lost resolution exactly where it operates.
  let previous = Infinity;
  for (const imbalance of [0, 0.2, 0.4, 0.6, 0.8]) {
    const r = scoreFitness(
      syntheticEvaluation({
        id: `i${imbalance}`, duelImbalance: imbalance,
        ffa4Imbalance: imbalance, ffa7Imbalance: imbalance,
        usage: healthyUsage(),
      }),
    );
    assert.ok(r.searchObjective >= 0 && r.searchObjective <= 1, "out of range");
    assert.ok(r.searchObjective < previous, `not monotonic at ${imbalance}`);
    previous = r.searchObjective;
  }
});
