import { test } from "node:test";
import assert from "node:assert/strict";
import {
  param,
  setActiveParameterSet,
  getActiveParameterSet,
  withParameterSet,
} from "../src/engine/parameters.js";
import { listParameters } from "../src/engine/parameterCatalog.js";
import { CASTLE, SHIELD } from "../src/data/balance.js";
import { resolveAbility } from "../src/engine/abilities.js";
import { computeIncome } from "../src/engine/economy.js";
import { repairCastle, repairCost, buyShield } from "../src/engine/purchases.js";
import { earn } from "../src/engine/money.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";
import { FIREBALL } from "../src/data/fireAbilities.js";
import { LIGHTNING_BARRAGE } from "../src/data/electricityAbilities.js";
import { runSimulation } from "../simulation/src/index.js";

/**
 * Ticket #202 — the balance parameter registry: every tunable flows through
 * `param`, alternate parameter sets change simulated gameplay without touching
 * production data, and no active set means production behavior exactly.
 */

const player = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

function duel(kingdomA = "fire", kingdomB = "water") {
  const match = new Match("1234");
  match.addPlayer(player("a", kingdomA));
  match.addPlayer(player("b", kingdomB));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const state = match.gameState!;
  return { match, a: state.getPlayer("a")!, b: state.getPlayer("b")! };
}

test("param returns base values when no set is active", () => {
  assert.equal(getActiveParameterSet(), null);
  assert.equal(param("economy.incomePerCitizen", 0.04), 0.04);
  assert.equal(param("anything.at.all", 42), 42);
});

test("withParameterSet scopes overrides and always restores", () => {
  const result = withParameterSet({ "x.y": 7 }, () => param("x.y", 1));
  assert.equal(result, 7);
  assert.equal(param("x.y", 1), 1); // restored

  // Restores even when the body throws.
  assert.throws(() =>
    withParameterSet({ "x.y": 7 }, () => {
      throw new Error("boom");
    }),
  );
  assert.equal(getActiveParameterSet(), null);
});

test("ability values resolve through the registry (damage, cost, cooldown)", () => {
  // Production baseline.
  const base = resolveAbility(FIREBALL, 0);
  assert.equal(base.effects[0]!.params.amount, 250);
  assert.equal(base.cost, 100);

  withParameterSet(
    {
      "ability.fireball.effects.0.amount": 999,
      "ability.fireball.cost": 60,
      "ability.fireball.cooldownTicks": 10,
    },
    () => {
      const tuned = resolveAbility(FIREBALL, 0);
      assert.equal(tuned.effects[0]!.params.amount, 999);
      assert.equal(tuned.cost, 60);
      assert.equal(tuned.cooldownTicks, 10);
    },
  );

  // Upgrade tiers still layer on top of overridden bases.
  withParameterSet({ "ability.fireball.cost": 200 }, () => {
    const lv2 = resolveAbility(FIREBALL, 2); // tier 2 = cooldown cut + 15% price cut
    assert.equal(lv2.cost, Math.floor(200 * 0.85));
  });
});

test("charge-system values resolve through the registry", () => {
  withParameterSet(
    {
      "ability.lightningBarrage.charge.damage.2": 900,
      "ability.lightningBarrage.charge.costPerCharge": 50,
    },
    () => {
      const tuned = resolveAbility(LIGHTNING_BARRAGE, 0);
      assert.deepEqual(tuned.chargeSystem?.damageByCharges, [230, 475, 900]);
      assert.equal(tuned.chargeSystem?.costPerCharge, 50);
    },
  );
});

test("economy and passive values resolve through the registry", () => {
  const { a, b } = duel("fire", "water");

  // Baseline: fire earns the base rate, water its passive override.
  assert.equal(computeIncome(a), 0.6); // 10 × 0.04
  assert.equal(computeIncome(b), 0.675); // 10 × 0.0675 (We're In This Together)

  withParameterSet(
    {
      "economy.incomePerCitizen": 0.05,
      "passive.water.0.amount": 0.1,
    },
    () => {
      assert.equal(computeIncome(a), 0.5); // 10 × 0.05
      assert.equal(computeIncome(b), 1); // 10 × 0.1
    },
  );
});

