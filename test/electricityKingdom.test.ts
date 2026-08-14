import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";
import { activateAbility, resolveAbility, purchaseUpgrade } from "../src/engine/abilities.js";
import { earn } from "../src/engine/money.js";
import { getStatus, removeStatus } from "../src/engine/status.js";
import { tickRecharges } from "../src/engine/cooldowns.js";
import {
  ZAP,
  LIGHTNING_BARRAGE,
  THUNDERDOME,
  HACK,
  THUNDERING_FATE,
} from "../src/data/electricityAbilities.js";
import { FIREBALL } from "../src/data/fireAbilities.js";

const player = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

/** Starts a match with one player per kingdom id given, in order (p0, p1, …). */
function grid(kingdoms: string[]): { match: Match; players: PlayerState[] } {
  const match = new Match("1234");
  kingdoms.forEach((k, i) => match.addPlayer(player(`p${i}`, k)));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  const players = kingdoms.map((_, i) => gs.getPlayer(`p${i}`)!);
  for (const p of players) earn(p, 100_000);
  return { match, players };
}

/** Lightning Barrage charges currently available (pool of 3 − regenerating). */
const charges = (p: PlayerState): number =>
  3 - (p.recharges["lightningBarrage"]?.length ?? 0);

// NOTE: every Electricity attack must pin `rng` — AfterShock rolls on each hit.
const noAftershock = { forceCrit: false, rng: () => 0.99 } as const;

// --- Passives -----------------------------------------------------------------------

test("Don't Blink: attack cooldowns are reduced 30%, utilities/ultimates untouched", () => {
  const { match, players } = grid(["electricity", "plains"]);
  const a = players[0];

  activateAbility(match, a, ZAP, { targetId: "p1", ...noAftershock });
  assert.equal(a.cooldowns["zap"], 42); // 60 x 0.7

  // Barrage has no ability cooldown at all — pacing comes from its charges.
  activateAbility(match, a, LIGHTNING_BARRAGE, { targetId: "p1", ...noAftershock });
  assert.equal(a.cooldowns["lightningBarrage"], undefined);

  activateAbility(match, a, HACK, { targetId: "p1" });
  assert.equal(a.cooldowns["hack"], 1200); // utility: full cooldown (untouched)

  activateAbility(match, a, THUNDERING_FATE);
  assert.equal(a.cooldowns["thunderingFate"], 3600); // ultimate: full cooldown (untouched)
});

test("AfterShock: attacks have a chance to deal 50% bonus damage after hitting", () => {
  const { match, players } = grid(["electricity", "plains"]);
  const [a, b] = players;

  // Roll fails (0.99 >= 0.25): plain hit.
  let r = activateAbility(match, a, ZAP, { targetId: "p1", ...noAftershock });
  assert.equal(b.castle.hp, b.castle.maxHp - 250);
  assert.equal(r.damage!.length, 1);

  // Roll succeeds (0.0 < 0.25): 250 + 125 bonus, reported as a second hit.
  b.castle.hp = 10_000;
  a.cooldowns = {};
  r = activateAbility(match, a, ZAP, { targetId: "p1", forceCrit: false, rng: () => 0.0 });
  assert.equal(b.castle.hp, 10_000 - 375);
  assert.equal(r.damage!.length, 2);
});

// --- Lightning Charges & Lightning Barrage ------------------------------------------

test("Lightning Barrage owns a pool of 3 charges, independent of Zap", () => {
  const { match, players } = grid(["electricity", "plains"]);
  const a = players[0];

  // Full pool from the start — no Zap casts required.
  assert.equal(charges(a), 3);

  // Casting Zap does not add or spend Barrage charges.
  activateAbility(match, a, ZAP, { targetId: "p1", ...noAftershock });
  assert.equal(charges(a), 3);
});

