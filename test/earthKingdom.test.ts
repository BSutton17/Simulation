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
import { getStatus } from "../src/engine/status.js";
import {
  ROCK_THROW,
  METEOR_SHOWER,
  EARTHQUAKE,
  NATURAL_TERRAIN,
  BRICK_WALL,
} from "../src/data/earthAbilities.js";
import { KINGDOM_PASSIVES } from "../src/data/kingdoms.js";
import {
  baseDamage,
  declaredAmount,
  declaredCooldown,
  declaredDamage,
} from "./support/derive.js";

/**
 * Earth's passives, read from the data rather than restated here.
 *
 * ⚠️ The shield size and the Distraught rate are BALANCE, and every assertion
 * below is about the mechanic they drive — that dealing damage regenerates
 * shield at all, that Meteor Shower lands five times rather than once. Pinning
 * "2000" and "10% of 250" made those tests fail the moment the balance search
 * moved Rock Throw from 250 to 392, which told us nothing about Earth.
 */
const EARTH_START_SHIELD = (() => {
  const p = KINGDOM_PASSIVES.earth.find((x) => x.type === "startingShield");
  assert.ok(p && "amount" in p, "Earth should start with a shield");
  return p.amount;
})();
const DISTRAUGHT_PCT = (() => {
  const p = KINGDOM_PASSIVES.earth.find((x) => x.type === "shieldOnDamageDealt");
  assert.ok(p && "pct" in p, "Earth should regenerate shield on damage dealt");
  return p.pct;
})();

/** Total damage a multi-hit ability lists across all of its damage effects. */
const totalDamage = (a: typeof METEOR_SHOWER): number =>
  a.effects.filter((e) => e.type === "damage").reduce((n, e) => n + (e.params.amount as number), 0);

const player = (id: string, kingdomId: string): MatchPlayer => ({
  id,
  socketId: `s-${id}`,
  name: id,
  kingdomId,
  ready: true,
  connected: true,
});

/** Starts a match with one player per kingdom id given, in order (p0, p1, …). */
function bedrock(kingdoms: string[]): { match: Match; players: PlayerState[] } {
  const match = new Match("1234");
  kingdoms.forEach((k, i) => match.addPlayer(player(`p${i}`, k)));
  match.hostId = "p0";
  match.start(createMatchConfig(match));
  const gs = match.gameState!;
  const players = kingdoms.map((_, i) => gs.getPlayer(`p${i}`)!);
  for (const p of players) earn(p, 100_000);
  return { match, players };
}

/** A plain 1000-damage attack for driving incoming-damage scenarios. */
const strike: AbilityDefinition = {
  id: "strike",
  kind: "attack",
  cost: 0,
  cooldownTicks: 0,
  targeting: { mode: "singleEnemy" },
  effects: [{ type: "damage", target: "target", params: { amount: 1000 } }],
};

// --- Passives -----------------------------------------------------------------------

test("Rock Hard Determination: Earth begins the game with a fully intact shield", () => {
  const { players } = bedrock(["earth", "plains"]);
  const [a, b] = players;
  assert.equal(a.castle.shield, EARTH_START_SHIELD);
  assert.equal(b.castle.shield, 0); // everyone else starts bare
});

test("Distraught: dealing damage regenerates Earth's shield", () => {
  const { match, players } = bedrock(["earth", "plains"]);
  const [a, b] = players;

  activateAbility(match, a, ROCK_THROW, { targetId: "p1", forceCrit: false });
  const dealt = b.castle.maxHp - b.castle.hp;
  assert.equal(dealt, baseDamage(ROCK_THROW));
  // The mechanic: a tenth of what was dealt comes back as shield.
  assert.equal(a.castle.shield, EARTH_START_SHIELD + Math.round(dealt * DISTRAUGHT_PCT));
});

