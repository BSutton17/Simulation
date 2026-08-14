import { COMBAT } from "../data/balance.js";
import { param } from "./parameters.js";
import { computeStat } from "./modifiers.js";
import {
  elementalDamageMultiplier,
  damageMultiplier,
  shieldDamageMultiplier,
  critChanceModifier,
  critDamageMultiplier,
  targeterDamageMultiplier,
  creditAncientMemory,
  cocoonSpec,
} from "./passives.js";
import { earn } from "./money.js";
import {
  perkDamageMultiplier,
  perkDamageTakenMultiplier,
  perkShieldDamageMultiplier,
} from "./perks.js";
import type { PlayerState } from "../match/playerState.js";

/**
 * Reusable damage engine (ticket #64). Computes the *incoming* damage of a hit —
 * its base amount plus a critical-strike roll — as a plain, deterministic
 * calculation any ability can share (ARCHITECTURE.md §7 step 5, "Apply damage").
 *
 * This is deliberately the stage **before** modifiers and mitigation: it does
 * not read attacker/defender buff–debuff `Modifier`s, resistances, shields, or
 * castle HP. Later pipeline stages take this result and apply those (shields
 * absorb before HP, per DATA_MODELS.md §9). Keeping the raw calculation isolated
 * makes it pure and trivially testable, and lets crit chance/multiplier be fed
 * in from wherever the caller computed them.
 *
 * Damage is a non-negative integer (DATA_MODELS.md §Units).
 */

export interface DamageInput {
  /** Base damage of the hit, before crit or any modifiers. */
  amount: number;
  /**
   * Probability (0–1) of a critical strike. Defaults to `COMBAT.BASE_CRIT_CHANCE`.
   * Clamped to [0, 1].
   */
  critChance?: number;
  /**
   * Damage multiplier applied on a crit. Defaults to `COMBAT.BASE_CRIT_MULTIPLIER`.
   * Values below 1 are treated as 1 (a crit never reduces damage).
   */
  critMultiplier?: number;
  /**
   * Forces the crit outcome, skipping the roll: `true` = always crit, `false` =
   * never crit. Omit to roll against `critChance`. Useful for abilities that
   * guarantee/forbid crits and for deterministic tests.
   */
  forceCrit?: boolean;
  /** Injectable RNG (returns 0–1) for deterministic tests. Defaults to Math.random. */
  rng?: () => number;
}

