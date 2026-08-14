import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";
import { activateAbility, resolveAbility, type AbilityDefinition } from "../src/engine/abilities.js";
import { getCooldown } from "../src/engine/cooldowns.js";
import { hasStatus } from "../src/engine/status.js";
import { tickMatch } from "../src/engine/tick.js";
import { buyCitizen } from "../src/engine/purchases.js";
import { earn } from "../src/engine/money.js";
import { TICK } from "../src/data/balance.js";
import {
  TIK_TOK,
  HALF_PASSED_12,
  FATHER_TIME,
  BLIP,
  BACK_TO_THE_FUTURE,
} from "../src/data/timeAbilities.js";

/** A plain 1000-damage attack with no element, for driving defense scenarios. */
const strike: AbilityDefinition = {
  id: "strike",
  kind: "attack",
  cost: 0,
  cooldownTicks: 0,
  targeting: { mode: "singleEnemy" },
  effects: [{ type: "damage", target: "target", params: { amount: 1000 } }],
};

// Time kingdom (scaffold pass): Tik Tok is a fully-working basic attack; the
// other four are castable, valid definitions with their damage wired and their
// special mechanics still TODO. These tests lock in what exists today.

const player = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

/** A match of Time (p0) vs plains dummies (p1, p2), all funded. */
function clockTower(n = 3): { match: Match; players: PlayerState[] } {
  const match = new Match("1234");
  match.addPlayer(player("p0", "time"));
  for (let i = 1; i < n; i++) match.addPlayer(player(`p${i}`, "plains"));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  const players = Array.from({ length: n }, (_, i) => gs.getPlayer(`p${i}`)!);
  for (const p of players) earn(p, 100_000);
  return { match, players };
}

// --- Tik Tok (basic, fully working) -------------------------------------------------

