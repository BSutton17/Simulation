import type { Match } from "../match/Match.js";
import type { BlackHoleState } from "../match/GameState.js";
import type { AttackRecord, ModifierOp, PlayerState } from "../match/playerState.js";
import { canAfford, spend } from "./money.js";
import { validateTransaction, type TransactionResult } from "./transactions.js";
import { isReady, setCooldown } from "./cooldowns.js";
import { addModifier, removeModifier, getTargetingRedirect, computeStat } from "./modifiers.js";
import {
  applyStatus,
  hasStatus,
  removeStatus,
  pruneExhaustedStatuses,
  isTargetingBlocked,
  type StatusEffectDefinition,
} from "./status.js";
import { resolveDamage } from "./damage.js";
import {
  besiegedDamageMultiplier,
  scalingAttackMultiplier,
  scalingDamageTakenMultiplier,
  canMultiTargetAttacks,
  multiTargetLimit,
  attackRedirectChance,
  shieldOnDamageDealt,
  attackCooldownMultiplier,
  attackAftershock,
  onHitStatuses,
  retaliations,
  thornsProcs,
  healShareGlobalPct,
  dotResistanceMultiplier,
  splitsMultiTargetDamage,
  attackInflictedStatuses,
  cooldownReductionOnCast,
  upgradeCostMultiplier,
  shieldedMissChance,
  creditMemoryDirect,
  chargingMeterSpec,
} from "./passives.js";
import { applyDamage, type DamageApplication } from "./combat.js";
import {
  spawnVolcano,
  damageVolcano,
  volcanoIsLive,
  applyVolcanoStatus,
} from "./volcano.js";
import { VOLCANO_TARGET_ID } from "../match/GameState.js";
import { spawnCaprice, capriceIsActive, capriceProtects } from "./caprice.js";
import { centrepieceSpawnedBy, standingCentrepiece } from "./centrepiece.js";
import { getActiveParameterSet, param } from "./parameters.js";
import { recalcIncome } from "./economy.js";
import { DARK, INSECTS, SPACE, TICK } from "../data/balance.js";

/**
 * Space's Supernova level (0–3) from a meter value, using the cumulative
 * `SUPERNOVA_LEVEL_THRESHOLDS` (ramping cost per level). Level 0 can't fire.
 */
export function supernovaLevel(meter: number): number {
  const thresholds = SPACE.SUPERNOVA_LEVEL_THRESHOLDS;
  let level = 0;
  for (let i = 0; i < thresholds.length; i++) {
    if (meter >= thresholds[i]!) level = i + 1;
  }
  return level;
}

/** Meter value at which the Supernova is fully charged (max level). */
export function supernovaMaxMeter(): number {
  const thresholds = SPACE.SUPERNOVA_LEVEL_THRESHOLDS;
  return thresholds[thresholds.length - 1]!;
}

/**
 * The crowd-control lock Supernova (L2/L3) drops on every other kingdom: it
 * forces their target onto the victim and freezes the selection (`blocksTarget-
 * Change`) for the redirect's duration. The forced target and the target to
 * restore afterward are stamped on the instance at cast time (they're per-cast,
 * not static). Created by the engine, so it lives here rather than in ability data.
 */
export const SUPERNOVA_LOCK: StatusEffectDefinition = {
  id: "supernovaLock",
  name: "Supernova Lock",
  category: "crowdControl",
  stacking: "refresh",
  blocksTargetChange: true,
};
import { type EffectCondition, evaluateCondition } from "./conditions.js";
import { ALL_ABILITIES } from "../data/abilitiesRegistry.js";
import { abilitiesForKingdom } from "../data/kingdomAbilities.js";
import { drawBlackjackCard } from "./blackjack.js";

/**
 * The shared ability framework (tickets #71–#73), per ABILITY_SYSTEM.md: one
 * engine executes *every* kingdom's abilities. There is no ability class
 * hierarchy — an ability is **data** (`AbilityDefinition`) composing generic
 * effect primitives, and this module provides the common behavior all kinds
 * (attack, utility, ultimate, passive) inherit: validation, cost & cooldown
 * processing, target resolution, and effect execution.
 *
 * Activation pipeline (#72), in the hard-contract order of ARCHITECTURE.md §7 —
 * all validation completes before anything is spent or mutated (fail closed &
 * atomic), which is exactly the #73 guarantee: money is deducted only after an
 * activation is certain to succeed.
 */

export type AbilityKind = "attack" | "utility" | "ultimate" | "passive";

export type TargetingMode = "self" | "singleEnemy" | "allEnemies" | "noTarget";

/**
 * One face of Joker's Lucky Draw. A `status` outcome is an ongoing buff for the
 * ability's duration; `shield` and `heal` land once and are done.
 */
export type LuckyOutcome =
  | { kind: "status"; status: StatusEffectDefinition }
  | { kind: "shield"; amount: number }
  | { kind: "heal"; amount: number };

/** One generic effect primitive; the engine applies each in order. */
export interface EffectDefinition {
  type:
    | "damage"
    | "heal"
    | "shield"
    | "status"
    | "buff"
    | "debuff"
    | "economyModifier"
    | "resourceTransfer"
    | "cooldownModify"
    | "vision"
    | "undoLastAttack"
    | "chargeSupernova"
    | "chargeMemory"
    | "spendMemory"
    | "lavaFloor"
    | "smokeScreen"
    | "spawnVolcano"
    | "foxSiege"
    | "spawnCaprice"
    | "supernovaBlast"
    | "createBlackHole"
    | "linkCastles"
    | "amplifyDispelCost"
    | "delayedStrike"
    | "rageBlast"
    | "yinYangWager"
    | "blackjackDraw"
    | "luckyDraw"
    | "slotMachine"
    | "roulette";
  /** Who this effect applies to within the resolved targeting.
   *  `otherEnemies` = every living enemy *except* the resolved target
   *  (Earthquake's aftershock, Epic 9 — "adjacent" until maps land).
   *  `allPlayers` = EVERY living kingdom, the caster included.
   *  `allEnemies` = every living kingdom EXCEPT the caster (Light's Flash
   *  Bang). Both ignore targeting bans, because neither is aimed at anyone —
   *  which is what separates them from `otherEnemies`, a splash off a struck
   *  target that does respect them. */
  target: "self" | "target" | "otherEnemies" | "allPlayers" | "allEnemies";
  /** Conditional effects (ticket #101). */
  conditions?: EffectCondition[];
  /** Probability check (ticket #102). */
  chance?: number;
  params: {
    /** damage/heal/shield magnitude. */
    amount?: number;
    /** heal: additionally restore this fraction of the recipient's max HP. */
    percentMaxHp?: number;
    /** damage: bypass the target's shield pool. */
    ignoreShields?: boolean;
    /** damage: the attack's element (consumed by resistances/matchups). */
    element?: string;
    /** damage: elemental interaction multiplier (from matchup data). */
    elementMultiplier?: number;
    /** damage: bonus multiplier against shielded targets (Meteor Shower). */
    shieldDamageMultiplier?: number;
    /** damage: excess shield-bonus damage carries into castle HP instead of
     *  capping at the shield (Meteor Shower Lv 5). */
    shieldDamageOverflow?: boolean;
    /**
     * damage: heal the caster for `ratio` × damage dealt, optionally only
     * while the target bears a named status (e.g. Water healing vs Current).
     */
    lifesteal?: { ratio: number; requiresTargetStatus?: string };
    /** status: definition + duration. */
    status?: StatusEffectDefinition;
    durationTicks?: number;
    stacks?: number;
    /**
     * status: extra duration when the recipient already bears a named status
     * (e.g. Flood lasting longer against Current-affected targets).
     */
    bonusDurationIfTargetHasStatus?: { statusId: string; extraTicks: number };
    /** buff/debuff: the modifier to add. */
    stat?: string;
    op?: ModifierOp;
    value?: number;
    /** buff/debuff: duration in ticks (null/omitted = permanent). */
    modifierTicks?: number | null;
    /** economyModifier: citizen adjustments (percent is of current count). */
    citizensPercent?: number;
    citizensFlat?: number;
    /** damage: extra damage when the recipient bears a named status. */
    bonusDamageIfTargetHasStatus?: { statusId: string; extraAmount: number };
    /**
     * Joker's Blackjack: what each SUIT leaves behind when the card lands.
     * Keyed by suit; a suit with no entry (diamonds) carries no rider, and a
     * joker has no suit at all.
     */
    suitStatuses?: Record<
      string,
      { status: StatusEffectDefinition; durationTicks: number }
    >;
    /**
     * amplifyDispelCost: multiply what the recipient owes to shake off a named
     * status (Light's Illumination inflating the Fireflies buy-off price). A
     * no-op unless they already carry it — it never applies the status itself.
     */
    amplifyDispelCost?: { statusId: string; multiplier: number };
    /**
     * delayedStrike (Light's "Light Show"): a field-wide hit that lands
     * `delayTicks` later, publicly telegraphed so everyone has time to react.
     * On landing, every kingdom but the caster is checked: a shielded one loses
     * its shield outright (whatever its health) and takes nothing, while an
     * unshielded one takes `amount`.
     */
    delayTicks?: number;
    breaksShields?: boolean;
    /**
     * yinYangWager (Dark): the wager laid on the victim. `amount` is what a
     * WRONG guess costs them; `halfAmount` what a right one still costs. The
     * side being punished comes from the caster's `options.choice`.
     */
    halfAmount?: number;
    /**
     * blackjackDraw (Joker): multiplies the drawn card's damage, so upgrade
     * tiers scale the whole deck at once rather than restating its table.
     * Defaults to 1.
     */
    cardDamageMultiplier?: number;
    /**
     * luckyDraw (Joker): `chance` (0–1) that ANY of `outcomes` fires; on a hit
     * exactly ONE is chosen uniformly. Nothing happens on a miss — that is the
     * gamble. Ongoing outcomes last `durationTicks`.
     */
    luckyDraw?: {
      chance: number;
      outcomes: readonly LuckyOutcome[];
    };
    /** resourceTransfer: transfer currency/citizens from recipient to caster (ticket #106) */
    resourceTransfer?: {
      type: "currency" | "citizens";
      amount?: number;
      percent?: number;
    };
    /** cooldownModify: alter existing cooldown duration of recipient's abilities (ticket #107) */
    cooldownModify?: {
      op: "set" | "add" | "multiply";
      value: number;
      target: "all" | "attacks" | "utilities" | "ultimates" | string;
    };
    /** vision: apply temporary vision status effects (ticket #108) */
    vision?: {
      type: "fog" | "hiddenInventory" | "overlay" | string;
      durationTicks: number;
    };
    /** chargeSupernova: points added to the caster's Supernova meter (Space). */
    supernovaCharge?: number;
    /** chargeMemory: points added to the caster's Ancient Memory (Kitsune). */
    memoryCharge?: number;
    /** foxSiege: damage spent ENTIRELY on a standing shield, no carry-over. */
    shieldOnlyAmount?: number;
    /** spawnCaprice: ticks between target re-rolls. */
    scrambleTicks?: number;
    /** lavaFloor: multiplier applied to every burn on the field. */
    burnMultiplier?: number;
    /** smokeScreen: damage dealt to each kingdom currently targeting the caster. */
    targeterDamage?: number;
    /** supernovaBlast (Space): damage indexed by the caster's CURRENT Supernova
     *  level (index 0 = level 1, etc.); the meter is consumed on cast. */
    supernovaDamageByLevel?: number[];
    /** supernovaBlast: chance, per level, that the blast forces every kingdom to
     *  target the victim (indexed like `supernovaDamageByLevel`). */
    supernovaRedirectChanceByLevel?: number[];
    /** supernovaBlast: how long the forced-target redirect lasts (ticks). */
    redirectDurationTicks?: number;
    /** createBlackHole (Space ultimate): how long the black hole stays open,
     *  absorbing every attack, before it collapses and dumps (ticks). */
    blackHoleDurationTicks?: number;
    /** status: alongside applying the status, borrow this many citizens from
     *  the recipient (capped at what they have), returned automatically when
     *  the status expires naturally (Love's Cupid's Arrow — "infatuated"). */
    borrowCitizens?: number;
    /** status: healing (cumulative negated damage) that triggers an early
     *  reveal on a `revealsBeforeExpiry` status (Love's "Love Galore"); set
     *  onto the instance so it scales with the ability's upgrade tier. */
    revealHealThreshold?: number;
  };
}

/**
 * One purchasable upgrade tier (ticket #75, ABILITY_SYSTEM.md §7). Tiers are
 * ordered data overrides merged onto the base definition — an upgrade never
 * forks behavior, it parameterizes it, so *any* property expressed in ability
 * data (damage amounts, cooldowns, durations, costs, visual-effect keys, …) is
 * upgradeable with zero engine or kingdom-specific changes.
 */
export interface UpgradeTier {
  /** Tier index, 1-based (level 0 = the base definition). */
  level: number;
  /** Currency cost to purchase this tier. */
  cost: number;
  changes: {
    /** Overrides the activation cost. */
    cost?: number;
    /** Scales the activation cost, rounded down (e.g. 0.85 = 15% cheaper).
     *  Every cooldown-reduction tier also carries one of these. */
    costMultiplier?: number;
    /** Overrides the cooldown. */
    cooldownTicks?: number;
    /**
     * Per-effect param overrides, matched to `effects` by index; null/omitted
     * entries leave that effect untouched. Merged shallowly, so a tier can bump
     * `amount`, extend `durationTicks`, swap a visual key, etc.
     */
    effectParams?: (Partial<EffectDefinition["params"]> | null)[];
    /** Overrides the chance of effects, matched by index. */
    effectChances?: (number | null)[];
    /** Additional effects unlocked at this tier. */
    addEffects?: EffectDefinition[];
    /** Partial overrides of the charge system (e.g. faster recharge). */
    chargeSystem?: Partial<ChargeSystem>;
    /** Overrides the concurrent-affected cap (e.g. Thick Fog Lv 5: 3 → 4). */
    maxConcurrentAffected?: { statusId: string; limit: number };
    /**
     * Permanent stat modifiers granted to the player when this tier is
     * purchased (Epic 10, e.g. Lightning Barrage extending charge duration
     * via `buffDuration:<stat>`). Applied by purchaseUpgrade, never expire.
     */
    permanentModifiers?: { stat: string; op: ModifierOp; value: number }[];
  };
}

