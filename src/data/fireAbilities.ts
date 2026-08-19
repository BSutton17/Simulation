import { FIRE, TICK } from "./balance.js";
import type { AbilityDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Fire attacks from the Burn's applier deal this multiplier against the
 * burning target (initial default — expected to move in balance tickets).
 */
const BURN_FIRE_AMP = 1.25;

/**
 * Reusable Burn Status effect (ticket #113). Burn does two things:
 *  - DoT: 20 damage per tick per stack, capping at 5 stacks;
 *  - amplification: while burning, Fire attacks *from the player who applied
 *    the Burn* deal ×1.25 damage (a conditional damageTaken modifier gated on
 *    the attack's element and the Burn's source).
 */
export const BURN_STATUS: StatusEffectDefinition = {
  id: "burn",
  name: "Burn",
  category: "debuff",
  isBurn: true,
  stacking: "stack",
  maxStacks: 3,
  tickEffects: [
    {
      type: "damage",
      amount: 10,
      perStack: true,
    },
  ],
  modifiers: [
    {
      stat: "damageTaken",
      op: "mult",
      value: BURN_FIRE_AMP,
      conditions: [
        { type: "attackElement", params: { element: "fire" } },
        { type: "targetHasStatusFromCaster", params: { statusId: "burn" } },
      ],
    },
  ],
};

/**
 * Ignited (Scorching Sun). NOT a burn — nothing ticks, nothing shows on the
 * health bar. It is a sixty-second mark that rolls, every fifteen seconds, for
 * a real Burn.
 *
 * The point is the uncertainty. A burn is a known cost you can plan around; a
 * one-in-four roll four times over a minute is a cost you cannot price, so the
 * victim either plays around a fire that may never come or eats one at the
 * worst possible moment. It also makes Firenado's bonus land on a target that
 * is NOT currently burning, which is what stops the two abilities collapsing
 * into "apply burn, then hit the burn".
 */
export const IGNITED_STATUS: StatusEffectDefinition = {
  id: "ignited",
  name: "Ignited",
  category: "debuff",
  stacking: "refresh",
  tickEffects: [
    {
      type: "applyStatus",
      amount: 0, // unused by applyStatus; the payload is `applies`
      intervalTicks: FIRE.IGNITED_ROLL_SECONDS * TICK.RATE,
      chance: FIRE.IGNITED_BURN_CHANCE,
      applies: {
        status: BURN_STATUS,
        durationTicks: FIRE.IGNITED_BURN_SECONDS * TICK.RATE,
      },
    },
  ],
};

/** Fireball: basic Fire attack (ticket #112). */
export const FIREBALL: AbilityDefinition = {
  id: "fireball",
  name: "Fireball",
  kind: "attack",
  cost: 125,
  cooldownTicks: 2.75 * TICK.RATE, // 2.75 s
  targeting: { mode: "singleEnemy" },
  // A plain damage attack — Burn is applied only by Scorching Sun (guaranteed)
  // and Firenado (chance); the Burn status itself carries the extra damage.
  effects: [
    {
      type: "damage",
      target: "target",
      params: { amount: 315, element: "fire" },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 150,
      changes: {
        effectParams: [{ amount: 380 }],
      },
    },
    {
      level: 2,
      cost: 200,
      changes: {
        cooldownTicks: Math.round(3 * TICK.RATE * 0.9), // 54 ticks (2.7 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 3,
      cost: 300,
      changes: {
        effectParams: [{ amount: 440 }],
      },
    },
  ],
};

/** Scorching Sun: powerful Fire attack with burn synergy (ticket #112). */
export const SCORCHING_SUN: AbilityDefinition = {
  id: "scorchingSun",
  name: "Scorching Sun",
  kind: "attack",
  cost: 150,
  cooldownTicks: 8.75 * TICK.RATE, // 8.75 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: {
        amount: 445,
        element: "fire",
        bonusDamageIfTargetHasStatus: { statusId: "burn", extraAmount: 100 },
      },
    },
    {
      // Ignited, NOT Burn: Scorching Sun marks its victim and leaves the fire
      // to chance. See IGNITED_STATUS.
      type: "status",
      target: "target",
      params: {
        status: IGNITED_STATUS,
        durationTicks: FIRE.IGNITED_SECONDS * TICK.RATE, // 60 s
      },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 300,
      changes: {
        effectParams: [{ amount: 555 }],
      },
    },
    {
      level: 2,
      cost: 400,
      changes: {
        // The mark burns for longer, so it gets an extra roll at a burn.
        effectParams: [null, { durationTicks: 75 * TICK.RATE }], // 60 s -> 75 s
      },
    },
    {
      level: 3,
      cost: 550,
      changes: {
        cooldownTicks: Math.round(8 * TICK.RATE * 0.9), // 144 ticks (7.2 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 4,
      cost: 600,
      changes: {
        effectParams: [
          { bonusDamageIfTargetHasStatus: { statusId: "burn", extraAmount: 350 } },
        ],
      },
    },
  ],
};

