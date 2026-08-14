import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buyCitizen,
  buyShield,
  citizenCost,
  repairCastle,
  repairCost,
  shieldCost,
} from "../src/engine/purchases.js";
import { earn } from "../src/engine/money.js";
import { applyDamage } from "../src/engine/combat.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { CASTLE, ECONOMY, SHIELD } from "../src/data/balance.js";
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

function activeMatch(): { match: Match; a: PlayerState } {
  const match = new Match("1234");
  match.addPlayer(player("a"));
  match.addPlayer(player("b"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  return { match, a: match.gameState!.getPlayer("a")! };
}

test("buying a citizen spends money and adds a citizen", () => {
  const { match, a } = activeMatch();
  earn(a, 25);
  const startCitizens = a.economy.citizens;

  const result = buyCitizen(match, a);
  assert.equal(result.ok, true);
  assert.equal(a.economy.citizens, startCitizens + 1);
  assert.equal(a.economy.currency, 25 - ECONOMY.CITIZEN_COST);
});

test("citizen cost scales up after each purchase", () => {
  const { match, a } = activeMatch();
  earn(a, 1000);

  const cost0 = citizenCost(a); // base
  assert.equal(cost0, ECONOMY.CITIZEN_COST);

  assert.equal(buyCitizen(match, a).ok, true);
  const cost1 = citizenCost(a);
  assert.ok(cost1 > cost0, `cost should rise: ${cost0} → ${cost1}`);

  assert.equal(buyCitizen(match, a).ok, true);
  const cost2 = citizenCost(a);
  assert.ok(cost2 > cost1, `cost should keep rising: ${cost1} → ${cost2}`);

  // Purchase counter tracks the escalation.
  assert.equal(a.economy.citizensPurchased, 2);
});

test("buying a citizen fails without enough money and changes nothing", () => {
  const { match, a } = activeMatch();
  earn(a, ECONOMY.CITIZEN_COST - 1);
  const startCitizens = a.economy.citizens;

  const result = buyCitizen(match, a);
  assert.equal(result.ok, false);
  assert.equal(result.error, "INSUFFICIENT_FUNDS");
  assert.equal(a.economy.citizens, startCitizens); // unchanged
});

test("repairing the castle restores HP for money, capped at max", () => {
  const { match, a } = activeMatch();
  a.castle.hp = a.castle.maxHp - 2000; // 2000 missing
  earn(a, 2000);

  const result = repairCastle(match, a);
  assert.equal(result.ok, true);
  // Repairs REPAIR_AMOUNT (1000) HP for the flat base cost ($500).
  assert.equal(a.castle.hp, a.castle.maxHp - 1000);
  assert.equal(a.economy.currency, 2000 - CASTLE.REPAIR_COST);
});

test("repair never exceeds max HP; the flat cost applies regardless", () => {
  const { match, a } = activeMatch();
  a.castle.hp = a.castle.maxHp - 100; // only 100 missing
  earn(a, 2000);

  assert.equal(repairCastle(match, a).ok, true);
  assert.equal(a.castle.hp, a.castle.maxHp); // clamped to full
  assert.equal(a.economy.currency, 2000 - CASTLE.REPAIR_COST);
});

test("repairs are capped at MAX_REPAIRS per match; ability healing is not", () => {
  const { match, a } = activeMatch();
  a.castle.hp = a.castle.maxHp - 5000;
  earn(a, 100_000);

  // Spend every repair: 500, 625, 781, 977 (each 1.25x the last).
  const costs: number[] = [];
  for (let i = 0; i < CASTLE.MAX_REPAIRS; i++) {
    costs.push(repairCost(a));
    assert.equal(repairCastle(match, a).ok, true);
  }
  // Derived from the ladder rather than pinned, so raising the cap doesn't
  // break the test that exists to prove the price climbs.
  const expected = Array.from({ length: CASTLE.MAX_REPAIRS }, (_, i) =>
    Math.round(CASTLE.REPAIR_COST * CASTLE.REPAIR_COST_GROWTH ** i),
  );
  assert.deepEqual(costs, expected); // 500, 625, 781, 977
  assert.equal(a.castle.repairs, CASTLE.MAX_REPAIRS);

  // One past the cap is refused outright, and the quoted price drops to 0.
  const refused = repairCastle(match, a);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "REPAIR_LIMIT");
  assert.equal(repairCost(a), 0);
});

test("repair cost scales up after each repair", () => {
  const { match, a } = activeMatch();
  a.castle.hp = a.castle.maxHp - 5000; // plenty of room for several repairs
  earn(a, 10_000);

  const cost0 = repairCost(a);
  assert.equal(repairCastle(match, a).ok, true);
  const cost1 = repairCost(a);
  assert.ok(cost1 > cost0, `repair cost should rise: ${cost0} → ${cost1}`);

  assert.equal(repairCastle(match, a).ok, true);
  const cost2 = repairCost(a);
  assert.ok(cost2 > cost1, `repair cost should keep rising: ${cost1} → ${cost2}`);

  assert.equal(a.castle.repairs, 2);
});

test("buying a shield grants the standard shield HP for money", () => {
  const { match, a } = activeMatch();
  earn(a, 1000);
  assert.equal(a.castle.shield, 0);

  const result = buyShield(match, a);
  assert.equal(result.ok, true);
  assert.equal(a.castle.shield, SHIELD.STANDARD_HP);
  assert.equal(a.economy.currency, 1000 - SHIELD.COST);
});

test("buying a shield fails without enough money", () => {
  const { match, a } = activeMatch();
  earn(a, SHIELD.COST - 1);
  const result = buyShield(match, a);
  assert.equal(result.ok, false);
  assert.equal(result.error, "INSUFFICIENT_FUNDS");
  assert.equal(a.castle.shield, 0);
});

test("cannot buy a second shield while one is active", () => {
  const { match, a } = activeMatch();
  earn(a, 2000);

  assert.equal(buyShield(match, a).ok, true); // first one
  const second = buyShield(match, a);
  assert.equal(second.ok, false);
  assert.equal(second.error, "SHIELD_ACTIVE");
  assert.equal(a.castle.shield, SHIELD.STANDARD_HP); // still just one
  // Once depleted, another can be bought.
  a.castle.shield = 0;
  assert.equal(buyShield(match, a).ok, true);
});

test("a shield broken by damage can't be rebought until the break cooldown passes", () => {
  const { match, a } = activeMatch();
  earn(a, 5000);
  match.tick = 1000;
  assert.equal(buyShield(match, a).ok, true);

  // Break the shield with an over-shield hit at tick 1000.
  applyDamage(a, a.castle.shield + 100, { tick: 1000 });
  assert.equal(a.castle.shield, 0);

  // Immediately after breaking: rebuy is on cooldown.
  const r = buyShield(match, a);
  assert.equal(r.ok, false);
  assert.equal(r.error, "SHIELD_COOLDOWN");

  // Still blocked one tick before 7.5 s.
  match.tick = 1000 + SHIELD.BREAK_COOLDOWN_TICKS - 1;
  assert.equal(buyShield(match, a).error, "SHIELD_COOLDOWN");

  // At 7.5 s the shield can be rebought.
  match.tick = 1000 + SHIELD.BREAK_COOLDOWN_TICKS;
  assert.equal(buyShield(match, a).ok, true);
});

test("each shield costs 1.05× the last (scales with cumulative purchases)", () => {
  const { match, a } = activeMatch();
  earn(a, 5000);

  assert.equal(shieldCost(a), SHIELD.COST); // 400, none bought yet
  buyShield(match, a);
  a.castle.shield = 0; // deplete so the next is buyable

  const second = Math.round(SHIELD.COST * SHIELD.COST_GROWTH); // 420
  assert.equal(shieldCost(a), second);
  buyShield(match, a);
  a.castle.shield = 0;

  const third = Math.round(SHIELD.COST * SHIELD.COST_GROWTH ** 2); // 441
  assert.equal(shieldCost(a), third);
  assert.equal(a.castle.shieldsPurchased, 2);
});

test("repairing a full castle is rejected", () => {
  const { match, a } = activeMatch();
  earn(a, 100);
  const result = repairCastle(match, a); // castle starts at full
  assert.equal(result.ok, false);
  assert.equal(result.error, "INVALID_TRANSACTION");
});

test("repair fails without enough money", () => {
  const { match, a } = activeMatch();
  a.castle.hp = a.castle.maxHp - 1000;
  earn(a, 1); // far too little
  const result = repairCastle(match, a);
  assert.equal(result.ok, false);
  assert.equal(result.error, "INSUFFICIENT_FUNDS");
  assert.equal(a.castle.hp, a.castle.maxHp - 1000); // unchanged
});
