import { test } from "node:test";
import assert from "node:assert/strict";
import { tickMatch } from "../src/engine/tick.js";
import { applyStatus } from "../src/engine/status.js";
import { setCooldown, getCooldown } from "../src/engine/cooldowns.js";
import { addModifier } from "../src/engine/modifiers.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { KingdomId } from "../src/data/kingdoms.js";
import type { MatchPlayer } from "../src/match/types.js";

const player = (id: string, kingdomId: KingdomId): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

function startedMatch(): Match {
  const match = new Match("1234");
  match.addPlayer(player("a", "plains"));
  match.addPlayer(player("b", "water"));
  match.addPlayer(player("c", "air"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  return match;
}

// A complete match: lobby-started state → several ticks of play (income,
// statuses, cooldowns) → eliminations → a single winner.
test("a match runs from start to a single winner", () => {
  const match = startedMatch();
  const state = match.gameState!;

  // --- initial state (from start) ---
  assert.equal(match.phase, "active");
  assert.equal(state.getPlayers().length, 3);
  for (const p of state.getPlayers()) {
    assert.equal(p.castle.hp, 10_000);
    assert.equal(p.economy.citizens, 10);
    assert.equal(p.economy.currency, 0);
    assert.equal(p.eliminated, false);
  }

  // Alice gets a burn (3 ticks), a cooldown (2 ticks), and an income buff.
  const alice = state.getPlayer("a")!;
  applyStatus(
    alice,
    { id: "burn", category: "debuff", stacking: "refresh" },
    { sourceId: "b", durationTicks: 3 },
  );
  setCooldown(alice, "fireball", 2);
  addModifier(alice, {
    id: "boon",
    stat: "income",
    op: "add",
    value: 1,
    sourceId: "self",
    remainingTicks: null,
  });

  // --- five ticks of normal play ---
  for (let t = 1; t <= 5; t++) assert.equal(tickMatch(match, t), false);

  assert.equal(match.tick, 5);
  // Bob is Water: 10 citizens × $0.0675 × 5 ticks = $3.375 ("We're In This
  // Together": water citizens each produce $1.35/s vs the base $1.20/s).
  assert.equal(state.getPlayer("b")!.economy.currency, 3.375);
  // Carol (Air, no production passive): plain $0.4/tick = $2 total.
  assert.equal(state.getPlayer("c")!.economy.currency, 3);
  // Alice earned +$1 income each tick → ($0.4 base + $1 boon) × 5 = $7.
  assert.equal(alice.economy.currency, 8);
  // Cooldown (2) and burn (3) have expired.
  assert.equal(getCooldown(alice, "fireball"), 0);
  assert.equal(alice.statuses.length, 0);
  assert.equal(match.phase, "active"); // three still alive

  // --- eliminations resolve the match ---
  state.getPlayer("c")!.eliminated = true;
  assert.equal(tickMatch(match, 6), false); // two alive → still active
  assert.equal(match.phase, "active");

  state.getPlayer("b")!.eliminated = true;
  assert.equal(tickMatch(match, 7), true); // one alive → match ends
  assert.equal(match.phase, "ended");
  assert.equal(match.winnerId, "a");
});

test("simultaneous final eliminations end the match in a draw", () => {
  const match = new Match("4321");
  match.addPlayer(player("a", "fire"));
  match.addPlayer(player("b", "water"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const state = match.gameState!;

  assert.equal(tickMatch(match, 1), false); // both alive

  state.getPlayer("a")!.eliminated = true;
  state.getPlayer("b")!.eliminated = true;
  assert.equal(tickMatch(match, 2), true);
  assert.equal(match.phase, "ended");
  assert.equal(match.winnerId, null); // draw
});
