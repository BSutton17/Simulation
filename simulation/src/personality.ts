import {
  activateAbility,
  getUpgradeLevel,
  resolveAbility,
  type AbilityDefinition,
  type AbilityKind,
} from "../../src/engine/abilities.js";
import {
  buyCitizen,
  buyShield,
  citizenCost,
  repairCastle,
  unlockOrUpgradeAbility,
} from "../../src/engine/purchases.js";
import { selectTarget } from "../../src/engine/targeting.js";
import { canMultiTargetAttacks, multiTargetLimit } from "../../src/engine/passives.js";
import { computeStat } from "../../src/engine/modifiers.js";
import { getCooldown } from "../../src/engine/cooldowns.js";
import { hasStatus } from "../../src/engine/status.js";
import { abilitiesForKingdom } from "../../src/data/kingdomAbilities.js";
import { SHIELD, TICK } from "../../src/data/balance.js";
import { param } from "../../src/engine/parameters.js";
import type { PlayerState } from "../../src/match/playerState.js";
import type { AIContext, AIController, AIFactory } from "./types.js";
import type { Rng } from "./rng.js";
import {
  aiTraceEnabled,
  recordDecision,
  type DecisionEntry,
  type DecisionOutcome,
} from "./aiDiagnostics.js";

/**
 * Effect types `abilityValue()` has a `case` for.
 *
 * Diagnostics only — this list does not change behaviour. It exists so a trace
 * can name exactly which of an ability's effects the value model cannot see,
 * which is what turns "this ability is never cast" into an actionable finding.
 */
const MODELED_EFFECTS: ReadonlySet<string> = new Set([
  "damage", "heal", "shield", "status",
  "economyModifier", "resourceTransfer", "buff", "debuff", "cooldownModify",
]);

/**
 * AI decision framework (ticket #205).
 *
 * ONE generic decision engine drives every playstyle. A "personality" is pure
 * data — a PersonalityProfile of thresholds, priorities, and weights — never
 * a code branch. The engine evaluates gameplay METADATA (ability kind, cost,
 * targeting mode, charge system, upgrade tiers) and current player state; it
 * contains no kingdom- or ability-specific knowledge, so new kingdoms,
 * abilities, and personalities require zero framework changes.
 *
 * All actions go through the public gameplay API — the exact engine calls the
 * live socket handlers make (activateAbility, buyCitizen, repairCastle,
 * buyShield, selectTarget, unlockOrUpgradeAbility). The engine validates
 * everything; the AI can no more cheat than a human can.
 */

/** How a personality picks who to fight. */
export type TargetingStrategy =
  | "lowestHp" // finish the weakest castle
  | "strongest" // hit the biggest threat
  | "richest" // deny the largest treasury
  | "highestIncome" // strangle the best economy
  | "random"; // chaos (seeded)

/**
 * A spending category. Personalities order these; earlier categories spend
 * first, and the abilities category additionally RESERVES the price of its
 * next unlock/upgrade against everything later in the order — so casting can
 * never starve kit progression forever. This is what makes "saves for
 * upgrades" vs "dumps everything into attacks" expressible as pure data.
 */
export type SpendCategory = "defense" | "economy" | "abilities" | "cast";

export interface PersonalityProfile {
  /** Display name (also the PERSONALITIES registry key). */
  name: string;
  /** Make decisions every N ticks. */
  actEveryTicks: number;
  /**
   * Probability (0–1) per decision of behaving randomly instead of following
   * policy: random target, random affordable cast. Drawn from the seat's
   * seeded RNG stream, so chaotic play is still reproducible.
   */
  chaos: number;
  /**
   * Opportunity cost (0–1). How willing the AI is to hold gold — forgoing a
   * weaker cast now — to afford a materially stronger play that is close to
   * available (coming off cooldown, or reachable within a few seconds of
   * income). 0 = pure tempo, spends greedily on the best affordable option
   * every decision; 1 = maximally patient, saves for the strongest reachable
   * play. This is the "should I spend now or wait for something that wins
   * harder?" capability, expressed per personality.
   */
  patience: number;
  /**
   * Decision noise (0–1), default 0.25. Jitters the ranking of otherwise
   * close plays so a seat explores its strategy NEIGHBOURHOOD across seeds.
   *
   * This is not `chaos`, which discards policy for a turn and picks at random.
   * Exploration keeps the policy and only perturbs how ties and near-ties
   * resolve, so play stays coherent.
   *
   * It exists because a fully deterministic policy makes the simulator a poor
   * measuring instrument: every seed replays essentially the same match
   * (measured duration spread of 1.6–2.3%), so a matchup's "win rate" is not a
   * probability but a boolean — 40/40 or 0/40 — and it flips wholesale when the
   * profile changes. Sampling nearby lines of play turns win rate back into an
   * estimate of matchup strength. Determinism is unaffected: the jitter is
   * drawn from the seat's seeded stream, so a given seed still replays exactly.
   */
  exploration?: number;

  targeting: {
    strategy: TargetingStrategy;
  };

  /** Spending order — earlier categories spend and reserve first. */
  spendPriority: SpendCategory[];

  economy: {
    /** Buy a citizen when spendable gold ≥ its cost × this factor. */
    citizenBudgetFactor: number;
    /** Stop investing in citizens beyond this count. */
    maxCitizens: number;
    /** Gold reserve normal spending never dips below. */
    savingsFloor: number;
  };

  defense: {
    /** Repair when castle HP falls below this fraction of max. */
    repairHpFraction: number;
    /** Buy a shield when spendable gold ≥ its cost × this factor. */
    shieldBudgetFactor: number;
    /**
     * Below this HP fraction the kingdom is in crisis: defense spending runs
     * first and ignores the savings floor.
     */
    emergencyHpFraction: number;
  };

