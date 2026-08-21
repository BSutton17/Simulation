import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import type { MatchPlayer } from "../src/match/types.js";
import type { PlayerState } from "../src/match/playerState.js";
import {
  activateAbility,
  resolveAbility,
  type AbilityDefinition,
} from "../src/engine/abilities.js";
import { earn } from "../src/engine/money.js";
import { TICK } from "../src/data/balance.js";
import { getStatus, processStatusTicks } from "../src/engine/status.js";
import {
  A_LIGHT_BREEZE,
  HURRICANE,
  THICK_FOG,
  BIRDS_EYE_VIEW,
  DUST_BUNNIES,
  DUST_BUNNIES_STATUS,
} from "../src/data/airAbilities.js";
import { FIREBALL } from "../src/data/fireAbilities.js";

const player = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

/** Starts a match with one player per kingdom id given, in order (p0, p1, …). */
function skies(kingdoms: string[]): { match: Match; players: PlayerState[] } {
  const match = new Match("1234");
  kingdoms.forEach((k, i) => match.addPlayer(player(`p${i}`, k)));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  const players = kingdoms.map((_, i) => gs.getPlayer(`p${i}`)!);
  for (const p of players) earn(p, 100_000);
  return { match, players };
}

/** A plain 1000-damage attack for driving deflection/redirect scenarios. */
const strike: AbilityDefinition = {
  id: "strike",
  kind: "attack",
  cost: 0,
  cooldownTicks: 0,
  targeting: { mode: "singleEnemy" },
  effects: [{ type: "damage", target: "target", params: { amount: 1000 } }],
};


// --- balance-independent expectations ------------------------------------------------
//
// ⚠️ DAMAGE FIGURES ARE DERIVED HERE, NEVER TYPED IN. Every assertion in this
// file is about a MECHANIC — damage divides across targets, a bounce does not
// divide, a mark deflects, a tier override resolves — and not one of them is
// about a particular damage number.
//
// Hardcoding the numbers coupled the whole file to balance data that the CMA-ES
// search rewrites on every apply. A Light Breeze went 250 -> 170 -> 238 across
// two balance commits and took seventeen tests down with it, none of which had
// a mechanical fault. Deriving from the definition means a balance change moves
// the expectation with the game, and a genuine mechanical break still fails.

/** The damage an ability's damage effect carries as shipped. */
function baseDamage(ability: AbilityDefinition): number {
  const effect = ability.effects.find((e) => e.type === "damage");
  assert.ok(effect, `${ability.id} has no damage effect to read`);
  return effect.params.amount as number;
}

/**
 * The damage the upgrade path DECLARES at `level`: the latest tier at or below
 * it that overrides the damage effect, or the base figure if none does.
 *
 * Asserting against this rather than a literal is what makes the upgrade tests
 * about resolution — that `resolveAbility` actually applies the override — and
 * not about which number the balance search happens to have landed on.
 */
function declaredDamage(ability: AbilityDefinition, level: number): number {
  let amount = baseDamage(ability);
  for (const tier of ability.upgradePath ?? []) {
    if (tier.level > level) break;
    const override = tier.changes.effectParams?.[0]?.amount;
    if (typeof override === "number") amount = override;
  }
  return amount;
}

/** As `declaredDamage`, for the cooldown a tier overrides. */
function declaredCooldown(ability: AbilityDefinition, level: number): number {
  let ticks = ability.cooldownTicks;
  for (const tier of ability.upgradePath ?? []) {
    if (tier.level > level) break;
    if (typeof tier.changes.cooldownTicks === "number") ticks = tier.changes.cooldownTicks;
  }
  return ticks;
}

/**
 * What each of `n` kingdoms takes when a multi-target attack spreads over them.
 *
 * The engine divides the LISTED damage before resolving, then rounds once
 * (`resolveDamage`), so the division is reproduced in that order here.
 */
function spread(ability: AbilityDefinition, n: number): number {
  return Math.round(baseDamage(ability) / n);
}

/**
 * The HP one full hit of `ability` removes, MEASURED in the given matchup.
 *
 * Needed where the elemental table applies a multiplier the listed figure does
 * not include — Fire into Plains resolves 441 as 595. Measuring in the same
 * matchup keeps the expectation correct if that table is ever retuned, which
 * reading the raw amount would not.
 */
