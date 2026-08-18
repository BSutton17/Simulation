import {
  ACTION_SIZE,
  BUY_CITIZEN,
  BUY_SHIELD,
  CAST_BASE,
  CHARGE_FRACTION,
  INVEST_BASE,
  KIT_SLOTS,
  REPAIR,
  SWITCH_GATE,
  TARGET_BASE,
  TARGET_SLOTS,
  WAIT,
  orderEnemies,
} from "./actions.js";
import type { PlayerKnowledge } from "./knowledge.js";

/**
 * The action mask.
 *
 * A network proposes; the game disposes. This computes which of the 22 heads
 * could legally be acted on right now, so an illegal proposal is filtered out
 * BEFORE decoding rather than being sent to the engine and rejected.
 *
 * Why masking rather than penalizing an illegal choice: one training evaluation
 * costs minutes of wall clock, and legality here is exactly computable from
 * state the seat already owns. Spending the first thirty generations teaching a
 * network that a locked ability is locked is compute this project cannot spare,
 * and the engine already knows the answer.
 *
 * What is masked is HARD LEGALITY ONLY — what the engine would refuse. Strategy
 * is never masked. "Can afford but shouldn't" is the judgement the network
 * exists to make; the heuristic controller's savings floor and reservations are
 * policy and are deliberately not inherited.
 *
 * The engine remains the authority. It re-validates everything and is
 * fail-closed, so a mask that is wrong in the permissive direction costs a
 * no-op, not a corrupt match. `controller.ts` records those rejections; a
 * nonzero rate means this module and the engine have drifted.
 */

/** Reads as legal/illegal per action index. */
export type ActionMask = Uint8Array;

export function createMask(): ActionMask {
  return new Uint8Array(ACTION_SIZE);
}

/**
 * Fills `mask` for the seat described by `knowledge`.
 *
 * INVARIANT: index 13 (WAIT) is always 1. There is therefore no reachable state
 * in which the mask is empty, so decoding can never fail to produce an action —
 * which is what stops a fully locked-down seat (frozen, broke, no target) from
 * crashing the controller.
 */
export function legalActions(knowledge: PlayerKnowledge, mask: ActionMask): ActionMask {
  if (mask.length !== ACTION_SIZE) {
    throw new Error(`action mask must be ${ACTION_SIZE}, got ${mask.length}`);
  }
  mask.fill(0);
  const { self } = knowledge;

  // Waiting is unconditional, and is what guarantees a non-empty mask.
  mask[WAIT] = 1;

  // An eliminated seat, or one in a finished match, may only wait.
  if (self.hp <= 0) return mask;

  const enemies = orderEnemies(knowledge);
  const hasLiveEnemy = enemies.length > 0;
  // A single-enemy cast resolves against the CURRENT selection, so without one
  // the engine refuses with TARGET_REQUIRED. Same rule a player meets: click a
  // castle, then an ability.
  const selected =
    knowledge.self.targetId !== null &&
    knowledge.enemies.some((e) => e.id === knowledge.self.targetId && !e.eliminated);

  // ── casts (0–4) ───────────────────────────────────────────────────────
  let anyChargeCastable = false;
  for (let slot = 0; slot < KIT_SLOTS; slot++) {
    const ability = self.kit[slot];
    if (ability === undefined) continue;
    const ready =
      ability.cooldownRemaining === 0 &&
      (ability.charges === null || ability.charges.available > 0);
    const castable =
      ability.unlocked &&
      ready &&
      ability.affordable &&
      ability.meterReady &&
      !ability.statusBlocked &&
      !ability.centrepieceBlocked &&
      // Abilities demanding a second target or a declared choice cannot be
      // expressed by the 22 heads, and the engine rejects them up-front. See
      // KitSlotKnowledge.needsUnsupportedPayload.
      !ability.needsUnsupportedPayload &&
      // An enemy-directed cast with nothing to resolve against is refused by
      // the engine, so it is not a legal choice here either.
      (ability.targetRequirement === "none" ||
        (ability.targetRequirement === "selected" ? selected : hasLiveEnemy));
    if (!castable) continue;
    mask[CAST_BASE + slot] = 1;
    if (ability.charges !== null) anyChargeCastable = true;
  }

  // ── invest (5–9) ──────────────────────────────────────────────────────
  for (let slot = 0; slot < KIT_SLOTS; slot++) {
    const ability = self.kit[slot];
    if (ability === undefined) continue;
    // investCost is null only when the ability is unlocked and fully upgraded.
    if (ability.investCost !== null && ability.investAffordable) {
      mask[INVEST_BASE + slot] = 1;
    }
  }

  // ── purchases (10–12) ─────────────────────────────────────────────────
  mask[BUY_CITIZEN] = self.citizenAvailable ? 1 : 0;
  mask[REPAIR] = self.repairAvailable ? 1 : 0;
  mask[BUY_SHIELD] = self.shieldAvailable ? 1 : 0;

  // ── targeting (14–19) ─────────────────────────────────────────────────
  // Switching is gated by the engine's anti-spam cooldown and by any status
  // that locks the selection (Supernova). Re-selecting the current target is a
  // no-op in the engine, so it is masked off rather than wasting a decision.
  if (!self.targetingLock && self.switchReady) {
    for (let slot = 0; slot < TARGET_SLOTS; slot++) {
      const enemy = enemies[slot];
      if (enemy === undefined) break;
      if (enemy.targetable && enemy.id !== self.targetId) {
        mask[TARGET_BASE + slot] = 1;
      }
    }
  }
  // The gate is only meaningful when there is something to switch to.
  mask[SWITCH_GATE] = anyTargetLegal(mask) ? 1 : 0;

  // ── charge fraction (21) ──────────────────────────────────────────────
  // Exactly one ability in the game declares a charge system (Electricity's
  // Lightning Barrage), so for fifteen kingdoms this output is permanently
  // masked off and simply never read by the decoder.
  mask[CHARGE_FRACTION] = anyChargeCastable ? 1 : 0;

  return mask;
}

function anyTargetLegal(mask: ActionMask): boolean {
  for (let i = TARGET_BASE; i < TARGET_BASE + TARGET_SLOTS; i++) {
    if (mask[i] === 1) return true;
  }
  return false;
}

/** Count of legal primary heads, for diagnostics. */
export function legalPrimaryCount(mask: ActionMask): number {
  let n = 0;
  for (let i = 0; i <= WAIT; i++) if (mask[i] === 1) n += 1;
  return n;
}
