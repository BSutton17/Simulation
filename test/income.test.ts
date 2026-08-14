import { test } from "node:test";
import assert from "node:assert/strict";
import { computeIncome, recalcIncome } from "../src/engine/economy.js";
import { buyCitizen } from "../src/engine/purchases.js";
import { earn } from "../src/engine/money.js";
import { addModifier } from "../src/engine/modifiers.js";
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

function activeMatch(): { match: Match; a: PlayerState } {
  const match = new Match("1234");
  match.addPlayer(player("a"));
  match.addPlayer(player("b"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  return { match, a: match.gameState!.getPlayer("a")! };
}

test("recalcIncome reflects citizen count and income modifiers", () => {
  const { a } = activeMatch();
  recalcIncome(a);
  assert.equal(a.economy.incomePerTick, 0.6); // 10 citizens × $0.04/tick

  addModifier(a, {
    id: "boon",
    stat: "income",
    op: "add",
    value: 0.5,
    sourceId: "x",
    remainingTicks: null,
  });
  recalcIncome(a);
  assert.equal(a.economy.incomePerTick, 1.1);
  assert.equal(computeIncome(a), 1.1);
});

test("buying a citizen updates income immediately, before any tick", () => {
  const { match, a } = activeMatch();
  earn(a, 100);
  recalcIncome(a);
  assert.equal(a.economy.incomePerTick, 0.6); // 10 citizens × $0.04/tick

  assert.equal(buyCitizen(match, a).ok, true);
  // 11 citizens now → income refreshed right away, no tick needed.
  assert.equal(a.economy.citizens, 11);
  assert.equal(a.economy.incomePerTick, 0.66); // 11 * 0.04, exact
});
