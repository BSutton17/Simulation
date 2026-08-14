import type { PlayerState } from "../match/playerState.js";

/**
 * Server-authoritative money system (ticket #51). Every gameplay money change —
 * income, purchases, refunds — goes through these functions. Player currency is
 * never modified directly anywhere else, so balances stay consistent and
 * cent-precise, and spending is always validated.
 */

/**
 * Rounds money to 4 decimal places to avoid floating-point drift. Finer than
 * cents so per-tick income increments (e.g. 0.0125/citizen at 20 ticks/sec)
 * accrue exactly instead of being distorted by cent rounding every tick.
 */
export function roundMoney(amount: number): number {
  return Math.round(amount * 10000) / 10000;
}

export function getBalance(player: PlayerState): number {
  return player.economy.currency;
}

export function canAfford(player: PlayerState, amount: number): boolean {
  return player.economy.currency >= amount;
}

/** Adds money to a player. Non-positive amounts are ignored. */
export function earn(player: PlayerState, amount: number): void {
  if (amount <= 0) return;
  player.economy.currency = roundMoney(player.economy.currency + amount);
}

/**
 * Deducts money if the player can afford it. Returns true on success, false if
 * the balance is insufficient (in which case nothing changes).
 */
export function spend(player: PlayerState, amount: number): boolean {
  if (amount <= 0) return true;
  if (!canAfford(player, amount)) return false;
  player.economy.currency = roundMoney(player.economy.currency - amount);
  return true;
}