export interface DamageResult {
  /** Incoming damage before defender modifiers and mitigation are applied. */
  amount: number;
  /** The base damage before the crit multiplier (integer, clamped ≥ 0). */
  baseAmount: number;
  /** Whether this hit critically struck. */
  crit: boolean;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Rounds a pipeline damage value to an integer, absorbing floating-point error
 * from the multiplier chain so intended half-values round up. Without this,
 * e.g. `650 * 1.15` evaluates to 747.4999999999999 and `Math.round` floors it to
 * 747 instead of the intended 748. The epsilon is relative so it stays safe for
 * large hits, and far too small to flip any genuine sub-half value.
 */
const roundDamage = (n: number): number =>
  Math.round(n + Math.max(1, Math.abs(n)) * 1e-9);

/**
 * Calculates the incoming damage for a single hit. Pure: given the same inputs
 * (and RNG) it always returns the same result, and it mutates nothing.
 */
export function computeIncomingDamage(input: DamageInput): DamageResult {
  const baseAmount = Math.max(0, roundDamage(input.amount));
  const critChance = clamp01(
    input.critChance ?? param("combat.baseCritChance", COMBAT.BASE_CRIT_CHANCE),
  );
  const critMultiplier = Math.max(
    1,
    input.critMultiplier ??
      param("combat.baseCritMultiplier", COMBAT.BASE_CRIT_MULTIPLIER),
  );
  const rng = input.rng ?? Math.random;

  const crit = input.forceCrit ?? rng() < critChance;
  const amount = crit ? roundDamage(baseAmount * critMultiplier) : baseAmount;

  return { amount, baseAmount, crit };
}

// ---------------------------------------------------------------------------
// Damage modifier pipeline (ticket #68)
// ---------------------------------------------------------------------------

export interface ResolveDamageOptions {
  /**
   * The attack's element (e.g. "fire", "water"), from ability data. Consumed
   * by defender kingdom passives (elemental resistance, ticket #81) and, when
   * the matchup table lands, elemental interactions.
   */
  element?: string;
  /**
   * Elemental interaction multiplier (attacker's element vs defender's).
   * Supplied by ability data / the elemental matchup table when that data
   * lands; defaults to neutral (1). Values below 0 are treated as 0.
   */
  elementMultiplier?: number;
  /** Forces the crit outcome (see DamageInput.forceCrit). */
  forceCrit?: boolean;
  /** Injectable RNG for deterministic tests. */
  rng?: () => number;
  /** If set, the hit bypasses shields. */
  ignoreShields?: boolean;
  /**
   * Ability-level bonus multiplier against shielded targets (Earth's Meteor
   * Shower, Epic 9). Composes with the attacker's shieldDamageMultiplier
   * kingdom passive (e.g. Fire's Roast!).
   */
  shieldDamageMultiplier?: number;
  /**
   * With a shield multiplier, excess bonus damage normally caps at the shield
   * (the remainder carries at ×1). Set to let the full multiplied damage carry
   * into castle HP instead (Meteor Shower Lv 5).
   */
  shieldDamageOverflow?: boolean;
  /**
   * "Besieged" outgoing multiplier (≥ 1): the attacker hits harder while
   * multiple enemies are targeting it. Computed live from targeting state by
   * `besiegedDamageMultiplier` at the call site (which has the full roster) and
   * passed in here. Defaults to 1 (no bonus).
   */
  besiegedMultiplier?: number;
  /**
   * Time-scaling OUTGOING multiplier (Time's "Longevity", attack half): grows
   * with match time. Computed at the call site (which has match.tick) via
   * `scalingAttackMultiplier`. Defaults to 1.
   */
  attackerScalingMultiplier?: number;
  /**
   * Time-scaling INCOMING damage-taken multiplier (Time's "Longevity", defense
   * half): shrinks with match time. Computed at the call site via
   * `scalingDamageTakenMultiplier` on the defender. Defaults to 1.
   */
  defenderScalingTakenMultiplier?: number;
}

export interface ResolvedDamage extends DamageResult {
  /** Damage after the attacker's "damage" modifiers, before element/crit. */
  afterAttackerModifiers: number;
  /** Damage after the elemental multiplier, before the crit roll. */
  afterElement: number;
  /** Gold Insects' "Cocoon" made of this hit instead of taking it. 0 normally
   *  — the share is already deducted from `amount`. */
  cocoonedGold: number;
}

/**
 * The full pre-mitigation damage pipeline (ticket #68). Applies, in order:
 *
 *   1. attacker "damage" modifiers — passives, buffs, debuffs, and temporary
 *      ability effects all live in the shared Modifier system, so one
 *      `computeStat` pass composes them without conflicts ((base + Σadd) × Πmult);
 *   2. the elemental interaction multiplier;
 *   3. the crit roll — crit chance/multiplier are themselves modifiable stats
 *      ("critChance", "critMultiplier"), based on the shared COMBAT constants;
 *   4. defender "damageTaken" modifiers — vulnerabilities and resistances.
 *
 * The result is the final incoming damage, ready for shield/HP application
 * (`applyDamage` in combat.ts). Pure aside from the RNG.
 */
export function resolveDamage(
  attacker: PlayerState,
  defender: PlayerState,
  baseAmount: number,
  options: ResolveDamageOptions = {},
): ResolvedDamage {
  const base = Math.max(0, baseAmount);

  // 1. Attacker-side modifiers (buffs/debuffs/passives/temp effects), then the
  // universal "besieged" comeback multiplier (harder-hitting while ganged up
  // on) and any time-scaling attack multiplier (Time's "Longevity").
  const besieged = Math.max(1, options.besiegedMultiplier ?? 1);
  const attackerScaling = Math.max(0, options.attackerScalingMultiplier ?? 1);
  const afterAttackerModifiers = Math.max(
    0,
    computeStat(attacker, "damage", base, defender, "caster", options.element) *
      damageMultiplier(attacker, defender, options.element) *
      // "Sharper Swords" stacks on top of every kingdom passive above.
      perkDamageMultiplier(attacker) *
      // Magma's "Hot ash": aiming at Magma is what makes Magma hit you harder.
      targeterDamageMultiplier(attacker, defender) *
      besieged *
      attackerScaling,
  );

  // 2. Elemental interaction.
  const element = Math.max(0, options.elementMultiplier ?? 1);
  let afterElement = afterAttackerModifiers * element;

  // Shield damage multiplier (passives, ticket #105; ability-level, Epic 9)
  if (!options.ignoreShields && defender.castle.shield > 0) {
    const shieldMult =
      shieldDamageMultiplier(attacker, defender, options.element) *
      // "Sharper Axes" composes with the passive and ability-level bonuses.
      perkShieldDamageMultiplier(attacker) *
      (options.shieldDamageMultiplier ?? 1);
    if (shieldMult !== 1) {
      const maxShieldDamage = defender.castle.shield;
      const potentialShieldDamage = afterElement * shieldMult;
      if (options.shieldDamageOverflow || potentialShieldDamage <= maxShieldDamage) {
        // Overflow (Meteor Shower Lv 5): the full multiplied damage applies —
        // whatever the shield doesn't absorb carries into castle HP.
        afterElement = potentialShieldDamage;
      } else {
        const overflow = afterElement - maxShieldDamage / shieldMult;
        afterElement = maxShieldDamage + overflow;
      }
    }
  }

  // 3. Crit roll, with modifier-aware chance and multiplier (#67).
  const rolled = computeIncomingDamage({
    amount: afterElement,
    critChance: computeStat(attacker, "critChance", param("combat.baseCritChance", COMBAT.BASE_CRIT_CHANCE), defender, "caster") + critChanceModifier(attacker),
    critMultiplier: computeStat(
      attacker,
      "critMultiplier",
      param("combat.baseCritMultiplier", COMBAT.BASE_CRIT_MULTIPLIER),
      defender,
      "caster",
    ) + (critDamageMultiplier(attacker) - 1),
    forceCrit: options.forceCrit,
    rng: options.rng,
  });

  // 4. Defender-side modifiers (vulnerability adds/mults, resistances < 1),
  // kingdom elemental resistance passives (ticket #81), and any time-scaling
  // damage reduction (Time's "Longevity", defense half).
  const defenderScaling = Math.max(0, options.defenderScalingTakenMultiplier ?? 1);
  const amount = Math.max(
    0,
    roundDamage(
      // The element is passed so defender-side modifiers can gate on it
      // (e.g. Burn amplifying incoming Fire damage from its applier).
      computeStat(defender, "damageTaken", rolled.amount, attacker, "target", options.element) *
        elementalDamageMultiplier(defender, options.element) *
        // "Extra Guards" cuts every hit, whatever its element or source.
        perkDamageTakenMultiplier(defender) *
        defenderScaling,
    ),
  );

  // Insects' "Cocoon": a share of this hit is caught and turned into money
  // rather than landing. Rolled HERE, in the attack pipeline, so it fires once
  // per attack — rolling it inside `applyDamage` would also roll it on every
  // damage-over-time tick, twenty times a second, and a 5% chance at that
  // cadence is a certainty rather than a surprise.
  let final = amount;
  let cocoonedGold = 0;
  const cocoon = cocoonSpec(defender);
  if (cocoon && final > 0) {
    const roll = options.rng ?? Math.random;
    if (roll() < cocoon.chance) {
      cocoonedGold = Math.round(final * cocoon.goldPct);
      // That share never lands: it is income, not damage taken. Deducting it
      // is what makes the passive defensive as well as economic.
      final = Math.max(0, final - cocoonedGold);
      earn(defender, cocoonedGold);
    }
  }

  // Kitsune's "Swift Tails" charges off damage DEALT, so it is credited here —
  // the one place that knows both who swung and how hard it landed. Tracked for
  // everyone; only a kingdom with the passive actually accrues. Credited on
  // what LANDED, so a cocooned share feeds nobody's meter.
  creditAncientMemory(attacker, final);

  return {
    amount: final,
    baseAmount: rolled.baseAmount,
    crit: rolled.crit,
    afterAttackerModifiers,
    afterElement,
    cocoonedGold,
  };
}
