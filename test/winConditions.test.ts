import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWinner } from "../src/engine/winConditions.js";
import { tickMatch } from "../src/engine/tick.js";
import { createGameState } from "../src/match/GameState.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
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

test("no winner while two or more kingdoms are alive", () => {
  const state = createGameState([player("a"), player("b")], config);
  assert.deepEqual(resolveWinner(state), { ended: false, winnerId: null });
});

test("last kingdom standing wins", () => {
  const state = createGameState([player("a"), player("b")], config);
  state.getPlayer("b")!.eliminated = true;
  assert.deepEqual(resolveWinner(state), { ended: true, winnerId: "a" });
});

test("no survivors is a draw", () => {
  const state = createGameState([player("a"), player("b")], config);
  state.getPlayer("a")!.eliminated = true;
  state.getPlayer("b")!.eliminated = true;
  assert.deepEqual(resolveWinner(state), { ended: true, winnerId: null });
});

test("tickMatch ends the match when one kingdom remains", () => {
  const match = new Match("1234");
  match.addPlayer(player("a"));
  match.addPlayer(player("b"));
  match.hostId = "a";
  match.start(createMatchConfig(match));

  // Two alive: still active.
  tickMatch(match, 1);
  assert.equal(match.phase, "active");
  assert.equal(match.winnerId, null);

  // Eliminate one: next tick ends the match.
  match.gameState!.getPlayer("b")!.eliminated = true;
  tickMatch(match, 2);
  assert.equal(match.phase, "ended");
  assert.equal(match.winnerId, "a");
});
