import { test } from "node:test";
import assert from "node:assert/strict";
import {
  optimize,
  matchDurationObjective,
  listParameters,
  type OptimizationAlgorithm,
  type ParameterSet,
  type PlayerSpec,
} from "../simulation/src/index.js";

/**
 * Ticket #209 — optimization algorithms & constraints: hill climbing,
 * simulated annealing, and genetic search share one constrained mutation
 * core, and configured constraints hold for EVERY evaluated candidate.
 */

const DUEL: PlayerSpec[] = [{ kingdomId: "fire" }, { kingdomId: "fire" }];
const LEVERS = ["castle.startingHp", "economy.incomePerCitizen"];
const ALGORITHMS: OptimizationAlgorithm[] = ["hillClimb", "annealing", "genetic"];

test("every algorithm improves the configured objective", () => {
  for (const algorithm of ALGORITHMS) {
    const result = optimize({
      seed: `improve-${algorithm}`,
      algorithm,
      iterations: algorithm === "genetic" ? 3 : 8,
      matchesPerBatch: 2,
      players: DUEL,
      maxTicks: 20_000,
      objective: matchDurationObjective(6_000),
      parameterIds: LEVERS,
      mutationScale: 0.5,
      genetic: { populationSize: 4, elites: 1 },
    });
    assert.equal(result.algorithm, algorithm);
    assert.ok(
      result.bestScore < result.baselineScore,
      `${algorithm}: expected improvement, got ${result.bestScore} vs ${result.baselineScore}`,
    );
    // Best score never regresses across the history.
    let previous = result.baselineScore;
    for (const step of result.history) {
      assert.ok(step.bestScore <= previous, `${algorithm}: best regressed`);
      previous = step.bestScore;
    }
  }
});

test("every evaluated candidate respects min/max limits and locked parameters", () => {
  const constraints = {
    parameters: {
      "castle.startingHp": { min: 8_000, max: 12_000 },
      "economy.incomePerCitizen": { locked: true },
      "ability.fireball.effects.0.amount": { min: 200, max: 260 },
    },
  };
  const space = [
    "castle.startingHp",
    "economy.incomePerCitizen",
    "ability.fireball.effects.0.amount",
  ];

  for (const algorithm of ALGORITHMS) {
    const evaluated: ParameterSet[] = [];
    optimize({
      seed: `constraints-${algorithm}`,
      algorithm,
      iterations: algorithm === "genetic" ? 2 : 6,
      matchesPerBatch: 1,
      players: DUEL,
      maxTicks: 1_500,
      objective: matchDurationObjective(1_000),
      parameterIds: space,
      constraints,
      mutationScale: 0.9, // violent mutations — the clamps must catch them
      genetic: { populationSize: 4, elites: 1 },
      onEvaluate: (candidate) => evaluated.push({ ...candidate }),
    });

    assert.ok(evaluated.length > 0);
    for (const candidate of evaluated) {
      // Locked parameters are never present (never mutated in).
      assert.equal(
        candidate["economy.incomePerCitizen"],
        undefined,
        `${algorithm}: locked parameter was mutated`,
      );
      const hp = candidate["castle.startingHp"];
      if (hp !== undefined) {
        assert.ok(hp >= 8_000 && hp <= 12_000, `${algorithm}: hp ${hp} out of bounds`);
        assert.ok(Number.isInteger(hp), `${algorithm}: hp not integer`);
      }
      const dmg = candidate["ability.fireball.effects.0.amount"];
      if (dmg !== undefined) {
        assert.ok(dmg >= 200 && dmg <= 260, `${algorithm}: damage ${dmg} out of bounds`);
      }
    }
  }
});

test("zero-priority parameters are never mutated; priorities weight selection", () => {
  const changed = new Set<string>();
  optimize({
    seed: "priority",
    iterations: 12,
    matchesPerBatch: 1,
    players: DUEL,
    maxTicks: 1_000,
    objective: matchDurationObjective(1_000),
    parameterIds: LEVERS,
    constraints: {
      parameters: {
        "castle.startingHp": { priority: 0 }, // excluded from the search
        "economy.incomePerCitizen": { priority: 5 },
      },
    },
    onIteration: (r) => r.changedIds.forEach((id) => changed.add(id)),
  });
  assert.ok(!changed.has("castle.startingHp"), "zero-priority parameter mutated");
  assert.ok(changed.has("economy.incomePerCitizen"));
});

test("locking the entire space is rejected up front", () => {
  assert.throws(
    () =>
      optimize({
        seed: 1,
        iterations: 1,
        matchesPerBatch: 1,
        players: DUEL,
        parameterIds: LEVERS,
        constraints: {
          parameters: {
            "castle.startingHp": { locked: true },
            "economy.incomePerCitizen": { priority: 0 },
          },
        },
      }),
    /No tunable parameters/,
  );
});

test("the full catalog (hundreds of parameters) optimizes under default bounds", () => {
  const catalog = listParameters();
  assert.ok(catalog.length > 200, "expected a large catalog");
  const baseById = new Map(catalog.map((p) => [p.id, p.base]));

  const evaluated: ParameterSet[] = [];
  const result = optimize({
    seed: "full-catalog",
    algorithm: "genetic",
    iterations: 1,
    matchesPerBatch: 1,
    players: DUEL,
    maxTicks: 1_200,
    objective: matchDurationObjective(1_000),
    // No parameterIds: the whole catalog is the search space.
    mutationsPerIteration: 25, // touch many parameters at once
    mutationScale: 0.9,
    genetic: { populationSize: 4, elites: 1 },
    onEvaluate: (candidate) => evaluated.push({ ...candidate }),
  });

  assert.ok(result.history.length === 1);
  // Every mutated value stays inside the default relative envelope
  // (bounds ordered by value — negative bases invert the factors).
  let touched = 0;
  for (const candidate of evaluated) {
    for (const [id, value] of Object.entries(candidate)) {
      const base = baseById.get(id)!;
      const lo = Math.min(base * 0.25, base * 4);
      const hi = Math.max(base * 0.25, base * 4);
      assert.ok(value >= lo - 1e-9, `${id} below default floor`);
      assert.ok(value <= hi + 1e-9, `${id} above default ceiling`);
      touched++;
    }
  }
  assert.ok(touched > 50, "expected wide mutation coverage");
});
