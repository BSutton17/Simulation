import {
  basicAttackIdFor,
  getUpgradeLevel,
  resolveAbility,
  supernovaLevel,
  supernovaMaxMeter,
  type AbilityDefinition,
  type AbilityKind,
  type TargetingMode,
} from "../../../src/engine/abilities.js";
import { getCooldown } from "../../../src/engine/cooldowns.js";
import { centrepieceSpawnedBy, standingCentrepiece } from "../../../src/engine/centrepiece.js";
import { capriceScrambles, capriceProtects } from "../../../src/engine/caprice.js";
import { isTargetingBlocked } from "../../../src/engine/status.js";
import { chargingMeterSpec } from "../../../src/engine/passives.js";
import { computeStat } from "../../../src/engine/modifiers.js";
import {
  abilityUnlockCost,
  citizenCost,
  repairCost,
  shieldCost,
} from "../../../src/engine/purchases.js";
import { abilityUpgradeCost } from "../../../src/engine/abilities.js";
import { abilitiesForKingdom } from "../../../src/data/kingdomAbilities.js";
import { KINGDOM_IDS, KINGDOM_PASSIVES, type KingdomId } from "../../../src/data/kingdoms.js";
import { CASTLE, DARK, SHIELD, TARGETING, TICK } from "../../../src/data/balance.js";
import { param } from "../../../src/engine/parameters.js";
import type { Match } from "../../../src/match/Match.js";
import type { PlayerState } from "../../../src/match/playerState.js";
import type { GameplayEvent } from "../../../src/engine/events.js";
import { REVEALING_STATUS_IDS } from "./visibility.js";

/**
 * The information boundary.
 *
 * ⚠️ THIS IS THE ONLY MODULE IN `ai/` PERMITTED TO READ ENGINE OR MATCH STATE.
 * `test/aiBoundary.test.ts` enforces that by scanning imports, and everything
 * downstream — the encoder, the legality mask, the action decoder — consumes
 * `PlayerKnowledge` and has no way to reach the simulation at all.
 *
 * The rule being applied lives in `visibility.ts`. What lives here is the
 * projection: given the authoritative state and one seat, produce the strictly
 * smaller object that seat is entitled to.
 *
 * The type is the first line of defence. `EnemyKnowledge` has no field for
 * gold, income-when-unrevealed, cooldowns, upgrades or meters — not a field set
 * to zero, no field. A developer cannot accidentally consume what the type does
 * not carry, and the encoder physically cannot leak it.
 */

/**
 * A value that may or may not be knowable right now.
 *
 * `known: false` is not the same as `value: 0`, and conflating them is the
 * specific mistake this type exists to prevent: an unknown enemy HP encoded as
 * 0 tells the network "they are dead", which is both wrong and actionable.
 * Consumers must encode the flag alongside the value.
 */
export interface Known<T> {
  readonly value: T;
  readonly known: boolean;
}

const UNKNOWN_NUMBER: Known<number> = { value: 0, known: false };
const known = (value: number): Known<number> => ({ value, known: true });

