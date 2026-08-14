import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";
import {
  activateAbility,
  resolveAbility,
  type AbilityDefinition,
} from "../src/engine/abilities.js";
import { earn } from "../src/engine/money.js";
import { getStatus, processStatusTicks } from "../src/engine/status.js";
import { withParameterSet } from "../src/engine/parameters.js";
import { listParameters } from "../src/engine/parameterCatalog.js";
import { recalcIncome } from "../src/engine/economy.js";
import { buyCitizen, repairCastle, buyShield } from "../src/engine/purchases.js";
import {
  SLUDGE,
  ACID_RAIN,
  GASTRO_ACID,
  POISON_APPLE,
  TOXIC_GAS,
} from "../src/data/natureAbilities.js";

const player = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

/** Starts a match with one player per kingdom id given, in order (p0, p1, …). */
function garden(kingdoms: string[]): { match: Match; players: PlayerState[] } {
  const match = new Match("1234");
  kingdoms.forEach((k, i) => match.addPlayer(player(`p${i}`, k)));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  const players = kingdoms.map((_, i) => gs.getPlayer(`p${i}`)!);
  for (const p of players) earn(p, 100_000);
  return { match, players };
}

/** A plain 1000-damage attack for driving thorns/apple scenarios. */
const strike: AbilityDefinition = {
  id: "strike",
  kind: "attack",
  cost: 0,
  cooldownTicks: 0,
  targeting: { mode: "singleEnemy" },
  effects: [{ type: "damage", target: "target", params: { amount: 1000 } }],
};

// --- Passives -----------------------------------------------------------------------

test("Gardener's Gift: Nature begins with 15 citizens instead of 10", () => {
  const { players } = garden(["nature", "fire"]);
  const [a, b] = players;
  assert.equal(a.economy.citizens, 15);
  assert.equal(b.economy.citizens, 10);
  recalcIncome(a);
  assert.equal(a.economy.incomePerTick, 0.9); // 15 x $0.04
});

test("No Rose Without Thorns: attackers risk reflected damage", () => {
  const { match, players } = garden(["nature", "nature"]);
  const [a, b] = players;

  // Roll succeeds (0.0 < 0.2): 25% of the 1000 dealt comes back.
  activateAbility(match, b, strike, { targetId: "p0", forceCrit: false, rng: () => 0.0 });
  assert.equal(a.castle.hp, a.castle.maxHp - 1000);
  assert.equal(b.castle.hp, b.castle.maxHp - 250);

  // Roll fails (0.99 >= 0.2): no reflection.
  const bHp = b.castle.hp;
  b.cooldowns = {};
  activateAbility(match, b, strike, { targetId: "p0", forceCrit: false, rng: () => 0.99 });
  assert.equal(b.castle.hp, bHp);
});

// --- Sludge & Poison ----------------------------------------------------------------

test("Sludge poisons; Poison refreshes rather than stacking on its own", () => {
  const { match, players } = garden(["nature", "fire"]);
  const [a, b] = players;

  activateAbility(match, a, SLUDGE, { targetId: "p1", forceCrit: false });
  assert.equal(b.castle.hp, b.castle.maxHp - 250);
  const poison = getStatus(b, "poison");
  assert.ok(poison);
  assert.equal(poison.remainingTicks, 60); // 3 s
  assert.equal(poison.stacks, 1);

  b.castle.hp = 10_000;
  processStatusTicks(match.gameState!);
  assert.equal(b.castle.hp, 10_000 - 3); // weak poison 3.5/tick → 4 (rounded)

  // Without Corroded, a second application only refreshes.
  a.cooldowns = {};
  activateAbility(match, a, SLUDGE, { targetId: "p1", forceCrit: false });
  assert.equal(getStatus(b, "poison")!.stacks, 1);
});

