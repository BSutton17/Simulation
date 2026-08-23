import { TICK } from "./balance.js";
import type { AbilityDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Electricity Kingdom ability set (Epic 10) — pure data on the shared
 * frameworks. Electricity's two passives ("Don't Blink" −30% attack cooldowns,
 * "AfterShock" chance-based bonus damage) live in KINGDOM_PASSIVES
 * (kingdoms.ts).
 *
 * Lightning Barrage owns its charges (engine ChargeSystem): a pool of 3,
 * independent of Zap. Each cast spends 1–3 charges (caster's choice); spent
 * charges regenerate on independent staggered timers.
 *
 * NOTE: costs, cooldowns, damage numbers, and durations are initial defaults
 * (the design specifies mechanics, not magnitudes except where noted) —
 * expected to move in later balance tickets.
 */

/** Zap: basic Electricity attack. */
export const ZAP: AbilityDefinition = {
  id: "zap",
  name: "Zap",
  kind: "attack",
  cost: 53,
  unlockCost: 27,
  cooldownTicks: Math.round(3 * TICK.RATE), // 60 ticks (3 s)
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 225, element: "electricity" },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 150,
      changes: {
        effectParams: [{ amount: 305 }],
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
        effectParams: [{ amount: 355 }],
      },
    },
  ],
};

/**
 * Lightning Barrage: powerful Electricity attack with its own pool of 3
 * charges, fully independent of Zap. Each cast spends 1–3 charges (caster's
 * choice via ActivateOptions.chargesToUse) at 85g per charge (85 / 170 / 255)
 * and deals the per-count total damage: 1 → 200, 2 → 410, 3 → 650. There is
 * no ability-level cooldown — pacing comes from the charges themselves, which
 * regenerate independently (staggered 3 s per charge spent: using 1 charge
 * restores it in 3 s; using 2 restores them at 3 s and 6 s), so any charges
 * left over are castable immediately. Unlocking costs a flat 125g.
 */
export const LIGHTNING_BARRAGE: AbilityDefinition = {
  id: "lightningBarrage",
  name: "Lightning Barrage",
  kind: "attack",
  cost: 83, // per charge — the pipeline recomputes from charges spent
  unlockCost: 100,
  cooldownTicks: 0, // paced by charge regeneration, not an ability cooldown
  targeting: { mode: "singleEnemy" },
  chargeSystem: {
    max: 3,
    rechargeTicks: 3 * TICK.RATE, // 3 s per charge, staggered
    costPerCharge: 80,
    damageByCharges: [230, 475, 800],
  },
  effects: [
    {
      type: "damage",
      target: "target",
      params: {
        amount: 0, // the charge table supplies the damage
        element: "electricity",
      },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 200,
      changes: {
        effectParams: [{ amount: 100 }], // +100 flat damage at any charge count
      },
    },
    {
      level: 2,
      cost: 300,
      changes: {
        chargeSystem: { rechargeTicks: Math.round(2.5 * TICK.RATE) }, // 3 s -> 2.5 s
      },
    },
    {
      level: 3,
      cost: 400,
      changes: {
        effectParams: [{ amount: 200 }], // +200 flat damage at any charge count
      },
    },
    {
      level: 4,
      cost: 500,
      changes: {
        chargeSystem: { rechargeTicks: 2 * TICK.RATE }, // 2.5 s -> 2 s
      },
    },
  ],
};

/**
 * Thunderdome mark: while active, Electricity attacks *from the player who
 * created the dome* deal bonus damage to the target — the same conditional
 * damageTaken pattern Burn uses.
 */
export const THUNDERDOME_STATUS: StatusEffectDefinition = {
  id: "thunderdome",
  name: "Thunderdome",
  category: "debuff",
  stacking: "refresh",
  modifiers: [
    {
      stat: "damageTaken",
      op: "mult",
      value: 1.25,
      conditions: [
        { type: "attackElement", params: { element: "electricity" } },
        { type: "targetHasStatusFromCaster", params: { statusId: "thunderdome" } },
      ],
    },
  ],
};

/** Thunderdome mark (Lv 5): increased bonus damage inside the dome. */
export const THUNDERDOME_STATUS_LV5: StatusEffectDefinition = {
  ...THUNDERDOME_STATUS,
  modifiers: [
    {
      stat: "damageTaken",
      op: "mult",
      value: 1.5,
      conditions: [
        { type: "attackElement", params: { element: "electricity" } },
        { type: "targetHasStatusFromCaster", params: { statusId: "thunderdome" } },
      ],
    },
  ],
};

/** Thunderdome: combo attack — moderate damage plus a dome that amplifies
 *  Electricity attacks against the target while it lasts. */
