import { KITSUNE, TICK } from "./balance.js";
import type { AbilityDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Kitsune Kingdom ability set. Kitsune plays a long game: everything it does
 * feeds the Ancient Memory meter ("Swift Tails"), and its two designed attacks
 * are both about making the victim SPEND rather than about raw damage.
 *
 *  - Fox Swipe (basic) — the reliable "Q", with a flat top-up to Memory.
 *  - Fox Fire (med) — a burn that grows hotter every time the victim attacks.
 *    Punishes an aggressive kingdom for doing the thing it wants to do, and
 *    stacks, so a second volley on a busy target is brutal.
 *  - Old Friends (heavy) — foxes. Against a shield they tear a fixed chunk out
 *    of it and leave, with nothing carrying over. Against an EXPOSED kingdom
 *    they move in and stay: no duration, no dispel, gnawing away and feeding
 *    Kitsune's Memory until the victim buys a shield to drive them off.
 *
 *  - Azure Guidance (utility) — Memory fills twice as fast for a window.
 *  - Kitsune Rush (ultimate) — fifteen seconds at double speed. Not bought:
 *    it fires when the Memory meter is full and empties it.
 *
 * Passives are `KINGDOM_PASSIVES.kitsune` ("Swift Tails", "Three tailed fox").
 */

/** Ancient Memory granted by a single Fox Swipe, on top of the share of damage
 *  "Swift Tails" already credits. */
export const FOX_SWIPE_MEMORY = 10;

/**
 * "Old Friends" against a SHIELDED kingdom: the BASE bite taken out of the
 * shield before modifiers. It runs the ordinary damage pipeline (Sharper
 * Swords, Sharper Axes, kingdom passives, Besieged, crits), so what actually
 * lands is usually more than this — which is why nothing user-facing quotes the
 * figure. None of it carries over to castle HP, so it is wasted on a fresh
 * shield and devastating to a worn one.
 */
export const OLD_FRIENDS_SHIELD_DAMAGE = 750;

/** Fox Fire's DoT, per tick, before intensification. */
const FOX_FIRE_TICK = 5;

/** How much hotter Fox Fire burns for each attack its bearer makes. */
export const FOX_FIRE_INTENSIFY = 1.15;

/** How long Fox Fire burns. */
export const FOX_FIRE_DURATION = 6 * TICK.RATE; // 6 s

/**
 * The foxes themselves. Deliberately has NO duration: `endsOnShieldPurchase`
 * is the only exit, so an exposed kingdom either buys a shield or bleeds. Every
 * tick they are left alone feeds Kitsune.
 */
export const OLD_FRIENDS_STATUS: StatusEffectDefinition = {
  id: "oldFriends",
  name: "Old Friends",
  category: "debuff",
  stacking: "refresh",
  tickEffects: [{ type: "damage", amount: 3 }],
  endsOnShieldPurchase: true,
  chargesSourceMemoryPerTick: 1.5,
};

/**
 * Fox Fire. Stacks, and each stack burns hotter every time the BEARER attacks —
 * so the cost of the burn is set by how much the victim wants to keep playing.
 */
export const FOX_FIRE_STATUS: StatusEffectDefinition = {
  id: "foxFire",
  name: "Fox Fire",
  category: "debuff",
  // Foxfire is still fire: Magma's "Floor is Lava" fans it like any other burn.
  isBurn: true,
  stacking: "stack",
  maxStacks: 5,
  tickEffects: [{ type: "damage", amount: FOX_FIRE_TICK, perStack: true }],
  intensifiesOnBearerAttack: FOX_FIRE_INTENSIFY,
};

/** Azure Guidance: Ancient Memory accrues at double speed while it holds. */
export const AZURE_GUIDANCE_STATUS: StatusEffectDefinition = {
  id: "azureGuidance",
  name: "Azure Guidance",
  category: "buff",
  stacking: "refresh",
  modifiers: [
    {
      stat: "memoryGain",
      op: "mult",
      value: KITSUNE.AZURE_GUIDANCE_MULTIPLIER,
    },
  ],
};

/**
 * Kitsune Rush: for fifteen seconds everything happens twice as fast. Cooldowns
 * run at double rate — including ones already counting down — and gold
 * production doubles.
 */
export const KITSUNE_RUSH_STATUS: StatusEffectDefinition = {
  id: "kitsuneRush",
  name: "Kitsune Rush",
  category: "buff",
  stacking: "refresh",
  modifiers: [
    { stat: "cooldownRate", op: "mult", value: KITSUNE.RUSH_COOLDOWN_RATE },
    { stat: "income", op: "mult", value: KITSUNE.RUSH_INCOME_MULTIPLIER },
  ],
};

/** Fox Swipe (basic): the reliable "Q", and a steady drip into Memory. */
export const FOX_SWIPE: AbilityDefinition = {
  id: "foxSwipe",
  name: "Fox Swipe",
  kind: "attack",
  cost: 100,
  cooldownTicks: 3 * TICK.RATE, // 3 s
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 250, element: "kitsune" } },
    // A flat top-up, on top of the damage share "Swift Tails" already credits.
    { type: "chargeMemory", target: "self", params: { memoryCharge: FOX_SWIPE_MEMORY } },
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

