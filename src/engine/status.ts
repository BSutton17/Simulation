import type { GameState } from "../match/GameState.js";
import type {
  ModifierOp,
  PlayerState,
  StatusEffectInstance,
  StatusTickEffect,
} from "../match/playerState.js";
import { type EffectCondition } from "./conditions.js";
import { addModifier, removeModifiersFromSource, computeStat } from "./modifiers.js";
import { applyDamage } from "./combat.js";
import { lavaFloorMultiplier } from "./lavaFloor.js";
import {
  statusDurationMultiplier,
  dotResistanceMultiplier,
  dotIgnoresShields,
  creditMemoryDirect,
} from "./passives.js";
import { perkDamageTakenMultiplier, perkDotDamageTakenMultiplier } from "./perks.js";
import { param } from "./parameters.js";
import { TICK } from "../data/balance.js";
import { recalcIncome } from "./economy.js";

/**
 * Reusable status-effect framework (tickets #47, #76–#80): apply, update, and
 * remove gameplay status effects on players. It owns the full lifecycle —
 * application with configurable duration, stacking behavior, and source
 * tracking (#76); removal/dispel with restoration of any modified player
 * statistics (#77); and per-tick processing of recurring effect logic (#78).
 *
 * This is also the buff (#79) and debuff (#80) framework: a buff/debuff is a
 * status definition (data, no kingdom-specific logic) composing two generic
 * capabilities —
 *   • `modifiers`: temporary stat changes (crit chance, production/income,
 *     damage, healing, …) applied through the shared modifier system while the
 *     status is active and automatically removed with it;
 *   • `tickEffects`: recurring per-tick damage/healing (burn, poison, regen),
 *     optionally scaling with stacks.
 * e.g. burn = debuff + damage tickEffect; frozen production = debuff +
 * income ×0 modifier; crit surge = buff + critChance modifier.
 *
 * A player holds at most one instance per status id; re-application is resolved
 * by the definition's stacking rule.
 */

export type StatusCategory = "buff" | "debuff" | "crowdControl";
export type StatusStacking = "none" | "refresh" | "stack" | "extend" | "replace";

/** A temporary stat change granted while a status is active (#79/#80). */
export interface StatusModifierSpec {
  stat: string;
  op: ModifierOp;
  value: number;
  /** Conditional modifiers (ticket #101). */
  conditions?: EffectCondition[];
  stringValue?: string;
  usageLimit?: number;
}

