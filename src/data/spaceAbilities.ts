import { TICK } from "./balance.js";
import type { AbilityDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Space Kingdom ability set — pure data on the shared frameworks. Space is a
 * bully class built around raw offense: three of its abilities feed a shared
 * **Supernova meter** (playerState.supernovaMeter) that its heavy attack spends,
 * firing harder the more it has been charged.
 *
 * Kit:
 *  - Shooting Star (basic) — reliable damage that trickles the meter.
 *  - Saturn's Rings (med) — a ring volley that fills the meter faster.
 *  - Supernova (heavy) — fires at the meter's CURRENT level (you can't pick):
 *    L0 can't fire, L1/L2/L3 escalate damage and, at L2+, may hijack the whole
 *    field onto the victim. Consumes the meter.
 *  - Orion's Belt (utility) — a shield of misses; whiffed attacks feed the meter.
 *  - Black Hole (ultimate) — swallows every attack for a spell, then dumps the
 *    whole pool on the last kingdom that fed it.
 *
 * Per the current scope, only visuals are deferred (except Shooting Star's bolt);
 * every mechanic here is wired to a real engine primitive. Magnitudes are
 * initial, tunable defaults. Passives are `KINGDOM_PASSIVES.space` (Blast off! +
 * Vast Universe).
 */

/**
 * Shooting Star (basic): a straightforward Space attack — the reliable "Q" — that
 * also trickles progress into the Supernova meter every time it lands.
 */
export const SHOOTING_STAR: AbilityDefinition = {
  id: "shootingStar",
  name: "Shooting Star",
  kind: "attack",
  cost: 76,
  unlockCost: 38,
  cooldownTicks: Math.round(1.9 * TICK.RATE), // 2.25 s
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 138, element: "space" } },
    // Feeds the Supernova meter (thresholds 50/150/250 for L1/L2/L3).
    { type: "chargeSupernova", target: "self", params: { supernovaCharge: 25 } },
  ],
  upgradePath: [
    { level: 1, cost: 150, changes: { effectParams: [{ amount: 275 }] } },
    {
      level: 2,
      cost: 250,
      changes: {
        cooldownTicks: 34, // 54 ticks (2.7 s)
        costMultiplier: 0.85,
      },
    },
    { level: 3, cost: 400, changes: { effectParams: [{ amount: 370 }] } },
  ],
};

/**
 * Saturn's Rings (med): a relentless barrage — 9 rings, each slamming the target
 * for 50 (65 upgraded) and feeding 5 Supernova charge, for 450 damage and 45
 * charge per cast. The 9-ring bombardment is a client-side visual; the server
 * applies the aggregate (SATURN_RINGS × per-ring). Fill the meter and Supernova
 * follows.
 */
const SATURN_RINGS = 9;
export const SATURNS_RINGS: AbilityDefinition = {
  id: "saturnsRings",
  name: "Saturn's Rings",
  kind: "attack",
  cost: 296,
  unlockCost: 148,
  cooldownTicks: Math.round(15.4 * TICK.RATE), // 11 s
  targeting: { mode: "singleEnemy" },
  effects: [
    // 9 rings × 50 damage.
    { type: "damage", target: "target", params: { amount: 354, element: "space" } },
    // 9 rings × 5 charge = 45 meter (nearly a full level).
    { type: "chargeSupernova", target: "self", params: { supernovaCharge: SATURN_RINGS * 5 } },
  ],
  upgradePath: [
    // Lv2/Lv3: each ring hits harder (50 -> 60 -> 65 per ring).
    { level: 1, cost: 200, changes: { effectParams: [{ amount: SATURN_RINGS * 60 }] } },
    { level: 2, cost: 300, changes: { effectParams: [{ amount: SATURN_RINGS * 65 }] } },
    {
      level: 3,
      cost: 400,
      changes: {
        cooldownTicks: Math.round(10 * TICK.RATE * 0.9),
        costMultiplier: 0.85,
      },
    },
  ],
};

/**
 * Supernova (heavy): fires at the caster's CURRENT Supernova level — you can't
 * choose the level, only how charged you are when you pull the trigger. L0 can't
 * fire at all (rejected as NO_SUPERNOVA). L1 = heavy damage; L2 = bigger, with a
 * 50% chance to hijack every kingdom onto the victim for a few seconds (no
 * swaps); L3 = biggest, with a guaranteed hijack. Firing empties the meter.
 */
