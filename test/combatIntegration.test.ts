import { test } from "node:test";
import assert from "node:assert/strict";
import { activateAbility, type AbilityDefinition } from "../src/engine/abilities.js";
import { hasStatus } from "../src/engine/status.js";
import { getCooldown } from "../src/engine/cooldowns.js";
import { earn, getBalance } from "../src/engine/money.js";
import { selectTarget } from "../src/engine/targeting.js";
import { tickMatch } from "../src/engine/tick.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";

/**
 * T5.2 — combat integration tests: complex scenarios where several kingdoms
 * activate abilities in the same tick window, layering damage, shields, buffs,
 * debuffs, and statuses, then the match runs on through the real tick loop to
 * eliminations and a winner. Deterministic throughout (crits forced off/on).
 */

const player = (id: string, kingdomId: MatchPlayer["kingdomId"]): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

function battle(): {
  match: Match;
  a: PlayerState;
  b: PlayerState;
  c: PlayerState;
} {
  const match = new Match("1234");
  match.addPlayer(player("a", "plains"));
  match.addPlayer(player("b", "water"));
  match.addPlayer(player("c", "ice"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  const [a, b, c] = [gs.getPlayer("a")!, gs.getPlayer("b")!, gs.getPlayer("c")!];
  for (const p of [a, b, c]) earn(p, 5000);
  return { match, a, b, c };
}

// Shared, data-only ability set for the scenarios.
const strike = (id: string, amount: number): AbilityDefinition => ({
  id,
  kind: "attack",
  cost: 100,
  cooldownTicks: 10,
  targeting: { mode: "singleEnemy" },
  effects: [{ type: "damage", target: "target", params: { amount } }],
});

const burnLash: AbilityDefinition = {
  id: "burnLash",
  kind: "attack",
  cost: 150,
  cooldownTicks: 20,
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 200 } },
    {
      type: "status",
      target: "target",
      params: {
        status: { id: "burn", category: "debuff", stacking: "stack", maxStacks: 5 },
        durationTicks: 5,
      },
    },
    {
      type: "debuff",
      target: "target",
      params: { stat: "damage", op: "mult", value: 0.8, modifierTicks: 5 },
    },
  ],
};

const bulwark: AbilityDefinition = {
  id: "bulwark",
  kind: "utility",
  cost: 200,
  cooldownTicks: 30,
  targeting: { mode: "self" },
  effects: [
    { type: "shield", target: "self", params: { amount: 600 } },
    {
      type: "buff",
      target: "self",
      params: { stat: "damageTaken", op: "mult", value: 0.9, modifierTicks: 10 },
    },
  ],
};

test("three kingdoms exchange simultaneous abilities and every interaction resolves", () => {
  const { match, a, b, c } = battle();

  // Same tick window: a burns b, b shields itself, c strikes a.
  const r1 = activateAbility(match, a, burnLash, { targetId: "b", forceCrit: false });
  const r2 = activateAbility(match, b, bulwark);
  // c is Ice — pin rng so Cold Embrace can't randomly freeze a's follow-up.
  const r3 = activateAbility(match, c, strike("frostBolt", 400), { targetId: "a", forceCrit: false, rng: () => 0.99 });
  assert.equal(r1.ok && r2.ok && r3.ok, true);

  // a's hit landed before b's shield went up.
  assert.equal(b.castle.hp, 10_000 - 200);
  assert.equal(b.castle.shield, 600);
  assert.equal(hasStatus(b, "burn"), true);
  assert.equal(a.castle.hp, 10_000 - 400);

  // b is weakened (0.8× damage debuff): b's counterattack deals reduced damage
  // into a — and b's own 0.9× damageTaken buff softens a's next hit.
  const counter = activateAbility(match, b, strike("tide", 500), { targetId: "a", forceCrit: false });
  assert.equal(counter.ok, true);
  assert.equal(a.castle.hp, 10_000 - 400 - 400); // 500 × 0.8

  const followUp = activateAbility(match, a, strike("ember", 500), { targetId: "b", forceCrit: false });
  assert.equal(followUp.ok, true);
  // 500 × 0.9 = 450, absorbed entirely by the 600 shield.
  assert.equal(b.castle.shield, 150);
  assert.equal(b.castle.hp, 10_000 - 200);
});

test("statuses and temporary modifiers expire mid-battle through the real tick loop", () => {
  const { match, a, b } = battle();

  activateAbility(match, a, burnLash, { targetId: "b", forceCrit: false });
  assert.equal(hasStatus(b, "burn"), true);
  assert.equal(b.modifiers.length, 1);

  // Run the real loop past the 5-tick durations.
  for (let t = 1; t <= 5; t++) tickMatch(match, t);

  assert.equal(hasStatus(b, "burn"), false);
  assert.equal(b.modifiers.length, 0);
  // b's damage is back to full once the debuff expired.
  activateAbility(match, b, strike("tide", 500), { targetId: "a", forceCrit: false });
  assert.equal(a.castle.hp, 10_000 - 500);
});

test("cooldowns gate repeat casts across ticks in a running battle", () => {
  const { match, a, b } = battle();
  const jab = strike("jab", 100);

  assert.equal(activateAbility(match, a, jab, { targetId: "b", forceCrit: false }).ok, true);
  assert.equal(activateAbility(match, a, jab, { targetId: "b", forceCrit: false }).error, "ON_COOLDOWN");

  for (let t = 1; t <= 10; t++) tickMatch(match, t); // cooldown = 10
  assert.equal(getCooldown(a, "jab"), 0);
  assert.equal(activateAbility(match, a, jab, { targetId: "b", forceCrit: false }).ok, true);
  assert.equal(b.castle.hp, 10_000 - 200);
});

