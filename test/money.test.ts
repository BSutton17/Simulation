import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canAfford,
  earn,
  getBalance,
  spend,
} from "../src/engine/money.js";
import { createGameState } from "../src/match/GameState.js";
import type { MatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";

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

function makePlayer() {
  return createGameState([player("a")], config).getPlayer("a")!;
}

test("earn adds money and stays cent-precise", () => {
  const p = makePlayer();
  earn(p, 0.1);
  earn(p, 0.2);
  assert.equal(getBalance(p), 0.3); // no float drift
});

test("earn ignores non-positive amounts", () => {
  const p = makePlayer();
  earn(p, -5);
  earn(p, 0);
  assert.equal(getBalance(p), 0);
});

test("spend deducts when affordable and reports success", () => {
  const p = makePlayer();
  earn(p, 10);
  assert.equal(canAfford(p, 4), true);
  assert.equal(spend(p, 4), true);
  assert.equal(getBalance(p), 6);
});

test("spend fails and changes nothing when unaffordable", () => {
  const p = makePlayer();
  earn(p, 3);
  assert.equal(canAfford(p, 5), false);
  assert.equal(spend(p, 5), false);
  assert.equal(getBalance(p), 3); // unchanged
});
