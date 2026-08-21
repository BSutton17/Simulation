import { TICK } from "./balance.js";
import type { AbilityDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Light Kingdom ability set. The three ATTACKS are designed and interlock
 * around one idea — Light plants a swarm on an enemy and then farms it:
 *
 *  - Light Beam (basic) — the reliable "Q", which hits noticeably harder while
 *    the target is infested.
 *  - Fireflies (med) — plants the swarm. The victim must BUY it off, at a price
 *    scaled to how many citizens they have; a shielded castle repels it
 *    outright. While the swarm is deployed Light cannot buy a shield of its
 *    own, so the pressure runs both ways.
 *  - Illumination (heavy) — heavy damage that also inflates an OUTSTANDING
 *    ransom by 25%. It never plants the swarm, so it is only worth its slot
 *    once Fireflies has landed.
 *
 *  - Flash Bang (utility) — stretches every cooldown ALREADY running, on every
 *    kingdom including Light's own.
 *  - Light Show (ultimate) — a public 3 second warning, then it comes down on
 *    everyone: shielded castles lose the shield, exposed ones eat the hit.
 *
 * The kit is complete.
 *
 * Passives are `KINGDOM_PASSIVES.light` ("Speed of light", "Bright idea").
 * Magnitudes are initial, tunable defaults.
 */

/**
 * "Fireflies" — the swarm Light plants on an enemy castle. It carries no damage
 * of its own; the pressure is entirely economic and positional:
 *  - the bearer can pay `dispelCostPerCitizen × their citizens` to shoo it away
 *    (see `dispelStatus`), so a fat kingdom pays more;
 *  - it never settles on a shielded castle (`repelledByShield`);
 *  - once it HAS settled, the bearer can no longer buy a shield
 *    (`blocksBearerShield`) — so a shield is prevention, never a cure, and
 *    paying the ransom is the only way out;
 *  - Light Beam hits harder against whoever is carrying it.
 *
 * It does not tick down in any meaningful sense — the duration below is far
 * longer than a match, so in practice it sits there until it is paid off.
 */
export const FIREFLIES_STATUS: StatusEffectDefinition = {
  id: "fireflies",
  name: "Fireflies",
  category: "debuff",
  stacking: "refresh",
  dispelCostPerCitizen: 10,
  repelledByShield: true,
  blocksBearerShield: true,
};

/** Effectively "until dispelled" — longer than any match will run. */
export const FIREFLIES_DURATION = 3600 * TICK.RATE; // 1 h

/** Extra damage Light Beam deals to a target carrying the swarm. */
const LIGHT_BEAM_INFESTED_BONUS = 150;

/**
 * Extra damage Illumination deals to a kingdom that is already swarmed. Light's
 * heavy is built around the same idea as its basic: the glare has something to
 * catch on. Larger than Light Beam's bonus because the whole ability is
 * conditional on the swarm being there — the ransom inflation does nothing
 * without one either.
 */
const ILLUMINATION_INFESTED_BONUS = 350;

/** Light Beam (basic): the reliable "Q", worth more once the swarm is out. */
export const LIGHT_BEAM: AbilityDefinition = {
  id: "lightBeam",
  name: "Light Beam",
  kind: "attack",
  cost: 45,
  cooldownTicks: Math.round(3.4 * TICK.RATE), // 2.75 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: {
        amount: 142,
        element: "light",
        bonusDamageIfTargetHasStatus: {
          statusId: FIREFLIES_STATUS.id,
          extraAmount: LIGHT_BEAM_INFESTED_BONUS,
        },
      },
    },
  ],
  upgradePath: [
    { level: 1, cost: 150, changes: { effectParams: [{ amount: 180 }] } },
    {
      level: 2,
      cost: 250,
      changes: {
        cooldownTicks: Math.round(3 * TICK.RATE * 0.9),
        costMultiplier: 0.85,
      },
    },
    // Lv4: the swarm bonus grows rather than the base hit — leaning the kit
    // further into "plant it, then farm it".
    {
      level: 3,
      cost: 400,
      changes: {
        effectParams: [
          {
            bonusDamageIfTargetHasStatus: {
              statusId: FIREFLIES_STATUS.id,
              extraAmount: 250,
            },
          },
        ],
      },
    },
  ],
};

/**
 * Fireflies (med): moderate damage that plants the swarm. A shielded castle
 * shrugs the swarm off (the damage still lands); an unshielded one is stuck
 * paying to be rid of it.
 */
export const FIREFLIES: AbilityDefinition = {
  id: "fireflies",
  name: "Fireflies",
  kind: "attack",
  cost: 153,
  cooldownTicks: Math.round(13.4 * TICK.RATE), // 16.5 s
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 338, element: "light" } },
    {
      type: "status",
      target: "target",
      params: { status: FIREFLIES_STATUS, durationTicks: FIREFLIES_DURATION },
    },
  ],
  upgradePath: [
    { level: 1, cost: 200, changes: { effectParams: [{ amount: 380 }] } },
    {
      level: 2,
      cost: 300,
      changes: {
        cooldownTicks: 219,
        costMultiplier: 0.85,
      },
    },
    // Lv4: a denser swarm — 15 gold per citizen to be rid of instead of 10.
    {
      level: 3,
      cost: 400,
      changes: {
        effectParams: [
          null,
          {
            status: { ...FIREFLIES_STATUS, dispelCostPerCitizen: 15 },
            durationTicks: FIREFLIES_DURATION,
          },
        ],
      },
    },
  ],
};

