import { test } from "node:test";
import assert from "node:assert/strict";
import { computeIncomingDamage, resolveDamage } from "../src/engine/damage.js";
import { addModifier } from "../src/engine/modifiers.js";
import { COMBAT } from "../src/data/balance.js";
import { createPlayerState, type PlayerState } from "../src/match/playerState.js";
import type { MatchConfig } from "../src/match/matchConfig.js";

const config: MatchConfig = {
  roomCode: "1234",
  maxPlayers: 8,
  tickRate: 20,
  startingCitizens: 10,
  startingCastleHp: 10_000,
};

function fighter(id: string): PlayerState {
  return createPlayerState({ id, name: id, kingdomId: "plains" }, config);
}

/** Shorthand for a permanent modifier in tests. */
function mod(
  stat: string,
  op: "add" | "mult",
  value: number,
  id = `${stat}-${op}-${value}`,
) {
  return { id, stat, op, value, sourceId: "test", remainingTicks: null };
}

// Ticket #64 — the reusable damage engine: pre-modifier incoming-damage
// calculation with critical strikes. Pure and deterministic via injectable RNG.

test("a non-crit hit deals exactly its base amount", () => {
  const result = computeIncomingDamage({ amount: 300, forceCrit: false });
  assert.deepEqual(result, { amount: 300, baseAmount: 300, crit: false });
});

test("a forced crit multiplies by the base crit multiplier", () => {
  const result = computeIncomingDamage({ amount: 300, forceCrit: true });
  assert.equal(result.crit, true);
  assert.equal(result.baseAmount, 300);
  assert.equal(result.amount, Math.round(300 * COMBAT.BASE_CRIT_MULTIPLIER));
});

test("crit is rolled against crit chance using the injected RNG", () => {
  // RNG below the chance → crit; at/above → no crit.
  const crit = computeIncomingDamage({
    amount: 100,
    critChance: 0.25,
    rng: () => 0.24,
  });
  assert.equal(crit.crit, true);
  assert.equal(crit.amount, Math.round(100 * COMBAT.BASE_CRIT_MULTIPLIER));

  const noCrit = computeIncomingDamage({
    amount: 100,
    critChance: 0.25,
    rng: () => 0.25,
  });
  assert.equal(noCrit.crit, false);
  assert.equal(noCrit.amount, 100);
});

test("crit chance and multiplier can be overridden", () => {
  const result = computeIncomingDamage({
    amount: 200,
    critChance: 1,
    critMultiplier: 3,
    rng: () => 0.99, // would miss a normal crit, but chance is 1
  });
  assert.equal(result.crit, true);
  assert.equal(result.amount, 600);
});

test("damage is a non-negative integer: fractions round, negatives clamp to 0", () => {
  assert.equal(computeIncomingDamage({ amount: 10.6, forceCrit: false }).amount, 11);
  assert.equal(computeIncomingDamage({ amount: -50, forceCrit: true }).amount, 0);
  assert.equal(computeIncomingDamage({ amount: 0, forceCrit: true }).baseAmount, 0);
});

test("a crit multiplier below 1 never reduces damage", () => {
  const result = computeIncomingDamage({
    amount: 100,
    critMultiplier: 0.5,
    forceCrit: true,
  });
  assert.equal(result.amount, 100); // clamped to ×1
});

test("crit chance is clamped: 0 never crits, ≥1 always crits", () => {
  assert.equal(
    computeIncomingDamage({ amount: 100, critChance: 0, rng: () => 0 }).crit,
    false,
  );
  assert.equal(
    computeIncomingDamage({ amount: 100, critChance: 5, rng: () => 0.999 }).crit,
    true,
  );
});

// --- #67: universal crit system — rate and multiplier verification -----------