/** One of the five ability slots, entirely own-side information. */
export interface KitSlotKnowledge {
  readonly abilityId: string;
  readonly kind: AbilityKind;
  readonly targetingMode: TargetingMode;
  readonly unlocked: boolean;
  /** Ticks until castable (0 = ready). */
  readonly cooldownRemaining: number;
  /** The ability's full cooldown at this tier, for normalizing the above. */
  readonly cooldownTicks: number;
  /** Effective cast cost at the current tier. */
  readonly cost: number;
  readonly upgradeLevel: number;
  readonly maxUpgradeLevel: number;
  /** Price of the next unlock or upgrade; null when fully upgraded. */
  readonly investCost: number | null;
  /** Every gate the engine would apply, pre-computed. See `legality.ts`. */
  readonly affordable: boolean;
  readonly investAffordable: boolean;
  readonly meterReady: boolean;
  readonly statusBlocked: boolean;
  readonly centrepieceBlocked: boolean;
  /**
   * What this ability needs pointed at before the engine will resolve it.
   *
   * `"selected"` (singleEnemy) requires an actual current selection — the
   * engine resolves the cast against `options.targetId ?? caster.target` and
   * refuses with TARGET_REQUIRED when both are absent. That is the same rule a
   * player meets: you click a castle, then an ability.
   *
   * `"anyEnemy"` (allEnemies) needs someone alive but no selection.
   * `"none"` covers self and noTarget casts.
   */
  readonly targetRequirement: "none" | "selected" | "anyEnemy";
  /** Charge economy, present only for abilities that declare one. */
  readonly charges: { available: number; max: number; costPerCharge: number } | null;
  /**
   * The ability needs cast payload the v1 action space cannot express.
   *
   * Two metadata fields do this, and the engine rejects up-front on both:
   * `targeting.secondTarget` demands a second distinct enemy
   * (`SECOND_TARGET_REQUIRED` — Love's BFFS!!!), and `targeting.choices`
   * demands the caster name one of its declared options (`CHOICE_REQUIRED` —
   * Dark's Yin and Yang). The action space supplies one target and a charge
   * count, so these are masked off rather than proposed and refused.
   *
   * Detected from metadata, never by ability id, so a future ability declaring
   * either field is handled without a code change — and so is a future action
   * space that learns to supply them.
   */
  readonly needsUnsupportedPayload: boolean;
  /** Kingdom-agnostic estimate of the play's worth. See `heuristicValue`. */
  readonly heuristicValue: number;
  /** True when casting this applies a status that reveals enemy state. */
  readonly revealing: boolean;
}

export interface SelfKnowledge {
  readonly id: string;
  readonly kingdomId: KingdomId;
  readonly hp: number;
  readonly maxHp: number;
  readonly shield: number;
  readonly currency: number;
  readonly incomePerTick: number;
  readonly citizens: number;
  readonly repairsUsed: number;
  readonly maxRepairs: number;
  readonly repairCost: number;
  readonly repairAvailable: boolean;
  readonly shieldCost: number;
  readonly shieldAvailable: boolean;
  readonly citizenCost: number;
  readonly citizenAvailable: boolean;
  /** Whichever charge meter this kingdom uses; null when it has none. */
  readonly meter: { value: number; full: number } | null;
  readonly offensiveLock: boolean;
  readonly economicLock: boolean;
  readonly targetingLock: boolean;
  readonly pendingObligation: boolean;
  readonly targetId: string | null;
  readonly switchReady: boolean;
  readonly kit: readonly KitSlotKnowledge[];
}

/**
 * What this seat may know about one other kingdom.
 *
 * Note what is absent: currency, cooldowns, upgrades, unlocked, meters,
 * modifiers, attackJournal. Those are `"never"` in the visibility table and so
 * have no representation here at all.
 */
export interface EnemyKnowledge {
  readonly id: string;
  readonly kingdomId: KingdomId;
  readonly eliminated: boolean;
  /** Who they are aiming at — public, and rendered as targeting arrows. */
  readonly targetId: string | null;
  /** Status ids drawn as overlays on their castle. */
  readonly statusIds: readonly string[];
  readonly hp: Known<number>;
  readonly shield: Known<number>;
  readonly citizens: Known<number>;
  readonly income: Known<number>;
  /** Damage this seat has watched itself deal them. Observed, never read. */
  readonly damageDealt: number;
  /** Ticks since this seat last damaged them; null if never. */
  readonly ticksSinceDamaged: number | null;
  /**
   * Whether a cast can RESOLVE against them right now.
   *
   * Distinct from `targetable`, and the distinction is load-bearing. The engine
   * refuses a singleEnemy cast with INVALID_TARGET when the target is
   * eliminated, targeting-blocked (Water's Flood bars aiming at its caster), or
   * caprice-protected — and it applies those rules to the CURRENT selection, not
   * only to a new one. A mask that checked merely "alive" let a genome keep
   * casting into a Flood for the whole of its duration; that produced 70 refused
   * actions in one match and stopped a training run dead.
   */
  readonly attackable: boolean;
  /**
   * Whether this seat may SELECT them. Everything `attackable` requires, plus
   * the selection-only rules — Insects' Caprice refuses manual selection while
   * it holds the field, but does not stop a cast at an already-chosen target.
   */
  readonly targetable: boolean;
  /**
   * How much harder this seat's attacks land on them (1 = neither resisted nor
   * amplified). Derived from PUBLIC data only — see `publicAmplification`.
   */
  readonly amplification: number;
  /**
   * They bear a visible status that some ability in this kit pays off — a
   * lifesteal gate, a bonus-damage rider, an extended duration. Legal because
   * statuses render as overlays on every kingdom.
   */
  readonly comboSetup: boolean;
}

