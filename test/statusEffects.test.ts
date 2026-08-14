import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyStatus,
  getStatus,
  hasStatus,
  processStatusTicks,
  removeStatus,
  tickStatuses,
  type StatusEffectDefinition,
} from "../src/engine/status.js";
import { computeStat } from "../src/engine/modifiers.js";
import { resolveDamage } from "../src/engine/damage.js";
import { applyDamage } from "../src/engine/combat.js";
import { applyPassiveIncome } from "../src/engine/economy.js";
import { earn } from "../src/engine/money.js";
import { tickMatch } from "../src/engine/tick.js";
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

// Data-only buff/debuff definitions (#79/#80) — no kingdom-specific logic.
const burn: StatusEffectDefinition = {
  id: "burn",
  category: "debuff",
  stacking: "stack",
  maxStacks: 5,
  tickEffects: [{ type: "damage", amount: 20, perStack: true }],
};

const frozenProduction: StatusEffectDefinition = {
  id: "frozenProduction",
  category: "debuff",
  stacking: "refresh",
  modifiers: [{ stat: "income", op: "mult", value: 0 }],
};

const corrosion: StatusEffectDefinition = {
  id: "corrosion",
  category: "debuff",
  stacking: "refresh",
  modifiers: [{ stat: "damageTaken", op: "mult", value: 1.25 }],
};

const critSurge: StatusEffectDefinition = {
  id: "critSurge",
  category: "buff",
  stacking: "refresh",
  modifiers: [
    { stat: "critChance", op: "add", value: 1 }, // guaranteed crits
    { stat: "critMultiplier", op: "add", value: 0.5 },
  ],
};

const regen: StatusEffectDefinition = {
  id: "regen",
  category: "buff",
  stacking: "refresh",
  tickEffects: [{ type: "heal", amount: 50 }],
};

// --- #76: application — duration, stacking, source tracking -------------------

test("application tracks duration, stacks, and source", () => {
  const { a } = activeMatch();
  const inst = applyStatus(a, burn, { sourceId: "b", durationTicks: 40, stacks: 2 });
  assert.equal(inst.remainingTicks, 40);
  assert.equal(inst.stacks, 2);
  assert.equal(inst.sourceId, "b");
});

test("applying a status with modifiers immediately changes the affected stat", () => {
  const { a } = activeMatch();
  assert.equal(computeStat(a, "income", 1), 1);
  applyStatus(a, frozenProduction, { sourceId: "b", durationTicks: 60 });
  assert.equal(computeStat(a, "income", 1), 0); // ×0 while frozen
});

// --- #77: removal restores modified statistics ---------------------------------

test("dispelling a status removes its modifiers and restores the stat", () => {
  const { match, a } = activeMatch();
  applyStatus(a, frozenProduction, { sourceId: "b", durationTicks: 600 });
  applyPassiveIncome(match.gameState!);
  assert.equal(a.economy.currency, 0); // frozen

  assert.equal(removeStatus(a, "frozenProduction"), true);
  assert.equal(a.modifiers.length, 0); // restored
  applyPassiveIncome(match.gameState!);
  assert.equal(a.economy.currency, 0.6); // earning again
});

test("natural expiry through the tick loop also restores the stat", () => {
  const { match, a, b } = activeMatch();
  applyStatus(b, corrosion, { sourceId: "a", durationTicks: 3 });
  assert.equal(resolveDamage(a, b, 100, { forceCrit: false }).amount, 125);

  for (let t = 1; t <= 3; t++) tickMatch(match, t);
  assert.equal(hasStatus(b, "corrosion"), false);
  assert.equal(b.modifiers.length, 0);
  assert.equal(resolveDamage(a, b, 100, { forceCrit: false }).amount, 100);
});

test("removing one status leaves another status's modifiers intact", () => {
  const { a } = activeMatch();
  applyStatus(a, frozenProduction, { sourceId: "b", durationTicks: 100 });
  applyStatus(a, corrosion, { sourceId: "b", durationTicks: 100 });
  removeStatus(a, "frozenProduction");

  assert.equal(computeStat(a, "income", 1), 1); // restored
  assert.equal(computeStat(a, "damageTaken", 100), 125); // corrosion remains
});

// --- #78: recurring per-tick effect processing ---------------------------------

test("burn deals damage every tick, scaling with stacks", () => {
  const { match, a } = activeMatch();
  applyStatus(a, burn, { sourceId: "b", durationTicks: 100, stacks: 3 });

  processStatusTicks(match.gameState!);
  assert.equal(a.castle.hp, 10_000 - 60); // 20 × 3 stacks

  applyStatus(a, burn, { sourceId: "b", durationTicks: 100, stacks: 2 }); // → 5
  processStatusTicks(match.gameState!);
  assert.equal(a.castle.hp, 10_000 - 60 - 100); // 20 × 5
});

test("DoT damage is absorbed by shields first, like any other damage", () => {
  const { match, a } = activeMatch();
  a.castle.shield = 45;
  applyStatus(a, burn, { sourceId: "b", durationTicks: 10 }); // 20/tick

  processStatusTicks(match.gameState!); // 20 → shield 25
  processStatusTicks(match.gameState!); // 20 → shield 5
  processStatusTicks(match.gameState!); // 5 absorbed, 15 to HP
  assert.equal(a.castle.shield, 0);
  assert.equal(a.castle.hp, 10_000 - 15);
});