export const SUPERNOVA: AbilityDefinition = {
  id: "supernova",
  name: "Supernova",
  kind: "attack",
  cost: 368,
  unlockCost: 184,
  cooldownTicks: Math.round(8.1 * TICK.RATE), // 13 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "supernovaBlast",
      target: "target",
      params: {
        element: "space",
        // Indexed by level: [L1, L2, L3].
        supernovaDamageByLevel: [500, 1000, 1500],
        // Chance the blast forces every kingdom onto the victim: none at L1,
        // half at L2, certain at L3.
        supernovaRedirectChanceByLevel: [0, 0.5, 1],
        redirectDurationTicks: 5 * TICK.RATE, // 5 s hijack
      },
    },
  ],
  upgradePath: [
    // Lv2: bigger blasts across the board.
    { level: 1, cost: 250, changes: { effectParams: [{ supernovaDamageByLevel: [700, 1300, 1900] }] } },
    {
      level: 2,
      cost: 400,
      changes: {
        cooldownTicks: 157,
        costMultiplier: 0.85,
      },
    },
    // Lv4: the hijack grips longer (5 s -> 7 s).
    { level: 3, cost: 600, changes: { effectParams: [{ redirectDurationTicks: 7 * TICK.RATE }] } },
  ],
};

/**
 * Orion's Belt (the ring of misses): while active, each incoming attack on Space
 * has a chance to miss entirely, and each whiff feeds the Supernova meter.
 */
export const ORIONS_BELT_STATUS: StatusEffectDefinition = {
  id: "orionsBelt",
  name: "Orion's Belt",
  category: "buff",
  stacking: "refresh",
  incomingMissChance: 0.5, // 50% of incoming attacks whiff
  missChargesSupernova: 50, // each whiff = a full level's worth of charge
};

/**
 * Orion's Belt (utility): surrounds Space with a belt that gives all incoming
 * attacks a 50% chance to miss for 10 seconds; every missed attack charges the
 * Supernova meter — so being attacked while belted fuels the counter-punch.
 */
export const ORIONS_BELT: AbilityDefinition = {
  id: "orionsBeltAbility",
  name: "Orion's Belt",
  kind: "utility",
  cost: 200,
  unlockCost: 100,
  cooldownTicks: 20 * TICK.RATE, // 20 s
  targeting: { mode: "self" },
  effects: [
    {
      type: "status",
      target: "self",
      params: { status: ORIONS_BELT_STATUS, durationTicks: 10 * TICK.RATE }, // 10 s
    },
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
    // Lv3: the belt holds longer (10 s -> 14 s).
    { level: 2, cost: 400, changes: { effectParams: [{ durationTicks: 14 * TICK.RATE }] } },
  ],
};

/**
 * Black Hole (ultimate): opens a black hole over the field. For its duration,
 * EVERY attack on the field is swallowed — no damage lands anywhere — and its
 * damage pools inside. When the hole collapses, the entire pool is dealt to a
 * single kingdom: the last one whose attack it absorbed. Feed it and it bites
 * back on whoever kept swinging.
 */
export const BLACK_HOLE: AbilityDefinition = {
  id: "blackHole",
  name: "Black Hole",
  kind: "ultimate",
  cost: 546,
  unlockCost: 273,
  cooldownTicks: Math.round(37.85 * TICK.RATE), // 54 s
  targeting: { mode: "self" },
  effects: [
    { type: "createBlackHole", target: "self", params: { blackHoleDurationTicks: 10 * TICK.RATE } }, // 10 s
  ],
  upgradePath: [
    // Lv2: the hole stays open longer (10 s -> 14 s) — more to swallow.
    { level: 1, cost: 1000, changes: { effectParams: [{ blackHoleDurationTicks: 14 * TICK.RATE }] } },
    {
      level: 2,
      cost: 1500,
      changes: {
        cooldownTicks: 681, // 76.5 s
        costMultiplier: 0.85,
      },
    },
  ],
};

/** The Space kingdom's activatable ability set. */
export const SPACE_ABILITIES: AbilityDefinition[] = [
  SHOOTING_STAR,
  SATURNS_RINGS,
  SUPERNOVA,
  ORIONS_BELT,
  BLACK_HOLE,
];
