import { test } from "node:test";
import assert from "node:assert/strict";
import { tickMatch } from "../src/engine/tick.js";
import { setCooldown } from "../src/engine/cooldowns.js";
import { applyStatus } from "../src/engine/status.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";

const player = (id: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: "plains",
  ready: true,
  connected: true,
});

function startedMatch(): Match {
  const match = new Match("1234");
  match.addPlayer(player("a"));
  match.addPlayer(player("b"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  return match;
}

// Integration: one tick runs every engine phase and advances the tick counter.
test("tickMatch advances the tick and runs all phases", () => {
  const match = startedMatch();
  const state = match.gameState!;
  const a = state.getPlayer("a")!;
  setCooldown(a, "fireball", 2);
  applyStatus(
    a,
    { id: "burn", category: "debuff", stacking: "refresh" },
    { sourceId: "b", durationTicks: 1 },
  );

  tickMatch(match, 1);

  assert.equal(match.tick, 1);
  assert.equal(state.tick, 1);
  assert.equal(a.economy.currency, 0.6); // income: 10 citizens * 0.04
  assert.equal(a.cooldowns.fireball, 1); // cooldown decremented
  assert.equal(a.statuses.length, 0); // burn expired (1 → 0)
});

test("tickMatch is a no-op when there is no game state", () => {
  const match = new Match("1234"); // never started → gameState null
  tickMatch(match, 5);
  assert.equal(match.tick, 5);
  assert.equal(match.gameState, null);
});