/**
 * Charge-based casting (Lightning Barrage, Epic 10). The ability owns a pool
 * of `max` charges; each cast spends 1..max of them (the caster chooses via
 * ActivateOptions.chargesToUse) and costs `costPerCharge` gold per charge.
 * Total damage comes from `damageByCharges` indexed by charges spent
 * (e.g. [200, 410, 650]). Spent charges regenerate independently: spending k
 * charges arms staggered countdowns of 1×, 2×, … k× `rechargeTicks`, so
 * remaining charges stay castable immediately.
 */
export interface ChargeSystem {
  max: number;
  rechargeTicks: number;
  costPerCharge: number;
  damageByCharges: number[];
}

/** The data an ability *is*. Kingdom ability sets are lists of these. */
export interface AbilityDefinition {
  id: string;
  /** Human-readable display name (optional; for UI). */
  name?: string;
  kind: AbilityKind;
  /** Money cost to activate (0 for free/passive). */
  cost: number;
  /** Explicit unlock price; when omitted, unlocking costs 50% of `cost`. */
  unlockCost?: number;
  /** Cooldown started on successful activation (0 = none). */
  cooldownTicks: number;
  /**
   * `secondTarget` (Love's BFFS!!!): this attack requires a SECOND, distinct
   * player-selected enemy in addition to the primary. The caller supplies both
   * via `targetIds` ([primary, second]); the cast is rejected up-front with
   * `SECOND_TARGET_REQUIRED` if a valid second isn't provided. The second id is
   * handed to effects as `options.secondTargetId` (used by `linkCastles`).
   */
  targeting: {
    mode: TargetingMode;
    secondTarget?: boolean;
    /**
     * The cast must name one of these (Dark's Yin and Yang: the caster picks
     * which behaviour they are punishing). Validated before anything is spent;
     * the chosen value rides into the effects on `options.choice`.
     */
    choices?: readonly string[];
  };
  effects: EffectDefinition[];
  /** Charge-based casting (Lightning Barrage); see ChargeSystem. */
  chargeSystem?: ChargeSystem;
  /**
   * Caps how many players may simultaneously bear `statusId` applied by this
   * caster (Air's Thick Fog, Epic 8). Activating on a fresh target while the
   * cap is full fails with TARGET_LIMIT — nothing is spent, no cooldown armed.
   */
  maxConcurrentAffected?: { statusId: string; limit: number };
  /**
   * Status-gated ricochet (Air's A Light Breeze under Bird's Eye View, Epic 8):
   * when the caster bears `requiresCasterStatus` and has 2+ distinct kingdoms
   * selected, the attack bounces *between* the selected kingdoms instead of
   * striking them all at once. The first selected kingdom is hit, then each
   * further bounce is a `chance` roll up to `maxLandings` total landings; a
   * bounce never lands on the same castle twice in a row. Every landing deals
   * the attack's full damage (no multi-target spread). With one kingdom
   * selected (or the status absent) the attack keeps its normal form.
   */
  bounce?: { requiresCasterStatus: string; chance: number; maxLandings: number };
  /** Ordered upgrade tiers (ticket #75); omitted = not upgradeable. */
  upgradePath?: UpgradeTier[];
}

/**
 * The id of a player's kingdom's BASIC attack — slot 1 of its kit, by the
 * convention every kingdom's ability list follows (basic, medium, heavy,
 * utility, ultimate). Used by locks that spare it (Dark's Never-ending
 * nightmare). Empty string for an unknown kingdom, which matches no ability.
 */
export function basicAttackIdFor(player: PlayerState): string {
  return abilitiesForKingdom(player.kingdomId)[0]?.id ?? "";
}

/** The player's current upgrade level for an ability (0 = base). */
export function getUpgradeLevel(player: PlayerState, abilityId: string): number {
  return player.upgrades[abilityId] ?? 0;
}

/**
 * Resolves the *effective* definition at an upgrade level by merging the
 * `changes` of every tier up to `level` onto the base, in order (#75). The
 * base definition is never mutated (definitions are immutable at runtime).
 */
export function resolveAbility(
  ability: AbilityDefinition,
  level: number,
): AbilityDefinition {
  const resolved: AbilityDefinition = {
    ...ability,
    effects: ability.effects.map((e) => ({ ...e, params: { ...e.params } })),
  };
  applyParameterOverrides(resolved);
  for (const tier of ability.upgradePath ?? []) {
    if (tier.level > level) continue;
    if (tier.changes.cost !== undefined) resolved.cost = tier.changes.cost;
    if (tier.changes.costMultiplier !== undefined) {
      resolved.cost = Math.floor(resolved.cost * tier.changes.costMultiplier);
    }
    if (tier.changes.cooldownTicks !== undefined) {
      resolved.cooldownTicks = tier.changes.cooldownTicks;
    }
    if (tier.changes.maxConcurrentAffected !== undefined) {
      resolved.maxConcurrentAffected = tier.changes.maxConcurrentAffected;
    }
    tier.changes.effectParams?.forEach((params, i) => {
      if (params && resolved.effects[i]) {
        Object.assign(resolved.effects[i].params, params);
      }
    });
    tier.changes.effectChances?.forEach((chance, i) => {
      if (chance !== null && chance !== undefined && resolved.effects[i]) {
        resolved.effects[i].chance = chance;
      }
    });
    for (const extra of tier.changes.addEffects ?? []) {
      resolved.effects.push({ ...extra, params: { ...extra.params } });
    }
    if (tier.changes.chargeSystem && resolved.chargeSystem) {
      resolved.chargeSystem = {
        ...resolved.chargeSystem,
        ...tier.changes.chargeSystem,
      };
    }
  }
  return resolved;
}

/**
 * Applies active balance-parameter overrides (ticket #202) to a fresh
 * per-activation copy of an ability, BEFORE upgrade tiers merge — so a
 * candidate configuration retunes base values while upgrade scaling still
 * layers on top. No active set (the live game) means no work and no change.
 *
 * Ids mirror parameterCatalog.ts exactly:
 *   ability.<id>.cost / .cooldownTicks / .charge.<field> /
 *   .charge.damage.<i> / .effects.<i>.<numericKey> / .effects.<i>.chance
 */
function applyParameterOverrides(resolved: AbilityDefinition): void {
  if (getActiveParameterSet() === null) return; // production: zero overhead

  const id = resolved.id;
  resolved.cost = param(`ability.${id}.cost`, resolved.cost);
  resolved.cooldownTicks = param(
    `ability.${id}.cooldownTicks`,
    resolved.cooldownTicks,
  );

  if (resolved.chargeSystem) {
    const c = resolved.chargeSystem;
    resolved.chargeSystem = {
      max: Math.round(param(`ability.${id}.charge.max`, c.max)),
      rechargeTicks: Math.round(
        param(`ability.${id}.charge.rechargeTicks`, c.rechargeTicks),
      ),
      costPerCharge: param(`ability.${id}.charge.costPerCharge`, c.costPerCharge),
      damageByCharges: c.damageByCharges.map((dmg, i) =>
        param(`ability.${id}.charge.damage.${i}`, dmg),
      ),
    };
  }

  resolved.effects.forEach((effect, i) => {
    if (effect.chance !== undefined) {
      effect.chance = param(`ability.${id}.effects.${i}.chance`, effect.chance);
    }
    for (const key of Object.keys(effect.params)) {
      const value = (effect.params as Record<string, unknown>)[key];
      if (typeof value === "number") {
        (effect.params as Record<string, number>)[key] = param(
          `ability.${id}.effects.${i}.${key}`,
          value,
        );
      }
    }
  });
}

/**
 * Purchases the caster's next upgrade tier for an ability (#75). Validated
 * through the shared transaction system; on success the cost is spent and the
 * player's level increments. Applies from the *next* activation — an already
 * armed cooldown is not retroactively changed.
 */
/**
 * What a specific upgrade tier costs this player: its declared price, then
 * Light's "Bright idea" discount. The single definition of an upgrade price —
 * both the purchase and the price table the HUD is sent read it, so a tag can
 * never disagree with the charge.
 */
export function abilityUpgradeCost(
  player: PlayerState,
  ability: AbilityDefinition,
  tier: UpgradeTier,
): number {
  return Math.ceil(
    param(`ability.${ability.id}.upgrade.${tier.level}.cost`, tier.cost) *
      upgradeCostMultiplier(player),
  );
}

export function purchaseUpgrade(
  match: Match,
  player: PlayerState,
  ability: AbilityDefinition,
): TransactionResult & { level?: number } {
  const current = getUpgradeLevel(player, ability.id);
  const next = (ability.upgradePath ?? []).find((t) => t.level === current + 1);
  if (!next) return { ok: false, error: "INVALID_TRANSACTION" }; // maxed / none

  const tierCost = abilityUpgradeCost(player, ability, next);
  const validation = validateTransaction(match, player, tierCost);
  if (!validation.ok) return validation;

  spend(player, tierCost);
  player.upgrades[ability.id] = current + 1;

  // Gameplay event (#204).
  const upgradeBus = match.gameState?.events;
  if (upgradeBus?.enabled) {
    upgradeBus.emit({ type: "purchase", tick: match.tick, playerId: player.id, kind: "upgrade", itemId: ability.id, cost: tierCost });
  }

  // Permanent stat grants attached to this tier (Epic 10).
  for (const [i, spec] of (next.changes.permanentModifiers ?? []).entries()) {
    addModifier(player, {
      id: `upgrade:${ability.id}:${next.level}:${i}`,
      stat: spec.stat,
      op: spec.op,
      value: spec.value,
      sourceId: `upgrade:${ability.id}`,
      remainingTicks: null,
    });
  }
  return { ok: true, level: current + 1 };
}

export type AbilityError =
  | "INVALID_PHASE"
  | "ELIMINATED"
  | "NOT_ACTIVATABLE" // passives are trigger-driven, never manually cast
  | "ON_COOLDOWN"
  | "INSUFFICIENT_FUNDS"
  | "TARGET_REQUIRED"
  | "INVALID_TARGET"
  | "TARGET_LIMIT" // concurrent-affected cap reached (e.g. Thick Fog)
  | "ATTACKS_BLOCKED" // a crowd-control status bars attacking (e.g. Frozen)
  | "NO_CHARGES" // a charge-costed ability needs at least one charge
  | "NO_SUPERNOVA" // Supernova has no charge yet (meter at level 0)
  | "NOT_ENRAGED" // Unlimited Rage is not fully charged yet
  | "MEMORY_NOT_FULL" // Kitsune Rush needs a completely full Ancient Memory
  | "BASIC_ATTACKS_ONLY" // Never-ending nightmare bars everything but the basic
  | "CHOICE_REQUIRED" // Yin and Yang needs the caster to pick a side
  | "SECOND_TARGET_REQUIRED" // BFFS!!! needs a second distinct kingdom selected
  | "FIELD_OCCUPIED"; // something already holds the middle of the battlefield

export interface AbilityActivation {
  ok: boolean;
  error?: AbilityError;
  /** Damage breakdowns for any damage effects, in effect order. */
  damage?: DamageApplication[];
  /** The resolved target's id (self-casts resolve to the caster). */
  targetId?: string;
}

export interface ActivateOptions {
  /** Explicit target for singleEnemy abilities; defaults to the caster's
   * currently selected target (ticket #61). */
  targetId?: string;
  /**
   * Multiple explicit targets for one attack cast (Air's "Embrace of Winds",
   * Epic 8). Honored only when the caster's kingdom has the multiTargetAttacks
   * passive and the ability is an attack; otherwise the first id is used.
   * Cost and cooldown are paid once; every effect applies to each target.
   */
  targetIds?: string[];
  /**
   * How many charges to spend on a charge-costed cast (Lightning Barrage,
   * Epic 10). Clamped to [1, spec.max] and to the charges actually held;
   * defaults to "as many as available (up to max)".
   */
  chargesToUse?: number;
  /** Deterministic crit control for tests (see damage engine). */
  forceCrit?: boolean;
  rng?: () => number;
  /** Engine-internal (Ice's Frozen Focus, Epic 11): set by activateAbility
   *  while the caster holds guarantee stacks — chance-gated effects always
   *  proc. Not intended to be passed by callers. */
  guaranteeChances?: boolean;
  /** Engine-internal: the attack-journal id for THIS activation, so every
   *  effect it lands on a recipient records under one record (Blip's undo).
   *  Set by the pipeline, never by callers. */
  journalId?: string;
  /** Engine-internal: the validated SECOND target for a `secondTarget` attack
   *  (Love's BFFS!!!). Set by the pipeline from `targetIds[1]`, read by the
   *  `linkCastles` effect. */
  secondTargetId?: string;
  /** The caster's pick for an ability that demands one (`targeting.choices`). */
  choice?: string;
}

/** Keep each player's attack journal small — only recent attacks are undoable. */
const MAX_ATTACK_JOURNAL = 8;

/**
 * Find-or-create the recipient's journal record for one attacking activation,
 * so all of that activation's damage/statuses on them group under a single
 * undoable entry (Blip). Only enemy attacks (source ≠ recipient) are journaled.
 */
function journalRecordFor(
  recipient: PlayerState,
  journalId: string,
  sourceId: string,
  abilityId: string,
  tick: number,
): AttackRecord {
  let record = recipient.attackJournal.find((r) => r.id === journalId);
  if (!record) {
    record = { id: journalId, sourceId, abilityId, tick, hpRefund: 0, shieldRefund: 0, statusIds: [] };
    recipient.attackJournal.push(record);
    if (recipient.attackJournal.length > MAX_ATTACK_JOURNAL) {
      recipient.attackJournal.shift();
    }
  }
  return record;
}

/**
 * Activates an ability through the shared pipeline (#72):
 *   validate ability → validate phase/actor → cooldown → funds → target →
 *   spend & start cooldown (#73) → apply effects → report.
 *
 * Thin wrapper over the pipeline that publishes a `castFailed` event (#204) on
 * any rejection — telemetry consumers use it to measure wasted intents. The
 * emission is fire-and-forget and guarded on `bus.enabled`, so it costs nothing
 * for unmonitored matches and never affects gameplay.
 */
export function activateAbility(
  match: Match,
  caster: PlayerState,
  ability: AbilityDefinition,
  options: ActivateOptions = {},
): AbilityActivation {
  const result = activateAbilityInner(match, caster, ability, options);
  if (!result.ok) {
    const bus = match.gameState?.events;
    if (bus?.enabled) {
      // Attribute a status-caused rejection to the responsible active status,
      // generically: the only cast rejection a status produces is a crowd
      // control that bars attacking, so report the caster's blocking status.
      const statusId =
        result.error === "ATTACKS_BLOCKED"
          ? caster.statuses.find((s) => s.blocksAttacks)?.id
          : undefined;
      bus.emit({
        type: "castFailed",
        tick: match.tick,
        casterId: caster.id,
        abilityId: ability.id,
        reason: result.error ?? "UNKNOWN",
        statusId,
      });
    }
  }
  return result;
}

