import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPassiveIncome, recalcIncome } from "../src/engine/economy.js";
import {
  buyCitizen,
  buyShield,
  citizenCost,
  repairCastle,
  repairCost,
} from "../src/engine/purchases.js";
import { earn, getBalance } from "../src/engine/money.js";
import { createGameState } from "../src/match/GameState.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { CASTLE, ECONOMY, SHIELD } from "../src/data/balance.js";
import type { MatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";

const config: MatchConfig = {
  roomCode: "1234",
  maxPlayers: 8,
  tickRate: 20,
  startingCitizens: 10,
  startingCastleHp: 10_000,
};

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

// --- money generation -------------------------------------------------------

test("income equals citizens × rate and accrues over many ticks", () => {
  const state = createGameState([player("a")], config);
  const a = state.getPlayer("a")!;
  for (let i = 0; i < 50; i++) applyPassiveIncome(state);
  // 10 citizens × $0.04 × 50 ticks = $20.
  assert.equal(getBalance(a), 30);
  assert.equal(a.economy.incomePerTick, 0.6);
});

test("a player with no citizens earns nothing", () => {
  const state = createGameState([player("a")], config);
  const a = state.getPlayer("a")!;
  a.economy.citizens = 0;
  recalcIncome(a);
  assert.equal(a.economy.incomePerTick, 0);
  applyPassiveIncome(state);
  assert.equal(getBalance(a), 0);
});

test("economies are independent across players", () => {
  const state = createGameState([player("a"), player("b")], config);
  const a = state.getPlayer("a")!;
  const b = state.getPlayer("b")!;
  b.economy.citizens = 20;
  applyPassiveIncome(state);
  assert.equal(a.economy.incomePerTick, 0.6); // 10 citizens
  assert.equal(b.economy.incomePerTick, 1.2); // 20 citizens
});

// --- citizen purchasing + scaling ------------------------------------------

test("citizen cost follows the exact scaling sequence", () => {
  const { match, a } = activeMatch();
  earn(a, 1000);
  const costs: number[] = [];
  for (let i = 0; i < 6; i++) {
    costs.push(citizenCost(a));
    buyCitizen(match, a);
  }
  // base 25 × 1.10^n, rounded to whole dollars.
  assert.deepEqual(costs, [25, 28, 30, 33, 37, 40]);
  assert.equal(a.economy.citizens, config.startingCitizens + 6);
});

test("buying a citizen debits exactly its current cost", () => {
  const { match, a } = activeMatch();
  earn(a, 100);
  const cost = citizenCost(a);
  buyCitizen(match, a);
  assert.equal(getBalance(a), 100 - cost);
});

// --- repairs + scaling ------------------------------------------------------

test("repair cost follows the exact scaling sequence", () => {
  const { match, a } = activeMatch();
  a.castle.hp = a.castle.maxHp - CASTLE.REPAIR_AMOUNT * 5; // room for repairs
  earn(a, 10_000);
  const costs: number[] = [];
  for (let i = 0; i < 3; i++) {
    costs.push(repairCost(a));
    repairCastle(match, a);
  }
  // flat base $500, × 1.25^n, rounded to whole dollars.
  assert.deepEqual(costs, [500, 625, 781]);
});

test("repair only restores missing HP; the flat cost applies regardless", () => {
  const { match, a } = activeMatch();
  a.castle.hp = a.castle.maxHp - 200; // less than one repair chunk
  earn(a, 2000);
  repairCastle(match, a);
  assert.equal(a.castle.hp, a.castle.maxHp);
  assert.equal(getBalance(a), 2000 - CASTLE.REPAIR_COST);
});

// --- shields ----------------------------------------------------------------

test("shield lifecycle: buy, block duplicate, rebuy after depletion", () => {
  const { match, a } = activeMatch();
  earn(a, 2000);

  assert.equal(buyShield(match, a).ok, true);
  assert.equal(a.castle.shield, SHIELD.STANDARD_HP);

  assert.equal(buyShield(match, a).error, "SHIELD_ACTIVE");

  a.castle.shield = 0; // depleted by damage (future)
  assert.equal(buyShield(match, a).ok, true);
  assert.equal(a.castle.shield, SHIELD.STANDARD_HP);
});

// --- full cycle -------------------------------------------------------------

test("earn → spend → income all reconcile", () => {
  const { match, a } = activeMatch();
  earn(a, 100);
  const citizenPrice = citizenCost(a);
  buyCitizen(match, a); // spend
  const afterBuy = getBalance(a);
  assert.equal(afterBuy, 100 - citizenPrice);

  // Now 11 citizens → income is $0.44/tick, exact at 4 decimals.
  applyPassiveIncome(match.gameState!);
  assert.equal(getBalance(a), afterBuy + 0.66);
});