test("Distraught only repairs an ACTIVE shield — it never conjures one", () => {
  const { match, players } = bedrock(["earth", "plains"]);
  const [a, b] = players;

  // Shield fully broken: dealing damage must NOT hand Earth a fresh shield.
  a.castle.shield = 0;
  activateAbility(match, a, ROCK_THROW, { targetId: "p1", forceCrit: false });
  assert.equal(b.castle.hp, b.castle.maxHp - baseDamage(ROCK_THROW)); // the hit still lands
  assert.equal(a.castle.shield, 0); // …but no shield is generated from nothing

  // With even a sliver of shield standing, it tops back up as normal.
  a.cooldowns = {};
  a.castle.shield = 10;
  activateAbility(match, a, ROCK_THROW, { targetId: "p1", forceCrit: false });
  assert.equal(a.castle.shield, 10 + Math.round(baseDamage(ROCK_THROW) * DISTRAUGHT_PCT));
});

// --- Meteor Shower ------------------------------------------------------------------

test("Meteor Shower is 5 hits of 100, not one 500 lump", () => {
  const { match, players } = bedrock(["earth", "plains"]);
  const [a, b] = players;

  const r = activateAbility(match, a, METEOR_SHOWER, { targetId: "p1", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(r.damage!.length, 5); // five separate applications
  assert.equal(b.castle.hp, b.castle.maxHp - totalDamage(METEOR_SHOWER));
  // Distraught pays out PER HIT, so five smaller credits — not one on the total.
  const perHit = baseDamage(METEOR_SHOWER);
  assert.equal(a.castle.shield, EARTH_START_SHIELD + 5 * Math.round(perHit * DISTRAUGHT_PCT));
});

test("Meteor Shower deals bonus damage to shields (x1.5 per hit)", () => {
  const { match, players } = bedrock(["earth", "plains"]);
  const [a, b] = players;

  b.castle.shield = 2000;
  const mult = METEOR_SHOWER.effects[0].params.shieldDamageMultiplier as number;
  activateAbility(match, a, METEOR_SHOWER, { targetId: "p1", forceCrit: false });
  // Each of the five hits is amplified against shields before it lands.
  assert.equal(b.castle.shield, 2000 - 5 * Math.round(baseDamage(METEOR_SHOWER) * mult));
  assert.equal(b.castle.hp, b.castle.maxHp); // fully absorbed
});

test("Meteor Shower Lv5: excess shield damage carries over into Castle HP", () => {
  // Lv3 (no overflow): the shield bonus caps at the shield; remainder at x1.
  const capped = bedrock(["earth", "plains"]);
  capped.players[0].upgrades["meteorShower"] = 2; // 130/hit, x2.0 shields
  capped.players[1].castle.shield = 100;
  activateAbility(capped.match, capped.players[0], METEOR_SHOWER, { targetId: "p1", forceCrit: false });
  assert.equal(capped.players[1].castle.shield, 0);
  const cappedHp = capped.players[1].castle.maxHp - capped.players[1].castle.hp;

  // Lv5 (overflow): the full x2 damage lands; the shield absorbs its part.
  const overflow = bedrock(["earth", "plains"]);
  overflow.players[0].upgrades["meteorShower"] = 4;
  overflow.players[1].castle.shield = 100;
  activateAbility(overflow.match, overflow.players[0], METEOR_SHOWER, { targetId: "p1", forceCrit: false });
  assert.equal(overflow.players[1].castle.shield, 0);
  const overflowHp = overflow.players[1].castle.maxHp - overflow.players[1].castle.hp;

  // ⚠️ THE CLAIM IS THE CARRY-OVER, not a damage total. Without overflow the
  // shield-bonus damage in excess of the shield is LOST at the shield; with it,
  // that excess continues into HP. So the same five hits must take strictly
  // more HP once overflow is on. Asserting the totals instead pinned this test
  // to Meteor Shower's per-hit figure, which balance owns and has moved twice.
  assert.ok(
    overflowHp > cappedHp,
    `overflow should carry excess into HP: capped ${cappedHp}, overflow ${overflowHp}`,
  );
});

// --- Earthquake ---------------------------------------------------------------------

test("Earthquake damages the target and deals aftershock damage to every other kingdom", () => {
  const { match, players } = bedrock(["earth", "plains", "water", "plains"]);
  const [a, b, c, d] = players;

  const r = activateAbility(match, a, EARTHQUAKE, { targetId: "p1", forceCrit: false });
  assert.equal(r.ok, true);
  const main = EARTHQUAKE.effects[0].params.amount as number;
  const after = EARTHQUAKE.effects[1].params.amount as number;
  assert.equal(b.castle.hp, b.castle.maxHp - main); // main hit
  assert.equal(c.castle.hp, c.castle.maxHp - after); // aftershock
  assert.equal(d.castle.hp, d.castle.maxHp - after); // aftershock
  // Distraught credits EVERY hit separately — the main one and both aftershocks.
  assert.equal(
    a.castle.shield,
    EARTH_START_SHIELD +
      Math.round(main * DISTRAUGHT_PCT) +
      2 * Math.round(after * DISTRAUGHT_PCT),
  );
});

test("Earthquake upgrades raise main and aftershock damage", () => {
  const { match, players } = bedrock(["earth", "plains", "water"]);
  const [a, b, c] = players;
  a.upgrades["earthquake"] = 2; // Lv2 damage + Lv3 aftershock

  const upgraded = resolveAbility(EARTHQUAKE, 2);
  activateAbility(match, a, EARTHQUAKE, { targetId: "p1", forceCrit: false });
  assert.equal(b.castle.hp, b.castle.maxHp - (upgraded.effects[0].params.amount as number));
  assert.equal(c.castle.hp, c.castle.maxHp - (upgraded.effects[1].params.amount as number));
  // …and the tier really did raise them, or the assertions above are vacuous.
  assert.ok(
    (upgraded.effects[0].params.amount as number) >
      (EARTHQUAKE.effects[0].params.amount as number),
  );
});

// --- Natural Terrain ----------------------------------------------------------------

test("Natural Terrain halves all incoming damage for its duration", () => {
  const { match, players } = bedrock(["earth", "plains"]);
  const [a, b] = players;
  a.castle.shield = 0; // isolate the HP math

  activateAbility(match, a, NATURAL_TERRAIN);
  const terrain = getStatus(a, "naturalTerrain");
  assert.ok(terrain);
  assert.equal(terrain.remainingTicks, NATURAL_TERRAIN.effects[0].params.durationTicks);

  // The same strike with no Terrain up, as the reference. Measuring it keeps
  // this about the REDUCTION rather than Earth's other damage modifiers.
  const ref = bedrock(["earth", "plains"]);
  ref.players[0].castle.shield = 0;
  activateAbility(ref.match, ref.players[1], strike, { targetId: "p0", forceCrit: false });
  const unmitigated = ref.players[0].castle.maxHp - ref.players[0].castle.hp;

  const reduction = NATURAL_TERRAIN.effects[0].params.status?.modifiers?.[0]
    .value as number;
  activateAbility(match, b, strike, { targetId: "p0", forceCrit: false });
  assert.equal(a.castle.hp, a.castle.maxHp - Math.round(unmitigated * reduction));
  assert.ok(reduction < 1, "Natural Terrain must actually reduce damage");
});

test("Natural Terrain Lv2 increases the damage reduction", () => {
  const { match, players } = bedrock(["earth", "plains"]);
  const [a, b] = players;
  a.castle.shield = 0;
  a.upgrades["naturalTerrain"] = 1;

  activateAbility(match, a, NATURAL_TERRAIN);
  const lv2 = resolveAbility(NATURAL_TERRAIN, 1);
  const lv2Reduction = lv2.effects[0].params.status?.modifiers?.[0].value as number;
  activateAbility(match, b, strike, { targetId: "p0", forceCrit: false });
  assert.equal(a.castle.maxHp - a.castle.hp, Math.round(1000 * lv2Reduction));
  // ⚠️ THIS IS A REAL DEFECT IN THE BALANCE DATA, not a stale expectation.
  // `value` is the multiplier applied to incoming damage, so SMALLER is
  // stronger. The base tier is 0.25 and the Lv2 tier is 0.4, which means
  // buying the upgrade makes Earth take MORE damage — an upgrade that
  // downgrades. The balance search lowered the base past the tier it was
  // meant to improve on, and nothing re-derived the tier to match.
  //
  // Left asserted deliberately: this is the invariant the ability is sold on,
  // and silencing it would hide a live gameplay bug.
  const baseReduction = NATURAL_TERRAIN.effects[0].params.status?.modifiers?.[0]
    .value as number;
  assert.ok(
    lv2Reduction < baseReduction,
    `Lv2 must reduce MORE than the base tier, but takes ${lv2Reduction} of ` +
      `incoming damage against the base ${baseReduction} — the upgrade is a ` +
      `downgrade. Fix the balance data, not this test.`,
  );
});

// --- Brick Wall ---------------------------------------------------------------------

test("Brick Wall grants a 4,000 HP shield on top of the current one", () => {
  const { match, players } = bedrock(["earth", "plains"]);
  const a = players[0];

  const r = activateAbility(match, a, BRICK_WALL);
  assert.equal(r.ok, true);
  assert.equal(
    a.castle.shield,
    EARTH_START_SHIELD + (BRICK_WALL.effects[0].params.amount as number),
  );
});

// --- Earth Ability Upgrades -----------------------------------------------------------

test("Earth upgrade tiers resolve their overrides", () => {
  // Rock Throw: standard damage/cooldown path.
  const rt = resolveAbility(ROCK_THROW, 3);
  assert.equal(rt.effects[0].params.amount, declaredDamage(ROCK_THROW, 3));
  assert.equal(rt.cooldownTicks, declaredCooldown(ROCK_THROW, 3));

  // Meteor Shower: Lv2 damage, Lv3 shield mult, Lv4 cooldown, Lv5 overflow —
  // applied to every one of the 5 hits.
  const ms = resolveAbility(METEOR_SHOWER, 4);
  assert.equal(ms.effects.length, 5);
  // The bug this guards is a tier rewriting only the FIRST hit: every one of
  // the five must carry the same upgraded figure and the same shield rules.
  const upgradedHit = ms.effects[0].params.amount as number;
  for (const hit of ms.effects) {
    assert.equal(hit.params.amount, upgradedHit);
    assert.equal(hit.params.shieldDamageMultiplier, 2.0);
    assert.equal(hit.params.shieldDamageOverflow, true);
  }
  assert.notEqual(upgradedHit, baseDamage(METEOR_SHOWER)); // the override applied
  assert.equal(ms.cooldownTicks, declaredCooldown(METEOR_SHOWER, 4));

  // Earthquake: Lv4 cooldown, Lv5 aftershock damage.
  const eq = resolveAbility(EARTHQUAKE, 4);
  assert.ok(
    (eq.effects[0].params.amount as number) >
      (EARTHQUAKE.effects[0].params.amount as number),
  );
  assert.ok(
    (eq.effects[1].params.amount as number) >
      (EARTHQUAKE.effects[1].params.amount as number),
  );
  assert.equal(eq.cooldownTicks, declaredCooldown(EARTHQUAKE, 4));

  // Natural Terrain: Lv2 reduction, Lv3 cooldown.
  const nt = resolveAbility(NATURAL_TERRAIN, 2);
  // The tier's damage-multiplier value is asserted by the dedicated Lv2 test
  // above; only the cooldown override is this test's business.
  assert.equal(nt.cooldownTicks, declaredCooldown(NATURAL_TERRAIN, 2));

  // Brick Wall: Lv2 shield HP, Lv3 cooldown.
  const bw = resolveAbility(BRICK_WALL, 2);
  assert.equal(bw.effects[0].params.amount, declaredAmount(BRICK_WALL, 2));
  assert.equal(bw.cooldownTicks, declaredCooldown(BRICK_WALL, 2));
});
