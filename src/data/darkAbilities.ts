import { TICK } from "./balance.js";
import type { AbilityDefinition } from "../engine/abilities.js";
import type { StatusEffectDefinition } from "../engine/status.js";

/**
 * Dark Kingdom ability set. Dark plays a game of pressure and punishment: it
 * profits from being hit, and it makes its victims lose either way.
 *
 *  - Shadow Strike (basic) — the reliable "Q".
 *  - Yin and Yang (med) — a rigged wager. Dark picks the side it is punishing;
 *    the victim is damaged whichever way they go, just less if they read Dark
 *    right. There is no clean escape, only a cheaper one.
 *  - Unlimited Rage (heavy) — a meter that fills with every point of damage
 *    Dark absorbs. Unusable until completely full, then it returns everything
 *    at once and leaves the victim blind.
 *  - Never-ending Nightmare (utility) — strips a kingdom back to its opening
 *    move: nothing but their basic attack for their next few attacks.
 *  - Infinitum Tenebrae (ultimate) — thirty seconds in which Dark's attacks
 *    reach three kingdoms at once at FULL damage each, hit harder, and blind
 *    everyone they touch.
 *
 * The kit is complete.
 *
 * Passives are `KINGDOM_PASSIVES.dark` ("Night terrors", "Black Magic").
 * Magnitudes are initial, tunable defaults. No VFX yet.
 */

/**
 * "Night terrors" — Dark's retaliation mark (a passive, not part of the kit
 * below). Applied to whoever attacks Dark: purely a client-side blackout of the
 * bearer's screen, so it carries no engine effects — the value is that the
 * attacker briefly cannot see the battlefield. Unlimited Rage reuses it to
 * blind its victim.
 */
export const DARKENED_STATUS: StatusEffectDefinition = {
  id: "darkened",
  name: "Night Terrors",
  category: "debuff",
  stacking: "refresh",
};

/** How long a Night Terrors blackout lasts. */
export const DARKENED_DURATION = 4 * TICK.RATE; // 4 s

/** How long Unlimited Rage leaves its victim in the dark — far longer than the
 *  passive's flicker, because this one is earned. */
export const RAGE_BLIND_DURATION = 8 * TICK.RATE; // 8 s

/** Shadow Strike (basic): the reliable "Q". */
export const SHADOW_STRIKE: AbilityDefinition = {
  id: "shadowStrike",
  name: "Shadow Strike",
  kind: "attack",
  cost: 100,
  cooldownTicks: 3 * TICK.RATE, // 3 s
  targeting: { mode: "singleEnemy" },
  effects: [
    { type: "damage", target: "target", params: { amount: 250, element: "dark" } },
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
 * "Yin and Yang" — the wager laid on the victim. The side being punished
 * (`wagerMode`) and the two prices are set on the instance at cast time; the
 * status itself is inert until it settles.
 */
export const YIN_YANG_STATUS: StatusEffectDefinition = {
  id: "yinYang",
  name: "Yin and Yang",
  category: "debuff",
  stacking: "refresh",
};

/** How long the victim has to make their move. */
export const YIN_YANG_DURATION = 12 * TICK.RATE; // 12 s

/**
 * Yin and Yang (med): Dark calls a side, and the victim is caught either way.
 *
 *  - "yin" punishes BUYING a citizen during the window;
 *  - "yang" punishes NOT buying one.
 *
 * Guessing right does not save them — it halves the bill. The wager settles the
 * instant they hire, or when the window closes if they never do.
 */
export const YIN_AND_YANG: AbilityDefinition = {
  id: "yinAndYang",
  name: "Yin and Yang",
  kind: "attack",
  cost: 300,
  cooldownTicks: 18 * TICK.RATE, // 18 s
  targeting: { mode: "singleEnemy", choices: ["yin", "yang"] },
  effects: [
    {
      type: "yinYangWager",
      target: "target",
      params: {
        status: YIN_YANG_STATUS,
        durationTicks: YIN_YANG_DURATION,
        amount: 700, // guessed wrong
        halfAmount: 350, // guessed right
      },
    },
  ],
  upgradePath: [
    {
      level: 1,
      cost: 300,
      changes: { effectParams: [{ amount: 900, halfAmount: 450 }] },
    },
    {
      level: 2,
      cost: 400,
      changes: {
        cooldownTicks: Math.round(18 * TICK.RATE * 0.9),
        costMultiplier: 0.85,
      },
    },
    // Lv4: a longer window to sweat in, and a heavier bill.
    {
      level: 3,
      cost: 600,
      changes: {
        effectParams: [
          { durationTicks: 16 * TICK.RATE, amount: 1200, halfAmount: 600 },
        ],
      },
    },
  ],
};

/**
 * Unlimited Rage (heavy attack): every point of damage Dark has absorbed,
 * returned at once. The meter fills purely from punishment taken (see
 * `applyDamage`), cannot be cast below full, and empties on use — so it is not
 * a cooldown to wait out but a debt the field builds up itself. The victim is
 * left blind.
 */
export const UNLIMITED_RAGE: AbilityDefinition = {
  id: "unlimitedRage",
  name: "Unlimited Rage",
  kind: "attack",
  cost: 600,
  cooldownTicks: 60 * TICK.RATE, // 60 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "rageBlast",
      target: "target",
      params: {
        amount: 1500,
        element: "dark",
        status: DARKENED_STATUS,
        durationTicks: RAGE_BLIND_DURATION,
      },
    },
  ],
  upgradePath: [
    { level: 1, cost: 1000, changes: { effectParams: [{ amount: 1800 }] } },
    {
      level: 2,
      cost: 1500,
      changes: {
        cooldownTicks: Math.round(60 * TICK.RATE * 0.85),
        costMultiplier: 0.85,
      },
    },
  ],
};