test("repair and shield values resolve through the registry", () => {
  const { match, a } = duel();
  earn(a, 100_000);
  a.castle.hp = 1;

  withParameterSet(
    { "castle.maxRepairs": 1, "castle.repairCost": 10, "shield.standardHp": 123 },
    () => {
      assert.equal(repairCost(a), 10);
      assert.equal(repairCastle(match, a).ok, true);
      // The tuned cap of 1 is spent — the second repair is refused.
      assert.equal(repairCastle(match, a).error, "REPAIR_LIMIT");

      assert.equal(buyShield(match, a).ok, true);
      assert.equal(a.castle.shield, 123);
    },
  );
});

test("the catalog enumerates the tunable space with production bases", () => {
  const params = listParameters();
  const byId = new Map(params.map((p) => [p.id, p.base]));

  // Globals.
  assert.equal(byId.get("economy.incomePerCitizen"), 0.06);
  assert.equal(byId.get("castle.repairCost"), CASTLE.REPAIR_COST);
  assert.equal(byId.get("castle.maxRepairs"), CASTLE.MAX_REPAIRS);
  assert.equal(byId.get("shield.cost"), SHIELD.COST);

  // Ability values — including charges, unlocks, and upgrade prices.
  assert.equal(byId.get("ability.fireball.effects.0.amount"), 250);
  assert.equal(byId.get("ability.lightningBarrage.unlockCost"), 100);
  assert.equal(byId.get("ability.lightningBarrage.charge.damage.1"), 475);
  assert.equal(byId.get("ability.fireball.upgrade.1.cost"), 150);

  // Passive values, discovered generically.
  assert.equal(byId.get("passive.water.0.amount"), 0.0675);

  // No duplicate ids — every parameter is uniquely addressable.
  assert.equal(byId.size, params.length);
  // The space is substantial (7 kingdoms × 5 abilities × many values).
  assert.ok(params.length > 200, `expected a large catalog, got ${params.length}`);
});

test("simulations run under alternate balance configurations deterministically", () => {
  const config = {
    matches: 2,
    seed: "candidate-1",
    players: [{ kingdomId: "fire" as const }, { kingdomId: "water" as const }],
  };

  // A candidate that strengthens basic attacks and thins the castles should
  // still be perfectly reproducible…
  const candidate = {
    ...config,
    parameters: {
      "ability.fireball.effects.0.amount": 800,
      "ability.waterBall.effects.0.amount": 800,
      "economy.incomePerCitizen": 0.06,
      // Much lower castle HP guarantees a shorter match regardless of the
      // economy — bigger attacks alone don't, because Water's lifesteal scales
      // with damage and can prolong a fight.
      "castle.startingHp": 2500,
    },
  };
  const a = runSimulation(candidate);
  const b = runSimulation(candidate);
  assert.deepEqual(a.records, b.records);

  // …and actually change outcomes relative to the production baseline.
  const baseline = runSimulation(config);
  assert.notDeepEqual(baseline.records, a.records);
  // Thinner castles (plus stronger attacks) end matches sooner.
  assert.ok(a.totalTicks < baseline.totalTicks);

  // The run left no overrides behind: production reads bases again.
  assert.equal(getActiveParameterSet(), null);
  assert.equal(param("economy.incomePerCitizen", 0.04), 0.04);
});

test("production stays on base values after simulation runs (leak guard)", () => {
  setActiveParameterSet(null); // belt and braces for test isolation
  const { a } = duel();
  assert.equal(computeIncome(a), 0.6);
  assert.equal(resolveAbility(FIREBALL, 0).effects[0]!.params.amount, 250);
});
