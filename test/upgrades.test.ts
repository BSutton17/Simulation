import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activateAbility,
  getUpgradeLevel,
  purchaseUpgrade,
  resolveAbility,
  type AbilityDefinition,
} from "../src/engine/abilities.js";
import { getCooldown, tickCooldowns } from "../src/engine/cooldowns.js";
import { earn, getBalance } from "../src/engine/money.js";
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

// A fully data-driven upgradeable ability: tiers touch damage, duration-style
// params, cooldown, cost, a visual key, and even add a whole new effect.
const fireball: AbilityDefinition = {
  id: "fireball",
  kind: "attack",
  cost: 100,
  cooldownTicks: 60,
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 300 } },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 250,
      changes: { effectParams: [{ amount: 400 }] }, // +damage
    },
    {
      level: 2,
      cost: 400,
      changes: { cooldownTicks: 40, cost: 90 }, // faster and cheaper
    },
    {
      level: 3,
      cost: 800,
      changes: {
        effectParams: [{ amount: 550 }],
        addEffects: [
          {
            type: "status",
            target: "target",
            params: {
              status: { id: "burn", category: "debuff", stacking: "refresh" },
              durationTicks: 100,
            },
          },
        ],
      },
    },
  ],
};

// --- #74: cooldown processing on activation -----------------------------------

test("the cooldown is armed immediately on successful activation", () => {
  const { match, a } = activeMatch();
  earn(a, 1000);
  assert.equal(getCooldown(a, "fireball"), 0);
  activateAbility(match, a, fireball, { targetId: "b", forceCrit: false });
  assert.equal(getCooldown(a, "fireball"), 60); // base tier
});

test("the armed cooldown uses the effective (upgraded) value", () => {
  const { match, a } = activeMatch();
  earn(a, 10_000);
  purchaseUpgrade(match, a, fireball); // L1
  purchaseUpgrade(match, a, fireball); // L2: cooldown 40
  activateAbility(match, a, fireball, { targetId: "b", forceCrit: false });
  assert.equal(getCooldown(a, "fireball"), 40);
});

test("a failed activation never arms the cooldown", () => {
  const { match, a } = activeMatch();
  earn(a, 1000);
  activateAbility(match, a, fireball, { targetId: "zzz" }); // INVALID_TARGET
  assert.equal(getCooldown(a, "fireball"), 0);
});

test("upgrading mid-cooldown does not retroactively change the armed cooldown", () => {
  const { match, a } = activeMatch();
  earn(a, 10_000);
  activateAbility(match, a, fireball, { targetId: "b", forceCrit: false }); // 60
  purchaseUpgrade(match, a, fireball);
  purchaseUpgrade(match, a, fireball); // L2 → future casts cool in 40
  assert.equal(getCooldown(a, "fireball"), 60); // unchanged

  for (let i = 0; i < 60; i++) tickCooldowns(match.gameState!);
  activateAbility(match, a, fireball, { targetId: "b", forceCrit: false });
  assert.equal(getCooldown(a, "fireball"), 40); // next cast uses the new value
});

// --- #75: the upgrade framework ------------------------------------------------

test("resolveAbility merges tiers cumulatively up to the given level", () => {
  assert.equal(resolveAbility(fireball, 0).effects[0].params.amount, 300);
  assert.equal(resolveAbility(fireball, 1).effects[0].params.amount, 400);

  const l2 = resolveAbility(fireball, 2);
  assert.equal(l2.effects[0].params.amount, 400); // L1 kept
  assert.equal(l2.cooldownTicks, 40);
  assert.equal(l2.cost, 90);

  const l3 = resolveAbility(fireball, 3);
  assert.equal(l3.effects[0].params.amount, 550);
  assert.equal(l3.effects.length, 2); // burn unlocked
  assert.equal(l3.cooldownTicks, 40); // L2 still applies
});

test("resolveAbility never mutates the base definition", () => {
  resolveAbility(fireball, 3);
  assert.equal(fireball.effects[0].params.amount, 300);
  assert.equal(fireball.effects.length, 1);
  assert.equal(fireball.cooldownTicks, 60);
});

test("purchaseUpgrade spends the tier cost and increments the level", () => {
  const { match, a } = activeMatch();
  earn(a, 1000);
  const result = purchaseUpgrade(match, a, fireball);
  assert.deepEqual(result, { ok: true, level: 1 });
  assert.equal(getBalance(a), 750);
  assert.equal(getUpgradeLevel(a, "fireball"), 1);
});

test("purchaseUpgrade rejects when unaffordable, leaving everything unchanged", () => {
  const { match, a } = activeMatch();
  earn(a, 249);
  const result = purchaseUpgrade(match, a, fireball);
  assert.equal(result.error, "INSUFFICIENT_FUNDS");
  assert.equal(getBalance(a), 249);
  assert.equal(getUpgradeLevel(a, "fireball"), 0);
});

test("purchaseUpgrade rejects beyond the last tier and for non-upgradeable abilities", () => {
  const { match, a } = activeMatch();
  earn(a, 10_000);
  purchaseUpgrade(match, a, fireball);
  purchaseUpgrade(match, a, fireball);
  purchaseUpgrade(match, a, fireball); // maxed at 3
  assert.equal(purchaseUpgrade(match, a, fireball).error, "INVALID_TRANSACTION");

  const plain: AbilityDefinition = { ...fireball, id: "plain", upgradePath: undefined };
  assert.equal(purchaseUpgrade(match, a, plain).error, "INVALID_TRANSACTION");
});

test("upgraded activations use the upgraded damage, cost, and new effects", () => {
  const { match, a, b } = activeMatch();
  earn(a, 10_000);
  purchaseUpgrade(match, a, fireball);
  purchaseUpgrade(match, a, fireball);
  purchaseUpgrade(match, a, fireball); // L3

  const before = getBalance(a);
  const result = activateAbility(match, a, fireball, { targetId: "b", forceCrit: false });
  assert.equal(result.ok, true);
  assert.equal(b.castle.hp, 10_000 - 550); // upgraded damage
  assert.equal(b.statuses.some((s) => s.id === "burn"), true); // unlocked effect
  assert.equal(getBalance(a), before - 90); // upgraded (cheaper) cost
});

test("upgrade levels are per player: one player's tiers never affect another", () => {
  const { match, a, b } = activeMatch();
  earn(a, 10_000);
  earn(b, 10_000);
  purchaseUpgrade(match, a, fireball);

  activateAbility(match, b, fireball, { targetId: "a", forceCrit: false });
  assert.equal(a.castle.hp, 10_000 - 300); // b still casts the base tier
});