function activateAbilityInner(
  match: Match,
  caster: PlayerState,
  ability: AbilityDefinition,
  options: ActivateOptions = {},
): AbilityActivation {
  // 1. Validate the ability is manually usable at all.
  if (ability.kind === "passive") return { ok: false, error: "NOT_ACTIVATABLE" };

  // Resolve the effective definition at the caster's upgrade level (#75):
  // cost, cooldown, and effect params below all come from this.
  const effective = resolveAbility(ability, getUpgradeLevel(caster, ability.id));

  // #203: every gameplay dice roll flows through the match-level RNG unless
  // a caller (deterministic tests) pins its own stream explicitly.
  if (options.rng === undefined) {
    options = { ...options, rng: match.rng };
  }

  // 2. Validate phase and actor.
  if (match.phase !== "active") return { ok: false, error: "INVALID_PHASE" };
  if (caster.eliminated) return { ok: false, error: "ELIMINATED" };

  // Frozen-style attack bans (Epic 11): crowd-control statuses that stop the
  // bearer from attacking (Ice's Frozen, Blizzard). Non-attacks stay legal.
  if (ability.kind === "attack" && caster.statuses.some((s) => s.blocksAttacks)) {
    return { ok: false, error: "ATTACKS_BLOCKED" };
  }

  // Dark's Never-ending nightmare: nothing but your kingdom's basic attack.
  // Everything offensive is refused — the rest of the kit and the ultimate
  // alike — while utilities stay legal, so the victim can still defend.
  if (
    (ability.kind === "attack" || ability.kind === "ultimate") &&
    caster.statuses.some((s) => s.basicAttacksOnly) &&
    ability.id !== basicAttackIdFor(caster)
  ) {
    return { ok: false, error: "BASIC_ATTACKS_ONLY" };
  }

  // Space's Supernova (level 0 = can't attack): a supernovaBlast ability needs
  // the meter charged to at least level 1 before it can fire.
  if (
    effective.effects.some((e) => e.type === "supernovaBlast") &&
    supernovaLevel(caster.supernovaMeter) < 1
  ) {
    return { ok: false, error: "NO_SUPERNOVA" };
  }

  // Dark's Unlimited Rage: all or nothing — it cannot be cast at all until the
  // meter is completely full.
  if (
    effective.effects.some((e) => e.type === "rageBlast") &&
    caster.rageMeter < param("dark.rageFull", DARK.RAGE_FULL)
  ) {
    return { ok: false, error: "NOT_ENRAGED" };
  }

  // Kitsune Rush: the same all-or-nothing rule, against Ancient Memory. Gold
  // cannot bring it forward — a full meter is the only key.
  if (effective.effects.some((e) => e.type === "spendMemory")) {
    const spec = chargingMeterSpec(caster);
    if (spec && caster.ancientMemory < spec.full) {
      return { ok: false, error: "MEMORY_NOT_FULL" };
    }
  }

  // The middle of the battlefield holds one thing at a time. An ability that
  // would put an entity there — Magma's volcano, Insects' butterfly — is
  // refused outright while any other is still standing, in both directions and
  // including itself. See `engine/centrepiece.ts` for why, and for the one-line
  // registration that extends this to future centre-of-the-field abilities.
  //
  // Checked BEFORE the spend below, so a refused cast costs the caster nothing:
  // the gate is "wait for the field to clear", never a squandered ultimate.
  if (centrepieceSpawnedBy(effective) && standingCentrepiece(match)) {
    return { ok: false, error: "FIELD_OCCUPIED" };
  }

  // 3. Validate cooldown, then funds. Charge-based abilities (Lightning
  // Barrage) price the cast per charge spent: the caster picks 1..max charges
  // (default 1), clamped to how many are currently regenerated. The cast's
  // damage comes from the per-count table; spent charges regenerate on
  // independent staggered timers (armed after the spend, step 5).
  if (!isReady(caster, effective.id)) return { ok: false, error: "ON_COOLDOWN" };

  const chargeSystem = effective.chargeSystem;
  let castCost = effective.cost;
  let chargesPlanned: number | undefined;
  if (chargeSystem) {
    const recharging = caster.recharges[effective.id]?.length ?? 0;
    const available = Math.max(0, chargeSystem.max - recharging);
    if (available === 0) return { ok: false, error: "NO_CHARGES" };
    const requested = Math.max(
      1,
      Math.min(chargeSystem.max, Math.floor(options.chargesToUse ?? 1)),
    );
    chargesPlanned = Math.min(requested, available);
    castCost = chargeSystem.costPerCharge * chargesPlanned;

    // Damage scales with charges spent: add the table value for this cast.
    // `effective` is a per-activation copy, so this never leaks between casts.
    const dmgEffect = effective.effects.find((e) => e.type === "damage");
    if (dmgEffect) {
      const idx = Math.min(chargesPlanned, chargeSystem.damageByCharges.length) - 1;
      dmgEffect.params.amount =
        (dmgEffect.params.amount ?? 0) + (chargeSystem.damageByCharges[idx] ?? 0);
    }
  }

  // Price modifiers: statuses may scale a specific ability's price
  // ("abilityCost:<id>" — Thundering Fate quarters Zap's price) or every
  // price ("abilityCost"). Rounded down to whole gold.
  castCost = Math.max(
    0,
    Math.floor(
      computeStat(
        caster,
        `abilityCost:${effective.id}`,
        computeStat(caster, "abilityCost", castCost),
      ),
    ),
  );

  if (!canAfford(caster, castCost)) {
    return { ok: false, error: "INSUFFICIENT_FUNDS" };
  }

  // 4. Resolve targeting (ABILITY_SYSTEM.md §4).
  const rng = options.rng!;
  /** Valid deflection/redirect destinations: anyone alive except `excludeId`
   *  — which deliberately *includes* the attacker (Air, Epic 8). */
  const otherPlayers = (excludeId: string): PlayerState[] =>
    match.gameState!.getPlayers().filter(
      (p) => !p.eliminated && p.id !== excludeId,
    );

  let targets: PlayerState[];
  /** Damage bound for the volcano instead of a kingdom, if this cast hit it. */
  let volcanoStrike = 0;
  // Air's wind passive (Epic 9 VFX): records shots turned aside so the renderer
  // can play the attacker → Air → new-target deflection. `via` is the kingdom
  // that intercepted the shot; `to` is where it was hurled instead.
  const windRedirects: { via: string; to: string }[] = [];
  switch (effective.targeting.mode) {
    case "self":
    case "noTarget":
      targets = [caster];
      break;
    case "allEnemies":
      // Every living enemy; status-imposed targeting bans (#88) still bind.
      targets = match.gameState!.getPlayers().filter(
        (p) =>
          p.id !== caster.id &&
          !p.eliminated &&
          !isTargetingBlocked(caster, p.id),
      );
      if (targets.length === 0) return { ok: false, error: "INVALID_TARGET" };
      break;
    case "singleEnemy": {
      // Multi-target casts (Air's "Embrace of Winds", Epic 8): honored only
      // for attacks from kingdoms with the multiTargetAttacks passive.
      const requestedIds =
        options.targetIds && options.targetIds.length > 0
          ? ability.kind === "attack" && canMultiTargetAttacks(caster)
            ? // Embrace of Winds cap: at most maxTargets kingdoms (3 base, 5
              // upgraded) may be struck by one cast.
              [...new Set(options.targetIds)].slice(0, multiTargetLimit(caster))
            : [options.targetIds[0]!]
          : [options.targetId ?? caster.target];

      // Swinging at the volcano: it is not a kingdom, so it skips the parts of
      // the pipeline that need one — redirects, targeting bans, crits, and
      // every defender-side modifier. Its plain damage is chipped off it, and
      // any status the attack carries is laid on it as well (see below).
      if (requestedIds.length === 1 && requestedIds[0] === VOLCANO_TARGET_ID) {
        if (!volcanoIsLive(match)) return { ok: false, error: "INVALID_TARGET" };
        if (ability.kind !== "attack" && ability.kind !== "ultimate") {
          return { ok: false, error: "INVALID_TARGET" };
        }
        const total = effective.effects
          .filter((e) => e.type === "damage")
          .reduce((sum, e) => sum + (e.params.amount ?? 0), 0);
        if (total <= 0) return { ok: false, error: "INVALID_TARGET" };
        volcanoStrike = total;
      }

      targets = [];
      for (const targetId of requestedIds) {
        if (targetId === VOLCANO_TARGET_ID) continue; // handled above
        if (!targetId) return { ok: false, error: "TARGET_REQUIRED" };
        // Normally you cannot aim at yourself. While a Caprice is out you can
        // — the scramble puts people on their own castle on purpose, and
        // silently refusing to fire would turn the joke into a lockout.
        if (targetId === caster.id && !capriceIsActive(match)) {
          return { ok: false, error: "INVALID_TARGET" };
        }
        // Nobody may swing at Insects while its butterfly holds the field.
        if (capriceProtects(match, targetId) && targetId !== caster.id) {
          return { ok: false, error: "INVALID_TARGET" };
        }
        const resolved = match.hasPlayer(targetId)
          ? match.gameState?.getPlayer(targetId)
          : undefined;
        if (!resolved || resolved.eliminated) {
          return { ok: false, error: "INVALID_TARGET" };
        }
        // Status-imposed targeting bans (#88) bind ability casts too.
        if (isTargetingBlocked(caster, targetId)) {
          return { ok: false, error: "INVALID_TARGET" };
        }
        let target = resolved;
        // The Air castle where the wind first intercepts this shot (set by the
        // first wind redirect below); drives the deflection animation's `via`.
        let windVia: string | null = null;

        // Apply targeting redirection (ticket #109)
        const redirectId = getTargetingRedirect(target, caster);
        if (redirectId && redirectId !== target.id) {
          const redirected = match.gameState?.getPlayer(redirectId);
          if (redirected && !redirected.eliminated && !isTargetingBlocked(caster, redirected.id)) {
            target = redirected;
          }
        }

        // Hurricane-style deflection (Air, Epic 8): a mark on the *caster*,
        // applied by the resolved target, deflects this attack to another
        // valid kingdom — possibly back onto the caster. Consumed on use.
        const mark = caster.statuses.find(
          (s) => s.deflectsAttackOnSource && s.sourceId === target.id,
        );
        if (mark) {
          const destinations = otherPlayers(target.id);
          if (destinations.length > 0) {
            windVia = target.id; // the shot reaches this Air castle first
            target = destinations[Math.floor(rng() * destinations.length)]!;
            // Hurricane Lv 3: the deflected attack hits the redirected target
            // harder — a one-use damage multiplier on this activation.
            const mult = mark.deflectsAttackOnSource!.damageMult;
            if (mult) {
              addModifier(caster, {
                id: `deflect:${mark.id}:${match.tick}:${match.nextSeq()}`,
                stat: "damage",
                op: "mult",
                value: mult,
                sourceId: `deflect:${mark.sourceId}`,
                remainingTicks: null,
                usageLimit: 1,
              });
            }
            // Hurricane Lv 5: one roll to keep the mark for a second
            // deflection (1 becomes 2, never more).
            const chain = mark.deflectsAttackOnSource!.chainChance ?? 0;
            if (!mark.deflectionChained && chain > 0 && rng() < chain) {
              mark.deflectionChained = true;
            } else {
              removeStatus(caster, mark.id);
            }
          }
        }

        // A Gust of Envy (Air passive, Epic 8): attacks on this kingdom have
        // a chance to be redirected to another kingdom — attacker included.
        const redirectPct = attackRedirectChance(target);
        if (redirectPct > 0 && rng() < redirectPct) {
          const destinations = otherPlayers(target.id);
          if (destinations.length > 0) {
            if (windVia === null) windVia = target.id; // first interception point
            target = destinations[Math.floor(rng() * destinations.length)]!;
          }
        }

        // A wind redirect actually fired — record it for the deflection VFX. If
        // the shot somehow lands back on the intercepting castle, there's nothing
        // to animate, so skip it.
        if (windVia !== null && windVia !== target.id) {
          windRedirects.push({ via: windVia, to: target.id });
        }

        targets.push(target);
      }
      break;
    }
  }

  // 4a2. Second-target requirement (Love's BFFS!!!): a second, distinct,
  // player-selected enemy must accompany the primary. Validated here — before
  // anything is spent — so a mis-cast (only one kingdom chosen) rejects cleanly
  // with SECOND_TARGET_REQUIRED. The validated id rides into the effects on
  // `secondTargetId` (consumed by `linkCastles`).
  let secondTargetId: string | undefined;
  if (effective.targeting.secondTarget) {
    const primaryId = targets[0]?.id;
    const candidate = options.targetIds?.[1];
    if (!candidate || candidate === primaryId) {
      return { ok: false, error: "SECOND_TARGET_REQUIRED" };
    }
    if (candidate === caster.id) return { ok: false, error: "INVALID_TARGET" };
    const resolvedSecond = match.hasPlayer(candidate)
      ? match.gameState?.getPlayer(candidate)
      : undefined;
    if (!resolvedSecond || resolvedSecond.eliminated) {
      return { ok: false, error: "INVALID_TARGET" };
    }
    if (isTargetingBlocked(caster, candidate)) {
      return { ok: false, error: "INVALID_TARGET" };
    }
    secondTargetId = candidate;
  }

  // 4a3. Caster's choice (Dark's Yin and Yang): the cast must name one of the
  // ability's declared options. Validated before anything is spent, so a
  // malformed or missing pick rejects cleanly.
  if (effective.targeting.choices) {
    if (!options.choice || !effective.targeting.choices.includes(options.choice)) {
      return { ok: false, error: "CHOICE_REQUIRED" };
    }
  }

  // 4b. Concurrent-affected cap (Air's Thick Fog, Epic 8): fail closed while
  // the cap is full — a re-cast on an already-affected target stays legal.
  if (effective.maxConcurrentAffected) {
    const { statusId, limit } = effective.maxConcurrentAffected;
    const bearers = match.gameState!.getPlayers().filter((p) =>
      p.statuses.some((s) => s.id === statusId && s.sourceId === caster.id),
    );
    const fresh = targets.filter(
      (t) => !bearers.some((b) => b.id === t.id),
    );
    if (bearers.length + fresh.length > limit) {
      return { ok: false, error: "TARGET_LIMIT" };
    }
  }

  // 4c. Status-gated bounce (A Light Breeze under Bird's Eye View, Epic 8):
  // rebuild `targets` into a ricochet sequence *between* the selected kingdoms.
  // The first selected kingdom is struck, then each further bounce is a 50%
  // roll up to `maxLandings` landings, never repeating the previous castle.
  // Every landing keeps full damage (bounced ⇒ no multi-target spread below).
  let bounced = false;
  const bounceSpec = effective.bounce;
  if (
    bounceSpec &&
    effective.targeting.mode === "singleEnemy" &&
    caster.statuses.some((s) => s.id === bounceSpec.requiresCasterStatus)
  ) {
    // Pool = the distinct selected kingdoms resolved above (a single selection
    // has nowhere to bounce, so it stays an ordinary hit).
    const pool: PlayerState[] = [];
    for (const t of targets) if (!pool.some((p) => p.id === t.id)) pool.push(t);
    if (pool.length >= 2) {
      const sequence: PlayerState[] = [pool[0]!]; // the guaranteed first landing
      while (sequence.length < bounceSpec.maxLandings && rng() < bounceSpec.chance) {
        const last = sequence[sequence.length - 1]!;
        const candidates = pool.filter((p) => p.id !== last.id); // no repeat in a row
        if (candidates.length === 0) break;
        sequence.push(candidates[Math.floor(rng() * candidates.length)]!);
      }
      targets = sequence;
      bounced = true;
    }
  }

  // 5. All validation passed — only now spend, and arm the cooldown
  // immediately, before any effect resolves (#73, #74). Effects can never run
  // twice off one activation, even if effect execution itself re-enters.
  // Attack cooldowns honor kingdom passives (Electricity's "Don't Blink",
  // Epic 10); setCooldown then applies cooldown modifier stats (#107).
  spend(caster, castCost);
  const cooldownTicks =
    ability.kind === "attack"
      ? Math.round(effective.cooldownTicks * attackCooldownMultiplier(caster))
      : effective.cooldownTicks;
  setCooldown(caster, effective.id, cooldownTicks);

  // Kitsune's "Fox Fire": swinging fans the flames. Counted here — once the
  // cast is COMMITTED — so a rejected cast never stokes the fire, and it counts
  // whatever the attack was aimed at. Ultimates fan it too: the fire responds
  // to the kingdom acting, not to who it acted against.
  if (ability.kind === "attack" || ability.kind === "ultimate") {
    for (const fire of caster.statuses) {
      if (!fire.intensifiesOnBearerAttack) continue;
      fire.intensity = (fire.intensity ?? 1) * fire.intensifiesOnBearerAttack;
    }
  }

  // Dark's Never-ending nightmare: this attack burns one of the victim's
  // allowance. Counted here, once the cast is committed, so a rejected cast
  // never shortens the sentence — and the lock lifts the moment it runs out.
  if (ability.kind === "attack") {
    for (const nightmare of caster.statuses.filter((s) => s.basicAttacksOnly)) {
      nightmare.basicAttacksRemaining = (nightmare.basicAttacksRemaining ?? 1) - 1;
      if (nightmare.basicAttacksRemaining <= 0) {
        removeStatus(caster, nightmare.id);
        if (match.gameState!.events.enabled) {
          match.gameState!.events.emit({
            type: "statusExpired",
            tick: match.tick,
            playerId: caster.id,
            statusId: nightmare.id,
          });
        }
      }
    }
  }

  // Light's "Speed of light": casting anything hurries every OTHER ability
  // along. Applied AFTER this ability's own cooldown is armed, and skipping
  // that ability, so a cast never shortens the cooldown it just started.
  const hurry = cooldownReductionOnCast(caster);
  if (hurry > 0) {
    for (const otherId of Object.keys(caster.cooldowns)) {
      if (otherId === effective.id) continue;
      const remaining = caster.cooldowns[otherId]! - hurry;
      if (remaining <= 0) {
        delete caster.cooldowns[otherId];
        if (match.gameState!.events.enabled) {
          match.gameState!.events.emit({
            type: "cooldownReady",
            tick: match.tick,
            playerId: caster.id,
            abilityId: otherId,
          });
        }
      } else {
        caster.cooldowns[otherId] = remaining;
      }
    }
  }

  // Arm charge regeneration: spending k charges starts staggered independent
  // countdowns (1×, 2×, … k× rechargeTicks), so one charge returns every
  // rechargeTicks and unspent charges stay castable immediately.
  if (chargeSystem && chargesPlanned) {
    const timers = (caster.recharges[effective.id] ??= []);
    for (let i = 1; i <= chargesPlanned; i++) {
      timers.push(i * chargeSystem.rechargeTicks);
    }
  }

  // Gameplay event (#204): the cast is accepted and paid for — announce it.
  const castBus = match.gameState!.events;
  if (castBus.enabled) {
    castBus.emit({
      type: "abilityCast",
      tick: match.tick,
      casterId: caster.id,
      abilityId: effective.id,
      targetIds: targets.map((t) => t.id),
      cost: castCost,
      chargesUsed: chargesPlanned,
      ...(windRedirects.length > 0 ? { redirects: windRedirects } : {}),
    });
  }

  // 6. Apply each effect primitive in order, to every resolved target.
  const damage: DamageApplication[] = [];

  // A swing at the volcano ends here: the cost and cooldown are already paid
  // above, and the per-kingdom effect pipeline cannot run against a rock.
  if (volcanoStrike > 0) {
    damageVolcano(match, caster.id, volcanoStrike);

    // …but the attack is not cut in half. Anything it inflicts — a burn, a
    // freeze, anything — is laid on the mountain too, on the same chance roll
    // it would face against a castle. A DoT then burns the volcano down and is
    // credited to whoever set it, so lighting it counts toward breaking it
    // exactly as swinging at it does. Statuses with nothing to act on (a
    // freeze has no attack to stop) simply ride along inert.
    const volcanoRng = options.rng ?? match.rng;
    for (const effect of effective.effects) {
      if (effect.type !== "status" || effect.target !== "target") continue;
      const status = effect.params.status;
      if (!status) continue;
      if (
        effect.chance !== undefined &&
        !options.guaranteeChances &&
        volcanoRng() >= effect.chance
      ) {
        continue;
      }
      applyVolcanoStatus(
        match,
        caster.id,
        status,
        effect.params.durationTicks ?? 0,
        effect.params.stacks ?? 1,
      );
    }
    return { ok: true, damage: [], targetId: VOLCANO_TARGET_ID };
  }

  // Frozen Focus (Epic 11): while the caster holds guarantee stacks, an
  // attack's chance-gated effects always proc; each attack consumes a stack.
  const focus =
    ability.kind === "attack"
      ? caster.statuses.find((s) => s.guaranteesChanceEffects && s.stacks > 0)
      : undefined;
  // One journal id per activation: every effect this cast lands on a recipient
  // records under the same undoable entry (Blip). Attacks only.
  const journalId =
    ability.kind === "attack"
      ? `atk:${caster.id}:${match.tick}:${match.nextSeq()}`
      : undefined;
  const effectOptions: ActivateOptions = {
    ...options,
    ...(focus ? { guaranteeChances: true } : {}),
    ...(journalId ? { journalId } : {}),
    ...(secondTargetId ? { secondTargetId } : {}),
    ...(options.choice ? { choice: options.choice } : {}),
  };

  // Resolve targeting modifiers (ticket #109)
  const duplicateCount = Math.max(1, Math.round(computeStat(caster, "duplicateAttackCount", 1)));
  const extraTargetsCount = Math.max(0, Math.round(computeStat(caster, "extraTargetsCount", 0)));

  // Air's "Embrace of Winds" (Epic 8): a multi-target attack divides its
  // damage evenly across the kingdoms it strikes — a re-cast on one kingdom is
  // spread 1 (unchanged). Only the multi-target singleEnemy path can resolve
  // more than one primary target, so every other attack keeps full damage.
  // Non-damage effects (status, heal, …) still apply in full to each target.
  // A bounce chain deals full damage per landing (each is its own gust), so it
  // never spreads; otherwise Embrace of Winds divides across the kingdoms hit.
  // Dark's Infinitum tenebrae grants multi-target WITHOUT the spread: every
  // kingdom struck takes the attack in full.
  const damageSpread =
    bounced || !splitsMultiTargetDamage(caster)
      ? 1
      : effective.targeting.mode === "singleEnemy"
        ? Math.max(1, targets.length)
        : 1;

  for (let i = 0; i < duplicateCount; i++) {
    // Apply to each resolved target
    for (const target of targets) {
      // The CASTER may simply fumble it (Insects' "Butterflies" makes its
      // victim inaccurate). Rolled before the defender's own dodge, because
      // a swing that was never on target cannot also be evaded — and because
      // a fumble can rebound onto the caster, which a dodge never does.
      if (
        effective.kind === "attack" &&
        target.id !== caster.id &&
        fumbleOwnAttack(match, effective, caster, target, effectOptions, damage)
      ) {
        continue;
      }
      // An attack may miss entirely — none of its effects land (Orion's Belt
      // feeding the bearer's Supernova meter, or Joker's shielded luck). Only
      // offensive attacks against another kingdom can be dodged.
      if (
        effective.kind === "attack" &&
        target.id !== caster.id &&
        maybeMissAttack(match, caster, target, effective.id, effectOptions)
      ) {
        continue;
      }
      for (const effect of effective.effects) {
        // Aftershock-style splash (Epic 9): this effect hits every living
        // enemy except the struck target, targeting bans respected.
        if (effect.target === "otherEnemies") {
          const others = match.gameState!.getPlayers().filter(
            (p) =>
              p.id !== caster.id &&
              p.id !== target.id &&
              !p.eliminated &&
              !isTargetingBlocked(caster, p.id),
          );
          for (const other of others) {
            applyEffect(match, effective.id, caster, other, other, effect, effectOptions, damage);
          }
          continue;
        }
        // Field-wide effects hit every living kingdom — no targeting bans,
        // because these are not aimed at anyone. `allPlayers` includes the
        // caster; `allEnemies` spares them (Light's Flash Bang goes off in
        // their hand, so Light is the one kingdom expecting it).
        if (effect.target === "allPlayers" || effect.target === "allEnemies") {
          const sparesCaster = effect.target === "allEnemies";
          for (const everyone of match.gameState!.getPlayers()) {
            if (everyone.eliminated) continue;
            if (sparesCaster && everyone.id === caster.id) continue;
            applyEffect(match, effective.id, caster, everyone, everyone, effect, effectOptions, damage);
          }
          continue;
        }
        const recipient = effect.target === "self" ? caster : target;
        applyEffect(match, effective.id, caster, target, recipient, effect, effectOptions, damage, damageSpread);
      }
    }

    // Apply to extra random enemy targets (multi-target modifier)
    if (extraTargetsCount > 0 && effective.targeting.mode === "singleEnemy") {
      const otherEnemies = match.gameState!.getPlayers().filter((p) => {
        return p.id !== caster.id && !targets.some((t) => t.id === p.id) && !p.eliminated && !isTargetingBlocked(caster, p.id);
      });
      const chosenEnemies = otherEnemies.slice(0, extraTargetsCount);
      for (const extraTarget of chosenEnemies) {
        for (const effect of effective.effects) {
          // Splash effects already covered every other enemy above.
          if (effect.target === "otherEnemies") continue;
          const recipient = effect.target === "self" ? caster : extraTarget;
          applyEffect(match, effective.id, caster, extraTarget, recipient, effect, effectOptions, damage);
        }
      }
    }
  }

  // One guarantee stack is spent per attack (Frozen Focus, Epic 11).
  if (focus) {
    focus.stacks -= 1;
    if (focus.stacks <= 0) removeStatus(caster, focus.id);
  }

  // Clean up any statuses that are now exhausted (modifiers consumed), e.g.
  // Blazing Determination once its buffed strike lands. Report each as expired
  // so VFX/replays learn the buff ended by being USED, not by timing out.
  const pruneBus = match.gameState!.events;
  const emitExpired = (playerId: string, exhausted: ReturnType<typeof pruneExhaustedStatuses>) => {
    if (!pruneBus.enabled) return;
    for (const s of exhausted) {
      pruneBus.emit({ type: "statusExpired", tick: match.tick, playerId, statusId: s.id });
    }
  };
  emitExpired(caster.id, pruneExhaustedStatuses(caster));
  for (const target of targets) emitExpired(target.id, pruneExhaustedStatuses(target));

  return { ok: true, damage, targetId: targets[0]!.id };
}

