import { test } from "node:test";
import assert from "node:assert/strict";
import { describeParameter } from "../simulation/src/index.js";

/**
 * The optimizer works on opaque catalog ids; describeParameter turns them into
 * designer-facing names for the progress console and reports. It derives names
 * from the ability/passive data registries (no hardcoded kingdom knowledge).
 */

test("ability effect fields read as '<Ability> <Field>'", () => {
  assert.equal(describeParameter("ability.fireball.effects.0.amount"), "Fireball Damage");
  assert.equal(describeParameter("ability.waterBall.effects.0.amount"), "Water Ball Damage");
  assert.equal(describeParameter("ability.fireball.cost"), "Fireball Cost");
  assert.equal(describeParameter("ability.fireball.cooldownTicks"), "Fireball Cooldown");
  assert.equal(describeParameter("ability.fireball.unlockCost"), "Fireball Unlock Cost");
});

test("charge and upgrade fields read naturally", () => {
  assert.equal(
    describeParameter("ability.lightningBarrage.charge.damage.1"),
    "Lightning Barrage Charge 2 Damage",
  );
  assert.equal(
    describeParameter("ability.lightningBarrage.charge.costPerCharge"),
    "Lightning Barrage Cost per Charge",
  );
  assert.equal(
    describeParameter("ability.fireball.upgrade.1.cost"),
    "Fireball Upgrade 1 Cost",
  );
});

test("global engine constants have fixed friendly names", () => {
  assert.equal(describeParameter("castle.repairCost"), "Repair Cost");
  assert.equal(describeParameter("economy.incomePerCitizen"), "Income per Citizen");
  assert.equal(describeParameter("shield.cost"), "Shield Cost");
  assert.equal(describeParameter("combat.baseCritChance"), "Crit Chance");
});

test("passives are named by their engine primitive, not a raw field", () => {
  // passive.water.0 is { type: 'incomePerCitizen', amount: 0.0675 }.
  assert.equal(describeParameter("passive.water.0.amount"), "Water Income Per Citizen");
  // A field that adds information is appended.
  assert.equal(
    describeParameter("passive.ice.2.chance"),
    "Ice Retaliation Chance",
  );
});

test("unknown ids fall back to a title-cased form rather than throwing", () => {
  assert.equal(describeParameter("some.future.knob"), "Some Future Knob");
});