export interface FieldKnowledge {
  readonly tick: number;
  readonly livingEnemies: number;
  readonly centrepieceHeld: boolean;
  readonly volcanoLive: boolean;
  readonly volcanoHpFraction: number;
  readonly capriceActive: boolean;
  /** Living enemies currently aiming at this seat. */
  readonly besiegedBy: number;
}

export interface RevealKnowledge {
  readonly statsRevealed: boolean;
  /** Ticks left on the reveal, and the duration it was granted for. */
  readonly ticksRemaining: number;
  readonly grantedTicks: number;
  /** A reveal ability is unlocked, off cooldown and affordable right now. */
  readonly available: boolean;
}

export interface PlayerKnowledge {
  readonly self: SelfKnowledge;
  readonly enemies: readonly EnemyKnowledge[];
  readonly field: FieldKnowledge;
  readonly reveal: RevealKnowledge;
}

/**
 * What this seat has watched happen.
 *
 * Enemy HP is hidden, so "how hurt is that kingdom?" cannot be read. What a
 * player actually does is remember their own hits landing — the floating damage
 * numbers are on their screen. This accumulates exactly that and nothing else:
 * damage events whose source is this seat.
 *
 * Fed from the gameplay EventBus by the controller rather than by diffing enemy
 * state, because diffing enemy state would BE the leak.
 */
export class ObservedHistory {
  private readonly damage = new Map<string, number>();
  private readonly lastHitTick = new Map<string, number>();

  /** Records one gameplay event, from this seat's point of view. */
  observe(seatId: string, event: GameplayEvent): void {
    if (event.type !== "damage" || event.sourceId !== seatId) return;
    // Phantom damage (Love's stealth phase) is counted deliberately: the number
    // appears on the attacker's screen exactly like a real one, so a player
    // would be misled in precisely the same way.
    const total = event.dealtToHp + event.absorbedByShield;
    this.damage.set(event.targetId, (this.damage.get(event.targetId) ?? 0) + total);
    this.lastHitTick.set(event.targetId, event.tick);
  }

  damageDealtTo(playerId: string): number {
    return this.damage.get(playerId) ?? 0;
  }

  ticksSinceDamaged(playerId: string, tick: number): number | null {
    const last = this.lastHitTick.get(playerId);
    return last === undefined ? null : Math.max(0, tick - last);
  }
}

/**
 * Kingdom-agnostic estimate of what casting an ability is worth.
 *
 * Deliberately its OWN implementation rather than a reuse of
 * `PersonalityAI.abilityValue`. That method is private, depends on state built
 * in its constructor, and — decisively — its behaviour is pinned by
 * `test/aiEquivalence.test.ts`, which fingerprints the heuristic controller's
 * decisions across a fixed workload. Extracting it to share would risk
 * invalidating every balance reading taken before the refactor, to save a
 * function this small.
 *
 * Read only from the ability's own resolved metadata — never from live enemy
 * state — so it is both leak-free and stable across a decision.
 */
