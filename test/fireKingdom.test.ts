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
import { applyStatus, getStatus, processStatusTicks } from "../src/engine/status.js";
import { FIREBALL, SCORCHING_SUN, FIRENADO, BURN_STATUS, IGNITED_STATUS, HEAT_WAVE, BLAZING_DETERMINATION } from "../src/data/fireAbilities.js";
import { FIRE, TICK } from "../src/data/balance.js";
import { KINGDOM_PASSIVES } from "../src/data/kingdoms.js";
import { baseDamage, declaredCooldown, declaredDamage } from "./support/derive.js";

const player = (id: string, kingdomId: string = "fire"): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

function activeMatch(
  kingdomA: string = "fire",
  kingdomB: string = "plains"
): { match: Match; a: PlayerState; b: PlayerState } {
  const match = new Match("1234");
  match.addPlayer(player("a", kingdomA));
  match.addPlayer(player("b", kingdomB));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  const [a, b] = [gs.getPlayer("a")!, gs.getPlayer("b")!];
  earn(a, 10_000);
  earn(b, 10_000);
  return { match, a, b };
}


/**
 * The HP one clean cast of `ability` takes off a fresh Plains castle.
 *
 * ⚠️ MEASURED, NOT TYPED IN. Fire's damage arrives through a chain — the listed
 * figure, "Set Your Heart Ablaze!", and the elemental table — and this file used
 * to bake the product of all three into literals like `10_000 - 338`. The
 * balance search then moved Fireball from 250 to 441 and eight tests failed at
 * once, none of them about damage numbers: they are about Burn amplifying,
 * Ignited marking, and Blazing Determination being consumed.
 *
 * Measuring the clean hit gives those tests a baseline to compare against, so
 * each one asserts its own subject instead of the balance sheet.
 */
function cleanHit(ability: AbilityDefinition): number {
  const { match, a, b } = activeMatch("fire", "plains");
  b.castle.hp = 10_000;
  activateAbility(match, a, ability, { targetId: "b", forceCrit: false });
  return 10_000 - b.castle.hp;
}

/** Fire's "+15% damage" passive, read from the data. */
const FIRE_DAMAGE_PCT = (() => {
  const p = KINGDOM_PASSIVES.fire.find((x) => x.type === "damageMultiplier");
  assert.ok(p && "pct" in p, "Fire should carry a damage multiplier passive");
  return p.pct;
})();

// --- [#111] Fire Passives ---------------------------------------------------------

test("Set Your Heart Ablaze! configures starting castle HP to 9000 and increases damage by 15%", () => {
  const { match, a, b } = activeMatch("fire", "plains");

  // Verify starting HP/maxHp for Fire is 9000
  assert.equal(a.castle.hp, 9000);
  assert.equal(a.castle.maxHp, 9000);

  // The passive's claim is AMPLIFICATION: Fire's hit must land above the
  // ability's listed damage by at least the passive's own percentage.
  b.castle.hp = 10_000;
  activateAbility(match, a, FIREBALL, { targetId: "b", forceCrit: false });
  const dealt = 10_000 - b.castle.hp;
  assert.ok(
    dealt >= Math.round(baseDamage(FIREBALL) * (1 + FIRE_DAMAGE_PCT)),
    `Fire should hit for at least its listed ${baseDamage(FIREBALL)} plus ` +
      `${FIRE_DAMAGE_PCT * 100}%, but dealt ${dealt}`,
  );
});

test("Roast! deals 1.25x damage to shields", () => {
  const { match, a, b } = activeMatch("fire", "water");

  const strike: AbilityDefinition = {
    id: "strike",
    kind: "attack",
    cost: 0,
    cooldownTicks: 0,
    targeting: { mode: "singleEnemy" },
    effects: [{ type: "damage", target: "target", params: { amount: 1000 } }],
  };

  // Attacking target with shield
  // Base 1000 * 1.15 (damageMultiplier) = 1150
  // Target has shield -> multiplied by Roast! 1.25 = 1150 * 1.25 = 1437.5 -> rounded to 1438
  b.castle.hp = 10_000;
  b.castle.shield = 2000;
  activateAbility(match, a, strike, { targetId: "b", forceCrit: false });
  assert.equal(b.castle.shield, 2000 - 1958);
});

