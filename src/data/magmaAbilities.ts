import { MAGMA, TICK } from "./balance.js";
import type { AbilityDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Magma Kingdom ability set. Magma is a burn kingdom that plays the long game:
 * its damage arrives over time, and its passive "Hotter fire" sends all of it
 * straight through shields, so buying a wall never buys a reprieve.
 *
 *  - Lava Punch (basic) — the reliable "Q", with a real chance of leaving a
 *    burn behind. Cheap pressure that stacks up over a match.
 *  - Eruption (med) — heavy damage AND a guaranteed burn.
 *  - Floor is Lava (utility) — sets the whole battlefield alight, so EVERY
 *    burn on it hits harder. Deliberately untargeted: it fans other kingdoms'
 *    fires too, and burns on Magma itself. Cast it when the field is already
 *    smouldering, not to open with.
 *
 *  - Smoke Screen (utility) — blinds and singes everyone aiming at Magma.
 *  - The End of the World (ultimate) — a volcano the whole field must break.
 *
 * The kit is complete.
 *
 * NOTE ON SHAPE: most kingdoms run three attacks. Magma runs two, plus two
 * support abilities, because both of its support slots are offensive in intent
 * — Floor is Lava fans burns, Smoke Screen punishes attention. Neither deals
 * its damage the way an attack does, so neither is typed as one.
 *
 * Passives are `KINGDOM_PASSIVES.magma` ("Hotter fire", "Hot ash").
 */

/**
 * Magma's own burn. Marked `isBurn` so "Floor is Lava" fans it, and it pierces
 * shields through the "Hotter fire" passive rather than a flag here — that
 * passive follows the INFLICTER, so any burn Magma lands goes through.
 */
export const MAGMA_BURN_STATUS: StatusEffectDefinition = {
  id: "magmaBurn",
  name: "Molten",
  category: "debuff",
  isBurn: true,
  stacking: "stack",
  maxStacks: 3,
  tickEffects: [{ type: "damage", amount: 9, perStack: true }],
  // Through a shield it still burns, but for less — see SHIELDED_BURN_TICK.
  shieldedTickAmount: MAGMA.SHIELDED_BURN_TICK,
};

/** How long a Magma burn lasts. */
export const MAGMA_BURN_DURATION = 6 * TICK.RATE; // 6 s

/** Lava Punch (basic): the reliable "Q", and a coin-flip-ish chance of a burn. */
export const LAVA_PUNCH: AbilityDefinition = {
  id: "lavaPunch",
  name: "Lava Punch",
  kind: "attack",
  cost: 100,
  cooldownTicks: 3.5 * TICK.RATE, // 3.5 s
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 250, element: "magma" } },
    {
      type: "status",
      target: "target",
      chance: MAGMA.LAVA_PUNCH_BURN_CHANCE,
      params: { status: MAGMA_BURN_STATUS, durationTicks: MAGMA_BURN_DURATION },
    },
  ],
  upgradePath: [
    { level: 1, cost: 150, changes: { effectParams: [{ amount: 300 }] } },
    {
      level: 2,
      cost: 250,
      changes: {
        cooldownTicks: Math.round(3 * TICK.RATE * 0.9),
        costMultiplier: 0.85,
      },
    },
    { level: 3, cost: 400, changes: { effectParams: [{ amount: 400 }] } },
  ],
};

/** Eruption (medium): the big hit. It sets a burn only occasionally — lighting
 *  people reliably is Lava Punch's job, not this one's. */
export const ERUPTION: AbilityDefinition = {
  id: "eruption",
  name: "Eruption",
  kind: "attack",
  cost: 230,
  cooldownTicks: 10.75 * TICK.RATE, // 10.75 s
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 310, element: "magma" } },
    {
      type: "status",
      target: "target",
      params: { status: MAGMA_BURN_STATUS, durationTicks: MAGMA_BURN_DURATION },
      chance: MAGMA.ERUPTION_BURN_CHANCE,
    },
  ],
  upgradePath: [
    { level: 1, cost: 200, changes: { effectParams: [{ amount: 345 }] } },
    {
      level: 2,
      cost: 300,
      changes: {
        cooldownTicks: Math.round(10 * TICK.RATE * 0.9),
        costMultiplier: 0.85,
      },
    },
    { level: 3, cost: 400, changes: { effectParams: [{ amount: 415 }] } },
  ],
};

/**
 * Smoke Screen's blind. Reuses the same `vision: fog` treatment as Air's Thick
 * Fog — it is the same experience for the victim, so it should look and behave
 * the same rather than being a second bespoke blindness.
 */
export const SMOKE_SCREEN_STATUS: StatusEffectDefinition = {
  id: "smokeScreen",
  name: "Smoke Screen",
  category: "debuff",
  stacking: "refresh",
};

/**
 * Magma's own footing while "Floor is Lava" holds. Runs on the same clock as
 * the lava, and lifts every attack Magma makes — see FLOOR_IS_LAVA.
 */
export const MOLTEN_GROUND_STATUS: StatusEffectDefinition = {
  id: "moltenGround",
  name: "Molten Ground",
  category: "buff",
  stacking: "refresh",
  modifiers: [
    { stat: "damage", op: "mult", value: MAGMA.LAVA_FLOOR_ATTACK_MULTIPLIER },
  ],
};