export function heuristicValue(resolved: AbilityDefinition): number {
  let value = 0;
  for (const effect of resolved.effects) {
    const p = effect.params as Record<string, unknown>;
    const chance = typeof effect.chance === "number" ? effect.chance : 1;
    let part = 0;
    for (const key of ["amount", "shieldOnlyAmount", "targeterDamage"]) {
      const v = p[key];
      if (typeof v === "number" && v > part) part = v;
    }
    const duration = p.durationTicks;
    if (typeof duration === "number" && duration > 0) {
      part += Math.min(duration / TICK.RATE, 12) * 50;
    }
    for (const key of ["supernovaCharge", "memoryCharge"]) {
      const v = p[key];
      if (typeof v === "number" && v > 0) part += v * 6;
    }
    // An effect carrying no numbers at all (a wager, a draw, a spin, an undo)
    // still does something; scoring it zero is what historically made whole
    // kits invisible to a value model.
    value += chance * (part > 0 ? part : 250);
  }
  return value;
}

/** Which charge meter, if any, this kingdom's kit actually uses. */
function meterFor(
  player: PlayerState,
  kit: readonly AbilityDefinition[],
): { value: number; full: number } | null {
  const memory = chargingMeterSpec(player);
  if (memory) return { value: player.ancientMemory, full: memory.full };
  const types = new Set<string>();
  for (const ability of kit) for (const e of ability.effects) types.add(e.type);
  if (types.has("supernovaBlast") || types.has("chargeSupernova")) {
    return { value: player.supernovaMeter, full: supernovaMaxMeter() };
  }
  if (types.has("rageBlast")) {
    return { value: player.rageMeter, full: param("dark.rageFull", DARK.RAGE_FULL) };
  }
  return null;
}

/** Whether this ability's own meter gate is currently satisfied. */
function meterReady(player: PlayerState, resolved: AbilityDefinition): boolean {
  for (const effect of resolved.effects) {
    if (effect.type === "supernovaBlast" && supernovaLevel(player.supernovaMeter) < 1) {
      return false;
    }
    if (
      effect.type === "rageBlast" &&
      player.rageMeter < param("dark.rageFull", DARK.RAGE_FULL)
    ) {
      return false;
    }
    if (effect.type === "spendMemory") {
      const spec = chargingMeterSpec(player);
      if (spec && player.ancientMemory < spec.full) return false;
    }
  }
  return true;
}

/**
 * What the engine will actually charge for a cast.
 *
 * Mirrors `activateAbilityInner`'s price step exactly, including the floor.
 * Kept in one place so "affordable" here and "can afford" there cannot drift.
 */
function effectiveCost(player: PlayerState, abilityId: string, base: number): number {
  return Math.max(
    0,
    Math.floor(
      computeStat(
        player,
        `abilityCost:${abilityId}`,
        computeStat(player, "abilityCost", base, undefined, "target", undefined, false),
        undefined,
        "target",
        undefined,
        false,
      ),
    ),
  );
}

/** True when this ability applies a status the visibility table calls a reveal. */
function isRevealing(resolved: AbilityDefinition): boolean {
  return resolved.effects.some((e) => {
    const status = (e.params as { status?: { id?: string } }).status;
    return status?.id !== undefined && REVEALING_STATUS_IDS.has(status.id);
  });
}

/**
 * How much harder this seat's attacks land on `enemy`, from PUBLIC data only.
 *
 * Deliberately narrow. The engine's own `computeStat(…, "damageTaken", …)` pass
 * would be more accurate, but it walks the target's full modifier stack, and
 * modifiers are `"never"` in the visibility table — some of them come from
 * effects a player cannot see. Reading them here would leak through a derived
 * feature, which is exactly the failure the behavioural tests exist to catch.
 *
 * So this uses only the target kingdom's static `elementalResistance` passives,
 * which follow from their kingdom and are therefore known the moment the lobby
 * closes. It UNDER-reports (it misses visible amplifiers like Thunderdome).
 * Under-reporting is the safe direction; widening it to include visible
 * statuses is a Phase 2 decision with its own version bump.
 */