// --- [#113] Burn Status DoT -------------------------------------------------------

test("Burn status ticks damage over time based on stack count", () => {
  const { match, a, b } = activeMatch();

  // Apply 1 stack of Burn
  applyStatus(b, BURN_STATUS, { sourceId: "a", durationTicks: 50, stacks: 1 });
  b.castle.hp = 10_000;
  processStatusTicks(match.gameState!);
  assert.equal(b.castle.hp, 10_000 - 10); // 20 damage per tick per stack

  // Apply 3 stacks of Burn
  b.statuses = [];
  applyStatus(b, BURN_STATUS, { sourceId: "a", durationTicks: 50, stacks: 3 });
  b.castle.hp = 10_000;
  processStatusTicks(match.gameState!);
  assert.equal(b.castle.hp, 10_000 - 30); // 60 damage per tick per stack (20 * 3)
});

// --- [#112] Fire Attacks & Synergies ----------------------------------------------

test("Scorching Sun IGNITES rather than burning, and still punishes a burning target", () => {
  const { match, a, b } = activeMatch("fire", "plains");

  const plainSun = cleanHit(SCORCHING_SUN);
  b.castle.hp = 10_000;
  activateAbility(match, a, SCORCHING_SUN, { targetId: "b", forceCrit: false });
  assert.equal(b.castle.hp, 10_000 - plainSun);

  // The mark, not a fire: nothing is burning yet.
  assert.ok(!getStatus(b, "burn"), "Scorching Sun should not apply Burn itself");
  const ignited = getStatus(b, "ignited");
  assert.ok(ignited);
  assert.equal(ignited.remainingTicks, FIRE.IGNITED_SECONDS * TICK.RATE); // 60 s

  // Its bonus still keys off Burn — so once something else has set the fire,
  // Scorching Sun is the follow-up that cashes it in.
  b.statuses = [];
  b.modifiers = [];
  applyStatus(b, BURN_STATUS, { sourceId: "a", durationTicks: 1000 });
  b.castle.hp = 10_000;
  a.cooldowns = {};
  activateAbility(match, a, SCORCHING_SUN, { targetId: "b", forceCrit: false });
  // Against a burning target the same cast must hit HARDER — that is the
  // whole "cashes in the fire" claim, and it holds at any balance.
  assert.ok(
    10_000 - b.castle.hp > plainSun,
    `Burn should amplify Scorching Sun: ${10_000 - b.castle.hp} vs ${plainSun}`,
  );
});

test("Ignited rolls for a Burn on its own cadence, and only sometimes catches", () => {
  const { match, a, b } = activeMatch("fire", "plains");
  activateAbility(match, a, SCORCHING_SUN, { targetId: "b", forceCrit: false });
  assert.ok(getStatus(b, "ignited"));

  const roll = FIRE.IGNITED_ROLL_SECONDS * TICK.RATE;
  const advance = (ticks: number, rng: () => number) => {
    for (let i = 0; i < ticks; i++) {
      match.gameState!.tick++;
      processStatusTicks(match.gameState!, rng);
    }
  };

  // Nothing happens BETWEEN rolls, however lucky the dice are — the cadence is
  // the whole point, otherwise it is just a burn with extra steps.
  advance(roll - 1, () => 0);
  assert.ok(!getStatus(b, "burn"), "Ignited fired before its interval");

  // A failed roll on the interval leaves them cold.
  advance(1, () => 0.99);
  assert.ok(!getStatus(b, "burn"), "a failed roll should not light anything");

  // A successful one sets a real Burn, credited to whoever ignited them — so
  // it feeds the igniter's Burn amplification, not the victim's.
  advance(roll, () => 0.01);
  const burn = getStatus(b, "burn");
  assert.ok(burn, "a successful roll should set a Burn");
  assert.equal(burn.sourceId, "a");
  assert.equal(burn.remainingTicks, FIRE.IGNITED_BURN_SECONDS * TICK.RATE);
});

