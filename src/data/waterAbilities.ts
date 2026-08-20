import { TICK } from "./balance.js";
import type { AbilityDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Water Kingdom ability set (Epic 6, tickets #82–#90) — pure data on the
 * shared frameworks; no Water-specific engine code exists. Water's two
 * passives ("We're In This Together", "Fountain of Youth") live in
 * KINGDOM_PASSIVES (kingdoms.ts, ticket #81).
 *
 * NOTE: costs, cooldowns, damage numbers, durations, and the lifesteal ratio
 * are initial defaults (the design specifies mechanics, not magnitudes except
 * where noted) — expected to move in later balance tickets.
 */

/**
 * Current (ticket #83): the mark Waterfall leaves on a target. Water attacks
 * heal Water while it lasts (#85, via each attack's `lifesteal` gate) and
 * Flood lasts longer against it (#86, via `bonusDurationIfTargetHasStatus`).
 */
export const CURRENT_STATUS: StatusEffectDefinition = {
  id: "current",
  name: "Current",
  category: "debuff",
  stacking: "refresh",
};

/**
 * Flooded (tickets #87–#88): bars the bearer from targeting the Water player
 * who applied it (`blocksTargetingSource`); all other kingdoms remain valid
 * targets. Design duration: 5 seconds.
 */
export const FLOODED_STATUS: StatusEffectDefinition = {
  id: "flooded",
  name: "Flooded",
  category: "debuff",
  stacking: "refresh",
  blocksTargetingSource: true,
};

/** Healing per point of damage dealt to a Current-marked target (#85). */
const CURRENT_LIFESTEAL = { ratio: 0.4, requiresTargetStatus: "current" };

/** Water Ball (#82): basic Water attack. */
export const WATER_BALL: AbilityDefinition = {
  id: "waterBall",
  name: "Water Ball",
  kind: "attack",
  cost: 147,
  cooldownTicks: Math.round(2.25 * TICK.RATE), // 3.75 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 271, element: "water", lifesteal: CURRENT_LIFESTEAL },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 150,
      changes: {
        effectParams: [{ amount: 350 }],
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
        effectParams: [{ amount: 400 }],
      },
    },
  ],
};

/** Waterfall (#84): powerful attack that applies Current (8 s). */
export const WATERFALL: AbilityDefinition = {
  id: "waterfall",
  name: "Waterfall",
  kind: "attack",
  cost: 274,
  cooldownTicks: Math.round(6.05 * TICK.RATE), // 8.75 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 355, element: "water", lifesteal: CURRENT_LIFESTEAL },
    },
    {
      type: "status",
      target: "target",
      params: { status: CURRENT_STATUS, durationTicks: 8 * TICK.RATE },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 200,
      changes: {
        effectParams: [{ amount: 450 }],
      },
    },
    {
      level: 2,
      cost: 300,
      changes: {
        effectParams: [null, { durationTicks: 10 * TICK.RATE }], // Current duration +2s (8s -> 10s)
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
      cost: 400,
      changes: {
        effectParams: [
          { lifesteal: { ratio: 0.40, requiresTargetStatus: "current" } },
        ],
      },
    },
  ],
};

/**
 * Flood (#87): heavy damage; bars the target from targeting Water for 5 s
 * (per design), extended by another 5 s against Current-affected targets (#86).
 */
export const FLOOD: AbilityDefinition = {
  id: "flood",
  name: "Flood",
  kind: "attack",
  cost: 189,
  cooldownTicks: Math.round(29.75 * TICK.RATE), // 21.25 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 784, element: "water", lifesteal: CURRENT_LIFESTEAL },
    },
    {
      type: "status",
      target: "target",
      params: {
        status: FLOODED_STATUS,
        durationTicks: 5 * TICK.RATE, // design: 5 s
        bonusDurationIfTargetHasStatus: {
          statusId: "current",
          extraTicks: 5 * TICK.RATE,
        },
      },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 250,
      changes: {
        effectParams: [{ amount: 665 }],
      },
    },
    {
      level: 2,
      cost: 300,
      changes: {
        effectParams: [null, { durationTicks: 7 * TICK.RATE }], // flooded duration 5s -> 7s
      },
    },
    {
      level: 3,
      cost: 400,
      changes: {
        cooldownTicks: Math.round(20 * TICK.RATE * 0.9), // 18 s
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 4,
      cost: 500,
      changes: {
        // Lv5: increased healing from Flood — lifesteal ratio 40% -> 125%.
        effectParams: [
          { lifesteal: { ratio: 1.25, requiresTargetStatus: "current" } },
        ],
      },
    },
  ],
};

/**
 * Assimilated (#89 rework): the mark Fluid Assimilation puts on every other
 * kingdom. Like Flooded, it bars the bearer from targeting the Water player
 * who applied it (`blocksTargetingSource`) and severs an existing lock-on.
 */
export const ASSIMILATED_STATUS: StatusEffectDefinition = {
  id: "assimilated",
  name: "Assimilated",
  category: "debuff",
  stacking: "refresh",
  blocksTargetingSource: true,
};

/**
 * Fluid Assimilation (#89, reworked): utility — no enemy can attack Water for
 * 5 seconds. Applies Assimilated to every living enemy; existing lock-ons
 * onto Water are severed (same mechanism as Flood, ticket #88).
 */
export const FLUID_ASSIMILATION: AbilityDefinition = {
  id: "fluidAssimilation",
  name: "Fluid Assimilation",
  kind: "utility",
  cost: 246,
  cooldownTicks: Math.round(20.85 * TICK.RATE), // 34.75 s
  targeting: { mode: "allEnemies" },
  effects: [
    {
      type: "status",
      target: "target",
      params: { status: ASSIMILATED_STATUS, durationTicks: Math.round(3.3 * TICK.RATE)},
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 300,
      changes: {
        effectParams: [{ durationTicks: 12 * TICK.RATE }], // protection 5s -> 12s
      },
    },
    {
      level: 2,
      cost: 400,
      changes: {
        cooldownTicks: Math.round(15 * TICK.RATE * 0.85), // 255 ticks (12.75 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
  ],
};

/** Riptide (#90): ultimate — restore 50% Castle HP, +5% citizens. */
export const RIPTIDE: AbilityDefinition = {
  id: "riptide",
  name: "Riptide",
  kind: "ultimate",
  cost: 1345,
  cooldownTicks: Math.round(231.65 * TICK.RATE), // 192 s
  targeting: { mode: "self" },
  effects: [
    { type: "heal", target: "self", params: { percentMaxHp: 0.5 } },
    { type: "economyModifier", target: "self", params: { citizensPercent: 0.05 } },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 1000,
      changes: {
        effectParams: [
          { percentMaxHp: 0.70 },
          { citizensPercent: 0.1 },
        ],
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

/** The Water kingdom's activatable ability set. */
export const WATER_ABILITIES: AbilityDefinition[] = [
  WATER_BALL,
  WATERFALL,
  FLOOD,
  FLUID_ASSIMILATION,
  RIPTIDE,
];