function publicAmplification(
  attackElements: readonly string[],
  enemyKingdom: KingdomId,
): number {
  if (attackElements.length === 0) return 1;
  const passives = KINGDOM_PASSIVES[enemyKingdom] ?? [];
  let best = 1;
  for (const element of attackElements) {
    let multiplier = 1;
    for (const passive of passives) {
      if (passive.type === "elementalResistance" && passive.element === element) {
        multiplier *= 1 - passive.pct;
      }
    }
    if (multiplier > best) best = multiplier;
  }
  return best;
}

/**
 * Status ids that some ability in this kit rewards hitting a bearer of.
 *
 * Read from effect metadata, so "setup" and "combo" are discovered rather than
 * named — a new kingdom whose kit chains two abilities gets this for free.
 */
export function payoffStatusesOf(kit: readonly AbilityDefinition[]): Set<string> {
  const payoff = new Set<string>();
  for (const ability of kit) {
    for (const effect of ability.effects) {
      const p = effect.params as {
        lifesteal?: { requiresTargetStatus?: string };
        bonusDamageIfTargetHasStatus?: { statusId: string };
        bonusDurationIfTargetHasStatus?: { statusId: string };
      };
      if (p.lifesteal?.requiresTargetStatus) payoff.add(p.lifesteal.requiresTargetStatus);
      if (p.bonusDamageIfTargetHasStatus) payoff.add(p.bonusDamageIfTargetHasStatus.statusId);
      if (p.bonusDurationIfTargetHasStatus) payoff.add(p.bonusDurationIfTargetHasStatus.statusId);
    }
  }
  return payoff;
}

/** The distinct damage elements this kit's attacks deal. */
export function attackElementsOf(kit: readonly AbilityDefinition[]): string[] {
  const elements = new Set<string>();
  for (const ability of kit) {
    if (ability.kind !== "attack") continue;
    for (const effect of ability.effects) {
      const element = (effect.params as { element?: unknown }).element;
      if (effect.type === "damage" && typeof element === "string") elements.add(element);
    }
  }
  return [...elements];
}

/**
 * Projects the authoritative state onto what one seat may know.
 *
 * `history` supplies the observed-damage memory; pass the controller's instance
 * so it accumulates across the match.
 */