test("regeneration heals every tick but never above max HP", () => {
  const { match, a } = activeMatch();
  a.castle.hp = 9920;
  applyStatus(a, regen, { sourceId: "a", durationTicks: 10 });

  processStatusTicks(match.gameState!);
  assert.equal(a.castle.hp, 9970);
  processStatusTicks(match.gameState!);
  assert.equal(a.castle.hp, 10_000); // capped, not 10,020
});

test("a DoT can kill: death is detected and processed in the same tick", () => {
  const { match, a, b } = activeMatch();
  b.castle.hp = 30;
  applyStatus(b, burn, { sourceId: "a", durationTicks: 100, stacks: 2 }); // 40/tick

  const ended = tickMatch(match, 1);
  assert.equal(b.eliminated, true);
  assert.equal(b.castle.hp, 0);
  assert.equal(b.eliminatedAtTick, 1);
  assert.equal(ended, true); // only 'a' remains
  assert.equal(match.winnerId, "a");
});

test("a pending heal can save a castle from a manual HP zero before death processing", () => {
  // Sequencing nuance: the status phase (heals) runs before the death phase,
  // so a regen tick can rescue a castle that reached 0 HP without a flagged
  // killing blow. Real kills via applyDamage flag elimination immediately.
  const { match, b } = activeMatch();
  applyStatus(b, regen, { sourceId: "b", durationTicks: 100 });
  b.castle.hp = 0;
  tickMatch(match, 1);
  assert.equal(b.eliminated, false);
  assert.equal(b.castle.hp, 50); // saved by the regen tick
});

test("eliminated players stop receiving tick effects entirely", () => {
  const { match, b } = activeMatch();
  applyStatus(b, regen, { sourceId: "b", durationTicks: 100 });
  applyDamage(b, 20_000); // real killing blow — flagged immediately
  tickMatch(match, 1); // elimination clears statuses

  assert.deepEqual(b.statuses, []);
  processStatusTicks(match.gameState!);
  assert.equal(b.castle.hp, 0); // no post-mortem regen
});

// --- #79: buffs — positive temporary effects ------------------------------------

test("a crit-surge buff raises crit chance and multiplier while active", () => {
  const { match, a, b } = activeMatch();
  applyStatus(a, critSurge, { sourceId: "a", durationTicks: 5 });

  // Guaranteed crit at 2.0× despite an rng roll that would normally miss.
  const buffed = resolveDamage(a, b, 100, { rng: () => 0.999 });
  assert.equal(buffed.crit, true);
  assert.equal(buffed.amount, 200);

  for (let t = 1; t <= 5; t++) tickMatch(match, t);
  const after = resolveDamage(a, b, 100, { rng: () => 0.999 });
  assert.equal(after.crit, false); // buff expired with its status
});

test("a production buff increases income only while it lasts", () => {
  const { match, a, b } = activeMatch();
  const productionBoost: StatusEffectDefinition = {
    id: "productionBoost",
    category: "buff",
    stacking: "refresh",
    modifiers: [{ stat: "income", op: "mult", value: 2 }],
  };
  applyStatus(a, productionBoost, { sourceId: "a", durationTicks: 2 });

  tickMatch(match, 1); // income phase runs before the status expires
  assert.equal(a.economy.currency, 1.2); // doubled ($0.4 base)
  assert.equal(b.economy.currency, 0.6); // unaffected neighbor

  tickMatch(match, 2);
  tickMatch(match, 3); // buff gone
  assert.equal(a.economy.currency, 3); // 0.8 + 0.8 + 0.4
});

// --- #80: debuffs — negative temporary effects -----------------------------------

test("frozen production halts income for exactly its duration", () => {
  const { match, a, b } = activeMatch();
  applyStatus(a, frozenProduction, { sourceId: "b", durationTicks: 3 });

  for (let t = 1; t <= 3; t++) tickMatch(match, t);
  assert.equal(a.economy.currency, 0); // frozen throughout
  assert.equal(b.economy.currency, 1.8); // opponent unaffected

  tickMatch(match, 4);
  assert.equal(a.economy.currency, 0.6); // thawed
});

test("corrosion amplifies all incoming damage while active", () => {
  const { a, b } = activeMatch();
  applyStatus(b, corrosion, { sourceId: "a", durationTicks: 10 });
  assert.equal(resolveDamage(a, b, 400, { forceCrit: false }).amount, 500);
});

test("buffs and debuffs coexist and resolve without conflicts", () => {
  const { match, a, b } = activeMatch();
  applyStatus(a, critSurge, { sourceId: "a", durationTicks: 10 }); // buff on attacker
  applyStatus(b, corrosion, { sourceId: "a", durationTicks: 10 }); // debuff on defender
  applyStatus(b, burn, { sourceId: "a", durationTicks: 10 }); // DoT on defender

  // 100 → guaranteed crit ×2.0 = 200 → corrosion ×1.25 = 250.
  const hit = resolveDamage(a, b, 100, { rng: () => 0.999 });
  assert.equal(hit.amount, 250);

  processStatusTicks(match.gameState!); // burn still ticks alongside: 20
  assert.equal(b.castle.hp, 10_000 - 20);
});
