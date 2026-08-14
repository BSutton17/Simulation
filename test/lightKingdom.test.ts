import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match/Match.js";
import { createMatchConfig } from "../src/match/matchConfig.js";
import { activateAbility, resolvePendingStrikes } from "../src/engine/abilities.js";
import { setCooldown, getCooldown } from "../src/engine/cooldowns.js";
import {
  unlockOrUpgradeAbility,
  buyShield,
  dispelStatus,
  dispellableStatus,
} from "../src/engine/purchases.js";
import { earn } from "../src/engine/money.js";
import {
  LIGHT_BEAM,
  FIREFLIES,
  ILLUMINATION,
  FLASH_BANG,
  LIGHT_SHOW,
  LIGHT_SHOW_DELAY,
} from "../src/data/lightAbilities.js";
import { HEAT_WAVE_STATUS } from "../src/data/fireAbilities.js";
import { COMBAT, TICK } from "../src/data/balance.js";
import { computeStat } from "../src/engine/modifiers.js";
import { applyStatus } from "../src/engine/status.js";
import type { PlayerState } from "../src/match/playerState.js";
import type { MatchPlayer } from "../src/match/types.js";

// Light's attack kit: plant the swarm, then farm it. Fireflies is an economic
// hostage-taking — the victim pays by the head to be rid of it, a shield turns
// it away, and Light gives up its own shield for as long as the swarm is out.

const matchPlayer = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId: kingdomId as MatchPlayer["kingdomId"],
  perks: [],
  ready: true,
  connected: true,
});

/** A Light player `a` against a plain `b`, with Light's kit already bought. */
function lightMatch(): { match: Match; a: PlayerState; b: PlayerState } {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("a", "light"));
  match.addPlayer(matchPlayer("b", "water"));
  match.hostId = "a";
  match.start(createMatchConfig(match));
  const a = match.gameState!.getPlayer("a")!;
  const b = match.gameState!.getPlayer("b")!;
  earn(a, 1_000_000);
  for (const id of [LIGHT_BEAM.id, FIREFLIES.id, ILLUMINATION.id]) {
    assert.equal(unlockOrUpgradeAbility(match, a, id).ok, true);
  }
  a.target = b.id;
  return { match, a, b };
}

const cast = (
  match: Match,
  a: PlayerState,
  ability: typeof LIGHT_BEAM,
): ReturnType<typeof activateAbility> =>
  activateAbility(match, a, ability, { forceCrit: false, rng: () => 0.5 });

// --- Fireflies: the swarm and its ransom -----------------------------------

test("Fireflies plants a swarm priced at 10 gold per victim citizen", () => {
  const { match, a, b } = lightMatch();
  b.economy.citizens = 17;

  assert.equal(cast(match, a, FIREFLIES).ok, true);
  const swarm = b.statuses.find((s) => s.id === "fireflies");
  assert.ok(swarm, "no swarm was planted");
  assert.equal(swarm!.dispelCost, 170);
  assert.equal(swarm!.sourceId, a.id);
  assert.deepEqual(dispellableStatus(b), { statusId: "fireflies", cost: 170 });
});

test("the ransom is fixed when it lands — later hiring doesn't raise it", () => {
  const { match, a, b } = lightMatch();
  b.economy.citizens = 10;
  assert.equal(cast(match, a, FIREFLIES).ok, true);
  assert.equal(dispellableStatus(b)!.cost, 100);

  b.economy.citizens = 40; // boom times, but the debt is already struck
  assert.equal(dispellableStatus(b)!.cost, 100);
});

test("a shielded castle repels the swarm but still takes the damage", () => {
  const { match, a, b } = lightMatch();
  b.castle.shield = 5_000;
  const shieldBefore = b.castle.shield;

  assert.equal(cast(match, a, FIREFLIES).ok, true);
  assert.equal(b.statuses.some((s) => s.id === "fireflies"), false);
  assert.ok(b.castle.shield < shieldBefore, "the attack dealt no damage");
  assert.equal(dispellableStatus(b), null);
});

test("the victim can pay the ransom to be rid of the swarm", () => {
  const { match, a, b } = lightMatch();
  b.economy.citizens = 12;
  assert.equal(cast(match, a, FIREFLIES).ok, true);
  earn(b, 1_000);
  const before = b.economy.currency;

  const result = dispelStatus(match, b);
  assert.equal(result.ok, true);
  assert.equal(result.statusId, "fireflies");
  assert.equal(before - b.economy.currency, 120);
  assert.equal(b.statuses.some((s) => s.id === "fireflies"), false);
});