test("Poison ramps up the longer it festers (unlike Fire's flat Burn)", () => {
  const { match, players } = garden(["nature", "fire"]);
  const [a, b] = players;
  activateAbility(match, a, SLUDGE, { targetId: "p1", forceCrit: false });

  // A fresh poison tick is light.
  b.castle.hp = 10_000;
  processStatusTicks(match.gameState!);
  const early = 10_000 - b.castle.hp;

  // Fast-forward ~3 seconds of ticking; the same poison now bites harder.
  for (let i = 0; i < 3 * 20; i++) processStatusTicks(match.gameState!);
  b.castle.hp = 10_000;
  processStatusTicks(match.gameState!);
  const late = 10_000 - b.castle.hp;

  assert.ok(late > early, `poison should ramp up: early ${early}, late ${late}`);
});

// --- Acid Rain & Corroded -----------------------------------------------------------

test("Corroded amplifies Poison damage and makes it stack", () => {
  const { match, players } = garden(["nature", "fire"]);
  const [a, b] = players;

  activateAbility(match, a, SLUDGE, { targetId: "p1", forceCrit: false });
  a.cooldowns = {};
  activateAbility(match, a, ACID_RAIN, { targetId: "p1", forceCrit: false });
  assert.equal(getStatus(b, "corroded")!.remainingTicks, 160); // 8 s

  // Poison ticks 25% harder while Corroded: 3.5 x 1.25 = 4.375 -> 4.
  b.castle.hp = 10_000;
  processStatusTicks(match.gameState!);
  assert.equal(b.castle.hp, 10_000 - 4);

  // And future Poison now stacks: 2 stacks tick 7 x 1.25 = 8.75 -> 9.
  a.cooldowns = {};
  activateAbility(match, a, SLUDGE, { targetId: "p1", forceCrit: false });
  assert.equal(getStatus(b, "poison")!.stacks, 2);
  b.castle.hp = 10_000;
  processStatusTicks(match.gameState!);
  assert.equal(b.castle.hp, 10_000 - 8);
});

// --- Gastro Acid --------------------------------------------------------------------

test("Gastro Acid applies strong Poison and can poison citizens (income $0.80 -> $0.64)", () => {
  const { match, players } = garden(["nature", "fire"]);
  const [a, b] = players;

  // Citizen roll succeeds (0.4 < 0.5).
  activateAbility(match, a, GASTRO_ACID, { targetId: "p1", forceCrit: false, rng: () => 0.4 });
  assert.equal(b.castle.hp, b.castle.maxHp - 450);
  assert.equal(getStatus(b, "poison")!.remainingTicks, 100); // 5 s
  assert.ok(getStatus(b, "poisonedCitizens"));

  // Strong poison: 7/tick.
  b.castle.hp = 10_000;
  processStatusTicks(match.gameState!);
  assert.equal(b.castle.hp, 10_000 - 4);

  // Poisoned citizens: income is reduced by the Poisoned Citizens debuff.
  recalcIncome(b);
  assert.equal(b.economy.incomePerTick, 0.3);
});

test("status.poison.tickDamage is a catalog knob that scales Poison DoT", () => {
  // The balance assistant points at "poison scaling"; this is the tunable lever.
  const knob = listParameters().find((p) => p.id === "status.poison.tickDamage");
  assert.ok(knob, "poison DoT multiplier is in the catalog");
  assert.equal(knob!.base, 1); // a multiplier, neutral at 1

  const { match, players } = garden(["nature", "fire"]);
  const [a, b] = players;
  activateAbility(match, a, GASTRO_ACID, { targetId: "p1", forceCrit: false, rng: () => 0.4 });

  // Strong poison ticks for 7; a 0.5 multiplier scales it to round(3.5) = 4,
  // preserving the variant while scaling every poison together.
  b.castle.hp = 10_000;
  withParameterSet({ "status.poison.tickDamage": 0.5 }, () => {
    processStatusTicks(match.gameState!);
  });
  assert.equal(b.castle.hp, 10_000 - 2);

  // Production (no active set) is unaffected — full 7.
  b.castle.hp = 10_000;
  processStatusTicks(match.gameState!);
  assert.equal(b.castle.hp, 10_000 - 4);
});

// --- Poison Apple -------------------------------------------------------------------

