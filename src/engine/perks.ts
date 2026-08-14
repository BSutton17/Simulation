import { PERKS } from "../data/balance.js";
import type { PerkId } from "../data/perks.js";
import { param } from "./parameters.js";
import { computeStat } from "./modifiers.js";
import { hasBoostedPerks } from "./passives.js";

/**
 * The modifier stat that switches a player's perks off wholesale (Joker's Slot
 * Machine). Any positive value suppresses them. Lives here, next to the only
 * code that reads it, so nothing has to import the slot machine to say so.
 */
export const PERK_SUPPRESSION_STAT = "perksSuppressed";
import type { PlayerState } from "../match/playerState.js";

/**
 * Perk application (mirrors `passives.ts` for kingdom passives). Reads a
 * player's two selected perks and exposes the single multiplier/bonus each
 * engine system consumes, so no system needs a perk-specific branch — it just
 * multiplies one more factor into a chain it already computes.
 *
 * Every magnitude comes in a base and a BOOSTED flavour: a kingdom carrying the
 * `boostedPerks` passive (Dark's "Black Magic") runs whichever perks it picked
 * at the stronger value. `magnitude()` is the only place that chooses between
 * them, so every perk gets the behaviour for free.
 *
 * Both flavours read through the balance-parameter system (ticket #202) so
 * perks stay tunable like everything else; the live game takes the fast path.
 */

export function hasPerk(player: PlayerState, perk: PerkId): boolean {
  // Joker's Slot Machine can switch a player's perks off for a while. Checked
  // here so EVERY perk goes dark together, with nothing to remember per perk.
  if (computeStat(player, PERK_SUPPRESSION_STAT, 0) > 0) return false;
  return player.perks.includes(perk);
}

/**
 * The effective magnitude of a perk value for `player`: the boosted number when
 * their kingdom boosts perks, the base number otherwise. `key` names the base
 * entry in `PERKS`; the boosted entry is `<key>_BOOSTED` by convention.
 */
function magnitude(
  player: PlayerState,
  key: "ATTACK_PCT" | "SHIELD_ATTACK_PCT" | "DAMAGE_REDUCTION_PCT" | "DOT_REDUCTION_PCT"
    | "COOLDOWN_REDUCTION_PCT" | "STARTING_GOLD" | "UNLOCK_DISCOUNT_PCT" | "SHIELD_BONUS_HP",
): number {
  return magnitudeFor(hasBoostedPerks(player), key);
}

/** `magnitude` against a raw boosted flag, for callers without a PlayerState. */
function magnitudeFor(
  boosted: boolean,
  key: "ATTACK_PCT" | "SHIELD_ATTACK_PCT" | "DAMAGE_REDUCTION_PCT" | "DOT_REDUCTION_PCT"
    | "COOLDOWN_REDUCTION_PCT" | "STARTING_GOLD" | "UNLOCK_DISCOUNT_PCT" | "SHIELD_BONUS_HP",
): number {
  const name = boosted ? (`${key}_BOOSTED` as const) : key;
  return param(`perk.${name}`, PERKS[name]);
}

/** "Sharper Swords" — outgoing ability damage multiplier (1 = no perk). */
export function perkDamageMultiplier(player: PlayerState): number {
  return hasPerk(player, "sharperSwords") ? 1 + magnitude(player, "ATTACK_PCT") : 1;
}

/** "Sharper Axes" — extra outgoing damage against a shielded castle. Composes
 *  with Fire's "Roast!" and ability-level shield multipliers. */
export function perkShieldDamageMultiplier(player: PlayerState): number {
  return hasPerk(player, "sharperAxes")
    ? 1 + magnitude(player, "SHIELD_ATTACK_PCT")
    : 1;
}

/** "Extra Guards" — multiplier on ALL damage this player takes (1 = no perk). */
export function perkDamageTakenMultiplier(player: PlayerState): number {
  return hasPerk(player, "extraGuards")
    ? Math.max(0, 1 - magnitude(player, "DAMAGE_REDUCTION_PCT"))
    : 1;
}

/**
 * "Extra Medics" — multiplier on damage-over-time (per-tick status) damage this
 * player takes. Applied ON TOP of "Extra Guards" when both are picked: perks
 * stack, so a DoT tick against a player holding both takes 0.9 × 0.85.
 */
export function perkDotDamageTakenMultiplier(player: PlayerState): number {
  return hasPerk(player, "extraMedics")
    ? Math.max(0, 1 - magnitude(player, "DOT_REDUCTION_PCT"))
    : 1;
}

/** "Extra Repairs" — multiplier on every ability cooldown (1 = no perk). */
export function perkCooldownMultiplier(player: PlayerState): number {
  return hasPerk(player, "extraRepairs")
    ? Math.max(0, 1 - magnitude(player, "COOLDOWN_REDUCTION_PCT"))
    : 1;
}

/** "Great Merchants" — multiplier on ability unlock prices (1 = no perk). */
export function perkUnlockCostMultiplier(player: PlayerState): number {
  return hasPerk(player, "greatMerchants")
    ? Math.max(0, 1 - magnitude(player, "UNLOCK_DISCOUNT_PCT"))
    : 1;
}

/** "Better Construction" — extra health on every shield this player gains. */
export function perkShieldBonusHp(player: PlayerState): number {
  return hasPerk(player, "betterConstruction")
    ? magnitude(player, "SHIELD_BONUS_HP")
    : 0;
}

/**
 * "Deep Pockets" — gold in the bank at match start. Takes the raw perk list and
 * boosted flag rather than a PlayerState: it is read while that state is being
 * built, before there is a player to ask.
 */
export function perkStartingGold(
  perks: readonly PerkId[],
  boosted = false,
): number {
  return perks.includes("deepPockets") ? magnitudeFor(boosted, "STARTING_GOLD") : 0;
}

/**
 * "Better Construction" against a raw perk list, for the same reason as
 * `perkStartingGold` — the starting shield is granted during state creation.
 */
export function perkShieldBonusHpFor(
  perks: readonly PerkId[],
  boosted = false,
): number {
  return perks.includes("betterConstruction")
    ? magnitudeFor(boosted, "SHIELD_BONUS_HP")
    : 0;
}
