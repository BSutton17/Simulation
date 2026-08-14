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
  assert.equal(a.castle.shield, 2000);
  assert.equal(b.castle.shield, 0); // everyone else starts bare
});

test("Distraught: dealing damage regenerates Earth's shield", () => {
  const { match, players } = bedrock(["earth", "plains"]);
  const [a, b] = players;

  activateAbility(match, a, ROCK_THROW, { targetId: "p1", forceCrit: false });
  assert.equal(b.castle.hp, b.castle.maxHp - 250);
  assert.equal(a.castle.shield, 2000 + 25); // 10% of 250 dealt
});

test("Distraught only repairs an ACTIVE shield — it never conjures one", () => {
  const { match, players } = bedrock(["earth", "plains"]);
  const [a, b] = players;

  // Shield fully broken: dealing damage must NOT hand Earth a fresh shield.
  a.castle.shield = 0;
  activateAbility(match, a, ROCK_THROW, { targetId: "p1", forceCrit: false });
  assert.equal(b.castle.hp, b.castle.maxHp - 250); // the hit still lands
  assert.equal(a.castle.shield, 0); // …but no shield is generated from nothing

  // With even a sliver of shield standing, it tops back up as normal.
  a.cooldowns = {};
  a.castle.shield = 10;
  activateAbility(match, a, ROCK_THROW, { targetId: "p1", forceCrit: false });
  assert.equal(a.castle.shield, 10 + 25);
});

// --- Meteor Shower ------------------------------------------------------------------

