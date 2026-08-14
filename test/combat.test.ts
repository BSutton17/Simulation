import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDamage } from "../src/engine/combat.js";
import { createPlayerState, type PlayerState } from "../src/match/playerState.js";
import type { MatchConfig } from "../src/match/matchConfig.js";

const config: MatchConfig = {
  roomCode: "1234",
  maxPlayers: 8,
  tickRate: 20,
  startingCitizens: 10,
  startingCastleHp: 10_000,
};

function castle(overrides: { hp?: number; shield?: number } = {}): PlayerState {
  const p = createPlayerState({ id: "a", name: "A", kingdomId: "plains" }, config);
  if (overrides.hp !== undefined) p.castle.hp = overrides.hp;
  if (overrides.shield !== undefined) p.castle.shield = overrides.shield;
  return p;
}

// --- #65: shields absorb before castle HP ------------------------------------

test("a shield fully absorbs damage smaller than its pool; HP is untouched", () => {
  const p = castle({ hp: 10_000, shield: 1000 });
  const result = applyDamage(p, 400);

  assert.equal(p.castle.shield, 600);
  assert.equal(p.castle.hp, 10_000);
  assert.equal(result.absorbedByShield, 400);
  assert.equal(result.dealtToHp, 0);
  assert.equal(result.eliminated, false);
});

test("damage exceeding the shield depletes it and overflows to HP", () => {
  const p = castle({ hp: 10_000, shield: 300 });
  const result = applyDamage(p, 500);

  assert.equal(p.castle.shield, 0);
  assert.equal(p.castle.hp, 10_000 - 200); // 500 − 300 absorbed
  assert.equal(result.absorbedByShield, 300);
  assert.equal(result.dealtToHp, 200);
});

test("damage exactly equal to the shield leaves HP untouched but depletes the shield", () => {
  const p = castle({ hp: 10_000, shield: 500 });
  const result = applyDamage(p, 500);

  assert.equal(p.castle.shield, 0);
  assert.equal(p.castle.hp, 10_000);
  assert.equal(result.dealtToHp, 0);
  assert.equal(result.eliminated, false);
});

test("ignoreShields bypasses the shield entirely", () => {
  const p = castle({ hp: 10_000, shield: 1000 });
  const result = applyDamage(p, 400, { ignoreShields: true });

  assert.equal(p.castle.shield, 1000); // untouched
  assert.equal(p.castle.hp, 10_000 - 400);
  assert.equal(result.absorbedByShield, 0);
  assert.equal(result.dealtToHp, 400);
});

// --- #66: remaining damage reduces castle HP ---------------------------------

test("with no shield, all damage reduces castle HP", () => {
  const p = castle({ hp: 10_000, shield: 0 });
  const result = applyDamage(p, 750);

  assert.equal(p.castle.hp, 9250);
  assert.equal(result.absorbedByShield, 0);
  assert.equal(result.dealtToHp, 750);
});

test("lethal damage clamps HP to 0 and eliminates the castle", () => {
  const p = castle({ hp: 500, shield: 0 });
  const result = applyDamage(p, 500);

  assert.equal(p.castle.hp, 0);
  assert.equal(p.eliminated, true);
  assert.equal(result.eliminated, true);
  assert.equal(result.dealtToHp, 500);
});

test("overkill never drives HP negative and reports only the HP actually lost", () => {
  const p = castle({ hp: 500, shield: 200 });
  const result = applyDamage(p, 5000);

  assert.equal(p.castle.hp, 0);
  assert.equal(p.eliminated, true);
  assert.equal(result.absorbedByShield, 200);
  assert.equal(result.dealtToHp, 500); // not 4800
});

test("an already-eliminated castle takes no further damage", () => {
  const p = castle({ hp: 0, shield: 0 });
  p.eliminated = true;
  const result = applyDamage(p, 1000);

  assert.equal(p.castle.hp, 0);
  assert.equal(result.dealtToHp, 0);
  assert.equal(result.eliminated, false); // not "newly" eliminated
});

// --- input hygiene -----------------------------------------------------------

test("damage is normalized to a non-negative integer", () => {
  const p = castle({ hp: 10_000, shield: 0 });
  applyDamage(p, 120.6); // rounds to 121
  assert.equal(p.castle.hp, 10_000 - 121);

  const q = castle({ hp: 10_000, shield: 500 });
  const result = applyDamage(q, -50); // clamped to 0 → no-op
  assert.equal(q.castle.hp, 10_000);
  assert.equal(q.castle.shield, 500);
  assert.equal(result.dealtToHp, 0);
});