export interface StatusEffectDefinition {
  id: string;
  /** Human-readable display name (optional; for UI). */
  name?: string;
  category: StatusCategory;
  /** How re-application behaves when the status is already present. */
  stacking: StatusStacking;
  /** Cap for `stacking: "stack"` (unbounded if omitted). */
  maxStacks?: number;
  /** Stat modifiers active while the status lasts; removed with it (#77). */
  modifiers?: StatusModifierSpec[];
  /** Recurring per-tick effects executed by `processStatusTicks` (#78). */
  tickEffects?: StatusTickEffect[];
  /**
   * While active, the bearer cannot target the player who applied the status
   * (#87–#88). Targeting anyone else stays legal.
   */
  blocksTargetingSource?: boolean;
  /**
   * While active, the bearer's next attack on the player who applied the
   * status is deflected to another valid kingdom, the attacker included
   * (Air's Hurricane, Epic 8). Consumed on use by the activation pipeline.
   *  - `damageMult`: the deflected attack deals this multiplier to the
   *    redirected target (Hurricane Lv 3).
   *  - `chainChance`: one roll to allow a second deflection before the mark
   *    is consumed — 1 deflection becomes 2, never more (Hurricane Lv 5).
   */
  deflectsAttackOnSource?: { damageMult?: number; chainChance?: number };
  /** While active, the bearer cannot activate attack-kind abilities
   *  (Ice's Frozen/Blizzard, Epic 11). */
  blocksAttacks?: boolean;
  /**
   * While active, chance-gated effects of the bearer's attacks always proc;
   * the activation pipeline consumes one stack per attack (Ice's Frozen
   * Focus, Epic 11).
   */
  guaranteesChanceEffects?: boolean;
  /** Applied to the bearer when this status expires naturally (Epic 11,
   *  e.g. thawing from Frozen briefly slows production). */
  onExpireStatus?: { status: StatusEffectDefinition; durationTicks: number };
  /**
   * Overrides `stacking` while the bearer has the named status (Epic 12,
   * e.g. Poison stacks while Corroded but merely refreshes otherwise).
   */
  stackingWhileStatus?: { statusId: string; stacking: StatusStacking };
  /** While active, the bearer cannot buy citizens or repair (Epic 12,
   *  Nature's Toxic Gas). */
  blocksPurchases?: boolean;
  /** Applied to the next player who damages the bearer, then consumed
   *  (Epic 12, Nature's Poison Apple). */
  onHitRetaliate?: { status: StatusEffectDefinition; durationTicks: number };
  /** Additional statuses applied to the biter alongside `onHitRetaliate` when
   *  the mark springs (Poison Apple also poisons the biter's citizens). Applied
   *  and consumed together with the primary retaliation. */
  onHitRetaliateExtra?: { status: StatusEffectDefinition; durationTicks: number }[];
  /**
   * While active, time runs backward on the bearer's treasury: instead of
   * earning passive income, they LOSE it each tick (floored at 0). Drains gold
   * at their own gold/sec rate (Time's "Back to the Future").
   */
  drainsIncome?: boolean;
  /**
   * While active, the bearer cannot change target (Space's Supernova L2/L3
   * forced redirect). The forced target and the target to restore on expiry are
   * set on the instance when applied.
   */
  blocksTargetChange?: boolean;
  /**
   * While active, each incoming attack on the bearer has this probability (0–1)
   * to miss entirely (Space's Orion's Belt). Snapshotted on apply.
   */
  incomingMissChance?: number;
  /**
   * The bearer's OWN attacks miss this often (Insects' "Butterflies"). The
   * mirror of `incomingMissChance`, which is about attacks aimed AT the bearer:
   * this one makes the bearer inaccurate rather than evasive.
   */
  attackMissChance?: number;
  /**
   * Insects' "Creepy Crawlers": how many bugs land, and how hard each one is
   * to swat. Each drains gold every tick until it is squashed, so the bleed
   * eases as the victim works through them.
   */
  crawlers?: { count: number; hitsToKill: number; drainPerSecond: number };
  /**
   * When the bearer's own attack misses, it lands on THEM instead (Insects'
   * "Infected"). Inert on its own — something else has to be making them miss,
   * which is why Butterflies and Infected are built to be used together.
   */
  deflectsMissedAttack?: boolean;
  /**
   * When an incoming attack misses via `incomingMissChance`, add this many
   * points to the bearer's Supernova meter (Orion's Belt feeds the meter).
   */
  missChargesSupernova?: number;
  /**
   * While active, these card ranks are missing from the bearer's Blackjack
   * deck (Joker's Ace of Spades stripping the 2s and 3s). Ranks are the
   * numeric card values — see `drawBlackjackCard`.
   */
  strippedCardRanks?: readonly number[];
  /**
   * While active, the bearer may only cast their kingdom's BASIC attack —
   * every other attack and their ultimate are refused (Dark's Never-ending
   * nightmare). Utilities stay legal. Each attack they do manage burns one of
   * `basicAttackLimit`; the status lifts when they run out.
   */
  basicAttacksOnly?: boolean;
  /** How many attacks the `basicAttacksOnly` lock lasts for. */
  basicAttackLimit?: number;
  /**
   * While active, the bearer's attacks may name up to this many enemies at
   * once — a temporary grant of what Air's "Embrace of Winds" passive gives
   * permanently (Dark's Infinitum tenebrae).
   */
  grantsMultiTarget?: number;
  /**
   * With a multi-target grant, damage is NOT divided across the kingdoms
   * struck — each takes the attack in full (Infinitum tenebrae, unlike Air).
   */
  noDamageSpread?: boolean;
  /**
   * While active, every attack the bearer lands also inflicts this status on
   * the victim (Infinitum tenebrae darkening every screen it touches).
   */
  attackInflicts?: { status: StatusEffectDefinition; durationTicks: number };
  /**
   * The bearer can pay gold to remove this status early (Light's Fireflies).
   * The price is `dispelCostPerCitizen × the bearer's citizen count` at the
   * moment it lands, snapshotted onto the instance — a bigger kingdom is a
   * juicier target and pays more to shake it off. Without this the status can
   * only be waited out.
   */
  dispelCostPerCitizen?: number;
  /**
   * An active shield repels this status outright — it never attaches to a
   * shielded castle (Light's Fireflies).
   */
  repelledByShield?: boolean;
  /**
   * While the bearer carries this status they cannot buy a shield (Light's
   * Fireflies). Paired with `repelledByShield` this makes the swarm a trap you
   * must pay your way out of: a shield keeps it off, but once it lands you can
   * no longer buy one to escape it.
   */
  blocksBearerShield?: boolean;
  /**
   * Per-tick damage used INSTEAD of `amount` while the bearer has a shield up
   * and the tick is piercing it (Magma's "Hotter fire").
   *
   * A shield should never be worthless against Magma, but it should not be a
   * full answer either: the burn still gets through, just for less. Declared on
   * the status rather than computed from a ratio so the softened number is a
   * deliberate choice, visible next to the one it replaces.
   */
  shieldedTickAmount?: number;
  /**
   * This status is a BURN — fire damage over time, whoever inflicted it.
   * Marked rather than inferred from the id so Magma's "Floor is Lava" can
   * amplify every burn on the field (Fire's, Magma's, Kitsune's foxfire) from
   * one rule, and a future kingdom's burn is covered the day it is written.
   */
  isBurn?: boolean;
  /**
   * The status ends the moment the bearer buys a shield (Kitsune's "Old
   * Friends": the foxes are driven off by the wall going up, and buying one is
   * the ONLY way out). Removed by `buyShield`, not by any timer.
   */
  endsOnShieldPurchase?: boolean;
  /**
   * While this status is on someone, the player who applied it gains this much
   * Ancient Memory per tick (Kitsune's "Old Friends": the longer the foxes are
   * left alone, the more Kitsune remembers).
   */
  chargesSourceMemoryPerTick?: number;
  /**
   * Each attack the BEARER makes multiplies this status's tick damage by this
   * much (Kitsune's "Fox Fire": swinging fans the flames). Compounds, so a
   * kingdom that keeps attacking burns hotter and hotter.
   */
  intensifiesOnBearerAttack?: number;
  /**
   * While active, whenever the STATUS'S SOURCE (the applier) takes damage,
   * the bearer also takes this fraction of it (Love's Cupid's Arrow —
   * "infatuated" kingdoms feel a share of what Love feels).
   */
  bearerTakesPctOfSourceDamage?: number;
  /**
   * While active, ANY damage the bearer takes is instead fully negated and
   * converted into healing for this fraction of the raw incoming amount
   * (Love's "Love Galore").
   */
  negateDamageHealPct?: number;
  /**
   * While active, damage the bearer takes is reflected back at the attacker
   * in full proportion (no chance roll — unlike the passive `thorns`, which
   * rolls per hit) at this fraction (Love's "Have some Empathy!", 1 = 100%).
   */
  thornsPct?: number;
  /**
   * A two-phase status that stays HIDDEN until it reveals (Love's "Love
   * Galore"). While unrevealed, its damage-negation heals the bearer silently
   * and enemies see phantom damage numbers instead. It reveals when EITHER the
   * initial (stealth) window elapses OR `negateDamageHealPct` healing reaches
   * `revealHealThreshold` — whichever comes first — at which point the status
   * restarts for a fresh window of the same length, now fully visible.
   */
  revealsBeforeExpiry?: boolean;
  /** Cumulative negated-damage healing that triggers an early reveal (paired
   *  with `revealsBeforeExpiry`; passed through the applying effect's params so
   *  it scales with upgrades). */
  revealHealThreshold?: number;
}

