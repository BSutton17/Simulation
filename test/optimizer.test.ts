import { test } from "node:test";
import assert from "node:assert/strict";
import {
  optimize,
  balanceObjective,
  matchDurationObjective,
  matrixParityScore,
  listParameters,
  getActiveParameterSet,
  param,
  type BatchAnalytics,
  type MatchupMatrix,
  type PlayerSpec,
} from "../simulation/src/index.js";
import { resolveAbility } from "../src/engine/abilities.js";
import { FIREBALL } from "../src/data/fireAbilities.js";

/**
 * Ticket #208 — the automated balance optimizer: generates candidates, runs
 * batches, evaluates the objective, preserves improvements, and never touches
 * production balance data.
 */

const DUEL: PlayerSpec[] = [{ kingdomId: "fire" }, { kingdomId: "fire" }];

/**
 * Two levers with a strong, smooth effect on match duration in this matchup
 * (measured: baseline ≈ 14.9k ticks; doubling income + halving HP ≈ 6.2k).
 * The objective wants 6k-tick matches, so there is clear room to improve.
 */
const DURATION_LEVERS = ["castle.startingHp", "economy.incomePerCitizen"];

test("optimization consistently improves the configured objective", () => {
  const result = optimize({
    seed: "optimize-1",
    iterations: 8,
    matchesPerBatch: 3,
    players: DUEL,
    maxTicks: 20_000,
    objective: matchDurationObjective(6_000),
    parameterIds: DURATION_LEVERS,
    mutationScale: 0.5,
  });

  // Improvements were found and preserved.
  assert.ok(
    result.bestScore < result.baselineScore,
    `expected improvement: ${result.bestScore} vs baseline ${result.baselineScore}`,
  );
  assert.ok(result.history.some((h) => h.accepted), "no candidate accepted");

  // The best score is monotonically non-increasing across iterations —
  // improvements are preserved, regressions rejected.
  let previous = result.baselineScore;
  for (const step of result.history) {
    assert.ok(step.bestScore <= previous, "best score regressed");
    if (step.accepted) assert.equal(step.bestScore, step.score);
    previous = step.bestScore;
  }

  // Candidates only touch the configured search space.
  for (const id of Object.keys(result.best)) {
    assert.ok(DURATION_LEVERS.includes(id), `unexpected parameter tuned: ${id}`);
  }
});

test("optimization is deterministic per seed", () => {
  const config = {
    seed: "optimize-repro",
    iterations: 3,
    matchesPerBatch: 2,
    players: DUEL,
    maxTicks: 6_000,
    objective: matchDurationObjective(3_000),
    parameterIds: DURATION_LEVERS,
  };
  const a = optimize(config);
  const b = optimize(config);
  assert.deepEqual(a.best, b.best);
  assert.deepEqual(a.history, b.history);
  assert.equal(a.bestScore, b.bestScore);
});

test("the optimizer never modifies production balance", () => {
  const baselineCatalog = listParameters();

  optimize({
    seed: 77,
    iterations: 2,
    matchesPerBatch: 2,
    players: DUEL,
    maxTicks: 3_000,
    objective: matchDurationObjective(3_000),
    parameterIds: DURATION_LEVERS,
  });

  // No parameter set left active; production reads base values.
  assert.equal(getActiveParameterSet(), null);
  assert.equal(param("castle.startingHp", 10_000), 10_000);
  assert.equal(param("economy.incomePerCitizen", 0.0275), 0.0275);
  assert.equal(resolveAbility(FIREBALL, 0).effects[0]!.params.amount, 250);
  // The catalog's production bases are untouched.
  assert.deepEqual(listParameters(), baselineCatalog);
});

test("unknown parameter ids are rejected up front", () => {
  assert.throws(
    () =>
      optimize({
        seed: 1,
        iterations: 1,
        matchesPerBatch: 1,
        players: DUEL,
        parameterIds: ["ability.doesNotExist.cost"],
      }),
    /Unknown parameter id/,
  );
});

