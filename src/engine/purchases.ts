import { CASTLE, ECONOMY, SHIELD } from "../data/balance.js";
import { ALL_ABILITIES } from "../data/abilitiesRegistry.js";
import type { AbilityDefinition } from "./abilities.js";
import type { Match } from "../match/Match.js";
import type { PlayerState } from "../match/playerState.js";
import { spend } from "./money.js";
import { recalcIncome } from "./economy.js";
import { bonusCitizenOnPurchase, citizenBaseCostOverride } from "./passives.js";
import { perkShieldBonusHp, perkUnlockCostMultiplier } from "./perks.js";
import { purchaseUpgrade, shareHealGlobally } from "./abilities.js";
import { removeStatus, settleYinYang } from "./status.js";
import { validateTransaction, type TransactionResult } from "./transactions.js";
import { param } from "./parameters.js";

/**
 * Gameplay purchases (ticket #53+). Each purchase validates through the
 * transaction system (funds + legality) before spending and applying its
 * effect, so nothing is granted unless it was paid for.
 */

/**
 * Cost of the player's next citizen. Scales with how many they've already
 * purchased (ticket #54): CITIZEN_COST × GROWTH^purchased, rounded to dollars.
 */
export function citizenCost(player: PlayerState): number {
  const purchased = player.economy.citizensPurchased;
  // Love's "Warm Welcome" lowers the ladder's BASE cost (20 vs 25) but keeps the
  // same growth, so every hire is proportionally cheaper (20 → 22 → 24 → …).
  const base = citizenBaseCostOverride(player) ?? param("economy.citizenCost", ECONOMY.CITIZEN_COST);
  return Math.round(
    base * param("economy.citizenCostGrowth", ECONOMY.CITIZEN_COST_GROWTH) ** purchased,
  );
}

/** Whether a status bars the player from citizen/repair purchases (Epic 12,
 *  Nature's Toxic Gas). Shields stay purchasable. */
function purchasesBlocked(player: PlayerState): boolean {
  return player.statuses.some((s) => s.blocksPurchases);
}

/**
 * A status the bearer can buy their way out of, with its current price (Light's
 * Fireflies). The most expensive one when several are held, so the shop always
 * quotes the debt that actually matters. Null when there is nothing to dispel.
 */
export function dispellableStatus(
  player: PlayerState,
): { statusId: string; cost: number } | null {
  let worst: { statusId: string; cost: number } | null = null;
  for (const s of player.statuses) {
    if (s.dispelCost === undefined) continue;
    if (!worst || s.dispelCost > worst.cost) {
      worst = { statusId: s.id, cost: s.dispelCost };
    }
  }
  return worst;
}

/**
 * Pays a status off: the bearer spends its snapshotted price and the status is
 * removed immediately (Light's Fireflies). Rejected when there is nothing to
 * dispel or the funds fall short.
 */
export function dispelStatus(
  match: Match,
  player: PlayerState,
): TransactionResult & { statusId?: string } {
  const owed = dispellableStatus(player);
  if (!owed) return { ok: false, error: "NOTHING_TO_DISPEL" };

  const validation = validateTransaction(match, player, owed.cost);
  if (!validation.ok) return validation;

  spend(player, owed.cost);
  removeStatus(player, owed.statusId);

  const bus = match.gameState!.events;
  if (bus.enabled) {
    bus.emit({
      type: "purchase",
      tick: match.tick,
      playerId: player.id,
      kind: "dispel",
      itemId: owed.statusId,
      cost: owed.cost,
    });
    bus.emit({
      type: "statusExpired",
      tick: match.tick,
      playerId: player.id,
      statusId: owed.statusId,
    });
  }
  return { ok: true, statusId: owed.statusId };
}