test("a victim who cannot afford the ransom keeps the swarm", () => {
  const { match, a, b } = lightMatch();
  b.economy.citizens = 30; // a 300g debt
  assert.equal(cast(match, a, FIREFLIES).ok, true);
  b.economy.currency = 50;

  const result = dispelStatus(match, b);
  assert.equal(result.ok, false);
  assert.equal(result.error, "INSUFFICIENT_FUNDS");
  assert.ok(b.statuses.some((s) => s.id === "fireflies"));
});

test("dispelling is rejected when nothing is stuck to you", () => {
  const { match, b } = lightMatch();
  earn(b, 1_000);
  const result = dispelStatus(match, b);
  assert.equal(result.ok, false);
  assert.equal(result.error, "NOTHING_TO_DISPEL");
});

// --- Fireflies: Light's own cost -------------------------------------------

test("the swarmed victim cannot buy a shield until they pay it off", () => {
  const { match, a, b } = lightMatch();
  earn(b, 100_000);
  // Before the swarm lands, a shield is perfectly buyable.
  assert.equal(buyShield(match, b).ok, true);
  b.castle.shield = 0; // clear it so the next purchase isn't SHIELD_ACTIVE
  b.castle.shieldBrokenAtTick = -100000;

  assert.equal(cast(match, a, FIREFLIES).ok, true);
  const blocked = buyShield(match, b);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "SHIELD_BLOCKED");

  // Paying the ransom is the only way out — then the walls go back up.
  assert.equal(dispelStatus(match, b).ok, true);
  assert.equal(buyShield(match, b).ok, true);
});

test("Light can buy a shield freely while its swarm is deployed", () => {
  const { match, a } = lightMatch();
  assert.equal(cast(match, a, FIREFLIES).ok, true);
  // The swarm is the VICTIM's problem; Light's own walls are unaffected.
  assert.equal(buyShield(match, a).ok, true);
});

// --- Light Beam: farming the swarm -----------------------------------------

test("Light Beam hits harder against a swarm-ridden castle", () => {
  const clean = lightMatch();
  const infested = lightMatch();

  const hpBefore = clean.b.castle.hp;
  assert.equal(cast(clean.match, clean.a, LIGHT_BEAM).ok, true);
  const plainDamage = hpBefore - clean.b.castle.hp;

  assert.equal(cast(infested.match, infested.a, FIREFLIES).ok, true);
  const infestedBefore = infested.b.castle.hp;
  assert.equal(cast(infested.match, infested.a, LIGHT_BEAM).ok, true);
  const bonusDamage = infestedBefore - infested.b.castle.hp;

  assert.ok(
    bonusDamage > plainDamage,
    `expected the swarm bonus (${bonusDamage} vs ${plainDamage})`,
  );
});

// --- Illumination: inflating the ransom ------------------------------------

test("Illumination inflates an outstanding ransom by 25%", () => {
  const { match, a, b } = lightMatch();
  b.economy.citizens = 20;
  assert.equal(cast(match, a, FIREFLIES).ok, true);
  assert.equal(dispellableStatus(b)!.cost, 200);

  assert.equal(cast(match, a, ILLUMINATION).ok, true);
  assert.equal(dispellableStatus(b)!.cost, 250);

  // It compounds — the glare keeps driving the price up. (Skipping past the
  // cooldown; the point here is the arithmetic, not the pacing.)
  a.cooldowns = {};
  assert.equal(cast(match, a, ILLUMINATION).ok, true);
  assert.equal(dispellableStatus(b)!.cost, 313); // round(250 × 1.25)
});

test("Illumination never plants the swarm itself", () => {
  const { match, a, b } = lightMatch();
  const hpBefore = b.castle.hp;

  assert.equal(cast(match, a, ILLUMINATION).ok, true);
  assert.equal(b.statuses.some((s) => s.id === "fireflies"), false);
  assert.equal(dispellableStatus(b), null);
  assert.ok(b.castle.hp < hpBefore, "Illumination dealt no damage");
});

test("Illumination hits for 500, and considerably harder through a swarm", () => {
  // Clean target: the plain hit.
  const plain = lightMatch();
  const cleanBefore = plain.b.castle.hp;
  assert.equal(cast(plain.match, plain.a, ILLUMINATION).ok, true);
  const plainDamage = cleanBefore - plain.b.castle.hp;
  assert.equal(plainDamage, 500);

  // Swarmed target: the glare has something to catch on.
  const lit = lightMatch();
  lit.b.economy.citizens = 20;
  assert.equal(cast(lit.match, lit.a, FIREFLIES).ok, true);
  assert.ok(lit.b.statuses.some((s) => s.id === "fireflies"), "no swarm landed");
  const litBefore = lit.b.castle.hp;
  lit.a.cooldowns = {};
  assert.equal(cast(lit.match, lit.a, ILLUMINATION).ok, true);
  const litDamage = litBefore - lit.b.castle.hp;

  assert.ok(litDamage > plainDamage, "a swarmed castle took no extra damage");
  assert.equal(litDamage, 850); // 500 + the 350 infested bonus
});

