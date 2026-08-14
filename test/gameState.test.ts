import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../src/match/GameState.js";
import { createPlayerState } from "../src/match/playerState.js";
import type { MatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";
import { CASTLE, CITIZENS } from "../src/data/balance.js";

const config: MatchConfig = {
  roomCode: "1234",
  maxPlayers: 8,
  tickRate: 20,
  startingCitizens: CITIZENS.STARTING_COUNT,
  startingCastleHp: CASTLE.STARTING_HP,
};

const player = (id: string, kingdomId: MatchPlayer["kingdomId"]): MatchPlayer => ({
  id,
  socketId: `sock-${id}`,
  name: `Player ${id}`,
  kingdomId,
  ready: true,
  connected: true,
});

// #43 — initialization from selected kingdom + shared constants.
test("createPlayerState initializes stats from the kingdom and constants", () => {
  const state = createPlayerState(
    { id: "a", name: "Alice", kingdomId: "plains" },
    config,
  );

  assert.equal(state.kingdomId, "plains");
  assert.equal(state.castle.hp, CASTLE.STARTING_HP);
  assert.equal(state.castle.maxHp, CASTLE.STARTING_HP);
  assert.equal(state.castle.shield, 0);
  assert.equal(state.economy.citizens, CITIZENS.STARTING_COUNT);
  assert.equal(state.economy.currency, 0);
});

// #42 — the runtime player object carries every gameplay value.
test("player state exposes money, health, shield, citizens, cooldowns, statuses, target", () => {
  const state = createPlayerState(
    { id: "a", name: "Alice", kingdomId: "ice" },
    config,
  );

  assert.equal(typeof state.economy.currency, "number"); // money
  assert.equal(typeof state.castle.hp, "number"); // health
  assert.equal(typeof state.castle.shield, "number"); // shield health
  assert.equal(typeof state.economy.citizens, "number");
  assert.deepEqual(state.cooldowns, {});
  assert.deepEqual(state.statuses, []);
  assert.deepEqual(state.combos, []);
  assert.deepEqual(state.upgrades, {});
  assert.equal(state.target, null); // selected target
  assert.equal(state.eliminated, false);
});

// #41 — the central game state stores every playing player.
test("createGameState builds state for each player with a kingdom", () => {
  const state = createGameState(
    [player("a", "fire"), player("b", "water"), player("c", null)],
    config,
  );

  // Player c has no kingdom, so is omitted.
  assert.equal(state.playerCount, 2);
  assert.equal(state.getPlayer("a")?.kingdomId, "fire");
  assert.equal(state.getPlayer("b")?.economy.citizens, CITIZENS.STARTING_COUNT);
  assert.equal(state.getPlayer("c"), undefined);
  assert.equal(state.tick, 0);
  assert.deepEqual(state.serialize().projectiles, []);
});
