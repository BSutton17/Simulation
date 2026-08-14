import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addModifier,
  computeStat,
  removeModifier,
  removeModifiersFromSource,
  tickModifiers,
} from "../src/engine/modifiers.js";
import { applyPassiveIncome } from "../src/engine/economy.js";
import { createGameState } from "../src/match/GameState.js";
import type { MatchConfig } from "../src/match/matchConfig.js";
import type { Modifier } from "../src/match/playerState.js";
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

const mod = (over: Partial<Modifier>): Modifier => ({
  id: "m1",
  stat: "damage",
  op: "add",
  value: 10,
  sourceId: "src",
  remainingTicks: null,
  ...over,
});

test("computeStat applies additive then multiplicative modifiers", () => {
  const state = createGameState([player("a")], config);
  const a = state.getPlayer("a")!;
  addModifier(a, mod({ id: "m1", stat: "damage", op: "add", value: 20 }));
  addModifier(a, mod({ id: "m2", stat: "damage", op: "mult", value: 1.5 }));
  // (100 + 20) * 1.5 = 180
  assert.equal(computeStat(a, "damage", 100), 180);
  // Unaffected stat returns the base.
  assert.equal(computeStat(a, "speed", 5), 5);
});

test("modifiers expire on their duration; removal works", () => {
  const state = createGameState([player("a")], config);
  const a = state.getPlayer("a")!;
  addModifier(a, mod({ id: "temp", remainingTicks: 2 }));
  addModifier(a, mod({ id: "perm", remainingTicks: null }));

  tickModifiers(state);
  assert.equal(a.modifiers.length, 2); // temp 2 → 1
  tickModifiers(state);
  assert.equal(a.modifiers.some((m) => m.id === "temp"), false); // expired
  assert.equal(a.modifiers.some((m) => m.id === "perm"), true); // permanent stays

  assert.equal(removeModifier(a, "perm"), true);
  assert.equal(a.modifiers.length, 0);
});

test("removeModifiersFromSource clears everything from a source", () => {
  const state = createGameState([player("a")], config);
  const a = state.getPlayer("a")!;
  addModifier(a, mod({ id: "m1", sourceId: "ult" }));
  addModifier(a, mod({ id: "m2", sourceId: "ult" }));
  addModifier(a, mod({ id: "m3", sourceId: "other" }));
  assert.equal(removeModifiersFromSource(a, "ult"), 2);
  assert.equal(a.modifiers.length, 1);
});

test("an income modifier boosts passive income", () => {
  const state = createGameState([player("a")], config);
  const a = state.getPlayer("a")!;
  // Base income is 10 citizens * 0.04 = 0.4; a +1.0 modifier makes it 1.4.
  addModifier(a, mod({ id: "boon", stat: "income", op: "add", value: 1 }));
  applyPassiveIncome(state);
  assert.equal(a.economy.currency, 1.6);
})