/** Executes one effect primitive on its recipient. `damageSpread` divides a
 *  damage effect's base amount across a multi-target attack's kingdoms (Air,
 *  Epic 8); it defaults to 1 and only affects the `damage` effect type. */
function applyEffect(
  match: Match,
  abilityId: string,
  caster: PlayerState,
  target: PlayerState,
  recipient: PlayerState,
  effect: EffectDefinition,
  options: ActivateOptions,
  damage: DamageApplication[],
  damageSpread = 1,
): void {
  // Check condition validations (ticket #101)
  if (effect.conditions) {
    const allMet = effect.conditions.every((c) =>
      evaluateCondition(c, caster, target),
    );
    if (!allMet) return;
  }

  // Check chance probability (ticket #102); Frozen Focus guarantees skip the
  // roll entirely (Epic 11).
  if (effect.chance !== undefined && !options.guaranteeChances) {
    const rng = options.rng ?? match.rng;
    if (rng() >= effect.chance) return;
  }

  const p = effect.params;
  // Gameplay events (#204). Emissions are fire-and-forget and guarded on
  // bus.enabled so unmonitored matches allocate nothing here.
  const bus = match.gameState!.events;

  // Space's Black Hole (ultimate): while it is open, every hostile effect aimed
  // at another kingdom is swallowed. Damage effects pool their damage into the
  // hole inside their own case below (they need the resolved figure); every
  // other harmful effect (debuffs/statuses) simply never lands here. Effects on
  // the caster itself (self-buffs) are untouched. The caster is recorded as the
  // "last to attack the hole", which decides who takes the collapse dump.
  const blackHole = match.gameState!.blackHole;
  const blackHoleOpen = blackHole !== null && match.tick < blackHole.endTick;
  if (
    blackHoleOpen &&
    recipient.id !== caster.id &&
    effect.type !== "damage" &&
    effect.type !== "supernovaBlast"
  ) {
    blackHole!.lastAttackerId = caster.id;
    return;
  }

  const emitDamage = (
    targetId: string,
    sourceId: string,
    applied: DamageApplication,
    crit: boolean,
    cause: string,
  ): void => {
    if (!bus.enabled) return;
    bus.emit({
      type: "damage",
      tick: match.tick,
      sourceId,
      targetId,
      amount: applied.absorbedByShield + applied.dealtToHp,
      absorbedByShield: applied.absorbedByShield,
      dealtToHp: applied.dealtToHp,
      overkill: applied.incoming - applied.absorbedByShield - applied.dealtToHp,
      crit,
      element: p.element,
      cause,
    });
    const bearer = match.gameState!.getPlayer(targetId);
    if (applied.absorbedByShield > 0 && bearer && bearer.castle.shield <= 0) {
      bus.emit({ type: "shieldDestroyed", tick: match.tick, playerId: targetId, cause });
    }
  };
  const emitStatusApplied = (
    targetId: string,
    sourceId: string,
    instance: { id: string; remainingTicks: number; stacks: number },
  ): void => {
    if (!bus.enabled) return;
    bus.emit({
      type: "statusApplied",
      tick: match.tick,
      targetId,
      sourceId,
      statusId: instance.id,
      durationTicks: instance.remainingTicks,
      stacks: instance.stacks,
    });
  };
  switch (effect.type) {
    case "damage": {
      // Multi-target attacks spread their listed damage evenly across the
      // kingdoms struck (Air, Epic 8); a per-target conditional bonus applies
      // in full to whoever qualifies. resolveDamage rounds the final figure.
      let baseAmount = (p.amount ?? 0) / damageSpread;
      if (
        p.bonusDamageIfTargetHasStatus &&
        hasStatus(recipient, p.bonusDamageIfTargetHasStatus.statusId)
      ) {
        baseAmount += p.bonusDamageIfTargetHasStatus.extraAmount;
      }

      const resolved = resolveDamage(caster, recipient, baseAmount, {
        element: p.element,
        elementMultiplier: p.elementMultiplier,
        forceCrit: options.forceCrit,
        rng: options.rng,
        ignoreShields: p.ignoreShields,
        shieldDamageMultiplier: p.shieldDamageMultiplier,
        shieldDamageOverflow: p.shieldDamageOverflow,
        // "Besieged" comeback: the caster hits harder the more kingdoms are
        // ganged up on it right now (universal, live from targeting state).
        besiegedMultiplier: besiegedDamageMultiplier(
          caster,
          match.gameState!.getPlayers(),
        ),
        // Time's "Longevity": attack scales up, and the recipient's defense
        // scales down, with match time elapsed. Water's "Fountain of Youth"
        // also cuts damage from named DoT-ish abilities (e.g. Meteor Shower).
        attackerScalingMultiplier: scalingAttackMultiplier(caster, match.tick),
        defenderScalingTakenMultiplier:
          scalingDamageTakenMultiplier(recipient, match.tick) *
          dotResistanceMultiplier(recipient, abilityId),
      });
      // Black Hole swallows the hit: pool the damage instead of landing it.
      if (blackHoleOpen && recipient.id !== caster.id) {
        absorbIntoBlackHole(match, blackHole!, caster.id, resolved.amount);
        break;
      }
      // Love Galore (Love ultimate): incoming damage never lands — it's fully
      // negated and converted into healing for the bearer instead. Two-phase
      // when `revealsBeforeExpiry`: during the STEALTH phase the heal is silent
      // and enemies see a phantom damage number (they don't know they're
      // feeding Love); once the healing threshold is crossed it REVEALS, and
      // thereafter every hit shows as visible healing (handled by the status's
      // time-based reveal in `tickStatuses` too).
      const galore = recipient.statuses.find((s) => s.negateDamageHealPct);
      if (galore && recipient.id !== caster.id) {
        const requested = Math.round(resolved.amount * galore.negateDamageHealPct!);
        const healed = healCastle(recipient, requested);
        galore.healAccumulated = (galore.healAccumulated ?? 0) + healed;
        const stealth = galore.revealsBeforeExpiry === true && galore.revealed !== true;
        if (stealth) {
          // Decoy: a normal-looking damage number for everyone but the bearer.
          if (bus.enabled) {
            bus.emit({
              type: "damage",
              tick: match.tick,
              sourceId: caster.id,
              targetId: recipient.id,
              amount: resolved.amount,
              absorbedByShield: 0,
              dealtToHp: 0,
              overkill: 0,
              crit: resolved.crit,
              element: p.element,
              cause: abilityId,
              phantom: true,
            });
          }
          // Early reveal: enough damage has secretly been turned into healing.
          if (
            galore.revealHealThreshold !== undefined &&
            galore.healAccumulated >= galore.revealHealThreshold
          ) {
            galore.revealed = true;
            galore.remainingTicks = galore.initialDurationTicks ?? galore.remainingTicks;
            if (bus.enabled) {
              bus.emit({ type: "statusRevealed", tick: match.tick, playerId: recipient.id, statusId: galore.id });
            }
          }
        } else if (bus.enabled) {
          bus.emit({ type: "heal", tick: match.tick, targetId: recipient.id, amount: healed, overheal: requested - healed, cause: "loveGalore" });
        }
        shareHealGlobally(match, recipient, healed);
        break;
      }
      // Love's Cupid's Arrow: each "infatuated" kingdom (bearer.sourceId ===
      // recipient.id) absorbs a REDIRECTED share of what would be Love's
      // damage — Love only takes what's left over, not the full hit plus an
      // extra one on top. Computed before Love's own applyDamage so the split
      // is real, not additive.
      let loveAmount = resolved.amount;
      const infatuatedRedirects: { bearer: PlayerState; amount: number }[] = [];
      if (recipient.id !== caster.id) {
        for (const other of match.gameState!.getPlayers()) {
          if (other.eliminated || other.id === recipient.id) continue;
          const mark = other.statuses.find(
            (s) => s.sourceId === recipient.id && s.bearerTakesPctOfSourceDamage,
          );
          if (!mark) continue;
          const share = Math.round(resolved.amount * mark.bearerTakesPctOfSourceDamage!);
          if (share > 0) {
            infatuatedRedirects.push({ bearer: other, amount: share });
            loveAmount -= share;
          }
        }
        loveAmount = Math.max(0, loveAmount);
      }

      const applied = applyDamage(recipient, loveAmount, {
        ignoreShields: p.ignoreShields,
        tick: match.tick,
      });
      damage.push(applied);
      // Landing a damaging active attack refreshes the caster's "last dealt
      // damage" clock — this is what resets Father Time's idle countdown.
      if (applied.absorbedByShield + applied.dealtToHp > 0) {
        caster.lastDamageDealtTick = match.tick;
        // Journal this attack against the recipient so Blip can undo it.
        if (options.journalId && recipient.id !== caster.id) {
          const rec = journalRecordFor(recipient, options.journalId, caster.id, abilityId, match.tick);
          rec.hpRefund += applied.dealtToHp;
          rec.shieldRefund += applied.absorbedByShield;
        }
      }
      emitDamage(recipient.id, caster.id, applied, resolved.crit, abilityId);

      // Love's "BFFS!!!" link: damage landing on a linked castle also lands
      // on its partner in full (single hop — a raw applyDamage call, so the
      // partner's own link never re-triggers a mirror-of-a-mirror). Mirrors
      // the attack's original figure, independent of any infatuation split.
      const bffsLink = recipient.statuses.find((s) => s.linkedPartnerId);
      if (bffsLink) {
        const partner = match.gameState!.getPlayer(bffsLink.linkedPartnerId!);
        if (partner && !partner.eliminated && partner.id !== caster.id) {
          const mirroredApplied = applyDamage(partner, resolved.amount, { tick: match.tick });
          damage.push(mirroredApplied);
          emitDamage(partner.id, caster.id, mirroredApplied, resolved.crit, `linked:${abilityId}`);
        }
      }

      // Apply each infatuated kingdom's redirected share.
      for (const r of infatuatedRedirects) {
        const shared = applyDamage(r.bearer, r.amount, { tick: match.tick });
        damage.push(shared);
        emitDamage(r.bearer.id, recipient.id, shared, false, "infatuated");
      }

      // Conditional lifesteal (#85): heal the caster for a ratio of the
      // damage dealt (shield + HP), gated on a target status when configured.
      const steal = p.lifesteal;
      if (
        steal &&
        (!steal.requiresTargetStatus ||
          hasStatus(recipient, steal.requiresTargetStatus))
      ) {
        const dealt = applied.absorbedByShield + applied.dealtToHp;
        const requested = Math.round(dealt * steal.ratio);
        const healed = healCastle(caster, requested);
        if (healed > 0 && bus.enabled) {
          bus.emit({ type: "heal", tick: match.tick, targetId: caster.id, amount: healed, overheal: requested - healed, cause: `lifesteal:${abilityId}` });
        }
        shareHealGlobally(match, caster, healed);
      }

      // Distraught (Earth passive, Epic 9): dealing damage slowly rebuilds
      // the caster's shield — a fraction of the damage dealt. It only tops up an
      // ACTIVE shield; with no shield standing it regenerates nothing (the
      // passive repairs a shield, it never conjures one from nothing).
      const shieldRegen = shieldOnDamageDealt(caster);
      if (shieldRegen > 0 && recipient.id !== caster.id && caster.castle.shield > 0) {
        const dealt = applied.absorbedByShield + applied.dealtToHp;
        const regen = Math.round(dealt * shieldRegen);
        caster.castle.shield += regen;
        if (regen > 0 && bus.enabled) {
          bus.emit({ type: "shieldGained", tick: match.tick, playerId: caster.id, amount: regen, total: caster.castle.shield, cause: "shieldOnDamageDealt" });
        }
      }

      // AfterShock (Electricity passive, Epic 10): attacks have a chance to
      // deal a fraction of the hit as bonus damage after hitting.
      const aftershock = attackAftershock(caster);
      if (aftershock && recipient.id !== caster.id) {
        const rng = options.rng ?? match.rng;
        if (rng() < aftershock.chance) {
          const bonus = applyDamage(
            recipient,
            Math.round(resolved.amount * aftershock.pct),
            { ignoreShields: p.ignoreShields, tick: match.tick },
          );
          damage.push(bonus);
          emitDamage(recipient.id, caster.id, bonus, false, "aftershock");
        }
      }

      // Cold Embrace / Frostbite (Ice passives, Epic 11): chance-based status
      // procs — on-hit against the victim (honors Frozen Focus guarantees)
      // and retaliation against the attacker.
      if (recipient.id !== caster.id) {
        const procRng = options.rng ?? match.rng;
        for (const proc of onHitStatuses(caster)) {
          if (options.guaranteeChances || procRng() < proc.chance) {
            const inst = applyStatus(recipient, proc.status, {
              sourceId: caster.id,
              durationTicks: proc.durationTicks,
            });
            emitStatusApplied(recipient.id, caster.id, inst);
          }
        }
        // Status-granted on-hit riders (Dark's Infinitum tenebrae darkening
        // every screen it touches). Unlike the passive procs above these are
        // certain — the buff was paid for, so it does not also roll dice.
        for (const rider of attackInflictedStatuses(caster)) {
          const inst = applyStatus(recipient, rider.status, {
            sourceId: caster.id,
            durationTicks: rider.durationTicks,
          });
          emitStatusApplied(recipient.id, caster.id, inst);
        }
        for (const proc of retaliations(recipient)) {
          if (procRng() < proc.chance) {
            const inst = applyStatus(caster, proc.status, {
              sourceId: recipient.id,
              durationTicks: proc.durationTicks,
            });
            emitStatusApplied(caster.id, recipient.id, inst);
          }
        }

        // Poison Apple-style marks (Epic 12): a status on the victim strikes
        // back with a status on the attacker, consumed on use.
        for (const mark of [...recipient.statuses]) {
          if (mark.onHitRetaliate) {
            const inst = applyStatus(caster, mark.onHitRetaliate.status, {
              sourceId: recipient.id,
              durationTicks: mark.onHitRetaliate.durationTicks,
            });
            emitStatusApplied(caster.id, recipient.id, inst);
            // Extra riders applied with the mark (Poison Apple also poisons the
            // biter's citizens).
            for (const extra of mark.onHitRetaliateExtra ?? []) {
              const rider = applyStatus(caster, extra.status, {
                sourceId: recipient.id,
                durationTicks: extra.durationTicks,
              });
              emitStatusApplied(caster.id, recipient.id, rider);
            }
            removeStatus(recipient, mark.id);
          }
        }

        // No Rose Without Thorns (Nature passive, Epic 12): attackers risk
        // receiving a fraction of the damage they dealt reflected back.
        for (const t of thornsProcs(recipient)) {
          if (procRng() < t.chance) {
            const dealt = applied.absorbedByShield + applied.dealtToHp;
            const reflected = applyDamage(caster, Math.round(dealt * t.pct), { tick: match.tick });
            damage.push(reflected);
            emitDamage(caster.id, recipient.id, reflected, false, "thorns");
          }
        }

        // Have some Empathy! (Love utility): unconditional reflection while
        // active — every hit gives a fraction straight back, no chance roll.
        const empathyPct = recipient.statuses.find((s) => s.thornsPct)?.thornsPct;
        if (empathyPct) {
          const dealt = applied.absorbedByShield + applied.dealtToHp;
          const reflected = applyDamage(caster, Math.round(dealt * empathyPct), { tick: match.tick });
          damage.push(reflected);
          emitDamage(caster.id, recipient.id, reflected, false, "empathy");
        }
      }
      break;
    }
    case "heal": {
      const flat = p.amount ?? 0;
      const pct = p.percentMaxHp
        ? recipient.castle.maxHp * p.percentMaxHp
        : 0;
      const requested = Math.round(flat + pct);
      const healed = healCastle(recipient, requested);
      if (healed > 0 && bus.enabled) {
        bus.emit({ type: "heal", tick: match.tick, targetId: recipient.id, amount: healed, overheal: requested - healed, cause: abilityId });
      }
      shareHealGlobally(match, recipient, healed);
      break;
    }
    case "shield": {
      const granted = Math.max(0, Math.round(p.amount ?? 0));
      recipient.castle.shield += granted;
      if (granted > 0 && bus.enabled) {
        bus.emit({ type: "shieldGained", tick: match.tick, playerId: recipient.id, amount: granted, total: recipient.castle.shield, cause: abilityId });
      }
      break;
    }
    case "status":
      if (p.status) {
        // A shield can repel a status outright: Light's Fireflies never settle
        // on a shielded castle, so a defended kingdom is never put to the
        // ransom. The ability's damage has already landed regardless.
        //
        // This is announced rather than silent — without it the caster sees an
        // ability apparently do nothing, and the defender never learns their
        // shield is what saved them.
        if (p.status.repelledByShield && recipient.castle.shield > 0) {
          if (bus.enabled) {
            bus.emit({
              type: "statusRepelled",
              tick: match.tick,
              playerId: recipient.id,
              sourceId: caster.id,
              statusId: p.status.id,
              abilityId,
              cause: "shield",
            });
          }
          break;
        }
        // Conditional duration bonus (#86): e.g. Flood lasts longer against
        // Current-affected targets. Checked before application so an ability
        // applying the prerequisite itself must order its effects accordingly.
        const bonus = p.bonusDurationIfTargetHasStatus;
        const extra =
          bonus && hasStatus(recipient, bonus.statusId) ? bonus.extraTicks : 0;
        const inst = applyStatus(recipient, p.status, {
          sourceId: caster.id,
          durationTicks: (p.durationTicks ?? 0) + extra,
          stacks: p.stacks,
        });
        // Journal the status against the recipient so Blip can strip it (and
        // refund its DoT) when it undoes this attack.
        if (options.journalId && recipient.id !== caster.id) {
          const rec = journalRecordFor(recipient, options.journalId, caster.id, abilityId, match.tick);
          if (!rec.statusIds.includes(inst.id)) rec.statusIds.push(inst.id);
          inst.journalId = options.journalId;
        }
        // Love's "Love Galore": arm the early-reveal healing threshold so it
        // scales with the ability's upgrade tier.
        if (p.revealHealThreshold !== undefined) {
          inst.revealHealThreshold = p.revealHealThreshold;
        }
        emitStatusApplied(recipient.id, caster.id, inst);

        // Love's Cupid's Arrow: alongside "infatuated", borrow citizens from
        // the recipient — returned automatically when the status expires
        // naturally (see tickStatuses).
        if (p.borrowCitizens && recipient.id !== caster.id) {
          const loaned = Math.min(p.borrowCitizens, recipient.economy.citizens);
          if (loaned > 0) {
            recipient.economy.citizens -= loaned;
            caster.economy.citizens += loaned;
            recalcIncome(recipient);
            recalcIncome(caster);
            inst.citizenLoanAmount = loaned;
            if (bus.enabled) {
              bus.emit({ type: "resourceTransfer", tick: match.tick, fromId: recipient.id, toId: caster.id, resource: "citizens", amount: loaned, cause: abilityId });
            }
          }
        }

        // Love's "BFFS!!!" link: any status landing on a linked castle also
        // lands on its partner (single hop — a raw applyStatus call, so the
        // partner's own link never re-triggers a mirror-of-a-mirror).
        const link = recipient.statuses.find((s) => s.linkedPartnerId);
        if (link) {
          const partner = match.gameState!.getPlayer(link.linkedPartnerId!);
          if (partner && !partner.eliminated && partner.id !== recipient.id) {
            const mirrored = applyStatus(partner, p.status, {
              sourceId: caster.id,
              durationTicks: (p.durationTicks ?? 0) + extra,
              stacks: p.stacks,
            });
            emitStatusApplied(partner.id, caster.id, mirrored);
          }
        }
      }
      break;
    case "economyModifier": {
      // Citizen adjustments (#90): percent of the current count plus a flat
      // delta, never below zero; income refreshes immediately.
      const current = recipient.economy.citizens;
      const next = Math.max(
        0,
        Math.round(current * (1 + (p.citizensPercent ?? 0))) +
          (p.citizensFlat ?? 0),
      );
      recipient.economy.citizens = next;
      recalcIncome(recipient);
      if (next !== current && bus.enabled) {
        bus.emit({ type: "citizensChanged", tick: match.tick, playerId: recipient.id, delta: next - current, total: next, cause: abilityId });
      }
      break;
    }
    case "buff":
    case "debuff":
      if (p.stat && p.op && p.value !== undefined) {
        // Timed buffs honor the caster's "buffDuration:<stat>" modifiers
        // (Epic 10, e.g. Lightning Charges lasting longer at Barrage Lv 3).
        const baseTicks = p.modifierTicks ?? null;
        addModifier(recipient, {
          id: `${caster.id}:${p.stat}:${match.tick}:${match.nextSeq()}`,
          stat: p.stat,
          op: p.op,
          value: p.value,
          sourceId: caster.id,
          remainingTicks:
            baseTicks === null
              ? null
              : Math.max(1, Math.round(computeStat(caster, `buffDuration:${p.stat}`, baseTicks))),
        });
      }
      break;
    case "resourceTransfer": {
      const transfer = p.resourceTransfer;
      if (!transfer) break;

      if (transfer.type === "currency") {
        let amount = transfer.amount ?? 0;
        if (transfer.percent !== undefined) {
          amount += Math.floor(recipient.economy.currency * transfer.percent);
        }
        amount = Math.max(0, amount);

        const actualSteal = Math.min(recipient.economy.currency, amount);
        if (actualSteal > 0) {
          recipient.economy.currency -= actualSteal;
          caster.economy.currency += actualSteal;
          if (bus.enabled) {
            bus.emit({ type: "resourceTransfer", tick: match.tick, fromId: recipient.id, toId: caster.id, resource: "currency", amount: actualSteal, cause: abilityId });
          }
        }
      } else if (transfer.type === "citizens") {
        let amount = transfer.amount ?? 0;
        if (transfer.percent !== undefined) {
          amount += Math.floor(recipient.economy.citizens * transfer.percent);
        }
        amount = Math.max(0, amount);

        const actualSteal = Math.min(recipient.economy.citizens, amount);
        if (actualSteal > 0) {
          recipient.economy.citizens -= actualSteal;
          caster.economy.citizens += actualSteal;
          // The citizen price ladder travels with the stolen citizens: the
          // victim steps back down the cost curve (rebuying what was taken
          // isn't double-priced) and the thief climbs it by the same amount,
          // conserving total purchase pressure. Clamped — you can't inherit
          // more "purchases" than the victim had actually made.
          const purchasedMoved = Math.min(
            actualSteal,
            recipient.economy.citizensPurchased,
          );
          recipient.economy.citizensPurchased -= purchasedMoved;
          caster.economy.citizensPurchased += purchasedMoved;
          recalcIncome(caster);
          recalcIncome(recipient);
          if (bus.enabled) {
            bus.emit({ type: "resourceTransfer", tick: match.tick, fromId: recipient.id, toId: caster.id, resource: "citizens", amount: actualSteal, cause: abilityId });
          }
        }
      }
      break;
    }
    case "cooldownModify": {
      const mod = p.cooldownModify;
      if (!mod) break;

      const abilityIds = Object.keys(recipient.cooldowns).filter((id) => {
        if (mod.target === "all") return true;
        if (mod.target === id) return true;

        const def = ALL_ABILITIES[id];
        if (!def) return false;

        if (mod.target === "attacks" && def.kind === "attack") return true;
        if (mod.target === "utilities" && def.kind === "utility") return true;
        if (mod.target === "ultimates" && def.kind === "ultimate") return true;

        return false;
      });

      for (const id of abilityIds) {
        const current = recipient.cooldowns[id];
        if (current !== undefined) {
          let next = current;
          if (mod.op === "set") {
            next = mod.value;
          } else if (mod.op === "add") {
            next += mod.value;
          } else if (mod.op === "multiply") {
            next = Math.round(next * mod.value);
          }

          if (next <= 0) {
            delete recipient.cooldowns[id];
          } else {
            recipient.cooldowns[id] = next;
          }
        }
      }
      break;
    }
    case "vision": {
      const vis = p.vision;
      if (!vis) break;
      const statusDef = {
        id: `vision:${vis.type}`,
        category: "debuff" as const,
        stacking: "refresh" as const,
      };
      applyStatus(recipient, statusDef, {
        sourceId: caster.id,
        durationTicks: vis.durationTicks,
      });
      break;
    }
    case "undoLastAttack": {
      // Blip! — rewind the most recent attack that affected the caster: heal
      // back its HP damage, restore the shield it absorbed, and strip the
      // statuses it applied (their attributed DoT is already in hpRefund).
      const record = caster.attackJournal.pop();
      if (!record) break; // nothing to undo — the ability simply fizzles
      const healed = healCastle(caster, record.hpRefund);
      caster.castle.shield += record.shieldRefund;
      const removed: string[] = [];
      for (const sid of record.statusIds) {
        const inst = caster.statuses.find(
          (s) => s.id === sid && s.journalId === record.id,
        );
        if (inst && removeStatus(caster, sid)) removed.push(sid);
      }
      shareHealGlobally(match, caster, healed);
      if (bus.enabled) {
        if (healed > 0) {
          bus.emit({
            type: "heal",
            tick: match.tick,
            targetId: caster.id,
            amount: healed,
            overheal: record.hpRefund - healed,
            cause: "blip",
          });
        }
        for (const sid of removed) {
          bus.emit({ type: "statusExpired", tick: match.tick, playerId: caster.id, statusId: sid });
        }
        bus.emit({
          type: "attackUndone",
          tick: match.tick,
          playerId: caster.id,
          sourceId: record.sourceId,
          abilityId: record.abilityId,
          removedStatusIds: removed,
        });
      }
      break;
    }
    case "smokeScreen": {
      // Magma's Smoke Screen: everyone currently aiming at Magma is blinded and
      // singed. Untargeted — the victims are chosen by their OWN targeting, so
      // a kingdom that has already looked away is untouched.
      for (const other of match.gameState!.getPlayers()) {
        if (other.id === caster.id || other.eliminated) continue;
        if (other.target !== caster.id) continue;

        if ((p.targeterDamage ?? 0) > 0) {
          const applied = applyDamage(other, p.targeterDamage!, { tick: match.tick });
          damage.push(applied);
          emitDamage(other.id, caster.id, applied, false, abilityId);
        }
        if (p.status) {
          const inst = applyStatus(other, p.status, {
            sourceId: caster.id,
            durationTicks: p.durationTicks ?? 0,
          });
          emitStatusApplied(other.id, caster.id, inst);
        }
      }
      break;
    }

    case "spawnCaprice": {
      // Insects' "Caprice". Field-wide and untargeted: it does not care who the
      // caster was pointing at, because in a moment nobody will be pointing
      // anywhere on purpose.
      spawnCaprice(
        match,
        caster.id,
        p.durationTicks ?? 0,
        p.scrambleTicks ?? INSECTS.CAPRICE_SCRAMBLE_SECONDS * TICK.RATE,
      );
      break;
    }

    case "spawnVolcano": {
      spawnVolcano(match, caster.id, p.durationTicks ?? 0);
      break;
    }

    case "lavaFloor": {
      // Magma's "Floor is Lava": set the whole battlefield alight. Field-wide
      // and untargeted — every burn on it hits harder, including burns on
      // Magma and burns set by other kingdoms.
      const state = match.gameState!;
      state.lavaFloor = {
        ownerId: caster.id,
        endTick: match.tick + (p.durationTicks ?? 0),
        multiplier: p.burnMultiplier ?? 1,
      };
      if (bus.enabled) {
        bus.emit({
          type: "lavaFloorLit",
          tick: match.tick,
          ownerId: caster.id,
          durationTicks: p.durationTicks ?? 0,
          multiplier: p.burnMultiplier ?? 1,
        });
      }
      break;
    }

    case "spendMemory": {
      // Kitsune Rush empties the meter it was paid for. An effect rather than a
      // price because gold is not involved at all — Memory IS the currency.
      caster.ancientMemory = 0;
      break;
    }

    case "chargeMemory": {
      // Kitsune's Fox Swipe: a flat top-up on top of whatever "Swift Tails"
      // already credits from the damage itself.
      creditMemoryDirect(caster, p.memoryCharge ?? 0);
      break;
    }

    case "foxSiege": {
      // Kitsune's "Old Friends". The foxes do one of two completely different
      // things depending on what they find:
      //
      //  • a shield up   — they tear at it for a fixed amount and leave. None
      //    of it carries over, so this is wasted on a fresh shield and lethal
      //    to a worn one.
      //  • no shield     — they move in and GNAW. The status has no duration:
      //    the only way to be rid of them is to put a shield up (see
      //    `endsOnShieldPurchase` in purchases.ts), and every tick they are
      //    left alone feeds Kitsune's Ancient Memory.
      if (recipient.castle.shield > 0) {
        // The bite is DAMAGE, so it runs the ordinary damage pipeline: Sharper
        // Swords, Sharper Axes, kingdom passives, Besieged and crits all apply,
        // and any future attacker buff does too without touching this code.
        // Only its DESTINATION is unusual — `shieldOnly` spends the whole
        // figure on the shield with nothing carrying into castle HP.
        const resolved = resolveDamage(caster, recipient, p.shieldOnlyAmount ?? 0, {
          element: p.element,
          forceCrit: options.forceCrit,
          rng: options.rng,
          besiegedMultiplier: besiegedDamageMultiplier(
            caster,
            match.gameState!.getPlayers(),
          ),
          attackerScalingMultiplier: scalingAttackMultiplier(caster, match.tick),
          defenderScalingTakenMultiplier:
            scalingDamageTakenMultiplier(recipient, match.tick) *
            dotResistanceMultiplier(recipient, abilityId),
        });
        const applied = applyDamage(recipient, resolved.amount, {
          tick: match.tick,
          shieldOnly: true,
        });
        damage.push(applied);
        emitDamage(recipient.id, caster.id, applied, resolved.crit, abilityId);
        if (applied.shieldRemaining <= 0 && bus.enabled) {
          bus.emit({
            type: "shieldDestroyed",
            tick: match.tick,
            playerId: recipient.id,
            cause: abilityId,
          });
        }
        break;
      }
      if (p.status) {
        const inst = applyStatus(recipient, p.status, {
          sourceId: caster.id,
          // No duration: it ends when a shield goes up, not when a clock does.
          durationTicks: p.durationTicks ?? 0,
        });
        emitStatusApplied(recipient.id, caster.id, inst);
      }
      break;
    }

    case "chargeSupernova": {
      // Space's Shooting Star / Saturn's Rings add progress to the caster's
      // Supernova meter, capped at a full charge (max level). The meter can't
      // fill at all until Supernova itself is unlocked — there'd be nothing to
      // spend the charge on, and it would otherwise look "ready" the moment a
      // fresh Space player lands their first basic attack.
      if (!caster.unlocked.supernova) break;
      const add = p.supernovaCharge ?? 0;
      if (add <= 0) break;
      const before = caster.supernovaMeter;
      caster.supernovaMeter = Math.min(supernovaMaxMeter(), before + add);
      if (bus.enabled && caster.supernovaMeter !== before) {
        bus.emit({
          type: "supernovaCharged",
          tick: match.tick,
          playerId: caster.id,
          meter: caster.supernovaMeter,
          level: supernovaLevel(caster.supernovaMeter),
        });
      }
      break;
    }
    case "supernovaBlast": {
      // Fires at the caster's CURRENT meter level (no level selection). L0 is
      // gated out at validation. Damage comes from the per-level table; the
      // meter is fully consumed on fire.
      const level = supernovaLevel(caster.supernovaMeter);
      if (level < 1) break; // safety — validation already blocks a dry cast
      const dmgTable = p.supernovaDamageByLevel ?? [];
      const baseAmount = dmgTable[level - 1] ?? 0;
      caster.supernovaMeter = 0;
      if (bus.enabled) {
        bus.emit({
          type: "supernovaFired",
          tick: match.tick,
          playerId: caster.id,
          targetId: recipient.id,
          level,
        });
      }

      const resolved = resolveDamage(caster, recipient, baseAmount, {
        element: p.element,
        forceCrit: options.forceCrit,
        rng: options.rng,
        besiegedMultiplier: besiegedDamageMultiplier(
          caster,
          match.gameState!.getPlayers(),
        ),
        attackerScalingMultiplier: scalingAttackMultiplier(caster, match.tick),
        defenderScalingTakenMultiplier: scalingDamageTakenMultiplier(recipient, match.tick),
      });
      // Black Hole swallows even a Supernova aimed into it.
      if (blackHoleOpen && recipient.id !== caster.id) {
        absorbIntoBlackHole(match, blackHole!, caster.id, resolved.amount);
        break;
      }
      const applied = applyDamage(recipient, resolved.amount, { tick: match.tick });
      damage.push(applied);
      if (applied.absorbedByShield + applied.dealtToHp > 0) {
        caster.lastDamageDealtTick = match.tick;
        if (options.journalId && recipient.id !== caster.id) {
          const rec = journalRecordFor(recipient, options.journalId, caster.id, abilityId, match.tick);
          rec.hpRefund += applied.dealtToHp;
          rec.shieldRefund += applied.absorbedByShield;
        }
      }
      emitDamage(recipient.id, caster.id, applied, resolved.crit, abilityId);

      // L2/L3: chance to force every OTHER kingdom onto the victim and lock the
      // selection for `redirectDurationTicks`. The victim itself is untouched.
      const redirectChance = (p.supernovaRedirectChanceByLevel ?? [])[level - 1] ?? 0;
      if (redirectChance > 0) {
        const rng = options.rng ?? match.rng;
        if (rng() < redirectChance) {
          const dur = p.redirectDurationTicks ?? 0;
          for (const other of match.gameState!.getPlayers()) {
            if (other.eliminated || other.id === recipient.id) continue;
            const prevTarget = other.target;
            const lock = applyStatus(other, SUPERNOVA_LOCK, {
              sourceId: caster.id,
              durationTicks: dur,
            });
            lock.restoreTargetId = prevTarget;
            other.target = recipient.id;
            emitStatusApplied(other.id, caster.id, lock);
            if (bus.enabled) {
              bus.emit({
                type: "targetChanged",
                tick: match.tick,
                playerId: other.id,
                targetId: recipient.id,
              });
            }
          }
        }
      }
      break;
    }
    case "createBlackHole": {
      // Space's ultimate: open a black hole over the field for its duration.
      // While open, every offensive attack is swallowed (see the absorption
      // gate at the top of applyEffect) and dumped on collapse (tick loop).
      const dur = p.blackHoleDurationTicks ?? 0;
      match.gameState!.blackHole = {
        ownerId: caster.id,
        endTick: match.tick + dur,
        accumulated: 0,
        lastAttackerId: null,
        fedBy: [],
      };
      if (bus.enabled) {
        bus.emit({
          type: "blackHoleOpened",
          tick: match.tick,
          playerId: caster.id,
          durationTicks: dur,
        });
      }
      break;
    }
    case "slotMachine": {
      // Joker's ultimate: hand the recipient a machine. Nothing is rolled here
      // — the spin happens when THEY pull the lever (`spinSlotMachine`), and
      // until they do their gold production is frozen (see `applyPassiveIncome`).
      // Re-casting on someone who already owes a spin doesn't stack.
      if (recipient.id === caster.id || recipient.pendingSpin) break;
      recipient.pendingSpin = { sourceId: caster.id, abilityId, atTick: match.tick };
      recipient.economy.incomePerTick = 0;
      if (bus.enabled) {
        bus.emit({
          type: "slotMachineOpened",
          tick: match.tick,
          playerId: recipient.id,
          sourceId: caster.id,
          abilityId,
        });
      }
      break;
    }

    case "roulette": {
      // Joker's Roulette: wheel the table out. Nothing spins here — the wheel
      // turns when THEY call a colour (`placeRouletteBet`), and until then
      // their gold production is frozen (see `applyPassiveIncome`).
      if (recipient.id === caster.id || recipient.pendingBet) break;
      recipient.pendingBet = { sourceId: caster.id, abilityId, atTick: match.tick };
      recipient.economy.incomePerTick = 0;
      if (bus.enabled) {
        bus.emit({
          type: "rouletteOpened",
          tick: match.tick,
          playerId: recipient.id,
          sourceId: caster.id,
          abilityId,
        });
      }
      break;
    }

    case "blackjackDraw": {
      // Joker's Blackjack: pull one card and hit for whatever it is worth. The
      // draw is uniform over a real 54-card deck (see `blackjack.ts`), so Ace
      // of Spades stripping the 2s and 3s genuinely improves the odds rather
      // than nudging a number. The rolled damage then runs the ordinary
      // pipeline, so crits, buffs, and resistances all apply on top.
      const rng = options.rng ?? match.rng;
      const card = drawBlackjackCard(caster, rng);
      const cardAmount = Math.round(
        card.damage * (p.cardDamageMultiplier ?? 1),
      );
      // The suit's rider, if this suit has one. Diamonds don't — their bonus is
      // already inside `card.damage` — and a joker has no suit at all.
      const rider = card.suit ? p.suitStatuses?.[card.suit] : undefined;
      if (bus.enabled) {
        bus.emit({
          type: "cardDrawn",
          tick: match.tick,
          playerId: caster.id,
          abilityId,
          card: card.label,
          suit: card.suit,
          damage: cardAmount,
        });
      }
      const drawn = resolveDamage(caster, recipient, cardAmount, {
        element: p.element,
        elementMultiplier: p.elementMultiplier,
        forceCrit: options.forceCrit,
        rng: options.rng,
        besiegedMultiplier: besiegedDamageMultiplier(caster, match.gameState!.getPlayers()),
        attackerScalingMultiplier: scalingAttackMultiplier(caster, match.tick),
        defenderScalingTakenMultiplier: scalingDamageTakenMultiplier(recipient, match.tick),
      });

      // The card has to physically reach the victim before it hurts them: the
      // whole cinematic (summon, reveal, throw) plays out first. The damage is
      // RESOLVED now — so it reflects the buffs in play at the moment of the
      // draw — but only lands when the card does.
      if (p.delayTicks) {
        match.gameState!.pendingStrikes.push({
          ownerId: caster.id,
          targetId: recipient.id,
          abilityId,
          resolveTick: match.tick + p.delayTicks,
          amount: drawn.amount,
          element: p.element,
          breaksShields: false,
          rider,
        });
        break;
      }

      const drawnApplied = applyDamage(recipient, drawn.amount, { tick: match.tick });
      damage.push(drawnApplied);
      emitDamage(recipient.id, caster.id, drawnApplied, drawn.crit, abilityId);
      if (rider) {
        const inst = applyStatus(recipient, rider.status, {
          sourceId: caster.id,
          durationTicks: rider.durationTicks,
        });
        emitStatusApplied(recipient.id, caster.id, inst);
      }
      break;
    }

    case "luckyDraw": {
      // Joker's Lucky Draw: one roll to see if anything happens at all, then a
      // second to pick which. Most casts are a wasted coin — that is the
      // ability. Both rolls go through the match RNG so a seeded replay is
      // identical (#203).
      const spec = p.luckyDraw;
      if (!spec || spec.outcomes.length === 0) break;
      const rng = options.rng ?? match.rng;
      if (rng() >= spec.chance) {
        if (bus.enabled) {
          bus.emit({
            type: "luckyDraw",
            tick: match.tick,
            playerId: caster.id,
            abilityId,
            outcome: null,
          });
        }
        break;
      }
      const pick =
        spec.outcomes[
          Math.min(spec.outcomes.length - 1, Math.floor(rng() * spec.outcomes.length))
        ]!;

      let label = "";
      if (pick.kind === "status") {
        label = pick.status.id;
        const lucky = applyStatus(recipient, pick.status, {
          sourceId: caster.id,
          durationTicks: p.durationTicks ?? 0,
        });
        emitStatusApplied(recipient.id, caster.id, lucky);
      } else if (pick.kind === "shield") {
        label = "shield";
        recipient.castle.shield += Math.max(0, Math.round(pick.amount));
        if (bus.enabled) {
          bus.emit({
            type: "shieldGained",
            tick: match.tick,
            playerId: recipient.id,
            amount: pick.amount,
            total: recipient.castle.shield,
            cause: abilityId,
          });
        }
      } else {
        label = "heal";
        const healed = healCastle(recipient, Math.round(pick.amount));
        if (healed > 0 && bus.enabled) {
          bus.emit({
            type: "heal",
            tick: match.tick,
            targetId: recipient.id,
            amount: healed,
            overheal: pick.amount - healed,
            cause: abilityId,
          });
        }
        shareHealGlobally(match, recipient, healed);
      }
      if (bus.enabled) {
        bus.emit({
          type: "luckyDraw",
          tick: match.tick,
          playerId: caster.id,
          abilityId,
          outcome: label,
        });
      }
      break;
    }

    case "rageBlast": {
      // Dark's Unlimited Rage: everything that has been done to Dark, returned
      // at once. Gated on a full meter up in validation; the meter empties here
      // so the charge is spent whether or not the hit lands well.
      caster.rageMeter = 0;
      if (bus.enabled) {
        bus.emit({
          type: "rageSpent",
          tick: match.tick,
          playerId: caster.id,
          abilityId,
        });
      }
      const raged = resolveDamage(caster, recipient, p.amount ?? 0, {
        element: p.element,
        elementMultiplier: p.elementMultiplier,
        forceCrit: options.forceCrit,
        rng: options.rng,
        besiegedMultiplier: besiegedDamageMultiplier(caster, match.gameState!.getPlayers()),
        attackerScalingMultiplier: scalingAttackMultiplier(caster, match.tick),
        defenderScalingTakenMultiplier: scalingDamageTakenMultiplier(recipient, match.tick),
      });
      const ragedApplied = applyDamage(recipient, raged.amount, { tick: match.tick });
      damage.push(ragedApplied);
      emitDamage(recipient.id, caster.id, ragedApplied, raged.crit, abilityId);
      // …and the victim is left in the dark, literally.
      if (p.status) {
        const blinded = applyStatus(recipient, p.status, {
          sourceId: caster.id,
          durationTicks: p.durationTicks ?? 0,
        });
        emitStatusApplied(recipient.id, caster.id, blinded);
      }
      break;
    }

    case "yinYangWager": {
      // Dark's Yin and Yang: lay the wager. Which behaviour is punished comes
      // from the caster's pick, validated at cast time. The victim is damaged
      // either way — the only question is how much, and that is settled either
      // when they buy a citizen or when the wager runs out (see `settleYinYang`).
      if (!p.status) break;
      const wager = applyStatus(recipient, p.status, {
        sourceId: caster.id,
        durationTicks: p.durationTicks ?? 0,
      });
      wager.wagerMode = options.choice === "yang" ? "yang" : "yin";
      wager.wagerAmount = p.amount ?? 0;
      wager.wagerHalfAmount = p.halfAmount ?? Math.round((p.amount ?? 0) / 2);
      emitStatusApplied(recipient.id, caster.id, wager);
      break;
    }

    case "delayedStrike": {
      // Schedule it and announce it — the warning is half the ability. The hit
      // itself is dealt by `resolvePendingStrikes` from the game loop.
      const resolveTick = match.tick + Math.max(0, p.delayTicks ?? 0);
      match.gameState!.pendingStrikes.push({
        ownerId: caster.id,
        abilityId,
        resolveTick,
        amount: p.amount ?? 0,
        element: p.element,
        breaksShields: p.breaksShields === true,
      });
      if (bus.enabled) {
        bus.emit({
          type: "strikeIncoming",
          tick: match.tick,
          ownerId: caster.id,
          abilityId,
          resolveTick,
        });
      }
      break;
    }

    case "amplifyDispelCost": {
      // Light's Illumination: make an outstanding ransom worse. Strictly a
      // multiplier on a debt the recipient ALREADY owes — it never creates the
      // status, so illuminating a kingdom with no swarm on it does nothing.
      const spec = p.amplifyDispelCost;
      if (!spec) break;
      const held = recipient.statuses.find(
        (s) => s.id === spec.statusId && s.dispelCost !== undefined,
      );
      if (!held) break;
      const before = held.dispelCost!;
      held.dispelCost = Math.max(0, Math.round(before * spec.multiplier));
      if (bus.enabled && held.dispelCost !== before) {
        bus.emit({
          type: "dispelCostChanged",
          tick: match.tick,
          playerId: recipient.id,
          statusId: spec.statusId,
          cost: held.dispelCost,
          cause: abilityId,
        });
      }
      break;
    }

    case "linkCastles": {
      // Love's "BFFS!!!": the primary target (recipient) takes damage; if
      // another living enemy is available it takes the SAME damage too, and
      // the two castles become linked for the duration — damage and statuses
      // hitting either from ANY source mirror onto the other (see the
      // "damage"/"status" cases above and the DoT-tick branch in status.ts).
      const dealTo = (who: PlayerState): void => {
        const hitResolved = resolveDamage(caster, who, p.amount ?? 0, {
          element: p.element,
          elementMultiplier: p.elementMultiplier,
          forceCrit: options.forceCrit,
          rng: options.rng,
          besiegedMultiplier: besiegedDamageMultiplier(caster, match.gameState!.getPlayers()),
          attackerScalingMultiplier: scalingAttackMultiplier(caster, match.tick),
          defenderScalingTakenMultiplier: scalingDamageTakenMultiplier(who, match.tick),
        });
        const dealtApplied = applyDamage(who, hitResolved.amount, { tick: match.tick });
        damage.push(dealtApplied);
        emitDamage(who.id, caster.id, dealtApplied, hitResolved.crit, abilityId);
      };
      dealTo(recipient);

      // The SECOND linked kingdom is player-selected (validated up-front as
      // `secondTargetId`; see the targeting.secondTarget requirement). It takes
      // the same hit and the two castles link for the duration.
      const second = options.secondTargetId
        ? match.gameState!.getPlayer(options.secondTargetId)
        : undefined;
      if (second && !second.eliminated && second.id !== recipient.id && p.status) {
        dealTo(second);

        const durationTicks = p.durationTicks ?? 0;
        const linkA = applyStatus(recipient, p.status, { sourceId: caster.id, durationTicks });
        linkA.linkedPartnerId = second.id;
        emitStatusApplied(recipient.id, caster.id, linkA);
        const linkB = applyStatus(second, p.status, { sourceId: caster.id, durationTicks });
        linkB.linkedPartnerId = recipient.id;
        emitStatusApplied(second.id, caster.id, linkB);
      }
      break;
    }
  }
}

