import { INSECTS, TICK } from "./balance.js";
import type { AbilityDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Insects Kingdom ability set. The three ATTACKS are designed and interlock
 * around one idea: make the victim unable to fight back cleanly, then punish
 * them for trying.
 *
 *  - Venom Shot (basic) — the reliable "Q", often leaving poison behind.
 *  - Butterflies (medium-heavy) — strips the target's damage reduction AND
 *    sends half of their own attacks wide.
 *  - Infected (heavy) — heavy damage, and for fifteen seconds any attack the
 *    victim FUMBLES rebounds onto them.
 *
 * The last two are built to be used together, and deliberately do nothing for
 * each other in isolation: Infected only ever triggers on a miss, and nothing
 * in the kit causes misses except Butterflies. Landing one and not the other
 * is a wasted setup, which is the decision the pair is for.
 *
 *  - Creepy Crawlers (utility) — three bugs that eat the victim's gold until
 *    they are swatted, two clicks apiece.
 *  - Caprice (ultimate) — a butterfly that takes everyone's aim away for
 *    twenty-five seconds, and makes Insects untargetable while it holds.
 *
 * The kit is complete.
 *
 * Passives are `KINGDOM_PASSIVES.insects` ("Cocoon", "Fruit Fly").
 */

/**
 * Venom Shot's poison. Stacks, so a kingdom that keeps eating the basic attack
 * bleeds progressively harder rather than sitting at a flat rate.
 */
export const VENOM_STATUS: StatusEffectDefinition = {
  id: "venom",
  name: "Venom",
  category: "debuff",
  stacking: "stack",
  maxStacks: 3,
  tickEffects: [{ type: "damage", amount: INSECTS.VENOM_TICK, perStack: true }],
};

/**
 * Butterflies. Two halves, and both of them are about the victim's next twenty
 * seconds rather than about this hit: they take more damage from everyone, and
 * half of their own swings go wide.
 *
 * A coin flip on every attack is punishing by itself — this is the debuff that
 * takes a kingdom out of the fight rather than merely taxing it — and it is
 * also the only thing in the game that makes Infected fire, which turns those
 * whiffs from wasted gold into damage they deal to themselves.
 */
export const BUTTERFLIES_STATUS: StatusEffectDefinition = {
  id: "butterflies",
  name: "Butterflies",
  category: "debuff",
  stacking: "refresh",
  // Damage reduction stripped: expressed as the damage they TAKE going up,
  // which is the same thing and is what the pipeline already understands.
  modifiers: [
    { stat: "damageTaken", op: "mult", value: INSECTS.BUTTERFLIES_DAMAGE_TAKEN },
  ],
  attackMissChance: INSECTS.BUTTERFLIES_MISS_CHANCE,
};

/**
 * Infected. Every attack the victim fumbles comes back around and lands on
 * them instead.
 *
 * Inert by itself — it needs something to be making them miss, and the only
 * thing that does is Butterflies. That is the intended combination, and the
 * reason neither ability reads as complete on its own.
 */
export const INFECTED_STATUS: StatusEffectDefinition = {
  id: "infected",
  name: "Infected",
  category: "debuff",
  stacking: "refresh",
  deflectsMissedAttack: true,
};

/**
 * The bugs themselves. Each one drains on its own account, so the bleed eases
 * with every one the victim swats — swatting the first is worth something
 * immediately rather than only the last one mattering.
 *
 * What it really costs the victim is attention: two clicks per bug, while
 * everything else on their screen carries on without them.
 */
export const CREEPY_CRAWLERS_STATUS: StatusEffectDefinition = {
  id: "creepyCrawlers",
  name: "Creepy Crawlers",
  category: "debuff",
  stacking: "refresh",
  crawlers: {
    count: INSECTS.CRAWLER_COUNT,
    hitsToKill: INSECTS.CRAWLER_HITS_TO_KILL,
    drainPerSecond: INSECTS.CRAWLER_DRAIN_PER_SECOND,
  },
};

/** Venom Shot (basic): the reliable "Q", which often leaves poison behind. */
export const VENOM_SHOT: AbilityDefinition = {
  id: "venomShot",
  name: "Venom Shot",
  kind: "attack",
  cost: 168,
  cooldownTicks: Math.round(3.5 * TICK.RATE), // 2.5 s
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 224, element: "insects" } },
    {
      type: "status",
      target: "target",
      params: {
        status: VENOM_STATUS,
        durationTicks: INSECTS.VENOM_SECONDS * TICK.RATE,
      },
      chance: INSECTS.VENOM_CHANCE,
    },
  ],
  upgradePath: [
    { level: 1, cost: 150, changes: { effectParams: [{ amount: 410 }] } },
    {
      level: 2,
      cost: 250,
      changes: {
        cooldownTicks: Math.round(3 * TICK.RATE * 0.9),
        costMultiplier: 0.85,
      },
    },
    // The poison gets likelier rather than the hit getting bigger — the basic
    // attack is the delivery system, not the damage.
    { level: 3, cost: 400, changes: { effectChances: [null, 0.5] } },
  ],
};