function fullHit(matchup: string[], ability: AbilityDefinition): number {
  const { match, players } = skies(matchup);
  const before = players[1].castle.hp;
  activateAbility(match, players[0], ability, { targetIds: ["p1"], forceCrit: false });
  return before - players[1].castle.hp;
}

const BREEZE = baseDamage(A_LIGHT_BREEZE);

// --- Embrace of Winds (multi-target attacks) ---------------------------------------

test("Embrace of Winds: Air attacks may hit multiple explicit targets for one cost/cooldown", () => {
  const { match, players } = skies(["air", "plains", "water"]);
  const [a, b, c] = players;

  const before = a.economy.currency;
  const r = activateAbility(match, a, A_LIGHT_BREEZE, {
    targetIds: ["p1", "p2"],
    forceCrit: false,
  });
  assert.equal(r.ok, true);
  // Damage spreads evenly across the two kingdoms struck.
  assert.equal(b.castle.hp, b.castle.maxHp - spread(A_LIGHT_BREEZE, 2));
  assert.equal(c.castle.hp, c.castle.maxHp - spread(A_LIGHT_BREEZE, 2));
  assert.equal(a.economy.currency, before - A_LIGHT_BREEZE.cost); // paid once
  assert.equal(
    a.cooldowns["aLightBreeze"],
    A_LIGHT_BREEZE.cooldownTicks, // armed once
  );
});

test("Embrace of Winds: a single target takes full damage (spread of 1)", () => {
  const { match, players } = skies(["air", "plains"]);
  const [a, b] = players;

  activateAbility(match, a, A_LIGHT_BREEZE, { targetIds: ["p1"], forceCrit: false });
  assert.equal(b.castle.hp, b.castle.maxHp - BREEZE); // no spread with one target
});

test("Embrace of Winds: damage divides evenly and rounds across three targets", () => {
  const { match, players } = skies(["air", "plains", "water", "nature"]);
  const [a, b, c, d] = players;

  activateAbility(match, a, A_LIGHT_BREEZE, {
    targetIds: ["p1", "p2", "p3"],
    forceCrit: false,
  });
  // The listed damage divides by three and resolveDamage rounds each hit once.
  assert.equal(b.castle.hp, b.castle.maxHp - spread(A_LIGHT_BREEZE, 3));
  assert.equal(c.castle.hp, c.castle.maxHp - spread(A_LIGHT_BREEZE, 3));
  assert.equal(d.castle.hp, d.castle.maxHp - spread(A_LIGHT_BREEZE, 3));
});

test("Embrace of Winds: duplicate target ids collapse to one hit", () => {
  const { match, players } = skies(["air", "plains"]);
  const [a, b] = players;

  activateAbility(match, a, A_LIGHT_BREEZE, {
    targetIds: ["p1", "p1"],
    forceCrit: false,
  });
  assert.equal(b.castle.hp, b.castle.maxHp - BREEZE);
});

test("Embrace of Winds: an attack strikes at most maxTargets kingdoms (cap 3)", () => {
  const { match, players } = skies(["air", "plains", "water", "nature", "fire"]);
  const [, b, c, d, e] = players;

  // Five explicit ids, but the base cap is 3: only the first three resolve, and
  // the spread divides by the capped count (3), not the requested 5.
  activateAbility(match, players[0], A_LIGHT_BREEZE, {
    targetIds: ["p1", "p2", "p3", "p4"],
    forceCrit: false,
  });
  assert.equal(b.castle.hp, b.castle.maxHp - spread(A_LIGHT_BREEZE, 3)); // divided by 3, not 4
  assert.equal(c.castle.hp, c.castle.maxHp - spread(A_LIGHT_BREEZE, 3));
  assert.equal(d.castle.hp, d.castle.maxHp - spread(A_LIGHT_BREEZE, 3));
  assert.equal(e.castle.hp, e.castle.maxHp); // 4th target beyond the cap — untouched
});