export const THUNDERDOME: AbilityDefinition = {
  id: "thunderdome",
  name: "Thunderdome",
  kind: "attack",
  cost: 418,
  unlockCost: 209,
  cooldownTicks: Math.round(12.8 * TICK.RATE), // 21 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 289, element: "electricity" },
    },
    {
      type: "status",
      target: "target",
      params: { status: THUNDERDOME_STATUS, durationTicks: 8 * TICK.RATE }, // 8 s
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 250,
      changes: {
        effectParams: [{ amount: 525 }],
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
        cooldownTicks: 165, // 270 ticks (13.5 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 4,
      cost: 600,
      changes: {
        effectParams: [null, { status: THUNDERDOME_STATUS_LV5 }], // x1.25 -> x1.4
      },
    },
  ],
};

/** Hack: Electricity utility — steal a percentage of the target's money and
 *  citizens. Deals no damage. */
export const HACK: AbilityDefinition = {
  id: "hack",
  name: "Hack",
  kind: "utility",
  cost: 332,
  unlockCost: 166,
  cooldownTicks: Math.round(52.85 * TICK.RATE), // 61.5 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "resourceTransfer",
      target: "target",
      params: { resourceTransfer: { type: "currency", percent: 0.1 } },
    },
    {
      type: "resourceTransfer",
      target: "target",
      params: { resourceTransfer: { type: "citizens", percent: 0.1 } },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 300,
      changes: {
        effectParams: [
          { resourceTransfer: { type: "currency", percent: 0.15 } },
          { resourceTransfer: { type: "citizens", percent: 0.15 } },
        ],
      },
    },
    {
      level: 2,
      cost: 500,
      changes: {
        cooldownTicks: Math.round(25 * TICK.RATE * 0.85), // 425 ticks (21.25 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
  ],
};

/** Thundering Fate's window: while active, Zap arms no cooldown AND costs 35%
 *  less (the price is floored to whole gold by the activation pipeline). */
/**
 * How long Thundering Fate keeps Zap free of cooldown.
 *
 * THREE SECONDS, deliberately — short and explosive, not a long dump. The
 * surrounding comments used to describe ten, which is a documentation bug and
 * not a balance one; reading them as the spec is exactly how this got "fixed"
 * to a value nobody wanted. The number here is the spec.
 *
 * Exported so the test can assert against it rather than carrying its own copy.
 * The old assertion had `60` written into it, which means it would have agreed
 * with any change made in the same edit — pinning behaviour, not a literal, is
 * the point.
 */
export const THUNDERING_FATE_WINDOW_TICKS = 3 * TICK.RATE;

export const THUNDERING_FATE_STATUS: StatusEffectDefinition = {
  id: "thunderingFate",
  name: "Thundering Fate",
  category: "buff",
  stacking: "refresh",
  modifiers: [
    // Per-ability cooldown stat (cooldowns.ts): x0 while the status lasts.
    { stat: "cooldown:zap", op: "mult", value: 0 },
    // Per-ability price stat (activation pipeline): Zap costs 35% less.
    { stat: "abilityCost:zap", op: "mult", value: 0.65 },
  ],
};

/** Thundering Fate: ultimate — for 3 seconds Zap has no cooldown and costs 35%
 *  less (rounded down). Five seconds at Lv1. */
export const THUNDERING_FATE: AbilityDefinition = {
  id: "thunderingFate",
  name: "Thundering Fate",
  kind: "ultimate",
  cost: 503,
  unlockCost: 526,
  cooldownTicks: Math.round(151.2 * TICK.RATE), // 3024 ticks (151.2 s)
  targeting: { mode: "self" },
  effects: [
    {
      // Clear any cooldown Zap is already serving…
      type: "cooldownModify",
      target: "self",
      params: { cooldownModify: { op: "set", value: 0, target: "zap" } },
    },
    {
      // …and keep it clear for the window.
      type: "status",
      target: "self",
      params: { status: THUNDERING_FATE_STATUS, durationTicks: THUNDERING_FATE_WINDOW_TICKS },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 800,
      changes: {
        effectParams: [null, { durationTicks: 5 * TICK.RATE }], // 3 s -> 5 s
      },
    },
    {
      level: 2,
      cost: 1000,
      changes: {
        cooldownTicks: Math.round(90 * TICK.RATE * 0.85), // 1530 ticks (76.5 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
  ],
};

/** The Electricity kingdom's activatable ability set. */
export const ELECTRICITY_ABILITIES: AbilityDefinition[] = [
  ZAP,
  LIGHTNING_BARRAGE,
  THUNDERDOME,
  HACK,
  THUNDERING_FATE,
];