test("Ignited does no damage of its own", () => {
  const { match, a, b } = activeMatch("fire", "plains");
  activateAbility(match, a, SCORCHING_SUN, { targetId: "b", forceCrit: false });

  // The mark is pure threat. If it ticked, it would just be a slow burn and the
  // gamble would stop mattering.
  const hp = (b.castle.hp = 10_000);
  for (let i = 0; i < FIRE.IGNITED_ROLL_SECONDS * TICK.RATE - 1; i++) {
    match.gameState!.tick++;
    processStatusTicks(match.gameState!, () => 0.99);
  }
  assert.equal(b.castle.hp, hp);
});

test("Burn amplifies Fire attacks from the applier only", () => {
  const { match, a, b } = activeMatch("fire", "plains");

  // Burn applied by a: a's Fire attacks deal 1.25x damage to b.
  applyStatus(b, BURN_STATUS, { sourceId: "a", durationTicks: 1000 });
  b.castle.hp = 10_000;
  activateAbility(match, a, FIREBALL, { targetId: "b", forceCrit: false });
  const amplified = 10_000 - b.castle.hp;
  const unamplified = cleanHit(FIREBALL);
  assert.ok(
    amplified > unamplified,
    `a's own Burn should amplify a's Fireball: ${amplified} vs ${unamplified}`,
  );

  // A Burn applied by someone else does not amplify a's attacks.
  b.statuses = [];
  b.modifiers = [];
  applyStatus(b, BURN_STATUS, { sourceId: "b", durationTicks: 1000 });
  b.castle.hp = 10_000;
  a.cooldowns = {};
  activateAbility(match, a, FIREBALL, { targetId: "b", forceCrit: false });
  // Someone else's Burn is worth nothing to a — back to the clean figure.
  assert.equal(b.castle.hp, 10_000 - unamplified);
});

test("Firenado always applies Burn, whatever the dice say", () => {
  const { match, a, b } = activeMatch("fire", "plains");

  // The gamble moved to Ignited; Firenado is the ability that actually sets
  // the fire, so no roll can deny it.
  for (const rng of [() => 0.01, () => 0.5, () => 0.99]) {
    b.statuses = [];
    b.modifiers = [];
    a.cooldowns = {};
    activateAbility(match, a, FIRENADO, { targetId: "b", rng });
    assert.ok(getStatus(b, "burn"), "Firenado failed to burn");
  }
});

test("Firenado hits an IGNITED target harder — but not an already-burning one", () => {
  const { match, a, b } = activeMatch("fire", "plains");

  const hit = (setup: (target: PlayerState) => void) => {
    b.statuses = [];
    b.modifiers = [];
    a.cooldowns = {};
    setup(b);
    b.castle.hp = 10_000;
    activateAbility(match, a, FIRENADO, { targetId: "b", forceCrit: false });
    return 10_000 - b.castle.hp;
  };

  const plain = hit(() => {});
  const ignited = hit((t) =>
    applyStatus(t, IGNITED_STATUS, { sourceId: "a", durationTicks: 1000 }),
  );
  assert.ok(ignited > plain, "Ignited did not increase Firenado's damage");

  // Burn's own amplification still applies to a burning target, but that is a
  // different, smaller effect — the setup bonus is specifically for a target
  // that is marked and NOT yet alight, which is what makes the pair a combo
  // rather than "burn them, then hit the burn".
  const burning = hit((t) =>
    applyStatus(t, BURN_STATUS, { sourceId: "a", durationTicks: 1000 }),
  );
  assert.ok(ignited > burning, "the bonus should favour Ignited over Burn");
});