test("a full battle runs to elimination and victory through the ability framework", () => {
  const { match, a, b, c } = battle();
  earn(a, 100_000);
  earn(b, 100_000);
  const smash = strike("smash", 2000);
  selectTarget(match, a, "c"); // both gang up on c via selected targets
  selectTarget(match, b, "c");

  let tick = 0;
  // Alternate hits until c's castle falls (10,000 HP / 2,000 = 5 hits).
  while (!c.eliminated && tick < 100) {
    tick += 1;
    const attacker = tick % 2 === 1 ? a : b;
    const result = activateAbility(match, attacker, smash, { forceCrit: false });
    if (!result.ok) assert.equal(result.error, "ON_COOLDOWN"); // only legal failure
    tickMatch(match, tick);
  }

  assert.equal(c.eliminated, true);
  assert.equal(c.castle.hp, 0);
  assert.equal(c.eliminatedAtTick, tick);
  // Attackers' targets were cleared by the elimination process.
  assert.equal(a.target, null);
  assert.equal(b.target, null);
  assert.equal(match.phase, "active"); // two kingdoms remain

  // b finishes a (or vice versa) — run to a winner.
  selectTarget(match, b, "a");
  while (match.phase === "active" && tick < 300) {
    tick += 1;
    activateAbility(match, b, smash, { forceCrit: false });
    tickMatch(match, tick);
  }
  assert.equal(match.phase, "ended");
  assert.equal(match.winnerId, "b");
});

test("crits, shields, and elimination interact correctly in one exchange", () => {
  const { match, a, b } = battle();
  b.castle.hp = 700;
  activateAbility(match, b, bulwark); // 600 shield, 0.9× damageTaken

  // Forced crit: 1000 × 1.5 = 1500 → ×0.9 = 1350 → 600 absorbed, 750 to HP ≥ 700.
  const result = activateAbility(match, a, strike("deathblow", 1000), {
    targetId: "b",
    forceCrit: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.damage![0].absorbedByShield, 600);
  assert.equal(result.damage![0].eliminated, true);

  tickMatch(match, 1); // death phase processes the elimination
  assert.equal(b.eliminated, true);
  assert.equal(b.eliminatedAtTick, 1);
  assert.equal(match.phase, "active"); // a and c still stand
});

test("economy and combat stay consistent through a heavy multi-ability battle", () => {
  const { match, a, b } = battle();
  const jab = strike("jab", 100);
  let spentA = 0;

  for (let t = 1; t <= 60; t++) {
    const result = activateAbility(match, a, jab, { targetId: "b", forceCrit: false });
    if (result.ok) spentA += jab.cost;
    tickMatch(match, t);
  }

  // Balance = seed + income − ability spend, to the penny.
  const income = a.economy.incomePerTick * 60; // constant 10 citizens
  assert.equal(getBalance(a), 5000 + income - spentA);
  // Casts happened exactly every cooldownTicks+1 window.
  assert.equal(spentA, jab.cost * Math.ceil(60 / (jab.cooldownTicks + 1)));
});

// --- T5.2 extension: upgrades + rich statuses through a full battle ------------

test("an upgraded ability with DoT and production debuffs decides an extended battle", async () => {
  const { activateAbility: cast, purchaseUpgrade } = await import("../src/engine/abilities.js");
  const { hasStatus: has } = await import("../src/engine/status.js");

  const { match, a, b } = battle();

  // A data-only ability: damage + stacking burn DoT + frozen production.
  // Its single upgrade tier deepens the damage and lengthens the freeze.
  const plague: AbilityDefinition = {
    id: "plague",
    kind: "attack",
    cost: 100,
    cooldownTicks: 4,
    targeting: { mode: "singleEnemy" },
    effects: [
      { type: "damage", target: "target", params: { amount: 150 } },
      {
        type: "status",
        target: "target",
        params: {
          status: {
            id: "burn",
            category: "debuff",
            stacking: "stack",
            maxStacks: 5,
            tickEffects: [{ type: "damage", amount: 10, perStack: true }],
          },
          durationTicks: 30,
        },
      },
      {
        type: "status",
        target: "target",
        params: {
          status: {
            id: "frozenProduction",
            category: "debuff",
            stacking: "refresh",
            modifiers: [{ stat: "income", op: "mult", value: 0 }],
          },
          durationTicks: 10,
        },
      },
    ],
    upgradePath: [
      {
        level: 1,
        cost: 300,
        changes: { effectParams: [{ amount: 250 }, null, { durationTicks: 20 }] },
      },
    ],
  };

  assert.equal(purchaseUpgrade(match, a, plague).ok, true);

  // Fight: a casts upgraded plague on cooldown; b's economy freezes and burns.
  let tick = 0;
  const bStartBalance = b.economy.currency;
  while (!b.eliminated && tick < 400) {
    tick += 1;
    cast(match, a, plague, { targetId: "b", forceCrit: false });
    tickMatch(match, tick);
  }

  assert.equal(b.eliminated, true);
  assert.ok(tick < 400, "the battle must resolve");
  // b earned nothing the whole fight — frozenProduction was refreshed faster
  // than it expired (10-tick freeze, 5-tick cast cycle).
  assert.equal(b.economy.currency, bStartBalance);
  // Elimination cleared every lingering status and modifier.
  assert.equal(has(b, "burn"), false);
  assert.deepEqual(b.modifiers, []);
  // The victor keeps earning normally, and the match continues (c survives).
  assert.ok(a.economy.currency > 0);
  assert.equal(match.phase, "active");
});
