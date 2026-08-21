import { TICK } from "./balance.js";
import type { AbilityDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Love Kingdom ability set — pure data on the shared frameworks. Love plays a
 * social, manipulative game: it borrows resources, redirects damage, and ties
 * enemy fates together rather than simply out-damaging them.
 *
 * Kit:
 *  - Tough Love (basic) — a plain reliable attack, the "Q".
 *  - Cupid's Arrow (med) — moderate damage that marks the target "infatuated":
 *    they lend Love 2 citizens for the duration and feel 20% of whatever
 *    damage Love takes while it lasts.
 *  - BFFS!!! (heavy) — moderate damage to the primary target AND a second,
 *    randomly chosen enemy, then LINKS the two: damage and statuses landing
 *    on either from any source mirror onto the other for the duration.
 *  - Have some Empathy! (utility) — unconditional 100% thorns for a window:
 *    every hit Love takes is dealt right back to the attacker.
 *  - Love Galore (ultimate) — incoming damage is fully negated and instead
 *    heals Love for half of what would have landed, for its duration.
 *
 * Passives are `KINGDOM_PASSIVES.love` (Warm Welcome + Feel the love!).
 * Magnitudes are initial, tunable defaults. Per the current scope, no VFX —
 * every mechanic here is wired to a real engine primitive.
 */

/** Tough Love (basic): the reliable "Q", mirroring every other kingdom's. */
export const TOUGH_LOVE: AbilityDefinition = {
  id: "toughLove",
  name: "Tough Love",
  kind: "attack",
  cost: 68,
  unlockCost: 34,
  cooldownTicks: Math.round(2.45 * TICK.RATE), // 1.75 s
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 254, element: "love" } },
  ],
  upgradePath: [
    { level: 1, cost: 150, changes: { effectParams: [{ amount: 306 }] } },
    {
      level: 2,
      cost: 250,
      changes: {
        cooldownTicks: 44,
        costMultiplier: 0.85,
      },
    },
    { level: 3, cost: 400, changes: { effectParams: [{ amount: 310 }] } },
  ],
};

/**
 * "Infatuated" — Cupid's Arrow's mark. While it lasts the bearer feels a
 * share of whatever damage Love (the applier) takes; the 2 borrowed citizens
 * (see `borrowCitizens` on the cast) travel home automatically on expiry.
 */
export const INFATUATED_STATUS: StatusEffectDefinition = {
  id: "infatuated",
  name: "Infatuated",
  category: "debuff",
  stacking: "refresh",
  bearerTakesPctOfSourceDamage: 0.2,
};

/**
 * Cupid's Arrow (med): moderate damage that marks the victim "infatuated" for
 * 10 seconds — they lend Love 2 citizens for the duration (returned when it
 * expires) and feel 20% of whatever damage Love takes while smitten.
 */
export const CUPIDS_ARROW: AbilityDefinition = {
  id: "cupidsArrow",
  name: "Cupid's Arrow",
  kind: "attack",
  cost: 336,
  unlockCost: 168,
  cooldownTicks: Math.round(7.7 * TICK.RATE), // 7.5 s
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 392, element: "love" } },
    {
      type: "status",
      target: "target",
      params: { status: INFATUATED_STATUS, durationTicks: 10 * TICK.RATE, borrowCitizens: 2 }, // 10 s
    },
  ],
  upgradePath: [
    { level: 1, cost: 200, changes: { effectParams: [{ amount: 490 }] } },
    {
      level: 2,
      cost: 300,
      changes: {
        cooldownTicks: 139,
        costMultiplier: 0.85,
      },
    },
    // Lv4: the crush lingers longer (10 s -> 14 s) — more citizens-time and
    // more shared damage to lean on.
    { level: 3, cost: 400, changes: { effectParams: [null, { durationTicks: 14 * TICK.RATE, borrowCitizens: 2 }] } },
  ],
};

/**
 * "BFFS" — the mutual-fate link. While active, damage AND statuses landing on
 * either linked castle, from any source, mirror onto the other in full.
 */
export const BFFS_LINK_STATUS: StatusEffectDefinition = {
  id: "bffsLink",
  name: "BFFS",
  category: "debuff",
  stacking: "refresh",
};

/**
 * BFFS!!! (heavy): moderate damage to the primary target AND a second,
 * randomly chosen enemy, then links the two castles for 10 seconds — whatever
 * happens to one happens to the other too. The player picks BOTH kingdoms
 * (`secondTarget`): casting with only one selected is rejected up-front with
 * SECOND_TARGET_REQUIRED.
 */
