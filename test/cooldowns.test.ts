import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getCooldown,
  isReady,
  setCooldown,
  tickCooldowns,
} from "../src/engine/cooldowns.js";
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

test("set, query, and clear an ability cooldown", () => {
  const state = createGameState([player("a")], config);
  const a = state.getPlayer("a")!;

  assert.equal(isReady(a, "fireball"), true);
  setCooldown(a, "fireball", 3);
  assert.equal(getCooldown(a, "fireball"), 3);
  assert.equal(isReady(a, "fireball"), false);
  setCooldown(a, "fireball", 0); // clears
  assert.equal(isReady(a, "fireball"), true);
});

test("each ability's cooldown ticks down independently", () => {
  const state = createGameState([player("a")], config);
  const a = state.getPlayer("a")!;
  setCooldown(a, "fireball", 3);
  setCooldown(a, "heal", 1);

  tickCooldowns(state);
  assert.equal(getCooldown(a, "fireball"), 2);
  assert.equal(isReady(a, "heal"), true); // 1 → 0, cleared
  assert.equal("heal" in a.cooldowns, false);

  tickCooldowns(state);
  tickCooldowns(state);
  assert.equal(isReady(a, "fireball"), true);
});

test("cooldowns are independent across players", () => {
  const state = createGameState([player("a"), player("b")], config);
  setCooldown(state.getPlayer("a")!, "ult", 2);

  tickCooldowns(state);
  assert.equal(getCooldown(state.getPlayer("a")!, "ult"), 1);
  assert.equal(getCooldown(state.getPlayer("b")!, "ult"), 0);
});
