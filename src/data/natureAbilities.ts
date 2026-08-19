import { TICK } from "./balance.js";
import type { AbilityDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Nature Kingdom ability set (Epic 12) — pure data on the shared frameworks.
 * Nature's passives ("No Rose Without Thorns" reflected damage, "Gardener's
 * Gift" extra starting citizens) live in KINGDOM_PASSIVES (kingdoms.ts).
 *
 * Poison design: one status id ("poison") in weak/strong/shield-piercing
 * variants — re-application swaps in the newest variant's tick damage.
 * Normally Poison only refreshes; while the bearer is Corroded it *stacks*
 * (conditional stacking), and Corroded also amplifies its damage via the
 * generic "dotDamage:poison" stat.
 *
 * NOTE: costs, cooldowns, damage numbers, and durations are initial defaults
 * (the design specifies mechanics, not magnitudes except where noted) —
 * expected to move in later balance tickets.
 */

/** "Until used": Poison Apple's mark persists until an attacker springs it. */
const UNTIL_USED = Number.MAX_SAFE_INTEGER;

// Poison worsens the longer it festers (+20%/s, capped at ×3) — this is what
// separates Nature's Poison from Fire's flat, front-loaded Burn.
const POISON_RAMP = { rampPerSecond: 0.2, rampMaxMultiplier: 3 } as const;

/** Weak Poison (Sludge): light, ramping damage over time. */
export const POISON_STATUS: StatusEffectDefinition = {
  id: "poison",
  name: "Poison",
  category: "debuff",
  stacking: "refresh",
  // Corroded makes future Poison effects stack instead of refreshing.
  stackingWhileStatus: { statusId: "corroded", stacking: "stack" },
  maxStacks: 5,
  tickEffects: [
    { type: "damage", amount: 3, perStack: true, ...POISON_RAMP },
  ],
};

/** Strong Poison (Gastro Acid, Poison Apple): heavier ramping tick damage. */
export const POISON_STATUS_STRONG: StatusEffectDefinition = {
  ...POISON_STATUS,
  tickEffects: [
    { type: "damage", amount: 4, perStack: true, ...POISON_RAMP },
  ],
};

/** Toxic Poison (Toxic Gas): strong, ramping, and it ignores all shields. */
export const POISON_STATUS_TOXIC: StatusEffectDefinition = {
  ...POISON_STATUS,
  tickEffects: [
    { type: "damage", amount: 5, perStack: true, ignoreShields: true, ...POISON_RAMP },
  ],
};

/** Corroded: Poison on the bearer deals +25% damage, and future Poison
 *  applications stack while this lasts. */
export const CORRODED_STATUS: StatusEffectDefinition = {
  id: "corroded",
  name: "Corroded",
  category: "debuff",
  stacking: "refresh",
  modifiers: [
    { stat: "dotDamage:poison", op: "mult", value: 1.25 },
  ],
};

/** Corroded (Lv 5): Poison damage amplified even further (+50%). */
export const CORRODED_STATUS_LV5: StatusEffectDefinition = {
  ...CORRODED_STATUS,
  modifiers: [
    { stat: "dotDamage:poison", op: "mult", value: 1.5 },
  ],
};

/** Poisoned Citizens (Gastro Acid): income per citizen drops $0.10 → $0.08. */
export const POISONED_CITIZENS_STATUS: StatusEffectDefinition = {
  id: "poisonedCitizens",
  name: "Poisoned Citizens",
  category: "debuff",
  stacking: "refresh",
  modifiers: [
    { stat: "income", op: "mult", value: 0.5 },
  ],
};

/** Poison Apple's mark: the next kingdom to damage Nature is Poisoned — HP over
 *  time AND their citizens (income sapped) for the same window. */
export const POISON_APPLE_STATUS: StatusEffectDefinition = {
  id: "poisonApple",
  name: "Poison Apple",
  category: "buff",
  stacking: "replace",
  onHitRetaliate: { status: POISON_STATUS_STRONG, durationTicks: 5 * TICK.RATE },
  onHitRetaliateExtra: [{ status: POISONED_CITIZENS_STATUS, durationTicks: 5 * TICK.RATE }],
};

/** Poison Apple's mark (Lv 2): longer Poison (and citizen poison) on the biter. */
export const POISON_APPLE_STATUS_LV2: StatusEffectDefinition = {
  ...POISON_APPLE_STATUS,
  onHitRetaliate: { status: POISON_STATUS_STRONG, durationTicks: 7 * TICK.RATE },
  onHitRetaliateExtra: [{ status: POISONED_CITIZENS_STATUS, durationTicks: 7 * TICK.RATE }],
};

/** Toxic Gas lockout: the bearer cannot buy citizens or repair. */
export const TOXIC_GAS_STATUS: StatusEffectDefinition = {
  id: "toxicGas",
  name: "Toxic Gas",
  category: "debuff",
  stacking: "refresh",
  blocksPurchases: true,
};

/** Sludge: basic Nature attack; applies a weak Poison (3 s). */
export const SLUDGE: AbilityDefinition = {
  id: "sludge",
  name: "Sludge",
  kind: "attack",
  cost: 200,
  cooldownTicks: 3 * TICK.RATE, // 3 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 320, element: "nature" },
    },
    {
      type: "status",
      target: "target",
      params: { status: POISON_STATUS, durationTicks: 3 * TICK.RATE }, // 3 s
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 200,
      changes: {
        effectParams: [{ amount: 385 }],
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
      cost: 300,
      changes: {
        effectParams: [{ amount: 450 }],
      },
    },
  ],
};