/**
 * "Never-ending nightmare" — the lock itself. While it holds, the bearer may
 * cast nothing offensive but their kingdom's basic attack; utilities stay open
 * so they can still shore up their defences. It lifts after they have thrown
 * `basicAttackLimit` attacks, or when the window closes, whichever comes first.
 */
export const NIGHTMARE_STATUS: StatusEffectDefinition = {
  id: "neverEndingNightmare",
  name: "Never-ending Nightmare",
  category: "debuff",
  stacking: "refresh",
  basicAttacksOnly: true,
  basicAttackLimit: 3,
};

/**
 * A backstop on the lock so a victim who simply stops attacking cannot carry it
 * all match. The three-attack allowance is the real limit.
 */
export const NIGHTMARE_DURATION = 45 * TICK.RATE; // 45 s

/**
 * Never-ending nightmare (utility): strip a kingdom back to its opening move.
 * For their next three attacks they may cast nothing but their basic — no
 * medium, no heavy, no ultimate. Everything they had been saving has to wait.
 */
export const NEVER_ENDING_NIGHTMARE: AbilityDefinition = {
  id: "neverEndingNightmare",
  name: "Never-ending Nightmare",
  kind: "utility",
  cost: 250,
  cooldownTicks: 30 * TICK.RATE, // 30 s
  targeting: { mode: "singleEnemy" },
  effects: [
    {
      type: "status",
      target: "target",
      params: { status: NIGHTMARE_STATUS, durationTicks: NIGHTMARE_DURATION },
    },
  ],
  upgradePath: [
    // Lv2: four attacks of enforced simplicity instead of three.
    {
      level: 1,
      cost: 350,
      changes: {
        effectParams: [
          {
            status: { ...NIGHTMARE_STATUS, basicAttackLimit: 4 },
            durationTicks: NIGHTMARE_DURATION,
          },
        ],
      },
    },
    {
      level: 2,
      cost: 500,
      changes: {
        cooldownTicks: Math.round(30 * TICK.RATE * 0.85),
        costMultiplier: 0.85,
      },
    },
  ],
};

/** How long Infinitum tenebrae's darkness holds the field. */
export const TENEBRAE_DURATION = 15 * TICK.RATE; // 15 s

/**
 * "Infinitum tenebrae" — the ultimate's self-buff. For its window Dark's
 * attacks reach three kingdoms at once WITHOUT dividing their damage (unlike
 * Air, which spreads), hit harder, and leave every victim's screen dark.
 */
export const TENEBRAE_STATUS: StatusEffectDefinition = {
  id: "infinitumTenebrae",
  name: "Infinitum Tenebrae",
  category: "buff",
  stacking: "refresh",
  grantsMultiTarget: 3,
  noDamageSpread: true,
  attackInflicts: { status: DARKENED_STATUS, durationTicks: DARKENED_DURATION },
  modifiers: [{ stat: "damage", op: "mult", value: 1.3 }],
};

/**
 * Infinitum tenebrae (ultimate): thirty seconds of endless dark. Every attack
 * Dark makes can name up to three kingdoms and lands on each in FULL, hits 30%
 * harder, and blinds whoever it touches. It buffs nothing but Dark's own
 * attacks, so its value is entirely in what Dark does with the window.
 */
export const INFINITUM_TENEBRAE: AbilityDefinition = {
  id: "infinitumTenebrae",
  name: "Infinitum Tenebrae",
  kind: "ultimate",
  cost: 900,
  cooldownTicks: 120 * TICK.RATE, // 120 s
  targeting: { mode: "self" },
  effects: [
    {
      type: "status",
      target: "self",
      params: { status: TENEBRAE_STATUS, durationTicks: TENEBRAE_DURATION },
    },
  ],
  upgradePath: [
    // Lv2: the dark lasts longer (30 s -> 40 s).
    {
      level: 1,
      cost: 1200,
      changes: {
        effectParams: [
          { status: TENEBRAE_STATUS, durationTicks: 40 * TICK.RATE },
        ],
      },
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

/** The Dark kingdom's activatable ability set. */
export const DARK_ABILITIES: AbilityDefinition[] = [
  SHADOW_STRIKE,
  YIN_AND_YANG,
  UNLIMITED_RAGE,
  NEVER_ENDING_NIGHTMARE,
  INFINITUM_TENEBRAE,
];