export const BFFS: AbilityDefinition = {
  id: "bffs",
  name: "BFFS!!!",
  kind: "attack",
  cost: 400,
  unlockCost: 200,
  cooldownTicks: 14 * TICK.RATE, // 14 s
  targeting: { mode: "singleEnemy", secondTarget: true },
  effects: [
    {
      type: "linkCastles",
      target: "target",
      params: { amount: 400, element: "love", status: BFFS_LINK_STATUS, durationTicks: 10 * TICK.RATE }, // 10 s
    },
  ],
  upgradePath: [
    { level: 1, cost: 250, changes: { effectParams: [{ amount: 500 }] } },
    {
      level: 2,
      cost: 400,
      changes: {
        cooldownTicks: Math.round(14 * TICK.RATE * 0.9),
        costMultiplier: 0.85,
      },
    },
    // Lv4: the link holds longer (10 s -> 14 s).
    { level: 3, cost: 500, changes: { effectParams: [{ durationTicks: 14 * TICK.RATE }] } },
  ],
};

/**
 * "Empathetic" — Have some Empathy!'s self-buff: unconditional (no chance
 * roll) 100% thorns while active.
 */
export const EMPATHY_STATUS: StatusEffectDefinition = {
  id: "empathetic",
  name: "Empathetic",
  category: "buff",
  stacking: "refresh",
  thornsPct: 1.0,
};

/**
 * Have some Empathy! (utility): for 10 seconds, any damage Love takes is
 * dealt right back to the attacker in full — unconditionally, no chance roll.
 */
export const EMPATHY: AbilityDefinition = {
  id: "empathy",
  name: "Have some Empathy!",
  kind: "utility",
  cost: 200,
  unlockCost: 100,
  cooldownTicks: 20 * TICK.RATE, // 20 s
  targeting: { mode: "self" },
  effects: [
    { type: "status", target: "self", params: { status: EMPATHY_STATUS, durationTicks: 10 * TICK.RATE } }, // 10 s
  ],
  upgradePath: [
    {
      level: 1,
      cost: 300,
      changes: {
        cooldownTicks: Math.round(20 * TICK.RATE * 0.85), // 17 s
        costMultiplier: 0.85,
      },
    },
    // Lv3: the empathy lasts longer (10 s -> 14 s).
    { level: 2, cost: 400, changes: { effectParams: [{ durationTicks: 14 * TICK.RATE }] } },
  ],
};

/**
 * "Love Galore" — the ultimate's self-buff: incoming damage never lands,
 * converted into healing for half its raw amount instead. It plays out in two
 * phases (`revealsBeforeExpiry`): a HIDDEN stealth window where the healing is
 * silent and attackers see phantom damage numbers, then — once the stealth
 * window elapses OR `revealHealThreshold` healing is reached, whichever comes
 * first — it REVEALS and runs a second, fully-visible window of the same length
 * during which all incoming damage shows as healing.
 */
export const LOVE_GALORE_STATUS: StatusEffectDefinition = {
  id: "loveGaloreShield",
  name: "Love Galore",
  category: "buff",
  stacking: "refresh",
  negateDamageHealPct: 0.5,
  revealsBeforeExpiry: true,
};

/**
 * Love Galore (ultimate): incoming damage is fully negated and instead heals
 * Love for half of what would have landed. It stays hidden for 15 seconds (or
 * until 1500 healing), then reveals for another 15 seconds of open healing.
 */
export const LOVE_GALORE: AbilityDefinition = {
  id: "loveGalore",
  name: "Love Galore",
  kind: "ultimate",
  cost: 800,
  unlockCost: 400,
  cooldownTicks: 180 * TICK.RATE, // 180 s
  targeting: { mode: "self" },
  effects: [
    { type: "status", target: "self", params: { status: LOVE_GALORE_STATUS, durationTicks: 15 * TICK.RATE, revealHealThreshold: 1500 } }, // 15 s stealth / 1500 heal
  ],
  upgradePath: [
    // Lv2: each window lasts longer (15 s -> 20 s) and it stays hidden until
    // more healing has been banked (1500 -> 2000).
    { level: 1, cost: 1000, changes: { effectParams: [{ durationTicks: 20 * TICK.RATE, revealHealThreshold: 2000 }] } },
      {
      level: 2,
      cost: 1500,
      changes: {
        cooldownTicks: Math.round(90 * TICK.RATE * 0.85), // 76.5 s
        costMultiplier: 0.85,
      },
    },
  ],
};

/** The Love kingdom's activatable ability set. */
export const LOVE_ABILITIES: AbilityDefinition[] = [
  TOUGH_LOVE,
  CUPIDS_ARROW,
  BFFS,
  EMPATHY,
  LOVE_GALORE,
];