test("Illumination cast BEFORE Fireflies does not inflate the later ransom", () => {
  const { match, a, b } = lightMatch();
  b.economy.citizens = 20;

  // Out of order: the glare hits an empty castle and is wasted.
  assert.equal(cast(match, a, ILLUMINATION).ok, true);
  assert.equal(cast(match, a, FIREFLIES).ok, true);

  // The swarm lands at its plain price — the earlier Illumination bought
  // nothing. Only a cast made while the swarm is already there raises it.
  assert.equal(dispellableStatus(b)!.cost, 200);
});

// --- Flash Bang: stretching what is already running ------------------------

test("Flash Bang stretches ACTIVE cooldowns on every OPPOSING kingdom", () => {
  const { match, a, b } = lightMatch();
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, FLASH_BANG.id).ok, true);

  setCooldown(a, LIGHT_BEAM.id, 100);
  setCooldown(b, "waterBall", 200);
  // An ability sitting ready has no cooldown entry, so it can't be stretched.
  assert.equal(getCooldown(b, "waterfall"), 0);

  assert.equal(cast(match, a, FLASH_BANG).ok, true);

  // Light is SPARED its own flash — it is the one kingdom that knows to look
  // away. Its cooldown still moves, but only because "Speed of light" fires
  // when the cast is paid for (100 → 70); the flash itself never touches it.
  assert.equal(getCooldown(a, LIGHT_BEAM.id), 70);
  // Everyone else takes it raw.
  assert.equal(getCooldown(b, "waterBall"), 240);
  assert.equal(getCooldown(b, "waterfall"), 0); // still ready, still untouched
});

test("Flash Bang does nothing to a field with everything off cooldown", () => {
  const { match, a, b } = lightMatch();
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, FLASH_BANG.id).ok, true);
  b.cooldowns = {};

  assert.equal(cast(match, a, FLASH_BANG).ok, true);
  assert.deepEqual(b.cooldowns, {});
});

// --- Light Show: the telegraphed field-wide strike --------------------------

test("Light Show lands only after its public 3 second warning", () => {
  const { match, a, b } = lightMatch();
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, LIGHT_SHOW.id).ok, true);

  const hpBefore = b.castle.hp;
  assert.equal(cast(match, a, LIGHT_SHOW).ok, true);
  // Nothing has happened yet — this window is the victims' chance to react.
  assert.equal(b.castle.hp, hpBefore);
  assert.equal(match.gameState!.pendingStrikes.length, 1);

  // One tick short of the delay: still nothing.
  match.tick += LIGHT_SHOW_DELAY - 1;
  resolvePendingStrikes(match);
  assert.equal(b.castle.hp, hpBefore);

  match.tick += 1;
  resolvePendingStrikes(match);
  assert.ok(b.castle.hp < hpBefore, "the strike never landed");
  assert.equal(match.gameState!.pendingStrikes.length, 0);
});

test("Light Show breaks a shield outright and deals no carry-over damage", () => {
  const { match, a, b } = lightMatch();
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, LIGHT_SHOW.id).ok, true);
  b.castle.shield = 1; // a sliver of a shield still buys total immunity
  const hpBefore = b.castle.hp;

  assert.equal(cast(match, a, LIGHT_SHOW).ok, true);
  match.tick += LIGHT_SHOW_DELAY;
  resolvePendingStrikes(match);

  assert.equal(b.castle.shield, 0, "the shield survived");
  assert.equal(b.castle.hp, hpBefore, "damage carried past the shield");
});

test("Light Show never hits the kingdom that called it down", () => {
  const { match, a } = lightMatch();
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, LIGHT_SHOW.id).ok, true);
  const hpBefore = a.castle.hp;

  assert.equal(cast(match, a, LIGHT_SHOW).ok, true);
  match.tick += LIGHT_SHOW_DELAY;
  resolvePendingStrikes(match);
  assert.equal(a.castle.hp, hpBefore);
});

test("a strike lands exactly once", () => {
  const { match, a, b } = lightMatch();
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, LIGHT_SHOW.id).ok, true);

  assert.equal(cast(match, a, LIGHT_SHOW).ok, true);
  match.tick += LIGHT_SHOW_DELAY;
  resolvePendingStrikes(match);
  const afterFirst = b.castle.hp;
  resolvePendingStrikes(match);
  assert.equal(b.castle.hp, afterFirst);
});

