import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTransaction } from "../src/engine/transactions.js";
import { earn } from "../src/engine/money.js";
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

test("valid, affordable purchase passes", () => {
  const { match, a } = activeMatch();
  earn(a, 100);
  assert.deepEqual(validateTransaction(match, a, 40), { ok: true });
});

test("rejects when the match is not active", () => {
  const { match, a } = activeMatch();
  earn(a, 100);
  match.phase = "lobby";
  assert.equal(validateTransaction(match, a, 10).error, "INVALID_PHASE");
});

test("rejects an eliminated buyer", () => {
  const { match, a } = activeMatch();
  earn(a, 100);
  a.eliminated = true;
  assert.equal(validateTransaction(match, a, 10).error, "ELIMINATED");
});

test("rejects an invalid cost", () => {
  const { match, a } = activeMatch();
  earn(a, 100);
  assert.equal(validateTransaction(match, a, -5).error, "INVALID_TRANSACTION");
  assert.equal(validateTransaction(match, a, NaN).error, "INVALID_TRANSACTION");
});

test("rejects when funds are insufficient", () => {
  const { match, a } = activeMatch();
  earn(a, 3);
  assert.equal(validateTransaction(match, a, 5).error, "INSUFFICIENT_FUNDS");
});
