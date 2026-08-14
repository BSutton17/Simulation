import { TICK } from "./balance.js";
import type { AbilityDefinition, EffectDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Earth Kingdom ability set (Epic 9) — pure data on the shared frameworks.
 * Earth's two passives ("Rock Hard Determination" starting shield,
 * "Distraught" shield regen on damage dealt) live in KINGDOM_PASSIVES
 * (kingdoms.ts).
 *
 * NOTE: costs, cooldowns, damage numbers, and durations are initial defaults
 * (the design specifies mechanics, not magnitudes except where noted) —
 * expected to move in later balance tickets.
 */

/** Rock Throw: basic Earth attack. */
export const ROCK_THROW: AbilityDefinition = {
  id: "rockThrow",
  name: "Rock Throw",
  kind: "attack",
  cost: 100,
  cooldownTicks: 3 * TICK.RATE, // 3 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 250, element: "earth" },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 150,
      changes: {
        effectParams: [{ amount: 275 }],
      },
    },
    {
      level: 2,
      cost: 250,
      changes: {
        cooldownTicks: Math.round(3 * TICK.RATE * 0.9), // 54 ticks (2.7 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 3,
      cost: 400,
      changes: {
        effectParams: [{ amount: 300 }],
      },
    },
  ],
};

/** One Meteor Shower hit — the attack is 5 of these, not one 500 lump. */
const meteorHit = (): EffectDefinition => ({
  type: "damage",
  target: "target",
  params: { amount: 150, element: "earth", shieldDamageMultiplier: 1.5 },
});

/** Per-hit param override applied to all 5 meteors at once. */
const allMeteors = (
  params: Partial<EffectDefinition["params"]>,
): Partial<EffectDefinition["params"]>[] => Array(5).fill(params);

/** Meteor Shower: powerful multi-hit Earth attack (5 × 100) that deals bonus
 *  damage to shields. */
export const METEOR_SHOWER: AbilityDefinition = {
  id: "meteorShower",
  name: "Meteor Shower",
  kind: "attack",
  cost: 225,
  cooldownTicks: 10 * TICK.RATE, // 10 s
  targeting: { mode: "singleEnemy" },
  effects: [meteorHit(), meteorHit(), meteorHit(), meteorHit(), meteorHit()],
  upgradePath: [
    {
      level: 1,
      cost: 200,
      changes: {
        effectParams: allMeteors({ amount: 200 }), // 5 × 150 -> 5 × 200
      },
    },
    {
      level: 2,
      cost: 250,
      changes: {
        effectParams: allMeteors({ shieldDamageMultiplier: 2.0 }), // 1.5 -> 2.0
      },
    },
    {
      level: 3,
      cost: 350,
      changes: {
        cooldownTicks: Math.round(10 * TICK.RATE * 0.9), // 9 s
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 4,
      cost: 500,
      changes: {
        // Excess shield damage carries over into Castle HP.
        effectParams: allMeteors({ shieldDamageOverflow: true }),
      },
    },
  ],
};

/** Earthquake: heavy Earth attack — damages the selected target and deals
 *  aftershock damage to every other kingdom ("adjacent" until maps land). */
export const EARTHQUAKE: AbilityDefinition = {
  id: "earthquake",
  name: "Earthquake",
  kind: "attack",
  cost: 500,
  cooldownTicks: 20 * TICK.RATE, // 20 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 750, element: "earth" },
    },
    {
      type: "damage",
      target: "otherEnemies", // aftershock splash
      params: { amount: 250, element: "earth" },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 500,
      changes: {
        effectParams: [{ amount: 800 }],
      },
    },
    {
      level: 2,
      cost: 600,
      changes: {
        effectParams: [null, { amount: 300 }], // aftershock 200 -> 300
      },
    },
    {
      level: 3,
      cost: 700,
      changes: {
        cooldownTicks: Math.round(20 * TICK.RATE * 0.9), // 18 s
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 4,
      cost: 800,
      changes: {
        // "Increase aftershock radius" awaits maps — until then, more damage.
        effectParams: [null, { amount: 400 }],
      },
    },
  ],
};

/** Natural Terrain buff: all incoming damage is halved while it lasts. */
export const NATURAL_TERRAIN_STATUS: StatusEffectDefinition = {
  id: "naturalTerrain",
  name: "Natural Terrain",
  category: "buff",
  stacking: "refresh",
  modifiers: [
    {
      stat: "damageTaken",
      op: "mult",
      value: 0.25,
    },
  ],
};

/** Natural Terrain buff (Lv 2): increased damage reduction (50% -> 60%). */
export const NATURAL_TERRAIN_STATUS_LV2: StatusEffectDefinition = {
  ...NATURAL_TERRAIN_STATUS,
  modifiers: [
    {
      stat: "damageTaken",
      op: "mult",
      value: 0.4,
    },
  ],
};

/** Natural Terrain: Earth utility — halve all incoming damage for 10 s. */
export const NATURAL_TERRAIN: AbilityDefinition = {
  id: "naturalTerrain",
  name: "Natural Terrain",
  kind: "utility",
  cost: 200,
  cooldownTicks: 30 * TICK.RATE, // 30 s
  targeting: { mode: "self" },
  effects: [
    {
      type: "status",
      target: "self",
      params: { status: NATURAL_TERRAIN_STATUS, durationTicks: 10 * TICK.RATE }, // 10 s
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 250,
      changes: {
        effectParams: [{ status: NATURAL_TERRAIN_STATUS_LV2 }],
      },
    },
    {
      level: 2,
      cost: 400,
      changes: {
        cooldownTicks: Math.round(30 * TICK.RATE * 0.85), // 510 ticks (25.5 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
  ],
};

/** Brick Wall: ultimate — create a 4,000 HP shield. */
export const BRICK_WALL: AbilityDefinition = {
  id: "brickWall",
  name: "Brick Wall",
  kind: "ultimate",
  cost: 750,
  cooldownTicks: 90 * TICK.RATE, // 90 s
  targeting: { mode: "self" },
  effects: [
    { type: "shield", target: "self", params: { amount: 4000 } },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 1000,
      changes: {
        // Preserves the original design's +1,000 upgrade step (2,500 -> 3,500).
        effectParams: [{ amount: 5000 }], // 4,000 -> 5,000
      },
    },
    {
      level: 2,
      cost: 1500,
      changes: {
        cooldownTicks: Math.round(90 * TICK.RATE * 0.85), // 1530 ticks (76.5 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
  ],
};

/** The Earth kingdom's activatable ability set. */
export const EARTH_ABILITIES: AbilityDefinition[] = [
  ROCK_THROW,
  METEOR_SHOWER,
  EARTHQUAKE,
  NATURAL_TERRAIN,
  BRICK_WALL,
];
