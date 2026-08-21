import { TICK } from "./balance.js";
import type { AbilityDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Air Kingdom ability set (Epic 8) — pure data on the shared frameworks. Air's
 * two passives ("Embrace of Winds" multi-target attacks, "A Gust of Envy" 5%
 * incoming-attack redirect) live in KINGDOM_PASSIVES (kingdoms.ts).
 *
 * NOTE: costs, cooldowns, damage numbers, and durations are initial defaults
 * (the design specifies mechanics, not magnitudes except where noted) —
 * expected to move in later balance tickets.
 */

/** "Until used": Hurricane's mark persists until consumed by a deflection. */
const UNTIL_USED = Number.MAX_SAFE_INTEGER;

/**
 * Hurricane's mark: the bearer's next attack on the Air player who applied it
 * is guaranteed to be deflected to another valid kingdom (engine consumes it
 * via `deflectsAttackOnSource`).
 */
export const HURRICANE_MARK: StatusEffectDefinition = {
  id: "hurricaneMark",
  name: "Hurricane",
  category: "debuff",
  stacking: "refresh",
  deflectsAttackOnSource: {},
};

/** Hurricane's mark (Lv 3): the deflected attack hits its new target harder. */
export const HURRICANE_MARK_LV3: StatusEffectDefinition = {
  ...HURRICANE_MARK,
  deflectsAttackOnSource: { damageMult: 1.25 },
};

/** Hurricane's mark (Lv 5): 50% chance for a second deflection (1 → 2). */
export const HURRICANE_MARK_LV5: StatusEffectDefinition = {
  ...HURRICANE_MARK,
  deflectsAttackOnSource: { damageMult: 1.25, chainChance: 0.5 },
};

/** Bird's Eye View reveal marker — the client uses its presence to show every
 *  kingdom's Castle HP, Shield HP, Citizens, and Income. */
export const BIRDS_EYE_STATUS: StatusEffectDefinition = {
  id: "birdsEyeView",
  name: "Bird's Eye View",
  category: "buff",
  stacking: "refresh",
};

/** Dust Bunnies: slow damage over time on every opposing kingdom. */
export const DUST_BUNNIES_STATUS: StatusEffectDefinition = {
  id: "dustBunnies",
  name: "Dust Bunnies",
  category: "debuff",
  stacking: "refresh",
  tickEffects: [
    {
      // 10 per tick across the 210-tick duration below = 2100 to every kingdom.
      type: "damage",
      amount: 10,
    },
  ],
};

/** Dust Bunnies status (Lv 2): increased damage over time. */
export const DUST_BUNNIES_STATUS_LV2: StatusEffectDefinition = {
  ...DUST_BUNNIES_STATUS,
  tickEffects: [
    {
      // Same +50% step the tier always had: 3150 over the full duration.
      type: "damage",
      amount: 15,
    },
  ],
};

/** A Light Breeze: basic Air attack. Under Bird's Eye View, a multi-kingdom
 *  cast ricochets between the selected kingdoms (Epic 8, `bounce`). */
export const A_LIGHT_BREEZE: AbilityDefinition = {
  id: "aLightBreeze",
  name: "A Light Breeze",
  kind: "attack",
  cost: 63,
  unlockCost: 32,
  cooldownTicks: Math.round(3.75 * TICK.RATE), // 3 s
  targeting: { mode: "singleEnemy" },
  // Bird's Eye View turns a multi-target Breeze into a bouncing gust: full
  // damage per landing, 50% to bounce again, up to 4 landings, never the same
  // castle twice in a row. One kingdom selected = no bounce (a normal hit).
  bounce: { requiresCasterStatus: "birdsEyeView", chance: 0.5, maxLandings: 4 },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 238, element: "air" },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 150,
      changes: {
        effectParams: [{ amount: 287 }],
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
        effectParams: [{ amount: 336 }],
      },
    },
  ],
};

/** Hurricane: powerful Air attack; marks the target so their next attack on
 *  Air is deflected to another valid kingdom. */