/**
 * Whether `player` is currently barred from targeting `targetId` by an active
 * status (#88). Used by both target selection and ability activation.
 */
export function isTargetingBlocked(
  player: PlayerState,
  targetId: string,
): boolean {
  return player.statuses.some(
    (s) => s.blocksTargetingSource && s.sourceId === targetId,
  );
}

/** The modifier `sourceId` a status's linked stat changes are tracked under. */
export function statusModifierSource(statusId: string): string {
  return `status:${statusId}`;
}

export interface ApplyStatusOptions {
  sourceId: string;
  durationTicks: number;
  /** Stacks applied (default 1). */
  stacks?: number;
}

/** A status removed during processing, for callers that react to expiry. */
export interface RemovedStatus {
  playerId: string;
  status: StatusEffectInstance;
}

/**
 * Settles a Dark "Yin and Yang" wager on the bearer, once. `bought` says which
 * way they went during the window.
 *
 * The wager punishes one behaviour and merely taxes the other, so there is no
 * clean escape — reading Dark right only halves the bill:
 *  - yin  punishes BUYING       → full if `bought`, half otherwise
 *  - yang punishes NOT BUYING   → full if not `bought`, half otherwise
 *
 * Damage is flat: this is a rigged bet being collected, not an attack to be
 * resisted. Callers are responsible for removing the status.
 */