/**
 * Illumination (heavy): heavy damage, and the glare drives an ALREADY-PRESENT
 * swarm into a frenzy — the victim's outstanding ransom goes up 25%. Casting it
 * on a kingdom with no swarm is just the damage.
 */
export const ILLUMINATION: AbilityDefinition = {
  id: "illumination",
  name: "Illumination",
  kind: "attack",
  cost: 276,
  cooldownTicks: Math.round(21.45 * TICK.RATE), // 20.5 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "damage",
      target: "target",
      params: {
        amount: 545,
        element: "light",
        // Lit up: a swarmed castle takes considerably more, on top of having
        // its ransom inflated below.
        bonusDamageIfTargetHasStatus: {
          statusId: FIREFLIES_STATUS.id,
          extraAmount: ILLUMINATION_INFESTED_BONUS,
        },
      },
    },
    {
      type: "amplifyDispelCost",
      target: "target",
      params: {
        amplifyDispelCost: { statusId: FIREFLIES_STATUS.id, multiplier: 1.25 },
      },
    },
  ],
  upgradePath: [
    // Lv2: the base hit and the swarm bonus both grow.
    {
      level: 1,
      cost: 500,
      changes: {
        effectParams: [
          {
            amount: 706,
            bonusDamageIfTargetHasStatus: {
              statusId: FIREFLIES_STATUS.id,
              extraAmount: 450,
            },
          },
        ],
      },
    },
    {
      level: 2,
      cost: 600,
      changes: {
        cooldownTicks: Math.round(20 * TICK.RATE * 0.85),
        costMultiplier: 0.85,
      },
    },
    // Lv4: the glare bites harder on the ransom (1.25× → 1.5×).
    {
      level: 3,
      cost: 800,
      changes: {
        effectParams: [
          null,
          { amplifyDispelCost: { statusId: FIREFLIES_STATUS.id, multiplier: 1.5 } },
        ],
      },
    },
  ],
};

/**
 * Flash Bang (utility): a blinding pop that stretches every cooldown ALREADY
 * running, on every OPPOSING kingdom. Abilities sitting ready are untouched, so
 * it punishes a field that has just spent its kit and does nothing against one
 * holding everything in reserve.
 *
 * Light is spared: it is the kingdom setting the thing off, so it is the one
 * player in the match who knows to look away.
 */
export const FLASH_BANG: AbilityDefinition = {
  id: "flashBang",
  name: "Flash Bang",
  kind: "utility",
  cost: 150,
  cooldownTicks: 25 * TICK.RATE, // 25 s
  targeting: { mode: "self" },
  effects: [
    {
      type: "cooldownModify",
      target: "allEnemies",
      params: { cooldownModify: { op: "multiply", value: 1.2, target: "all" } },
    },
  ],
  upgradePath: [
    // Lv2: a harsher stretch (20% -> 30%).
    {
      level: 1,
      cost: 250,
      changes: {
        effectParams: [
          { cooldownModify: { op: "multiply", value: 1.3, target: "all" } },
        ],
      },
    },
    {
      level: 2,
      cost: 350,
      changes: {
        cooldownTicks: Math.round(25 * TICK.RATE * 0.85),
        costMultiplier: 0.85,
      },
    },
  ],
};

/**
 * How long the Light Show hangs overhead before it lands.
 *
 * The countdown the field SEES is 3 seconds, but the strike resolves a quarter
 * of a second later. That gap is deliberate grace: a player slamming the shield
 * button as the counter hits zero should make it, rather than losing to the
 * round-trip. Nobody is told about the extra beat — it only ever helps.
 */
export const LIGHT_SHOW_DELAY = Math.round(3.25 * TICK.RATE); // 3.25 s

/**
 * Light Show (ultimate): the sky lights up and, three seconds later, comes
 * down on everyone. The delay is PUBLIC — that window is the whole ability, and
 * it is a race for the shop.
 *
 * Light's kit is built AROUND casting this as often as possible, which is why
 * it hits for less than its peers and comes back far sooner (60 s against the
 * field's 90–210 s). Fireflies exists to serve it: barring the victim from
 * buying a shield is what turns the next Light Show from a tax into a kill.
 * Reading this ability's numbers next to other ultimates in isolation will
 * always make it look cheap — the cooldown IS the kingdom.
 *
 * When it lands, each kingdom is judged on one thing: whether it is behind a
 * shield. A shielded castle loses that shield outright, however much health it
 * had left, and takes nothing — no carry-over. A castle caught in the open eats
 * the whole hit. So the shield is not a damage sponge here, it is a ticket.
 */
export const LIGHT_SHOW: AbilityDefinition = {
  id: "lightShow",
  name: "Light Show",
  kind: "ultimate",
  cost: 577,
  cooldownTicks: Math.round(45.4 * TICK.RATE), // 45.25 s
  targeting: { mode: "self" },
  effects: [
    {
      type: "delayedStrike",
      target: "self",
      params: {
        amount: 2000,
        element: "light",
        delayTicks: LIGHT_SHOW_DELAY,
        breaksShields: true,
      },
    },
  ],
  upgradePath: [
    { level: 1, cost: 1000, changes: { effectParams: [{ amount: 2500 }] } },
    {
      level: 2,
      cost: 1500,
      changes: {
        cooldownTicks: 817, // 60 s -> 51 s
        costMultiplier: 0.85,
      },
    },
  ],
};

/** The Light kingdom's activatable ability set. */
export const LIGHT_ABILITIES: AbilityDefinition[] = [
  LIGHT_BEAM,
  FIREFLIES,
  ILLUMINATION,
  FLASH_BANG,
  LIGHT_SHOW,
];