/**
 * Fox Fire (medium): an enchanting volley that leaves a burn behind. The burn
 * intensifies every time the victim attacks, so it taxes exactly the kingdom
 * that refuses to sit still, and it stacks.
 */
export const FOX_FIRE: AbilityDefinition = {
  id: "foxFire",
  name: "Fox Fire",
  kind: "attack",
  cost: 250,
  cooldownTicks: 12 * TICK.RATE, // 12 s
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 250, element: "kitsune" } },
    {
      type: "status",
      target: "target",
      params: { status: FOX_FIRE_STATUS, durationTicks: FOX_FIRE_DURATION },
    },
    { type: "chargeMemory", target: "self", params: { memoryCharge: 25 } },
  ],
  upgradePath: [
    { level: 1, cost: 200, changes: { effectParams: [{ amount: 350 }] } },
    {
      level: 2,
      cost: 300,
      changes: {
        cooldownTicks: Math.round(10 * TICK.RATE * 0.9),
        costMultiplier: 0.85,
      },
    },
    { level: 3, cost: 400, changes: { effectParams: [{ amount: 600 }] } },
  ],
};

/**
 * Old Friends (heavy): an army of foxes. What they do depends entirely on what
 * they find — see the `foxSiege` effect. Against a shield: a fixed bite out of
 * it, nothing carried over. Against bare walls: they stay until a shield drives
 * them off, and feed Kitsune the whole time.
 */
export const OLD_FRIENDS: AbilityDefinition = {
  id: "oldFriends",
  name: "Old Friends",
  kind: "attack",
  cost: 500,
  cooldownTicks: 35 * TICK.RATE, // 35 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "foxSiege",
      target: "target",
      params: {
        element: "kitsune",
        shieldOnlyAmount: OLD_FRIENDS_SHIELD_DAMAGE,
        status: OLD_FRIENDS_STATUS,
        durationTicks: 0, // no clock: only a shield ends it
      },
    },
  ],
  upgradePath: [
    { level: 1, cost: 500, changes: { effectParams: [{ shieldOnlyAmount: 1250 }] } },
    {
      level: 2,
      cost: 600,
      changes: {
        cooldownTicks: Math.round(20 * TICK.RATE * 0.85),
        costMultiplier: 0.85,
      },
    },
    { level: 3, cost: 800, changes: { effectParams: [{ shieldOnlyAmount: 1500 }] } },
  ],
};

/**
 * Azure Guidance (utility): Ancient Memory fills twice as fast for a short
 * window. It brings Kitsune Rush forward rather than doing anything on its own,
 * which makes when to cast it the whole decision — early, to shorten the wait,
 * or during a fight when attacks are already feeding the meter hardest.
 */
export const AZURE_GUIDANCE: AbilityDefinition = {
  id: "azureGuidance",
  name: "Azure Guidance",
  kind: "utility",
  cost: 150,
  cooldownTicks: 30 * TICK.RATE, // 30 s
  targeting: { mode: "self" },
  effects: [
    {
      type: "status",
      target: "self",
      params: {
        status: AZURE_GUIDANCE_STATUS,
        durationTicks: KITSUNE.AZURE_GUIDANCE_DURATION_SECONDS * TICK.RATE,
      },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 200,
      changes: { effectParams: [{ durationTicks: 18 * TICK.RATE }] },
    },
    {
      level: 2,
      cost: 350,
      changes: {
        cooldownTicks: Math.round(30 * TICK.RATE * 0.85),
        costMultiplier: 0.85,
      },
    },
  ],
};

/**
 * Kitsune Rush (ultimate): fifteen seconds at double speed — every cooldown
 * runs twice as fast and gold production doubles.
 *
 * It is NOT bought. Gold cannot bring it forward at all: the only currency is
 * Ancient Memory, and it fires the moment the meter is full and empties it. A
 * Kitsune doing nothing whatsoever gets one every three minutes; playing well
 * is what makes that number smaller.
 */
export const KITSUNE_RUSH: AbilityDefinition = {
  id: "kitsuneRush",
  name: "Kitsune Rush",
  kind: "ultimate",
  // Free to CAST by design — Memory is the price, so gold can never bring it
  // forward (see the `memoryFull` gate in `activateAbilityInner`). It still has
  // to be unlocked once like any other ultimate, which the derived
  // `cost × 0.5` cannot express for a zero-cost ability.
  cost: 0,
  unlockCost: 500,
  cooldownTicks: 0,
  targeting: { mode: "self" },
  effects: [
    {
      type: "status",
      target: "self",
      params: {
        status: KITSUNE_RUSH_STATUS,
        durationTicks: KITSUNE.RUSH_DURATION_SECONDS * TICK.RATE,
      },
    },
    // Emptying the meter IS the cost, so it is an effect rather than a price.
    { type: "spendMemory", target: "self", params: {} },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 1000,
      changes: { effectParams: [{ durationTicks: 20 * TICK.RATE }] },
    },
  ],
};

/** The Kitsune kingdom's activatable ability set. */
export const KITSUNE_ABILITIES: AbilityDefinition[] = [
  FOX_SWIPE,
  FOX_FIRE,
  OLD_FRIENDS,
  AZURE_GUIDANCE,
  KITSUNE_RUSH,
];