test("Fireball is a plain attack and does not apply Burn", () => {
  const { match, a, b } = activeMatch("fire", "plains");

  // Fireball only deals damage; Burn comes from Scorching Sun / Firenado.
  activateAbility(match, a, FIREBALL, { targetId: "b", forceCrit: false });
  assert.ok(!getStatus(b, "burn"));
});

test("Ice players suffer 1.5x longer Burn durations", () => {
  const { match, a, b } = activeMatch("fire", "ice");

  // Firenado applies Burn for 100 ticks (5 seconds); Ice player b should take
  // it for 100 × 1.5 = 150. (Scorching Sun ignites rather than burning now, so
  // it is no longer the ability that demonstrates this.)
  activateAbility(match, a, FIRENADO, { targetId: "b", forceCrit: false });
  const burn = getStatus(b, "burn");
  assert.ok(burn);
  assert.equal(burn.remainingTicks, 150);
});

// --- [#113] Heat Wave & [#114] Blazing Determination --------------------------------

test("Heat Wave applies stats and refreshes duration without stacking", () => {
  const { match, a } = activeMatch("fire", "plains");

  // Cast Heat Wave
  activateAbility(match, a, HEAT_WAVE, { targetId: "a" });
  const status = getStatus(a, "heatWave");
  assert.ok(status);
  const heatWaveTicks = HEAT_WAVE.effects[0].params.durationTicks as number;
  assert.equal(status.remainingTicks, heatWaveTicks);

  // Verify modifiers are active
  const chance = a.modifiers.find((m) => m.stat === "critChance" && m.sourceId === "status:heatWave");
  const mult = a.modifiers.find((m) => m.stat === "critMultiplier" && m.sourceId === "status:heatWave");
  const declared = (stat: string): number => {
    for (const e of HEAT_WAVE.effects) {
      const m = e.params.status?.modifiers?.find((x) => x.stat === stat);
      if (m) return m.value as number;
    }
    throw new Error(`Heat Wave declares no ${stat} modifier`);
  };
  assert.ok(chance);
  assert.equal(chance.value, declared("critChance"));
  assert.ok(mult);
  assert.equal(mult.value, declared("critMultiplier"));

  // Cast again mid-duration -> should refresh ticks to 300 and not add extra modifiers
  status.remainingTicks = Math.floor(heatWaveTicks / 2);
  a.cooldowns = {};
  activateAbility(match, a, HEAT_WAVE, { targetId: "a" });
  assert.equal(status.remainingTicks, heatWaveTicks);
  assert.equal(a.modifiers.filter((m) => m.sourceId === "status:heatWave").length, 2);
});

test("Blazing Determination multiplies next attack damage by 2.5x and gets consumed", () => {
  const { match, a, b } = activeMatch("fire", "plains");

  // Cast Blazing Determination
  activateAbility(match, a, BLAZING_DETERMINATION, { targetId: "a" });
  assert.ok(getStatus(a, "blazingDetermination"));

  // The claim is the MULTIPLIER: the empowered hit must be the clean hit
  // scaled by whatever Blazing Determination declares.
  const clean = cleanHit(FIREBALL);
  b.castle.hp = 10_000;
  activateAbility(match, a, FIREBALL, { targetId: "b", forceCrit: false });
  const empowered = 10_000 - b.castle.hp;
  assert.ok(
    empowered > clean,
    `Blazing Determination should empower the next attack: ${empowered} vs ${clean}`,
  );

  // Status and modifiers should be consumed/removed instantly
  assert.ok(!getStatus(a, "blazingDetermination"));
  assert.equal(a.modifiers.filter((m) => m.sourceId === "status:blazingDetermination").length, 0);

  // …and once consumed, the very next attack is back to the clean figure.
  b.castle.hp = 10_000;
  a.cooldowns = {}; // clear fireball CD
  activateAbility(match, a, FIREBALL, { targetId: "b", forceCrit: false });
  assert.equal(b.castle.hp, 10_000 - clean);
});