/** Firenado: very powerful chance-based Fire attack (ticket #112). */
export const FIRENADO: AbilityDefinition = {
  id: "firenado",
  name: "Firenado",
  kind: "attack",
  cost: 345,
  cooldownTicks: 23 * TICK.RATE, // 23 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      // Hits hardest on a target that is IGNITED rather than already burning:
      // Scorching Sun sets them up, Firenado cashes it in, and the follow-up
      // is worth most BEFORE the fire has actually caught. Keying it off Burn
      // instead would just reward hitting the same burn twice.
      params: {
        amount: 505,
        element: "fire",
        bonusDamageIfTargetHasStatus: { statusId: "ignited", extraAmount: 250 },
      },
    },
    {
      // Guaranteed. Firenado is the ability that actually SETS the fire; the
      // gamble lives in Ignited now, not here.
      type: "status",
      target: "target",
      params: { status: BURN_STATUS, durationTicks: 5 * TICK.RATE }, // 5 s
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 300,
      changes: {
        effectParams: [{ amount: 590 }],
      },
    },
    {
      level: 2,
      cost: 350,
      changes: {
        // The burn used to become more likely here; it is certain now, so the
        // level buys a bigger payoff for setting the target up first.
        effectParams: [
          { bonusDamageIfTargetHasStatus: { statusId: "ignited", extraAmount: 400 } },
        ],
      },
    },
    {
      level: 3,
      cost: 400,
      changes: {
        cooldownTicks: Math.round(12 * TICK.RATE * 0.9), // 216 ticks (10.8 s)
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
    {
      level: 4,
      cost: 500,
      changes: {
        effectParams: [null, { durationTicks: 8 * TICK.RATE }], // burn duration 5s -> 8s (160 ticks)
      },
    },
  ],
};

/** Heat Wave status effect (ticket #113). */
export const HEAT_WAVE_STATUS: StatusEffectDefinition = {
  id: "heatWave",
  name: "Heat Wave",
  category: "buff",
  stacking: "refresh",
  modifiers: [
    {
      // Takes the crit chance to 15% — added on top of the 5% shared base.
      stat: "critChance",
      op: "add",
      value: 0.10,
    },
    {
      stat: "critMultiplier",
      op: "add",
      value: 0.10,
    },
  ],
};

/** Heat Wave status effect (Lv 2). */
export const HEAT_WAVE_STATUS_LV2: StatusEffectDefinition = {
  ...HEAT_WAVE_STATUS,
  modifiers: [
    {
      // Upgraded: 20% total crit chance (5% base + 15%).
      stat: "critChance",
      op: "add",
      value: 0.15,
    },
    {
      stat: "critMultiplier",
      op: "add",
      value: 0.10,
    },
  ],
};

/** Heat Wave status effect (Lv 3). */
export const HEAT_WAVE_STATUS_LV3: StatusEffectDefinition = {
  ...HEAT_WAVE_STATUS,
  modifiers: [
    {
      // Upgraded: 20% total crit chance (5% base + 15%).
      stat: "critChance",
      op: "add",
      value: 0.15,
    },
    {
      stat: "critMultiplier",
      op: "add",
      value: 0.15,
    },
  ],
};

/** Heat Wave: Fire utility self-buff (ticket #113). */
export const HEAT_WAVE: AbilityDefinition = {
  id: "heatWave",
  name: "Heat Wave",
  kind: "utility",
  cost: 95,
  cooldownTicks: 15.75 * TICK.RATE, // 15.75 s
  targeting: { mode: "self" },
  effects: [
    {
      type: "status",
      target: "self",
      params: { status: HEAT_WAVE_STATUS, durationTicks: 190},
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 200,
      changes: {
        effectParams: [{ status: HEAT_WAVE_STATUS_LV2 }],
      },
    },
    {
      level: 2,
      cost: 350,
      changes: {
        effectParams: [{ status: HEAT_WAVE_STATUS_LV3 }],
      },
    },
  ],
};

/** Blazing Determination status effect (ticket #114). */
export const BLAZING_DETERMINATION_STATUS: StatusEffectDefinition = {
  id: "blazingDetermination",
  name: "Blazing Determination",
  category: "buff",
  stacking: "replace",
  modifiers: [
    {
      stat: "damage",
      op: "mult",
      value: 2.75,
      usageLimit: 1,
    },
  ],
};

/** Blazing Determination status effect (Lv 2). */
export const BLAZING_DETERMINATION_STATUS_LV2: StatusEffectDefinition = {
  ...BLAZING_DETERMINATION_STATUS,
  modifiers: [
    {
      stat: "damage",
      op: "mult",
      value: 3.25,
      usageLimit: 1,
    },
  ],
};

/** Blazing Determination: Fire utility/ultimate self-buff (ticket #114). */
export const BLAZING_DETERMINATION: AbilityDefinition = {
  id: "blazingDetermination",
  name: "Blazing Determination",
  kind: "utility",
  cost: 650,
  cooldownTicks: 35 * TICK.RATE, // 30s
  targeting: { mode: "self" },
  effects: [
    {
      type: "status",
      target: "self",
      params: { status: BLAZING_DETERMINATION_STATUS, durationTicks: 30 * TICK.RATE },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 350,
      changes: {
        effectParams: [{ status: BLAZING_DETERMINATION_STATUS_LV2 }],
      },
    },
    {
      level: 2,
      cost: 450,
      changes: {
        cooldownTicks: 15 * TICK.RATE, // 15 s
        costMultiplier: 0.85, // cooldown reductions also cut the price 15% (rounded down)
      },
    },
  ],
};

/** The Fire kingdom's activatable ability set. */
export const FIRE_ABILITIES: AbilityDefinition[] = [
  FIREBALL,
  SCORCHING_SUN,
  FIRENADO,
  HEAT_WAVE,
  BLAZING_DETERMINATION,
];