test("Non-Air kingdoms cannot multi-target: only the first id is used", () => {
  const { match, players } = skies(["fire", "plains", "water"]);
  const [, b, c] = players;
  const f = players[0];

  activateAbility(match, f, FIREBALL, {
    targetIds: ["p1", "p2"],
    forceCrit: false,
  });
  assert.equal(b.castle.hp, b.castle.maxHp - fullHit(["fire", "plains"], FIREBALL));
  assert.equal(c.castle.hp, c.castle.maxHp); // untouched
});

// --- A Light Breeze bounce under Bird's Eye View -----------------------------------

/** Give Air the Bird's Eye View reveal so bounce mode engages. */
function grantBirdsEye(match: Match, a: PlayerState): void {
  const r = activateAbility(match, a, BIRDS_EYE_VIEW);
  assert.equal(r.ok, true);
  assert.equal(getStatus(a, "birdsEyeView") !== undefined, true);
}

test("Bird's Eye bounce: full damage per landing, no multi-target spread", () => {
  const { match, players } = skies(["air", "plains", "water"]);
  const [a, b, c] = players;
  grantBirdsEye(match, a);

  // rng always 0: every bounce roll (0 < 0.5) succeeds → 4 landings, and each
  // candidate pick is index 0. Two selected (b, c) → the chain alternates
  // b, c, b, c: each castle is hit twice, full 250 damage per landing.
  activateAbility(match, a, A_LIGHT_BREEZE, {
    targetIds: ["p1", "p2"],
    forceCrit: false,
    rng: () => 0,
  });
  assert.equal(b.castle.hp, b.castle.maxHp - 2 * BREEZE); // two FULL hits, not spread
  assert.equal(c.castle.hp, c.castle.maxHp - 2 * BREEZE);
});

test("Bird's Eye bounce: cost and cooldown are paid once for the whole chain", () => {
  const { match, players } = skies(["air", "plains", "water"]);
  const a = players[0];
  grantBirdsEye(match, a);

  const before = a.economy.currency;
  activateAbility(match, a, A_LIGHT_BREEZE, {
    targetIds: ["p1", "p2"],
    forceCrit: false,
    rng: () => 0,
  });
  assert.equal(before - a.economy.currency, A_LIGHT_BREEZE.cost); // one price
  assert.equal(a.cooldowns["aLightBreeze"], A_LIGHT_BREEZE.cooldownTicks);
});

test("Bird's Eye bounce: 50% roll can stop the chain early (still full damage)", () => {
  const { match, players } = skies(["air", "plains", "water"]);
  const [a, b, c] = players;
  grantBirdsEye(match, a);

  // rng always 0.99: the first bounce roll fails (0.99 ≥ 0.5), so only the
  // guaranteed initial landing lands — full damage, and NOT spread.
  activateAbility(match, a, A_LIGHT_BREEZE, {
    targetIds: ["p1", "p2"],
    forceCrit: false,
    rng: () => 0.99,
  });
  assert.equal(b.castle.hp, b.castle.maxHp - BREEZE); // full, not spread
  assert.equal(c.castle.hp, c.castle.maxHp); // chain never reached it
});

test("Bird's Eye bounce never strikes the same castle twice in a row", () => {
  const { match, players } = skies(["air", "plains", "water", "nature"]);
  const [a, b, c, d] = players;
  grantBirdsEye(match, a);

  // Three selected (b, c, d), rng 0 → 4 landings, always the first eligible
  // candidate: b, c, b, c (d is never the "first candidate" here, but the key
  // property is that no landing repeats the previous castle).
  activateAbility(match, a, A_LIGHT_BREEZE, {
    targetIds: ["p1", "p2", "p3"],
    forceCrit: false,
    rng: () => 0,
  });
  // b at landings 0 & 2, c at 1 & 3 → two full hits each; consecutive landings
  // always differ, and d is untouched by this particular roll sequence.
  assert.equal(b.castle.hp, b.castle.maxHp - 2 * BREEZE);
  assert.equal(c.castle.hp, c.castle.maxHp - 2 * BREEZE);
  assert.equal(d.castle.hp, d.castle.maxHp);
});

test("Bird's Eye + one kingdom selected does not bounce (single full hit)", () => {
  const { match, players } = skies(["air", "plains", "water"]);
  const [a, b, c] = players;
  grantBirdsEye(match, a);

  activateAbility(match, a, A_LIGHT_BREEZE, {
    targetIds: ["p1"],
    forceCrit: false,
    rng: () => 0, // would bounce if it could, but there's nowhere to go
  });
  assert.equal(b.castle.hp, b.castle.maxHp - BREEZE);
  assert.equal(c.castle.hp, c.castle.maxHp); // untouched
});