export function settleYinYang(
  state: GameState,
  bearer: PlayerState,
  wager: StatusEffectInstance,
  bought: boolean,
): number {
  if (!wager.wagerMode) return 0;
  const guessedWrong = wager.wagerMode === "yin" ? bought : !bought;
  const amount = guessedWrong
    ? (wager.wagerAmount ?? 0)
    : (wager.wagerHalfAmount ?? 0);
  if (amount <= 0) return 0;

  const applied = applyDamage(bearer, amount, { tick: state.tick });
  const bus = state.events;
  if (bus.enabled) {
    bus.emit({
      type: "damage",
      tick: state.tick,
      sourceId: wager.sourceId,
      targetId: bearer.id,
      amount: applied.absorbedByShield + applied.dealtToHp,
      absorbedByShield: applied.absorbedByShield,
      dealtToHp: applied.dealtToHp,
      overkill: applied.incoming - applied.absorbedByShield - applied.dealtToHp,
      crit: false,
      cause: `yinYang:${wager.wagerMode}:${guessedWrong ? "wrong" : "right"}`,
    });
  }
  return applied.absorbedByShield + applied.dealtToHp;
}

/** Applies a status to a player, resolving re-application via its stacking rule. */
export function applyStatus(
  player: PlayerState,
  definition: StatusEffectDefinition,
  options: ApplyStatusOptions,
): StatusEffectInstance {
  const stacks = options.stacks ?? 1;
  // Kingdom passives may shorten how long this status lasts on its recipient
  // (ticket #81, e.g. Water's reduced Burn duration). Applied to every path
  // that consumes the duration (fresh apply, refresh, stack, extend).
  const durationTicks = Math.round(
    options.durationTicks * statusDurationMultiplier(player, definition.id),
  );
  const existing = player.statuses.find((s) => s.id === definition.id);

  // Conditional stacking (Epic 12): e.g. Poison stacks while the bearer is
  // Corroded, but merely refreshes otherwise.
  let stacking = definition.stacking;
  if (
    definition.stackingWhileStatus &&
    hasStatus(player, definition.stackingWhileStatus.statusId)
  ) {
    stacking = definition.stackingWhileStatus.stacking;
  }

  if (!existing) {
    const instance: StatusEffectInstance = {
      id: definition.id,
      sourceId: options.sourceId,
      remainingTicks: durationTicks,
      stacks,
      // Snapshot the recurring effects so per-tick processing needs no
      // definition lookup (#78).
      tickEffects: definition.tickEffects?.map((t) => ({ ...t })),
      initialDurationTicks: durationTicks,
      blocksTargetingSource: definition.blocksTargetingSource,
      deflectsAttackOnSource: definition.deflectsAttackOnSource
        ? { ...definition.deflectsAttackOnSource }
        : undefined,
      blocksAttacks: definition.blocksAttacks,
      guaranteesChanceEffects: definition.guaranteesChanceEffects,
      onExpireStatus: definition.onExpireStatus,
      blocksPurchases: definition.blocksPurchases,
      onHitRetaliate: definition.onHitRetaliate,
      onHitRetaliateExtra: definition.onHitRetaliateExtra,
      drainsIncome: definition.drainsIncome,
      blocksTargetChange: definition.blocksTargetChange,
      incomingMissChance: definition.incomingMissChance,
      attackMissChance: definition.attackMissChance,
      drainPerSecond: definition.crawlers?.drainPerSecond,
      hitsToKill: definition.crawlers?.hitsToKill,
      // One entry per bug, counting the clicks it has taken so far.
      bugHits: definition.crawlers
        ? new Array<number>(definition.crawlers.count).fill(0)
        : undefined,
      deflectsMissedAttack: definition.deflectsMissedAttack,
      missChargesSupernova: definition.missChargesSupernova,
      bearerTakesPctOfSourceDamage: definition.bearerTakesPctOfSourceDamage,
      negateDamageHealPct: definition.negateDamageHealPct,
      thornsPct: definition.thornsPct,
      revealsBeforeExpiry: definition.revealsBeforeExpiry,
      blocksBearerShield: definition.blocksBearerShield,
      isBurn: definition.isBurn,
      shieldedTickAmount: definition.shieldedTickAmount,
      endsOnShieldPurchase: definition.endsOnShieldPurchase,
      chargesSourceMemoryPerTick: definition.chargesSourceMemoryPerTick,
      intensifiesOnBearerAttack: definition.intensifiesOnBearerAttack,
      // Starts at 1× and climbs each time the bearer attacks (Fox Fire).
      intensity: 1,
      strippedCardRanks: definition.strippedCardRanks,
      basicAttacksOnly: definition.basicAttacksOnly,
      basicAttacksRemaining: definition.basicAttackLimit,
      grantsMultiTarget: definition.grantsMultiTarget,
      noDamageSpread: definition.noDamageSpread,
      attackInflicts: definition.attackInflicts,
      // The buy-off price is fixed the moment it lands, scaled by how big the
      // bearer is right now — shedding citizens afterwards doesn't make it
      // cheaper, and hiring more doesn't make it dearer.
      dispelCost:
        definition.dispelCostPerCitizen === undefined
          ? undefined
          : Math.max(
              0,
              Math.round(definition.dispelCostPerCitizen * player.economy.citizens),
            ),
      hasModifiers: (definition.modifiers ?? []).length > 0,
    };
    player.statuses.push(instance);

    // A targeting ban severs an existing lock-on too: if the bearer is
    // currently aiming at the applier, the target is cleared and the switch
    // cooldown waived so they can immediately aim elsewhere (#87–#88).
    if (definition.blocksTargetingSource && player.target === options.sourceId) {
      player.target = null;
      player.targetSwitchReadyTick = 0;
    }

    // Linked stat modifiers live exactly as long as the status (#79/#80);
    // they are removed with it, restoring the player's statistics (#77).
    for (const [i, spec] of (definition.modifiers ?? []).entries()) {
      addModifier(player, {
        id: `${statusModifierSource(definition.id)}:${i}`,
        stat: spec.stat,
        op: spec.op,
        value: spec.value,
        sourceId: statusModifierSource(definition.id),
        remainingTicks: null, // lifecycle bound to the status, not a timer
        conditions: spec.conditions,
        stringValue: spec.stringValue,
        usageLimit: spec.usageLimit,
      });
    }
    return instance;
  }

  switch (stacking) {
    case "none":
      // Already present — leave it untouched.
      break;
    case "refresh":
      existing.remainingTicks = durationTicks;
      existing.sourceId = options.sourceId;
      // Re-application renews the effect: restart its elapsed clock so ramping
      // DoTs and half-life steps measure from this fresh application.
      existing.tickElapsed = 0;
      existing.initialDurationTicks = durationTicks;
      // Re-application wins: a stronger variant's recurring effects replace
      // the snapshot (Epic 12, e.g. strong Poison over weak).
      if (definition.tickEffects) {
        existing.tickEffects = definition.tickEffects.map((t) => ({ ...t }));
      }
      break;
    case "replace":
      removeStatus(player, definition.id);
      return applyStatus(player, definition, options);
    case "stack": {
      const max = definition.maxStacks ?? Number.POSITIVE_INFINITY;
      existing.stacks = Math.min(existing.stacks + stacks, max);
      existing.remainingTicks = durationTicks;
      existing.sourceId = options.sourceId;
      existing.tickElapsed = 0;
      existing.initialDurationTicks = durationTicks;
      if (definition.tickEffects) {
        existing.tickEffects = definition.tickEffects.map((t) => ({ ...t }));
      }
      break;
    }
    case "extend":
      existing.remainingTicks += durationTicks;
      break;
  }
  return existing;
}