test("Poison Apple: the next kingdom to attack Nature is immediately Poisoned", () => {
  const { match, players } = garden(["nature", "nature"]);
  const [a, b] = players;

  activateAbility(match, a, POISON_APPLE);
  assert.ok(getStatus(a, "poisonApple"));

  // b bites: guaranteed strong Poison (5 s), mark consumed. (rng 0.99 also
  // proves it isn't the thorns roll doing this.)
  activateAbility(match, b, strike, { targetId: "p0", forceCrit: false, rng: () => 0.99 });
  const poison = getStatus(b, "poison");
  assert.ok(poison);
  assert.equal(poison.remainingTicks, 100); // 5 s
  assert.ok(!getStatus(a, "poisonApple")); // consumed on use

  b.castle.hp = 10_000;
  processStatusTicks(match.gameState!);
  assert.equal(b.castle.hp, 10_000 - 4); // strong poison

  // The biter's citizens are poisoned too (income sapped) for the same window.
  assert.ok(getStatus(b, "poisonedCitizens"));
});

// --- Toxic Gas ----------------------------------------------------------------------

test("Toxic Gas poisons every enemy through shields and blocks citizen/repair purchases", () => {
  const { match, players } = garden(["nature", "fire", "water"]);
  const [a, b, c] = players;

  const r = activateAbility(match, a, TOXIC_GAS);
  assert.equal(r.ok, true);

  for (const p of [b, c]) {
    assert.equal(getStatus(p, "poison")!.remainingTicks, 200); // 10 s
    assert.equal(getStatus(p, "toxicGas")!.remainingTicks, 200);
    assert.equal(buyCitizen(match, p).error, "PURCHASES_BLOCKED"); // water included
    p.castle.hp -= 500;
    assert.equal(repairCastle(match, p).error, "PURCHASES_BLOCKED");
  }

  // Shields are still purchasable — and the poison ignores them anyway.
  assert.equal(buyShield(match, b).ok, true);
  const shieldAfterBuy = b.castle.shield;
  const hpBefore = b.castle.hp;
  processStatusTicks(match.gameState!);
  assert.equal(b.castle.hp, hpBefore - 5); // straight to HP
  assert.equal(b.castle.shield, shieldAfterBuy); // shield untouched

  // Nature itself is unaffected.
  assert.equal(buyCitizen(match, a).ok, true);
});

// --- Nature Ability Upgrades ----------------------------------------------------------

test("Nature upgrade tiers resolve their overrides", () => {
  // Sludge: standard damage/cooldown path.
  const sl = resolveAbility(SLUDGE, 3);
  assert.equal(sl.effects[0].params.amount, 350);
  assert.equal(sl.cooldownTicks, 54);

  // Acid Rain: Lv2 damage, Lv3 Corroded duration, Lv4 CD, Lv5 amp +50%.
  const ar = resolveAbility(ACID_RAIN, 4);
  assert.equal(ar.effects[0].params.amount, 450);
  assert.equal(ar.effects[1].params.durationTicks, 240); // 12 s
  assert.equal(ar.cooldownTicks, 180); // 9 s
  assert.equal(ar.effects[1].params.status?.modifiers?.[0].value, 1.5);

  // Gastro Acid: Lv2 damage, Lv3 citizen chance, Lv4 CD, Lv5 poison duration.
  const ga = resolveAbility(GASTRO_ACID, 4);
  assert.equal(ga.effects[0].params.amount, 550);
  assert.equal(ga.effects[2].chance, 0.75);
  assert.equal(ga.effects[1].params.durationTicks, 140); // 7 s
  assert.equal(ga.cooldownTicks, 270); // 13.5 s

  // Poison Apple: Lv2 poison duration on the biter, Lv3 CD.
  const pa = resolveAbility(POISON_APPLE, 2);
  assert.equal(pa.effects[0].params.status?.onHitRetaliate?.durationTicks, 140); // 7 s
  assert.equal(pa.cooldownTicks, 425);

  // Toxic Gas: Lv2 durations, Lv3 CD.
  const tg = resolveAbility(TOXIC_GAS, 2);
  assert.equal(tg.effects[0].params.durationTicks, 260); // 13 s
  assert.equal(tg.effects[1].params.durationTicks, 260);
  assert.equal(tg.cooldownTicks, 1530);
});