/**
 * Rolls whether the CASTER fumbles their own swing (Insects' "Butterflies"),
 * and resolves what happens if they do.
 *
 * This is the mirror of `maybeMissAttack`: that one is about a defender being
 * hard to hit, this one is about an attacker being unable to aim. Kept separate
 * for a reason — a fumble can rebound, and a dodge never can.
 *
 * If the caster is also "Infected", the fumbled attack lands on THEM: every
 * effect it would have inflicted on the target is applied to the caster
 * instead. That is the whole interaction between Insects' two heavy attacks —
 * Butterflies makes you miss, Infected makes missing hurt — and it is why
 * `deflectsMissedAttack` does nothing on its own.
 *
 * Returns true when the attack is over, so the caller drops the rest of it.
 */
function fumbleOwnAttack(
  match: Match,
  effective: AbilityDefinition,
  caster: PlayerState,
  target: PlayerState,
  options: ActivateOptions,
  damage: DamageApplication[],
): boolean {
  const clumsy = caster.statuses.find((s) => (s.attackMissChance ?? 0) > 0);
  if (!clumsy) return false;

  const rng = options.rng ?? match.rng;
  if (rng() >= clumsy.attackMissChance!) return false;

  const bus = match.gameState!.events;
  if (bus.enabled) {
    bus.emit({
      type: "attackMissed",
      tick: match.tick,
      playerId: target.id,
      attackerId: caster.id,
      abilityId: effective.id,
      cause: clumsy.id,
    });
  }

  // Infected: the swing comes back around. Applied straight to the caster
  // rather than by re-entering `activateAbility`, so it cannot re-roll the
  // fumble and rebound forever.
  const infection = caster.statuses.find((s) => s.deflectsMissedAttack);
  if (infection) {
    if (bus.enabled) {
      bus.emit({
        type: "attackDeflected",
        tick: match.tick,
        playerId: caster.id,
        abilityId: effective.id,
        cause: infection.id,
      });
    }
    for (const effect of effective.effects) {
      // Only what the attack was aiming at the TARGET comes back. Anything it
      // does to the caster (self-buffs, meter charges) already happened or is
      // not part of the swing.
      if (effect.target !== "target") continue;
      applyEffect(match, effective.id, caster, caster, caster, effect, options, damage);
    }
  }
  return true;
}