export function knowledgeFor(
  match: Match,
  player: PlayerState,
  history: ObservedHistory,
): PlayerKnowledge {
  const state = match.gameState!;
  const tick = match.tick;
  const kit = abilitiesForKingdom(player.kingdomId).filter((a) => a.kind !== "passive");

  // ── reveal ────────────────────────────────────────────────────────────
  // The host rule (`eliminatedSeeAllHealth`) is included because it is a real,
  // legitimate way a seat comes to see everything — it simply never applies to
  // a seat that is still playing.
  let revealTicks = 0;
  let revealGranted = 0;
  for (const status of player.statuses) {
    if (!REVEALING_STATUS_IDS.has(status.id)) continue;
    if (status.remainingTicks > revealTicks) {
      revealTicks = status.remainingTicks;
      revealGranted = status.initialDurationTicks ?? status.remainingTicks;
    }
  }
  const deadSeesAll = match.eliminatedSeeAllHealth && player.eliminated;
  const statsRevealed = revealTicks > 0 || deadSeesAll;

  // ── own kit ───────────────────────────────────────────────────────────
  const currency = player.economy.currency;
  const basicAttackId = basicAttackIdFor(player);
  const attacksBlocked = player.statuses.some((s) => s.blocksAttacks);
  const basicOnly = player.statuses.some((s) => s.basicAttacksOnly);
  const centrepiece = standingCentrepiece(match) !== null;

  let revealAvailable = false;
  const kitKnowledge: KitSlotKnowledge[] = kit.map((ability) => {
    const level = getUpgradeLevel(player, ability.id);
    const resolved = resolveAbility(ability, level);
    const unlocked = player.unlocked[ability.id] === true;
    const path = ability.upgradePath ?? [];
    const nextTier = path.find((t) => t.level === level + 1);
    const investCost = !unlocked
      ? abilityUnlockCost(player, ability)
      : nextTier
        ? abilityUpgradeCost(player, ability, nextTier)
        : null;

    const chargeSystem = resolved.chargeSystem;
    const charges = chargeSystem
      ? {
          available: Math.max(
            0,
            chargeSystem.max - (player.recharges[ability.id]?.length ?? 0),
          ),
          max: chargeSystem.max,
          costPerCharge: chargeSystem.costPerCharge,
        }
      : null;
    // The price the engine will actually charge. Statuses may scale one
    // ability's price ("abilityCost:<id>" — Thundering Fate quarters Zap) or
    // every price ("abilityCost"), and the engine floors the result. Reading
    // the resolved cost alone made "affordable" disagree with the engine and
    // produced INSUFFICIENT_FUNDS on casts the mask had permitted.
    //
    // ⚠️ `consume: false` is load-bearing. computeStat spends usage-limited
    // modifiers by DEFAULT, so a speculative read would mutate the match from
    // inside the observation layer — the AI's act of looking would change the
    // game. This is the caster's own modifier stack, so reading it is legal.
    const cost = effectiveCost(player, resolved.id, charges ? charges.costPerCharge : resolved.cost);

    const statusBlocked =
      (ability.kind === "attack" && attacksBlocked) ||
      ((ability.kind === "attack" || ability.kind === "ultimate") &&
        basicOnly &&
        ability.id !== basicAttackId);

    const revealing = isRevealing(resolved);
    const ready = getCooldown(player, ability.id) === 0 && (!charges || charges.available > 0);
    if (
      revealing &&
      unlocked &&
      ready &&
      currency >= cost &&
      !statusBlocked &&
      meterReady(player, resolved)
    ) {
      revealAvailable = true;
    }

    return {
      abilityId: ability.id,
      kind: ability.kind,
      targetingMode: resolved.targeting.mode,
      unlocked,
      cooldownRemaining: getCooldown(player, ability.id),
      cooldownTicks: Math.max(1, resolved.cooldownTicks ?? 1),
      cost,
      upgradeLevel: level,
      maxUpgradeLevel: path.length,
      investCost,
      affordable: currency >= cost,
      investAffordable: investCost !== null && currency >= investCost,
      meterReady: meterReady(player, resolved),
      statusBlocked,
      centrepieceBlocked: centrepieceSpawnedBy(resolved) !== null && centrepiece,
      targetRequirement:
        resolved.targeting.mode === "singleEnemy"
          ? "selected"
          : resolved.targeting.mode === "allEnemies"
            ? "anyEnemy"
            : "none",
      charges,
      needsUnsupportedPayload:
        resolved.targeting.secondTarget === true || resolved.targeting.choices !== undefined,
      heuristicValue: heuristicValue(resolved),
      revealing,
    };
  });

  // ── enemies ───────────────────────────────────────────────────────────
  const attackElements = attackElementsOf(kit);
  const payoffStatuses = payoffStatusesOf(kit);
  const purchasesBlocked = player.statuses.some((s) => s.blocksPurchases);
  const others = state.getPlayers().filter((p) => p.id !== player.id);
  let besiegedBy = 0;
  const enemies: EnemyKnowledge[] = others.map((enemy) => {
    if (!enemy.eliminated && enemy.target === player.id) besiegedBy += 1;
    const reveal = statsRevealed;
    const statusIds = enemy.statuses.map((s) => s.id);
    return {
      id: enemy.id,
      kingdomId: enemy.kingdomId,
      eliminated: enemy.eliminated,
      targetId: enemy.target,
      statusIds,
      hp: reveal ? known(enemy.castle.hp / Math.max(1, enemy.castle.maxHp)) : UNKNOWN_NUMBER,
      shield: reveal ? known(enemy.castle.shield) : UNKNOWN_NUMBER,
      citizens: reveal ? known(enemy.economy.citizens) : UNKNOWN_NUMBER,
      income: reveal ? known(enemy.economy.incomePerTick) : UNKNOWN_NUMBER,
      damageDealt: history.damageDealtTo(enemy.id),
      ticksSinceDamaged: history.ticksSinceDamaged(enemy.id, tick),
      attackable:
        !enemy.eliminated &&
        match.hasPlayer(enemy.id) &&
        !isTargetingBlocked(player, enemy.id) &&
        !capriceProtects(match, enemy.id),
      targetable:
        !enemy.eliminated &&
        match.hasPlayer(enemy.id) &&
        !isTargetingBlocked(player, enemy.id) &&
        !capriceProtects(match, enemy.id) &&
        !capriceScrambles(match, player),
      amplification: publicAmplification(attackElements, enemy.kingdomId),
      comboSetup: statusIds.some((id) => payoffStatuses.has(id)),
    };
  });

  const livingEnemies = enemies.filter((e) => !e.eliminated).length;
  const volcano = state.volcano;

  return {
    self: {
      id: player.id,
      kingdomId: player.kingdomId,
      hp: player.castle.hp,
      maxHp: player.castle.maxHp,
      shield: player.castle.shield,
      currency,
      incomePerTick: player.economy.incomePerTick,
      citizens: player.economy.citizens,
      repairsUsed: player.castle.repairs,
      maxRepairs: param("castle.maxRepairs", CASTLE.MAX_REPAIRS),
      repairCost: repairCost(player),
      repairAvailable:
        !purchasesBlocked &&
        player.castle.repairs < param("castle.maxRepairs", CASTLE.MAX_REPAIRS) &&
        player.castle.hp < player.castle.maxHp &&
        currency >= repairCost(player),
      shieldCost: shieldCost(player),
      shieldAvailable:
        player.castle.shield <= 0 &&
        !player.statuses.some((s) => s.blocksBearerShield) &&
        tick - player.castle.shieldBrokenAtTick >=
          param("shield.breakCooldownTicks", SHIELD.BREAK_COOLDOWN_TICKS) &&
        currency >= shieldCost(player),
      citizenCost: citizenCost(player),
      citizenAvailable: !purchasesBlocked && currency >= citizenCost(player),
      meter: meterFor(player, kit),
      offensiveLock: attacksBlocked || basicOnly,
      economicLock: purchasesBlocked || player.statuses.some((s) => s.blocksBearerShield),
      targetingLock: player.statuses.some((s) => s.blocksTargetChange),
      pendingObligation: player.pendingSpin !== null || player.pendingBet !== null,
      targetId: player.target,
      switchReady: tick >= player.targetSwitchReadyTick,
      kit: kitKnowledge,
    },
    enemies,
    field: {
      tick,
      livingEnemies,
      centrepieceHeld: centrepiece,
      volcanoLive: volcano !== null,
      volcanoHpFraction: volcano ? volcano.hp / Math.max(1, volcano.maxHp) : 0,
      capriceActive: state.caprice !== null,
      besiegedBy,
    },
    reveal: {
      statsRevealed,
      ticksRemaining: revealTicks,
      grantedTicks: revealGranted,
      available: revealAvailable,
    },
  };
}

/** Canonical kingdom index, for the stable tiebreak in `actions.ts`. */
export function kingdomOrder(kingdomId: KingdomId): number {
  return KINGDOM_IDS.indexOf(kingdomId);
}

/** The target-switch cooldown, for normalizing "switch ready". */
export const SWITCH_COOLDOWN_TICKS = TARGETING.SWITCH_COOLDOWN_TICKS;
