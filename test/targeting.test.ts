import { test } from "node:test";
import assert from "node:assert/strict";
import { selectTarget } from "../src/engine/targeting.js";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { TARGETING } from "../src/data/balance.js";
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

function activeMatch(): {
  match: Match;
  a: PlayerState;
  b: PlayerState;
  c: PlayerState;
} {
  const match = new Match("1234");
  match.addPlayer(player("a"));
  match.addPlayer(player("b"));
  match.addPlayer(player("c"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  return {
    match,
    a: gs.getPlayer("a")!,
    b: gs.getPlayer("b")!,
    c: gs.getPlayer("c")!,
  };
}

// --- #61: selecting another active kingdom -----------------------------------

test("a player can target another active kingdom", () => {
  const { match, a } = activeMatch();
  assert.deepEqual(selectTarget(match, a, "b"), { ok: true });
  assert.equal(a.target, "b");
});

test("targeting is switchable between active kingdoms once the cooldown elapses", () => {
  const { match, a } = activeMatch();
  selectTarget(match, a, "b");
  // A switch is gated by the anti-spam cooldown; advance past it.
  match.tick = TARGETING.SWITCH_COOLDOWN_TICKS;
  assert.deepEqual(selectTarget(match, a, "c"), { ok: true });
  assert.equal(a.target, "c");
});

test("passing null clears the current target", () => {
  const { match, a } = activeMatch();
  selectTarget(match, a, "b");
  assert.deepEqual(selectTarget(match, a, null), { ok: true });
  assert.equal(a.target, null);
});

// --- #62: invalid targets are rejected ---------------------------------------

test("cannot target an eliminated kingdom", () => {
  const { match, a, b } = activeMatch();
  b.eliminated = true;
  const result = selectTarget(match, a, "b");
  assert.equal(result.ok, false);
  assert.equal(result.error, "INVALID_TARGET");
  assert.equal(a.target, null); // unchanged
});

test("cannot target a kingdom that dropped after its reconnection grace expired", () => {
  const { match, a } = activeMatch();
  // Grace expiry removes the player from the match roster (but leaves any
  // lingering gameState) — they are no longer a legal target.
  match.removePlayer("b");
  const result = selectTarget(match, a, "b");
  assert.equal(result.ok, false);
  assert.equal(result.error, "INVALID_TARGET");
});

test("a disconnected kingdom still within its grace period remains targetable", () => {
  const { match, a } = activeMatch();
  // Disconnected but still in the roster (mid-grace): their kingdom is in play.
  match.getPlayer("b")!.connected = false;
  assert.deepEqual(selectTarget(match, a, "b"), { ok: true });
  assert.equal(a.target, "b");
});

test("cannot target a nonexistent kingdom", () => {
  const { match, a } = activeMatch();
  const result = selectTarget(match, a, "zzz");
  assert.equal(result.ok, false);
  assert.equal(result.error, "INVALID_TARGET");
});

test("cannot target yourself by default", () => {
  const { match, a } = activeMatch();
  const result = selectTarget(match, a, "a");
  assert.equal(result.ok, false);
  assert.equal(result.error, "INVALID_TARGET");
  assert.equal(a.target, null);
});

test("self-targeting is allowed when an ability explicitly permits it", () => {
  const { match, a } = activeMatch();
  assert.deepEqual(selectTarget(match, a, "a", { allowSelf: true }), {
    ok: true,
  });
  assert.equal(a.target, "a");
});

// --- phase / actor guards ----------------------------------------------------

test("targeting is rejected when the match is not active", () => {
  const { match, a } = activeMatch();
  match.phase = "ended";
  const result = selectTarget(match, a, "b");
  assert.equal(result.ok, false);
  assert.equal(result.error, "INVALID_PHASE");
});

test("an eliminated player cannot select a target", () => {
  const { match, a } = activeMatch();
  a.eliminated = true;
  const result = selectTarget(match, a, "b");
  assert.equal(result.ok, false);
  assert.equal(result.error, "ELIMINATED");
});

// --- anti-spam switch cooldown -----------------------------------------------

test("the first target selection is never gated by the switch cooldown", () => {
  const { match, a } = activeMatch();
  match.tick = 0;
  assert.deepEqual(selectTarget(match, a, "b"), { ok: true });
  // The cooldown now blocks the next switch.
  assert.equal(a.targetSwitchReadyTick, TARGETING.SWITCH_COOLDOWN_TICKS);
});

test("switching to a new target before the cooldown elapses is rejected", () => {
  const { match, a } = activeMatch();
  match.tick = 100;
  selectTarget(match, a, "b"); // readyTick = 100 + 70 = 170

  match.tick = 169; // one tick short
  const result = selectTarget(match, a, "c");
  assert.equal(result.ok, false);
  assert.equal(result.error, "TARGET_ON_COOLDOWN");
  assert.equal(a.target, "b"); // unchanged
});

test("switching is allowed exactly when the cooldown expires", () => {
  const { match, a } = activeMatch();
  match.tick = 100;
  selectTarget(match, a, "b"); // readyTick = 170

  match.tick = 170; // cooldown elapsed
  assert.deepEqual(selectTarget(match, a, "c"), { ok: true });
  assert.equal(a.target, "c");
});

test("re-selecting the current target is a free no-op during the cooldown", () => {
  const { match, a } = activeMatch();
  match.tick = 0;
  selectTarget(match, a, "b");
  const readyTick = a.targetSwitchReadyTick;

  // Still on cooldown, but re-picking the same target is not a switch.
  assert.deepEqual(selectTarget(match, a, "b"), { ok: true });
  assert.equal(a.target, "b");
  assert.equal(a.targetSwitchReadyTick, readyTick); // cooldown not extended
});

test("clearing the target does not reset the cooldown, so it cannot dodge the limit", () => {
  const { match, a } = activeMatch();
  match.tick = 0;
  selectTarget(match, a, "b"); // readyTick = 70

  // Clearing is free...
  assert.deepEqual(selectTarget(match, a, null), { ok: true });
  assert.equal(a.target, null);

  // ...but selecting a different target is still on cooldown.
  match.tick = 10;
  const result = selectTarget(match, a, "c");
  assert.equal(result.ok, false);
  assert.equal(result.error, "TARGET_ON_COOLDOWN");
});