/**
 * Rolls whether an incoming attack on `target` misses entirely. Two sources
 * feed it, and the first that fires wins:
 *
 *  - Orion's Belt (Space utility): a status-borne dodge chance that also feeds
 *    the bearer's Supernova meter on a whiff.
 *  - "Why so serious?" (Joker passive): a flat chance while Joker is shielded.
 *
 * Returns true so the caller drops the whole attack. Both are suppressed while
 * a Black Hole is open — that absorbs the attack rather than dodging it.
 */
function maybeMissAttack(
  match: Match,
  caster: PlayerState,
  target: PlayerState,
  abilityId: string,
  options: ActivateOptions,
): boolean {
  const hole = match.gameState!.blackHole;
  if (hole && match.tick < hole.endTick) return false;
  const rng = options.rng ?? match.rng;

  // Joker's shield-borne luck. Rolled first and independently of Orion's Belt,
  // so a kingdom that somehow had both would get both chances.
  const jokerChance = shieldedMissChance(target);
  if (jokerChance > 0 && rng() < jokerChance) {
    const bus = match.gameState!.events;
    if (bus.enabled) {
      bus.emit({
        type: "attackMissed",
        tick: match.tick,
        playerId: target.id,
        attackerId: caster.id,
        abilityId,
        cause: "whySoSerious",
      });
    }
    return true;
  }

  return maybeMissByOrionsBelt(match, caster, target, abilityId, options, rng);
}