/**
 * Removes (dispels) a status from a player (#77). Any stat modifiers the
 * status granted are removed with it, restoring the player's statistics.
 * Returns true if one was removed.
 */
export function removeStatus(player: PlayerState, statusId: string): boolean {
  const before = player.statuses.length;
  player.statuses = player.statuses.filter((s) => s.id !== statusId);
  const removed = player.statuses.length < before;
  if (removed) {
    removeModifiersFromSource(player, statusModifierSource(statusId));
  }
  return removed;
}

/**
 * Prunes statuses whose modifiers have been fully consumed (e.g. Blazing
 * Determination once its one-shot damage buff is spent). Returns the removed
 * statuses so callers can emit `statusExpired` for them — consumers (VFX,
 * replays, recorders) can't otherwise tell a usage-exhausted buff has ended.
 */
export function pruneExhaustedStatuses(player: PlayerState): StatusEffectInstance[] {
  const keptStatuses: StatusEffectInstance[] = [];
  const removed: StatusEffectInstance[] = [];
  for (const s of player.statuses) {
    if (s.hasModifiers) {
      const hasActiveMod = player.modifiers.some((m) => m.sourceId === statusModifierSource(s.id));
      if (!hasActiveMod) {
        removeModifiersFromSource(player, statusModifierSource(s.id));
        removed.push(s);
        continue;
      }
    }
    keptStatuses.push(s);
  }
  player.statuses = keptStatuses;
  return removed;
}

export function getStatus(
  player: PlayerState,
  statusId: string,
): StatusEffectInstance | undefined {
  return player.statuses.find((s) => s.id === statusId);
}

export function hasStatus(player: PlayerState, statusId: string): boolean {
  return player.statuses.some((s) => s.id === statusId);
}

/**
 * Advances every player's status durations by one tick, removing expired ones
 * and stripping their linked stat modifiers (#77 — expiry restores statistics).
 * Returns the removed statuses so callers can run onExpire effects / emit events.
 */
