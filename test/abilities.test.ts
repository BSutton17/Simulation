import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activateAbility,
  type AbilityDefinition,
} from "../src/engine/abilities.js";
import { getCooldown } from "../src/engine/cooldowns.js";
import { hasStatus } from "../src/engine/status.js";
import { earn, getBalance } from "../src/engine/money.js";
import { selectTarget } from "../src/engine/targeting.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";

const player = (id: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: "plains",
  ready: true,
  connected: true,
});

function activeMatch(): { match: Match; a: PlayerState; b: PlayerState } {
  const match = new Match("1234");
  match.addPlayer(player("a"));
  match.addPlayer(player("b"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  return {
    match,
    a: match.gameState!.getPlayer("a")!,
    b: match.gameState!.getPlayer("b")!,
  };
}

// Data-only ability definitions — no subclasses, per ABILITY_SYSTEM.md.
const fireball: AbilityDefinition = {
  id: "fireball",
  kind: "attack",
  cost: 200,
  cooldownTicks: 180,
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 300 } },
    {
      type: "status",
      target: "target",
      params: {
        status: { id: "burn", category: "debuff", stacking: "refresh" },
        durationTicks: 300,
      },
    },
  ],
};

const barrier: AbilityDefinition = {
  id: "barrier",
  kind: "utility",
  cost: 150,
  cooldownTicks: 100,
  targeting: { mode: "self" },
  effects: [{ type: "shield", target: "self", params: { amount: 800 } }],
};

const cataclysm: AbilityDefinition = {
  id: "cataclysm",
  kind: "ultimate",
  cost: 500,
  cooldownTicks: 1200,
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 1500, ignoreShields: true } },
    { type: "buff", target: "self", params: { stat: "damage", op: "mult", value: 1.2, modifierTicks: 200 } },
  ],
};

const aura: AbilityDefinition = {
  id: "aura",
  kind: "passive",
  cost: 0,
  cooldownTicks: 0,
  targeting: { mode: "self" },
  effects: [{ type: "buff", target: "self", params: { stat: "income", op: "add", value: 1 } }],
};

// --- #71: one shared framework for every ability kind -------------------------

test("attack, utility, and ultimate all execute through the same pipeline", () => {
  const { match, a, b } = activeMatch();
  earn(a, 1000);

  const atk = activateAbility(match, a, fireball, { targetId: "b", forceCrit: false });
  assert.equal(atk.ok, true);
  assert.equal(b.castle.hp, 10_000 - 300);
  assert.equal(hasStatus(b, "burn"), true); // composed second effect

  const util = activateAbility(match, a, barrier);
  assert.equal(util.ok, true);
  assert.equal(a.castle.shield, 800);
  assert.equal(util.targetId, "a"); // self-cast resolves to the caster

  const ult = activateAbility(match, a, cataclysm, { targetId: "b", forceCrit: false });
  assert.equal(ult.ok, true);
  assert.equal(b.castle.hp, 10_000 - 300 - 1500);
  assert.equal(a.modifiers.some((m) => m.stat === "damage"), true);
});

test("common behavior is inherited: each kind pays its cost and starts its cooldown", () => {
  const { match, a } = activeMatch();
  earn(a, 1000);
  activateAbility(match, a, barrier);
  assert.equal(getBalance(a), 850);
  assert.equal(getCooldown(a, "barrier"), 100);
});

test("passives are never manually activatable", () => {
  const { match, a } = activeMatch();
  earn(a, 1000);
  const result = activateAbility(match, a, aura);
  assert.equal(result.ok, false);
  assert.equal(result.error, "NOT_ACTIVATABLE");
});

test("ignoreShields damage effects bypass the target's shield", () => {
  const { match, a, b } = activeMatch();
  earn(a, 1000);
  b.castle.shield = 1000;
  activateAbility(match, a, cataclysm, { targetId: "b", forceCrit: false });
  assert.equal(b.castle.shield, 1000); // untouched
  assert.equal(b.castle.hp, 10_000 - 1500);
});

// --- #72: the activation pipeline rejects invalid activations -----------------

test("rejects when the match is not active", () => {
  const { match, a } = activeMatch();
  earn(a, 1000);
  match.phase = "ended";
  assert.equal(activateAbility(match, a, fireball, { targetId: "b" }).error, "INVALID_PHASE");
});

test("rejects an eliminated caster", () => {
  const { match, a } = activeMatch();
  earn(a, 1000);
  a.eliminated = true;
  assert.equal(activateAbility(match, a, fireball, { targetId: "b" }).error, "ELIMINATED");
});

test("rejects an ability on cooldown", () => {
  const { match, a } = activeMatch();
  earn(a, 1000);
  assert.equal(activateAbility(match, a, fireball, { targetId: "b" }).ok, true);
  assert.equal(activateAbility(match, a, fireball, { targetId: "b" }).error, "ON_COOLDOWN");
});

test("rejects a singleEnemy ability with no target anywhere", () => {
  const { match, a } = activeMatch();
  earn(a, 1000);
  assert.equal(activateAbility(match, a, fireball).error, "TARGET_REQUIRED");
});

test("falls back to the caster's selected target when none is given", () => {
  const { match, a, b } = activeMatch();
  earn(a, 1000);
  selectTarget(match, a, "b"); // ticket #61 selection
  const result = activateAbility(match, a, fireball, { forceCrit: false });
  assert.equal(result.ok, true);
  assert.equal(result.targetId, "b");
  assert.equal(b.castle.hp, 10_000 - 300);
});

test("rejects self, eliminated, and unknown targets", () => {
  const { match, a, b } = activeMatch();
  earn(a, 1000);
  assert.equal(activateAbility(match, a, fireball, { targetId: "a" }).error, "INVALID_TARGET");
  b.eliminated = true;
  assert.equal(activateAbility(match, a, fireball, { targetId: "b" }).error, "INVALID_TARGET");
  assert.equal(activateAbility(match, a, fireball, { targetId: "zzz" }).error, "INVALID_TARGET");
});

// --- #73: money is deducted only on successful activation ---------------------

test("no failed activation ever consumes money or starts a cooldown", () => {
  const { match, a, b } = activeMatch();
  earn(a, 1000);

  // Target failure.
  activateAbility(match, a, fireball, { targetId: "a" });
  // Phase failure.
  match.phase = "ended";
  activateAbility(match, a, fireball, { targetId: "b" });
  match.phase = "active";
  // Eliminated-target failure.
  b.eliminated = true;
  activateAbility(match, a, fireball, { targetId: "b" });
  b.eliminated = false;

  assert.equal(getBalance(a), 1000); // untouched by all three failures
  assert.equal(getCooldown(a, "fireball"), 0); // never armed
});

test("an unaffordable ability is rejected before any state changes", () => {
  const { match, a, b } = activeMatch();
  earn(a, 199); // fireball costs 200
  const result = activateAbility(match, a, fireball, { targetId: "b" });
  assert.equal(result.error, "INSUFFICIENT_FUNDS");
  assert.equal(getBalance(a), 199);
  assert.equal(b.castle.hp, 10_000); // no partial effects
  assert.equal(hasStatus(b, "burn"), false);
});

test("a successful activation deducts exactly the ability cost", () => {
  const { match, a } = activeMatch();
  earn(a, 1000);
  activateAbility(match, a, barrier);
  assert.equal(getBalance(a), 1000 - barrier.cost);
});