export const HURRICANE: AbilityDefinition = {
  id: "hurricane",
  name: "Hurricane",
  kind: "attack",
  cost: 177,
  unlockCost: 89,
  cooldownTicks: Math.round(13.2 * TICK.RATE), // 10.75 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 623, element: "air" },
    },
    {
      type: "status",
      target: "target",
      params: { status: HURRICANE_MARK, durationTicks: UNTIL_USED },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 200,
      changes: {
        effectParams: [{ amount: 700 }],
      },
    },
    {
      level: 2,
      cost: 300,
      changes: {
        // Deflected attack deals increased damage to the redirected target.
        effectParams: [null, { status: HURRICANE_MARK_LV3 }],
      },
    },
    {
      level: 3,
      cost: 450,
      changes: {
        cooldownTicks: Math.round(10 * TICK.RATE * 0.9), // 9 s
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 4,
      cost: 600,
      changes: {
        // 50% chance the deflection chains once (1 deflection becomes 2).
        effectParams: [null, { status: HURRICANE_MARK_LV5 }],
      },
    },
  ],
};

/** Thick Fog: moderate damage; obscures the target's screen for a short
 *  duration. At most 3 players may be fogged at once (4 at Lv 5). */
export const THICK_FOG: AbilityDefinition = {
  id: "thickFog",
  name: "Thick Fog",
  kind: "attack",
  cost: 255,
  unlockCost: 128,
  cooldownTicks: Math.round(20.3 * TICK.RATE), // 14.5 s
  targeting: { mode: "singleEnemy" },
  maxConcurrentAffected: { statusId: "vision:fog", limit: 3 },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 679, element: "air" },
    },
    {
      type: "vision",
      target: "target",
      params: { vision: { type: "fog", durationTicks: 5 * TICK.RATE } }, // 5 s
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 250,
      changes: {
        effectParams: [{ amount: 805 }],
      },
    },
    {
      level: 2,
      cost: 400,
      changes: {
        effectParams: [null, { vision: { type: "fog", durationTicks: 8 * TICK.RATE } }], // 5 s -> 8 s
      },
    },
    {
      level: 3,
      cost: 600,
      changes: {
        cooldownTicks: Math.round(15 * TICK.RATE * 0.9), // 270 ticks (13.5 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 4,
      cost: 800,
      changes: {
        maxConcurrentAffected: { statusId: "vision:fog", limit: 4 }, // 3 -> 4
      },
    },
  ],
};

/** Bird's Eye View: Air utility — temporarily reveal every kingdom's Castle
 *  HP, Shield HP, Citizens, and Income. */
export const BIRDS_EYE_VIEW: AbilityDefinition = {
  id: "birdsEyeView",
  name: "Bird's Eye View",
  kind: "utility",
  cost: 100,
  unlockCost: 50,
  cooldownTicks: 20 * TICK.RATE, // 20 s
  targeting: { mode: "self" },
  effects: [
    {
      type: "status",
      target: "self",
      params: { status: BIRDS_EYE_STATUS, durationTicks: 10 * TICK.RATE }, // 10 s
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 200,
      changes: {
        effectParams: [{ durationTicks: 15 * TICK.RATE }], // reveal 10 s -> 15 s
      },
    },
    {
      level: 2,
      cost: 350,
      changes: {
        cooldownTicks: Math.round(20 * TICK.RATE * 0.85), // 340 ticks (17 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
  ],
};

/** Dust Bunnies: ultimate — send Dust Bunnies to every opposing kingdom,
 *  slowly damaging all of them over time. */
export const DUST_BUNNIES: AbilityDefinition = {
  id: "dustBunnies",
  name: "Dust Bunnies",
  kind: "ultimate",
  cost: 300,
  unlockCost: 150,
  cooldownTicks: Math.round(64.85 * TICK.RATE), // 93.25 s
  targeting: { mode: "allEnemies" },
  effects: [
    {
      type: "status",
      target: "target",
      // 10.5 s — 210 ticks, so the DoT totals exactly 2100 per kingdom.
      params: { status: DUST_BUNNIES_STATUS, durationTicks: 10.5 * TICK.RATE },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 1000,
      changes: {
        effectParams: [{ status: DUST_BUNNIES_STATUS_LV2 }], // 10 -> 15 per tick
      },
    },
    {
      level: 2,
      cost: 1500,
      changes: {
        cooldownTicks: 1064, // 1530 ticks (76.5 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
  ],
};

/** The Air kingdom's activatable ability set. */
export const AIR_ABILITIES: AbilityDefinition[] = [
  A_LIGHT_BREEZE,
  HURRICANE,
  THICK_FOG,
  BIRDS_EYE_VIEW,
  DUST_BUNNIES,
];