/**
 * Orion's Belt (Space utility): rolls whether an incoming attack on `target`
 * misses. On a miss it feeds `target`'s Supernova meter, emits the miss/charge
 * events, and returns true so the caller drops the whole attack.
 */
function maybeMissByOrionsBelt(
  match: Match,
  caster: PlayerState,
  target: PlayerState,
  abilityId: string,
  options: ActivateOptions,
  rng: () => number,
): boolean {
  void options;
  const belt = target.statuses.find(
    (s) => (s.incomingMissChance ?? 0) > 0,
  );
  if (!belt) return false;
  if (rng() >= belt.incomingMissChance!) return false;

  const bus = match.gameState!.events;
  const charge = belt.missChargesSupernova ?? 0;
  // Same rule as every other charge source: nothing fills the meter until
  // Supernova is unlocked.
  if (charge > 0 && target.unlocked.supernova) {
    const before = target.supernovaMeter;
    target.supernovaMeter = Math.min(supernovaMaxMeter(), before + charge);
    if (bus.enabled && target.supernovaMeter !== before) {
      bus.emit({
        type: "supernovaCharged",
        tick: match.tick,
        playerId: target.id,
        meter: target.supernovaMeter,
        level: supernovaLevel(target.supernovaMeter),
      });
    }
  }
  if (bus.enabled) {
    bus.emit({
      type: "attackMissed",
      tick: match.tick,
      playerId: target.id,
      attackerId: caster.id,
      abilityId,
      cause: "orionsBelt",
    });
  }
  return true;
}