/** Purchases one additional citizen for the player at its current scaled cost. */
export function buyCitizen(match: Match, player: PlayerState): TransactionResult {
  if (purchasesBlocked(player)) {
    return { ok: false, error: "PURCHASES_BLOCKED" };
  }
  const cost = citizenCost(player);
  const validation = validateTransaction(match, player, cost);
  if (!validation.ok) return validation;

  spend(player, cost);
  // The price ladder advances by exactly one hire, always.
  player.economy.citizensPurchased += 1;
  // Base purchase grants one citizen; Time's "Time is money" has a
  // chance to throw in a free bonus citizen without advancing the ladder.
  let gained = 1;
  const bonus = bonusCitizenOnPurchase(player);
  if (bonus && match.rng() < bonus.chance) {
    gained += bonus.amount;
  }
  player.economy.citizens += gained;
  // Citizen count changed — refresh income immediately (ticket #55).
  recalcIncome(player);

  // Dark's Yin and Yang: hiring settles any outstanding wager on the spot —
  // in full if Dark called "yin" (buying is what it was punishing), at half if
  // it called "yang" and you read it right. Either way the wager is spent.
  for (const wager of player.statuses.filter((s) => s.wagerMode)) {
    settleYinYang(match.gameState!, player, wager, true);
    removeStatus(player, wager.id);
  }

  // Gameplay events (#204).
  const bus = match.gameState!.events;
  if (bus.enabled) {
    bus.emit({ type: "purchase", tick: match.tick, playerId: player.id, kind: "citizen", cost });
    bus.emit({
      type: "citizensChanged",
      tick: match.tick,
      playerId: player.id,
      delta: gained,
      total: player.economy.citizens,
      cause: "purchase",
    });
  }
  return { ok: true };
}

/**
 * Cost of the player's next repair (ticket #57): a flat `REPAIR_COST` scaled
 * by `REPAIR_COST_GROWTH^repairs` so each repair costs more than the last
 * (1000 → 1250 → 1563). Returns 0 once the `MAX_REPAIRS` cap is spent.
 */
export function repairCost(player: PlayerState): number {
  if (player.castle.repairs >= param("castle.maxRepairs", CASTLE.MAX_REPAIRS)) return 0;
  return Math.round(
    param("castle.repairCost", CASTLE.REPAIR_COST) *
      param("castle.repairCostGrowth", CASTLE.REPAIR_COST_GROWTH) **
        player.castle.repairs,
  );
}

/**
 * Repairs the player's castle (ticket #56): restores up to `REPAIR_AMOUNT` HP
 * (never above max) at the current, progressively-scaling cost (ticket #57).
 * Capped at `MAX_REPAIRS` purchases per match — ability-based healing is
 * unaffected by the cap.
 */
export function repairCastle(match: Match, player: PlayerState): TransactionResult {
  if (purchasesBlocked(player)) {
    return { ok: false, error: "PURCHASES_BLOCKED" };
  }
  if (player.castle.repairs >= param("castle.maxRepairs", CASTLE.MAX_REPAIRS)) {
    return { ok: false, error: "REPAIR_LIMIT" };
  }
  const missing = player.castle.maxHp - player.castle.hp;
  if (missing <= 0) {
    return { ok: false, error: "INVALID_TRANSACTION" }; // already full
  }

  const repaired = Math.min(param("castle.repairAmount", CASTLE.REPAIR_AMOUNT), missing);
  const cost = repairCost(player);

  const validation = validateTransaction(match, player, cost);
  if (!validation.ok) return validation;

  spend(player, cost);
  player.castle.hp += repaired;
  player.castle.repairs += 1;

  // Gameplay events (#204).
  const bus = match.gameState!.events;
  if (bus.enabled) {
    bus.emit({ type: "purchase", tick: match.tick, playerId: player.id, kind: "repair", cost });
    bus.emit({ type: "heal", tick: match.tick, targetId: player.id, amount: repaired, overheal: param("castle.repairAmount", CASTLE.REPAIR_AMOUNT) - repaired, cause: "repair" });
  }
  // Love's "Feel the love!": a repair is healing too — share a cut with any
  // kingdom that taxes global healing.
  shareHealGlobally(match, player, repaired);
  return { ok: true };
}

/**
 * Cost of the player's next shield: a flat `SHIELD.COST` scaled by
 * `SHIELD.COST_GROWTH^shieldsPurchased` so each shield costs more than the last
 * (500 → 525 → 551 → …), rounded to dollars. Only one shield can be active at a
 * time, so this scales with cumulative purchases across the match.
 */
export function shieldCost(player: PlayerState): number {
  return Math.round(
    param("shield.cost", SHIELD.COST) *
      param("shield.costGrowth", SHIELD.COST_GROWTH) ** player.castle.shieldsPurchased,
  );
}

/**
 * Purchases the standard shield (ticket #58): grants `SHIELD.STANDARD_HP` of
 * shield health at the current, progressively-scaling cost (`shieldCost`).
 *
 * Cannot buy another standard shield while one is already active (ticket #59).
 * Kingdom abilities that grant shields apply them directly (via the effect
 * engine), bypassing this purchase guard.
 */