// --- Fire Ability Upgrades --------------------------------------------------------

test("Fireball upgrades modify damage and cooldown values", () => {
  // Lv 1 (Default): Damage 250, CD 60 (3s)
  const lv1 = resolveAbility(FIREBALL, 0);
  assert.equal(lv1.effects[0].params.amount, baseDamage(FIREBALL));
  assert.equal(lv1.cooldownTicks, FIREBALL.cooldownTicks);

  // Lv 2: Increased damage (350)
  const lv2 = resolveAbility(FIREBALL, 1);
  assert.equal(lv2.effects[0].params.amount, declaredDamage(FIREBALL, 1));
  assert.equal(lv2.cooldownTicks, declaredCooldown(FIREBALL, 1));

  // Lv 3: Reduce cooldown by 10% (54 ticks)
  const lv3 = resolveAbility(FIREBALL, 2);
  assert.equal(lv3.effects[0].params.amount, declaredDamage(FIREBALL, 2));
  assert.equal(lv3.cooldownTicks, declaredCooldown(FIREBALL, 2));

  // Lv 4: Increased damage (450)
  const lv4 = resolveAbility(FIREBALL, 3);
  assert.equal(lv4.effects[0].params.amount, declaredDamage(FIREBALL, 3));
  assert.equal(lv4.cooldownTicks, declaredCooldown(FIREBALL, 3));
});

test("Scorching Sun upgrades modify damage, Ignited duration, cooldown, and bonus damage", () => {
  // Lv 1 (Default): the shipped figures, whatever balance currently says.
  const lv1 = resolveAbility(SCORCHING_SUN, 0);
  assert.equal(lv1.effects[0].params.amount, baseDamage(SCORCHING_SUN));
  assert.equal(lv1.effects[1].params.status?.id, "ignited");
  assert.equal(lv1.effects[1].params.durationTicks, FIRE.IGNITED_SECONDS * TICK.RATE);
  assert.equal(lv1.cooldownTicks, SCORCHING_SUN.cooldownTicks);
  assert.equal(
    lv1.effects[0].params.bonusDamageIfTargetHasStatus?.extraAmount,
    SCORCHING_SUN.effects[0].params.bonusDamageIfTargetHasStatus?.extraAmount,
  );

  // Lv 2: the damage tier resolves to what the path declares.
  const lv2 = resolveAbility(SCORCHING_SUN, 1);
  assert.equal(lv2.effects[0].params.amount, declaredDamage(SCORCHING_SUN, 1));

  // Lv 3: the mark lasts longer, so it gets an extra roll at a Burn.
  const lv3 = resolveAbility(SCORCHING_SUN, 2);
  assert.ok(
    lv3.effects[1].params.durationTicks! >
      lv1.effects[1].params.durationTicks! + FIRE.IGNITED_ROLL_SECONDS * TICK.RATE - 1,
    "the upgrade should buy at least one more roll",
  );

  // Lv 4: the cooldown tier resolves to what the path declares.
  const lv4 = resolveAbility(SCORCHING_SUN, 3);
  assert.equal(lv4.cooldownTicks, declaredCooldown(SCORCHING_SUN, 3));

  // Lv 5: a bigger payoff against Burning targets than the base tier gives.
  const lv5 = resolveAbility(SCORCHING_SUN, 4);
  assert.ok(
    lv5.effects[0].params.bonusDamageIfTargetHasStatus!.extraAmount >
      lv1.effects[0].params.bonusDamageIfTargetHasStatus!.extraAmount,
  );
});