test("Without Bird's Eye, a multi-target Breeze still spreads (no bounce)", () => {
  const { match, players } = skies(["air", "plains", "water"]);
  const [a, b, c] = players;
  // No Bird's Eye status — Embrace of Winds spread behavior is unchanged.
  activateAbility(match, a, A_LIGHT_BREEZE, {
    targetIds: ["p1", "p2"],
    forceCrit: false,
    rng: () => 0,
  });
  assert.equal(b.castle.hp, b.castle.maxHp - spread(A_LIGHT_BREEZE, 2)); // still spreads
  assert.equal(c.castle.hp, c.castle.maxHp - spread(A_LIGHT_BREEZE, 2));
});

// --- A Gust of Envy (5% incoming redirect) -----------------------------------------

test("A Gust of Envy: incoming attacks can be redirected — even back to the attacker", () => {
  const { match, players } = skies(["fire", "air", "plains"]);
  const [f, a] = players;

  // rng 0.0: redirect roll succeeds (0 < 0.05); destination index 0 of
  // [f, nature] (everyone alive except the Air target) -> the attacker.
  activateAbility(match, f, FIREBALL, {
    targetId: "p1",
    forceCrit: false,
    rng: () => 0.0,
  });
  assert.equal(a.castle.hp, a.castle.maxHp); // Air untouched
  // Redirected onto the caster, so the matchup is Fire into Fire — a different
  // elemental pairing from the Fire-into-Air the cast was aimed at.
  assert.equal(f.castle.hp, f.castle.maxHp - fullHit(["fire", "fire"], FIREBALL));

  // rng 0.99: the 5% roll fails — the attack lands on Air normally.
  f.cooldowns = {};
  activateAbility(match, f, FIREBALL, {
    targetId: "p1",
    forceCrit: false,
    rng: () => 0.99,
  });
  assert.equal(a.castle.hp, a.castle.maxHp - fullHit(["fire", "air"], FIREBALL));
});

// --- Hurricane (mark + guaranteed deflection) --------------------------------------