  offense: {
    /** Unlock the cheapest locked ability when gold ≥ price × this factor. */
    unlockBudgetFactor: number;
    /** Buy the next upgrade tier when gold ≥ price × this factor. */
    upgradeBudgetFactor: number;
    /** Cast an ability when spendable gold ≥ its cost × this factor. */
    castBudgetFactor: number;
    /** Cast order preference by ability kind (metadata, not names). */
    preferKinds: AbilityKind[];
  };

  ultimate: {
    /**
     * Enemy-targeted ultimates wait until the target's HP fraction is below
     * this (1 = fire at will, 0.35 = held for the kill window).
     */
    targetHpFraction: number;
    /**
     * Self-targeted ultimates (heals, self-buffs) wait until OWN HP fraction
     * is below this (1 = use freely, 0.5 = save it for trouble).
     */
    selfHpFraction: number;
  };
}

/** The unlock price rule mirrored from purchase metadata (policy, not logic —
 *  the engine still validates the real price on purchase). */
function unlockPrice(ability: AbilityDefinition): number {
  return ability.unlockCost ?? Math.ceil((ability.cost ?? 0) * 0.5);
}

/**
 * Fallback valuation for an effect the model has no bespoke evaluator for.
 *
 * Reads the effect's own numbers: a damage/absorb magnitude counts like damage,
 * a duration counts like control, meter charge counts as progress toward the
 * kingdom's gated payoff. An effect carrying no numbers at all still returns a
 * positive floor, because scoring it zero is what made whole kits unplayable.
 */
function genericEffectValue(
  effect: { type: string; params: Record<string, unknown> },
  mode: string,
  enemyHits: number,
  toSelf: boolean,
): number {
  const p = effect.params;
  // Field-wide and self-targeted effects always land once; enemy-directed ones
  // need a live target.
  const hits = toSelf || mode === "self" || mode === "noTarget" ? 1 : enemyHits;
  if (hits === 0) return 0;

  let value = 0;
  let quantified = false;

  // Damage/absorb magnitude. `amount` is the headline figure when present;
  // otherwise take the largest alternative (variant payloads, not additive).
  let magnitude = typeof p.amount === "number" ? p.amount : 0;
  if (magnitude === 0) {
    for (const key of MAGNITUDE_KEYS) {
      const v = p[key];
      if (typeof v === "number" && v > magnitude) magnitude = v;
    }
  }
  if (magnitude > 0) {
    value += magnitude * hits;
    quantified = true;
  }

  // Meter progress — the mechanism gating a kingdom's biggest play.
  for (const key of METER_KEYS) {
    const charge = p[key];
    if (typeof charge === "number" && charge > 0) {
      value += charge * VALUE.meterChargePerPoint;
      quantified = true;
    }
  }

  // A duration on an unmodeled effect means a persistent field or lock effect.
  const duration = p.durationTicks;
  if (typeof duration === "number" && duration > 0) {
    const seconds = Math.min(duration / TICK.RATE, VALUE.controlCapSeconds);
    const rate = toSelf ? VALUE.selfBuffPerSecond : VALUE.enemyControlPerSecond;
    value += seconds * rate * hits;
    quantified = true;
  }

  // Nothing numeric to read (wagers, draws, spins, undo). Keep it in the
  // running on a flat floor rather than filtering it out entirely.
  return quantified ? value : VALUE.unknownEffect * hits;
}

/**
 * Heuristic value weights, all in a single HP-equivalent currency so that
 * heterogeneous effects — direct damage, damage-over-time, healing, shields,
 * crowd control, and economy swings — can be compared on one scale. The AI
 * ranks casts by value ÷ gold, so only the RELATIVE magnitudes matter.
 *
 * Nothing here is ability- or kingdom-specific: the value of a cast is read
 * entirely from its resolved effect metadata at decision time. That is what
 * lets "spam the cheapest attack" win ONLY when it is genuinely the most
 * gold-efficient play, rather than by construction — and it makes an ability's
 * damage numbers a live input to the decision again (buff Firenado enough and
 * the AI will start choosing it, with no code change).
 */
const VALUE = {
  /** 1 HP restored ≈ 1 HP of damage prevented. */
  healPerHp: 1,
  /** Shields are temporary and can be bypassed, so worth a little less. */
  shieldPerHp: 0.7,
  /** HP-equivalent of impairing an enemy (freeze, purchase lock, targeting
   *  ban, income debuff) for one second. */
  enemyControlPerSecond: 60,
  /** HP-equivalent of one second of a self-buff (crit surge, deflection …). */
  selfBuffPerSecond: 40,
  /** Cap on how long a control/buff is credited, so a very long lock does not
   *  dwarf everything else. */
  controlCapSeconds: 12,
  /** HP-equivalent of gaining one citizen (a future income engine). */
  citizen: 30,
  /** HP-equivalent per gold stolen or denied. */
  currencyPerGold: 0.5,
  /** Credit for applying a status that a *later* ability in the kit pays off
   *  (lifesteal-vs-status, bonus-damage-vs-status, longer-duration-vs-status).
   *  This is how "setup" and "combo" plays earn value without naming them. */
  setup: 150,
  /** HP-equivalent per point of progress on a charge meter (Supernova, Ancient
   *  Memory). Meters gate a kingdom's biggest play, so filling one is worth
   *  real value — per point, so it never outbids a landed hit. */
  meterChargePerPoint: 6,
  /**
   * Floor value for an effect the model has no specific evaluator for.
   *
   * The engine defines 28 effect primitives in live ability data; this
   * heuristic has cases for 9. Scoring the rest at 0 made every ability built
   * purely from them structurally invisible — never ranked, never cast, at any
   * price. Fifteen of the game's eighty abilities were dead this way, whole
   * kits among them. A positive floor keeps them in the running, and means a
   * NEW primitive added by a future kingdom degrades to "considered" rather
   * than "unusable".
   */
  unknownEffect: 260,
};

/** Numeric effect params that behave like a damage or absorb magnitude, read
 *  generically so unmodeled effects are still valued from their own data. */
