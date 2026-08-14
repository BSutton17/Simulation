import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";
import {
  activateAbility,
  type AbilityDefinition,
} from "../src/engine/abilities.js";
import { earn } from "../src/engine/money.js";
import { addModifier } from "../src/engine/modifiers.js";
import { applyStatus, removeStatus } from "../src/engine/status.js";
import { setCooldown, getCooldown } from "../src/engine/cooldowns.js";
import { KINGDOM_PASSIVES } from "../src/data/kingdoms.js";

const player = (id: string, kingdomId: string = "water"): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

function activeMatch(
  kingdomA: string = "water",
  kingdomB: string = "fire"
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

// --- [#104] Unique Buff Framework (Status Stacking: "replace") --------------------

test("Status stacking: replace removes existing status/modifiers and creates a fresh instance", () => {
  const { match, a } = activeMatch();

  const powerBuff = {
    id: "power",
    category: "buff" as const,
    stacking: "replace" as const,
    modifiers: [{ stat: "damage", op: "add" as const, value: 100 }],
  };

  // Apply buff once (duration 50)
  applyStatus(a, powerBuff, { sourceId: "a", durationTicks: 50 });
  let inst = a.statuses.find((s) => s.id === "power");
  assert.ok(inst);
  assert.equal(inst.remainingTicks, 50);
  
  // Verify modifier value is +100
  let mod = a.modifiers.find((m) => m.sourceId === "status:power");
  assert.ok(mod);
  assert.equal(mod.value, 100);

  // Apply again with different modifiers / duration (represented by fresh spec)
  const powerBuffUpgraded = {
    id: "power",
    category: "buff" as const,
    stacking: "replace" as const,
    modifiers: [{ stat: "damage", op: "add" as const, value: 250 }],
  };

  applyStatus(a, powerBuffUpgraded, { sourceId: "a", durationTicks: 120 });
  
  // Verify instance duration was updated to 120
  inst = a.statuses.find((s) => s.id === "power");
  assert.ok(inst);
  assert.equal(inst.remainingTicks, 120);

  // Verify old modifiers were removed and new one is exactly +250
  const mods = a.modifiers.filter((m) => m.sourceId === "status:power");
  assert.equal(mods.length, 1);
  assert.equal(mods[0].value, 250);
});

// --- [#105] Expanded Kingdom Passive Framework ------------------------------------

test("Expanded kingdom passives configure starting Castle HP, damage, shield damage, and critical calculations", () => {
  // Inject mock passives for testing
  KINGDOM_PASSIVES["fire"] = [
    { type: "startingCastleHpMultiplier", pct: 0.80 }, // starting HP: 80%
    { type: "damageMultiplier", pct: 0.20 },          // +20% outgoing damage
    { type: "shieldDamageMultiplier", pct: 0.50 },    // +50% shield damage
    { type: "critChanceModifier", pct: 0.25 },        // +25% crit chance
    { type: "critDamageMultiplier", pct: 0.50 },      // +50% crit damage
  ];

  const { match, a, b } = activeMatch("water", "fire");

  // Verify starting HP for fire (b) is 80% (8,000 instead of 10,000)
  assert.equal(b.castle.maxHp, 8000);
  assert.equal(b.castle.hp, 8000);

  // Cast strike from Fire (b) to Water (a)
  const strike: AbilityDefinition = {
    id: "strike",
    kind: "attack",
    cost: 0,
    cooldownTicks: 0,
    targeting: { mode: "singleEnemy" },
    effects: [{ type: "damage", target: "target", params: { amount: 1000 } }],
  };

  // Base strike 1000 * 1.20 (damageMultiplier) = 1200
  // Attacking target without shield -> deals 1200 damage to HP
  a.castle.hp = 10_000;
  a.castle.shield = 0;
  let r = activateAbility(match, b, strike, { targetId: "a", forceCrit: false });
  assert.equal(a.castle.hp, 10_000 - 1200);

  // Attacking target with shield -> shield damage is scaled by +50% (1.5x)
  // So incoming 1200 damage * 1.50 = 1800 shield damage
  a.castle.hp = 10_000;
  a.castle.shield = 2000;
  r = activateAbility(match, b, strike, { targetId: "a", forceCrit: false });
  assert.equal(a.castle.shield, 2000 - 1800);
  assert.equal(a.castle.hp, 10_000); // 0 HP overflow

  // Shield is small: shield 500, damage is 1200.
  // Shield consumes: 500 / 1.5 = 333 incoming damage (amplified to 500 and breaks shield).
  // Overflow incoming damage: 1200 - 333 = 867 hits HP.
  a.castle.hp = 10_000;
  a.castle.shield = 500;
  r = activateAbility(match, b, strike, { targetId: "a", forceCrit: false });
  assert.equal(a.castle.shield, 0);
  assert.equal(a.castle.hp, 10_000 - 867);

  // Test crit multipliers: crit chance base 10% + 25% = 35% chance, crit damage base 1.5x + 50% = 2.0x
  a.castle.hp = 10_000;
  a.castle.shield = 0;
  r = activateAbility(match, b, strike, { targetId: "a", forceCrit: true });
  // Critical hit: 1200 damage * 2.0x crit multiplier = 2400 damage
  assert.equal(a.castle.hp, 10_000 - 2400);

  // Reset injected passive configuration
  KINGDOM_PASSIVES["fire"] = [];
});

// --- [#106] Resource Transfer Framework Tests -------------------------------------

test("resourceTransfer transfers currency and citizens securely, updating income authority", () => {
  const { match, a, b } = activeMatch();

  const stealCurrency: AbilityDefinition = {
    id: "stealCurrency",
    kind: "attack",
    cost: 0,
    cooldownTicks: 0,
    targeting: { mode: "singleEnemy" },
    effects: [
      {
        type: "resourceTransfer",
        target: "target",
        params: {
          resourceTransfer: { type: "currency", amount: 500 },
        },
      },
    ],
  };

  // b has 10,000 currency. Caster a has 10,000 currency.
  b.economy.currency = 1000;
  a.economy.currency = 1000;
  activateAbility(match, a, stealCurrency, { targetId: "b" });
  assert.equal(b.economy.currency, 500);
  assert.equal(a.economy.currency, 1500);

  // Capped at target balance: try to steal 1000 when b only has 500
  const stealMore: AbilityDefinition = {
    id: "stealMore",
    kind: "attack",
    cost: 0,
    cooldownTicks: 0,
    targeting: { mode: "singleEnemy" },
    effects: [
      {
        type: "resourceTransfer",
        target: "target",
        params: {
          resourceTransfer: { type: "currency", amount: 1000 },
        },
      },
    ],
  };
  activateAbility(match, a, stealMore, { targetId: "b" });
  assert.equal(b.economy.currency, 0); // clamped at 0
  assert.equal(a.economy.currency, 2000); // gained remaining 500

  // Citizens transfer
  const stealCitizens: AbilityDefinition = {
    id: "stealCitizens",
    kind: "attack",
    cost: 0,
    cooldownTicks: 0,
    targeting: { mode: "singleEnemy" },
    effects: [
      {
        type: "resourceTransfer",
        target: "target",
        params: {
          resourceTransfer: { type: "citizens", amount: 2 },
        },
      },
    ],
  };

  b.economy.citizens = 5;
  a.economy.citizens = 5;
  
  activateAbility(match, a, stealCitizens, { targetId: "b" });
  
  assert.equal(b.economy.citizens, 3);
  assert.equal(a.economy.citizens, 7);

  // Verify income recalculated immediately for both players
  assert.equal(b.economy.incomePerTick, 0.18); // 3 citizens * 0.04
  // Water caster a: 7 citizens × $0.0675 (flat per-citizen override) = 0.4725.
  assert.equal(a.economy.incomePerTick, 0.4725);
});

// --- [#107] Cooldown Modifier Framework Tests -------------------------------------

test("cooldown modification supports cast-time adjustments, immunities, and active penalties", () => {
  const { match, a, b } = activeMatch();

  // 1. Cast-time CD Reduction
  addModifier(a, {
    id: "cd-reduction",
    stat: "cooldown",
    op: "multiply",
    value: 0.80, // -20% cooldown
    sourceId: "buff",
    remainingTicks: null,
  });

  const waterBall = {
    id: "waterBall",
    kind: "attack" as const,
    cost: 0,
    cooldownTicks: 100,
    targeting: { mode: "singleEnemy" as const },
    effects: [],
  };

  setCooldown(a, "waterBall", 100);
  assert.equal(getCooldown(a, "waterBall"), 80); // reduced by 20%

  // 2. Cooldown reduction immunity
  addModifier(a, {
    id: "cd-immunity",
    stat: "cooldownReductionImmune",
    op: "add",
    value: 1,
    sourceId: "immunity-src",
    remainingTicks: null,
  });

  setCooldown(a, "waterBall", 100);
  assert.equal(getCooldown(a, "waterBall"), 100); // reduction ignored due to immunity

  // Put abilities on cooldown
  setCooldown(b, "waterBall", 50);
  setCooldown(b, "fluidAssimilation", 50);

  const increaseCooldowns: AbilityDefinition = {
    id: "increaseCooldowns",
    kind: "attack",
    cost: 0,
    cooldownTicks: 0,
    targeting: { mode: "singleEnemy" },
    effects: [
      {
        type: "cooldownModify",
        target: "target",
        params: {
          cooldownModify: { op: "add", value: 20, target: "all" },
        },
      },
    ],
  };

  activateAbility(match, a, increaseCooldowns, { targetId: "b" });
  assert.equal(getCooldown(b, "waterBall"), 70); // 50 + 20
  assert.equal(getCooldown(b, "fluidAssimilation"), 70); // 50 + 20

  const halveAttackCooldowns: AbilityDefinition = {
    id: "halveAttackCooldowns",
    kind: "attack",
    cost: 0,
    cooldownTicks: 0,
    targeting: { mode: "singleEnemy" },
    effects: [
      {
        type: "cooldownModify",
        target: "target",
        params: {
          cooldownModify: { op: "multiply", value: 0.50, target: "attacks" },
        },
      },
    ],
  };

  // waterBall is "attack" kind, fluidAssimilation is "utility" kind.
  activateAbility(match, a, halveAttackCooldowns, { targetId: "b" });
  assert.equal(getCooldown(b, "waterBall"), 35); // 70 * 0.5 = 35
  assert.equal(getCooldown(b, "fluidAssimilation"), 70); // unchanged (utility, not attack)
});

// --- [#108] Vision Effect Framework Tests -----------------------------------------

test("vision primitive applies a temporary vision status effect to the recipient", () => {
  const { match, a, b } = activeMatch();

  const applyFog: AbilityDefinition = {
    id: "applyFog",
    kind: "attack",
    cost: 0,
    cooldownTicks: 0,
    targeting: { mode: "singleEnemy" },
    effects: [
      {
        type: "vision",
        target: "target",
        params: {
          vision: { type: "fog", durationTicks: 80 },
        },
      },
    ],
  };

  activateAbility(match, a, applyFog, { targetId: "b" });
  
  // Verify b has the vision status effect for client visibility synchronization
  const status = b.statuses.find((s) => s.id === "vision:fog");
  assert.ok(status);
  assert.equal(status.remainingTicks, 80);
});

// --- [#109] Targeting Modifier Framework Tests ------------------------------------

test("targeting modifiers successfully redirect, duplicate, and multi-target attack execution", () => {
  const match = new Match("1234");
  match.addPlayer(player("a", "water"));
  match.addPlayer(player("b", "fire"));
  match.addPlayer(player("c", "water"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  const [a, b, c] = [gs.getPlayer("a")!, gs.getPlayer("b")!, gs.getPlayer("c")!];
  earn(a, 10_000);
  earn(b, 10_000);
  earn(c, 10_000);

  const strike: AbilityDefinition = {
    id: "strike",
    kind: "attack",
    cost: 0,
    cooldownTicks: 0,
    targeting: { mode: "singleEnemy" },
    effects: [{ type: "damage", target: "target", params: { amount: 300 } }],
  };

  // 1. Target Redirection to another player
  addModifier(b, {
    id: "redirect-to-c",
    stat: "redirectTarget",
    op: "add",
    value: 0,
    stringValue: "c",
    sourceId: "redirect-src",
    remainingTicks: null,
  });

  // a attacks b -> redirected to c
  b.castle.hp = 10_000;
  c.castle.hp = 10_000;
  // `forceCrit: false` like every other strike in this test: an unseeded match
  // rolls crits off `Math.random`, so without it this assertion fails whenever
  // the roll happens to land (300 becomes 450) — a flake with nothing to do
  // with the redirection it is meant to be checking.
  activateAbility(match, a, strike, { targetId: "b", forceCrit: false });
  assert.equal(b.castle.hp, 10_000); // undamaged
  assert.equal(c.castle.hp, 10_000 - 300); // took redirected damage

  // Remove redirect
  b.modifiers = [];

  // 2. Target Redirection to "attacker" (Deflection back to caster)
  addModifier(b, {
    id: "deflect-to-attacker",
    stat: "redirectTarget",
    op: "add",
    value: 0,
    stringValue: "attacker",
    sourceId: "deflect-src",
    remainingTicks: null,
  });

  // a attacks b -> redirected to a
  a.castle.hp = 10_000;
  b.castle.hp = 10_000;
  activateAbility(match, a, strike, { targetId: "b", forceCrit: false });
  assert.equal(b.castle.hp, 10_000); // undamaged
  assert.equal(a.castle.hp, 10_000 - 300); // took self-inflicted deflected damage

  // Remove deflect
  b.modifiers = [];

  // 3. Attack Duplication
  addModifier(a, {
    id: "double-cast",
    stat: "duplicateAttackCount",
    op: "add",
    value: 1, // base 1 + 1 = 2 hits
    sourceId: "dup-src",
    remainingTicks: null,
  });

  // a attacks b -> hits twice (300 * 2 = 600 damage)
  b.castle.hp = 10_000;
  activateAbility(match, a, strike, { targetId: "b", forceCrit: false });
  assert.equal(b.castle.hp, 10_000 - 600);

  // Remove duplicate modifier
  a.modifiers = [];

  // 4. Multi-Target Attacks
  addModifier(a, {
    id: "multi-shot",
    stat: "extraTargetsCount",
    op: "add",
    value: 1, // hits 1 extra target
    sourceId: "multi-src",
    remainingTicks: null,
  });

  // a attacks b -> hits b AND c (300 damage to each)
  b.castle.hp = 10_000;
  c.castle.hp = 10_000;
  activateAbility(match, a, strike, { targetId: "b", forceCrit: false });
  assert.equal(b.castle.hp, 10_000 - 300);
  assert.equal(c.castle.hp, 10_000 - 300);
});