// --- Fire: Heat Wave's retuned crit chance ---------------------------------

test("Heat Wave takes the caster's crit chance to 15%", () => {
  const match = new Match("1234");
  match.addPlayer(matchPlayer("f", "fire"));
  match.addPlayer(matchPlayer("w", "water"));
  match.hostId = "f";
  match.start(createMatchConfig(match));
  const fire = match.gameState!.getPlayer("f")!;

  applyStatus(fire, HEAT_WAVE_STATUS, { sourceId: fire.id, durationTicks: 100 });
  const chance = computeStat(fire, "critChance", COMBAT.BASE_CRIT_CHANCE);
  assert.ok(
    Math.abs(chance - 0.15) < 1e-9,
    `expected 15% crit chance, got ${chance}`,
  );
});

test("a shield repelling the swarm is ANNOUNCED, not silent", () => {
  // Without this the caster sees Fireflies apparently do nothing and the
  // defender never learns their shield is what saved them.
  const { match, a, b } = lightMatch();
  b.economy.citizens = 20;
  b.castle.shield = 1_000;

  // The bus delivers ONE event per call and swallows listener errors, so a
  // listener written as if it took a batch fails silently and the test passes
  // for the wrong reason.
  const seen: { type: string; playerId?: string; statusId?: string }[] = [];
  const off = match.gameState!.events.on((e) => {
    seen.push(e as never);
  });

  assert.equal(cast(match, a, FIREFLIES).ok, true);
  off();

  // The swarm still never lands...
  assert.equal(b.statuses.some((s) => s.id === "fireflies"), false);
  assert.equal(dispellableStatus(b), null);
  // ...but it says so.
  const repelled = seen.find((e) => e.type === "statusRepelled");
  assert.ok(repelled, "the repel was silent");
  assert.equal(repelled!.playerId, b.id);
  assert.equal(repelled!.statusId, "fireflies");
});

test("nothing is announced when the swarm actually lands", () => {
  const { match, a, b } = lightMatch();
  b.economy.citizens = 20;

  const seen: string[] = [];
  const off = match.gameState!.events.on((e) => {
    seen.push(e.type);
  });
  assert.equal(cast(match, a, FIREFLIES).ok, true);
  off();

  assert.ok(b.statuses.some((s) => s.id === "fireflies"), "the swarm didn't land");
  assert.equal(seen.includes("statusRepelled"), false);
});

test("Light Show grants a quarter second of grace past the visible countdown", () => {
  // The countdown players see is 3 seconds; the strike lands at 3.25. That gap
  // is what lets a shield bought on zero actually save you, so it is pinned.
  assert.equal(LIGHT_SHOW_DELAY, Math.round(3.25 * TICK.RATE));
  assert.ok(LIGHT_SHOW_DELAY > 3 * TICK.RATE, "no grace past the countdown");

  const { match, a, b } = lightMatch();
  assert.equal(unlockOrUpgradeAbility(match, a, LIGHT_SHOW.id).ok, true);
  assert.equal(cast(match, a, LIGHT_SHOW).ok, true);

  // Three seconds in — the counter has hit zero and nothing has landed yet.
  match.tick += 3 * TICK.RATE;
  resolvePendingStrikes(match);
  assert.equal(b.castle.hp, b.castle.maxHp, "the strike beat its own countdown");

  // A shield raised inside the grace window still counts.
  b.castle.shield = 1_000;
  match.tick += LIGHT_SHOW_DELAY - 3 * TICK.RATE;
  resolvePendingStrikes(match);
  assert.equal(b.castle.shield, 0, "the late shield wasn't consumed");
  assert.equal(b.castle.hp, b.castle.maxHp, "the late shield didn't protect them");
});

test("Flash Bang never stretches Light's own cooldowns, passive aside", () => {
  // Pinned separately from the composition test above, because the two Light
  // effects landing in cast order makes "the caster was spared" easy to read
  // wrongly. Here Light has no other ability on cooldown to be reduced, so any
  // movement at all would be the flash hitting its own caster.
  const { match, a, b } = lightMatch();
  earn(a, 100_000);
  assert.equal(unlockOrUpgradeAbility(match, a, FLASH_BANG.id).ok, true);
  setCooldown(b, "waterBall", 200);

  assert.equal(cast(match, a, FLASH_BANG).ok, true);
  // Light Beam was never on cooldown, so there is nothing to stretch OR reduce.
  assert.equal(getCooldown(a, LIGHT_BEAM.id), 0);
  // The opposition still takes it in full.
  assert.equal(getCooldown(b, "waterBall"), 240);
});