const MAGNITUDE_KEYS = ["amount", "shieldOnlyAmount", "targeterDamage"] as const;
/** Params that advance a charge meter. */
const METER_KEYS = ["supernovaCharge", "memoryCharge"] as const;

/** How far toward affording a finisher (ultimate) the AI must already be before
 *  it holds gold for the final push (0.6 = 60%). Ultimates are gated to a
 *  low-HP kill window, so this saving only happens in the endgame — never a
 *  match-long hoard, so tempo never collapses. */
const SAVINGS_NEAR_FRACTION = 0.6;
/** A play must be at least this much more valuable than the best option
 *  available right now to be worth holding gold (skipping a cast) for. */
const SAVINGS_MARGIN = 1.25;
/**
 * How far ahead the AI looks for an ability that is still cooling down, in
 * ticks, when deciding whether to bank gold (scaled by `patience`).
 *
 * A kingdom's strongest plays carry its longest cooldowns — Water's Flood is a
 * 20 s cooldown and the most gold-efficient thing in the kit. Considering only
 * plays that are ready THIS instant meant the AI never saved for them: its
 * 3 s-cooldown filler attack drained the treasury between every cycle, so the
 * expensive ability was unaffordable on the one tick it became castable, and
 * the kit collapsed to its cheapest option. Looking ahead over a cooldown lets
 * the AI arrive at that moment solvent.
 */
const SAVINGS_LOOKAHEAD_TICKS = 500;
/** Default decision noise when a profile does not set `exploration`. */
const DEFAULT_EXPLORATION = 0.25;

/** The generic, metadata-driven controller. One instance per seat per match. */
export class PersonalityAI implements AIController {
  private readonly kit: AbilityDefinition[];
  /** Status ids that some ability in this kit pays off later (combo detection,
   *  built once from metadata — see VALUE.setup). */
  private readonly payoffStatuses: ReadonlySet<string>;
  /** Distinct elements this kit's attacks deal — used to spot targets its
   *  damage hits harder (vulnerabilities/amplifiers), fully via metadata. */
  private readonly attackElements: readonly string[];
  /**
   * Upgrade-resolved abilities, by ability id then upgrade level.
   *
   * `resolveAbility` deep-copies an ability and re-applies every upgrade tier
   * and parameter override; the controller called it for the whole kit on every
   * decision, which made it the largest single allocator in the AI hot path.
   * The result depends only on the ability, its level, and the active parameter
   * set — all fixed for the life of one controller — so it is safe to memoise
   * per match. Consumers only read the resolved copy; casts still pass the
   * original definition.
   *
   * Nested rather than keyed by a composed string: the composition itself was
   * measured at 8.4% of runtime, allocating a throwaway string per lookup.
   */
  private readonly resolved = new Map<string, Map<number, AbilityDefinition>>();

  /** Tick offset at which this seat makes its decisions. Seats that all act on
   *  the same ticks resolve in a fixed order every match, which is part of why
   *  matches replayed identically; staggering them from the seeded stream
   *  diversifies trajectories without giving anyone an advantage. */
  private readonly actPhase: number;

  constructor(
    private readonly profile: PersonalityProfile,
    player: PlayerState,
    rng?: Rng,
  ) {
    // Phase 0 without a seeded stream: a controller built directly (tests,
    // one-off harnesses) must stay reproducible. Only the simulation factory,
    // which owns a per-seat stream, staggers its seats.
    this.actPhase = rng
      ? Math.floor(rng() * Math.max(1, profile.actEveryTicks))
      : 0;
    // The kingdom's castable kit, ordered by the profile's kind preference —
    // enumerated once from data, never named.
    const rank = new Map(profile.offense.preferKinds.map((k, i) => [k, i]));
    this.kit = abilitiesForKingdom(player.kingdomId)
      .filter((a) => a.kind !== "passive")
      .sort(
        (a, b) => (rank.get(a.kind) ?? 99) - (rank.get(b.kind) ?? 99),
      );

    // Discover combos: any status id that a kit ability rewards hitting a
    // target that already bears it (lifesteal gate, bonus damage, extended
    // duration). Applying such a status is a valuable *setup* play.
    const payoff = new Set<string>();
    for (const ability of this.kit) {
      for (const effect of ability.effects) {
        const p = effect.params;
        if (p.lifesteal?.requiresTargetStatus) payoff.add(p.lifesteal.requiresTargetStatus);
        if (p.bonusDamageIfTargetHasStatus) payoff.add(p.bonusDamageIfTargetHasStatus.statusId);
        if (p.bonusDurationIfTargetHasStatus) payoff.add(p.bonusDurationIfTargetHasStatus.statusId);
      }
    }
    this.payoffStatuses = payoff;

    const elements = new Set<string>();
    for (const ability of this.kit) {
      if (ability.kind !== "attack") continue;
      for (const effect of ability.effects) {
        if (effect.type === "damage" && typeof effect.params.element === "string") {
          elements.add(effect.params.element);
        }
      }
    }
    this.attackElements = [...elements];
  }

  act(ctx: AIContext): void {
    const { match, player, tick } = ctx;
    if ((tick + this.actPhase) % this.profile.actEveryTicks !== 0) return;
    if (match.phase !== "active" || player.eliminated) return;

    const hpFraction = player.castle.hp / player.castle.maxHp;
    const emergency = hpFraction < this.profile.defense.emergencyHpFraction;

    this.chooseTarget(ctx);
    if (emergency) this.defend(ctx, true, 0); // crisis: defense first, no floor

    // Spend in the profile's priority order. Unmet goals reserve gold against
    // everything later in the order.
    let reserved = 0;
    for (const step of this.profile.spendPriority) {
      if (match.phase !== "active") return;
      switch (step) {
        case "defense":
          if (!emergency) this.defend(ctx, false, reserved);
          break;
        case "economy":
          this.investInEconomy(ctx, reserved);
          break;
        case "abilities":
          reserved += this.buyAbilities(ctx, reserved);
          break;
        case "cast":
          this.cast(ctx, reserved);
          break;
      }
    }
  }