/** Acid Rain: moderate Nature attack; applies Corroded. */
export const ACID_RAIN: AbilityDefinition = {
  id: "acidRain",
  name: "Acid Rain",
  kind: "attack",
  cost: 345,
  cooldownTicks: 9.75 * TICK.RATE, // 9.75 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 335, element: "nature" },
    },
    {
      type: "status",
      target: "target",
      params: { status: CORRODED_STATUS, durationTicks: 8 * TICK.RATE }, // 8 s
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 200,
      changes: {
        effectParams: [{ amount: 430 }],
      },
    },
    {
      level: 2,
      cost: 300,
      changes: {
        effectParams: [null, { durationTicks: 12 * TICK.RATE }], // 8 s -> 12 s
      },
    },
    {
      level: 3,
      cost: 400,
      changes: {
        cooldownTicks: Math.round(10 * TICK.RATE * 0.9), // 9 s
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 4,
      cost: 500,
      changes: {
        effectParams: [null, { status: CORRODED_STATUS_LV5 }], // +25% -> +50%
      },
    },
  ],
};

/** Gastro Acid: powerful Nature attack — strong Poison (5 s), plus a 50%
 *  chance to Poison the target's citizens (income $0.10 → $0.08/citizen). */
export const GASTRO_ACID: AbilityDefinition = {
  id: "gastroAcid",
  name: "Gastro Acid",
  kind: "attack",
  cost: 440,
  cooldownTicks: 18.5 * TICK.RATE, // 18.5 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 405, element: "nature" },
    },
    {
      type: "status",
      target: "target",
      params: { status: POISON_STATUS_STRONG, durationTicks: 5 * TICK.RATE }, // 5 s
    },
    {
      type: "status",
      target: "target",
      params: { status: POISONED_CITIZENS_STATUS, durationTicks: 5 * TICK.RATE },
      chance: 0.5,
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 250,
      changes: {
        effectParams: [{ amount: 495 }],
      },
    },
    {
      level: 2,
      cost: 400,
      changes: {
        effectChances: [null, null, 0.75], // citizen poison 50% -> 75%
      },
    },
    {
      level: 3,
      cost: 500,
      changes: {
        cooldownTicks: Math.round(15 * TICK.RATE * 0.9), // 270 ticks (13.5 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 4,
      cost: 700,
      changes: {
        effectParams: [null, { durationTicks: 7 * TICK.RATE }, null], // 5 s -> 7 s
      },
    },
  ],
};

/** Poison Apple: Nature utility — the next kingdom to attack Nature is
 *  immediately Poisoned. Persists until sprung. */
export const POISON_APPLE: AbilityDefinition = {
  id: "poisonApple",
  name: "Poison Apple",
  kind: "utility",
  cost: 155,
  cooldownTicks: 21 * TICK.RATE, // 21 s
  targeting: { mode: "self" },
  effects: [
    {
      type: "status",
      target: "self",
      params: { status: POISON_APPLE_STATUS, durationTicks: UNTIL_USED },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 250,
      changes: {
        effectParams: [{ status: POISON_APPLE_STATUS_LV2 }], // poison 5 s -> 7 s
      },
    },
    {
      level: 2,
      cost: 400,
      changes: {
        cooldownTicks: Math.round(25 * TICK.RATE * 0.85), // 425 ticks (21.25 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
  ],
};

/** Toxic Gas: ultimate — Poison every opposing kingdom (shield-piercing) and
 *  bar them from buying citizens or repairing while it lasts. */
export const TOXIC_GAS: AbilityDefinition = {
  id: "toxicGas",
  name: "Toxic Gas",
  kind: "ultimate",
  cost: 700,
  cooldownTicks: 74.75 * TICK.RATE, // 74.75 s
  targeting: { mode: "allEnemies" },
  effects: [
    {
      type: "status",
      target: "target",
      params: { status: POISON_STATUS_TOXIC, durationTicks: 10 * TICK.RATE }, // 10 s
    },
    {
      type: "status",
      target: "target",
      params: { status: TOXIC_GAS_STATUS, durationTicks: 10 * TICK.RATE },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 1000,
      changes: {
        effectParams: [
          { durationTicks: 13 * TICK.RATE }, // poison 10 s -> 13 s
          { durationTicks: 13 * TICK.RATE }, // lockout follows it
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

/** The Nature kingdom's activatable ability set. */
export const NATURE_ABILITIES: AbilityDefinition[] = [
  SLUDGE,
  ACID_RAIN,
  GASTRO_ACID,
  POISON_APPLE,
  TOXIC_GAS,
];