/**
 * Floor is Lava (utility): the whole battlefield goes molten and every burn on
 * it burns harder — Fire's, Kitsune's foxfire, and Magma's own alike.
 *
 * It also sharpens Magma's own attacks while it holds (MOLTEN_GROUND_STATUS).
 *
 * Untargeted on purpose. It is weather, not an attack: the burn multiplier
 * helps any kingdom running a burn, and it fans burns that are on MAGMA too.
 * The decision is when to light it, not who to point it at.
 */
export const FLOOR_IS_LAVA: AbilityDefinition = {
  id: "floorIsLava",
  name: "Floor is Lava",
  kind: "utility",
  cost: 325,
  cooldownTicks: 33.25 * TICK.RATE, // 33.25 s
  targeting: { mode: "self" },
  effects: [
    {
      type: "lavaFloor",
      target: "self",
      params: {
        burnMultiplier: MAGMA.LAVA_FLOOR_BURN_MULTIPLIER,
        durationTicks: MAGMA.LAVA_FLOOR_DURATION_SECONDS * TICK.RATE,
      },
    },
    {
      // Magma fights better on its own ground: a flat lift to EVERY attack it
      // makes while the field is molten. This is what stops the ability being
      // purely altruistic — the burn multiplier helps any kingdom running a
      // burn, but the attack lift is Magma's alone.
      type: "status",
      target: "self",
      params: {
        status: MOLTEN_GROUND_STATUS,
        durationTicks: MAGMA.LAVA_FLOOR_DURATION_SECONDS * TICK.RATE,
      },
    },
  ],
  upgradePath: [
    { level: 1, cost: 500, changes: { effectParams: [{ burnMultiplier: 1.75 }] } },
    {
      level: 2,
      cost: 600,
      changes: {
        cooldownTicks: Math.round(20 * TICK.RATE * 0.85),
        costMultiplier: 0.85,
      },
    },
    {
      level: 3,
      cost: 800,
      changes: {
        // Both entries: the self-buff runs on the lava's clock, so extending
        // one without the other would leave Magma buffed on cold ground.
        effectParams: [
          { durationTicks: 270}, // 20 s -> 26 s
          { durationTicks: 26 * TICK.RATE },
        ],
      },
    },
  ],
};

/**
 * The End of the World (ultimate): a volcano in the middle of the battlefield
 * with 1000 health per living kingdom and twenty seconds on the clock.
 *
 * Everyone but Magma has to swing at it, and the eruption is scored per
 * kingdom: each one takes `5000 - what they personally dealt to it`. That makes
 * it a prisoner's dilemma rather than a raid — chipping at the volcano is time
 * not spent attacking each other, and a kingdom that sits it out is the one
 * that gets hurt most. Magma just watches.
 *
 * See `engine/volcano.ts`.
 */
export const THE_END_OF_THE_WORLD: AbilityDefinition = {
  id: "theEndOfTheWorld",
  name: "The End of the World",
  kind: "ultimate",
  cost: 1095,
  cooldownTicks: 92.75 * TICK.RATE, // 92.75 s
  targeting: { mode: "self" },
  effects: [
    {
      type: "spawnVolcano",
      target: "self",
      params: { durationTicks: MAGMA.VOLCANO_TIMER_SECONDS * TICK.RATE },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 1200,
      // A shorter clock: the same wall, less time to bring it down.
      changes: { effectParams: [{ durationTicks: 15 * TICK.RATE }] },
    },
    {
      level: 2,
      cost: 1600,
      changes: {
        cooldownTicks: Math.round(120 * TICK.RATE * 0.85),
        costMultiplier: 0.85,
      },
    },
  ],
};

/**
 * Smoke Screen (utility): everyone currently aiming at Magma is blinded and
 * singed. Untargeted — the victims pick themselves by pointing at Magma, which
 * pairs with "Hot ash": aiming at Magma already costs you extra damage, and
 * this is the punish that makes looking away worth it.
 */
export const SMOKE_SCREEN: AbilityDefinition = {
  id: "smokeScreen",
  name: "Smoke Screen",
  kind: "utility",
  cost: 180,
  cooldownTicks: 26 * TICK.RATE, // 26 s
  targeting: { mode: "self" },
  effects: [
    {
      type: "smokeScreen",
      target: "self",
      params: {
        targeterDamage: MAGMA.SMOKE_SCREEN_DAMAGE,
        status: SMOKE_SCREEN_STATUS,
        durationTicks: MAGMA.SMOKE_SCREEN_BLIND_SECONDS * TICK.RATE,
        vision: { type: "fog", durationTicks: MAGMA.SMOKE_SCREEN_BLIND_SECONDS * TICK.RATE },
      },
    },
  ],
  upgradePath: [
    { level: 1, cost: 300, changes: { effectParams: [{ targeterDamage: 300 }] } },
    {
      level: 2,
      cost: 450,
      changes: {
        cooldownTicks: Math.round(25 * TICK.RATE * 0.85),
        costMultiplier: 0.85,
      },
    },
  ],
};

/** The Magma kingdom's activatable ability set. */
export const MAGMA_ABILITIES: AbilityDefinition[] = [
  LAVA_PUNCH,
  ERUPTION,
  FLOOR_IS_LAVA,
  SMOKE_SCREEN,
  THE_END_OF_THE_WORLD,
];