  /** Upgrade-resolved form of an ability at the player's current level, cached
   *  for the life of this controller (see `resolved`). */
  private effectiveAbility(
    ability: AbilityDefinition,
    player: PlayerState,
  ): AbilityDefinition {
    const level = getUpgradeLevel(player, ability.id);
    // Keyed by id then level rather than by a composed `id:level` string.
    // The cache was already doing its job — profiling showed the cost was the
    // template literal itself, allocating and hashing a fresh string on every
    // lookup, in a function called several times per decision per ability.
    // Two map hops with values that already exist cost nothing by comparison.
    let byLevel = this.resolved.get(ability.id);
    if (byLevel === undefined) {
      byLevel = new Map<number, AbilityDefinition>();
      this.resolved.set(ability.id, byLevel);
    }
    let hit = byLevel.get(level);
    if (hit === undefined) {
      hit = resolveAbility(ability, level);
      byLevel.set(level, hit);
    }
    return hit;
  }

  /** Gold available for normal spending, after the floor and reservations. */
  private spendable(player: PlayerState, reserved: number): number {
    return (
      player.economy.currency - this.profile.economy.savingsFloor - reserved
    );
  }

  private roll(rng: Rng): boolean {
    return this.profile.chaos > 0 && rng() < this.profile.chaos;
  }

  // --- targeting -------------------------------------------------------------

  private chooseTarget({ match, player, rng }: AIContext): void {
    const state = match.gameState!;
    const enemies = state
      .getPlayers()
      .filter((p) => p.id !== player.id && !p.eliminated);
    if (enemies.length === 0) return;

    const current = player.target ? state.getPlayer(player.target) : undefined;
    const currentValid = current !== undefined && !current.eliminated;

    // Random strategy (or a chaos roll) re-targets only when needed, so the
    // switch cooldown is not fought pointlessly.
    const strategy = this.roll(rng) ? "random" : this.profile.targeting.strategy;
    if (strategy === "random") {
      if (!currentValid) {
        const pick = enemies[Math.floor(rng() * enemies.length)]!;
        selectTarget(match, player, pick.id);
      }
      return;
    }

    // Prefer an enemy this kit's damage hits harder — one the caster has marked
    // with an amplifying debuff (Thunderdome) or is elementally weak. Among the
    // most-amplified enemies, the personality's strategy still picks which one.
    // Amplification is computed once per enemy and reused. The previous form
    // built a closure, mapped it over the enemies to find the maximum, then
    // filtered with the SAME closure — evaluating attackAmplification twice for
    // every enemy, every decision, plus three throwaway arrays. Identical
    // results: attackAmplification is a pure read of player and enemy state.
    let maxAmp = -Infinity;
    const amps: number[] = [];
    for (const enemy of enemies) {
      const value = this.attackAmplification(player, enemy);
      amps.push(value);
      if (value > maxAmp) maxAmp = value;
    }
    let pool = enemies;
    if (maxAmp > 1 + 1e-9) {
      const threshold = maxAmp - 1e-9;
      pool = [];
      for (let i = 0; i < enemies.length; i++) {
        if (amps[i]! >= threshold) pool.push(enemies[i]!);
      }
    }

    let best = pool[0]!;
    for (const enemy of pool) {
      if (this.targetPriority(enemy) > this.targetPriority(best)) best = enemy;
    }
    if (!currentValid || best.id !== current.id) {
      selectTarget(match, player, best.id); // engine enforces the switch cooldown
    }
  }

  /** The best damage multiplier this kit's attacks get against `enemy` right
   *  now (1 = none). Composed by the engine's own damageTaken pass, so target
   *  vulnerabilities and caster-applied amplifiers (Thunderdome) both count —
   *  no ability or kingdom is named. */
  private attackAmplification(player: PlayerState, enemy: PlayerState): number {
    let best = 1;
    for (const element of this.attackElements) {
      const mult = computeStat(enemy, "damageTaken", 1, player, "target", element, false);
      if (mult > best) best = mult;
    }
    return best;
  }

  /** How much this AI wants to hit `p`, per its targeting strategy (higher =
   *  preferred). Shared by primary target selection and multi-target spread. */
  private targetPriority(p: PlayerState): number {
    switch (this.profile.targeting.strategy) {
      case "strongest":
        return p.castle.hp + p.castle.shield;
      case "richest":
        return p.economy.currency;
      case "highestIncome":
        return p.economy.incomePerTick;
      case "lowestHp":
      default: // "random" and any future strategy fall back to finishing the weakest
        return -(p.castle.hp + p.castle.shield);
    }
  }

  /**
   * Air's "Embrace of Winds" in the hands of the AI (metadata-driven, no
   * kingdom names): a multi-target kingdom's singleEnemy ATTACK can strike
   * several enemies for one cost/cooldown, damage split evenly. The AI spreads
   * pressure across the highest-priority enemies up to the passive's cap — but
   * concentrates on a single target when the undivided hit would secure a kill
   * (a diluted finishing blow eliminates no one). Returns the target ids for a
   * multi-target cast, or undefined to use the normal single-target path.
   */
  private multiTargetIds(
    { match, player }: AIContext,
    effective: AbilityDefinition,
  ): string[] | undefined {
    if (
      effective.kind !== "attack" ||
      effective.targeting.mode !== "singleEnemy" ||
      !canMultiTargetAttacks(player)
    ) {
      return undefined;
    }
    const limit = multiTargetLimit(player);
    if (limit <= 1) return undefined;

    const state = match.gameState!;
    const enemies = state
      .getPlayers()
      .filter((p) => p.id !== player.id && !p.eliminated);
    if (enemies.length <= 1) return undefined; // nothing to spread to

    const primary = player.target ? state.getPlayer(player.target) : undefined;
    const primaryValid = primary !== undefined && !primary.eliminated;

    // Concentrate for a kill: if the undivided attack would eliminate the
    // primary target, single-target it rather than dilute the blow.
    const solo = this.soloAttackDamage(effective);
    if (
      primaryValid &&
      solo > 0 &&
      primary.castle.hp + primary.castle.shield <= solo
    ) {
      return undefined;
    }

    const ranked = [...enemies].sort(
      (a, b) => this.targetPriority(b) - this.targetPriority(a),
    );
    const ordered = primaryValid
      ? [primary, ...ranked.filter((e) => e.id !== primary.id)]
      : ranked;
    const ids = ordered.slice(0, limit).map((e) => e.id);
    return ids.length > 1 ? ids : undefined; // a single id is just a normal cast
  }

