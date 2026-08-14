import { test } from "node:test";
import assert from "node:assert/strict";
import { CASTLE, CITIZENS, COMBAT, LOBBY, MATCH } from "../src/data/balance.js";

// Shared constants. Spec-defined values (starting HP/citizens) are asserted
// exactly; tunable values (crit, room code) are asserted for valid ranges so
// the tests don't break every time balance is adjusted.

test("starting Castle HP matches the game spec (10,000)", () => {
  assert.equal(CASTLE.STARTING_HP, 10_000);
});

test("starting citizens match the game spec (10)", () => {
  assert.equal(CITIZENS.STARTING_COUNT, 10);
});

test("base crit chance is a probability in [0, 1]", () => {
  assert.ok(
    COMBAT.BASE_CRIT_CHANCE >= 0 && COMBAT.BASE_CRIT_CHANCE <= 1,
    `BASE_CRIT_CHANCE out of range: ${COMBAT.BASE_CRIT_CHANCE}`,
  );
});

test("base crit multiplier is at least 1x", () => {
  assert.ok(
    COMBAT.BASE_CRIT_MULTIPLIER >= 1,
    `BASE_CRIT_MULTIPLIER should be >= 1: ${COMBAT.BASE_CRIT_MULTIPLIER}`,
  );
});

test("room code length is a positive integer", () => {
  assert.ok(
    Number.isInteger(LOBBY.ROOM_CODE_LENGTH) && LOBBY.ROOM_CODE_LENGTH > 0,
    `ROOM_CODE_LENGTH invalid: ${LOBBY.ROOM_CODE_LENGTH}`,
  );
});

test("match player-count bounds match the game spec (2–8)", () => {
  assert.equal(MATCH.MIN_PLAYERS, 2);
  assert.equal(MATCH.MAX_PLAYERS, 8);
});