test("Tik Tok is a working basic attack: damage, cost, and cooldown", () => {
  const { match, players } = clockTower();
  const [a, b] = players;
  const before = a.economy.currency;

  const r = activateAbility(match, a, TIK_TOK, { targetId: "p1", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, b.castle.maxHp - 250);
  assert.equal(before - a.economy.currency, 100); // cast cost
  assert.equal(getCooldown(a, "tikTok"), 3 * 20); // 3 s at 20 ticks/s
});

test("Tik Tok upgrades (Lv 2->4) raise damage and cut cooldown/price", () => {
  // Lv 2 (tier 1): 250 -> 300 damage.
  const lv2 = resolveAbility(TIK_TOK, 1);
  assert.equal(lv2.effects[0].params.amount, 300);

  // Lv 3 (tier 2): cooldown -10% and price -15%.
  const lv3 = resolveAbility(TIK_TOK, 2);
  assert.equal(lv3.cooldownTicks, 54);
  assert.equal(lv3.cost, Math.floor(100 * 0.85)); // 85

  // Lv 4 (tier 3): 300 -> 400 damage.
  const lv4 = resolveAbility(TIK_TOK, 3);
  assert.equal(lv4.effects[0].params.amount, 400);
});

// --- Half Passed 12 (damage wired; scramble status applied, VFX TODO) ---------------

test("Half Passed 12 deals damage and applies the Scrambled status", () => {
  const { match, players } = clockTower();
  const [a, b] = players;

  const r = activateAbility(match, a, HALF_PASSED_12, { targetId: "p1", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, b.castle.maxHp - 400);
  assert.equal(hasStatus(b, "scrambled"), true);
});

// --- Father Time (heavy damage wired; conditional DoT TODO) -------------------------

test("Father Time deals heavy damage and applies its Mark", () => {
  const { match, players } = clockTower();
  const [a, b] = players;
  match.tick = 0;

  const r = activateAbility(match, a, FATHER_TIME, { targetId: "p1", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, b.castle.maxHp - 500);
  assert.equal(hasStatus(b, "fatherTimeMark"), true);
});

test("Father Time's Mark bleeds 100/idle second, doubling to 200 past the halfway point", () => {
  const { match, players } = clockTower();
  const [a, b] = players;
  match.tick = 0;
  activateAbility(match, a, FATHER_TIME, { targetId: "p1", forceCrit: false });
  b.castle.hp = 10_000; // ignore the up-front strike for clean bleed math

  // 10s mark → halfway at 5s. Seconds 1–5 bleed 100 each; 6–10 bleed 200 each.
  // After 3 idle seconds (all in the first half): 3 × 100.
  for (let t = 1; t <= 3 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(b.castle.hp, 10_000 - 3 * 100);

  // Run to 7 seconds: seconds 4,5 add 100 each; 6,7 add 200 each (past halfway).
  for (let t = 3 * TICK.RATE + 1; t <= 7 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(b.castle.hp, 10_000 - (5 * 100 + 2 * 200));
});

test("landing a damaging attack interrupts Father Time's countdown", () => {
  const { match, players } = clockTower(3);
  const [a, b] = players; // a = Time caster, b = marked victim (plains), p2 = c
  match.tick = 0;
  activateAbility(match, a, FATHER_TIME, { targetId: "p1", forceCrit: false });
  b.castle.hp = 10_000;

  // Second 1: the victim attacks a third kingdom mid-second → the tick at t=20
  // is interrupted, so no bleed lands.
  for (let t = 1; t <= 15; t++) tickMatch(match, t);
  activateAbility(match, b, strike, { targetId: "p2", forceCrit: false });
  for (let t = 16; t <= 20; t++) tickMatch(match, t);
  assert.equal(b.castle.hp, 10_000); // bought the second back

  // Second 2: idle again → the bleed resumes at t=40 (first-half → 100).
  for (let t = 21; t <= 40; t++) tickMatch(match, t);
  assert.equal(b.castle.hp, 10_000 - 100);
});

test("Father Time's Mark expires after its duration", () => {
  const { match, players } = clockTower();
  const [a, b] = players;
  match.tick = 0;
  activateAbility(match, a, FATHER_TIME, { targetId: "p1", forceCrit: false });
  assert.equal(hasStatus(b, "fatherTimeMark"), true);

  for (let t = 1; t <= 10 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(hasStatus(b, "fatherTimeMark"), false);
});

// --- Blip! and Back to the Future (castable scaffolds; mechanics TODO) --------------

/** A damage + damage-over-time attack, for exercising Blip's DoT refund. */
const poisonStrike: AbilityDefinition = {
  id: "poisonStrike",
  kind: "attack",
  cost: 0,
  cooldownTicks: 0,
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 300 } },
    {
      type: "status",
      target: "target",
      params: {
        status: {
          id: "testpoison",
          name: "Test Poison",
          category: "debuff",
          stacking: "refresh",
          tickEffects: [{ type: "damage", amount: 50, intervalTicks: 20 }], // 50/s
        },
        durationTicks: 200,
      },
    },
  ],
};

test("Blip! is castable: pays its cost and arms its cooldown", () => {
  const { match, players } = clockTower();
  const a = players[0];
  const before = a.economy.currency;

  const r = activateAbility(match, a, BLIP);
  assert.equal(r.ok, true);
  assert.equal(before - a.economy.currency, 200);
  assert.equal(getCooldown(a, "blip"), 15 * 20);
});

test("Blip undoes the most recent attack's immediate damage", () => {
  const { match, players } = clockTower();
  const [time, enemy] = players; // p0 = Time (caster), p1 = attacker
  match.tick = 0;
  time.castle.hp = 10_000;

  activateAbility(match, enemy, strike, { targetId: "p0", forceCrit: false });
  assert.equal(time.castle.hp, 9_000); // 1000 damage

  activateAbility(match, time, BLIP);
  assert.equal(time.castle.hp, 10_000); // rewound
  assert.equal(time.attackJournal.length, 0);
});

test("Blip restores the shield the undone attack absorbed", () => {
  const { match, players } = clockTower();
  const [time, enemy] = players;
  match.tick = 0;
  time.castle.hp = 10_000;
  time.castle.shield = 500;

  activateAbility(match, enemy, strike, { targetId: "p0", forceCrit: false }); // 500 shield + 500 hp
  assert.equal(time.castle.shield, 0);
  assert.equal(time.castle.hp, 9_500);

  activateAbility(match, time, BLIP);
  assert.equal(time.castle.shield, 500);
  assert.equal(time.castle.hp, 10_000);
});

test("Blip refunds a DoT attack's immediate + status damage and strips the status", () => {
  const { match, players } = clockTower();
  const [time, enemy] = players;
  match.tick = 0;
  time.castle.hp = 10_000;

  activateAbility(match, enemy, poisonStrike, { targetId: "p0", forceCrit: false });
  assert.equal(time.castle.hp, 10_000 - 300); // immediate hit
  assert.equal(hasStatus(time, "testpoison"), true);

  // Let the poison tick for 3 seconds (3 × 50).
  for (let t = 1; t <= 3 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(time.castle.hp, 10_000 - 300 - 150);

  // Blip rewinds everything the attack did: immediate + DoT, and removes it.
  activateAbility(match, time, BLIP);
  assert.equal(time.castle.hp, 10_000);
  assert.equal(hasStatus(time, "testpoison"), false);
});

test("Blip undoes only the MOST RECENT attack", () => {
  const { match, players } = clockTower(3);
  const [time, a, b] = players;
  match.tick = 0;
  time.castle.hp = 10_000;

  activateAbility(match, a, strike, { targetId: "p0", forceCrit: false }); // -1000
  activateAbility(match, b, strike, { targetId: "p0", forceCrit: false }); // -1000
  assert.equal(time.castle.hp, 8_000);

  activateAbility(match, time, BLIP); // undoes b's strike only
  assert.equal(time.castle.hp, 9_000); // a's 1000 still stands
  assert.equal(time.attackJournal.length, 1);
});

test("Blip fizzles harmlessly when there is nothing to undo", () => {
  const { match, players } = clockTower();
  const time = players[0];
  const before = time.economy.currency;
  time.castle.hp = 9_000; // damaged, but not by any journaled attack

  const r = activateAbility(match, time, BLIP);
  assert.equal(r.ok, true);
  assert.equal(before - time.economy.currency, 200); // still pays its cost
  assert.equal(time.castle.hp, 9_000); // nothing restored
});

test("Back to the Future is castable against the field", () => {
  const { match, players } = clockTower();
  const a = players[0];
  const before = a.economy.currency;

  const r = activateAbility(match, a, BACK_TO_THE_FUTURE);
  assert.equal(r.ok, true);
  // Read off the definition rather than pinned to a literal: the price is a
  // balance knob the designer moves, and this test is about the cast being
  // paid for and put on cooldown, not about what the number happens to be.
  assert.equal(before - a.economy.currency, BACK_TO_THE_FUTURE.cost);
  assert.equal(getCooldown(a, "backToTheFuture"), BACK_TO_THE_FUTURE.cooldownTicks);
});

test("Back to the Future rewinds each enemy's gold at their income rate, floored at 0", () => {
  const { match, players } = clockTower(3);
  const [a, b, c] = players; // a = Time caster, b/c = enemies
  match.tick = 0;

  activateAbility(match, a, BACK_TO_THE_FUTURE);
  assert.equal(hasStatus(b, "goldRewind"), true);
  assert.equal(hasStatus(c, "goldRewind"), true);
  assert.equal(hasStatus(a, "goldRewind"), false); // enemies only

  // Give an enemy some gold and a known income; the drain removes income/tick
  // instead of adding it (net −gold/sec while rewinding).
  b.economy.currency = 500;
  const perTick = b.economy.incomePerTick; // set by recalc; > 0 with citizens
  for (let t = 1; t <= 1 * TICK.RATE; t++) tickMatch(match, t);
  // After 1 second, roughly one second of income has been drained (not earned).
  assert.ok(b.economy.currency < 500, "gold should be draining, not growing");

  // Drain to empty and confirm it stays pinned at 0 for the duration.
  b.economy.currency = 5;
  for (let t = 1 * TICK.RATE + 1; t <= 5 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(b.economy.currency, 0);
  void perTick;
  void c;
});

test("gold stops draining once Back to the Future expires", () => {
  const { match, players } = clockTower();
  const [a, b] = players;
  match.tick = 0;
  activateAbility(match, a, BACK_TO_THE_FUTURE); // 10 s rewind
  // Run past the 10 s duration, then let income resume.
  for (let t = 1; t <= 11 * TICK.RATE; t++) tickMatch(match, t);
  assert.equal(hasStatus(b, "goldRewind"), false);
  b.economy.currency = 100;
  for (let t = 11 * TICK.RATE + 1; t <= 12 * TICK.RATE; t++) tickMatch(match, t);
  assert.ok(b.economy.currency > 100, "income resumes after the rewind ends");
});

// --- Longevity (time-scaling attack + defense) -------------------------------------

test("Longevity: Time's attacks grow +5% every 2 minutes of match time", () => {
  const { match, players } = clockTower();
  const [a, b] = players;
  const twoMin = 2 * 60 * TICK.RATE;

  // t = 0: no boost yet.
  match.tick = 0;
  b.castle.hp = 10_000;
  activateAbility(match, a, TIK_TOK, { targetId: "p1", forceCrit: false });
  assert.equal(b.castle.hp, 10_000 - 250);

  // t = 2 min: +5% → 262.5 → 263.
  match.tick = twoMin;
  a.cooldowns = {};
  b.castle.hp = 10_000;
  activateAbility(match, a, TIK_TOK, { targetId: "p1", forceCrit: false });
  assert.equal(b.castle.hp, 10_000 - 263);

  // t = 4 min: +10% → 275.
  match.tick = 2 * twoMin;
  a.cooldowns = {};
  b.castle.hp = 10_000;
  activateAbility(match, a, TIK_TOK, { targetId: "p1", forceCrit: false });
  assert.equal(b.castle.hp, 10_000 - 275);
});

test("Longevity: Time takes -5% damage every 3 minutes of match time", () => {
  const { match, players } = clockTower();
  const [time, attacker] = players; // p0 = time (defender), p1 = plains (attacker)
  const threeMin = 3 * 60 * TICK.RATE;

  // t = 0: full damage taken.
  match.tick = 0;
  time.castle.hp = 10_000;
  activateAbility(match, attacker, strike, { targetId: "p0", forceCrit: false });
  assert.equal(time.castle.hp, 10_000 - 1000);

  // t = 3 min: -5% → 950 taken.
  match.tick = threeMin;
  attacker.cooldowns = {};
  time.castle.hp = 10_000;
  activateAbility(match, attacker, strike, { targetId: "p0", forceCrit: false });
  assert.equal(time.castle.hp, 10_000 - 950);

  // t = 9 min: -15% → 850 taken.
  match.tick = 3 * threeMin;
  attacker.cooldowns = {};
  time.castle.hp = 10_000;
  activateAbility(match, attacker, strike, { targetId: "p0", forceCrit: false });
  assert.equal(time.castle.hp, 10_000 - 850);
});

test("Longevity does not affect non-Time kingdoms", () => {
  const { match, players } = clockTower();
  const [, attacker, victim] = players; // both plains
  match.tick = 10 * 60 * TICK.RATE; // deep into the match
  victim.castle.hp = 10_000;
  activateAbility(match, attacker, strike, { targetId: "p2", forceCrit: false });
  assert.equal(victim.castle.hp, 10_000 - 1000); // unchanged, no scaling
});

// --- Time is money (bonus citizen on purchase) ------------------------------

test("Time is money: a lucky hire yields 2 citizens but advances the ladder once", () => {
  const { match, players } = clockTower();
  const a = players[0]; // time
  match.rng = () => 0; // 0 < 0.075 → the bonus always procs

  const citizens0 = a.economy.citizens;
  const purchased0 = a.economy.citizensPurchased;
  buyCitizen(match, a);

  assert.equal(a.economy.citizens, citizens0 + 2); // one bought + one free
  assert.equal(a.economy.citizensPurchased, purchased0 + 1); // ladder advanced once
});

test("Time is money: an unlucky hire yields just the one citizen", () => {
  const { match, players } = clockTower();
  const a = players[0]; // time
  match.rng = () => 0.99; // 0.99 ≥ 0.075 → no bonus

  const citizens0 = a.economy.citizens;
  buyCitizen(match, a);
  assert.equal(a.economy.citizens, citizens0 + 1);
});

test("Time is money is exclusive to Time — plains never gets a bonus", () => {
  const { match, players } = clockTower();
  const plains = players[1];
  match.rng = () => 0; // would proc if the passive existed

  const citizens0 = plains.economy.citizens;
  buyCitizen(match, plains);
  assert.equal(plains.economy.citizens, citizens0 + 1); // no passive, no bonus
});