export function buyShield(match: Match, player: PlayerState): TransactionResult {
  if (player.castle.shield > 0) {
    return { ok: false, error: "SHIELD_ACTIVE" };
  }
  // Light's Fireflies: a shield keeps the swarm off, but once it has landed
  // you can't buy your way behind one — the only exit is paying the ransom.
  if (player.statuses.some((s) => s.blocksBearerShield)) {
    return { ok: false, error: "SHIELD_BLOCKED" };
  }
  // A freshly-broken shield can't be replaced instantly — wait out the cooldown.
  const cooldown = param("shield.breakCooldownTicks", SHIELD.BREAK_COOLDOWN_TICKS);
  if (match.tick - player.castle.shieldBrokenAtTick < cooldown) {
    return { ok: false, error: "SHIELD_COOLDOWN" };
  }

  const cost = shieldCost(player);
  const validation = validateTransaction(match, player, cost);
  if (!validation.ok) return validation;

  spend(player, cost);
  // "Better Construction" reinforces the shield at no extra cost.
  const granted =
    param("shield.standardHp", SHIELD.STANDARD_HP) + perkShieldBonusHp(player);
  player.castle.shield += granted;
  player.castle.shieldsPurchased += 1;

  // Kitsune's "Old Friends": the wall going up drives the foxes off. Buying a
  // shield is the ONLY exit from that status — it has no duration — so this is
  // where it ends, not the tick loop.
  const driven = player.statuses.filter((s) => s.endsOnShieldPurchase);
  if (driven.length > 0) {
    player.statuses = player.statuses.filter((s) => !s.endsOnShieldPurchase);
    if (match.gameState!.events.enabled) {
      for (const s of driven) {
        match.gameState!.events.emit({
          type: "statusExpired",
          tick: match.tick,
          playerId: player.id,
          statusId: s.id,
        });
      }
    }
  }

  // Gameplay events (#204).
  const bus = match.gameState!.events;
  if (bus.enabled) {
    bus.emit({ type: "purchase", tick: match.tick, playerId: player.id, kind: "shield", cost });
    bus.emit({
      type: "shieldGained",
      tick: match.tick,
      playerId: player.id,
      amount: granted,
      total: player.castle.shield,
      cause: "purchase",
    });
  }
  return { ok: true };
}

/**
 * What it costs this player to buy `ability`: its explicit `unlockCost` when
 * the data sets one, otherwise 50% of its cast cost, then the player's
 * "Great Merchants" perk discount. The single definition of the unlock price —
 * both the purchase itself and the price the HUD is sent read it.
 */
export function abilityUnlockCost(
  player: PlayerState,
  ability: AbilityDefinition,
): number {
  return Math.ceil(
    param(
      `ability.${ability.id}.unlockCost`,
      ability.unlockCost ?? Math.ceil((ability.cost ?? 0) * 0.5),
    ) * perkUnlockCostMultiplier(player),
  );
}

/**
 * Buys a locked ability, or upgrades an already-bought one.
 *
 * Every ability starts locked. Buying it costs 50% of its cast cost and makes
 * it usable at its base strength ("level 1" in UI terms — `unlocked` is set,
 * `upgrades` stays at tier 0). Once bought, further purchases go through the
 * standard tier upgrade system (`purchaseUpgrade`, ticket #75).
 */
export function unlockOrUpgradeAbility(
  match: Match,
  player: PlayerState,
  abilityId: string,
): TransactionResult & { level?: number } {
  const ability = ALL_ABILITIES[abilityId as keyof typeof ALL_ABILITIES];
  if (!ability) {
    return { ok: false, error: "INVALID_TRANSACTION" };
  }

  if (!player.unlocked[abilityId]) {
    const unlockCost = abilityUnlockCost(player, ability);
    const validation = validateTransaction(match, player, unlockCost);
    if (!validation.ok) return validation;

    spend(player, unlockCost);
    player.unlocked[abilityId] = true;

    // Gameplay event (#204).
    const bus = match.gameState!.events;
    if (bus.enabled) {
      bus.emit({
        type: "purchase",
        tick: match.tick,
        playerId: player.id,
        kind: "unlock",
        itemId: abilityId,
        cost: unlockCost,
      });
    }
    return { ok: true, level: 1 };
  }

  // Already bought — purchase the next upgrade tier.
  const result = purchaseUpgrade(match, player, ability);
  if (!result.ok) return result;
  return { ok: true, level: (result.level ?? 0) + 1 };
}