test("Lightning Barrage spends 1-3 charges: 85g per charge, 200/410/650 damage", () => {
  const { match, players } = grid(["electricity", "plains"]);
  const [a, b] = players;

  // Spend 2 of 3: 410 total damage, cast cost 2 × 85 = 170, one charge left.
  const before2 = a.economy.currency;
  activateAbility(match, a, LIGHTNING_BARRAGE, {
    targetId: "p1",
    chargesToUse: 2,
    ...noAftershock,
  });
  assert.equal(b.castle.hp, b.castle.maxHp - 475);
  assert.equal(charges(a), 1);
  assert.equal(before2 - a.economy.currency, 160);

  // The remaining charge is castable immediately: default spend is 1 charge —
  // 200 damage, 85g. No ability cooldown gates it.
  b.castle.hp = 10_000;
  const before1 = a.economy.currency;
  activateAbility(match, a, LIGHTNING_BARRAGE, { targetId: "p1", ...noAftershock });
  assert.equal(b.castle.hp, 10_000 - 230);
  assert.equal(charges(a), 0);
  assert.equal(before1 - a.economy.currency, 80);

  // Pool empty: the cast is refused outright.
  const refused = activateAbility(match, a, LIGHTNING_BARRAGE, {
    targetId: "p1",
    ...noAftershock,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "NO_CHARGES");
});

test("spent charges regenerate independently: 1 charge in 3s, 2 charges at 3s and 6s", () => {
  const { match, players } = grid(["electricity", "plains"]);
  const a = players[0];
  const state = match.gameState!;

  // Spend 2 charges: staggered timers of 60 and 120 ticks (3 s and 6 s).
  activateAbility(match, a, LIGHTNING_BARRAGE, {
    targetId: "p1",
    chargesToUse: 2,
    ...noAftershock,
  });
  assert.deepEqual(a.recharges["lightningBarrage"], [60, 120]);
  assert.equal(charges(a), 1);

  // 60 ticks later the first charge is back…
  for (let i = 0; i < 60; i++) tickRecharges(state);
  assert.equal(charges(a), 2);

  // …and 60 more restore the pool.
  for (let i = 0; i < 60; i++) tickRecharges(state);
  assert.equal(charges(a), 3);
});

test("a partial spend leaves the rest castable immediately", () => {
  const { match, players } = grid(["electricity", "plains"]);
  const [a, b] = players;

  // Use 1 of 3 (200 dmg) — two remain, so a follow-up 2-charge cast works
  // right away with no waiting.
  activateAbility(match, a, LIGHTNING_BARRAGE, {
    targetId: "p1",
    chargesToUse: 1,
    ...noAftershock,
  });
  assert.equal(charges(a), 2);

  b.castle.hp = 10_000;
  const r = activateAbility(match, a, LIGHTNING_BARRAGE, {
    targetId: "p1",
    chargesToUse: 2,
    ...noAftershock,
  });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, 10_000 - 475);
  assert.equal(charges(a), 0);
});

test("Lightning Barrage unlocks for a flat 125g", () => {
  assert.equal(LIGHTNING_BARRAGE.unlockCost, 100);
});

// --- Thunderdome --------------------------------------------------------------------

test("Thunderdome amplifies the caster's Electricity attacks against the domed target", () => {
  const { match, players } = grid(["electricity", "plains", "fire"]);
  const [a, b, f] = players;

  activateAbility(match, a, THUNDERDOME, { targetId: "p1", ...noAftershock });
  assert.equal(b.castle.hp, b.castle.maxHp - 350);
  assert.ok(getStatus(b, "thunderdome"));
  assert.equal(getStatus(b, "thunderdome")!.remainingTicks, 160); // 8 s

  // Electricity attack from the dome's creator, amplified 1.25x.
  b.castle.hp = 10_000;
  activateAbility(match, a, ZAP, { targetId: "p1", ...noAftershock });
  assert.equal(b.castle.hp, 10_000 - 313);

  // A Fire attack is not amplified (element gate): 250 x 1.15 -> 288 only.
  b.castle.hp = 10_000;
  activateAbility(match, f, FIREBALL, { targetId: "p1", ...noAftershock });
  assert.equal(b.castle.hp, 10_000 - 338);
});

// --- Hack ---------------------------------------------------------------------------

test("Hack steals a percentage of the target's money and citizens, dealing no damage", () => {
  const { match, players } = grid(["electricity", "plains"]);
  const [a, b] = players;

  b.economy.currency = 1000;
  b.economy.citizens = 10;
  const aCitizens = a.economy.citizens;
  const aCurrency = a.economy.currency;

  const r = activateAbility(match, a, HACK, { targetId: "p1" });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, b.castle.maxHp); // no damage
  assert.equal(b.economy.currency, 900); // -10%
  assert.equal(b.economy.citizens, 9); // -10%
  assert.equal(a.economy.currency, aCurrency - 350 + 100); // cost, then loot
  assert.equal(a.economy.citizens, aCitizens + 1);
});

test("Hack moves the citizen price ladder with the stolen citizens", () => {
  const { match, players } = grid(["electricity", "plains"]);
  const [a, b] = players;

  // The victim has climbed the cost curve by two purchases; the hacker none.
  b.economy.citizens = 20;
  b.economy.citizensPurchased = 2;
  a.economy.citizensPurchased = 0;

  activateAbility(match, a, HACK, { targetId: "p1" }); // steals 10% = 2 citizens
  assert.equal(b.economy.citizens, 18);
  // Both ladders adjust: the victim steps back down, the thief climbs up.
  assert.equal(b.economy.citizensPurchased, 0);
  assert.equal(a.economy.citizensPurchased, 2);
});

test("Hack's ladder transfer is clamped to what the victim actually purchased", () => {
  const { match, players } = grid(["electricity", "plains"]);
  const [a, b] = players;

  // 20 citizens but only 1 was purchased (the rest are starting stock).
  b.economy.citizens = 20;
  b.economy.citizensPurchased = 1;
  a.economy.citizensPurchased = 3;

  activateAbility(match, a, HACK, { targetId: "p1" }); // steals 2 citizens
  assert.equal(b.economy.citizens, 18);
  // Only 1 ladder step existed to take — never negative on the victim.
  assert.equal(b.economy.citizensPurchased, 0);
  assert.equal(a.economy.citizensPurchased, 4);
});

// --- Thundering Fate ----------------------------------------------------------------