export function tickStatuses(state: GameState): RemovedStatus[] {
  const bus = state.events;
  const removed: RemovedStatus[] = [];
  for (const player of state.getPlayers()) {
    // Usage-exhausted statuses removed this tick still report as expired.
    for (const s of pruneExhaustedStatuses(player)) {
      if (bus.enabled) {
        bus.emit({ type: "statusExpired", tick: state.tick, playerId: player.id, statusId: s.id });
      }
    }

    const kept: StatusEffectInstance[] = [];
    const expired: StatusEffectInstance[] = [];
    for (const status of player.statuses) {
      // A status with no clock never expires on time — the only thing that
      // ends it is the condition it names (Kitsune's "Old Friends": buying a
      // shield). Skipped before the countdown so it can't tick to zero.
      if (status.endsOnShieldPurchase) {
        kept.push(status);
        continue;
      }
      status.remainingTicks -= 1;
      if (status.remainingTicks > 0) {
        kept.push(status);
      } else if (status.revealsBeforeExpiry && !status.revealed) {
        // Two-phase status (Love's "Love Galore"): the stealth window ran out
        // without the healing threshold being crossed — reveal now and restart
        // for a fresh, fully-visible window of the same length.
        status.revealed = true;
        status.remainingTicks = status.initialDurationTicks ?? 1;
        kept.push(status);
        if (bus.enabled) {
          bus.emit({ type: "statusRevealed", tick: state.tick, playerId: player.id, statusId: status.id });
        }
      } else {
        removed.push({ playerId: player.id, status });
        expired.push(status);
        removeModifiersFromSource(player, statusModifierSource(status.id));
        // Gameplay event (#204): the status ran out naturally.
        if (bus.enabled) {
          bus.emit({
            type: "statusExpired",
            tick: state.tick,
            playerId: player.id,
            statusId: status.id,
          });
        }
      }
    }
    player.statuses = kept;

    // Follow-up statuses on natural expiry (Epic 11, e.g. thawing from
    // Frozen briefly slows production). Applied after the reassignment so
    // the follow-up isn't wiped with the expiring batch.
    for (const status of expired) {
      // Love's Cupid's Arrow expiring: the "infatuated" kingdom's loaned
      // citizens travel home. Only the raw citizen count moves — the loan
      // never touched the price ladder, so there's nothing to unwind there.
      if (status.citizenLoanAmount) {
        const lover = state.getPlayer(status.sourceId);
        if (lover) {
          const giveBack = Math.min(status.citizenLoanAmount, lover.economy.citizens);
          if (giveBack > 0) {
            lover.economy.citizens -= giveBack;
            player.economy.citizens += giveBack;
            recalcIncome(lover);
            recalcIncome(player);
            if (bus.enabled) {
              bus.emit({
                type: "resourceTransfer",
                tick: state.tick,
                fromId: lover.id,
                toId: player.id,
                resource: "citizens",
                amount: giveBack,
                cause: "infatuated",
              });
            }
          }
        }
      }
      // Dark's Yin and Yang running out unbought: the wager settles on the
      // "didn't buy" side. Yang was betting on exactly this, so it lands in
      // full; Yin misread them, and they get away with half.
      if (status.wagerMode) {
        settleYinYang(state, player, status, false);
      }
      // Space's Supernova lock expiring: return the bearer to the target they
      // had before they were forced onto the victim (#redirect).
      if (status.blocksTargetChange && status.restoreTargetId !== undefined) {
        player.target = status.restoreTargetId;
        if (bus.enabled && status.restoreTargetId !== null) {
          bus.emit({
            type: "targetChanged",
            tick: state.tick,
            playerId: player.id,
            targetId: status.restoreTargetId,
          });
        }
      }
      if (status.onExpireStatus) {
        const inst = applyStatus(player, status.onExpireStatus.status, {
          sourceId: status.sourceId,
          durationTicks: status.onExpireStatus.durationTicks,
        });
        if (bus.enabled) {
          bus.emit({
            type: "statusApplied",
            tick: state.tick,
            targetId: player.id,
            sourceId: status.sourceId,
            statusId: inst.id,
            durationTicks: inst.remainingTicks,
            stacks: inst.stacks,
          });
        }
      }
    }
  }
  return removed;
}

/**
 * Executes every active status's recurring per-tick effects (#78): burn/poison
 * damage (through the shared shield→HP application, so death detection sees
 * DoT kills), regeneration heals capped at max HP, with optional per-stack
 * scaling. Run once per tick, before durations advance.
 */