test("Meteor Shower is 5 hits of 100, not one 500 lump", () => {
  const { match, players } = bedrock(["earth", "plains"]);
  const [a, b] = players;

  const r = activateAbility(match, a, METEOR_SHOWER, { targetId: "p1", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(r.damage!.length, 5); // five separate applications
  assert.equal(b.castle.hp, b.castle.maxHp - 750);
  assert.equal(a.castle.shield, 2000 + 75); // Distraught: 10 per hit
});

test("Meteor Shower deals bonus damage to shields (x1.5 per hit)", () => {
  const { match, players } = bedrock(["earth", "plains"]);
  const [a, b] = players;

  b.castle.shield = 2000;
  activateAbility(match, a, METEOR_SHOWER, { targetId: "p1", forceCrit: false });
  assert.equal(b.castle.shield, 2000 - 1125); // 5 × (100 × 1.5)
  assert.equal(b.castle.hp, b.castle.maxHp); // fully absorbed
});

test("Meteor Shower Lv5: excess shield damage carries over into Castle HP", () => {
  // Lv3 (no overflow): the shield bonus caps at the shield; remainder at x1.
  const capped = bedrock(["earth", "plains"]);
  capped.players[0].upgrades["meteorShower"] = 2; // 130/hit, x2.0 shields
  capped.players[1].castle.shield = 100;
  activateAbility(capped.match, capped.players[0], METEOR_SHOWER, { targetId: "p1", forceCrit: false });
  // hit 1: 100 shield + (130 − 100/2) = 180 total; hits 2–5: 130 to HP.
  assert.equal(capped.players[1].castle.shield, 0);
  assert.equal(capped.players[1].castle.hp, capped.players[1].castle.maxHp - 950);

  // Lv5 (overflow): the full x2 damage lands; the shield absorbs its part.
  const overflow = bedrock(["earth", "plains"]);
  overflow.players[0].upgrades["meteorShower"] = 4;
  overflow.players[1].castle.shield = 100;
  activateAbility(overflow.match, overflow.players[0], METEOR_SHOWER, { targetId: "p1", forceCrit: false });
  // hit 1: 260 (130 × 2) — shield takes 100, HP takes 160; hits 2–5: 130 each.
  assert.equal(overflow.players[1].castle.shield, 0);
  assert.equal(overflow.players[1].castle.hp, overflow.players[1].castle.maxHp - 1100);
});

// --- Earthquake ---------------------------------------------------------------------

test("Earthquake damages the target and deals aftershock damage to every other kingdom", () => {
  const { match, players } = bedrock(["earth", "plains", "water", "plains"]);
  const [a, b, c, d] = players;

  const r = activateAbility(match, a, EARTHQUAKE, { targetId: "p1", forceCrit: false });
  assert.equal(r.ok, true);
  assert.equal(b.castle.hp, b.castle.maxHp - 750); // main hit
  assert.equal(c.castle.hp, c.castle.maxHp - 250); // aftershock
  assert.equal(d.castle.hp, d.castle.maxHp - 250); // aftershock
  assert.equal(a.castle.shield, 2000 + 80 + 20 + 25); // Distraught on every hit
});

test("Earthquake upgrades raise main and aftershock damage", () => {
  const { match, players } = bedrock(["earth", "plains", "water"]);
  const [a, b, c] = players;
  a.upgrades["earthquake"] = 2; // Lv2 damage + Lv3 aftershock

  activateAbility(match, a, EARTHQUAKE, { targetId: "p1", forceCrit: false });
  assert.equal(b.castle.hp, b.castle.maxHp - 800);
  assert.equal(c.castle.hp, c.castle.maxHp - 300);
});

// --- Natural Terrain ----------------------------------------------------------------

test("Natural Terrain halves all incoming damage for its duration", () => {
  const { match, players } = bedrock(["earth", "plains"]);
  const [a, b] = players;
  a.castle.shield = 0; // isolate the HP math

  activateAbility(match, a, NATURAL_TERRAIN);
  const terrain = getStatus(a, "naturalTerrain");
  assert.ok(terrain);
  assert.equal(terrain.remainingTicks, 200); // 10 s

  activateAbility(match, b, strike, { targetId: "p0", forceCrit: false });
  assert.equal(a.castle.hp, a.castle.maxHp - 250); // 1000 halved
});

test("Natural Terrain Lv2 increases the damage reduction", () => {
  const { match, players } = bedrock(["earth", "plains"]);
  const [a, b] = players;
  a.castle.shield = 0;
  a.upgrades["naturalTerrain"] = 1;

  activateAbility(match, a, NATURAL_TERRAIN);
  activateAbility(match, b, strike, { targetId: "p0", forceCrit: false });
  assert.equal(a.castle.hp, a.castle.maxHp - 400); // 60% reduction
});

// --- Brick Wall ---------------------------------------------------------------------

test("Brick Wall grants a 4,000 HP shield on top of the current one", () => {
  const { match, players } = bedrock(["earth", "plains"]);
  const a = players[0];

  const r = activateAbility(match, a, BRICK_WALL);
  assert.equal(r.ok, true);
  assert.equal(a.castle.shield, 2000 + 4000);
});

// --- Earth Ability Upgrades -----------------------------------------------------------

test("Earth upgrade tiers resolve their overrides", () => {
  // Rock Throw: standard damage/cooldown path.
  const rt = resolveAbility(ROCK_THROW, 3);
  assert.equal(rt.effects[0].params.amount, 300);
  assert.equal(rt.cooldownTicks, 54);

  // Meteor Shower: Lv2 damage, Lv3 shield mult, Lv4 cooldown, Lv5 overflow —
  // applied to every one of the 5 hits.
  const ms = resolveAbility(METEOR_SHOWER, 4);
  assert.equal(ms.effects.length, 5);
  for (const hit of ms.effects) {
    assert.equal(hit.params.amount, 200);
    assert.equal(hit.params.shieldDamageMultiplier, 2.0);
    assert.equal(hit.params.shieldDamageOverflow, true);
  }
  assert.equal(ms.cooldownTicks, 180); // 9 s

  // Earthquake: Lv4 cooldown, Lv5 aftershock damage.
  const eq = resolveAbility(EARTHQUAKE, 4);
  assert.equal(eq.effects[0].params.amount, 800);
  assert.equal(eq.effects[1].params.amount, 400);
  assert.equal(eq.cooldownTicks, 360); // 18 s

  // Natural Terrain: Lv2 reduction, Lv3 cooldown.
  const nt = resolveAbility(NATURAL_TERRAIN, 2);
  assert.equal(nt.effects[0].params.status?.modifiers?.[0].value, 0.4);
  assert.equal(nt.cooldownTicks, 510); // 25.5 s

  // Brick Wall: Lv2 shield HP, Lv3 cooldown.
  const bw = resolveAbility(BRICK_WALL, 2);
  assert.equal(bw.effects[0].params.amount, 5000);
  assert.equal(bw.cooldownTicks, 1530); // 76.5 s
});
