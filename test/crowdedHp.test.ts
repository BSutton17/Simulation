import test from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import {
  createMatchConfig,
  castleHpMultiplier,
  CROWDED_HP_MULTIPLIER,
  CROWDED_MIN_PLAYERS,
} from "../src/match/matchConfig.js";
import { CASTLE } from "../src/data/balance.js";
import type { MatchPlayer } from "../src/match/types.js";
import { KINGDOM_IDS } from "../src/data/kingdoms.js";

/**
 * Crowded boards start with more health.
 *
 * At six or seven seats a castle takes fire from every other player at once, so
 * the starting HP that makes a duel a fight makes a full lobby a race to focus
 * one player down first.
 */

function seat(i: number, spectator = false): MatchPlayer {
  return {
    id: `p${i}`,
    socketId: `s${i}`,
    name: `P${i}`,
    kingdomId: KINGDOM_IDS[i]!,
    perks: [],
    ready: true,
    connected: true,
    ...(spectator ? { spectator: true, kingdomId: null } : {}),
  };
}

function configFor(playing: number, spectators = 0) {
  const match = new Match(`R${playing}${spectators}`);
  for (let i = 0; i < playing; i++) match.addPlayer(seat(i));
  for (let i = 0; i < spectators; i++) match.addPlayer(seat(playing + i, true));
  return createMatchConfig(match);
}

test("the multiplier applies from the crowd threshold up, and not below it", () => {
  // Read from the constant rather than hardcoded, so tuning the strength of the
  // boost is a one-line change and does not break a test that is about WHEN it
  // applies. The value itself is asserted separately below.
  for (let n = 1; n < CROWDED_MIN_PLAYERS; n++) {
    assert.equal(castleHpMultiplier(n), 1, `${n} seats should be unmodified`);
  }
  for (const n of [CROWDED_MIN_PLAYERS, 7]) {
    assert.equal(castleHpMultiplier(n), CROWDED_HP_MULTIPLIER, `${n} seats`);
  }
});

test("the crowded-board boost is actually switched on", () => {
  // Separate from the threshold test on purpose. A multiplier of exactly 1
  // silently disables the feature while every other test still passes, so the
  // value gets its own assertion that says so out loud.
  assert.ok(
    CROWDED_HP_MULTIPLIER > 1,
    `CROWDED_HP_MULTIPLIER is ${CROWDED_HP_MULTIPLIER} — crowded boards get no extra health`,
  );
});

test("small games are untouched", () => {
  for (const n of [2, 3, 4, 5]) {
    assert.equal(
      configFor(n).startingCastleHp,
      CASTLE.STARTING_HP,
      `${n} players should keep the normal starting health`,
    );
  }
});

test("six and seven player games start at the crowded multiplier", () => {
  for (const n of [6, 7]) {
    assert.equal(
      configFor(n).startingCastleHp,
      Math.round(CASTLE.STARTING_HP * CROWDED_HP_MULTIPLIER),
      `${n} players should start at ${CROWDED_HP_MULTIPLIER}x`,
    );
  }
});

test("spectators do not inflate anyone's health", () => {
  // A five-player game with a watcher is still a five-player game. Counting the
  // watcher would hand everyone 50% more health for a board that has not got
  // any more attackers on it.
  assert.equal(configFor(5, 1).startingCastleHp, CASTLE.STARTING_HP);
  assert.equal(configFor(5, 2).startingCastleHp, CASTLE.STARTING_HP);
  // ...and a genuinely crowded board still scales with a watcher present.
  assert.equal(
    configFor(6, 1).startingCastleHp,
    Math.round(CASTLE.STARTING_HP * CROWDED_HP_MULTIPLIER),
  );
});

test("the snapshot is what the match plays under, so it cannot drift", () => {
  // The config is captured at start; the balance constant is untouched, which is
  // what keeps this out of the balance search and the AI training environment.
  const crowded = configFor(7);
  assert.equal(crowded.startingCastleHp, Math.round(CASTLE.STARTING_HP * CROWDED_HP_MULTIPLIER));
  // The constant itself is never touched, which is what keeps this out of the
  // balance search and the AI training environment.
  assert.equal(CASTLE.STARTING_HP, configFor(2).startingCastleHp);
});
