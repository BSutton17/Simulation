import type { Match } from "../match/Match.js";
import type { PlayerState } from "../match/playerState.js";
import { canAfford } from "./money.js";

/**
 * Transaction validation (ticket #52). Every purchase is validated here before
 * it completes: the match must be in play, the buyer alive, the cost sane, and
 * the buyer must have sufficient funds. Systems call `validateTransaction`
 * before spending so no purchase mutates state unless it is legal and affordable.
 */

export type TransactionError =
  | "INVALID_PHASE"
  | "ELIMINATED"
  | "INVALID_TRANSACTION"
  | "INSUFFICIENT_FUNDS"
  | "SHIELD_ACTIVE"
  | "SHIELD_COOLDOWN" // a broken shield can't be rebought yet (break cooldown)
  | "PURCHASES_BLOCKED" // a status bars citizen/repair purchases (Toxic Gas)
  | "SHIELD_BLOCKED" // your own deployed swarm bars a shield (Light's Fireflies)
  | "NOTHING_TO_DISPEL" // no buy-off-able status is currently held
  | "REPAIR_LIMIT"; // the per-match cap on purchased repairs is spent

export interface TransactionResult {
  ok: boolean;
  error?: TransactionError;
}

export function validateTransaction(
  match: Match,
  player: PlayerState,
  cost: number,
): TransactionResult {
  if (match.phase !== "active") return { ok: false, error: "INVALID_PHASE" };
  if (player.eliminated) return { ok: false, error: "ELIMINATED" };
  if (!Number.isFinite(cost) || cost < 0) {
    return { ok: false, error: "INVALID_TRANSACTION" };
  }
  if (!canAfford(player, cost)) {
    return { ok: false, error: "INSUFFICIENT_FUNDS" };
  }
  return { ok: true };
}