test("Thundering Fate clears Zap's cooldown and keeps it clear for the window", () => {
  const { match, players } = grid(["electricity", "plains"]);
  const [a, b] = players;

  activateAbility(match, a, ZAP, { targetId: "p1", ...noAftershock });
  assert.equal(a.cooldowns["zap"], 42);

  // Cast the ultimate: the armed cooldown is wiped…
  activateAbility(match, a, THUNDERING_FATE);
  assert.equal(a.cooldowns["zap"], undefined);
  assert.equal(getStatus(a, "thunderingFate")!.remainingTicks, 60); // 3 s

  // …and Zap arms no cooldown while the window lasts: back-to-back casts.
  // Zap also costs less inside the window (discounted cast cost).
  const before = a.economy.currency;
  activateAbility(match, a, ZAP, { targetId: "p1", ...noAftershock });
  assert.equal(a.cooldowns["zap"], undefined);
  assert.equal(before - a.economy.currency, 65);
  const r = activateAbility(match, a, ZAP, { targetId: "p1", ...noAftershock });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, b.castle.maxHp - 250 * 3);

  // Window over: Zap cools down normally again at its full price.
  removeStatus(a, "thunderingFate");
  const beforeFull = a.economy.currency;
  activateAbility(match, a, ZAP, { targetId: "p1", ...noAftershock });
  assert.equal(a.cooldowns["zap"], 42);
  assert.equal(beforeFull - a.economy.currency, 100);
});

test("cooldown-reduction upgrade tiers also cut the ability's price 15%", () => {
  // Zap Lv3 (tier 2 reduces cooldown): cost floor(100 × 0.85) = 85.
  const z = resolveAbility(ZAP, 2);
  assert.equal(z.cooldownTicks, 54);
  assert.equal(z.cost, 85);

  // Hack Lv3 (tier 2 reduces cooldown): cost floor(350 × 0.85) = 297.
  const h = resolveAbility(HACK, 2);
  assert.equal(h.cooldownTicks, 425);
  assert.equal(h.cost, 297);

  // Below the tier, the price is untouched.
  assert.equal(resolveAbility(ZAP, 1).cost, 100);
});

// --- Electricity Ability Upgrades -----------------------------------------------------

test("Lightning Barrage upgrades speed up charge regeneration", () => {
  const { match, players } = grid(["electricity", "plains"]);
  const [a, b] = players;

  // Lv2 then Lv3: charges regenerate in 2.5 s instead of 3 s.
  purchaseUpgrade(match, a, LIGHTNING_BARRAGE);
  purchaseUpgrade(match, a, LIGHTNING_BARRAGE);
  activateAbility(match, a, LIGHTNING_BARRAGE, {
    targetId: "p1",
    chargesToUse: 1,
    ...noAftershock,
  });
  assert.deepEqual(a.recharges["lightningBarrage"], [50]); // 2.5 s

  // Tier 1 also added flat damage: 200 (1 charge) + 100 flat = 300.
  assert.equal(b.castle.hp, b.castle.maxHp - 330);
});

test("Electricity upgrade tiers resolve their overrides", () => {
  // Zap: standard damage/cooldown path.
  const z = resolveAbility(ZAP, 3);
  assert.equal(z.effects[0].params.amount, 350);
  assert.equal(z.cooldownTicks, 54);

  // Lightning Barrage: flat damage tiers (Lv2/Lv4) and recharge tiers (Lv3/Lv5).
  const lb = resolveAbility(LIGHTNING_BARRAGE, 4);
  assert.equal(lb.effects[0].params.amount, 200); // Lv4 overrides Lv2's +100
  assert.equal(lb.cooldownTicks, 0); // paced by charges, never a cooldown
  assert.equal(lb.chargeSystem?.max, 3);
  assert.equal(lb.chargeSystem?.costPerCharge, 80);
  assert.deepEqual(lb.chargeSystem?.damageByCharges, [230, 475, 800]);
  assert.equal(lb.chargeSystem?.rechargeTicks, 40); // Lv5 tier: 2 s
  assert.equal(lb.effects.length, 1);

  // Thunderdome: Lv2 damage, Lv3 duration, Lv4 CD, Lv5 amp.
  const td = resolveAbility(THUNDERDOME, 4);
  assert.equal(td.effects[0].params.amount, 450);
  assert.equal(td.effects[1].params.durationTicks, 240); // 12 s
  assert.equal(td.cooldownTicks, 270);
  assert.equal(td.effects[1].params.status?.modifiers?.[0].value, 1.5);

  // Hack: Lv2 steal percentages, Lv3 CD.
  const h = resolveAbility(HACK, 2);
  assert.equal(h.effects[0].params.resourceTransfer?.percent, 0.15);
  assert.equal(h.effects[1].params.resourceTransfer?.percent, 0.15);
  assert.equal(h.cooldownTicks, 425);

  // Thundering Fate: Lv2 window, Lv3 CD.
  const tf = resolveAbility(THUNDERING_FATE, 2);
  assert.equal(tf.effects[1].params.durationTicks, 100); // 5 s
  assert.equal(tf.cooldownTicks, 1530);
});