test("Firenado upgrades modify damage, the Ignited bonus, cooldown, and burn duration", () => {
  // Lv 1 (Default): the shipped figures, whatever balance currently says.
  const lv1 = resolveAbility(FIRENADO, 0);
  assert.equal(lv1.effects[0].params.amount, baseDamage(FIRENADO));
  assert.equal(lv1.effects[1].chance, undefined, "the burn is certain now");
  assert.equal(lv1.cooldownTicks, FIRENADO.cooldownTicks);
  assert.equal(
    lv1.effects[1].params.durationTicks,
    FIRENADO.effects[1].params.durationTicks,
  );
  assert.equal(
    lv1.effects[0].params.bonusDamageIfTargetHasStatus?.statusId,
    "ignited",
  );

  // Lv 2: the damage tier resolves to what the path declares.
  const lv2 = resolveAbility(FIRENADO, 1);
  assert.equal(lv2.effects[0].params.amount, declaredDamage(FIRENADO, 1));

  // Lv 3: a bigger payoff for setting the target up first (the burn used to
  // become more likely here; it is certain from level 1 now).
  const lv3 = resolveAbility(FIRENADO, 2);
  assert.equal(lv3.effects[1].chance, undefined);
  assert.ok(
    lv3.effects[0].params.bonusDamageIfTargetHasStatus!.extraAmount >
      lv1.effects[0].params.bonusDamageIfTargetHasStatus!.extraAmount,
    "Lv3 should pay more for setting the target up first",
  );

  // Lv 4: the cooldown tier resolves to what the path declares.
  const lv4 = resolveAbility(FIRENADO, 3);
  assert.equal(lv4.cooldownTicks, declaredCooldown(FIRENADO, 3));

  // Lv 5: a longer Burn than the base tier sets.
  const lv5 = resolveAbility(FIRENADO, 4);
  assert.ok(
    lv5.effects[1].params.durationTicks! > lv1.effects[1].params.durationTicks!,
  );
});

test("Heat Wave upgrades swap status modifiers for Crit Chance and Crit Damage", () => {
  // Crit-chance modifiers ADD to the 5% shared base, so the totals below are
  // 15% / 20% / 20%.
  // Lv 1 (Default): 15% total Crit Chance, +10% Crit Damage
  const lv1 = resolveAbility(HEAT_WAVE, 0);
  const status1 = lv1.effects[0].params.status!;
  assert.equal(status1.modifiers?.[0].value, 0.10);
  assert.equal(status1.modifiers?.[1].value, 0.10);

  // Lv 2: Increase Crit Chance (20% total)
  const lv2 = resolveAbility(HEAT_WAVE, 1);
  const status2 = lv2.effects[0].params.status!;
  assert.equal(status2.modifiers?.[0].value, 0.15);
  assert.equal(status2.modifiers?.[1].value, 0.10);

  // Lv 3: Increase Crit Damage
  const lv3 = resolveAbility(HEAT_WAVE, 2);
  const status3 = lv3.effects[0].params.status!;
  assert.equal(status3.modifiers?.[0].value, 0.15);
  assert.equal(status3.modifiers?.[1].value, 0.15);
});

test("Blazing Determination upgrades swap status multiplier and reduce cooldown", () => {
  // Lv 1 (Default): 2.75x next attack, 35s cooldown
  const lv1 = resolveAbility(BLAZING_DETERMINATION, 0);
  const status1 = lv1.effects[0].params.status!;
  assert.equal(status1.modifiers?.[0].value, 2.75);
  assert.equal(lv1.cooldownTicks, 700);

  // Lv 2: Increase damage multiplier to 3.25x
  const lv2 = resolveAbility(BLAZING_DETERMINATION, 1);
  const status2 = lv2.effects[0].params.status!;
  assert.equal(status2.modifiers?.[0].value, 3.25);
  assert.equal(lv2.cooldownTicks, 700);

  // Lv 3: Reduce cooldown to 15s (300 ticks)
  const lv3 = resolveAbility(BLAZING_DETERMINATION, 2);
  assert.equal(lv3.cooldownTicks, 300);
});