/** Deterministic LCG RNG so the statistical assertions can never flake. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test("crits occur at approximately the base 5% rate over many rolls", () => {
  const rng = lcg(42);
  const rolls = 20_000;
  let crits = 0;
  for (let i = 0; i < rolls; i++) {
    if (computeIncomingDamage({ amount: 100, rng }).crit) crits++;
  }
  const rate = crits / rolls;
  // 5% ± 1 percentage point over 20k deterministic rolls.
  assert.ok(
    rate > 0.04 && rate < 0.06,
    `crit rate ${(rate * 100).toFixed(2)}% not ≈ ${COMBAT.BASE_CRIT_CHANCE * 100}%`,
  );
});

test("every crit applies exactly the 1.5× multiplier; non-crits never do", () => {
  const rng = lcg(7);
  for (let i = 0; i < 5000; i++) {
    const r = computeIncomingDamage({ amount: 200, rng });
    assert.equal(r.amount, r.crit ? 300 : 200); // 200 × 1.5 = 300
  }
});

test("uses the balance defaults when chance/multiplier are omitted", () => {
  // rng just below the default chance crits; just above does not.
  const below = COMBAT.BASE_CRIT_CHANCE - 0.001;
  const above = COMBAT.BASE_CRIT_CHANCE + 0.001;
  assert.equal(computeIncomingDamage({ amount: 100, rng: () => below }).crit, true);
  assert.equal(computeIncomingDamage({ amount: 100, rng: () => above }).crit, false);
});

// --- #68: the damage modifier pipeline ----------------------------------------

test("with no modifiers the pipeline passes base damage through unchanged", () => {
  const a = fighter("a");
  const d = fighter("d");
  const r = resolveDamage(a, d, 300, { forceCrit: false });
  assert.equal(r.amount, 300);
  assert.equal(r.crit, false);
});

test("attacker damage buffs and debuffs compose as (base + adds) x mults", () => {
  const a = fighter("a");
  const d = fighter("d");
  addModifier(a, mod("damage", "add", 50));   // +50
  addModifier(a, mod("damage", "add", 25));   // +25
  addModifier(a, mod("damage", "mult", 1.2)); // x1.2
  addModifier(a, mod("damage", "mult", 0.5)); // x0.5 (a debuff)

  const r = resolveDamage(a, d, 100, { forceCrit: false });
  // (100 + 50 + 25) x 1.2 x 0.5 = 105
  assert.equal(r.afterAttackerModifiers, 105);
  assert.equal(r.amount, 105);
});

test("defender damageTaken modifiers apply after the crit stage", () => {
  const a = fighter("a");
  const d = fighter("d");
  addModifier(d, mod("damageTaken", "mult", 0.8)); // 20% resistance

  const r = resolveDamage(a, d, 200, { forceCrit: true });
  // 200 -> crit x1.5 = 300 -> x0.8 = 240
  assert.equal(r.amount, 240);
  assert.equal(r.crit, true);
});

test("elemental interaction multiplies between attacker modifiers and the crit roll", () => {
  const a = fighter("a");
  const d = fighter("d");
  addModifier(a, mod("damage", "add", 100)); // 200 base

  const strong = resolveDamage(a, d, 100, {
    elementMultiplier: 1.5,
    forceCrit: false,
  });
  assert.equal(strong.afterElement, 300); // (100+100) x 1.5
  assert.equal(strong.amount, 300);

  const weak = resolveDamage(a, d, 100, {
    elementMultiplier: 0.5,
    forceCrit: false,
  });
  assert.equal(weak.amount, 100); // (100+100) x 0.5
});

test("crit chance and multiplier are modifiable stats", () => {
  const a = fighter("a");
  const d = fighter("d");
  // Guarantee the crit via a chance buff, and boost its multiplier to 2x.
  addModifier(a, mod("critChance", "add", 1));
  addModifier(a, mod("critMultiplier", "add", 0.5)); // 1.5 + 0.5 = 2

  const r = resolveDamage(a, d, 100, { rng: () => 0.999 });
  assert.equal(r.crit, true);
  assert.equal(r.amount, 200);
});

test("all four stages stack together without conflicts", () => {
  const a = fighter("a");
  const d = fighter("d");
  addModifier(a, mod("damage", "add", 50));        // 150
  addModifier(a, mod("damage", "mult", 2));        // 300
  addModifier(d, mod("damageTaken", "mult", 1.5)); // vulnerability
  addModifier(d, mod("damageTaken", "add", 10));   // flat vulnerability

  const r = resolveDamage(a, d, 100, {
    elementMultiplier: 2, // 600
    forceCrit: true,      // x1.5 = 900
  });
  // Defender: (900 + 10) x 1.5 = 1365
  assert.equal(r.amount, 1365);
});

test("heavy resistance floors damage at zero, never negative", () => {
  const a = fighter("a");
  const d = fighter("d");
  addModifier(d, mod("damageTaken", "add", -500));
  const r = resolveDamage(a, d, 100, { forceCrit: false });
  assert.equal(r.amount, 0);
});

test("expired modifiers no longer affect the pipeline", () => {
  const a = fighter("a");
  const d = fighter("d");
  const temp = { id: "t", stat: "damage", op: "mult" as const, value: 3, sourceId: "x", remainingTicks: null };
  addModifier(a, temp);
  assert.equal(resolveDamage(a, d, 100, { forceCrit: false }).amount, 300);

  a.modifiers = a.modifiers.filter((m) => m.id !== "t"); // expiry
  assert.equal(resolveDamage(a, d, 100, { forceCrit: false }).amount, 100);
});
