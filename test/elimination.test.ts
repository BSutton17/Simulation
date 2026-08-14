import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDeaths, processDeaths } from "../src/engine/elimination.js";
import { applyDamage } from "../src/engine/combat.js";
import { applyPassiveIncome } from "../src/engine/economy.js";
import { applyStatus } from "../src/engine/status.js";
import { addModifier } from "../src/engine/modifiers.js";
import { setCooldown } from "../src/engine/cooldowns.js";
import { selectTarget } from "../src/engine/targeting.js";
import { buyCitizen } from "../src/engine/purchases.js";
import { earn } from "../src/engine/money.js";
import { tickMatch } from "../src/engine/tick.js";
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

function activeMatch(ids: string[] = ["a", "b", "c"]): {
  match: Match;
  players: Record<string, PlayerState>;
} {
  const match = new Match("1234");
  for (const id of ids) match.addPlayer(player(id));
  match.hostId = ids[0];
  match.start(createMatchConfig(match));
  const players: Record<string, PlayerState> = {};
  for (const id of ids) players[id] = match.gameState!.getPlayer(id)!;
  return { match, players };
}

// --- #69: death detection ------------------------------------------------------

test("detectDeaths identifies castles at exactly 0 HP", () => {
  const { match, players } = activeMatch();
  players.b.castle.hp = 0;
  const dead = detectDeaths(match.gameState!);
  assert.deepEqual(dead.map((p) => p.id), ["b"]);
});

test("living castles are never flagged, even at 1 HP", () => {
  const { match, players } = activeMatch();
  players.b.castle.hp = 1;
  assert.equal(detectDeaths(match.gameState!).length, 0);
});

test("a killing blow through applyDamage is detected and processed on the next tick", () => {
  const { match, players } = activeMatch();
  const result = applyDamage(players.b, 20_000);
  assert.equal(result.eliminated, true); // flagged at the moment of the blow

  tickMatch(match, 1); // death phase runs the elimination process
  assert.equal(players.b.eliminated, true);
  assert.equal(players.b.eliminatedAtTick, 1);
});

test("each death is processed exactly once", () => {
  const { match, players } = activeMatch();
  players.b.castle.hp = 0;
  assert.equal(processDeaths(match).length, 1);
  assert.equal(processDeaths(match).length, 0); // already processed
  assert.equal(players.b.eliminatedAtTick, 0);
});

// --- #70: the elimination process ---------------------------------------------

test("elimination clears pending gameplay state but preserves match statistics", () => {
  const { match, players } = activeMatch();
  const b = players.b;
  earn(b, 123.45);
  b.economy.citizens = 17;
  applyStatus(
    b,
    { id: "burn", category: "debuff", stacking: "refresh" },
    { sourceId: "a", durationTicks: 100 },
  );
  addModifier(b, {
    id: "buff",
    stat: "damage",
    op: "add",
    value: 10,
    sourceId: "b",
    remainingTicks: null,
  });
  setCooldown(b, "fireball", 50);
  match.tick = 40;
  selectTarget(match, b, "a");

  b.castle.hp = 0;
  processDeaths(match);

  // Removed from active gameplay…
  assert.deepEqual(b.statuses, []);
  assert.deepEqual(b.modifiers, []);
  assert.deepEqual(b.cooldowns, {});
  assert.equal(b.target, null);
  // …but statistics survive for end-of-match reporting.
  assert.equal(b.economy.currency, 123.45);
  assert.equal(b.economy.citizens, 17);
  assert.equal(b.eliminatedAtTick, 40);
});

test("opponents targeting the dead kingdom lose their target and may re-target at once", () => {
  const { match, players } = activeMatch();
  match.tick = 10;
  selectTarget(match, players.a, "b"); // a aims at b; switch cooldown armed

  match.tick = 20; // still within a's switch cooldown (10 + 70)
  players.b.castle.hp = 0;
  processDeaths(match);

  assert.equal(players.a.target, null);
  // The waived cooldown lets 'a' immediately pick a new target.
  assert.deepEqual(selectTarget(match, players.a, "c"), { ok: true });
});

test("an eliminated kingdom can no longer interact with the game", () => {
  const { match, players } = activeMatch();
  const b = players.b;
  earn(b, 1000);
  b.castle.hp = 0;
  processDeaths(match);

  // No income.
  const balance = b.economy.currency;
  applyPassiveIncome(match.gameState!);
  assert.equal(b.economy.currency, balance);

  // No purchases.
  assert.equal(buyCitizen(match, b).error, "ELIMINATED");

  // No targeting, in either direction.
  assert.equal(selectTarget(match, b, "a").error, "ELIMINATED");
  assert.equal(selectTarget(match, players.a, "b").error, "INVALID_TARGET");

  // No further damage processing.
  const hit = applyDamage(b, 500);
  assert.equal(hit.dealtToHp, 0);
});

test("death by damage ends the match when only one kingdom survives", () => {
  const { match, players } = activeMatch(["a", "b"]);
  applyDamage(players.b, 20_000);

  const ended = tickMatch(match, 5);
  assert.equal(ended, true);
  assert.equal(match.phase, "ended");
  assert.equal(match.winnerId, "a");
  assert.equal(players.b.eliminatedAtTick, 5);
});

test("simultaneous deaths in the same tick produce a draw", () => {
  const { match, players } = activeMatch(["a", "b"]);
  applyDamage(players.a, 20_000);
  applyDamage(players.b, 20_000);

  assert.equal(tickMatch(match, 3), true);
  assert.equal(match.winnerId, null);
  assert.equal(players.a.eliminatedAtTick, 3);
  assert.equal(players.b.eliminatedAtTick, 3);
});
