import type { PersonalityProfile } from "./personality.js";

/**
 * AI personalities (ticket #206) — pure data consumed by the ONE generic
 * decision engine (personality.ts). Each profile shapes target selection,
 * ability usage, upgrades, economy purchases, repairs, shields, and ultimate
 * timing purely through thresholds and priorities; there is no per-personality
 * code and no kingdom-specific knowledge anywhere.
 */

/** All-out pressure: casts as soon as anything is affordable, targets the
 *  weakest castle to force eliminations, invests little in anything else. */
export const AGGRESSIVE: PersonalityProfile = {
  name: "aggressive",
  spendPriority: ["cast", "abilities", "economy", "defense"],
  actEveryTicks: 5,
  chaos: 0,
  patience: 0, // pure tempo: never hold gold, always cast the best affordable play
  targeting: { strategy: "lowestHp" },
  economy: { citizenBudgetFactor: 6, maxCitizens: 14, savingsFloor: 0 },
  defense: {
    repairHpFraction: 0.15,
    shieldBudgetFactor: 8,
    emergencyHpFraction: 0.08,
  },
  offense: {
    unlockBudgetFactor: 1,
    upgradeBudgetFactor: 1.5,
    castBudgetFactor: 1,
    preferKinds: ["attack", "ultimate", "utility"],
  },
  ultimate: { targetHpFraction: 1, selfHpFraction: 0.8 },
};

/** Turtle: guards its castle first — early shields, eager repairs, a deep
 *  gold reserve — and only attacks with what is left over. */
export const DEFENSIVE: PersonalityProfile = {
  name: "defensive",
  spendPriority: ["defense", "economy", "abilities", "cast"],
  actEveryTicks: 5,
  chaos: 0,
  patience: 0.5, // will wait for a stronger option when one is close
  targeting: { strategy: "strongest" },
  economy: { citizenBudgetFactor: 4, maxCitizens: 18, savingsFloor: 200 },
  defense: {
    repairHpFraction: 0.65,
    shieldBudgetFactor: 1,
    emergencyHpFraction: 0.4,
  },
  offense: {
    unlockBudgetFactor: 2.5,
    upgradeBudgetFactor: 3,
    castBudgetFactor: 2.5,
    preferKinds: ["utility", "attack", "ultimate"],
  },
  ultimate: { targetHpFraction: 0.6, selfHpFraction: 0.55 },
};

/** Tycoon: citizens before swords. Builds the largest economy on the field,
 *  spends on violence only from surplus, and strangles rich rivals. */
export const ECONOMIC: PersonalityProfile = {
  name: "economic",
  spendPriority: ["economy", "defense", "abilities", "cast"],
  actEveryTicks: 5,
  chaos: 0,
  patience: 0.8, // spends from surplus; happily saves for a decisive play
  targeting: { strategy: "highestIncome" },
  economy: { citizenBudgetFactor: 1.1, maxCitizens: 40, savingsFloor: 250 },
  defense: {
    repairHpFraction: 0.45,
    shieldBudgetFactor: 3,
    emergencyHpFraction: 0.25,
  },
  offense: {
    unlockBudgetFactor: 3,
    upgradeBudgetFactor: 4,
    castBudgetFactor: 3,
    preferKinds: ["attack", "utility", "ultimate"],
  },
  ultimate: { targetHpFraction: 0.5, selfHpFraction: 0.5 },
};

/** Vulture: circles until a kill window opens — hunts the lowest HP, holds
 *  its ultimate for the finishing blow, and strikes in bursts. */
export const OPPORTUNISTIC: PersonalityProfile = {
  name: "opportunistic",
  spendPriority: ["abilities", "defense", "economy", "cast"],
  actEveryTicks: 5,
  chaos: 0,
  patience: 1, // the vulture: waits for the perfect, hardest-hitting moment
  targeting: { strategy: "lowestHp" },
  economy: { citizenBudgetFactor: 3, maxCitizens: 20, savingsFloor: 300 },
  defense: {
    repairHpFraction: 0.35,
    shieldBudgetFactor: 4,
    emergencyHpFraction: 0.2,
  },
  offense: {
    unlockBudgetFactor: 1.5,
    upgradeBudgetFactor: 2,
    castBudgetFactor: 1.75,
    preferKinds: ["ultimate", "attack", "utility"],
  },
  ultimate: { targetHpFraction: 0.35, selfHpFraction: 0.4 },
};

/** All-rounder: sensible middle values everywhere. The default opponent and
 *  the baseline other personalities are measured against. */
export const BALANCED: PersonalityProfile = {
  name: "balanced",
  spendPriority: ["abilities", "economy", "defense", "cast"],
  actEveryTicks: 5,
  chaos: 0,
  patience: 0.5, // balances spending now against saving for a stronger play
  targeting: { strategy: "lowestHp" },
  economy: { citizenBudgetFactor: 3, maxCitizens: 25, savingsFloor: 150 },
  defense: {
    repairHpFraction: 0.35,
    shieldBudgetFactor: 4,
    emergencyHpFraction: 0.15,
  },
  offense: {
    unlockBudgetFactor: 1.5,
    upgradeBudgetFactor: 2.5,
    castBudgetFactor: 1.5,
    preferKinds: ["attack", "utility", "ultimate"],
  },
  ultimate: { targetHpFraction: 0.75, selfHpFraction: 0.6 },
};

/** Dice-goblin: every decision may go sideways — random targets, shuffled
 *  casts, forgotten purchases. Seeded, so even chaos replays identically. */
export const RANDOM: PersonalityProfile = {
  name: "random",
  spendPriority: ["abilities", "economy", "defense", "cast"],
  actEveryTicks: 5,
  chaos: 1,
  patience: 0, // no planning — chaos casts on impulse
  targeting: { strategy: "random" },
  economy: { citizenBudgetFactor: 2, maxCitizens: 30, savingsFloor: 0 },
  defense: {
    repairHpFraction: 0.4,
    shieldBudgetFactor: 3,
    emergencyHpFraction: 0.2,
  },
  offense: {
    unlockBudgetFactor: 1.5,
    upgradeBudgetFactor: 2,
    castBudgetFactor: 1,
    preferKinds: ["attack", "utility", "ultimate"],
  },
  ultimate: { targetHpFraction: 1, selfHpFraction: 1 },
};

/** Registry for config-driven selection (e.g. CLI flags, optimizer matchups). */
export const PERSONALITIES = {
  aggressive: AGGRESSIVE,
  defensive: DEFENSIVE,
  economic: ECONOMIC,
  opportunistic: OPPORTUNISTIC,
  balanced: BALANCED,
  random: RANDOM,
} as const;

export type PersonalityName = keyof typeof PERSONALITIES;