test("Hurricane damages and marks; the mark deflects the target's next attack on Air", () => {
  const { match, players } = skies(["air", "plains", "water"]);
  const [a, b, c] = players;

  // Air casts Hurricane on b: full damage plus the until-used mark.
  const r = activateAbility(match, a, HURRICANE, { targetId: "p1", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, b.castle.maxHp - baseDamage(HURRICANE));
  assert.ok(getStatus(b, "hurricaneMark"));

  // b attacks Air: deflected to a random other kingdom (rng 0 -> b himself).
  const hpBeforeStrike = b.castle.hp;
  activateAbility(match, b, strike, {
    targetId: "p0",
    forceCrit: false,
    rng: () => 0.0,
  });
  assert.equal(a.castle.hp, a.castle.maxHp); // Air never touched
  assert.equal(b.castle.hp, hpBeforeStrike - 1000); // deflected onto himself
  assert.equal(c.castle.hp, c.castle.maxHp);
  assert.ok(!getStatus(b, "hurricaneMark")); // consumed on use
});

test("Hurricane Lv3: the deflected attack deals increased damage to the redirected target", () => {
  const { match, players } = skies(["air", "plains"]);
  const [a, b] = players;
  a.upgrades["hurricane"] = 2; // Lv3: mark carries damageMult 1.25

  activateAbility(match, a, HURRICANE, { targetId: "p1", forceCrit: false });
  assert.equal(b.castle.hp, b.castle.maxHp - declaredDamage(HURRICANE, 2)); // Lv2 damage upgrade included

  const hpBeforeStrike = b.castle.hp;
  activateAbility(match, b, strike, {
    targetId: "p0",
    forceCrit: false,
    rng: () => 0.0,
  });
  // 1000 * 1.25 (deflection amp) = 1250, onto himself (only destination).
  assert.equal(b.castle.hp, hpBeforeStrike - 1250);
  assert.equal(a.castle.hp, a.castle.maxHp);
});

test("Hurricane Lv5: a 50% roll allows one extra deflection — never a third", () => {
  const { match, players } = skies(["air", "plains"]);
  const [a, b] = players;
  a.upgrades["hurricane"] = 4; // Lv5: chainChance 0.5

  activateAbility(match, a, HURRICANE, { targetId: "p1", forceCrit: false });
  assert.ok(getStatus(b, "hurricaneMark"));

  // First deflection: chain roll succeeds (0 < 0.5) — the mark survives.
  activateAbility(match, b, strike, { targetId: "p0", forceCrit: false, rng: () => 0.0 });
  assert.equal(a.castle.hp, a.castle.maxHp);
  assert.ok(getStatus(b, "hurricaneMark"));

  // Second deflection: already chained — always consumed now.
  activateAbility(match, b, strike, { targetId: "p0", forceCrit: false, rng: () => 0.0 });
  assert.equal(a.castle.hp, a.castle.maxHp);
  assert.ok(!getStatus(b, "hurricaneMark"));
});

// --- Thick Fog (damage + screen obscure, capped) -----------------------------------

test("Thick Fog damages and fogs the target's screen", () => {
  const { match, players } = skies(["air", "plains"]);
  const [a, b] = players;

  const r = activateAbility(match, a, THICK_FOG, { targetId: "p1", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, b.castle.maxHp - baseDamage(THICK_FOG));
  const fog = getStatus(b, "vision:fog");
  assert.ok(fog);
  assert.equal(fog.remainingTicks, 100); // 5 s
});

test("Thick Fog is capped at 3 fogged players — a 4th cast is blocked, re-fogging is not", () => {
  const { match, players } = skies(["air", "plains", "plains", "plains", "plains"]);
  const a = players[0];

  for (const id of ["p1", "p2", "p3"]) {
    a.cooldowns = {};
    assert.equal(activateAbility(match, a, THICK_FOG, { targetId: id, forceCrit: false }).ok, true);
  }

  // 4th fresh target: blocked, nothing spent, no cooldown armed.
  a.cooldowns = {};
  const before = a.economy.currency;
  const blocked = activateAbility(match, a, THICK_FOG, { targetId: "p4", forceCrit: false });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "TARGET_LIMIT");
  assert.equal(a.economy.currency, before);
  assert.equal(a.cooldowns["thickFog"], undefined);

  // Re-fogging an already-fogged player stays legal at the cap.
  assert.equal(activateAbility(match, a, THICK_FOG, { targetId: "p1", forceCrit: false }).ok, true);

  // Lv5 raises the cap to 4: the blocked target is now foggable.
  a.upgrades["thickFog"] = 4;
  a.cooldowns = {};
  assert.equal(activateAbility(match, a, THICK_FOG, { targetId: "p4", forceCrit: false }).ok, true);
  assert.ok(getStatus(players[4], "vision:fog"));
});

// --- Bird's Eye View ----------------------------------------------------------------

test("Bird's Eye View applies the reveal marker to Air for its duration", () => {
  const { match, players } = skies(["air", "plains"]);
  const a = players[0];

  const r = activateAbility(match, a, BIRDS_EYE_VIEW);
  assert.equal(r.ok, true);
  const reveal = getStatus(a, "birdsEyeView");
  assert.ok(reveal);
  assert.equal(reveal.remainingTicks, 200); // 10 s

  // Lv2 extends the reveal; Lv3 shortens the cooldown.
  const lv2 = resolveAbility(BIRDS_EYE_VIEW, 1);
  assert.equal(lv2.effects[0].params.durationTicks, 300); // 15 s
  const lv3 = resolveAbility(BIRDS_EYE_VIEW, 2);
  assert.equal(lv3.cooldownTicks, 340); // 17 s
});

// --- Dust Bunnies -------------------------------------------------------------------

test("Dust Bunnies afflicts every opposing kingdom with damage over time", () => {
  const { match, players } = skies(["air", "plains", "water"]);
  const [a, b, c] = players;

  const r = activateAbility(match, a, DUST_BUNNIES);
  assert.equal(r.ok, true);
  assert.ok(getStatus(b, "dustBunnies"));
  assert.ok(getStatus(c, "dustBunnies"));
  assert.ok(!getStatus(a, "dustBunnies")); // never the caster

  b.castle.hp = 10_000;
  c.castle.hp = 10_000;
  processStatusTicks(match.gameState!);
  assert.equal(b.castle.hp, 10_000 - 10);
  assert.equal(c.castle.hp, 10_000 - 10);
});

test("Dust Bunnies totals 2100 damage to every kingdom over its full duration", () => {
  const base = resolveAbility(DUST_BUNNIES, 0);
  const durationTicks = base.effects[0]!.params.durationTicks!;
  const perTick = DUST_BUNNIES_STATUS.tickEffects![0]!.amount;
  assert.equal(perTick * durationTicks, 2100);
});

test("Dust Bunnies Lv2 increases the damage over time", () => {
  const { match, players } = skies(["air", "plains", "water"]);
  const [a, b, c] = players;
  a.upgrades["dustBunnies"] = 1;

  activateAbility(match, a, DUST_BUNNIES);
  b.castle.hp = 10_000;
  c.castle.hp = 10_000;
  processStatusTicks(match.gameState!);
  assert.equal(b.castle.hp, 10_000 - 15);
  assert.equal(c.castle.hp, 10_000 - 15);
});

// --- Air Ability Upgrades ------------------------------------------------------------

test("A Light Breeze upgrades modify damage and cooldown values", () => {
  // Each tier must resolve to what the upgrade path DECLARES for it. That is
  // the mechanism under test; the figures themselves are balance data.
  const lv1 = resolveAbility(A_LIGHT_BREEZE, 0);
  assert.equal(lv1.effects[0].params.amount, BREEZE);
  assert.equal(lv1.cooldownTicks, A_LIGHT_BREEZE.cooldownTicks);

  const lv2 = resolveAbility(A_LIGHT_BREEZE, 1);
  assert.equal(lv2.effects[0].params.amount, declaredDamage(A_LIGHT_BREEZE, 1));

  const lv3 = resolveAbility(A_LIGHT_BREEZE, 2);
  assert.equal(lv3.cooldownTicks, declaredCooldown(A_LIGHT_BREEZE, 2));

  const lv4 = resolveAbility(A_LIGHT_BREEZE, 3);
  assert.equal(lv4.effects[0].params.amount, declaredDamage(A_LIGHT_BREEZE, 3));

  // …and a tier must actually CHANGE something, or the assertions above would
  // pass against an upgrade path that silently stopped applying.
  assert.notEqual(lv2.effects[0].params.amount, lv1.effects[0].params.amount);
  assert.notEqual(lv3.cooldownTicks, lv1.cooldownTicks);
});

test("Hurricane and Thick Fog upgrades resolve their tier overrides", () => {
  // Hurricane: Lv2 damage, Lv3 deflect amp, Lv4 cooldown, Lv5 chain chance.
  const h2 = resolveAbility(HURRICANE, 1);
  assert.equal(h2.effects[0].params.amount, declaredDamage(HURRICANE, 1));
  const h3 = resolveAbility(HURRICANE, 2);
  assert.equal(h3.effects[1].params.status?.deflectsAttackOnSource?.damageMult, 1.25);
  const h4 = resolveAbility(HURRICANE, 3);
  assert.equal(h4.cooldownTicks, declaredCooldown(HURRICANE, 3));
  const h5 = resolveAbility(HURRICANE, 4);
  assert.equal(h5.effects[1].params.status?.deflectsAttackOnSource?.chainChance, 0.5);

  // Thick Fog: Lv2 damage, Lv3 fog duration, Lv4 cooldown, Lv5 cap 3 -> 4.
  const f2 = resolveAbility(THICK_FOG, 1);
  assert.equal(f2.effects[0].params.amount, declaredDamage(THICK_FOG, 1));
  const f3 = resolveAbility(THICK_FOG, 2);
  assert.equal(f3.effects[1].params.vision?.durationTicks, 160); // 8 s
  const f4 = resolveAbility(THICK_FOG, 3);
  assert.equal(f4.cooldownTicks, declaredCooldown(THICK_FOG, 3));
  const f5 = resolveAbility(THICK_FOG, 4);
  assert.equal(f5.maxConcurrentAffected?.limit, 4);
});