/**
 * Butterflies: a heavy hit that leaves the target both softer and clumsier —
 * they take more damage from everyone for twenty seconds, and their own
 * attacks start missing.
 */
export const BUTTERFLIES: AbilityDefinition = {
  id: "butterflies",
  name: "Butterflies",
  kind: "attack",
  cost: 494,
  cooldownTicks: Math.round(17.35 * TICK.RATE), // 15 s
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 727, element: "insects" } },
    {
      type: "status",
      target: "target",
      params: {
        status: BUTTERFLIES_STATUS,
        durationTicks: INSECTS.BUTTERFLIES_SECONDS * TICK.RATE,
      },
    },
  ],
  upgradePath: [
    { level: 1, cost: 300, changes: { effectParams: [{ amount: 700 }] } },
    {
      level: 2,
      cost: 400,
      changes: {
        cooldownTicks: Math.round(18 * TICK.RATE * 0.9),
        costMultiplier: 0.85,
      },
    },
    // A longer window to land Infected inside.
    {
      level: 3,
      cost: 550,
      changes: { effectParams: [null, { durationTicks: 26 * TICK.RATE }] },
    },
  ],
};

/**
 * Infected: heavy damage, and for fifteen seconds every attack the victim
 * fumbles rebounds onto them.
 *
 * The payoff half of the pair — worth its cost only against a target that is
 * already missing, which in practice means one already carrying Butterflies.
 */
export const INFECTED: AbilityDefinition = {
  id: "infected",
  name: "Infected",
  kind: "attack",
  cost: 532,
  cooldownTicks: Math.round(10.5 * TICK.RATE), // 17.5 s
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 612, element: "insects" } },
    {
      type: "status",
      target: "target",
      params: {
        status: INFECTED_STATUS,
        durationTicks: INSECTS.INFECTED_SECONDS * TICK.RATE,
      },
    },
  ],
  upgradePath: [
    { level: 1, cost: 500, changes: { effectParams: [{ amount: 710 }] } },
    {
      level: 2,
      cost: 600,
      changes: {
        cooldownTicks: Math.round(24 * TICK.RATE * 0.85),
        costMultiplier: 0.85,
      },
    },
    {
      level: 3,
      cost: 800,
      changes: { effectParams: [null, { durationTicks: 20 * TICK.RATE }] },
    },
  ],
};

/**
 * Creepy Crawlers (utility): three bugs sent to eat a kingdom's gold. They keep
 * draining until they are swatted — two clicks each — so what the ability
 * really takes is the victim's attention, not just their treasury.
 *
 * A utility rather than an attack: it deals no damage at all, and a kingdom
 * that ignores it simply pays for the privilege.
 */
export const CREEPY_CRAWLERS: AbilityDefinition = {
  id: "creepyCrawlers",
  name: "Creepy Crawlers",
  kind: "utility",
  cost: 300,
  cooldownTicks: 30 * TICK.RATE, // 30 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "status",
      target: "target",
      params: {
        status: CREEPY_CRAWLERS_STATUS,
        durationTicks: INSECTS.CRAWLER_SECONDS * TICK.RATE,
      },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 350,
      changes: { effectParams: [{ durationTicks: 26 * TICK.RATE }] },
    },
    {
      level: 2,
      cost: 450,
      changes: {
        cooldownTicks: Math.round(30 * TICK.RATE * 0.85),
        costMultiplier: 0.85,
      },
    },
  ],
};

/**
 * Caprice (ultimate): a butterfly holds the middle of the field for
 * twenty-five seconds, and for as long as it does nobody chooses their own
 * fight — every second it re-rolls everyone's target.
 *
 * It deals no damage whatsoever. What it does is remove the one thing every
 * other kingdom's plan depends on: knowing who they are hitting. Insects is
 * exempt and aims freely, and is also untargetable for the duration, so it
 * spends the window as the only kingdom still playing on purpose.
 *
 * See `engine/caprice.ts`.
 */
export const CAPRICE: AbilityDefinition = {
  id: "caprice",
  name: "Caprice",
  kind: "ultimate",
  cost: 735,
  cooldownTicks: Math.round(97.8 * TICK.RATE), // 163 s
  targeting: { mode: "self" },
  effects: [
    {
      type: "spawnCaprice",
      target: "self",
      params: {
        durationTicks: INSECTS.CAPRICE_SECONDS * TICK.RATE,
        scrambleTicks: INSECTS.CAPRICE_SCRAMBLE_SECONDS * TICK.RATE,
      },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 1200,
      changes: { effectParams: [{ durationTicks: 32 * TICK.RATE }] },
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

/** The Insects kingdom's activatable ability set. */
export const INSECTS_ABILITIES: AbilityDefinition[] = [
  VENOM_SHOT,
  BUTTERFLIES,
  INFECTED,
  CREEPY_CRAWLERS,
  CAPRICE,
];