test("the canonical balance objective scores parity, duration, and timeouts", () => {
  const synthetic = (
    winRates: number[],
    averageDurationTicks: number,
    timeouts = 0,
  ): BatchAnalytics => ({
    matches: 10,
    timeouts,
    totalTicks: averageDurationTicks * 10,
    averageDurationTicks,
    minDurationTicks: averageDurationTicks,
    maxDurationTicks: averageDurationTicks,
    kingdoms: Object.fromEntries(
      winRates.map((winRate, i) => [
        `k${i}`,
        { kingdomId: `k${i}`, matches: 10, wins: winRate * 10, winRate } as never,
      ]),
    ),
  });

  const objective = balanceObjective({ durationBand: { min: 2_000, max: 10_000 } });

  // Perfect parity inside the band scores zero.
  assert.equal(objective.evaluate(synthetic([0.5, 0.5], 5_000)), 0);
  // Skewed win rates score worse than parity.
  assert.ok(
    objective.evaluate(synthetic([0.9, 0.1], 5_000)) >
      objective.evaluate(synthetic([0.6, 0.4], 5_000)),
  );
  // Out-of-band durations and timeouts add penalties.
  assert.ok(objective.evaluate(synthetic([0.5, 0.5], 20_000)) > 0);
  assert.ok(
    objective.evaluate(synthetic([0.5, 0.5], 5_000, 5)) >
      objective.evaluate(synthetic([0.5, 0.5], 5_000, 0)),
  );
});

test("each iteration reports labelled changes and before/after metrics", () => {
  const seen: string[] = [];
  const result = optimize({
    seed: "optimize-progress",
    iterations: 8,
    matchesPerBatch: 3,
    players: DUEL,
    maxTicks: 20_000,
    objective: matchDurationObjective(6_000),
    parameterIds: DURATION_LEVERS,
    mutationScale: 0.5,
    onIteration: (r) => r.changes.forEach((c) => seen.push(c.label)),
  });

  // Every history entry carries the enriched payload the CLI renders.
  for (const step of result.history) {
    // Changes name the mutated parameter and its before → after values.
    for (const change of step.changes) {
      assert.ok(DURATION_LEVERS.includes(change.id), `unexpected id ${change.id}`);
      assert.notEqual(change.from, change.to, "a change must actually move the value");
      assert.equal(typeof change.label, "string");
      assert.ok(change.label.length > 0);
    }
    // Metrics and the "before" reference both expose win rates + duration.
    assert.equal(typeof step.metrics.averageDurationTicks, "number");
    assert.equal(typeof step.previous.averageDurationTicks, "number");
    assert.ok("fire" in step.metrics.winRates);
    assert.ok("fire" in step.previous.winRates);
    // An accepted step's reported score matches the running best.
    if (step.accepted) assert.equal(step.metrics.score, step.score);
  }

  // Human-readable labels were produced (e.g. "Castle Starting HP").
  assert.ok(seen.some((l) => l === "Castle Starting HP" || l === "Income per Citizen"));
});

test("matrixParityScore is zero for a balanced field and grows with skew", () => {
  const mk = (ab: number): MatchupMatrix => ({
    kingdoms: ["a", "b"],
    winRates: { a: { a: 0.5, b: ab }, b: { a: 1 - ab, b: 0.5 } },
    matchesPerPair: 10,
    timeouts: 0,
  });
  assert.equal(matrixParityScore(mk(0.5)), 0); // perfectly balanced
  assert.ok(matrixParityScore(mk(1)) > matrixParityScore(mk(0.7))); // more skew, worse
});

test("matrix-mode optimization scores candidates on the round-robin", () => {
  // The optimizer evaluates each candidate on the full duel matrix (not one
  // match), so a field-dominant kingdom is actually visible to the objective.
  const result = optimize({
    seed: "matrix-opt",
    iterations: 4,
    matchesPerBatch: 3,
    players: [], // ignored in matrix mode
    matrix: { kingdoms: ["nature", "fire"], matchesPerPair: 3 },
    parameterIds: ["status.poison.tickDamage"],
    mutationScale: 0.7,
  });
  assert.ok(Number.isFinite(result.baselineScore));
  assert.ok(result.bestScore <= result.baselineScore + 1e-9, "never worse than baseline");
  // Aggregate duel analytics are attached (win rates present for the report).
  assert.ok(Object.keys(result.analytics.kingdoms).length >= 1);
});
