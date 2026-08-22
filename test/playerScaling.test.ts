import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { CASTLE, PLAYER_SCALING } from "../src/data/balance.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { KingdomId } from "../src/data/kingdoms.js";

/**
 * Castles scale with the size of the table.
 *
 * ⚠️ MORE PLAYERS MEANS MORE INCOMING DAMAGE, NOT MORE TIME. In a seven-player
 * free-for-all a castle can be the target of six kingdoms while still earning
 * one kingdom's income, so a pool sized for a duel is spent far faster than the
 * match can be won.
 *
 * Counted from TWO so a duel is untouched — the case every existing balance
 * number was tuned against.
 */

const player = (id: string, kingdomId: KingdomId): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

/** Starts a match with `n` seats and returns the first seat's castle. */
function castleWith(n: number, kingdomId: KingdomId = "plains") {
  const fill: KingdomId[] = [
    "plains", "water", "fire", "air", "earth", "ice", "nature",
  ] as KingdomId[];
  const match = new Match("1234");
  match.addPlayer(player("p0", kingdomId));
  for (let i = 1; i < n; i++) match.addPlayer(player(`p${i}`, fill[i]!));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  return match.gameState!.getPlayer("p0")!.castle;
}

test("a duel is unchanged — scaling counts from two players", () => {
  const castle = castleWith(2);
  assert.equal(castle.maxHp, CASTLE.STARTING_HP);
  assert.equal(castle.hp, CASTLE.STARTING_HP);
});

test("each player above two adds starting health", () => {
  const base = CASTLE.STARTING_HP;
  for (const [seats, extra] of [[3, 1], [4, 2], [7, 5]] as const) {
    const expected = Math.round(base * (1 + PLAYER_SCALING.HP_PER_EXTRA_PLAYER * extra));
    assert.equal(
      castleWith(seats).maxHp,
      expected,
      `${seats} seats should scale health by ${extra} steps`,
    );
  }
});

test("health scales strictly upward with the table", () => {
  // The property, not the arithmetic: adding a kingdom must never shrink a
  // castle, whatever the rate is later tuned to.
  let previous = 0;
  for (const seats of [2, 3, 4, 5, 6, 7]) {
    const hp = castleWith(seats).maxHp;
    assert.ok(hp >= previous, `${seats} seats gave ${hp}, fewer seats gave ${previous}`);
    previous = hp;
  }
});

test("a starting shield scales too, at half the health rate", () => {
  // Earth opens the match already shielded, which is the only way to observe
  // starting-shield scaling without buying one.
  const duel = castleWith(2, "earth" as KingdomId).shield;
  assert.ok(duel > 0, "Earth should start shielded");

  const seven = castleWith(7, "earth" as KingdomId).shield;
  const expected = Math.round(duel * (1 + PLAYER_SCALING.SHIELD_PER_EXTRA_PLAYER * 5));
  assert.equal(seven, expected);

  // Deliberately gentler than health: a shield is a burst that arrives once,
  // and scaling it as hard would make big games swingier rather than longer.
  assert.ok(
    PLAYER_SCALING.SHIELD_PER_EXTRA_PLAYER < PLAYER_SCALING.HP_PER_EXTRA_PLAYER,
    "shield scaling must stay below health scaling",
  );
});
