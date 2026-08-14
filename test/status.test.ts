import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyStatus,
  getStatus,
  hasStatus,
  removeStatus,
  tickStatuses,
  type StatusEffectDefinition,
} from "../src/engine/status.js";
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

const burn = (stacking: StatusEffectDefinition["stacking"]): StatusEffectDefinition => ({
  id: "burn",
  category: "debuff",
  stacking,
  maxStacks: 3,
});

test("applies a status and expires it after its duration", () => {
  const state = createGameState([player("a")], config);
  const a = state.getPlayer("a")!;

  applyStatus(a, burn("refresh"), { sourceId: "b", durationTicks: 2 });
  assert.equal(hasStatus(a, "burn"), true);

  assert.equal(tickStatuses(state).length, 0); // 2 → 1, none expired
  const expired = tickStatuses(state); // 1 → 0, removed
  assert.equal(hasStatus(a, "burn"), false);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].status.id, "burn");
});

test("stacking rule 'none' ignores re-application", () => {
  const state = createGameState([player("a")], config);
  const a = state.getPlayer("a")!;
  applyStatus(a, burn("none"), { sourceId: "b", durationTicks: 5 });
  applyStatus(a, burn("none"), { sourceId: "b", durationTicks: 2, stacks: 1 });
  const s = getStatus(a, "burn")!;
  assert.equal(s.remainingTicks, 5); // unchanged
  assert.equal(s.stacks, 1);
});

test("stacking rule 'refresh' resets duration but not stacks", () => {
  const state = createGameState([player("a")], config);
  const a = state.getPlayer("a")!;
  applyStatus(a, burn("refresh"), { sourceId: "b", durationTicks: 3, stacks: 1 });
  applyStatus(a, burn("refresh"), { sourceId: "c", durationTicks: 9, stacks: 1 });
  const s = getStatus(a, "burn")!;
  assert.equal(s.remainingTicks, 9);
  assert.equal(s.stacks, 1);
});

test("stacking rule 'stack' adds stacks up to the cap", () => {
  const state = createGameState([player("a")], config);
  const a = state.getPlayer("a")!;
  applyStatus(a, burn("stack"), { sourceId: "b", durationTicks: 3, stacks: 2 });
  applyStatus(a, burn("stack"), { sourceId: "c", durationTicks: 3, stacks: 2 });
  const s = getStatus(a, "burn")!;
  assert.equal(s.stacks, 3); // capped at maxStacks 3
});

test("stacking rule 'extend' adds to the remaining duration", () => {
  const state = createGameState([player("a")], config);
  const a = state.getPlayer("a")!;
  applyStatus(a, burn("extend"), { sourceId: "b", durationTicks: 3 });
  applyStatus(a, burn("extend"), { sourceId: "b", durationTicks: 4 });
  assert.equal(getStatus(a, "burn")!.remainingTicks, 7);
});

test("removeStatus removes it immediately", () => {
  const state = createGameState([player("a")], config);
  const a = state.getPlayer("a")!;
  applyStatus(a, burn("refresh"), { sourceId: "b", durationTicks: 5 });
  assert.equal(removeStatus(a, "burn"), true);
  assert.equal(hasStatus(a, "burn"), false);
  assert.equal(removeStatus(a, "burn"), false);
});