  /** Sum of an attack's raw damage effects (pre-crit/modifiers) — a cheap
   *  estimate of its undivided punch, used only to decide kill vs. spread. */
  private soloAttackDamage(ability: AbilityDefinition): number {
    let dmg = 0;
    for (const e of ability.effects) {
      if (e.type === "damage") dmg += (e.params.amount as number) ?? 0;
    }
    return dmg;
  }

  // --- economy ---------------------------------------------------------------

  private investInEconomy({ match, player, rng }: AIContext, reserved: number): void {
    const { citizenBudgetFactor, maxCitizens } = this.profile.economy;
    if (player.economy.citizens >= maxCitizens) return;
    // Chaos: sometimes simply forget to invest this round.
    if (this.roll(rng) && rng() < 0.5) return;
    if (
      this.spendable(player, reserved) >=
      citizenCost(player) * citizenBudgetFactor
    ) {
      buyCitizen(match, player);
    }
  }

  /** Repairs and shields, gated by the profile's thresholds. Priority order
   *  (not reservation) decides who gets first claim on the treasury. */
  private defend(
    { match, player }: AIContext,
    crisis: boolean,
    reserved: number,
  ): void {
    const { repairHpFraction, shieldBudgetFactor } = this.profile.defense;
    const gold = crisis
      ? player.economy.currency
      : this.spendable(player, reserved);

    if (player.castle.hp < player.castle.maxHp * repairHpFraction || crisis) {
      repairCastle(match, player); // engine enforces cost, funds, and the cap
    }
    const shieldCost = param("shield.cost", SHIELD.COST);
    if (
      player.castle.shield <= 0 &&
      (crisis ? gold >= shieldCost : gold >= shieldCost * shieldBudgetFactor)
    ) {
      buyShield(match, player);
    }
  }

  // --- abilities -------------------------------------------------------------

  /** Unlocks, then upgrades, cheapest first. Returns gold to reserve for the
   *  next purchase so casting cannot starve kit progression forever. */
  private buyAbilities({ match, player }: AIContext, reserved: number): number {
    const { unlockBudgetFactor, upgradeBudgetFactor } = this.profile.offense;
    const gold = this.spendable(player, reserved);

    // Unlock the cheapest locked ability first — widen the toolkit. The
    // reservation is factor-scaled so it always covers the purchase gate:
    // lower-priority spending can never permanently outrace it.
    const locked = this.kit
      .filter((a) => !player.unlocked[a.id])
      .sort((a, b) => unlockPrice(a) - unlockPrice(b));
    if (locked.length > 0) {
      const price = unlockPrice(locked[0]!);
      if (gold >= price * unlockBudgetFactor) {
        unlockOrUpgradeAbility(match, player, locked[0]!.id);
        return 0;
      }
      return price * unlockBudgetFactor; // finish unlocking before upgrading
    }

    // Then buy the cheapest available upgrade tier.
    let cheapest: { id: string; cost: number } | null = null;
    for (const ability of this.kit) {
      const level = getUpgradeLevel(player, ability.id);
      const next = (ability.upgradePath ?? []).find((t) => t.level === level + 1);
      if (next && (!cheapest || next.cost < cheapest.cost)) {
        cheapest = { id: ability.id, cost: next.cost };
      }
    }
    if (cheapest) {
      if (gold >= cheapest.cost * upgradeBudgetFactor) {
        unlockOrUpgradeAbility(match, player, cheapest.id);
        return 0;
      }
      return cheapest.cost * upgradeBudgetFactor;
    }
    return 0;
  }

