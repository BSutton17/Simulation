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
  type EffectCondition,
} from "../src/engine/abilities.js";
import { evaluateCondition } from "../src/engine/conditions.js";
import { earn } from "../src/engine/money.js";
import { addModifier } from "../src/engine/modifiers.js";
import { applyStatus, processStatusTicks } from "../src/engine/status.js";

const player = (id: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: "water",
  ready: true,
  connected: true,
});

function activeMatch(): { match: Match; a: PlayerState; b: PlayerState } {
  const match = new Match("1234");
  match.addPlayer(player("a"));
  match.addPlayer(player("b"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  const [a, b] = [gs.getPlayer("a")!, gs.getPlayer("b")!];
  earn(a, 10_000);
  earn(b, 10_000);
  return { match, a, b };
}

// --- [#101] Conditional Effect Framework Tests -------------------------------------

test("evaluateCondition supports composable nested conditions (AND, OR, NOT)", () => {
  const { match, a, b } = activeMatch();

  const wetStatus = { id: "wet", category: "debuff" as const, stacking: "refresh" as const };
  const burnStatus = { id: "burn", category: "debuff" as const, stacking: "refresh" as const };

  // Condition: target has wet AND target has shield
  const cond: EffectCondition = {
    type: "and",
    conditions: [
      { type: "targetHasStatus", params: { statusId: "wet" } },
      { type: "targetHasShield" },
    ],
  };

  // False: target has neither
  assert.equal(evaluateCondition(cond, a, b), false);

  // False: target has wet but no shield
  applyStatus(b, wetStatus, { sourceId: "a", durationTicks: 100 });
  assert.equal(evaluateCondition(cond, a, b), false);

  // True: target has wet AND has shield
  b.castle.shield = 500;
  assert.equal(evaluateCondition(cond, a, b), true);

  // NOT Condition: NOT (target has burn)
  const notCond: EffectCondition = {
    type: "not",
    conditions: [{ type: "targetHasStatus", params: { statusId: "burn" } }],
  };

  // True: target does not have burn
  assert.equal(evaluateCondition(notCond, a, b), true);

  // False: target now has burn
  applyStatus(b, burnStatus, { sourceId: "a", durationTicks: 100 });
  assert.equal(evaluateCondition(notCond, a, b), false);
});

test("conditional modifiers apply stat changes only when conditions are met", () => {
  const { match, a, b } = activeMatch();

  const strike: AbilityDefinition = {
    id: "strike",
    kind: "attack",
    cost: 100,
    cooldownTicks: 0,
    targeting: { mode: "singleEnemy" },
    effects: [{ type: "damage", target: "target", params: { amount: 300 } }],
  };

  // Add conditional damage modifier (+150 if target has status "burn")
  addModifier(a, {
    id: "bonus-vs-burning",
    stat: "damage",
    op: "add",
    value: 150,
    sourceId: "test-src",
    remainingTicks: null,
    conditions: [
      { type: "targetHasStatus", params: { statusId: "burn" } }
    ],
  });

  // Cast strike without burn -> deals base 300 damage
  b.castle.hp = 10_000;
  let r = activateAbility(match, a, strike, { targetId: "b", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, 10_000 - 300);

  // Apply burn status to b
  const burnStatus = { id: "burn", category: "debuff" as const, stacking: "refresh" as const };
  applyStatus(b, burnStatus, { sourceId: "a", durationTicks: 100 });

  // Cast strike with burn -> deals 450 damage
  b.castle.hp = 10_000;
  r = activateAbility(match, a, strike, { targetId: "b", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, 10_000 - 450);
});

test("conditional modifier checks HP thresholds correctly", () => {
  const { match, a, b } = activeMatch();

  const heal: AbilityDefinition = {
    id: "heal",
    kind: "utility",
    cost: 100,
    cooldownTicks: 0,
    targeting: { mode: "self" },
    effects: [{ type: "heal", target: "self", params: { amount: 200 } }],
  };

  // Add conditional healing modifier (+100 if caster HP is below 50%)
  // Wait, does healing resolve damage or uses computeStat?
  // Let's check: healCastle in abilities.ts uses flat heal amount directly.
  // Wait, does heal have modifiers? No, but outgoing damage is easy. Let's use damage!
  addModifier(a, {
    id: "last-stand-damage",
    stat: "damage",
    op: "add",
    value: 200,
    sourceId: "test-src",
    remainingTicks: null,
    conditions: [
      { type: "casterHpBelow", params: { hpPercent: 0.50 } }
    ],
  });

  const strike: AbilityDefinition = {
    id: "strike",
    kind: "attack",
    cost: 100,
    cooldownTicks: 0,
    targeting: { mode: "singleEnemy" },
    effects: [{ type: "damage", target: "target", params: { amount: 300 } }],
  };

  // Attacker HP is 100% -> deals 300 damage
  b.castle.hp = 10_000;
  let r = activateAbility(match, a, strike, { targetId: "b", forceCrit: false });
  assert.equal(b.castle.hp, 10_000 - 300);

  // Attacker HP is 40% (below 50%) -> deals 500 damage
  a.castle.hp = 4000;
  b.castle.hp = 10_000;
  r = activateAbility(match, a, strike, { targetId: "b", forceCrit: false });
  assert.equal(b.castle.hp, 10_000 - 500);
});

// --- [#102] Create Chance-Based Effect Framework Tests ------------------------------

test("chance-based effects execute deterministically when injecting RNG", () => {
  const { match, a, b } = activeMatch();

  const freezeStatus = { id: "freeze", category: "debuff" as const, stacking: "refresh" as const };

  const frostStrike: AbilityDefinition = {
    id: "frostStrike",
    kind: "attack",
    cost: 100,
    cooldownTicks: 0,
    targeting: { mode: "singleEnemy" },
    effects: [
      { type: "damage", target: "target", params: { amount: 200 } },
      {
        type: "status",
        target: "target",
        chance: 0.40, // 40% chance
        params: { status: freezeStatus, durationTicks: 100 },
      },
    ],
  };

  // Case 1: Injected RNG returns 0.50 (>= 0.40) -> chance check fails, status NOT applied
  b.statuses = [];
  let r = activateAbility(match, a, frostStrike, {
    targetId: "b",
    forceCrit: false,
    rng: () => 0.50,
  });
  assert.equal(r.ok, true);
  assert.equal(b.statuses.some((s) => s.id === "freeze"), false);

  // Case 2: Injected RNG returns 0.30 (< 0.40) -> chance check succeeds, status IS applied
  b.statuses = [];
  r = activateAbility(match, a, frostStrike, {
    targetId: "b",
    forceCrit: false,
    rng: () => 0.30,
  });
  assert.equal(r.ok, true);
  assert.equal(b.statuses.some((s) => s.id === "freeze"), true);
});

test("chance-based status tick effects execute deterministically when ticking", () => {
  const { match, a, b } = activeMatch();

  const sparkStatus = {
    id: "spark",
    category: "debuff" as const,
    stacking: "refresh" as const,
    tickEffects: [
      { type: "damage" as const, amount: 200, chance: 0.50 }
    ],
  };

  // Apply sparks status to b
  applyStatus(b, sparkStatus, { sourceId: "a", durationTicks: 100 });

  // Tick 1: RNG returns 0.60 (>= 0.50) -> does not trigger damage
  b.castle.hp = 10_000;
  processStatusTicks(match.gameState!, () => 0.60);
  assert.equal(b.castle.hp, 10_000);

  // Tick 2: RNG returns 0.30 (< 0.50) -> triggers SPARKS damage
  processStatusTicks(match.gameState!, () => 0.30);
  assert.equal(b.castle.hp, 10_000 - 200);
});

// --- [#103] Create Usage-Limited Modifier Framework Tests --------------------------

test("usage-limited modifier expires exactly after its configured successful uses count", () => {
  const { match, a, b } = activeMatch();

  const strike: AbilityDefinition = {
    id: "strike",
    kind: "attack",
    cost: 100,
    cooldownTicks: 0,
    targeting: { mode: "singleEnemy" },
    effects: [{ type: "damage", target: "target", params: { amount: 300 } }],
  };

  // Add outgoing damage modifier (+200 damage) with usageLimit: 2
  addModifier(a, {
    id: "temp-power",
    stat: "damage",
    op: "add",
    value: 200,
    sourceId: "test-src",
    remainingTicks: null,
    usageLimit: 2,
  });

  // Cast 1: Deals bonus damage (300 + 200 = 500). Counter drops to 1.
  b.castle.hp = 10_000;
  let r = activateAbility(match, a, strike, { targetId: "b", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, 10_000 - 500);
  assert.equal(a.modifiers.some((m) => m.id === "temp-power"), true);

  // Cast 2: Deals bonus damage (300 + 200 = 500). Counter drops to 0 and modifier is removed.
  b.castle.hp = 10_000;
  r = activateAbility(match, a, strike, { targetId: "b", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, 10_000 - 500);
  assert.equal(a.modifiers.some((m) => m.id === "temp-power"), false);

  // Cast 3: Deals normal base damage (300)
  b.castle.hp = 10_000;
  r = activateAbility(match, a, strike, { targetId: "b", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, 10_000 - 300);
});
