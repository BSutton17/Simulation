import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { activateAbility } from "../src/engine/abilities.js";
import { unlockOrUpgradeAbility } from "../src/engine/purchases.js";
import { applyPassiveIncome } from "../src/engine/economy.js";
import { earn } from "../src/engine/money.js";
import {
  WHEEL_POCKETS,
  colorOfPocket,
  settleBet,
  spinWheel,
  placeRouletteBet,
  describeResult,
  ROULETTE_DAMAGE,
  ROULETTE_HALF_DAMAGE,
  ROULETTE_GREEN_HEAL,
  ROULETTE_REVEAL_TICKS,
  isBetColor,
} from "../src/engine/roulette.js";
import { ROULETTE, SLOT_MACHINE } from "../src/data/jokerAbilities.js";
import type { PlayerState } from "../src/match/playerState.js";
import type { MatchPlayer } from "../src/match/types.js";

// Joker's Roulette. A EUROPEAN wheel — a single green zero — so the house edge
// and the green jackpot are both 1/37, not the American 2/38.

const matchPlayer = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks: [],
  ready: true,
  connected: true,
});

function rouletteMatch(): { match: Match; a: PlayerState; b: PlayerState } {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("a", "joker"));
  match.addPlayer(matchPlayer("b", "water"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const a = match.gameState!.getPlayer("a")!;
  earn(a, 1_000_000);
  assert.equal(unlockOrUpgradeAbility(match, a, ROULETTE.id).ok, true);
  a.target = "b";
  return { match, a, b: match.gameState!.getPlayer("b")! };
}

/** The roll that lands a given pocket. */
const rollFor = (pocket: number) =>
  WHEEL_POCKETS.indexOf(pocket) / WHEEL_POCKETS.length;

/** A pocket of each colour, for readable tests. */
const A_RED = 32;
const A_BLACK = 15;
const ZERO = 0;

// --- The wheel --------------------------------------------------------------

test("it is a European wheel: 37 pockets and exactly one green", () => {
  assert.equal(WHEEL_POCKETS.length, 37);
  assert.equal(new Set(WHEEL_POCKETS).size, 37, "a pocket is duplicated");
  const greens = WHEEL_POCKETS.filter((p) => colorOfPocket(p) === "green");
  assert.deepEqual(greens, [0], "a European wheel has a single zero");
  assert.equal(WHEEL_POCKETS.filter((p) => colorOfPocket(p) === "red").length, 18);
  assert.equal(WHEEL_POCKETS.filter((p) => colorOfPocket(p) === "black").length, 18);
  // Every number 0–36 present exactly once.
  for (let n = 0; n <= 36; n++) {
    assert.equal(WHEEL_POCKETS.includes(n), true, `pocket ${n} is missing`);
  }
});

test("the wheel draws uniformly across all 37 pockets", () => {
  assert.equal(spinWheel(() => 0), WHEEL_POCKETS[0]);
  assert.equal(spinWheel(() => 0.9999), WHEEL_POCKETS[36]);
  assert.equal(spinWheel(() => rollFor(A_RED)), A_RED);
});

test("only red, black, and green are legal bets", () => {
  assert.equal(isBetColor("red"), true);
  assert.equal(isBetColor("black"), true);
  assert.equal(isBetColor("green"), true);
  assert.equal(isBetColor("blue"), false);
  assert.equal(isBetColor(0), false);
  assert.equal(isBetColor(undefined), false);
});

// --- The payouts ------------------------------------------------------------

test("a colour called RIGHT still costs half damage", () => {
  assert.deepEqual(settleBet("red", A_RED), {
    won: true,
    damage: ROULETTE_HALF_DAMAGE,
    heal: 0,
  });
  assert.deepEqual(settleBet("black", A_BLACK), {
    won: true,
    damage: ROULETTE_HALF_DAMAGE,
    heal: 0,
  });
});

test("a colour called WRONG costs full damage — including on a zero", () => {
  assert.deepEqual(settleBet("red", A_BLACK), {
    won: false,
    damage: ROULETTE_DAMAGE,
    heal: 0,
  });
  // The green zero beats both colour bets: that is the house edge.
  assert.deepEqual(settleBet("red", ZERO), {
    won: false,
    damage: ROULETTE_DAMAGE,
    heal: 0,
  });
  assert.deepEqual(settleBet("black", ZERO), {
    won: false,
    damage: ROULETTE_DAMAGE,
    heal: 0,
  });
});

test("green hits heal, and green misses cost half again as much", () => {
  assert.deepEqual(settleBet("green", ZERO), {
    won: true,
    damage: 0,
    heal: ROULETTE_GREEN_HEAL,
  });
  assert.deepEqual(settleBet("green", A_RED), {
    won: false,
    damage: Math.round(ROULETTE_DAMAGE * 1.5),
    heal: 0,
  });
  // A green miss is strictly worse than any colour bet.
  assert.ok(settleBet("green", A_RED).damage > settleBet("red", A_BLACK).damage);
});

test("the result text never leaks a percentage", () => {
  for (const bet of ["red", "black", "green"] as const) {
    for (const pocket of [ZERO, A_RED, A_BLACK]) {
      const { won, damage, heal } = settleBet(bet, pocket);
      const text = describeResult({
        pocket,
        color: colorOfPocket(pocket),
        bet,
        won,
        damage,
        healed: heal,
      });
      assert.equal(text.includes("%"), false, `"${text}" leaks a percentage`);
    }
  }
});

// --- The table's grip -------------------------------------------------------

test("the ability seats the victim at a wheel and freezes their gold", () => {
  const { match, a, b } = rouletteMatch();
  assert.equal(activateAbility(match, a, ROULETTE, { forceCrit: false }).ok, true);

  assert.ok(b.pendingBet, "no wheel was put in front of them");
  assert.equal(b.pendingBet!.sourceId, a.id);
  assert.equal(a.pendingBet, null, "Joker seated itself");

  b.economy.citizens = 50;
  const before = b.economy.currency;
  const jokerBefore = a.economy.currency;
  applyPassiveIncome(match.gameState!);
  assert.equal(b.economy.currency, before, "a frozen treasury still earned");
  assert.equal(b.economy.incomePerTick, 0);
  assert.ok(a.economy.currency > jokerBefore, "Joker's own income stopped too");
});

test("placing the bet frees the gold immediately, before the ball settles", () => {
  const { match, a, b } = rouletteMatch();
  assert.equal(activateAbility(match, a, ROULETTE, { forceCrit: false }).ok, true);
  b.economy.citizens = 50;

  const result = placeRouletteBet(match, b, "red", () => rollFor(A_RED));
  assert.ok(result);
  assert.equal(b.pendingBet, null, "the debt was not settled");

  const before = b.economy.currency;
  applyPassiveIncome(match.gameState!);
  assert.ok(b.economy.currency > before, "gold production did not resume");
});

test("betting without a wheel in front of you is refused", () => {
  const { match, b } = rouletteMatch();
  assert.equal(placeRouletteBet(match, b, "red"), null);
});

test("a second wheel doesn't stack on someone already seated", () => {
  const { match, a, b } = rouletteMatch();
  assert.equal(activateAbility(match, a, ROULETTE, { forceCrit: false }).ok, true);
  const first = b.pendingBet;
  a.cooldowns = {};
  assert.equal(activateAbility(match, a, ROULETTE, { forceCrit: false }).ok, true);
  assert.equal(b.pendingBet, first);
});

test("the result is held back until revealTick so both screens agree", () => {
  const { match, a, b } = rouletteMatch();
  assert.equal(activateAbility(match, a, ROULETTE, { forceCrit: false }).ok, true);
  match.tick = 200;
  placeRouletteBet(match, b, "black", () => rollFor(A_BLACK));

  assert.ok(b.lastBet);
  assert.equal(b.lastBet!.revealTick, 200 + ROULETTE_REVEAL_TICKS);
  assert.equal(b.lastBet!.pocket, A_BLACK);
  assert.equal(b.lastBet!.color, "black");
  assert.equal(b.lastBet!.bet, "black");
});

// --- The damage actually landing --------------------------------------------

test("a right call takes half, a wrong call takes full", () => {
  const right = rouletteMatch();
  assert.equal(activateAbility(right.match, right.a, ROULETTE, { forceCrit: false }).ok, true);
  placeRouletteBet(right.match, right.b, "red", () => rollFor(A_RED));
  assert.equal(right.b.castle.maxHp - right.b.castle.hp, ROULETTE_HALF_DAMAGE);

  const wrong = rouletteMatch();
  assert.equal(activateAbility(wrong.match, wrong.a, ROULETTE, { forceCrit: false }).ok, true);
  placeRouletteBet(wrong.match, wrong.b, "red", () => rollFor(A_BLACK));
  assert.equal(wrong.b.castle.maxHp - wrong.b.castle.hp, ROULETTE_DAMAGE);
});

test("hitting green heals instead of hurting", () => {
  const { match, a, b } = rouletteMatch();
  assert.equal(activateAbility(match, a, ROULETTE, { forceCrit: false }).ok, true);
  b.castle.hp = b.castle.maxHp - 5000;

  placeRouletteBet(match, b, "green", () => rollFor(ZERO));
  assert.equal(b.castle.hp, b.castle.maxHp - 5000 + ROULETTE_GREEN_HEAL);
});

test("missing green is the worst seat at the table", () => {
  const { match, a, b } = rouletteMatch();
  assert.equal(activateAbility(match, a, ROULETTE, { forceCrit: false }).ok, true);
  placeRouletteBet(match, b, "green", () => rollFor(A_RED));
  assert.equal(
    b.castle.maxHp - b.castle.hp,
    Math.round(ROULETTE_DAMAGE * 1.5),
  );
});

// --- The two casino games never overlap -------------------------------------

test("a slot machine and a wheel are ordered so only one plays at a time", () => {
  const { match, a, b } = rouletteMatch();
  earn(a, 1_000_000);
  assert.equal(unlockOrUpgradeAbility(match, a, SLOT_MACHINE.id).ok, true);

  match.tick = 50;
  assert.equal(activateAbility(match, a, ROULETTE, { forceCrit: false }).ok, true);
  match.tick = 90;
  a.cooldowns = {};
  assert.equal(activateAbility(match, a, SLOT_MACHINE, { forceCrit: false }).ok, true);

  // Both are owed, and `atTick` says which the client shows first.
  assert.ok(b.pendingBet);
  assert.ok(b.pendingSpin);
  assert.equal(b.pendingBet!.atTick, 50);
  assert.equal(b.pendingSpin!.atTick, 90);
  assert.ok(b.pendingBet!.atTick < b.pendingSpin!.atTick, "the wheel came first");

  // Income stays frozen while EITHER is outstanding.
  b.economy.citizens = 50;
  placeRouletteBet(match, b, "red", () => rollFor(A_RED));
  const before = b.economy.currency;
  applyPassiveIncome(match.gameState!);
  assert.equal(b.economy.currency, before, "the slot machine should still hold it");
});