/**
 * Feeds one swallowed attack into an open Black Hole: pools its damage and marks
 * the attacker as the most recent to feed it — the last such attacker takes the
 * whole pool when the hole collapses (see `collapseBlackHoles`).
 */
function absorbIntoBlackHole(
  match: Match,
  hole: BlackHoleState,
  attackerId: string,
  amount: number,
): void {
  hole.accumulated += amount;
  hole.lastAttackerId = attackerId;
  if (!hole.fedBy.includes(attackerId)) hole.fedBy.push(attackerId);
  const bus = match.gameState!.events;
  if (bus.enabled) {
    bus.emit({
      type: "blackHoleAbsorbed",
      tick: match.tick,
      ownerId: hole.ownerId,
      attackerId,
      amount,
    });
  }
}

/**
 * Collapses an open Black Hole once its duration elapses: the entire pooled
 * damage is dropped on one kingdom, chosen by `blackHoleVictim` — a kingdom
 * that never fed it if there is one, otherwise the last that did (nobody fed
 * it and nobody survives to take it →
 * it fizzles). Run once per tick from the game loop. Returns the collapse info
 * for callers that want to react (tests), or null if nothing collapsed.
 */
/**
 * Lands every telegraphed strike whose moment has come (Light's "Light Show").
 * Run once per tick from the game loop, before death detection so a lethal one
 * resolves the same tick.
 *
 * Each kingdom but the caster is judged on one thing — whether it is behind a
 * shield right now:
 *  - shielded: the shield is annihilated whatever its health, and it eats the
 *    strike whole. No damage carries into castle HP.
 *  - unshielded: it takes the full hit.
 *
 * The damage is flat and deliberately skips the modifier pipeline: this is a
 * fixed toll for having been caught in the open, not an attack to be resisted.
 */
export function resolvePendingStrikes(match: Match): void {
  const state = match.gameState;
  if (!state) return;
  const due = state.pendingStrikes.filter((s) => match.tick >= s.resolveTick);
  if (due.length === 0) return;
  // Drop the resolved ones first, so nothing can land twice.
  for (const strike of due) {
    const at = state.pendingStrikes.indexOf(strike);
    if (at >= 0) state.pendingStrikes.splice(at, 1);
  }

  const bus = state.events;
  for (const strike of due) {
    for (const victim of state.getPlayers()) {
      if (victim.id === strike.ownerId || victim.eliminated) continue;
      // A targeted strike waits for exactly one kingdom; a field-wide one has
      // no `targetId` and sweeps everybody.
      if (strike.targetId && victim.id !== strike.targetId) continue;

      if (strike.breaksShields && victim.castle.shield > 0) {
        victim.castle.shield = 0;
        victim.castle.shieldBrokenAtTick = match.tick;
        if (bus.enabled) {
          bus.emit({
            type: "shieldDestroyed",
            tick: match.tick,
            playerId: victim.id,
            cause: strike.abilityId,
          });
        }
        continue; // the shield absorbed it all — nothing carries over
      }

      const applied = applyDamage(victim, strike.amount, { tick: match.tick });
      // A rider travels WITH the strike (Blackjack's suit), so it lands on the
      // same frame as the damage rather than tipping the reveal early.
      if (strike.rider) {
        const inst = applyStatus(victim, strike.rider.status, {
          sourceId: strike.ownerId,
          durationTicks: strike.rider.durationTicks,
        });
        if (bus.enabled) {
          bus.emit({
            type: "statusApplied",
            tick: match.tick,
            targetId: victim.id,
            sourceId: strike.ownerId,
            statusId: inst.id,
            durationTicks: inst.remainingTicks ?? strike.rider.durationTicks,
            stacks: inst.stacks ?? 1,
          });
        }
      }
      if (bus.enabled) {
        bus.emit({
          type: "damage",
          tick: match.tick,
          sourceId: strike.ownerId,
          targetId: victim.id,
          amount: applied.absorbedByShield + applied.dealtToHp,
          absorbedByShield: applied.absorbedByShield,
          dealtToHp: applied.dealtToHp,
          overkill: applied.incoming - applied.absorbedByShield - applied.dealtToHp,
          crit: false,
          element: strike.element,
          cause: strike.abilityId,
        });
      }
    }
  }
}

/**
 * Who a collapsing Black Hole dumps on.
 *
 * Space is excluded outright, owner or not. Beyond that, a kingdom that never
 * fed it comes FIRST. The hole punishes sitting the fight out: everyone who threw a punch at Space already paid for it by having that
 * attack swallowed, so dropping the whole pool on one of them taxes the same
 * kingdom twice while the player who quietly built up all window walks away
 * untouched. Non-attackers are the top of the list; the last kingdom to feed it
 * is only the fallback for when the entire field engaged.
 *
 * Ties are broken with the match RNG so a seeded replay picks the same victim
 * (#203), and so the choice can't be gamed by turn order or seating.
 */
function blackHoleVictim(
  match: Match,
  hole: BlackHoleState,
): PlayerState | undefined {
  const state = match.gameState!;
  // Space is never a valid victim — not the kingdom that opened it, and not
  // another Space either. The black hole is Space's own instrument; it does not
  // turn on the kingdom that understands it.
  const candidates = state
    .getPlayers()
    .filter(
      (p) => !p.eliminated && p.id !== hole.ownerId && p.kingdomId !== "space",
    );
  if (candidates.length === 0) return undefined;

  const bystanders = candidates.filter((p) => !hole.fedBy.includes(p.id));
  if (bystanders.length > 0) {
    const i = Math.min(
      bystanders.length - 1,
      Math.floor(match.rng() * bystanders.length),
    );
    return bystanders[i];
  }

  // Everyone engaged — fall back to whoever fed it last.
  return hole.lastAttackerId
    ? candidates.find((p) => p.id === hole.lastAttackerId)
    : undefined;
}

export function collapseBlackHoles(match: Match): void {
  const state = match.gameState;
  if (!state) return;
  const hole = state.blackHole;
  if (!hole || match.tick < hole.endTick) return;

  state.blackHole = null; // closed regardless of whether it dumps
  const bus = state.events;
  const victim = blackHoleVictim(match, hole);
  if (victim && !victim.eliminated && hole.accumulated > 0) {
    const applied = applyDamage(victim, hole.accumulated, { tick: match.tick });
    if (bus.enabled) {
      bus.emit({
        type: "damage",
        tick: match.tick,
        sourceId: hole.ownerId,
        targetId: victim.id,
        amount: applied.absorbedByShield + applied.dealtToHp,
        absorbedByShield: applied.absorbedByShield,
        dealtToHp: applied.dealtToHp,
        overkill: applied.incoming - applied.absorbedByShield - applied.dealtToHp,
        crit: false,
        cause: "blackHole",
      });
      if (applied.absorbedByShield > 0 && victim.castle.shield <= 0) {
        bus.emit({ type: "shieldDestroyed", tick: match.tick, playerId: victim.id, cause: "blackHole" });
      }
    }
  }
  if (bus.enabled) {
    bus.emit({
      type: "blackHoleCollapsed",
      tick: match.tick,
      ownerId: hole.ownerId,
      victimId: victim && !victim.eliminated ? victim.id : null,
      amount: hole.accumulated,
    });
  }
}

/** Restores castle HP, clamped to max. Returns the HP actually restored. */
export function healCastle(player: PlayerState, amount: number): number {
  if (amount <= 0) return 0;
  const before = player.castle.hp;
  player.castle.hp = Math.min(player.castle.maxHp, before + amount);
  return player.castle.hp - before;
}

/**
 * Love's "Feel the love!": whenever ANY castle heals, for any reason, every
 * OTHER kingdom holding the generic `healShareGlobal` passive also receives a
 * cut of it. Data-driven — no kingdom-name branch; excludes the healed player
 * itself so the passive never re-triggers off its own bonus heal.
 */
export function shareHealGlobally(match: Match, healedPlayer: PlayerState, healedAmount: number): void {
  if (healedAmount <= 0) return;
  const bus = match.gameState!.events;
  for (const other of match.gameState!.getPlayers()) {
    if (other.id === healedPlayer.id || other.eliminated) continue;
    const pct = healShareGlobalPct(other);
    if (pct <= 0) continue;
    const requested = Math.round(healedAmount * pct);
    const gained = healCastle(other, requested);
    if (gained > 0 && bus.enabled) {
      bus.emit({ type: "heal", tick: match.tick, targetId: other.id, amount: gained, overheal: requested - gained, cause: "healShareGlobal" });
    }
  }
}