  private cast(ctx: AIContext, reserved: number): void {
    const { match, player, rng } = ctx;
    const { castBudgetFactor } = this.profile.offense;

    // Score every viable play by expected value ÷ gold, then spend the treasury
    // on the best affordable ones first. Ranking by value/cost (not by cost, and
    // not by a fixed kind order) is the whole point: the AI casts what it
    // believes is the strongest option, so it will only "spam the cheapest
    // attack" when that attack is actually the most efficient — and it will
    // switch to a pricier ability the moment its numbers make it worth it.
    interface Play {
      ability: AbilityDefinition;
      /** The upgrade-resolved ability — its targeting mode and effect amounts
       *  drive multi-target selection at cast time. */
      effective: AbilityDefinition;
      cost: number;
      chargesToUse: number | undefined;
      value: number;
      efficiency: number;
      /** Ticks until this play is off cooldown / has a charge (0 = ready now). */
      readyInTicks: number;
      /** Sort key: efficiency after exploration jitter. */
      rank: number;
    }

    // A gentle per-personality lean by ability KIND (metadata, never names):
    // the most-preferred kind keeps its full value, later ones are shaded down,
    // so aggressive still favors attacks and defensive still favors utility
    // without any ability being hardcoded.
    const kindRank = new Map(
      this.profile.offense.preferKinds.map((k, i) => [k, i]),
    );

    // Diagnostics: when tracing is on, every ability gets an entry explaining
    // its fate. Free when off — one null check, nothing allocated.
    const tracing = aiTraceEnabled();
    const traced = new Map<string, DecisionEntry>();
    const note = (
      ability: AbilityDefinition,
      outcome: DecisionOutcome,
      extra: Partial<DecisionEntry> = {},
    ): void => {
      if (!tracing) return;
      traced.set(ability.id, {
        abilityId: ability.id,
        kind: ability.kind,
        outcome,
        value: 0,
        cost: ability.cost,
        efficiency: 0,
        readyInTicks: 0,
        ...extra,
      });
    };

    const plays: Play[] = [];
    for (const ability of this.kit) {
      if (!player.unlocked[ability.id]) {
        note(ability, "locked");
        continue; // mirror the live unlock gate
      }

      const effective = this.effectiveAbility(ability, player);
      if (!this.ultimateWindowOpen(ctx, effective)) {
        note(ability, "ultimateWindowClosed");
        continue;
      }

      let chargesToUse: number | undefined;
      let cost = effective.cost;
      let readyInTicks = getCooldown(player, ability.id);
      if (effective.chargeSystem) {
        const timers = player.recharges[ability.id] ?? [];
        const available = effective.chargeSystem.max - timers.length;
        if (available > 0) {
          chargesToUse = available;
          cost = effective.chargeSystem.costPerCharge * available;
          readyInTicks = 0;
        } else {
          // No charge in the pool: the soonest one back is the nearest timer.
          chargesToUse = 1;
          cost = effective.chargeSystem.costPerCharge;
          readyInTicks = timers.length ? Math.min(...timers) : Infinity;
        }
      }

      const value = this.abilityValue(ctx, effective, chargesToUse);
      if (value <= 0) {
        // The decisive diagnostic: name the effect types the value model has no
        // case for, so a dead ability points straight at the missing evaluator.
        note(ability, "zeroValue", {
          cost,
          readyInTicks,
          unmodeledEffects: tracing
            ? effective.effects
                .map((e) => e.type)
                .filter((t) => !MODELED_EFFECTS.has(t))
            : undefined,
        });
        continue; // never spend gold on a play with no upside
      }

      const lean = 1 - 0.1 * (kindRank.get(effective.kind) ?? 0);
      const efficiency = (value / Math.max(1, cost)) * lean;
      note(ability, readyInTicks === 0 ? "notReached" : "onCooldown", {
        value, cost, efficiency, readyInTicks,
      });
      plays.push({
        ability,
        effective,
        cost,
        chargesToUse,
        value,
        efficiency,
        readyInTicks,
        rank: efficiency,
      });
    }
    if (plays.length === 0) {
      if (tracing) this.flushTrace(ctx, traced, reserved, 0);
      return;
    }

    // Casting order. Chaos personalities cast a random affordable option;
    // everyone else casts most-gold-efficient first (id tiebreak keeps it
    // deterministic).
    const ready = plays.filter((p) => p.readyInTicks === 0);
    if (this.roll(rng)) {
      ready.sort(() => rng() - 0.5);
      for (const opt of ready) {
        const spendableNow = this.spendable(player, reserved);
        const required = opt.cost * castBudgetFactor;
        if (spendableNow < required) {
          note(opt.ability, "unaffordable", {
            value: opt.value, cost: opt.cost, efficiency: opt.efficiency,
            readyInTicks: opt.readyInTicks, spendable: spendableNow, required,
          });
          continue;
        }
        activateAbility(match, player, opt.ability, {
          targetId: player.target ?? undefined,
          targetIds: this.multiTargetIds(ctx, opt.effective),
          chargesToUse: opt.chargesToUse,
        });
        note(opt.ability, "cast", {
          value: opt.value, cost: opt.cost, efficiency: opt.efficiency,
        });
        if (match.phase !== "active") {
          if (tracing) this.flushTrace(ctx, traced, reserved, 0);
          return;
        }
      }
      if (tracing) this.flushTrace(ctx, traced, reserved, 0);
      return;
    }
    // Exploration: perturb each play's ranking key before sorting, so plays of
    // similar merit trade places between seeds. A clearly better play still
    // wins; only near-ties are resampled.
    const explore = this.profile.exploration ?? DEFAULT_EXPLORATION;
    if (explore > 0) {
      for (const p of ready) p.rank = p.efficiency * (1 + explore * (rng() * 2 - 1));
    } else {
      for (const p of ready) p.rank = p.efficiency;
    }
    ready.sort(
      (a, b) => b.rank - a.rank || a.ability.id.localeCompare(b.ability.id),
    );

    // Opportunity cost (#savings model). A patient AI does not just spam the
    // most gold-EFFICIENT ability — it prioritizes its highest-IMPACT play (a
    // finishing ultimate, a big nuke) even though that play is less efficient,
    // because efficiency-ordering would otherwise starve it. When that play is
    // affordable it is cast FIRST; when it is a nearly-affordable finisher, the
    // AI holds gold for the final push instead of frittering it on cheap casts.
    // patience 0 (aggressive, chaos) skips all of this and keeps pure tempo.
    const patience = this.profile.patience;
    let hold = 0;
    let priority: Play | null = null;
    if (patience > 0 && ready.length > 0) {
      const efficiencyLeader = ready[0]!; // most efficient ready play
      // The highest-impact play worth planning around — searched over the whole
      // kit within a cooldown lookahead, not just what is castable this instant.
      // A kingdom's best ability usually carries its longest cooldown, so
      // considering only ready plays meant the AI never banked for it.
      const lookahead = SAVINGS_LOOKAHEAD_TICKS * patience;

      // An ultimate that has passed its window gate IS the high-impact play, by
      // metadata rather than by name: `ultimateWindowOpen` only lets one through
      // at the moment the profile considers decisive. It therefore qualifies
      // regardless of the value margin, and outranks a non-ultimate — otherwise
      // valuing the rest of the kit properly lets ordinary abilities crowd the
      // finisher out of the slot patience exists to protect.
      const isUlt = (p: Play) => p.ability.kind === "ultimate";
      const qualifies = (p: Play, best: Play | null): boolean => {
        if (!isUlt(p) && p.value < efficiencyLeader.value * SAVINGS_MARGIN) {
          return false;
        }
        if (!best) return true;
        if (isUlt(p) !== isUlt(best)) return isUlt(p);
        return p.value > best.value;
      };

      // A play that is castable RIGHT NOW always wins the slot: acting beats
      // banking. Only when nothing ready is worth prioritising does the AI look
      // ahead over cooldowns to decide what to save for.
      let impact: Play | null = null;
      for (const p of ready) if (qualifies(p, impact)) impact = p;
      if (!impact) {
        for (const p of plays) {
          if (p.readyInTicks === 0 || p.readyInTicks > lookahead) continue;
          if (qualifies(p, impact)) impact = p;
        }
      }
      if (impact) {
        const need = impact.cost * castBudgetFactor;
        const spendableNow = this.spendable(player, reserved);
        if (impact.readyInTicks === 0 && spendableNow >= need) {
          priority = impact; // afford it now → cast it before the cheap spam
        } else if (spendableNow < need) {
          // Bank toward it — whether it is ready now or still cooling down.
          // Only when the gap is genuinely closable, so a play priced far
          // beyond this economy never freezes spending.
          const income = player.economy.incomePerTick;
          const ticksToAfford =
            income > 0 ? (need - spendableNow) / income : Infinity;
          const reachable =
            ticksToAfford <= SAVINGS_LOOKAHEAD_TICKS * patience ||
            spendableNow >= need * SAVINGS_NEAR_FRACTION;
          if (reachable) hold = need;
        }
      }
    }

    const order = priority
      ? [priority, ...ready.filter((p) => p !== priority)]
      : ready;

    for (const opt of order) {
      // The priority play is never gated by the hold; every weaker play must
      // leave the held gold untouched so the finisher stays affordable.
      const reserve = opt === priority ? 0 : hold;
      const spendableNow = this.spendable(player, reserved);
      const required = opt.cost * castBudgetFactor;
      if (spendableNow - reserve < required) {
        note(opt.ability, reserve > 0 ? "heldForFinisher" : "unaffordable", {
          value: opt.value, cost: opt.cost, efficiency: opt.efficiency,
          readyInTicks: opt.readyInTicks,
          spendable: spendableNow - reserve, required,
        });
        continue;
      }
      // The engine re-validates everything; a rejection changes nothing.
      // Gameplay dice draw from the match-level RNG (#203).
      activateAbility(match, player, opt.ability, {
        targetId: player.target ?? undefined,
        targetIds: this.multiTargetIds(ctx, opt.effective),
        chargesToUse: opt.chargesToUse,
      });
      note(opt.ability, "cast", {
        value: opt.value, cost: opt.cost, efficiency: opt.efficiency,
      });
      if (match.phase !== "active") {
        if (tracing) this.flushTrace(ctx, traced, reserved, hold);
        return; // the cast ended the match
      }
    }
    if (tracing) this.flushTrace(ctx, traced, reserved, hold);
  }