export function processStatusTicks(
  state: GameState,
  rng: () => number = Math.random,
): void {
  const bus = state.events;
  for (const player of state.getPlayers()) {
    if (player.eliminated) continue;
    for (const status of player.statuses) {
      // Advance the status's own tick counter once per game tick, for
      // interval-cadence effects (e.g. Father Time's once-per-second punish).
      const elapsed = (status.tickElapsed = (status.tickElapsed ?? 0) + 1);

      // "Old Friends": while the foxes are loose, Kitsune remembers. Credited
      // to whoever set them on this kingdom, every tick they are still here.
      if (status.chargesSourceMemoryPerTick) {
        const owner = state.getPlayer(status.sourceId);
        if (owner && !owner.eliminated) {
          creditMemoryDirect(owner, status.chargesSourceMemoryPerTick);
        }
      }
      for (const effect of status.tickEffects ?? []) {
        // Interval cadence: fire only on this effect's Nth tick (default every).
        const interval = effect.intervalTicks ?? 1;
        if (interval > 1 && elapsed % interval !== 0) continue;

        // Idle gate (Father Time): the tick is avoided if the bearer landed a
        // damaging attack since the last evaluation — measured over the window
        // that just closed — and the countdown resets for the next window.
        if (effect.onlyIfBearerIdleSinceLastTick) {
          const windowStart = status.lastIdleEvalTick ?? state.tick - interval;
          const dealtDamage = player.lastDamageDealtTick > windowStart;
          status.lastIdleEvalTick = state.tick;
          if (dealtDamage) {
            // Interrupted — the victim bought back a second. No damage.
            if (bus.enabled) {
              bus.emit({
                type: "statusTick",
                tick: state.tick,
                playerId: player.id,
                statusId: status.id,
                interrupted: true,
              });
            }
            continue;
          }
        }

        if (effect.chance !== undefined && rng() >= effect.chance) {
          continue;
        }

        // "applyStatus": this tick seeds ANOTHER status on the bearer instead
        // of dealing damage — Fire's Ignited rolling a Burn every fifteen
        // seconds. None of the damage machinery below applies to it.
        //
        // Credited to whoever applied the CARRIER, not to the carrier itself,
        // so the burn belongs to the kingdom that lit them: it feeds that
        // kingdom's passives and counts as their damage, exactly as it would
        // had they applied the burn directly.
        if (effect.type === "applyStatus") {
          if (!effect.applies) continue;
          const seeded = applyStatus(player, effect.applies.status, {
            sourceId: status.sourceId,
            durationTicks: effect.applies.durationTicks,
          });
          if (bus.enabled) {
            bus.emit({
              type: "statusApplied",
              tick: state.tick,
              targetId: player.id,
              sourceId: status.sourceId,
              statusId: seeded.id,
              durationTicks: seeded.remainingTicks,
              stacks: seeded.stacks,
            });
          }
          continue;
        }
        // Half-life step: past the midpoint of its duration, the effect can
        // switch to a heavier magnitude (Father Time: 100 → 200 in the back
        // half). Measured from the elapsed clock vs the applied duration.
        const pastHalfLife =
          effect.amountAfterHalfLife !== undefined &&
          status.initialDurationTicks !== undefined &&
          elapsed * 2 > status.initialDurationTicks;
        const perTickAmount = pastHalfLife
          ? effect.amountAfterHalfLife!
          : effect.amount;
        // Magma's burn is softened while a shield is up: it still pierces (see
        // `piercesShields` below), but for less, so raising a shield is worth
        // doing against Magma without being a full answer to it.
        const shieldSoftened =
          status.shieldedTickAmount !== undefined && player.castle.shield > 0
            ? status.shieldedTickAmount
            : perTickAmount;
        let stacked = effect.perStack
          ? shieldSoftened * status.stacks
          : shieldSoftened;
        // Ramp: DoTs that worsen the longer they fester (Nature's Poison vs
        // Fire's flat Burn) — ×(1 + rampPerSecond × secondsActive), capped.
        if (effect.rampPerSecond) {
          const seconds = elapsed / param("tick.rate", TICK.RATE);
          const rampMult = Math.min(
            effect.rampMaxMultiplier ?? Number.POSITIVE_INFINITY,
            1 + effect.rampPerSecond * seconds,
          );
          stacked *= rampMult;
        }
        // Fox Fire: every attack the BEARER made since this landed has fanned
        // the flames. Stored on the instance so it compounds across ticks and
        // survives refreshes.
        if (status.intensity && status.intensity !== 1) {
          stacked *= status.intensity;
        }
        // Magma's "Floor is Lava": while the field is molten, EVERY burn on it
        // hits harder — no matter which kingdom set it.
        if (status.isBurn) {
          stacked *= lavaFloorMultiplier(state, player.id);
        }
        // Balance knob (ticket #202): a DoT's per-tick DAMAGE is tunable through
        // `status.<id>.tickDamage` (a multiplier, so all severity variants —
        // e.g. weak/strong Poison — scale together and keep their ratio). Reads
        // through on the null-set fast path, so the live game pays nothing.
        const base =
          effect.type === "damage"
            ? stacked * param(`status.${status.id}.tickDamage`, 1)
            : stacked;
        // DoT amplification (Epic 12): statuses on the bearer may amplify a
        // named DoT via "dotDamage:<statusId>" modifiers — e.g. Corroded
        // increasing Poison damage. Kingdom DoT-resistance passives (Water's
        // "Fountain of Youth") then cut damage from named DoTs by their pct.
        // Perks apply here too, since a DoT tick never passes through
        // `resolveDamage`: "Extra Medics" cuts damage-over-time specifically,
        // and "Extra Guards" cuts all incoming damage — both, if both are held.
        const amount = Math.round(
          computeStat(player, `dotDamage:${status.id}`, base) *
            (effect.type === "damage"
              ? dotResistanceMultiplier(player, status.id) *
                perkDotDamageTakenMultiplier(player) *
                perkDamageTakenMultiplier(player)
              : 1),
        );
        if (effect.type === "damage") {
          // Magma's "Hotter fire": a DoT inflicted BY Magma goes straight
          // through a shield. Read off whoever applied the status, so it
          // follows Magma's damage rather than the status definition — any
          // burn Magma lands pierces, whichever ability put it there.
          const inflicter = status.sourceId
            ? state.getPlayer(status.sourceId)
            : undefined;
          const piercesShields =
            effect.ignoreShields === true ||
            (inflicter !== undefined && dotIgnoresShields(inflicter));
          const applied = applyDamage(player, amount, {
            ignoreShields: piercesShields,
            tick: state.tick,
          });
          // Attribute this DoT tick back to the attack that applied the status,
          // so Blip's undo refunds status-based damage too (if still journaled).
          if (status.journalId) {
            const rec = player.attackJournal.find((r) => r.id === status.journalId);
            if (rec) {
              rec.hpRefund += applied.dealtToHp;
              rec.shieldRefund += applied.absorbedByShield;
            }
          }
          // Gameplay event (#204): DoT damage, attributed to its status.
          if (bus.enabled) {
            bus.emit({
              type: "damage",
              tick: state.tick,
              sourceId: status.sourceId,
              targetId: player.id,
              amount: applied.absorbedByShield + applied.dealtToHp,
              absorbedByShield: applied.absorbedByShield,
              dealtToHp: applied.dealtToHp,
              overkill: applied.incoming - applied.absorbedByShield - applied.dealtToHp,
              crit: false,
              cause: `status:${status.id}`,
            });
            if (applied.absorbedByShield > 0 && player.castle.shield <= 0) {
              bus.emit({
                type: "shieldDestroyed",
                tick: state.tick,
                playerId: player.id,
                cause: `status:${status.id}`,
              });
            }
          }
          // Love's "BFFS!!!" link: DoT damage on a linked castle also lands
          // on its partner (single hop — the partner's own link never
          // re-triggers from this direct applyDamage call).
          const link = player.statuses.find((s) => s.linkedPartnerId);
          if (link) {
            const partner = state.getPlayer(link.linkedPartnerId!);
            if (partner && !partner.eliminated) {
              const mirrored = applyDamage(partner, amount, { tick: state.tick });
              if (bus.enabled) {
                bus.emit({
                  type: "damage",
                  tick: state.tick,
                  sourceId: status.sourceId,
                  targetId: partner.id,
                  amount: mirrored.absorbedByShield + mirrored.dealtToHp,
                  absorbedByShield: mirrored.absorbedByShield,
                  dealtToHp: mirrored.dealtToHp,
                  overkill: mirrored.incoming - mirrored.absorbedByShield - mirrored.dealtToHp,
                  crit: false,
                  cause: `linked:status:${status.id}`,
                });
              }
            }
          }
        } else {
          const before = player.castle.hp;
          const requested = Math.max(0, amount);
          player.castle.hp = Math.min(
            player.castle.maxHp,
            player.castle.hp + requested,
          );
          const healed = player.castle.hp - before;
          if (healed > 0 && bus.enabled) {
            bus.emit({
              type: "heal",
              tick: state.tick,
              targetId: player.id,
              amount: healed,
              overheal: requested - healed,
              cause: `status:${status.id}`,
            });
          }
        }
      }
    }
  }
}