  /** Emits one decision point's trace (diagnostic mode only). */
  private flushTrace(
    { match, player }: AIContext,
    traced: Map<string, DecisionEntry>,
    reserved: number,
    hold: number,
  ): void {
    recordDecision({
      tick: match.tick,
      playerId: player.id,
      kingdomId: player.kingdomId,
      currency: player.economy.currency,
      reserved,
      hold,
      entries: [...traced.values()],
    });
  }

  /**
   * Estimates a cast's expected value in HP-equivalent terms, read entirely
   * from resolved effect metadata (#205 stays kingdom/ability-agnostic). This
   * is the AI's model of "how much does this play do for me": direct damage and
   * damage-over-time toward eliminating enemies, healing/shields toward
   * survival, crowd control and debuffs as tempo, and economy swings. It is a
   * heuristic, not a full forward simulation, but it is grounded in how the
   * engine actually resolves each effect.
   */
  private abilityValue(
    ctx: AIContext,
    effective: AbilityDefinition,
    chargesToUse: number | undefined,
  ): number {
    const { match, player } = ctx;
    const state = match.gameState!;
    const target = player.target ? state.getPlayer(player.target) : undefined;
    const enemies = state
      .getPlayers()
      .filter((p) => p.id !== player.id && !p.eliminated);
    const mode = effective.targeting.mode;
    const enemyHits =
      mode === "allEnemies"
        ? enemies.length
        : mode === "singleEnemy"
          ? target && !target.eliminated
            ? 1
            : 0
          : 0;

    let value = 0;

    // An attack is worth more against a target it hits harder — a Thunderdomed
    // enemy, an elemental weakness. Reuse the engine's exact damageTaken pass so
    // the AI's expectation matches the real hit. Single-target only: the primary
    // `target` is the amplified enemy; AoE can't assume every enemy is marked.
    const attackEl = effective.effects.find((e) => e.type === "damage")?.params.element;
    const dmgMult = (element: unknown): number =>
      mode === "singleEnemy" && target && typeof element === "string"
        ? computeStat(target, "damageTaken", 1, player, "target", element, false)
        : 1;

    // Charge-based direct damage (Lightning Barrage): the payload comes from
    // the charge table, not an effect amount.
    if (effective.chargeSystem && chargesToUse) {
      const dmg = effective.chargeSystem.damageByCharges[chargesToUse - 1] ?? 0;
      value += dmg * enemyHits * dmgMult(attackEl);
    }

    for (const effect of effective.effects) {
      const p = effect.params;
      const chance = effect.chance ?? 1;
      const toSelf = effect.target === "self";
      const bearer = toSelf ? player : target;

      switch (effect.type) {
        case "damage": {
          if (effective.chargeSystem) break; // counted from the charge table
          const hits =
            effect.target === "otherEnemies"
              ? Math.max(0, enemies.length - (enemyHits > 0 ? 1 : 0))
              : enemyHits;
          if (hits === 0) break;
          let dmg = p.amount ?? 0;
          if (
            p.bonusDamageIfTargetHasStatus &&
            target &&
            hasStatus(target, p.bonusDamageIfTargetHasStatus.statusId)
          ) {
            dmg += p.bonusDamageIfTargetHasStatus.extraAmount;
          }
          dmg *= dmgMult(p.element ?? attackEl); // target vulnerability/amplification
          value += chance * dmg * hits;
          // Conditional lifesteal → self-heal, capped at HP actually missing.
          if (p.lifesteal && target) {
            const gated =
              !p.lifesteal.requiresTargetStatus ||
              hasStatus(target, p.lifesteal.requiresTargetStatus);
            if (gated) {
              const missing = Math.max(0, player.castle.maxHp - player.castle.hp);
              value +=
                chance *
                Math.min(dmg * p.lifesteal.ratio, missing) *
                VALUE.healPerHp;
            }
          }
          break;
        }
        case "heal": {
          if (!bearer) break;
          const missing = Math.max(0, bearer.castle.maxHp - bearer.castle.hp);
          const amt =
            (p.percentMaxHp ? p.percentMaxHp * bearer.castle.maxHp : 0) +
            (p.amount ?? 0);
          value += chance * Math.min(amt, missing) * VALUE.healPerHp;
          break;
        }
        case "shield": {
          value += chance * (p.amount ?? 0) * VALUE.shieldPerHp;
          break;
        }
        case "status": {
          const st = p.status;
          if (!st) break;
          const hits = toSelf ? 1 : enemyHits;
          if (hits === 0) break;
          const dur = p.durationTicks ?? 0;
          // Re-applying a refresh/replace status that is already up adds
          // nothing; stacking statuses (burn, poison) genuinely add another.
          const additive = st.stacking === "stack" || st.stacking === "extend";
          const already = bearer ? hasStatus(bearer, st.id) : false;
          if (already && !additive) break;
          // Damage-over-time applies every tick for the whole duration.
          let dot = 0;
          for (const te of st.tickEffects ?? []) {
            if (te.type === "damage") dot += (te.amount ?? 0) * (te.chance ?? 1);
          }
          value += chance * dot * dur * hits;
          // Crowd control / debuff / self-buff tempo.
          const hasControl = !!(
            st.blocksAttacks ||
            st.blocksTargetingSource ||
            st.blocksPurchases ||
            st.deflectsAttackOnSource ||
            st.onHitRetaliate ||
            (st.modifiers && st.modifiers.length)
          );
          if (hasControl) {
            const secs = Math.min(dur / TICK.RATE, VALUE.controlCapSeconds);
            const rate = toSelf
              ? VALUE.selfBuffPerSecond
              : VALUE.enemyControlPerSecond;
            value += chance * secs * rate * hits;
          }
          // Setup/combo: applying a status a later ability pays off is worth
          // more than the status alone (e.g. Water's Current enabling lifesteal).
          if (this.payoffStatuses.has(st.id)) {
            value += chance * VALUE.setup * hits;
          }
          break;
        }
        case "economyModifier": {
          const gained =
            Math.round(player.economy.citizens * (p.citizensPercent ?? 0)) +
            (p.citizensFlat ?? 0);
          value += chance * Math.max(0, gained) * VALUE.citizen;
          break;
        }
        case "resourceTransfer": {
          const rt = p.resourceTransfer;
          if (!rt || !target) break;
          const base =
            rt.type === "currency"
              ? target.economy.currency
              : target.economy.citizens;
          const amt = rt.amount ?? (rt.percent ? base * rt.percent : 0);
          value +=
            chance *
            amt *
            (rt.type === "citizens" ? VALUE.citizen : VALUE.currencyPerGold);
          break;
        }
        case "buff":
        case "debuff": {
          const hits = toSelf ? 1 : enemyHits;
          if (hits === 0) break;
          // A permanent modifier (null ticks) is credited at the cap.
          const secs =
            p.modifierTicks && p.modifierTicks > 0
              ? Math.min(p.modifierTicks / TICK.RATE, VALUE.controlCapSeconds)
              : VALUE.controlCapSeconds;
          const rate = toSelf
            ? VALUE.selfBuffPerSecond
            : VALUE.enemyControlPerSecond;
          value += chance * secs * rate * hits;
          break;
        }
        case "cooldownModify": {
          // Stalling an enemy's abilities is a modest tempo swing.
          if (enemyHits === 0) break;
          value +=
            chance * VALUE.enemyControlPerSecond * 2 * enemyHits;
          break;
        }
        default: {
          // Every other engine primitive: field entities, delayed strikes,
          // meter charge/spend, wagers, redirects, castle links. Valued from
          // whatever numbers the effect itself carries, so this stays generic —
          // no effect type and no kingdom is named.
          value += chance * genericEffectValue(effect, mode, enemyHits, toSelf);
          break;
        }
      }
    }
    return value;
  }

  /** Ultimate timing (#206): hold ultimates for the profile's windows, judged
   *  purely from targeting metadata — never from the ability's identity. */
  private ultimateWindowOpen(
    { match, player }: AIContext,
    ability: AbilityDefinition,
  ): boolean {
    if (ability.kind !== "ultimate") return true;

    if (ability.targeting.mode === "self" || ability.targeting.mode === "noTarget") {
      const own = player.castle.hp / player.castle.maxHp;
      return own <= this.profile.ultimate.selfHpFraction;
    }

    // Enemy-targeted (single or all): judge by the current target's HP.
    const target = player.target
      ? match.gameState!.getPlayer(player.target)
      : undefined;
    if (!target || target.eliminated) return false;
    const frac = target.castle.hp / target.castle.maxHp;
    return frac <= this.profile.ultimate.targetHpFraction;
  }
}

/** Factory: bind a profile to the runner's AIFactory contract (#205). New
 *  personalities are new profiles — the simulator never changes. */
export function personalityAI(profile: PersonalityProfile): AIFactory {
  return (player, rng) => new PersonalityAI(profile, player, rng);
}
